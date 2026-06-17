package server

import (
	"bytes"
	"encoding/binary"
	"testing"

	"badapple/src/extractor"
)

func TestFrameStoreChunk(t *testing.T) {
	raw := testFrameFile(t, extractor.Metadata{
		SourceWidth:  2,
		SourceHeight: 2,
		FrameCount:   3,
		DurationMS:   3000,
		FPS:          1,
		FrameBytes:   1,
	}, []byte{0x80, 0x40, 0x20})

	store, err := NewFrameStore(raw)
	if err != nil {
		t.Fatal(err)
	}
	chunk, err := store.Chunk(1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if got := binary.LittleEndian.Uint32(chunk[0:4]); got != 1 {
		t.Fatalf("start frame = %d, want 1", got)
	}
	if got := binary.LittleEndian.Uint16(chunk[4:6]); got != 2 {
		t.Fatalf("frame count = %d, want 2", got)
	}
	if got, want := chunk[6:], []byte{0x40, 0x20}; !bytes.Equal(got, want) {
		t.Fatalf("payload = %v, want %v", got, want)
	}
}

func TestNewFrameStoreRejectsInvalidPayloadLength(t *testing.T) {
	raw := testFrameFile(t, extractor.Metadata{
		SourceWidth:  2,
		SourceHeight: 2,
		FrameCount:   2,
		DurationMS:   2000,
		FPS:          1,
		FrameBytes:   1,
	}, []byte{0x80})

	if _, err := NewFrameStore(raw); err == nil {
		t.Fatal("expected invalid payload length error")
	}
}

func testFrameFile(t *testing.T, meta extractor.Metadata, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := extractor.WriteHeader(&buf, meta); err != nil {
		t.Fatal(err)
	}
	buf.Write(payload)
	return buf.Bytes()
}
