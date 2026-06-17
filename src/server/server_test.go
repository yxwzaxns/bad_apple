package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"badapple/src/extractor"
	"github.com/coder/websocket"
)

func TestMetaHandler(t *testing.T) {
	store, err := NewFrameStore(testFrameFile(t, extractor.Metadata{
		SourceWidth:  2,
		SourceHeight: 2,
		FrameCount:   1,
		DurationMS:   1000,
		FPS:          1,
		FrameBytes:   1,
	}, []byte{0x80}))
	if err != nil {
		t.Fatal(err)
	}

	handler := New(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}, []byte("audio"), store).Handler()

	req := httptest.NewRequest(http.MethodGet, "/meta", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var got MetaResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.SourceWidth != 2 || got.SourceHeight != 2 || got.Frames != 1 || got.FrameBytes != 1 {
		t.Fatalf("metadata = %+v", got)
	}
}

func TestWebSocketFrameRequest(t *testing.T) {
	store, err := NewFrameStore(testFrameFile(t, extractor.Metadata{
		SourceWidth:  2,
		SourceHeight: 2,
		FrameCount:   2,
		DurationMS:   2000,
		FPS:          1,
		FrameBytes:   1,
	}, []byte{0x80, 0x40}))
	if err != nil {
		t.Fatal(err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("local listen unavailable: %v", err)
	}
	httpServer := httptest.NewUnstartedServer(New(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("ok")},
	}, []byte("audio"), store).Handler())
	httpServer.Listener = listener
	httpServer.Start()
	defer httpServer.Close()

	ctx := context.Background()
	conn, _, err := websocket.Dial(ctx, "ws"+httpServer.URL[len("http"):]+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	typ, payload, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if typ != websocket.MessageText {
		t.Fatalf("initial message type = %v, want text", typ)
	}

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","from":0,"chunk":2}`)); err != nil {
		t.Fatal(err)
	}
	typ, payload, err = conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("frame message type = %v, want binary", typ)
	}
	if got := binary.LittleEndian.Uint32(payload[0:4]); got != 0 {
		t.Fatalf("start frame = %d, want 0", got)
	}
	if got := binary.LittleEndian.Uint16(payload[4:6]); got != 2 {
		t.Fatalf("frame count = %d, want 2", got)
	}
	if string(payload[6:]) != string([]byte{0x80, 0x40}) {
		t.Fatalf("payload = %v", payload[6:])
	}
}
