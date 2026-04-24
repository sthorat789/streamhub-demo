// cmd/streamhub/main.go — StreamHub
//
// Receives raw PCM audio from k6 sender over WebSocket and forwards every
// packet to the Bridge over gRPC (PushAudio client-streaming).
//
// StreamHub is a WebSocket SERVER and a gRPC CLIENT only.
// It has NO gRPC server — the Bridge owns all gRPC serving.
//
//   k6 sender  ──(WS binary)──────────────────► StreamHub :8765
//   StreamHub  ──(gRPC PushAudio)──────────────► Bridge :50052
//   k6 receiver ◄──(gRPC ReceiveAudio)────────── Bridge :50052
//
// One goroutine per WS connection dials Bridge and opens a PushAudio stream.
// Packets flow: WS message → AudioPacket → PushAudio.Send → Bridge.
//
// Usage:
//   go run ./cmd/streamhub
//   go run ./cmd/streamhub --ws-port=8765 --bridge-addr=127.0.0.1:50052
//
// Build:
//   go build -o bin/streamhub ./cmd/streamhub
//
// Setup (once):
//   cd go && bash generate_proto.sh && go mod tidy

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "streamhub/pb"
)

// ─── WebSocket upgrader ────────────────────────────────────────────────────────

var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 4 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type metadata struct {
	SessionID  string `json:"session_id"`
	SampleRate uint32 `json:"sample_rate"`
	Channels   uint32 `json:"channels"`
	ChunkMS    uint32 `json:"chunk_ms"`
}

var clientTsMagic = [4]byte{'K', '6', 'T', 'S'}

// ─── Per-connection handler ────────────────────────────────────────────────────
// Each WS connection gets its own goroutine, its own gRPC connection, and its
// own PushAudio stream. Nothing is shared between sessions.

func handleWS(bridgeAddr string, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WS upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// ── 1. Read JSON metadata (first WS message) ──────────────────────────────
	msgType, raw, err := conn.ReadMessage()
	if err != nil || msgType != websocket.TextMessage {
		log.Printf("WS: expected JSON metadata as first message: %v", err)
		return
	}
	var meta metadata
	if err := json.Unmarshal(raw, &meta); err != nil || meta.SessionID == "" {
		log.Printf("WS: invalid metadata: %v", err)
		return
	}
	sid := meta.SessionID
	log.Printf("[%s] WS connected  rate=%d ch=%d chunk_ms=%d",
		shortID(sid), meta.SampleRate, meta.Channels, meta.ChunkMS)

	// ── 2. Dial Bridge (gRPC) ─────────────────────────────────────────────────
	grpcConn, err := grpc.NewClient(bridgeAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(4*1024*1024),
			grpc.MaxCallSendMsgSize(4*1024*1024),
		),
	)
	if err != nil {
		log.Printf("[%s] dial Bridge %s: %v", shortID(sid), bridgeAddr, err)
		return
	}
	defer grpcConn.Close()

	// ── 3. Open PushAudio stream toward Bridge ────────────────────────────────
	stub := pb.NewAudioForwardServiceClient(grpcConn)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pushStream, err := stub.PushAudio(ctx)
	if err != nil {
		log.Printf("[%s] PushAudio open: %v", shortID(sid), err)
		return
	}
	log.Printf("[%s] PushAudio stream open → %s", shortID(sid), bridgeAddr)

	// ── 4. Forward WS binary messages as AudioPackets ─────────────────────────
	var seq uint64
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break // WS closed or error — fall through to close PushAudio
		}
		if mt != websocket.BinaryMessage {
			continue // skip non-binary (e.g. ping frames)
		}

		clientSendTsUs := int64(0)
		if len(data) >= 12 &&
			data[0] == clientTsMagic[0] &&
			data[1] == clientTsMagic[1] &&
			data[2] == clientTsMagic[2] &&
			data[3] == clientTsMagic[3] {
			clientSendTsUs = int64(binary.LittleEndian.Uint64(data[4:12]))
			data = data[12:]
		}

		pkt := &pb.AudioPacket{
			Seq:            seq,
			SendTsUs:       time.Now().UnixMicro(),
			SessionId:      sid,
			SampleRate:     meta.SampleRate,
			Channels:       meta.Channels,
			Payload:        append([]byte(nil), data...), // copy — WS reuses buf
			ClientSendTsUs: clientSendTsUs,
		}
		seq++

		if err := pushStream.Send(pkt); err != nil {
			log.Printf("[%s] PushAudio.Send seq=%d: %v", shortID(sid), pkt.Seq, err)
			break
		}
	}

	// ── 5. Close PushAudio stream, collect Bridge summary ─────────────────────
	result, err := pushStream.CloseAndRecv()
	if err != nil {
		log.Printf("[%s] PushAudio.CloseAndRecv: %v", shortID(sid), err)
	} else {
		log.Printf("[%s] WS closed  sent=%d  bridge_recv=%d  bridge_drop=%d",
			shortID(sid), seq, result.PacketsReceived, result.PacketsDropped)
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
	wsPort     := flag.String("ws-port",     "8765",            "WebSocket listen port")
	bridgeAddr := flag.String("bridge-addr", "127.0.0.1:50052", "Bridge gRPC address (host:port)")
	flag.Parse()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		handleWS(*bridgeAddr, w, r)
	})

	log.Printf("StreamHub WebSocket listening on :%s  →  Bridge %s", *wsPort, *bridgeAddr)
	if err := http.ListenAndServe(":"+*wsPort, nil); err != nil {
		log.Fatalf("WS serve: %v", err)
	}
}
