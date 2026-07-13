const canvas = document.getElementById("screen");
const ctx = canvas.getContext("2d", { alpha: false });
const audio = document.getElementById("audio");
const stage = document.querySelector(".stage");
const screenWrap = document.getElementById("screenWrap");
const soundPrompt = document.getElementById("soundPrompt");

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
let sourceImage = null;
let resizeFrame = 0;
const activePlaybackKeys = new Set();
const endedPauseTime = 8;
const soundPromptDelayMs = 1000;
const dotTileSize = 32;
const dotDiameterRatio = 0.74;
const maxRenderDpr = 2;
const maxRenderPixels = 8_000_000;

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
  if (lastDrawn >= 0 && frames.has(lastDrawn)) {
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
  if (!autoplayStarted && frames.size > 0) {
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
  const packed = frames.get(index);
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

window.addEventListener("resize", scheduleResize);
window.addEventListener("orientationchange", scheduleResize);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", scheduleResize);
  window.visualViewport.addEventListener("scroll", scheduleResize);
}

syncViewportSize(viewport());

loadMeta()
  .then(() => {
    visualStartedAt = performance.now();
    requestAnimationFrame(tick);
    connect();
  })
  .catch((error) => {
    console.error(error);
  });

buildDotTile();

window.badAppleSizing = { calculateCanvasSize, frameBackgroundIsBlack, stageViewport, viewport };
