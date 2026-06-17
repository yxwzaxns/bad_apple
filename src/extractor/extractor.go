package extractor

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	Magic   = "BADAPPLE"
	Version = uint16(1)
)

type Config struct {
	ImagesDir   string
	AudioPath   string
	OutputPath  string
	Threshold   int
	OverrideFPS float64
}

type Metadata struct {
	SourceWidth  uint32
	SourceHeight uint32
	FrameCount   uint32
	DurationMS   uint32
	FPS          float64
	FrameBytes   uint32
}

type imageFrame struct {
	index int
	path  string
}

var frameNamePattern = regexp.MustCompile(`_(\d+)\.jpe?g$`)

func Extract(cfg Config) error {
	if cfg.ImagesDir == "" {
		return errors.New("--images is required")
	}
	if cfg.AudioPath == "" && cfg.OverrideFPS <= 0 {
		return errors.New("--audio is required unless --fps is provided")
	}
	if cfg.OutputPath == "" {
		return errors.New("--out is required")
	}
	if cfg.Threshold < 0 || cfg.Threshold > 255 {
		return fmt.Errorf("--threshold must be in [0,255], got %d", cfg.Threshold)
	}

	frames, err := listFrames(cfg.ImagesDir)
	if err != nil {
		return err
	}
	if len(frames) == 0 {
		return fmt.Errorf("no jpg frames found in %s", cfg.ImagesDir)
	}

	duration, err := audioDuration(cfg.AudioPath)
	if cfg.OverrideFPS > 0 {
		err = nil
		duration = timeFromFPS(len(frames), cfg.OverrideFPS)
	}
	if err != nil {
		return fmt.Errorf("calculate audio duration: %w", err)
	}
	if duration <= 0 {
		return errors.New("audio duration must be positive")
	}

	first, err := decodeJPEG(frames[0].path)
	if err != nil {
		return err
	}
	bounds := first.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	frameBytes := (width*height + 7) / 8
	if width <= 0 || height <= 0 {
		return fmt.Errorf("invalid first frame size %dx%d", width, height)
	}

	out, err := os.Create(cfg.OutputPath)
	if err != nil {
		return fmt.Errorf("create output: %w", err)
	}
	defer out.Close()

	writer := bufio.NewWriter(out)
	meta := Metadata{
		SourceWidth:  uint32(width),
		SourceHeight: uint32(height),
		FrameCount:   uint32(len(frames)),
		DurationMS:   uint32(math.Round(duration * 1000)),
		FPS:          float64(len(frames)) / duration,
		FrameBytes:   uint32(frameBytes),
	}
	if err := WriteHeader(writer, meta); err != nil {
		return err
	}

	buf := make([]byte, frameBytes)
	for i, frame := range frames {
		img := first
		if i > 0 {
			img, err = decodeJPEG(frame.path)
			if err != nil {
				return err
			}
		}
		if got := img.Bounds(); got.Dx() != width || got.Dy() != height {
			return fmt.Errorf("frame %d size mismatch: got %dx%d, want %dx%d", frame.index, got.Dx(), got.Dy(), width, height)
		}
		EncodeFrame(img, cfg.Threshold, buf)
		if _, err := writer.Write(buf); err != nil {
			return fmt.Errorf("write frame %d: %w", frame.index, err)
		}
	}

	if err := writer.Flush(); err != nil {
		return fmt.Errorf("flush output: %w", err)
	}

	fmt.Printf("wrote %s: %d frames, %dx%d, %.6f fps, %d ms\n", cfg.OutputPath, meta.FrameCount, meta.SourceWidth, meta.SourceHeight, meta.FPS, meta.DurationMS)
	return nil
}

func WriteHeader(w io.Writer, meta Metadata) error {
	if _, err := w.Write([]byte(Magic)); err != nil {
		return err
	}
	fields := []any{
		Version,
		meta.SourceWidth,
		meta.SourceHeight,
		meta.FrameCount,
		meta.DurationMS,
		meta.FPS,
		meta.FrameBytes,
	}
	for _, field := range fields {
		if err := binary.Write(w, binary.LittleEndian, field); err != nil {
			return err
		}
	}
	return nil
}

func ReadHeader(r io.Reader) (Metadata, error) {
	var magic [8]byte
	if _, err := io.ReadFull(r, magic[:]); err != nil {
		return Metadata{}, err
	}
	if string(magic[:]) != Magic {
		return Metadata{}, fmt.Errorf("invalid magic %q", string(magic[:]))
	}

	var version uint16
	if err := binary.Read(r, binary.LittleEndian, &version); err != nil {
		return Metadata{}, err
	}
	if version != Version {
		return Metadata{}, fmt.Errorf("unsupported version %d", version)
	}

	var meta Metadata
	fields := []any{
		&meta.SourceWidth,
		&meta.SourceHeight,
		&meta.FrameCount,
		&meta.DurationMS,
		&meta.FPS,
		&meta.FrameBytes,
	}
	for _, field := range fields {
		if err := binary.Read(r, binary.LittleEndian, field); err != nil {
			return Metadata{}, err
		}
	}
	return meta, nil
}

func EncodeFrame(img image.Image, threshold int, dst []byte) {
	for i := range dst {
		dst[i] = 0
	}
	bounds := img.Bounds()
	bit := 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r, g, b, _ := img.At(x, y).RGBA()
			black := int(r>>8) < threshold && int(g>>8) < threshold && int(b>>8) < threshold
			if black {
				dst[bit/8] |= 1 << uint(7-bit%8)
			}
			bit++
		}
	}
}

func listFrames(dir string) ([]imageFrame, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read images dir: %w", err)
	}
	var frames []imageFrame
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := frameNamePattern.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		index, err := strconv.Atoi(match[1])
		if err != nil {
			return nil, fmt.Errorf("parse frame number %q: %w", entry.Name(), err)
		}
		frames = append(frames, imageFrame{index: index, path: filepath.Join(dir, entry.Name())})
	}
	sort.Slice(frames, func(i, j int) bool {
		return frames[i].index < frames[j].index
	})
	for i, frame := range frames {
		if frame.index != i {
			return nil, fmt.Errorf("missing frame %d before %s", i, filepath.Base(frame.path))
		}
	}
	return frames, nil
}

func decodeJPEG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()
	img, err := jpeg.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return img, nil
}

func audioDuration(path string) (float64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("read audio: %w", err)
	}
	return MP3Duration(data)
}

func timeFromFPS(frameCount int, fps float64) float64 {
	return float64(frameCount) / fps
}

func MP3Duration(data []byte) (float64, error) {
	effectiveDuration := taggedEffectiveDuration(data)
	if len(data) < 4 {
		return 0, errors.New("mp3 too small")
	}
	offset := 0
	if bytes.HasPrefix(data, []byte("ID3")) {
		if len(data) < 10 {
			return 0, errors.New("truncated id3 header")
		}
		size := int(data[6]&0x7f)<<21 | int(data[7]&0x7f)<<14 | int(data[8]&0x7f)<<7 | int(data[9]&0x7f)
		offset = 10 + size
	}

	var duration float64
	frames := 0
	for offset+4 <= len(data) {
		if data[offset] != 0xff || data[offset+1]&0xe0 != 0xe0 {
			offset++
			continue
		}
		header := binary.BigEndian.Uint32(data[offset : offset+4])
		info, ok := parseMP3Header(header)
		if !ok {
			offset++
			continue
		}
		if offset+info.frameSize > len(data) {
			break
		}
		duration += float64(info.samples) / float64(info.sampleRate)
		frames++
		offset += info.frameSize
	}
	if frames == 0 {
		return 0, errors.New("no mp3 audio frames found")
	}
	if effectiveDuration > 0 && effectiveDuration < duration*0.9 {
		return effectiveDuration, nil
	}
	return duration, nil
}

func taggedEffectiveDuration(data []byte) float64 {
	text := string(data)
	const key = "lastkeyframetimestamp"
	index := strings.Index(text, key)
	if index < 0 {
		return 0
	}
	start := index + len(key)
	for start < len(text) && (text[start] < '0' || text[start] > '9') && text[start] != '.' {
		start++
	}
	end := start
	for end < len(text) && ((text[end] >= '0' && text[end] <= '9') || text[end] == '.') {
		end++
	}
	if end == start {
		return 0
	}
	value, err := strconv.ParseFloat(text[start:end], 64)
	if err != nil || value <= 0 {
		return 0
	}
	return value
}

type mp3FrameInfo struct {
	frameSize  int
	samples    int
	sampleRate int
}

func parseMP3Header(h uint32) (mp3FrameInfo, bool) {
	versionID := (h >> 19) & 0x3
	layerID := (h >> 17) & 0x3
	bitrateID := (h >> 12) & 0xf
	sampleRateID := (h >> 10) & 0x3
	padding := int((h >> 9) & 0x1)
	if versionID == 1 || layerID == 0 || bitrateID == 0 || bitrateID == 15 || sampleRateID == 3 {
		return mp3FrameInfo{}, false
	}

	version := 1
	if versionID == 3 {
		version = 1
	} else if versionID == 2 {
		version = 2
	} else {
		version = 25
	}
	layer := 4 - int(layerID)
	bitrate := bitrateKbps(version, layer, int(bitrateID))
	sampleRate := sampleRateHz(version, int(sampleRateID))
	if bitrate == 0 || sampleRate == 0 {
		return mp3FrameInfo{}, false
	}

	samples := 1152
	if layer == 1 {
		samples = 384
	} else if layer == 3 && version != 1 {
		samples = 576
	}

	frameSize := 0
	if layer == 1 {
		frameSize = ((12 * bitrate * 1000 / sampleRate) + padding) * 4
	} else if layer == 3 && version != 1 {
		frameSize = 72*bitrate*1000/sampleRate + padding
	} else {
		frameSize = 144*bitrate*1000/sampleRate + padding
	}
	if frameSize <= 4 {
		return mp3FrameInfo{}, false
	}
	return mp3FrameInfo{frameSize: frameSize, samples: samples, sampleRate: sampleRate}, true
}

func bitrateKbps(version int, layer int, id int) int {
	mpeg1 := map[int][]int{
		1: {0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448},
		2: {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384},
		3: {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320},
	}
	mpeg2 := map[int][]int{
		1: {0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256},
		2: {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},
		3: {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},
	}
	if version == 1 {
		return mpeg1[layer][id]
	}
	return mpeg2[layer][id]
}

func sampleRateHz(version int, id int) int {
	base := []int{44100, 48000, 32000}
	rate := base[id]
	if version == 2 {
		return rate / 2
	}
	if version == 25 {
		return rate / 4
	}
	return rate
}
