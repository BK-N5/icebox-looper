let audioCtx = null;
let sharedStream = null;
let micSource = null;
let processor = null;

const NUM_TRACKS = 6;
const tracks = [];

let loopLength = 4.0; // seconds, for visuals
let loopLengthInSamples = null;
let loopStartTime = null;
let isPlaying = false;

let soloIndex = null;
let transportState = "idle"; // idle, recordingLoop1, playingLoop1, recordingLoop2Pending, recordingLoop2, playingAll

let visualLoopStart = performance.now() / 1000;

// NEW: boundary crossing memory
let lastPhase = 0;

// Track structure
for (let i = 0; i < NUM_TRACKS; i++) {
  tracks.push({
    buffer: null,
    source: null,
    gainNode: null,
    state: "empty", // empty, armed, recording, playing
    muted: false,
    muteArmed: false,
    unmuteArmed: false,
    soloArmed: false,
    unsoloArmed: false,
    volume: 1.0
  });
}

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function getLoopLengthSeconds() {
  const input = document.getElementById("loopLengthInput");
  let val = parseFloat(input.value);
  if (isNaN(val) || val < 0.5) val = 0.5;
  input.value = val;
  loopLength = val;
  return val;
}

// ---------- Loop phase & animation ----------

function getLoopPhase() {
  const now = performance.now() / 1000;
  const t = now - visualLoopStart;
  return ((t % loopLength) + loopLength) % loopLength / loopLength;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = (angleDeg - 90) * Math.PI / 180.0;
  return {
    x: cx + r * Math.cos(angleRad),
    y: cy + r * Math.sin(angleRad)
  };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function updateVisuals() {
  const phase = getLoopPhase();
  const tracksEls = document.querySelectorAll(".track");

  tracksEls.forEach((trackEl, index) => {
    const track = tracks[index];
    const svg = trackEl.querySelector("svg");
    const loopArc = svg.querySelector(".loop-arc");

    const d = describeArc(50, 50, 45, 0, 360 * phase);
    loopArc.setAttribute("d", d);

    trackEl.classList.toggle("armed", track.state === "armed");
    trackEl.classList.toggle("recording", track.state === "recording");
    trackEl.classList.toggle("playing", track.state === "playing");
    trackEl.classList.toggle("muted", track.muted && soloIndex === null);
    trackEl.classList.toggle("soloed", soloIndex === index);
    trackEl.classList.toggle("has-audio", !!track.buffer);

    trackEl.classList.toggle("mute-armed", track.muteArmed);
    trackEl.classList.toggle("unmute-armed", track.unmuteArmed);
    trackEl.classList.toggle("solo-armed", track.soloArmed);
    trackEl.classList.toggle("unsolo-armed", track.unsoloArmed);
  });

  handleQuantizedEvents(phase);

  requestAnimationFrame(updateVisuals);
}

// ---------- NEW: Boundary crossing detection ----------

function crossedBoundary(phase) {
  const crossed = lastPhase > 0.95 && phase < 0.05;
  lastPhase = phase;
  return crossed;
}

// ---------- Quantized events (mute/solo only now) ----------

function handleQuantizedEvents(phase) {
  if (!crossedBoundary(phase)) return;

  // VISUAL BOUNDARY FLASH
  document.body.classList.add("boundary-flash");
  setTimeout(() => {
    document.body.classList.remove("boundary-flash");
  }, 120);

  tracks.forEach((track, index) => {
    // Mute / unmute
    if (track.muteArmed) {
      track.muted = true;
      track.muteArmed = false;
      updateTrackGain(index);
      updateStatus(index);
    }
    if (track.unmuteArmed) {
      track.muted = false;
      track.unmuteArmed = false;
      updateTrackGain(index);
      updateStatus(index);
    }

    // Solo / unsolo
    if (track.soloArmed) {
      soloIndex = index;
      track.soloArmed = false;
      updateAllGains();
      updateAllStatuses();
    }
    if (track.unsoloArmed) {
      if (soloIndex === index) soloIndex = null;
      track.unsoloArmed = false;
      updateAllGains();
      updateAllStatuses();
    }
  });
}

// ---------- AudioWorklet setup ----------

function setupProcessorPort() {
  if (!processor) return;

  processor.port.onmessage = (event) => {
    const msg = event.data;

    if (msg.type === "loop1Recorded") {
      ensureAudioContext();

      loopLengthInSamples = msg.loopLengthInSamples;
      const floatData = msg.buffer;
      const audioBuffer = audioCtx.createBuffer(1, floatData.length, audioCtx.sampleRate);
      audioBuffer.copyToChannel(floatData, 0);

      const track = tracks[0];
      track.buffer = audioBuffer;
      track.state = "playing";

      const loopSeconds = loopLengthInSamples / audioCtx.sampleRate;
      loopLength = loopSeconds;
      visualLoopStart = performance.now() / 1000;

      transportState = "playingLoop1";
      updateStatus(0);

      if (!isPlaying) {
        startGlobalPlayback();
      }
    }

    if (msg.type === "loop2Started") {
      const idx = msg.trackIndex;
      if (tracks[idx]) {
        tracks[idx].state = "recording";
        transportState = "recordingLoop2";
        updateStatus(idx);
      }
    }

    if (msg.type === "loopRecorded") {
      ensureAudioContext();

      const idx = msg.trackIndex;
      const floatData = msg.buffer;
      const audioBuffer = audioCtx.createBuffer(1, floatData.length, audioCtx.sampleRate);
      audioBuffer.copyToChannel(floatData, 0);

      const track = tracks[idx];
      track.buffer = audioBuffer;
      track.state = "playing";

      if (!isPlaying) {
        startGlobalPlayback();
      } else {
        startTrackPlaybackInLoop(idx);
      }

      transportState = "playingAll";
      updateStatus(idx);
    }
  };
}

function setupProcessor() {
  // Called after micSource is created (from your intro code)
  ensureAudioContext();
  if (processor) return;

  audioCtx.audioWorklet.addModule("looper-processor.js").then(() => {
    processor = new AudioWorkletNode(audioCtx, "looper-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1
    });

    if (micSource) {
      micSource.connect(processor);
    }

    setupProcessorPort();
  });
}

// ---------- Playback ----------

function startTrackPlaybackInLoop(index) {
  ensureAudioContext();
  const track = tracks[index];
  if (!track.buffer) return;

  const source = audioCtx.createBufferSource();
  source.buffer = track.buffer;
  source.loop = true;

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = getEffectiveVolume(index);

  source.connect(gainNode).connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  source.start(now + 0.01);

  track.source = source;
  track.gainNode = gainNode;
}

function startGlobalPlayback() {
  ensureAudioContext();
  if (!loopLengthInSamples) return;

  const loopSeconds = loopLengthInSamples / audioCtx.sampleRate;
  loopLength = loopSeconds;

  const now = audioCtx.currentTime;
  isPlaying = true;

  tracks.forEach((track, index) => {
    if (!track.buffer) return;

    const source = audioCtx.createBufferSource();
    source.buffer = track.buffer;
    source.loop = true;

    const gainNode = audioCtx.createGain();
    gainNode.gain.value = getEffectiveVolume(index);

    source.connect(gainNode).connect(audioCtx.destination);

    source.start(now + 0.01);

    track.source = source;
    track.gainNode = gainNode;

    if (track.state === "empty") {
      track.state = "playing";
    }
  });

  updateAllStatuses();
}

function playAll() {
  if (!isPlaying) startGlobalPlayback();
}

function stopAll() {
  tracks.forEach((track, index) => {
    if (track.source) {
      try { track.source.stop(); } catch (e) {}
      track.source = null;
      track.gainNode = null;
    }
    if (track.state === "recording" || track.state === "armed") {
      track.state = track.buffer ? "playing" : "empty";
      updateStatus(index);
    }
  });
  isPlaying = false;
  loopStartTime = null;
  transportState = "idle";
  updateAllStatuses();
}

// ---------- Volume / Mute / Solo ----------

function getEffectiveVolume(index) {
  const track = tracks[index];

  if (soloIndex !== null) {
    return soloIndex === index ? track.volume : 0;
  }

  if (track.muted) return 0;
  return track.volume;
}

function updateTrackGain(index) {
  const track = tracks[index];
  if (track.gainNode) {
    track.gainNode.gain.value = getEffectiveVolume(index);
  }
}

function updateAllGains() {
  for (let i = 0; i < NUM_TRACKS; i++) {
    updateTrackGain(i);
  }
}

function toggleMute(index) {
  const track = tracks[index];

  if (!track.muted) {
    track.muteArmed = true;
    track.unmuteArmed = false;
  } else {
    track.unmuteArmed = true;
    track.muteArmed = false;
  }
}

function toggleSolo(index) {
  const track = tracks[index];

  if (soloIndex === index) {
    track.unsoloArmed = true;
    track.soloArmed = false;
  } else {
    track.soloArmed = true;
    track.unsoloArmed = false;
  }
}

// ---------- Clear ----------

function clearTrack(index) {
  const track = tracks[index];
  const statusEl = document.querySelector(`.track[data-index="${index}"] .track-status`);

  if (track.source) {
    try { track.source.stop(); } catch (e) {}
    track.source = null;
  }

  track.buffer = null;
  track.state = "empty";
  track.muted = false;
  track.muteArmed = false;
  track.unmuteArmed = false;
  track.soloArmed = false;
  track.unsoloArmed = false;

  statusEl.textContent = "Empty";
  updateTrackGain(index);
}

// ---------- Status text ----------

function updateStatus(index) {
  const track = tracks[index];
  const statusEl = document.querySelector(`.track[data-index="${index}"] .track-status`);

  if (!track.buffer && track.state === "empty") {
    statusEl.textContent = "Empty";
    return;
  }

  if (track.state === "armed") {
    statusEl.textContent = "Armed";
    return;
  }

  if (track.state === "recording") {
    statusEl.textContent = "Recording...";
    return;
  }

  if (soloIndex === index) {
    statusEl.textContent = "Soloed";
    return;
  }

  if (track.muted) {
    statusEl.textContent = "Muted";
    return;
  }

  if (track.buffer) {
    statusEl.textContent = "Playing";
    return;
  }

  statusEl.textContent = "Empty";
}

function updateAllStatuses() {
  for (let i = 0; i < NUM_TRACKS; i++) {
    updateStatus(i);
  }
}

// ---------- UI wiring ----------

window.addEventListener("DOMContentLoaded", () => {
  const trackEls = document.querySelectorAll(".track");

  trackEls.forEach(trackEl => {
    const index = parseInt(trackEl.getAttribute("data-index"), 10);
    const svg = trackEl.querySelector("svg");
    const middleRing = svg.querySelector(".middle-ring");
    const recordBtn = svg.querySelector(".record-btn");
    const clearBtn = trackEl.querySelector(".clear-btn");
    const volSlider = trackEl.querySelector(".vol-slider");

    let lastTapTime = 0;

    // Record button
    recordBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const track = tracks[index];

      // No overdub
      if (track.buffer && index !== 0) return;

      // Track 1 = master loop
      if (index === 0) {
        if (!track.buffer && transportState !== "recordingLoop1") {
          // Start recording loop 1
          if (processor) {
            processor.port.postMessage({ type: "startLoop1" });
            transportState = "recordingLoop1";
            track.state = "recording";
            updateStatus(index);
          }
        } else if (transportState === "recordingLoop1") {
          // Stop recording loop 1
          if (processor) {
            processor.port.postMessage({ type: "stopLoop1" });
          }
        }
        return;
      }

      // Tracks 2–5: must have master loop defined
      if (!loopLengthInSamples) return;

      if (!track.buffer) {
        // Arm this track to start on next loop boundary
        if (processor) {
          processor.port.postMessage({ type: "armLoop2", trackIndex: index });
          track.state = "armed";
          transportState = "recordingLoop2Pending";
          updateStatus(index);
        }
      }
    });

    // Middle ring: mute / solo
    middleRing.addEventListener("click", (e) => {
      e.stopPropagation();
      const now = Date.now();
      const delta = now - lastTapTime;

      if (delta < 300) {
        toggleSolo(index);
      } else {
        toggleMute(index);
      }

      lastTapTime = now;
    });

    clearBtn.addEventListener("click", () => clearTrack(index));

    volSlider.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      tracks[index].volume = v;
      updateTrackGain(index);
    });
  });

  // Kick off visuals
  requestAnimationFrame(updateVisuals);
});
