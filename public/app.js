const conversation = document.querySelector("#conversation");
const composer = document.querySelector("#composer");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const micButton = document.querySelector("#mic-button");
const statusLabel = document.querySelector("#status-label");
const assistantStatus = statusLabel.parentElement;
const suggestions = document.querySelector("#suggestions");
const toast = document.querySelector("#toast");
const newChatButton = document.querySelector("#new-chat");
const chatList = document.querySelector("#chat-list");
const appShell = document.querySelector(".app-shell");
const sidebar = document.querySelector("#sidebar");
const sidebarToggle = document.querySelector("#sidebar-toggle");
const sidebarScrim = document.querySelector("#sidebar-scrim");
const settingsButton = document.querySelector("#settings-button");
const settingsDialog = document.querySelector("#settings-dialog");
const themeSelect = document.querySelector("#theme-select");
const voiceReplies = document.querySelector("#voice-replies");
const greetingTemplate = conversation.firstElementChild.cloneNode(true);

let chats = [{ id: 1, title: "New chat", messages: [] }];
let activeChat = chats[0];
let nextChatId = 2;
let isSending = false;
let isRecording = false;
let isTranscribing = false;
let speakReplies = voiceReplies.checked;
let localRecording = null;
let recordingTimeout;
let toastTimeout;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 5000);
}

function scrollToLatest() {
  conversation.scrollTop = conversation.scrollHeight;
}

function setSidebarOpen(open) {
  const isMobile = window.matchMedia("(max-width: 760px)").matches;
  sidebar.hidden = isMobile && !open;
  appShell.classList.toggle("sidebar-open", isMobile && open);
  sidebarToggle.setAttribute("aria-expanded", String(isMobile && open));
}

function renderChatList() {
  chatList.replaceChildren();
  for (const chat of chats) {
    const button = document.createElement("button");
    button.className = "chat-list-item";
    button.type = "button";
    button.textContent = chat.title;
    button.title = chat.title;
    if (chat === activeChat) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => selectChat(chat));
    chatList.append(button);
  }
}

function renderConversation(chat) {
  conversation.replaceChildren(greetingTemplate.cloneNode(true));
  conversation.classList.toggle("conversation-welcome", chat.messages.length === 0);
  chat.messages.forEach(({ role, content }) => addMessage(role, content));
  suggestions.classList.toggle("hidden", chat.messages.length > 0);
  statusLabel.textContent = "Ready when you are";
}

function selectChat(chat) {
  activeChat = chat;
  renderChatList();
  renderConversation(chat);
  setSidebarOpen(false);
  messageInput.value = "";
  if (!isSending) messageInput.focus();
}

function startNewChat() {
  if (activeChat.messages.length === 0) {
    messageInput.value = "";
    messageInput.focus();
    setSidebarOpen(false);
    return;
  }

  activeChat = { id: nextChatId++, title: "New chat", messages: [] };
  chats.unshift(activeChat);
  renderChatList();
  renderConversation(activeChat);
  messageInput.value = "";
  if (!isSending) messageInput.focus();
  setSidebarOpen(false);
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function addMessage(role, content, { speak = false } = {}) {
  const row = document.createElement("div");
  row.className = `message-row ${role === "user" ? "user-row" : "assistant-row"}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = role === "user" ? "Y" : "✦";

  const contentColumn = document.createElement("div");
  contentColumn.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.append(document.createTextNode(role === "user" ? "YOU" : "NORTHSTAR ASSISTANT "));
  const timeSeparator = document.createElement("span");
  timeSeparator.textContent = "·";
  meta.append(timeSeparator, document.createTextNode(" JUST NOW"));

  const bubble = document.createElement("div");
  bubble.className = `message-bubble ${role === "user" ? "user-bubble" : "assistant-bubble"}`;
  bubble.textContent = content;
  contentColumn.append(meta, bubble);
  row.append(avatar, contentColumn);
  conversation.append(row);
  scrollToLatest();

  if (speak && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(content));
  }
}

function addTypingIndicator() {
  const row = document.createElement("div");
  row.className = "message-row assistant-row typing";
  row.id = "typing-indicator";
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = "✦";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble assistant-bubble";
  bubble.setAttribute("aria-label", "Assistant is thinking");
  bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  row.append(avatar, bubble);
  conversation.append(row);
  scrollToLatest();
}

async function sendMessage(text) {
  const chat = activeChat;
  const content = text.trim();
  if (!content || isSending) return;

  chat.messages.push({ role: "user", content });
  if (chat.title === "New chat") {
    chat.title = content.length > 32 ? `${content.slice(0, 32).trimEnd()}…` : content;
  }
  renderChatList();
  if (activeChat === chat) {
    conversation.classList.remove("conversation-welcome");
    addMessage("user", content);
    suggestions.classList.add("hidden");
  }
  messageInput.value = "";
  isSending = true;
  sendButton.disabled = true;
  messageInput.disabled = true;
  if (activeChat === chat) {
    statusLabel.textContent = "Finding an answer...";
    addTypingIndicator();
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chat.messages.slice(-20) }),
    });
    const result = await response.json();
    if (activeChat === chat) document.querySelector("#typing-indicator")?.remove();

    if (!response.ok) {
      showToast(result.error || "Something went wrong. Please try again.");
      if (activeChat === chat) statusLabel.textContent = "Ready when you are";
      return;
    }

    chat.messages.push({ role: "assistant", content: result.answer });
    if (activeChat === chat) {
      addMessage("assistant", result.answer, { speak: speakReplies });
      statusLabel.textContent = "Ready when you are";
    }
  } catch (error) {
    if (activeChat === chat) document.querySelector("#typing-indicator")?.remove();
    console.error("Could not send message:", error);
    showToast("Couldn't connect. Check your connection and try again.");
    if (activeChat === chat) statusLabel.textContent = "Connection issue";
  } finally {
    isSending = false;
    sendButton.disabled = false;
    messageInput.disabled = false;
    if (activeChat === chat) messageInput.focus();
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(messageInput.value);
});

document.querySelectorAll(".suggestion").forEach((button) => {
  button.addEventListener("click", () => sendMessage(button.textContent));
});

newChatButton.addEventListener("click", startNewChat);

sidebarToggle.addEventListener("click", () => {
  setSidebarOpen(sidebar.hidden);
});

sidebarScrim.addEventListener("click", () => setSidebarOpen(false));

settingsButton.addEventListener("click", () => settingsDialog.showModal());
document.documentElement.dataset.theme = themeSelect.value;
themeSelect.addEventListener("change", () => {
  document.documentElement.dataset.theme = themeSelect.value;
});
voiceReplies.addEventListener("change", () => {
  speakReplies = voiceReplies.checked;
});
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewChat();
  }
  if (event.key === "Escape") setSidebarOpen(false);
});

renderChatList();
setSidebarOpen(false);
window.addEventListener("resize", () => setSidebarOpen(false));

function createWav(chunks, sourceSampleRate) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(sampleCount);
  let chunkOffset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, chunkOffset);
    chunkOffset += chunk.length;
  }

  const targetSampleRate = 16000;
  const ratio = sourceSampleRate / targetSampleRate;
  const targetSampleCount = Math.floor(sampleCount / ratio);
  const buffer = new ArrayBuffer(44 + targetSampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + targetSampleCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, targetSampleCount * 2, true);

  for (let index = 0; index < targetSampleCount; index += 1) {
    const first = Math.floor(index * ratio);
    const last = Math.min(Math.floor((index + 1) * ratio), sampleCount);
    let total = 0;
    for (let sourceIndex = first; sourceIndex < last; sourceIndex += 1) {
      total += samples[sourceIndex];
    }
    const average = last > first ? total / (last - first) : samples[first] || 0;
    const clamped = Math.max(-1, Math.min(1, average));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function startLocalRecording() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AudioContext) {
    showToast("This browser can't record audio. Try a current version of Chrome or type your message.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let speechDetected = false;
    let silenceDuration = 0;
    processor.onaudioprocess = (event) => {
      if (!isRecording) return;
      const input = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(input));
      let sumOfSquares = 0;
      for (const sample of input) sumOfSquares += sample * sample;
      const rms = Math.sqrt(sumOfSquares / input.length);
      if (rms >= 0.012) {
        speechDetected = true;
        silenceDuration = 0;
      } else if (speechDetected) {
        silenceDuration += (input.length / context.sampleRate) * 1000;
      }
      event.outputBuffer.getChannelData(0).fill(0);
      if (speechDetected && silenceDuration >= 1600) stopLocalRecording();
    };
    source.connect(processor);
    processor.connect(context.destination);
    localRecording = { stream, context, source, processor, chunks };
    isRecording = true;
    conversation.classList.add("is-listening");
    assistantStatus.classList.add("is-listening");
    micButton.classList.add("listening");
    micButton.setAttribute("aria-label", "Stop recording");
    statusLabel.textContent = "Listening — pause to transcribe, or tap the mic to finish";
    recordingTimeout = setTimeout(stopLocalRecording, 30_000);
  } catch (error) {
    console.error("Could not start local recording:", error);
    conversation.classList.remove("is-listening");
    assistantStatus.classList.remove("is-listening");
    showToast(error.name === "NotAllowedError"
      ? "Microphone access is blocked. Allow microphone access in your browser settings."
      : "Couldn't start the microphone. Check its connection and browser permissions.");
    statusLabel.textContent = "Ready when you are";
  }
}

async function stopLocalRecording() {
  if (!isRecording || !localRecording) return;
  isRecording = false;
  clearTimeout(recordingTimeout);
  const recording = localRecording;
  localRecording = null;
  const sampleRate = recording.context.sampleRate;
  conversation.classList.remove("is-listening");
  conversation.classList.add("is-transcribing");
  assistantStatus.classList.remove("is-listening");
  assistantStatus.classList.add("is-transcribing");
  micButton.classList.remove("listening");
  micButton.disabled = true;
  micButton.setAttribute("aria-label", "Transcribing recording");
  statusLabel.textContent = "Transcribing on this Mac...";

  try {
    recording.processor.disconnect();
    recording.source.disconnect();
    recording.stream.getTracks().forEach((track) => track.stop());
    await recording.context.close();

    const audio = createWav(recording.chunks, sampleRate);
    if (audio.size <= 44) {
      throw new Error("No speech was recorded. Try again and speak a little louder.");
    }

    isTranscribing = true;
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "X-Speech-Language": navigator.language || "en-US",
      },
      body: audio,
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Local transcription failed. Please try again.");
    }

    const transcript = typeof result.transcript === "string" ? result.transcript.trim() : "";
    if (!transcript) {
      throw new Error("No speech was detected. Try speaking a little louder.");
    }

    messageInput.value = transcript;
    if (!isSending) messageInput.focus();
    statusLabel.textContent = "Transcription ready — review and send";
  } catch (error) {
    console.error("Could not transcribe local recording:", error);
    showToast(error.message || "Couldn't connect to local transcription. Restart the app and try again.");
    statusLabel.textContent = "Ready when you are";
  } finally {
    isTranscribing = false;
    conversation.classList.remove("is-transcribing");
    assistantStatus.classList.remove("is-transcribing");
    micButton.disabled = false;
    micButton.setAttribute("aria-label", "Start voice input");
  }
}

micButton.addEventListener("click", () => {
  if (isRecording) stopLocalRecording();
  else if (!isSending && !isTranscribing) startLocalRecording();
});

document.querySelector("#composer-hint").textContent =
  "Tap the mic and speak; pause or tap again to finish · Your transcript appears here to review";

fetch("/api/config")
  .then((response) => {
    if (!response.ok) throw new Error(`Configuration request failed with ${response.status}`);
    return response.json();
  })
  .then(({ companyName }) => {
    if (typeof companyName !== "string" || !companyName.trim()) return;
    document.querySelector(".brand-company").textContent = companyName;
    document.querySelector(".brand").setAttribute("aria-label", `${companyName} Support home`);
    document.querySelector("#assistant-name").textContent = `${companyName} Assistant`;
    const assistantLabel = `${companyName.toUpperCase()} ASSISTANT `;
    greetingTemplate.querySelector(".message-meta").firstChild.textContent = assistantLabel;
    conversation.querySelector(".message-meta").firstChild.textContent = assistantLabel;
    document.title = `${companyName} Support — We're here to help`;
  })
  .catch((error) => console.error("Could not load assistant configuration:", error));
