const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d", { alpha: false });
const audio = document.getElementById("audio");
const screenWrap = document.getElementById("screenWrap");
const soundPrompt = document.getElementById("soundPrompt");

const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { alpha: false });

let meta = null;
let socket = null;
let frames = new Map();
let requestedUntil = 0;
let lastDrawn = -1;
let playing = false;
let visualPlaying = true;
let visualStartedAt = 0;
let visualOffset = 0;
let lastToggleAt = 0;
let autoplayStarted = false;
let soundPromptTimer = 0;
let initialSoundCheckComplete = false;
let seekTargetFrame = null;
let endedResting = false;
const activePlaybackKeys = new Set();
const endedPauseTime = 8;
const soundPromptDelayMs = 1000;

function effectiveDuration() {
  return meta ? meta.durationMs / 1000 : 0;
}

function viewport() {
  return {
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };
}

function calculateCanvasSize(sourceWidth, sourceHeight, view) {
  const scale = Math.min(view.w / sourceWidth, view.h / sourceHeight);
  const cssWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const cssHeight = Math.max(1, Math.floor(sourceHeight * scale));
  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.floor(cssWidth * view.dpr)),
    pixelHeight: Math.max(1, Math.floor(cssHeight * view.dpr)),
  };
}

function resizeCanvas() {
  if (!meta) return;
  const size = calculateCanvasSize(meta.sourceWidth, meta.sourceHeight, viewport());
  canvas.style.width = `${size.cssWidth}px`;
  canvas.style.height = `${size.cssHeight}px`;
  screenWrap.style.width = `${size.cssWidth}px`;
  screenWrap.style.height = `${size.cssHeight}px`;
  canvas.width = size.pixelWidth;
  canvas.height = size.pixelHeight;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (lastDrawn >= 0 && frames.has(lastDrawn)) {
    drawFrame(lastDrawn);
  }
}

async function loadMeta() {
  const response = await fetch("/meta");
  if (!response.ok) throw new Error(`meta ${response.status}`);
  meta = await response.json();
  window.__badAppleDebugMeta = meta;
  sourceCanvas.width = meta.sourceWidth;
  sourceCanvas.height = meta.sourceHeight;
  resizeCanvas();
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    requestedUntil = 0;
    requestFrames(frameForTime(playbackTime()), 240, "hello");
  });
  socket.addEventListener("message", async (event) => {
    if (typeof event.data === "string") return;
    const data = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
    receiveChunk(data);
  });
  socket.addEventListener("close", () => {
    if (playing) {
      window.setTimeout(connect, 500);
    }
  });
}

function requestFrames(from, chunk = 240, type = "frames", force = false) {
  if (!meta || !socket || socket.readyState !== WebSocket.OPEN) return;
  const clampedFrom = Math.max(0, Math.min(meta.frames - 1, from));
  if (!force && clampedFrom < requestedUntil && type !== "hello") return;
  socket.send(JSON.stringify({
    type,
    viewport: viewport(),
    from: clampedFrom,
    chunk,
  }));
  requestedUntil = Math.min(meta.frames, clampedFrom + chunk);
}

function receiveChunk(buffer) {
  if (!meta || buffer.byteLength < 6) return;
  const view = new DataView(buffer);
  const start = view.getUint32(0, true);
  const count = view.getUint16(4, true);
  let offset = 6;
  for (let i = 0; i < count; i += 1) {
    const frame = new Uint8Array(buffer, offset, meta.frameBytes);
    frames.set(start + i, new Uint8Array(frame));
    offset += meta.frameBytes;
  }
  const target = frameForTime(playbackTime());
  if (seekTargetFrame !== null && frames.has(seekTargetFrame)) {
    drawFrame(seekTargetFrame);
    seekTargetFrame = null;
  } else if (frames.has(target) && (lastDrawn < 0 || visualPlaying)) {
    drawFrame(target);
  }
  if (!autoplayStarted && frames.has(0)) {
    autoplayStarted = true;
    audio.muted = false;
    scheduleSoundPromptCheck();
    audio.play().catch(() => {});
  }
}

function updateSoundButton() {
  if (audio.paused || audio.muted) {
    soundPrompt.hidden = false;
    return;
  }
  hideSoundPrompt();
}

function scheduleSoundPromptCheck() {
  if (soundPromptTimer) return;
  soundPromptTimer = window.setTimeout(() => {
    soundPromptTimer = 0;
    initialSoundCheckComplete = true;
    updateSoundButton();
  }, soundPromptDelayMs);
}

function hideSoundPrompt(clearPendingCheck = false) {
  if (clearPendingCheck && soundPromptTimer) {
    window.clearTimeout(soundPromptTimer);
    soundPromptTimer = 0;
    initialSoundCheckComplete = true;
  }
  soundPrompt.hidden = true;
}

function hideSoundPromptIfAudible() {
  if (!audio.paused && !audio.muted) {
    hideSoundPrompt();
  }
}

function seekToProgress(progress) {
  if (!meta) return;
  const duration = effectiveDuration();
  if (duration <= 0) return;
  const targetTime = Math.max(0, Math.min(1, progress)) * duration;
  const targetFrame = frameForTime(targetTime);
  const shouldPlayAudio = visualPlaying || !audio.paused;

  connect();
  endedResting = false;
  audio.currentTime = targetTime;
  visualOffset = targetTime;
  if (visualPlaying) {
    visualStartedAt = performance.now();
  }
  if (shouldPlayAudio) {
    audio.play().catch((error) => {
      console.error(error);
    });
  }

  seekTargetFrame = targetFrame;
  requestFrames(targetFrame, 240, "frames", true);
  if (frames.has(targetFrame)) {
    drawFrame(targetFrame);
    seekTargetFrame = null;
  }
}

function frameForTime(seconds) {
  if (!meta) return 0;
  const duration = effectiveDuration();
  if (duration > 0) {
    const progress = Math.max(0, Math.min(1, seconds / duration));
    return Math.max(0, Math.min(meta.frames - 1, Math.floor(progress * meta.frames)));
  }
  return Math.max(0, Math.min(meta.frames - 1, Math.floor(seconds * meta.fps)));
}

function playbackTime() {
  if (!audio.paused) return audio.currentTime;
  if (visualPlaying) {
    return visualOffset + (performance.now() - visualStartedAt) / 1000;
  }
  return visualOffset;
}

function drawFrame(index) {
  const packed = frames.get(index);
  if (!packed || !meta) return false;

  const image = sourceCtx.createImageData(meta.sourceWidth, meta.sourceHeight);
  const pixels = image.data;
  const total = meta.sourceWidth * meta.sourceHeight;
  for (let bit = 0; bit < total; bit += 1) {
    const on = (packed[bit >> 3] & (1 << (7 - (bit & 7)))) !== 0;
    const color = on ? 0 : 255;
    const p = bit * 4;
    pixels[p] = color;
    pixels[p + 1] = color;
    pixels[p + 2] = color;
    pixels[p + 3] = 255;
  }

  sourceCtx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  lastDrawn = index;
  return true;
}

function finishPlayback() {
  const duration = effectiveDuration();
  const restartTime = duration > 0 ? Math.min(endedPauseTime, duration) : 0;
  playing = false;
  visualPlaying = false;
  endedResting = true;
  visualOffset = restartTime;
  audio.pause();
  audio.currentTime = restartTime;
  hideSoundPrompt();

  seekTargetFrame = frameForTime(restartTime);
  requestFrames(seekTargetFrame, 240, "frames", true);
  if (frames.has(seekTargetFrame)) {
    drawFrame(seekTargetFrame);
    seekTargetFrame = null;
  }
}

function tick() {
  if (meta) {
    const current = playbackTime();
    if (visualPlaying && effectiveDuration() > 0 && current >= effectiveDuration()) {
      finishPlayback();
    }
    if (!audio.paused && effectiveDuration() > 0 && audio.currentTime >= effectiveDuration()) {
      finishPlayback();
    }
    const target = frameForTime(current);
    if (!frames.has(target)) {
      requestFrames(target, 240);
    } else if (target !== lastDrawn) {
      drawFrame(target);
      if (target === seekTargetFrame) {
        seekTargetFrame = null;
      }
    }
    if (target + 120 > requestedUntil) {
      requestFrames(requestedUntil, 240);
    }
  }
  requestAnimationFrame(tick);
}

async function togglePlayback() {
  connect();
  audio.muted = false;
  hideSoundPrompt(true);
  if (visualPlaying) {
    endedResting = false;
    visualOffset = playbackTime();
    visualPlaying = false;
    if (!audio.paused) {
      audio.pause();
    }
  } else {
    if (endedResting) {
      endedResting = false;
      visualOffset = 0;
    }
    visualStartedAt = performance.now();
    visualPlaying = true;
    audio.currentTime = Math.min(visualOffset, effectiveDuration());
    await audio.play();
  }
  hideSoundPrompt(true);
}

async function playSoundFromPrompt() {
  connect();
  audio.muted = false;
  if (endedResting) {
    endedResting = false;
    visualOffset = 0;
  }
  audio.currentTime = Math.min(playbackTime(), effectiveDuration());
  visualStartedAt = performance.now();
  visualOffset = audio.currentTime;
  visualPlaying = true;
  await audio.play();
  hideSoundPrompt(true);
}

audio.addEventListener("play", () => {
  playing = true;
  visualPlaying = true;
  if (initialSoundCheckComplete) {
    hideSoundPrompt();
  }
});

audio.addEventListener("pause", () => {
  playing = false;
  if (audio.currentTime > 0 && audio.currentTime < effectiveDuration()) {
    visualOffset = audio.currentTime;
  }
});

audio.addEventListener("ended", () => {
  finishPlayback();
});

audio.addEventListener("volumechange", hideSoundPromptIfAudible);

soundPrompt.addEventListener("click", (event) => {
  event.stopPropagation();
  playSoundFromPrompt().catch((error) => {
    console.error(error);
  });
});

screenWrap.addEventListener("click", (event) => {
  const rect = screenWrap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (y >= rect.height * 0.75) {
    seekToProgress(x / rect.width);
    return;
  }

  togglePlayback().catch((error) => {
    console.error(error);
  });
});

function isPlaybackKey(event) {
  return event.key === " " || event.key === "Enter";
}

function handlePlaybackKeyDown(event) {
  if (!isPlaybackKey(event)) return;
  event.preventDefault();
  if (event.repeat || activePlaybackKeys.has(event.code)) return;
  activePlaybackKeys.add(event.code);

  const now = performance.now();
  if (now - lastToggleAt < 150) return;
  lastToggleAt = now;
  togglePlayback().catch((error) => {
    console.error(error);
  });
}

function handlePlaybackKeyUp(event) {
  if (!isPlaybackKey(event)) return;
  event.preventDefault();
  activePlaybackKeys.delete(event.code);
}

window.addEventListener("keydown", handlePlaybackKeyDown);
window.addEventListener("keyup", handlePlaybackKeyUp);
window.addEventListener("blur", () => {
  activePlaybackKeys.clear();
});

window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", resizeCanvas);

loadMeta()
  .then(() => {
    visualStartedAt = performance.now();
    requestAnimationFrame(tick);
    connect();
  })
  .catch((error) => {
    console.error(error);
  });

window.badAppleSizing = { calculateCanvasSize };
