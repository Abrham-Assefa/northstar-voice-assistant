import { createServer as createHttpServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const maxRequestBytes = 16 * 1024;
const maxAudioBytes = 2 * 1024 * 1024;
const maxMessages = 20;
const maxMessageCharacters = 4000;
const execFileAsync = promisify(execFile);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

async function readBinaryBody(request, maxBytes) {
  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Audio recording is too large. Keep recordings under 30 seconds.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function isWavFile(audio) {
  return (
    audio.length >= 44 &&
    audio.toString("ascii", 0, 4) === "RIFF" &&
    audio.toString("ascii", 8, 12) === "WAVE"
  );
}

async function transcribeOnDevice(audio, language, env) {
  const modelPath = env.WHISPER_MODEL
    ? path.resolve(projectDirectory, env.WHISPER_MODEL)
    : path.join(projectDirectory, ".models", "ggml-tiny.bin");
  const command = env.WHISPER_CLI || "whisper-cli";
  try {
    await access(modelPath);
  } catch {
    const error = new Error("Local speech model is missing. Run npm run setup:speech, then restart the app.");
    error.statusCode = 503;
    throw error;
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "customer-voice-"));
  const audioPath = path.join(temporaryDirectory, "recording.wav");

  try {
    await writeFile(audioPath, audio);
    const { stdout } = await execFileAsync(
      command,
      [
        "-m",
        modelPath,
        "-f",
        audioPath,
        "-l",
        language.split("-")[0].toLowerCase(),
        "-nt",
        "-np",
        "-t",
        "4",
      ],
      { timeout: 45_000, maxBuffer: 1024 * 1024 },
    );
    const transcript = stdout.trim().replace(/^\[BLANK_AUDIO\]$/i, "");
    if (!transcript) {
      const error = new Error("No speech was detected. Try speaking a little louder.");
      error.statusCode = 422;
      throw error;
    }
    return transcript;
  } catch (error) {
    if (error.statusCode) throw error;

    if (error.code === "ETIMEDOUT") {
      const timeoutError = new Error("Transcription took too long. Try a shorter recording.");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    console.error("On-device speech transcription failed:", {
      code: error.code,
      signal: error.signal,
      stderr: error.stderr,
      message: error.message,
    });
    const transcriptionError = new Error(
      error.code === "ENOENT"
        ? "whisper-cli is missing. Run npm run setup:speech, then restart the app."
        : "Local transcription failed. Check the recording and speech model, then try again.",
    );
    transcriptionError.statusCode = 503;
    throw transcriptionError;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > maxMessages) {
    return null;
  }

  const validMessages = [];
  for (const message of messages) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.trim().length === 0 ||
      message.content.length > maxMessageCharacters
    ) {
      return null;
    }
    validMessages.push({ role: message.role, content: message.content.trim() });
  }

  return validMessages.at(-1)?.role === "user" ? validMessages : null;
}

async function serveStaticFile(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL path." });
    return;
  }

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const filePath = path.resolve(publicDirectory, relativePath);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Length": content.length,
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    throw error;
  }
}

export function createAppServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  transcribeImpl = transcribeOnDevice,
} = {}) {
  const baseUrl = (env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env.AI_MODEL || "gpt-4o-mini";
  const companyName = env.COMPANY_NAME || "Northstar";
  const supportContext =
    env.SUPPORT_CONTEXT ||
    "Be friendly and concise. Never invent policies, prices, order details, or promises. If you cannot confirm an answer, say so and recommend contacting a human support representative.";

  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        sendJson(response, 200, { ok: true, modelConfigured: Boolean(env.AI_API_KEY) });
        return;
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        sendJson(response, 200, { companyName });
        return;
      }

      if (url.pathname === "/api/transcribe" && request.method === "POST") {
        const contentType = request.headers["content-type"]?.split(";")[0].trim();
        if (contentType !== "audio/wav") {
          sendJson(response, 415, { error: "Send the microphone recording as a WAV audio file." });
          return;
        }

        const audio = await readBinaryBody(request, maxAudioBytes);
        if (!isWavFile(audio)) {
          sendJson(response, 400, { error: "The microphone recording isn't a valid WAV file." });
          return;
        }

        const language = request.headers["x-speech-language"] || "en-US";
        if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
          sendJson(response, 400, { error: "The speech language code is invalid." });
          return;
        }

        const transcript = await transcribeImpl(audio, language, env);
        sendJson(response, 200, { transcript });
        return;
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        if (!env.AI_API_KEY) {
          sendJson(response, 503, { error: "Add AI_API_KEY to your local .env file to enable AI replies." });
          return;
        }

        const body = await readJsonBody(request);
        const messages = validateMessages(body?.messages);
        if (!messages) {
          sendJson(response, 400, {
            error: `Send 1–${maxMessages} non-empty user/assistant messages, ending with a user message (up to ${maxMessageCharacters} characters each).`,
          });
          return;
        }

        let upstream;
        try {
          upstream = await fetchImpl(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.AI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "system",
                  content: `You are the customer support voice assistant for ${companyName}. Always answer every user message in English, regardless of the language the user writes in. Preserve names, URLs, order IDs, and technical identifiers as written. ${supportContext}`,
                },
                ...messages,
              ],
              temperature: 0.4,
            }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          console.error("AI provider request failed:", error.message);
          sendJson(response, 502, { error: "Could not reach the AI service. Check the provider URL and try again." });
          return;
        }

        if (!upstream.ok) {
          console.error(`AI provider returned HTTP ${upstream.status}.`);
          sendJson(response, 502, { error: "The AI service could not answer right now. Please try again." });
          return;
        }

        let result;
        try {
          result = await upstream.json();
        } catch (error) {
          console.error("AI provider returned invalid JSON:", error.message);
          sendJson(response, 502, { error: "The AI service returned an invalid response. Please try again." });
          return;
        }

        const answer = result?.choices?.[0]?.message?.content;
        if (typeof answer !== "string" || !answer.trim()) {
          console.error("AI provider response did not contain a message.");
          sendJson(response, 502, { error: "The AI service returned an empty response. Please try again." });
          return;
        }

        sendJson(response, 200, { answer: answer.trim() });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "API route not found." });
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }

      await serveStaticFile(request, response, url.pathname);
    } catch (error) {
      console.error("Request failed:", error.message);
      if (!response.headersSent) {
        sendJson(response, error.statusCode ?? 500, {
          error: error.statusCode ? error.message : "The server could not complete the request.",
        });
      } else {
        response.destroy();
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createAppServer();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, "127.0.0.1", () => {
    console.log(`Customer voice assistant ready at http://127.0.0.1:${port}`);
  });
}
