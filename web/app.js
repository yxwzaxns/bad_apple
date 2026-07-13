const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d", { alpha: false });
const audio = document.getElementById("audio");
const stage = document.querySelector(".stage");
const screenWrap = document.getElementById("screenWrap");
const soundPrompt = document.getElementById("soundPrompt");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingStatus = document.getElementById("loadingStatus");
const loadingProgress = document.getElementById("loadingProgress");
const loadingBar = document.getElementById("loadingBar");
const loadingPercent = document.getElementById("loadingPercent");
const loadingRetry = document.getElementById("loadingRetry");

const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { alpha: false });
const dotLayerCanvas = document.createElement("canvas");
const dotLayerCtx = dotLayerCanvas.getContext("2d");
const dotMaskCanvas = document.createElement("canvas");
const dotMaskCtx = dotMaskCanvas.getContext("2d");
const dotTileCanvas = document.createElement("canvas");
const dotTileCtx = dotTileCanvas.getContext("2d");

let meta = null;
let socket = null;
let frames = new Map();
let frameData = null;
let loadedFrameCount = 0;
let frameTransport = "pending";
let frameStreamComplete = false;
let requestedUntil = 0;
let lastDrawn = -1;
let visualPlaying = false;
let visualStartedAt = 0;
let visualOffset = 0;
let lastToggleAt = 0;
let soundPromptTimer = 0;
let initialSoundCheckComplete = false;
let seekTargetFrame = null;
let endedResting = false;
let sourceImage = null;
let resizeFrame = 0;
let reconnectTimer = 0;
let appReady = false;
let startScheduled = false;
let loadingFailed = false;
let playbackBuffering = false;
let resumeAfterBuffering = false;
let bufferingReason = "frames";
let audioCanPlayAt = 0;
let audioReadyTimer = 0;
let audioWaitingTimer = 0;
const activePlaybackKeys = new Set();
const endedPauseTime = 8;
const soundPromptDelayMs = 1000;
const dotTileSize = 32;
const dotDiameterRatio = 0.74;
const maxRenderDpr = 2;
const maxRenderPixels = 8_000_000;
const initialBufferFrames = 90;
const initialChunkFrames = 30;
const resumeBufferFrames = 45;
const startupAudioBufferSeconds = 8;
const audioResumeBufferSeconds = 3;
const maxAudioBufferWaitMs = 12000;
const loadingState = {
  interface: true,
  metadata: false,
  audio: false,
  transport: false,
  frames: 0,
};
const loadingWeights = {
  interface: 5,
  metadata: 20,
  audio: 25,
  transport: 15,
  frames: 35,
};

function hasFrame(index) {
  return (frameData !== null && index >= 0 && index < loadedFrameCount) || frames.has(index);
}

function getFrame(index) {
  if (frameData !== null && index >= 0 && index < loadedFrameCount) {
    const start = index * meta.frameBytes;
    return frameData.subarray(start, start + meta.frameBytes);
  }
  return frames.get(index);
}

function availableFramesFrom(index, limit) {
  let count = 0;
  while (count < limit && index + count < meta.frames && hasFrame(index + count)) {
    count += 1;
  }
  return count;
}

function bufferedAudioSeconds() {
  const current = audio.currentTime;
  for (let i = 0; i < audio.buffered.length; i += 1) {
    if (audio.buffered.start(i) <= current + 0.1 && audio.buffered.end(i) >= current) {
      return audio.buffered.end(i) - current;
    }
  }
  return 0;
}

function bufferedInitialFrames() {
  let count = 0;
  while (count < initialBufferFrames && hasFrame(count)) {
    count += 1;
  }
  return count;
}

function loadingValue() {
  const frameProgress = Math.min(1, loadingState.frames / initialBufferFrames);
  return Math.round(
    (loadingState.interface ? loadingWeights.interface : 0)
    + (loadingState.metadata ? loadingWeights.metadata : 0)
    + (loadingState.audio ? loadingWeights.audio : 0)
    + (loadingState.transport ? loadingWeights.transport : 0)
    + frameProgress * loadingWeights.frames,
  );
}

function refreshLoadingStatus() {
  if (loadingFailed || startScheduled || appReady) return;
  if (!loadingState.metadata) {
    loadingStatus.textContent = "Loading playback metadata…";
  } else if (!loadingState.audio) {
    loadingStatus.textContent = "Preparing audio…";
  } else if (!loadingState.transport) {
    loadingStatus.textContent = "Opening frame stream…";
  } else if (loadingState.frames < initialBufferFrames) {
    loadingStatus.textContent = `Buffering animation ${loadingState.frames} / ${initialBufferFrames}…`;
  }
}

function renderLoadingProgress() {
  const value = loadingValue();
  loadingBar.style.width = `${value}%`;
  loadingPercent.textContent = `${value}%`;
  loadingProgress.setAttribute("aria-valuenow", String(value));
  refreshLoadingStatus();
}

function markLoadingReady(resource) {
  if (loadingState[resource]) return;
  loadingState[resource] = true;
  renderLoadingProgress();
  maybeStartPlayback();
}

function updateFrameLoading() {
  loadingState.frames = bufferedInitialFrames();
  renderLoadingProgress();
  maybeStartPlayback();
}

function showLoadingError(message) {
  loadingFailed = true;
  visualPlaying = false;
  audio.pause();
  loadingOverlay.classList.add("has-error");
  loadingStatus.textContent = message;
  loadingOverlay.setAttribute("aria-busy", "false");
  loadingRetry.hidden = false;
}

function maybeStartPlayback() {
  if (
    loadingFailed
    || startScheduled
    || appReady
    || !loadingState.metadata
    || !loadingState.audio
    || !loadingState.transport
    || loadingState.frames < initialBufferFrames
  ) {
    return;
  }

  startScheduled = true;
  drawFrame(0);
  loadingBar.style.width = "100%";
  loadingPercent.textContent = "100%";
  loadingProgress.setAttribute("aria-valuenow", "100");
  loadingStatus.textContent = "Ready";
  window.setTimeout(startPlayback, 300);
}

function startPlayback() {
  if (appReady || loadingFailed) return;
  appReady = true;
  loadingOverlay.setAttribute("aria-busy", "false");
  loadingOverlay.classList.add("is-hidden");
  visualOffset = 0;
  visualStartedAt = performance.now();
  visualPlaying = true;
  endedResting = false;
  audio.currentTime = 0;
  audio.muted = false;
  if (frameTransport === "websocket") {
    requestFrames(initialBufferFrames, 120);
  }
  scheduleSoundPromptCheck();
  audio.play().catch(() => {});
}

function showPlaybackBuffering(currentTime, reason = "frames") {
  if (playbackBuffering || !appReady) return;
  playbackBuffering = true;
  bufferingReason = reason;
  resumeAfterBuffering = visualPlaying || !audio.paused;
  visualOffset = currentTime;
  visualPlaying = false;
  audio.pause();
  loadingOverlay.classList.remove("is-hidden");
  loadingOverlay.setAttribute("aria-busy", "true");
  loadingStatus.textContent = reason === "audio" ? "Buffering audio…" : "Buffering playback…";
  updatePlaybackBufferProgress();
}

function updatePlaybackBufferProgress() {
  if (!playbackBuffering || !meta) return;
  let value;
  if (bufferingReason === "audio") {
    value = Math.min(100, Math.round(bufferedAudioSeconds() / audioResumeBufferSeconds * 100));
  } else {
    const target = frameForTime(visualOffset);
    const needed = Math.min(resumeBufferFrames, meta.frames - target);
    const available = availableFramesFrom(target, needed);
    value = needed > 0 ? Math.round(available / needed * 100) : 100;
  }
  loadingBar.style.width = `${value}%`;
  loadingPercent.textContent = `${value}%`;
  loadingProgress.setAttribute("aria-valuenow", String(value));
}

function resumeBufferedPlayback() {
  if (!playbackBuffering || !meta) return;
  const target = frameForTime(visualOffset);
  const needed = Math.min(resumeBufferFrames, meta.frames - target);
  if (availableFramesFrom(target, needed) < needed) {
    updatePlaybackBufferProgress();
    return;
  }
  if (
    bufferingReason === "audio"
    && bufferedAudioSeconds() < audioResumeBufferSeconds
    && audio.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA
  ) {
    updatePlaybackBufferProgress();
    return;
  }

  playbackBuffering = false;
  drawFrame(target);
  loadingOverlay.setAttribute("aria-busy", "false");
  loadingOverlay.classList.add("is-hidden");
  if (!resumeAfterBuffering) return;

  visualStartedAt = performance.now();
  visualPlaying = true;
  audio.currentTime = Math.min(visualOffset, effectiveDuration());
  audio.play().catch(() => {});
}

function buildDotTile() {
  dotTileCanvas.width = dotTileSize;
  dotTileCanvas.height = dotTileSize;
  dotTileCtx.clearRect(0, 0, dotTileSize, dotTileSize);
  dotTileCtx.fillStyle = "#fff";
  dotTileCtx.beginPath();
  dotTileCtx.arc(
    dotTileSize / 2,
    dotTileSize / 2,
    dotTileSize * dotDiameterRatio / 2,
    0,
    Math.PI * 2,
  );
  dotTileCtx.fill();
}

function effectiveDuration() {
  return meta ? meta.durationMs / 1000 : 0;
}

function viewport() {
  const visualViewport = window.visualViewport;
  return {
    w: visualViewport ? visualViewport.width : window.innerWidth,
    h: visualViewport ? visualViewport.height : window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };
}

function syncViewportSize(view) {
  document.documentElement.style.setProperty("--app-width", `${Math.round(view.w)}px`);
  document.documentElement.style.setProperty("--app-height", `${Math.round(view.h)}px`);
}

function stageViewport(view) {
  const styles = window.getComputedStyle(stage);
  const horizontalPadding = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
  return {
    w: Math.max(1, view.w - horizontalPadding),
    h: Math.max(1, view.h - verticalPadding),
    dpr: view.dpr,
  };
}

function calculateCanvasSize(sourceWidth, sourceHeight, view) {
  const scale = Math.min(view.w / sourceWidth, view.h / sourceHeight);
  const cssWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const cssHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const pixelBudgetDpr = Math.sqrt(maxRenderPixels / (cssWidth * cssHeight));
  const renderDpr = Math.max(0.5, Math.min(view.dpr, maxRenderDpr, pixelBudgetDpr));
  return {
    cssWidth,
    cssHeight,
    pixelWidth: Math.max(1, Math.floor(cssWidth * renderDpr)),
    pixelHeight: Math.max(1, Math.floor(cssHeight * renderDpr)),
    renderDpr,
  };
}

function resizeCanvas() {
  const view = viewport();
  syncViewportSize(view);
  if (!meta) return;
  const size = calculateCanvasSize(meta.sourceWidth, meta.sourceHeight, stageViewport(view));
  canvas.style.width = `${size.cssWidth}px`;
  canvas.style.height = `${size.cssHeight}px`;
  screenWrap.style.width = `${size.cssWidth}px`;
  screenWrap.style.height = `${size.cssHeight}px`;
  if (
    canvas.width === size.pixelWidth
    && canvas.height === size.pixelHeight
    && dotLayerCanvas.width === size.pixelWidth
    && dotLayerCanvas.height === size.pixelHeight
  ) {
    return;
  }
  canvas.width = size.pixelWidth;
  canvas.height = size.pixelHeight;
  dotLayerCanvas.width = size.pixelWidth;
  dotLayerCanvas.height = size.pixelHeight;
  dotMaskCanvas.width = size.pixelWidth;
  dotMaskCanvas.height = size.pixelHeight;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  rebuildDotMask();
  if (lastDrawn >= 0 && hasFrame(lastDrawn)) {
    drawFrame(lastDrawn);
  }
}

function scheduleResize() {
  if (resizeFrame) return;
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0;
    resizeCanvas();
  });
}

function rebuildDotMask() {
  if (!meta || dotMaskCanvas.width === 0 || dotMaskCanvas.height === 0) return;

  const cellWidth = dotMaskCanvas.width / meta.sourceWidth;
  const cellHeight = dotMaskCanvas.height / meta.sourceHeight;
  const pattern = dotMaskCtx.createPattern(dotTileCanvas, "repeat");
  if (!pattern) return;

  dotMaskCtx.clearRect(0, 0, dotMaskCanvas.width, dotMaskCanvas.height);
  dotMaskCtx.save();
  dotMaskCtx.scale(cellWidth / dotTileSize, cellHeight / dotTileSize);
  dotMaskCtx.fillStyle = pattern;
  dotMaskCtx.fillRect(
    0,
    0,
    dotMaskCanvas.width * dotTileSize / cellWidth,
    dotMaskCanvas.height * dotTileSize / cellHeight,
  );
  dotMaskCtx.restore();
}

async function loadMeta() {
  const response = await fetch("/meta");
  if (!response.ok) throw new Error(`meta ${response.status}`);
  meta = await response.json();
  window.__badAppleDebugMeta = meta;
  sourceCanvas.width = meta.sourceWidth;
  sourceCanvas.height = meta.sourceHeight;
  sourceImage = sourceCtx.createImageData(meta.sourceWidth, meta.sourceHeight);
  resizeCanvas();
  markLoadingReady("metadata");
}

async function loadFrameStream() {
  const version = encodeURIComponent(meta.framesVersion || "current");
  const response = await fetch(`/frames?v=${version}`, {
    cache: "force-cache",
    priority: "low",
  });
  if (!response.ok) throw new Error(`frames ${response.status}`);

  frameTransport = "http";
  markLoadingReady("transport");
  const totalBytes = meta.frames * meta.frameBytes;
  frameData = new Uint8Array(totalBytes);
  loadedFrameCount = 0;
  let received = 0;

  const acceptChunk = (chunk) => {
    if (received + chunk.byteLength > totalBytes) {
      throw new Error(`frame stream exceeds ${totalBytes} bytes`);
    }
    frameData.set(chunk, received);
    received += chunk.byteLength;
    loadedFrameCount = Math.floor(received / meta.frameBytes);
    updateFrameLoading();
    resumeBufferedPlayback();
  };

  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acceptChunk(value);
    }
  } else {
    acceptChunk(new Uint8Array(await response.arrayBuffer()));
  }

  if (received !== totalBytes) {
    throw new Error(`frame stream length ${received}, want ${totalBytes}`);
  }
  frameStreamComplete = true;
  loadedFrameCount = meta.frames;
  resumeBufferedPlayback();
}

function useWebSocketFallback(error) {
  console.warn("HTTP frame stream failed, using WebSocket fallback", error);
  frameTransport = "websocket";
  loadingState.transport = false;
  if (!appReady) {
    renderLoadingProgress();
  }
  connect();
}

function connect() {
  if (frameTransport !== "websocket") return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = 0;
    }
    markLoadingReady("transport");
    requestedUntil = 0;
    if (appReady) {
      const target = frameForTime(playbackTime());
      requestFrames(Math.max(target, loadedFrameCount), 120, "hello");
    } else {
      requestFrames(bufferedInitialFrames(), initialChunkFrames, "hello");
    }
  });
  socket.addEventListener("message", async (event) => {
    if (typeof event.data === "string") return;
    const data = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
    receiveChunk(data);
  });
  socket.addEventListener("close", () => {
    loadingState.transport = false;
    if (!appReady) {
      renderLoadingProgress();
    }
    if ((visualPlaying || playbackBuffering || !appReady) && !reconnectTimer) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = 0;
        connect();
      }, 750);
    }
  });
}

function requestFrames(from, chunk = 120, type = "frames", force = false) {
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
  if (buffer.byteLength < 6 + count * meta.frameBytes) return;
  let offset = 6;
  for (let i = 0; i < count; i += 1) {
    const frame = new Uint8Array(buffer, offset, meta.frameBytes);
    frames.set(start + i, new Uint8Array(frame));
    offset += meta.frameBytes;
  }

  if (!appReady) {
    updateFrameLoading();
    if (hasFrame(0)) {
      drawFrame(0);
    }
    const buffered = bufferedInitialFrames();
    if (buffered < initialBufferFrames) {
      requestFrames(
        buffered,
        Math.min(initialChunkFrames, initialBufferFrames - buffered),
        "frames",
      );
    }
    return;
  }

  resumeBufferedPlayback();
  const target = frameForTime(playbackTime());
  if (seekTargetFrame !== null && hasFrame(seekTargetFrame)) {
    drawFrame(seekTargetFrame);
    seekTargetFrame = null;
  } else if (hasFrame(target) && (lastDrawn < 0 || visualPlaying)) {
    drawFrame(target);
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
  if (!meta || !appReady || playbackBuffering) return;
  const duration = effectiveDuration();
  if (duration <= 0) return;
  const targetTime = Math.max(0, Math.min(1, progress)) * duration;
  const targetFrame = frameForTime(targetTime);
  const shouldPlayAudio = visualPlaying || !audio.paused;

  if (frameTransport === "websocket") {
    connect();
  }
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
  if (frameTransport === "websocket") {
    requestFrames(targetFrame, 120, "frames", true);
  }
  if (hasFrame(targetFrame)) {
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

function packedBit(packed, bit) {
  return (packed[bit >> 3] & (1 << (7 - (bit & 7)))) !== 0;
}

function frameBackgroundIsBlack(packed, width, height) {
  let black = 0;
  let sampled = 0;

  for (let x = 0; x < width; x += 1) {
    if (packedBit(packed, x)) black += 1;
    if (height > 1 && packedBit(packed, (height - 1) * width + x)) black += 1;
    sampled += height > 1 ? 2 : 1;
  }
  for (let y = 1; y < height - 1; y += 1) {
    if (packedBit(packed, y * width)) black += 1;
    if (width > 1 && packedBit(packed, y * width + width - 1)) black += 1;
    sampled += width > 1 ? 2 : 1;
  }

  return black * 2 >= sampled;
}

function drawFrame(index) {
  const packed = getFrame(index);
  if (!packed || !meta || !sourceImage) return false;

  const pixels = sourceImage.data;
  const total = meta.sourceWidth * meta.sourceHeight;
  for (let bit = 0; bit < total; bit += 1) {
    const on = packedBit(packed, bit);
    const color = on ? 0 : 255;
    const p = bit * 4;
    pixels[p] = color;
    pixels[p + 1] = color;
    pixels[p + 2] = color;
    pixels[p + 3] = 255;
  }

  sourceCtx.putImageData(sourceImage, 0, 0);

  dotLayerCtx.clearRect(0, 0, dotLayerCanvas.width, dotLayerCanvas.height);
  dotLayerCtx.globalCompositeOperation = "source-over";
  dotLayerCtx.imageSmoothingEnabled = false;
  dotLayerCtx.drawImage(sourceCanvas, 0, 0, dotLayerCanvas.width, dotLayerCanvas.height);
  dotLayerCtx.globalCompositeOperation = "destination-in";
  dotLayerCtx.drawImage(dotMaskCanvas, 0, 0);
  dotLayerCtx.globalCompositeOperation = "source-over";

  ctx.fillStyle = frameBackgroundIsBlack(packed, meta.sourceWidth, meta.sourceHeight) ? "#000" : "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(dotLayerCanvas, 0, 0);
  lastDrawn = index;
  return true;
}

function finishPlayback() {
  const duration = effectiveDuration();
  const restartTime = duration > 0 ? Math.min(endedPauseTime, duration) : 0;
  visualPlaying = false;
  endedResting = true;
  visualOffset = restartTime;
  audio.pause();
  audio.currentTime = restartTime;
  hideSoundPrompt();

  seekTargetFrame = frameForTime(restartTime);
  if (frameTransport === "websocket") {
    requestFrames(seekTargetFrame, 120, "frames", true);
  }
  if (hasFrame(seekTargetFrame)) {
    drawFrame(seekTargetFrame);
    seekTargetFrame = null;
  }
}

function tick() {
  if (meta && appReady) {
    const current = playbackTime();
    if (visualPlaying && effectiveDuration() > 0 && current >= effectiveDuration()) {
      finishPlayback();
    }
    if (!audio.paused && effectiveDuration() > 0 && audio.currentTime >= effectiveDuration()) {
      finishPlayback();
    }
    const target = frameForTime(current);
    if (!hasFrame(target)) {
      if (frameTransport === "websocket") {
        requestFrames(target, 120);
      }
      showPlaybackBuffering(current);
    } else if (playbackBuffering) {
      resumeBufferedPlayback();
    } else if (target !== lastDrawn) {
      drawFrame(target);
      if (target === seekTargetFrame) {
        seekTargetFrame = null;
      }
    }
    if (frameTransport === "websocket" && target + 90 > requestedUntil) {
      requestFrames(requestedUntil, 120);
    }
  }
  requestAnimationFrame(tick);
}

async function togglePlayback() {
  if (!appReady || playbackBuffering) return;
  if (frameTransport === "websocket") {
    connect();
  }
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
  if (!appReady || playbackBuffering) return;
  if (frameTransport === "websocket") {
    connect();
  }
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
  if (audioWaitingTimer) {
    window.clearTimeout(audioWaitingTimer);
    audioWaitingTimer = 0;
  }
  if (playbackBuffering) return;
  visualPlaying = true;
  if (initialSoundCheckComplete) {
    hideSoundPrompt();
  }
});

audio.addEventListener("pause", () => {
  if (audio.currentTime > 0 && audio.currentTime < effectiveDuration()) {
    visualOffset = audio.currentTime;
  }
});

audio.addEventListener("ended", () => {
  finishPlayback();
});

audio.addEventListener("volumechange", hideSoundPromptIfAudible);

function checkAudioReady() {
  if (loadingState.audio || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
  if (!audioCanPlayAt) {
    audioCanPlayAt = performance.now();
  }
  if (
    bufferedAudioSeconds() >= startupAudioBufferSeconds
    || performance.now() - audioCanPlayAt >= maxAudioBufferWaitMs
  ) {
    if (audioReadyTimer) {
      window.clearTimeout(audioReadyTimer);
      audioReadyTimer = 0;
    }
    markLoadingReady("audio");
    return;
  }
  if (!audioReadyTimer) {
    audioReadyTimer = window.setTimeout(() => {
      audioReadyTimer = 0;
      checkAudioReady();
    }, 250);
  }
}

function handleAudioProgress() {
  checkAudioReady();
  if (playbackBuffering && bufferingReason === "audio") {
    resumeBufferedPlayback();
  }
}

audio.addEventListener("loadeddata", handleAudioProgress);
audio.addEventListener("canplay", handleAudioProgress);
audio.addEventListener("progress", handleAudioProgress);
audio.addEventListener("waiting", () => {
  if (!appReady || !visualPlaying || playbackBuffering || audioWaitingTimer) return;
  const stalledAt = audio.currentTime;
  audioWaitingTimer = window.setTimeout(() => {
    audioWaitingTimer = 0;
    if (
      appReady
      && visualPlaying
      && !playbackBuffering
      && !audio.paused
      && audio.currentTime - stalledAt < 0.05
      && bufferedAudioSeconds() < audioResumeBufferSeconds
      && audio.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA
    ) {
      showPlaybackBuffering(audio.currentTime, "audio");
    }
  }, 500);
});
audio.addEventListener("error", () => {
  if (!appReady) {
    showLoadingError("Audio could not be loaded.");
  }
});

loadingRetry.addEventListener("click", () => {
  window.location.reload();
});

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

window.addEventListener("resize", scheduleResize);
window.addEventListener("orientationchange", scheduleResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", scheduleResize);
  window.visualViewport.addEventListener("scroll", scheduleResize);
}

syncViewportSize(viewport());
renderLoadingProgress();
if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
  audioCanPlayAt = performance.now();
  checkAudioReady();
} else {
  audio.load();
}

loadMeta()
  .then(() => {
    requestAnimationFrame(tick);
    loadFrameStream().catch(useWebSocketFallback);
  })
  .catch((error) => {
    console.error(error);
    showLoadingError("Playback data could not be loaded.");
  });

buildDotTile();

window.badAppleSizing = { calculateCanvasSize, frameBackgroundIsBlack, stageViewport, viewport };
window.badApplePlaybackState = () => ({
  appReady,
  buffering: playbackBuffering,
  frameTransport,
  loadedFrames: loadedFrameCount + frames.size,
  streamComplete: frameStreamComplete,
  lastDrawn,
  visualPlaying,
  audioPaused: audio.paused,
  audioTime: audio.currentTime,
});
