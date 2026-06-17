package extractor

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
)

func TestEncodeFrameThresholdAndBitPacking(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 8, 1))
	pixels := []color.RGBA{
		{0, 0, 0, 255},
		{199, 199, 199, 255},
		{200, 0, 0, 255},
		{0, 200, 0, 255},
		{0, 0, 200, 255},
		{255, 255, 255, 255},
		{10, 20, 30, 255},
		{201, 201, 201, 255},
	}
	for x, pixel := range pixels {
		img.SetRGBA(x, 0, pixel)
	}

	dst := []byte{0}
	EncodeFrame(img, 200, dst)
	want := byte(0b11000010)
	if dst[0] != want {
		t.Fatalf("encoded byte = %08b, want %08b", dst[0], want)
	}
}

func TestHeaderRoundTrip(t *testing.T) {
	want := Metadata{
		SourceWidth:  320,
		SourceHeight: 240,
		FrameCount:   3300,
		DurationMS:   218000,
		FPS:          15.1376,
		FrameBytes:   9600,
	}
	var buf bytes.Buffer
	if err := WriteHeader(&buf, want); err != nil {
		t.Fatal(err)
	}
	got, err := ReadHeader(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("metadata = %+v, want %+v", got, want)
	}
}

func TestListFramesRequiresContinuousNumbers(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"38030302_baofeng_0.jpg", "38030302_baofeng_2.jpg"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := listFrames(dir); err == nil {
		t.Fatal("expected missing frame error")
	}
}

func TestExtractCalculatesFPSFromAudioDuration(t *testing.T) {
	dir := t.TempDir()
	images := filepath.Join(dir, "images")
	if err := os.Mkdir(images, 0755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		writeJPEG(t, filepath.Join(images, "38030302_baofeng_"+string(rune('0'+i))+".jpg"))
	}

	audio := filepath.Join(dir, "one-second.mp3")
	if err := os.WriteFile(audio, silentMP3Frames(44100, 128, 39), 0644); err != nil {
		t.Fatal(err)
	}

	out := filepath.Join(dir, "frames.badapple")
	if err := Extract(Config{ImagesDir: images, AudioPath: audio, OutputPath: out, Threshold: 200}); err != nil {
		t.Fatal(err)
	}

	f, err := os.Open(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	meta, err := ReadHeader(f)
	if err != nil {
		t.Fatal(err)
	}
	if meta.SourceWidth != 2 || meta.SourceHeight != 2 || meta.FrameCount != 2 {
		t.Fatalf("unexpected metadata: %+v", meta)
	}
	if meta.DurationMS < 1010 || meta.DurationMS > 1025 {
		t.Fatalf("duration = %d ms, want about 1019 ms", meta.DurationMS)
	}
	if meta.FPS < 1.9 || meta.FPS > 2.0 {
		t.Fatalf("fps = %.6f, want about 1.96", meta.FPS)
	}
}

func TestMP3DurationUsesTaggedEffectiveDurationForLongSilentTail(t *testing.T) {
	data := append([]byte("TXXX\x00lastkeyframetimestamp\x00217\x00"), silentMP3Frames(44100, 128, 10000)...)
	duration, err := MP3Duration(data)
	if err != nil {
		t.Fatal(err)
	}
	if duration != 217 {
		t.Fatalf("duration = %.3f, want tagged effective duration 217", duration)
	}
}

func TestMP3DurationKeepsFullDurationWithoutLongTailTag(t *testing.T) {
	data := silentMP3Frames(44100, 128, 39)
	duration, err := MP3Duration(data)
	if err != nil {
		t.Fatal(err)
	}
	if duration < 1.0 || duration > 1.1 {
		t.Fatalf("duration = %.3f, want full mp3 duration around 1.02", duration)
	}
}

func writeJPEG(t *testing.T, path string) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.SetRGBA(0, 0, color.RGBA{0, 0, 0, 255})
	img.SetRGBA(1, 0, color.RGBA{255, 255, 255, 255})
	img.SetRGBA(0, 1, color.RGBA{0, 0, 0, 255})
	img.SetRGBA(1, 1, color.RGBA{255, 255, 255, 255})
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := jpeg.Encode(f, img, nil); err != nil {
		t.Fatal(err)
	}
}

func silentMP3Frames(sampleRate int, bitrateKbps int, count int) []byte {
	frameSize := 144 * bitrateKbps * 1000 / sampleRate
	frame := make([]byte, frameSize)
	frame[0] = 0xff
	frame[1] = 0xfb
	frame[2] = 0x90
	frame[3] = 0x64
	var out []byte
	for i := 0; i < count; i++ {
		out = append(out, frame...)
	}
	return out
}
