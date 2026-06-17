# Go 重写 Bad Apple 项目计划

## Summary

- 在仓库根目录创建 Go 项目，保留 `SMA_bad_apple-php_version/` 作为迁移参考，不修改旧 PHP 代码。
- 新版目标：用 Go 预处理图片为完整 01 帧数据，通过 WebSocket 传输动画数据，前端先读取客户端可视尺寸再计算动画尺寸，最终 `go build` 生成单一可执行文件。
- 不沿用旧版固定 `65ms/frame`。默认帧率由有效音频时长和图片帧数重新计算，保证最后一帧和有效声音结束时间对齐。

## Key Changes

- `cmd/badapple/main.go` 提供 `extract` 和 `serve` 子命令。
- `src/extractor/` 负责 JPEG 读取、阈值转换、MP3 时长解析、FPS 计算和二进制帧数据写入。
- `src/server/` 负责读取二进制帧数据、HTTP 资源服务、`/meta` 和 `/ws`。
- `web/` 提供极简 Canvas 前端，按客户端视口计算动画尺寸，隐藏可见播放控件。
- `assets/source/ba.mp3` 和 `assets/generated/frames.badapple` 与 `web/` 一起被 `embed` 打包进单一 Go 可执行文件。
- 对当前 MP3，容器时长约 `1144s`，但有效声音结束点约 `217s`；提取器使用有效时长计算 FPS。
- 前端打开页面后自动播放动画；浏览器阻止有声 autoplay 时，动画静音推进，按 `Space` 或 `Enter` 后音频对齐当前动画进度播放或暂停。
- Canvas 使用平滑缩放降低二值帧放大后的黑白边缘锯齿。

## Public Interfaces

- `badapple extract --images <dir> --audio <mp3> --out <file> [--fps <float>] [--threshold 200]`
- `badapple serve [--addr :8080]`
- `GET /`
- `GET /audio`
- `GET /meta`
- `GET /ws`

## Test Plan

- `go test ./...`
- `go build -o badapple ./cmd/badapple`
- `badapple extract --images assets/source/images --audio assets/source/ba.mp3 --out assets/generated/frames.badapple`
- `badapple serve --addr :8081`
- Browser verification: page loads, Canvas adapts to viewport, WebSocket frames draw, animation starts automatically, `Space`/`Enter` toggles audio-aligned playback.

## Assumptions

- 当前旧素材实际为 `320x240`，但显示尺寸不得写死为该值。
- 客户端尺寸只影响 Canvas 渲染尺寸，不改变服务器发送的原始 01 帧数据。
- 默认帧率必须由有效音频时长和帧数量计算；旧版 `65ms/frame` 只作为历史背景。
- 浏览器可能禁止无交互有声自动播放；实现层面只能保证动画自动播放，并在用户按键后对齐启动声音。
