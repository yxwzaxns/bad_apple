# Go 重写 Bad Apple 项目计划

## Summary

- 在仓库根目录创建 Go 项目，保留 `SMA_bad_apple-php_version/` 作为迁移参考，不修改旧 PHP 代码。
- 新版目标：用 Go 预处理图片为完整 01 帧数据，通过 WebSocket 传输动画数据，前端先读取客户端可视尺寸再计算动画尺寸，最终 `go build` 生成单一可执行文件。
- 不沿用旧版固定 `65ms/frame`。默认帧率由有效音频时长和图片帧数重新计算，保证最后一帧和有效声音结束时间对齐。

## Key Changes

- 项目结构：
  - `cmd/badapple/main.go`：入口，支持 `serve` 和 `extract`。
  - `src/extractor/`：图片读取、灰度阈值、帧率计算、二进制帧编码。
  - `src/server/`：HTTP 静态资源、音频资源、WebSocket `/ws`。
  - `assets/source/`：从旧项目复制 `images/` 和 `ba.mp3`。
  - `assets/generated/frames.badapple`：预处理输出。
  - `web/`：极简原生前端，隐藏可见播放控件。
  - `docs/GOAL_PLAN.md`：保存本计划，供后续 goal 执行。
- 帧提取：
  - 输入图片按数字后缀排序，期望连续；缺失、解码失败、尺寸不一致直接报错。
  - 保留源图完整逻辑分辨率；不把显示目标写死为 320x240。
  - 像素任一 RGB 通道 `>= 200` 记为 `0`，否则记为 `1`。
  - 输出文件头包含 magic、version、sourceWidth、sourceHeight、frameCount、durationMs、fps、frameBytes；帧数据按 bit-pack 存储。
- 帧率计算：
  - `extract` 默认读取 `ba.mp3` 有效时长，使用 `fps = frameCount / effectiveAudioDurationSeconds`。
  - `--fps` 仅作为显式覆盖参数；正常流程不传 `--fps`。
  - `--audio assets/source/ba.mp3` 为默认音频输入，用于计算 duration 和 fps。
  - 若无法解析 MP3 时长，`extract` 失败并提示用户安装或提供可解析音频，不回退到旧版 65ms。
  - 当前 MP3 容器时长约 `1144s`，但有效声音结束点约 `217s`；后段静音填充不参与 FPS 计算。
- 客户端尺寸适配：
  - 页面加载后读取 `window.innerWidth/innerHeight` 和 `devicePixelRatio`，计算可用画布尺寸。
  - 保持源图宽高比，选择能完整放入视口的最大动画区域。
  - Canvas CSS 尺寸按 CSS 像素，实际 backing store 乘以 DPR。
  - `resize` 和方向变化时重新计算画布尺寸，只改变渲染尺寸，不重新提取帧、不重启音频。
- 服务与接口：
  - `badapple extract --images assets/source/images --audio assets/source/ba.mp3 --out assets/generated/frames.badapple` 生成帧数据。
  - `badapple serve --addr :8080` 启动服务，使用 `embed` 打包前端、音频和帧数据到单一二进制。
  - `GET /` 返回前端，`GET /audio` 返回 MP3，`GET /meta` 返回帧元数据 JSON。
  - `GET /ws` 建立 WebSocket；服务端按客户端请求发送二进制帧块。
- WebSocket 协议：
  - 客户端发送 `{"type":"hello","viewport":{"w":..., "h":..., "dpr":...},"from":0,"chunk":120}`。
  - 服务端返回元数据 JSON：`sourceWidth/sourceHeight/frameCount/durationMs/fps/frameBytes`。
  - 帧块用二进制消息返回：小端 `uint32 startFrame + uint16 frameCount + packedFrameBytes...`。
- 同步策略：
  - 页面打开后动画自动播放。
  - 浏览器阻止有声 autoplay 时，动画使用视觉时钟静音推进；用户按 `Space` 或 `Enter` 后音频对齐当前动画进度播放或暂停。
  - 音频播放中使用 `audio.currentTime` 计算目标帧；无音频播放时使用视觉时钟计算目标帧。
  - WebSocket 负责供应帧数据，动画推进不依赖 `setInterval`。
  - 若目标帧未到，保留上一帧并请求缺失区间；恢复后跳到音频对应帧，避免累计漂移。
  - 结束条件以有效时长为准，并显示最后一帧。
  - Canvas 使用平滑缩放降低黑白边缘锯齿。

## Public Interfaces

- CLI:
  - `badapple extract --images <dir> --audio <mp3> --out <file> [--fps <float>] [--threshold 200]`
  - `badapple serve [--addr :8080]`
- HTTP:
  - `/` 前端页面。
  - `/audio` 内嵌 MP3。
  - `/meta` 返回 `{sourceWidth,sourceHeight,frames,durationMs,fps,frameBytes}`。
  - `/ws` WebSocket 帧数据通道。
- Build commands:
  - `go test ./...`
  - `go run ./cmd/badapple extract --images assets/source/images --audio assets/source/ba.mp3 --out assets/generated/frames.badapple`
  - `go run ./cmd/badapple serve --addr :8080`
  - `go build -o badapple ./cmd/badapple`

## Test Plan

- 单元测试：
  - 验证阈值规则、bit-pack 编码和解码一致。
  - 验证图片文件按数字后缀排序，缺帧和尺寸不一致会失败。
  - 验证 metadata 中源图尺寸来自图片本身，而不是固定常量。
  - 验证 `fps = frameCount / effectiveAudioDurationSeconds`，且不会回退到旧版 65ms。
  - 验证前端尺寸计算函数在桌面、移动、超宽、竖屏视口下保持宽高比并完整放入视口。
- 集成测试：
  - 对 fixture 跑 `extract`，确认输出 metadata 包含正确 duration/fps。
  - WebSocket 请求返回正确起始帧、帧数和字节长度。
- 手动验收：
  - 浏览器打开页面后动画区域根据当前窗口自动适配。
  - 打开页面后动画自动播放。
  - 按 `Space` 或 `Enter` 可以播放或暂停，音频从当前动画进度对齐。
  - 播放时动画最后一帧与有效声音结束对齐。
  - 调整浏览器大小或旋转屏幕时画面重新铺排，音频不中断且帧同步不漂移。
  - 最终二进制在没有 PHP、Apache、外部静态文件的情况下可播放。

## Assumptions

- 图片源分辨率由输入文件决定；当前旧素材实际为 320x240，但实现不得把这个值写死为显示尺寸。
- 客户端尺寸只影响 Canvas 渲染尺寸，不改变服务器发送的原始 01 帧数据。
- 前端使用 Canvas 绘制，不使用大量 DOM 字符串更新。
- 默认帧率必须由有效音频时长和帧数量计算；旧版 65ms 只作为历史背景，不进入新版默认逻辑。
- 浏览器可能禁止无交互有声自动播放；实现保证动画自动播放，并在用户按键后对齐启动声音。
