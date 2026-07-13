package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"

	"badapple/src/extractor"
)

const (
	frameChunkHeaderBytes = 6
	defaultChunkSize      = 120
	maxChunkSize          = 600
)

type FrameStore struct {
	meta    extractor.Metadata
	data    []byte
	version string
}

type MetaResponse struct {
	SourceWidth   uint32  `json:"sourceWidth"`
	SourceHeight  uint32  `json:"sourceHeight"`
	Frames        uint32  `json:"frames"`
	DurationMS    uint32  `json:"durationMs"`
	FPS           float64 `json:"fps"`
	FrameBytes    uint32  `json:"frameBytes"`
	FramesVersion string  `json:"framesVersion"`
}

func NewFrameStore(raw []byte) (*FrameStore, error) {
	reader := bytes.NewReader(raw)
	meta, err := extractor.ReadHeader(reader)
	if err != nil {
		return nil, fmt.Errorf("read frame header: %w", err)
	}
	if meta.FrameCount == 0 || meta.FrameBytes == 0 {
		return nil, fmt.Errorf("invalid frame metadata: frames=%d frameBytes=%d", meta.FrameCount, meta.FrameBytes)
	}

	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, fmt.Errorf("read frame payload: %w", err)
	}
	want := int64(meta.FrameCount) * int64(meta.FrameBytes)
	if int64(len(data)) != want {
		return nil, fmt.Errorf("invalid frame payload length: got %d, want %d", len(data), want)
	}
	sum := sha256.Sum256(data)
	return &FrameStore{
		meta:    meta,
		data:    data,
		version: hex.EncodeToString(sum[:]),
	}, nil
}

func (s *FrameStore) Meta() MetaResponse {
	return MetaResponse{
		SourceWidth:   s.meta.SourceWidth,
		SourceHeight:  s.meta.SourceHeight,
		Frames:        s.meta.FrameCount,
		DurationMS:    s.meta.DurationMS,
		FPS:           s.meta.FPS,
		FrameBytes:    s.meta.FrameBytes,
		FramesVersion: s.version,
	}
}

func (s *FrameStore) Chunk(from uint32, count uint16) ([]byte, error) {
	if from >= s.meta.FrameCount {
		return nil, fmt.Errorf("from frame %d outside frame count %d", from, s.meta.FrameCount)
	}
	if count == 0 {
		count = defaultChunkSize
	}
	if count > maxChunkSize {
		count = maxChunkSize
	}

	remaining := s.meta.FrameCount - from
	if uint32(count) > remaining {
		count = uint16(remaining)
	}

	frameBytes := int(s.meta.FrameBytes)
	start := int(from) * frameBytes
	end := start + int(count)*frameBytes
	out := make([]byte, frameChunkHeaderBytes+end-start)
	binary.LittleEndian.PutUint32(out[0:4], from)
	binary.LittleEndian.PutUint16(out[4:6], count)
	copy(out[frameChunkHeaderBytes:], s.data[start:end])
	return out, nil
}
