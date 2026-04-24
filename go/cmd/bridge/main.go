// cmd/bridge/main.go — Bridge
//
// A pure gRPC server. Needed only when StreamHub acts
// as a gRPC CLIENT that dials out — i.e. it cannot expose its own gRPC server.
//
// The Bridge exposes two RPCs on the same port:
//
//   PushAudio    (client-streaming) — StreamHub calls this to push PCM in.
//   ReceiveAudio (server-streaming) — k6 receiver calls this to pull PCM out.
//
// Per-session buffered channel connects the two sides with zero locks on the
// hot path. One goroutine per RPC call — designed for 300–500 sessions.
//
//   StreamHub ──(gRPC PushAudio)──► Bridge :50052
//   k6 receiver ◄──(gRPC ReceiveAudio)── Bridge :50052
//
// Bridge has NO WebSocket server and NO knowledge of k6 internals.
//
// Usage:
//   go run ./cmd/bridge
//   go run ./cmd/bridge --port=50052
//
// Build:
//   go build -o bin/bridge ./cmd/bridge
//
// Setup (once):
//   cd go && bash generate_proto.sh && go mod tidy

package main

import (
	"encoding/binary"
	"flag"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "streamhub/pb"
)

// ─── Per-session state ─────────────────────────────────────────────────────────
// StreamHub's PushAudio call creates the entry and signals ready.
// k6's ReceiveAudio call waits on ready then drains the channel.

type session struct {
	ch    chan *pb.AudioPacket // PushAudio → ReceiveAudio (buffered, 256 packets)
	ready chan struct{}        // closed exactly once when PushAudio starts
}

var (
	mu       sync.Mutex
	sessions = make(map[string]*session, 512)
)

func getOrCreate(id string) *session {
	mu.Lock()
	defer mu.Unlock()
	if s, ok := sessions[id]; ok {
		return s
	}
	s := &session{
		ch:    make(chan *pb.AudioPacket, 256),
		ready: make(chan struct{}),
	}
	sessions[id] = s
	return s
}

func remove(id string) {
	mu.Lock()
	delete(sessions, id)
	mu.Unlock()
}

func markReady(s *session) {
	select {
	case <-s.ready: // already closed
	default:
		close(s.ready)
	}
}

// ─── gRPC service ──────────────────────────────────────────────────────────────

type bridgeServer struct {
	pb.UnimplementedAudioForwardServiceServer
	recordDir string // if non-empty, write a WAV per session under this directory
}

// ─── WAV recorder ──────────────────────────────────────────────────────────────
// Writes raw 16-bit signed PCM into a valid WAV file. Sizes are patched on close.

var safeID = regexp.MustCompile(`[^a-zA-Z0-9_\-]`)

type wavWriter struct {
	path      string
	f         *os.File
	dataBytes int64
}

func newWavWriter(dir, sid string, sampleRate, channels uint32) (*wavWriter, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	safe := safeID.ReplaceAllString(sid, "_")
	path := filepath.Join(dir, safe+".wav")
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}

	// Write 44-byte PCM WAV header with placeholder sizes (patched on close).
	hdr := make([]byte, 44)
	copy(hdr[0:4], "RIFF")
	// [4:8]  RIFF chunk size — patched on close
	copy(hdr[8:12], "WAVE")
	copy(hdr[12:16], "fmt ")
	binary.LittleEndian.PutUint32(hdr[16:20], 16)                  // fmt chunk size
	binary.LittleEndian.PutUint16(hdr[20:22], 1)                   // PCM = 1
	binary.LittleEndian.PutUint16(hdr[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(hdr[24:28], sampleRate)
	binary.LittleEndian.PutUint32(hdr[28:32], sampleRate*channels*2) // byte rate (16-bit)
	binary.LittleEndian.PutUint16(hdr[32:34], uint16(channels*2))   // block align
	binary.LittleEndian.PutUint16(hdr[34:36], 16)                   // bits per sample
	copy(hdr[36:40], "data")
	// [40:44] data chunk size — patched on close

	if _, err := f.Write(hdr); err != nil {
		f.Close()
		return nil, err
	}
	return &wavWriter{path: path, f: f}, nil
}

func (w *wavWriter) write(payload []byte) {
	if len(payload) == 0 {
		return
	}
	w.f.Write(payload) // best-effort — errors surface on close
	w.dataBytes += int64(len(payload))
}

func (w *wavWriter) close() {
	if w.f == nil {
		return
	}
	b4 := make([]byte, 4)
	// Patch RIFF size (= 36 + dataBytes)
	binary.LittleEndian.PutUint32(b4, uint32(36+w.dataBytes))
	w.f.WriteAt(b4, 4)
	// Patch data chunk size
	binary.LittleEndian.PutUint32(b4, uint32(w.dataBytes))
	w.f.WriteAt(b4, 40)
	w.f.Close()
	w.f = nil
	log.Printf("WAV saved: %s  (%d bytes PCM)", w.path, w.dataBytes)
}

// PushAudio — StreamHub calls this as a gRPC CLIENT to push PCM into the bridge.
// Each AudioPacket must carry a session_id. The first packet registers the session
// and unblocks any waiting ReceiveAudio call.
func (b *bridgeServer) PushAudio(stream pb.AudioForwardService_PushAudioServer) error {
	var (
		sid         string
		sess        *session
		pktsRecv    uint64
		pktsDropped uint64
	)

	for {
		pkt, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			if sess != nil {
				sess.ch <- nil
				remove(sid)
			}
			return err
		}

		// First packet — register session.
		if sid == "" {
			sid = pkt.SessionId
			if sid == "" {
				return status.Error(codes.InvalidArgument, "session_id must be set in every AudioPacket")
			}
			sess = getOrCreate(sid)
			markReady(sess)
			log.Printf("[%s] PushAudio started", shortID(sid))
		}

		// Stamp arrival time if StreamHub didn't set it.
		pkt.RecvTsUs = time.Now().UnixMicro()
		if pkt.SendTsUs == 0 {
			pkt.SendTsUs = pkt.RecvTsUs
		}

		select {
		case sess.ch <- pkt:
			pktsRecv++
		default:
			pktsDropped++
			log.Printf("[%s] channel full — dropping seq=%d", shortID(sid), pkt.Seq)
		}
	}

	// Nil sentinel signals ReceiveAudio to close the stream cleanly.
	if sess != nil {
		sess.ch <- nil
		remove(sid)
	}
	log.Printf("[%s] PushAudio closed  recv=%d dropped=%d", shortID(sid), pktsRecv, pktsDropped)

	return stream.SendAndClose(&pb.PushResult{
		SessionId:       sid,
		PacketsReceived: pktsRecv,
		PacketsDropped:  pktsDropped,
	})
}

// ReceiveAudio — k6 receiver calls this to get PCM packets out of the bridge.
// Waits up to wait_s for StreamHub's PushAudio call to register the session,
// then streams every packet until the nil sentinel (PushAudio closed).
func (b *bridgeServer) ReceiveAudio(req *pb.ReceiveRequest, stream pb.AudioForwardService_ReceiveAudioServer) error {
	sid := req.SessionId
	if sid == "" {
		return status.Error(codes.InvalidArgument, "session_id is required")
	}
	waitS := req.WaitS
	if waitS == 0 {
		waitS = 10
	}

	sess := getOrCreate(sid)
	ctx  := stream.Context()

	select {
	case <-sess.ready:
	case <-time.After(time.Duration(waitS) * time.Second):
		return status.Errorf(codes.DeadlineExceeded, "session %q not seen within %ds", sid, waitS)
	case <-ctx.Done():
		return ctx.Err()
	}

	var ww *wavWriter // non-nil when --record-dir is set

	for {
		select {
		case pkt, ok := <-sess.ch:
			if !ok || pkt == nil {
				if ww != nil {
					ww.close()
				}
				return nil // PushAudio closed — end stream cleanly
			}

			// Init WAV writer on the first real packet (sample rate + channels now known).
			if ww == nil && b.recordDir != "" {
				sr := pkt.SampleRate
				if sr == 0 {
					sr = 16000
				}
				ch := pkt.Channels
				if ch == 0 {
					ch = 1
				}
				var werr error
				ww, werr = newWavWriter(b.recordDir, sid, sr, ch)
				if werr != nil {
					log.Printf("[%s] WAV open failed: %v", shortID(sid), werr)
				}
			}
			if ww != nil {
				ww.write(pkt.Payload)
			}

			if err := stream.Send(pkt); err != nil {
				if ww != nil {
					ww.close()
				}
				return err
			}
		case <-ctx.Done():
			if ww != nil {
				ww.close()
			}
			return ctx.Err()
		}
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

func shortID(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// ─── main ──────────────────────────────────────────────────────────────────────

func main() {
	port      := flag.String("port",       "50052", "gRPC listen port")
	recordDir := flag.String("record-dir", "",      "Directory to save per-session WAV files (disabled if empty)")
	flag.Parse()

	if *recordDir != "" {
		if err := os.MkdirAll(*recordDir, 0o755); err != nil {
			log.Fatalf("Cannot create record-dir %s: %v", *recordDir, err)
		}
		log.Printf("Recording ReceiveAudio streams → %s", *recordDir)
	}

	lis, err := net.Listen("tcp", ":"+*port)
	if err != nil {
		log.Fatalf("Bridge listen :%s: %v", *port, err)
	}

	srv := grpc.NewServer(
		grpc.MaxRecvMsgSize(4*1024*1024),
		grpc.MaxSendMsgSize(4*1024*1024),
	)
	pb.RegisterAudioForwardServiceServer(srv, &bridgeServer{recordDir: *recordDir})

	log.Printf("Bridge gRPC (PushAudio + ReceiveAudio) listening on :%s", *port)
	if err := srv.Serve(lis); err != nil {
		log.Fatalf("Bridge serve: %v", err)
	}
}
