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
let pc = null;
let dataChannel = null;
let mediaStream = null;
let recognition = null;
let partialTranscript = "";

init();

async function init() {
  config = await fetchJson("/api/config").catch(() => ({}));
  setSetupStatus();
  bindEvents();
  updateWordCount();
}

function bindEvents() {
  els.recordButton.addEventListener("click", () => {
    if (starting) return;
    if (recording) stopRecording();
    else startRecording();
  });

  els.clearButton.addEventListener("click", () => {
    els.transcript.value = "";
    partialTranscript = "";
    renderTasks([]);
    updateWordCount();
  });

  els.extractButton.addEventListener("click", extractTasks);
  els.transcript.addEventListener("input", updateWordCount);
}

async function startRecording() {
  if (starting || recording) return;

  starting = true;
  els.recordButton.disabled = true;
  setStatusText("Starting microphone", "Connecting to live transcription.");

  try {
    if (config.hasOpenAI && window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia) {
      await startRealtimeRecording();
      setRecordingUi(true, "Listening live", "Transcript text will appear as you speak.");
      return;
    }

    startBrowserSpeechRecognition();
    setRecordingUi(true, "Listening locally", "Using your browser speech recognition fallback.");
  } catch (error) {
    cleanupRealtimeConnection();
    setRecordingUi(false, "Ready to listen", error.message || "Could not start recording.");
  } finally {
    starting = false;
    els.recordButton.disabled = false;
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
    throw new Error(`WebRTC connection moved to ${activePc.signalingState}. Please tap record again.`);
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
    if (recording) recognition.start();
  };

  recognition.start();
  recording = true;
}

function stopRecording() {
  starting = false;
  recording = false;
  cleanupRealtimeConnection();
  recognition?.stop();
  recognition = null;
  partialTranscript = "";
  setRecordingUi(false, "Ready to listen", "Use the microphone button whenever you want to capture tasks.");
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
    partialTranscript += event.delta || "";
    updateWordCount();
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    appendTranscript(`${event.transcript || partialTranscript} `);
    partialTranscript = "";
  }

  if (event.type === "error") {
    els.recordingHint.textContent = event.error?.message || "Realtime transcription reported an error.";
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

  try {
    const result = await fetchJson("/api/tasks/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript })
    });
    renderTasks(result.tasks || []);
  } catch (error) {
    els.tasks.className = "tasks-empty";
    els.tasks.textContent = error.message || "Task extraction failed.";
  } finally {
    els.extractButton.disabled = false;
    els.extractButton.textContent = "Extract Tasks";
  }
}

function renderTasks(tasks) {
  els.taskCount.textContent = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;

  if (!tasks.length) {
    els.tasks.className = "tasks-empty";
    els.tasks.textContent = "No task drafts yet.";
    return;
  }

  els.tasks.className = "";
  els.tasks.replaceChildren(...tasks.map(taskCard));
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

  const button = document.createElement("button");
  button.className = "task-button";
  button.type = "button";
  button.textContent = config.hasClickUp ? "Send to ClickUp" : "Add ClickUp setup first";
  button.disabled = !config.hasClickUp;
  button.addEventListener("click", () => sendTask(button, task));

  card.append(title, description, meta, button);
  return card;
}

async function sendTask(button, task) {
  button.disabled = true;
  button.textContent = "Sending";

  try {
    await fetchJson("/api/clickup/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task)
    });
    button.classList.add("sent");
    button.textContent = "Sent";
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message || "Try again";
  }
}

function addMeta(container, value, extraClass = "") {
  if (!value) return;
  const pill = document.createElement("span");
  pill.className = `meta ${extraClass}`.trim();
  pill.textContent = value;
  container.append(pill);
}

function appendTranscript(text) {
  els.transcript.value = `${els.transcript.value}${text}`.replace(/\s+/g, " ").trimStart();
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}
