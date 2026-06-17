package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type Server struct {
	webFS fs.FS
	audio []byte
	store *FrameStore
}

type WSRequest struct {
	Type     string `json:"type"`
	From     uint32 `json:"from"`
	Chunk    uint16 `json:"chunk"`
	Viewport struct {
		W   float64 `json:"w"`
		H   float64 `json:"h"`
		DPR float64 `json:"dpr"`
	} `json:"viewport"`
}

func New(webFS fs.FS, audio []byte, store *FrameStore) *Server {
	return &Server{webFS: webFS, audio: audio, store: store}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/audio", s.handleAudio)
	mux.HandleFunc("/meta", s.handleMeta)
	mux.HandleFunc("/ws", s.handleWS)
	mux.Handle("/", http.FileServer(http.FS(s.webFS)))
	return mux
}

func (s *Server) Serve(addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("listening on http://%s", printableAddr(addr))
	return srv.ListenAndServe()
}

func (s *Server) handleAudio(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, "ba.mp3", time.Time{}, bytes.NewReader(s.audio))
}

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, s.store.Meta())
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("websocket accept: %v", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx := r.Context()
	if err := conn.Write(ctx, websocket.MessageText, mustJSON(s.store.Meta())); err != nil {
		log.Printf("websocket write meta: %v", err)
		return
	}

	for {
		typ, payload, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			_ = conn.Close(websocket.StatusUnsupportedData, "expected text json request")
			return
		}

		var req WSRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			_ = conn.Close(websocket.StatusInvalidFramePayloadData, "invalid json request")
			return
		}
		if req.Type != "hello" && req.Type != "frames" {
			_ = conn.Close(websocket.StatusPolicyViolation, "unknown request type")
			return
		}
		chunk, err := s.store.Chunk(req.From, req.Chunk)
		if err != nil {
			_ = conn.Close(websocket.StatusPolicyViolation, err.Error())
			return
		}
		if err := conn.Write(ctx, websocket.MessageBinary, chunk); err != nil {
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

func mustJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}

func printableAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "127.0.0.1" + addr
	}
	return addr
}

func Run(ctx context.Context, addr string, webFS fs.FS, audio []byte, frames []byte) error {
	store, err := NewFrameStore(frames)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           New(webFS, audio, store).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("listening on http://%s", printableAddr(addr))
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		return ctx.Err()
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return fmt.Errorf("serve: %w", err)
	}
}
