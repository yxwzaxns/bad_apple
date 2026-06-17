# Bad Apple Go Rewrite

This project is a Go rewrite of the PHP Bad Apple demo in `SMA_bad_apple-php_version/`.

The Go version preprocesses numbered JPEG frames into compact binary `0/1` frame data, embeds the generated data and MP3 into one executable, serves a small browser UI, and streams animation frames over WebSocket.

## Prerequisites

- Go installed locally.
- In this environment Go is available globally as `go`.

## Run Locally

Build the single executable:

```sh
go build -o badapple ./cmd/badapple
```

Start the server:

```sh
./badapple serve --addr :8081
```

Open:

```text
http://127.0.0.1:8081
```

Runtime endpoints:

- `/` serves the embedded frontend.
- `/audio` serves the embedded MP3.
- `/meta` returns frame metadata.
- `/ws` streams frame chunks over WebSocket.

## Development

Run tests:

```sh
go test ./...
```

Regenerate preprocessed frame data after changing extractor logic or source assets:

```sh
go run ./cmd/badapple extract \
  --images assets/source/images \
  --audio assets/source/ba.mp3 \
  --out assets/generated/frames.badapple
```

Preview during development:

```sh
go build -o badapple ./cmd/badapple
./badapple serve --addr :8081
```

Then open:

```text
http://127.0.0.1:8081
```

Package a single executable:

```sh
go build -trimpath -ldflags="-s -w" -o badapple ./cmd/badapple
```

The built executable embeds:

- `web/`
- `assets/source/ba.mp3`
- `assets/generated/frames.badapple`

After changing any embedded frontend or asset file, rebuild the executable before previewing the change.

## Playback Behavior

- The page contains only the animation canvas; visible audio controls, buttons, seek bars, and timers are intentionally removed.
- Animation starts automatically after the first frame chunk is available.
- The browser may block unmuted audio autoplay. The frontend still attempts autoplay, but if the browser blocks it, the animation continues silently.
- Press `Space` or `Enter` to play or pause. When audio starts after a key press, it seeks to the current animation position before playing.
- Playback uses the effective media duration from metadata, not the MP3 container duration. When the effective duration is reached, the animation stops on the last frame.
- Canvas scaling uses high-quality smoothing instead of pixelated nearest-neighbor rendering, reducing jagged black/white edges.

## Source Data

The existing PHP project contains the source assets:

- Images: `SMA_bad_apple-php_version/src/images/`
- Audio: `SMA_bad_apple-php_version/src/ba.mp3`

The image sequence is expected to use continuous numeric suffixes:

```text
38030302_baofeng_0.jpg
38030302_baofeng_1.jpg
...
38030302_baofeng_3299.jpg
```

## Preprocess Frame Data

Run the extractor:

```sh
go run ./cmd/badapple extract \
  --images SMA_bad_apple-php_version/src/images \
  --audio SMA_bad_apple-php_version/src/ba.mp3 \
  --out assets/generated/frames.badapple
```

Generated output:

```text
assets/generated/frames.badapple
```

Current generated data:

- Frames: `3300`
- Source size: `320x240`
- Bytes per frame: `9600`
- File size: `31,680,038` bytes
- Effective audio duration: about `217s`
- Calculated FPS: about `15.207373`

The FPS is calculated from effective audio duration and frame count:

```text
fps = frameCount / effectiveAudioDurationSeconds
```

The extractor does not use the old PHP interval of `65ms/frame`.
For this source MP3, the container duration is about `1144s`, but its metadata marks the last effective content timestamp at about `217s`; the remaining tail is silent padding and is not used for animation timing.

## Pixel Conversion Rule

Each decoded JPEG pixel is converted to one binary bit:

- `0` if any RGB channel is greater than or equal to the threshold.
- `1` if all RGB channels are below the threshold.

Default threshold:

```text
200
```

Equivalent logic:

```text
if r >= 200 || g >= 200 || b >= 200:
  bit = 0
else:
  bit = 1
```

## Binary File Format

`frames.badapple` starts with a fixed-size header, followed by packed frame data.

Header fields:

```text
magic        8 bytes   "BADAPPLE"
version      uint16    little-endian
sourceWidth  uint32    little-endian
sourceHeight uint32    little-endian
frameCount   uint32    little-endian
durationMs   uint32    little-endian
fps          float64   little-endian
frameBytes   uint32    little-endian
```

Frame payload:

```text
frameCount * frameBytes bytes
```

Bits are packed most-significant-bit first within each byte. For a `320x240` source frame:

```text
320 * 240 = 76800 bits
76800 / 8 = 9600 bytes
```

## Validation

Run tests:

```sh
go test ./...
```

The tests cover:

- Pixel threshold conversion.
- Bit packing.
- Header read/write round trip.
- Continuous frame numbering.
- FPS calculation from audio duration.
- Frame file payload validation.
- `/meta` response formatting.
- WebSocket binary frame chunk response.

You can also verify the generated file size:

```sh
wc -c assets/generated/frames.badapple
```

Expected current size:

```text
31680038 assets/generated/frames.badapple
```

This equals:

```text
38 byte header + 3300 frames * 9600 bytes
```

## WebSocket Frame Protocol

Client request:

```json
{"type":"hello","viewport":{"w":1280,"h":720,"dpr":2},"from":0,"chunk":120}
```

The server first sends metadata as JSON, then frame chunks as binary messages.

Binary frame chunk layout:

```text
startFrame uint32 little-endian
frameCount uint16 little-endian
payload    frameCount * frameBytes
```

The frontend maps playback time to a frame with:

```text
targetFrame = floor(audio.currentTime * fps)
```

When audio is active, playback time comes from `audio.currentTime`. If the browser blocks audio autoplay, playback time comes from a visual animation clock until the user presses `Space` or `Enter`.

Canvas size is calculated from the client viewport while preserving the source frame aspect ratio. The canvas is scaled with smoothing enabled to soften binary-frame edges.
