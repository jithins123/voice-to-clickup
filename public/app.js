const els = {
  status: document.querySelector("#connectionStatus"),
  recordButton: document.querySelector("#recordButton"),
  recordingTitle: document.querySelector("#recordingTitle"),
  recordingHint: document.querySelector("#recordingHint"),
  clearButton: document.querySelector("#clearButton"),
  extractButton: document.querySelector("#extractButton"),
  transcript: document.querySelector("#transcript"),
  transcriptCount: document.querySelector("#transcriptCount"),
  tasks: document.querySelector("#tasks"),
  taskCount: document.querySelector("#taskCount")
};

let config = {};
let starting = false;
let recording = false;
let finalizing = false;
let holdActive = false;
let stopTimer = null;
let pc = null;
let dataChannel = null;
let mediaStream = null;
let recognition = null;
let partialTranscript = "";
let taskDrafts = [];
let streamedTranscriptItems = new Set();
let transcriptWaiter = null;

init();

async function init() {
  config = await fetchJson("/api/config").catch(() => ({}));
  setSetupStatus();
  bindEvents();
  updateWordCount();
}

function bindEvents() {
  els.recordButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    holdActive = true;
    startRecording();
  });

  els.recordButton.addEventListener("pointerup", endHold);
  els.recordButton.addEventListener("pointercancel", endHold);
  els.recordButton.addEventListener("pointerleave", () => {
    if (holdActive) endHold();
  });

  els.recordButton.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && !holdActive) {
      event.preventDefault();
      holdActive = true;
      startRecording();
    }
  });

  els.recordButton.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      endHold();
    }
  });

  els.clearButton.addEventListener("click", () => {
    els.transcript.value = "";
    partialTranscript = "";
    taskDrafts = [];
    renderTasks();
    updateWordCount();
  });

  els.extractButton.addEventListener("click", extractTasks);
  els.transcript.addEventListener("input", updateWordCount);
}

function endHold() {
  holdActive = false;
  window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    stopRecording();
  }, 350);
}

async function startRecording() {
  window.clearTimeout(stopTimer);
  if (starting || recording || finalizing) return;

  starting = true;
  streamedTranscriptItems = new Set();
  setStatusText("Starting microphone", "Keep holding while the microphone connects.");

  try {
    if (config.hasOpenAI && window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia) {
      await startRealtimeRecording();
      setRecordingUi(true, "Listening live", "Transcript text appears while you speak. Release to finish this note.");
    } else {
      startBrowserSpeechRecognition();
      setRecordingUi(true, "Listening locally", "Transcript text appears while you speak. Release to finish this note.");
    }

    if (!holdActive) {
      stopRecording();
    }
  } catch (error) {
    cleanupRealtimeConnection();
    setRecordingUi(false, "Ready to listen", error.message || "Could not start recording.");
  } finally {
    starting = false;
  }
}

async function startRealtimeRecording() {
  const tokenData = await fetchJson("/api/realtime/token");
  const ephemeralKey = tokenData.value || tokenData.client_secret?.value;
  if (!ephemeralKey) throw new Error("Realtime token response did not include a usable key.");

  const activePc = new RTCPeerConnection();
  pc = activePc;

  dataChannel = activePc.createDataChannel("oai-events");
  dataChannel.addEventListener("message", (event) => handleRealtimeEvent(JSON.parse(event.data)));

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  activePc.addTrack(mediaStream.getAudioTracks()[0]);

  const offer = await activePc.createOffer();
  await activePc.setLocalDescription(offer);
  await waitForIceGatheringComplete(activePc);

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      "Content-Type": "application/sdp"
    },
    body: activePc.localDescription?.sdp || offer.sdp
  });

  const answerSdp = await response.text();
  if (!response.ok) {
    throw new Error(answerSdp);
  }

  if (activePc !== pc) {
    throw new Error("Recording startup was cancelled. Please try again.");
  }

  if (activePc.signalingState !== "have-local-offer") {
    throw new Error(`WebRTC connection moved to ${activePc.signalingState}. Please hold the microphone again.`);
  }

  await activePc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  recording = true;
}

function startBrowserSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    throw new Error("This browser does not support live speech recognition. Try Chrome or Edge.");
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = config.defaultLanguage || "en";

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += `${text} `;
      else interimText += text;
    }

    if (finalText) appendTranscript(finalText);
    partialTranscript = interimText;
    updateWordCount();
  };

  recognition.onend = () => {
    if (recording && holdActive) recognition.start();
  };

  recognition.start();
  recording = true;
}

async function stopRecording() {
  if (!starting && !recording && !finalizing) return;

  holdActive = false;
  starting = false;

  if (recognition) {
    recording = false;
    recognition.stop();
    recognition = null;
    partialTranscript = "";
    setRecordingUi(false, "Ready to listen", "Hold the microphone while speaking, then release to stop.");
    updateWordCount();
    return;
  }

  if (recording && dataChannel) {
    finalizing = true;
    recording = false;
    mediaStream?.getTracks().forEach((track) => track.stop());
    setRecordingUi(false, "Finishing transcript", "Waiting for the final words before closing the microphone session.");
    sendRealtimeEvent({ type: "input_audio_buffer.commit" });
    await waitForTranscriptCompletion(3500);
  }

  finalizing = false;
  cleanupRealtimeConnection();
  partialTranscript = "";
  setRecordingUi(false, "Ready to listen", "Hold the microphone while speaking, then release to stop.");
  updateWordCount();
}

function cleanupRealtimeConnection() {
  dataChannel?.close();
  pc?.close();
  mediaStream?.getTracks().forEach((track) => track.stop());
  dataChannel = null;
  pc = null;
  mediaStream = null;
}

function sendRealtimeEvent(event) {
  if (!dataChannel || dataChannel.readyState !== "open") return false;
  dataChannel.send(JSON.stringify(event));
  return true;
}

function waitForTranscriptCompletion(timeoutMs) {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs);

    function done() {
      window.clearTimeout(timeout);
      if (transcriptWaiter === done) transcriptWaiter = null;
      resolve();
    }

    transcriptWaiter = done;
  });
}

function waitForIceGatheringComplete(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, 2500);

    function done() {
      window.clearTimeout(timeout);
      peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }

    function onStateChange() {
      if (peerConnection.iceGatheringState === "complete") done();
    }

    peerConnection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

function handleRealtimeEvent(event) {
  if (event.type === "conversation.item.input_audio_transcription.delta") {
    if (event.item_id) streamedTranscriptItems.add(event.item_id);
    appendTranscript(event.delta || "");
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    if (!event.item_id || !streamedTranscriptItems.has(event.item_id)) {
      appendTranscript(`${event.transcript || partialTranscript} `);
    }
    partialTranscript = "";
    transcriptWaiter?.();
  }

  if (event.type === "error") {
    els.recordingHint.textContent = event.error?.message || "Realtime transcription reported an error.";
    transcriptWaiter?.();
  }
}

async function extractTasks() {
  const transcript = combinedTranscript().trim();
  if (!transcript) {
    els.recordingHint.textContent = "Add or speak a transcript before extracting tasks.";
    return;
  }

  els.extractButton.disabled = true;
  els.extractButton.textContent = "Extracting";
  setStatusText("Extracting task drafts", "Existing task cards will stay in place.");

  try {
    const result = await fetchJson("/api/tasks/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript })
    });

    const incoming = Array.isArray(result.tasks) ? result.tasks : [];
    if (!incoming.length) {
      setStatusText("No new tasks found", "Your existing task drafts were kept.");
      return;
    }

    const beforeCount = taskDrafts.length;
    taskDrafts = mergeTasks(taskDrafts, incoming);
    renderTasks();
    const addedCount = taskDrafts.length - beforeCount;
    setStatusText("Task drafts updated", addedCount ? `Added ${addedCount} new draft${addedCount === 1 ? "" : "s"}.` : "No duplicate task cards were added.");
  } catch (error) {
    setStatusText("Task extraction failed", error.message || "Your existing task drafts were kept.");
  } finally {
    els.extractButton.disabled = false;
    els.extractButton.textContent = "Extract Tasks";
  }
}

function mergeTasks(existing, incoming) {
  const seen = new Set(existing.map(taskKey));
  const next = [...existing];

  for (const task of incoming) {
    const normalized = normalizeClientTask(task);
    const key = taskKey(normalized);
    if (!normalized.name || seen.has(key)) continue;
    seen.add(key);
    next.push(normalized);
  }

  return next;
}

function renderTasks() {
  els.taskCount.textContent = `${taskDrafts.length} ${taskDrafts.length === 1 ? "task" : "tasks"}`;

  if (!taskDrafts.length) {
    els.tasks.className = "tasks-empty";
    els.tasks.textContent = "No task drafts yet.";
    return;
  }

  els.tasks.className = "";
  els.tasks.replaceChildren(...taskDrafts.map(taskCard));
}

function taskCard(task) {
  const card = document.createElement("article");
  card.className = "task-card";

  const title = document.createElement("h3");
  title.textContent = task.name || "Untitled task";

  const description = document.createElement("p");
  description.textContent = task.description || "No description captured.";

  const meta = document.createElement("div");
  meta.className = "meta-row";
  addMeta(meta, task.priority, `priority-${String(task.priority || "").toLowerCase()}`);
  addMeta(meta, task.due_date);
  for (const tag of task.tags || []) addMeta(meta, `#${tag}`);

  const status = document.createElement("p");
  status.className = "task-status";
  status.textContent = task.statusText || "";

  const button = document.createElement("button");
  button.className = `task-button ${task.sent ? "sent" : ""}`.trim();
  button.type = "button";
  button.textContent = task.sent ? "Sent" : config.hasClickUp ? "Send to ClickUp" : "Add ClickUp setup first";
  button.disabled = task.sent || !config.hasClickUp;
  button.addEventListener("click", () => sendTask(button, status, task));

  card.append(title, description, meta, status, button);
  return card;
}

async function sendTask(button, status, task) {
  button.disabled = true;
  button.textContent = "Sending";
  status.textContent = "Sending to ClickUp...";

  try {
    await fetchJson("/api/clickup/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task)
    });
    task.sent = true;
    task.statusText = "Sent to ClickUp.";
    renderTasks();
  } catch (error) {
    task.statusText = error.message || "ClickUp send failed.";
    status.textContent = task.statusText;
    button.disabled = false;
    button.textContent = "Try Again";
  }
}

function normalizeClientTask(task) {
  return {
    name: String(task.name || task.title || "").trim(),
    description: String(task.description || "").trim(),
    priority: task.priority || null,
    due_date: task.due_date || null,
    assignee_hint: task.assignee_hint || null,
    tags: Array.isArray(task.tags) ? task.tags.filter(Boolean).map(String) : [],
    confidence: Number(task.confidence || 0),
    sent: false,
    statusText: ""
  };
}

function taskKey(task) {
  return `${String(task.name || "").toLowerCase()}|${String(task.due_date || "").toLowerCase()}`;
}

function addMeta(container, value, extraClass = "") {
  if (!value) return;
  const pill = document.createElement("span");
  pill.className = `meta ${extraClass}`.trim();
  pill.textContent = value;
  container.append(pill);
}

function appendTranscript(text) {
  if (!text) return;
  const needsSpace = els.transcript.value && !/\s$/.test(els.transcript.value) && !/^\s|^[,.;:!?]/.test(text);
  els.transcript.value = `${els.transcript.value}${needsSpace ? " " : ""}${text}`;
  updateWordCount();
}

function combinedTranscript() {
  return `${els.transcript.value} ${partialTranscript}`.trim();
}

function updateWordCount() {
  const words = combinedTranscript().split(/\s+/).filter(Boolean).length;
  els.transcriptCount.textContent = `${words} ${words === 1 ? "word" : "words"}`;
}

function setStatusText(title, hint) {
  els.recordingTitle.textContent = title;
  els.recordingHint.textContent = hint;
}

function setRecordingUi(isRecording, title, hint) {
  recording = isRecording;
  els.recordButton.classList.toggle("recording", isRecording);
  setStatusText(title, hint);
}

function setSetupStatus() {
  if (config.hasOpenAI && config.hasClickUp) {
    els.status.textContent = "Ready";
    els.status.className = "status-pill ready";
    return;
  }

  const missing = [];
  if (!config.hasOpenAI) missing.push("OpenAI");
  if (!config.hasClickUp) missing.push("ClickUp");
  els.status.textContent = `Missing ${missing.join(" + ")}`;
  els.status.className = "status-pill warn";
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: cleanResponseText(text) };
    }
  }

  if (!response.ok) {
    const message = data.error || data.message || cleanResponseText(text) || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return data;
}

function cleanResponseText(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
