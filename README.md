---
title: Bad Apple
emoji: 🍎
colorFrom: gray
colorTo: gray
sdk: docker
pinned: false
---

# Bad Apple

![Code by AI](https://img.shields.io/badge/Code%20by-AI-8A2BE2?style=for-the-badge)
[![Live Demo](https://img.shields.io/badge/Live-Demo-2ea44f?style=for-the-badge)](https://yxwzaxns-badapple.hf.space/)

A Go rewrite of the Bad Apple PHP demo. It converts JPEG frames into compact binary data, embeds the animation, audio, and web frontend into a single executable, and streams frames to the browser over WebSocket.

## Quick Start

Requires Go.

```sh
go build -o badapple ./cmd/badapple
./badapple serve --addr :8081
```

Open <http://127.0.0.1:8081> in a browser.

## Controls

- Playback starts automatically when frames are ready.
- Press `Space` or `Enter` to play or pause.
- If the browser blocks audio autoplay, press either key to enable sound.

## Development

Run tests:

```sh
go test ./...
```

Regenerate frame data:

```sh
go run ./cmd/badapple extract \
  --images assets/source/images \
  --audio assets/source/ba.mp3 \
  --out assets/generated/frames.badapple
```

Build a smaller release executable:

```sh
go build -trimpath -ldflags="-s -w" -o badapple ./cmd/badapple
```

The frontend, audio, and generated frame data are embedded. Rebuild after changing files in `web/`, `assets/source/ba.mp3`, or `assets/generated/frames.badapple`.

## Project Structure

```text
cmd/badapple/       CLI entrypoint
src/extractor/      Image and audio preprocessing
src/server/         HTTP and WebSocket server
web/                Browser frontend
assets/source/      Source images and audio
assets/generated/   Generated frame data
```
