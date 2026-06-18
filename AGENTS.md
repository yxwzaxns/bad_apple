# Repository Guidelines

## Project

Go rewrite of the Bad Apple PHP demo. The app preprocesses JPEG frames into binary `0/1` data, embeds assets into one Go executable, serves a Canvas frontend, and streams frames over WebSocket.

## Structure

- `cmd/badapple/`: CLI entrypoint for `extract` and `serve`.
- `src/extractor/`: image/audio preprocessing and frame file format.
- `src/server/`: HTTP, metadata, and WebSocket frame streaming.
- `web/`: embedded frontend.
- `assets/source/`: source MP3 and frame images.
- `assets/generated/`: generated `frames.badapple`.
- `SMA_bad_apple-php_version/`: ignored legacy reference, do not edit.

## Commands

```sh
go test ./...
go run ./cmd/badapple extract --images assets/source/images --audio assets/source/ba.mp3 --out assets/generated/frames.badapple
go build -o badapple ./cmd/badapple
./badapple serve --addr :8081
```

## Rules

- Use global `go`; do not create project-local Go cache directories.
- Rebuild after changing `web/`, `assets/source/ba.mp3`, or `assets/generated/frames.badapple` because they are embedded.
- Keep the old PHP folder ignored and unchanged.
- Keep visible frontend controls minimal; playback is keyboard-driven with `Space`/`Enter`.
- Run `go test ./...` before committing code changes.
