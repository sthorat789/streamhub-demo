// cmd/bridge/main.go — Bridge
//
// A gRPC server that receives PCM audio from StreamHub (PushAudio) and:
//   - Extracts the 12-byte K6TS header stamped by the k6 sender to measure
//     end-to-end latency (k6 → StreamHub → Bridge) without touching StreamHub.
//   - Records per-session WAV files (when --record-dir is set).
//   - Writes a JSON summary (same schema as the former e2eprobe) after every
//     session completes when --stats-out is set.
//   - Exposes ReceiveAudio (server-streaming) for ad-hoc debugging.
//
//   k6 sender ──(WS binary with K6TS header)──► StreamHub :8765
//   StreamHub ──(gRPC PushAudio, raw payload)──► Bridge    :50052
//
// K6TS header: [K][6][T][S][8-byte little-endian µs timestamp] (12 bytes total)
// Bridge strips the header before writing the WAV and forwarding.
//
// Usage:
//   go run ./cmd/bridge
//   go run ./cmd/bridge --port=50052 --record-dir=recordings --stats-out=e2e.json
//
// Build:
//   go build -o bin/bridge ./cmd/bridge

package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"io"
	"log"
	"math"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "streamhub/pb"
)

// ─── Per-session state ─────────────────────────────────────────────────────────

type session struct {
	ch    chan *pb.AudioPacket // optional buffered channel for ReceiveAudio debugging
	ready chan struct{}        // closed exactly once when PushAudio starts
}

type sessionStats struct {
	packetsReceived uint64
	packetsDropped  uint64
	latencyAvgMs    float64 // pre-computed in PushAudio — no re-sort in flushStats
	latencyP95Ms    float64
	latencyMaxMs    float64
	jitterMs        float64 // RFC 3550 smoothed IPDV at session end
	driftMs         float64 // mean(last-5 latency) − mean(first-5 latency)
}

var (
	mu           sync.Mutex
	sessions     = make(map[string]*session, 512)
	completed    = make(map[string]sessionStats, 512)
	statsOutPath string
	expectedPkts uint64
	statsMu      sync.Mutex // serialises JSON file writes
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

func storeStats(id string, received, dropped uint64, latAvgMs, latP95Ms, latMaxMs, jitterMs, driftMs float64) {
	mu.Lock()
	completed[id] = sessionStats{
		packetsReceived: received,
		packetsDropped:  dropped,
		latencyAvgMs:    latAvgMs,
		latencyP95Ms:    latP95Ms,
		latencyMaxMs:    latMaxMs,
		jitterMs:        jitterMs,
		driftMs:         driftMs,
	}
	mu.Unlock()
	if statsOutPath != "" {
		flushStats(statsOutPath)
	}
}

func getStats(id string) (sessionStats, bool) {
	mu.Lock()
	s, ok := completed[id]
	mu.Unlock()
	return s, ok
}

func markReady(s *session) {
	select {
	case <-s.ready: // already closed
	default:
		close(s.ready)
	}
}

// ─── JSON output (same schema as the former e2eprobe) ─────────────────────────

type sessionResult struct {
	SessionID       string  `json:"session_id"`
	PacketsReceived uint64  `json:"packets_received"`
	PacketsDropped  uint64  `json:"packets_dropped"`
	LatencyAvgMs    float64 `json:"latency_avg_ms"`
	LatencyP95Ms    float64 `json:"latency_p95_ms"`
	LatencyMaxMs    float64 `json:"latency_max_ms"`
	JitterMs        float64 `json:"jitter_ms"` // RFC 3550 smoothed IPDV
	DriftMs         float64 `json:"drift_ms"`  // mean(last-5 lat) − mean(first-5 lat)
	OK              bool    `json:"ok"`
	Error           string  `json:"error,omitempty"`
}

type statsSummary struct {
	ExpectedPackets uint64          `json:"expected_packets"`
	SessionCount    int             `json:"session_count"`
	SessOKRate      float64         `json:"sess_ok_rate"`
	SessDropPctAvg  float64         `json:"sess_drop_pct_avg"`
	E2ELatencyAvgMs float64         `json:"e2e_latency_avg_ms"`
	E2ELatencyP95Ms float64         `json:"e2e_latency_p95_ms"`
	E2ELatencyMaxMs float64         `json:"e2e_latency_max_ms"`
	JitterAvgMs     float64         `json:"jitter_avg_ms"` // mean RFC 3550 jitter across sessions
	DriftAvgMs      float64         `json:"drift_avg_ms"`  // mean drift across sessions
	Thresholds      map[string]bool `json:"thresholds"`
	Sessions        []sessionResult `json:"sessions"`
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(math.Ceil((p/100.0)*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// flushStats builds a summary from all completed sessions and writes it to path.
// Called after every session completes and on SIGTERM, so report.py always sees
// a valid file even if the pipeline is killed early.
// Per-session aggregates are pre-computed in PushAudio; flushStats only marshals.
func flushStats(path string) {
	mu.Lock()
	snap := make(map[string]sessionStats, len(completed))
	for k, v := range completed {
		snap[k] = v
	}
	mu.Unlock()

	sessResults := make([]sessionResult, 0, len(snap))
	allP95 := make([]float64, 0, len(snap))
	okCount := 0
	dropPctSum := 0.0
	jitterSum := 0.0
	driftSum := 0.0
	jitterN := 0

	for id, s := range snap {
		r := sessionResult{
			SessionID:       id,
			PacketsReceived: s.packetsReceived,
			PacketsDropped:  s.packetsDropped,
			LatencyAvgMs:    s.latencyAvgMs,
			LatencyP95Ms:    s.latencyP95Ms,
			LatencyMaxMs:    s.latencyMaxMs,
			JitterMs:        s.jitterMs,
			DriftMs:         s.driftMs,
		}
		if s.latencyP95Ms > 0 {
			allP95 = append(allP95, s.latencyP95Ms)
		}
		if s.jitterMs > 0 {
			jitterSum += s.jitterMs
			jitterN++
		}
		driftSum += s.driftMs
		r.OK = s.packetsDropped == 0 &&
			(expectedPkts == 0 || s.packetsReceived == expectedPkts)
		if r.OK {
			okCount++
		}
		// Drop % against expected (most accurate); fall back to received+dropped.
		if expectedPkts > 0 {
			dropPctSum += float64(s.packetsDropped) * 100.0 / float64(expectedPkts)
		} else if total := s.packetsReceived + s.packetsDropped; total > 0 {
			dropPctSum += float64(s.packetsDropped) * 100.0 / float64(total)
		}
		sessResults = append(sessResults, r)
	}

	jitterAvg := 0.0
	if jitterN > 0 {
		jitterAvg = jitterSum / float64(jitterN)
	}
	n := len(sessResults)
	driftAvg := 0.0
	if n > 0 {
		driftAvg = driftSum / float64(n)
	}
	sessRate := 0.0
	if n > 0 {
		sessRate = float64(okCount) / float64(n)
	}
	dropAvg := 0.0
	if n > 0 {
		dropAvg = dropPctSum / float64(n)
	}

	sort.Float64s(allP95)
	latAvg, latP95, latMax := 0.0, 0.0, 0.0
	if len(allP95) > 0 {
		sum := 0.0
		for _, v := range allP95 {
			sum += v
			if v > latMax {
				latMax = v
			}
		}
		latAvg = sum / float64(len(allP95))
		latP95 = percentile(allP95, 95)
	}

	out := statsSummary{
		ExpectedPackets: expectedPkts,
		SessionCount:    n,
		SessOKRate:      sessRate,
		SessDropPctAvg:  dropAvg,
		E2ELatencyAvgMs: latAvg,
		E2ELatencyP95Ms: latP95,
		E2ELatencyMaxMs: latMax,
		JitterAvgMs:     jitterAvg,
		DriftAvgMs:      driftAvg,
		Thresholds: map[string]bool{
			"e2e_latency_p95_lt_500ms": latP95 < 500,
			"sess_ok_rate_gt_095":      sessRate > 0.95,
			"sess_drop_pct_avg_lt_1":   dropAvg < 1,
		},
		Sessions: sessResults,
	}

	statsMu.Lock()
	defer statsMu.Unlock()
	dir := filepath.Dir(path)
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o755); err == nil {
		if b, err := json.MarshalIndent(out, "", "  "); err == nil {
			_ = os.WriteFile(path, b, 0o644)
			log.Printf("Stats → %s  (%d sessions  e2e_p95=%.1fms  ok_rate=%.0f%%)",
				path, n, latP95, sessRate*100)
		}
	}
}

// ─── gRPC service ──────────────────────────────────────────────────────────────

type bridgeServer struct {
	pb.UnimplementedAudioForwardServiceServer
	recordDir string
}

// ─── WAV recorder ──────────────────────────────────────────────────────────────

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

	// Write 44-byte PCM WAV header; sizes are patched on close.
	hdr := make([]byte, 44)
	copy(hdr[0:4], "RIFF")
	copy(hdr[8:12], "WAVE")
	copy(hdr[12:16], "fmt ")
	binary.LittleEndian.PutUint32(hdr[16:20], 16)
	binary.LittleEndian.PutUint16(hdr[20:22], 1) // PCM
	binary.LittleEndian.PutUint16(hdr[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(hdr[24:28], sampleRate)
	binary.LittleEndian.PutUint32(hdr[28:32], sampleRate*channels*2)
	binary.LittleEndian.PutUint16(hdr[32:34], uint16(channels*2))
	binary.LittleEndian.PutUint16(hdr[34:36], 16)
	copy(hdr[36:40], "data")

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
	w.f.Write(payload) // best-effort
	w.dataBytes += int64(len(payload))
}

func (w *wavWriter) close() {
	if w.f == nil {
		return
	}
	b4 := make([]byte, 4)
	binary.LittleEndian.PutUint32(b4, uint32(36+w.dataBytes))
	w.f.WriteAt(b4, 4)
	binary.LittleEndian.PutUint32(b4, uint32(w.dataBytes))
	w.f.WriteAt(b4, 40)
	w.f.Close()
	w.f = nil
	log.Printf("WAV saved: %s  (%d bytes PCM)", w.path, w.dataBytes)
}

// PushAudio — StreamHub calls this to push raw PCM into the bridge.
//
// For every packet Bridge:
//  1. Detects and strips the 12-byte K6TS header (magic + sender µs timestamp).
//  2. Computes e2e latency = bridgeRecvUs − clientSendTsUs.
//  3. Writes the stripped PCM directly to the WAV file (no intermediate channel).
//  4. Forwards the packet non-blocking into sess.ch for any connected ReceiveAudio.
func (b *bridgeServer) PushAudio(stream pb.AudioForwardService_PushAudioServer) error {
	const driftN = 5
	var (
		sid         string
		sess        *session
		pktsRecv    uint64
		ww          *wavWriter
		latenciesMs []float64
		// RFC 3550 jitter: smoothed inter-packet delay variation
		// transit(i) = bridgeRecvUs(i) − clientSendTsUs(i)
		// J(i) = J(i−1) + (|transit(i)−transit(i−1)| − J(i−1)) / 16
		// Clock offset cancels in the difference, so cross-clock jitter is accurate.
		prevTransitUs int64
		jitterUs      float64
		jitterInit    bool
		// Drift: mean(last driftN latencies) − mean(first driftN latencies)
		// Positive = pipeline accumulating delay; zero = stable.
		earlyLats [driftN]float64
		earlyN    int
		lateLats  [driftN]float64
		lateIdx   int
	)

	for {
		pkt, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			if ww != nil {
				ww.close()
			}
			if sess != nil {
				select {
				case sess.ch <- nil:
				default:
				}
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

		// Extract K6TS header: [K][6][T][S][8-byte LE µs timestamp]
		bridgeRecvUs := time.Now().UnixMicro()
		if len(pkt.Payload) >= 12 &&
			pkt.Payload[0] == 'K' && pkt.Payload[1] == '6' &&
			pkt.Payload[2] == 'T' && pkt.Payload[3] == 'S' {
			clientSendTsUs := int64(binary.LittleEndian.Uint64(pkt.Payload[4:12]))
			pkt.Payload = pkt.Payload[12:]
			if clientSendTsUs > 0 {
				latMs := float64(bridgeRecvUs-clientSendTsUs) / 1000.0
				if latMs >= 0 && latMs < 60_000 {
					latenciesMs = append(latenciesMs, latMs)
					// Drift: accumulate first / last driftN samples.
					if earlyN < driftN {
						earlyLats[earlyN] = latMs
						earlyN++
					}
					lateLats[lateIdx%driftN] = latMs
					lateIdx++
				}
				// RFC 3550 jitter using transit = recvUs − sendUs.
				// Clock offset is constant per session and cancels in the diff.
				transitUs := bridgeRecvUs - clientSendTsUs
				if jitterInit {
					d := math.Abs(float64(transitUs - prevTransitUs))
					jitterUs += (d - jitterUs) / 16
				}
				prevTransitUs = transitUs
				jitterInit = true
			}
		}

		// Init WAV writer on the first packet (sample rate + channels now known).
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

		pktsRecv++

		// Forward to ReceiveAudio channel non-blocking (debug use only).
		select {
		case sess.ch <- pkt:
		default:
			// channel full; no ReceiveAudio consumer — that's OK
		}
	}

	if ww != nil {
		ww.close()
	}
	if sess != nil {
		select {
		case sess.ch <- nil:
		default:
		}
		remove(sid)
	}
	// Compute final jitter (ms) and drift (ms) for this session.
	jitterMs := jitterUs / 1000.0
	var driftMs float64
	if earlyN >= 2 && lateIdx >= 2 {
		var earlySum, lateSum float64
		for i := 0; i < earlyN; i++ {
			earlySum += earlyLats[i]
		}
		lateN := lateIdx
		if lateN > driftN {
			lateN = driftN
		}
		for i := 0; i < lateN; i++ {
			lateSum += lateLats[i]
		}
		driftMs = (lateSum/float64(lateN) - earlySum/float64(earlyN))
	}

	// Compute per-session latency aggregates once here (O(n log n) per session,
	// never repeated). flushStats just reads pre-computed scalars — O(1) per session.
	var latAvgMs, latP95Ms, latMaxMs float64
	if len(latenciesMs) > 0 {
		sorted := make([]float64, len(latenciesMs))
		copy(sorted, latenciesMs)
		sort.Float64s(sorted)
		sum := 0.0
		for _, v := range sorted {
			sum += v
		}
		latAvgMs = sum / float64(len(sorted))
		latP95Ms = percentile(sorted, 95)
		latMaxMs = sorted[len(sorted)-1]
	}

	// Derive drop count from expectedPkts when set; otherwise assume 0.
	var pktsDropped uint64
	if expectedPkts > 0 && pktsRecv < expectedPkts {
		pktsDropped = expectedPkts - pktsRecv
	}

	log.Printf("[%s] PushAudio closed  recv=%d  dropped=%d  e2e_samples=%d  jitter=%.2fms  drift=%+.2fms",
		shortID(sid), pktsRecv, pktsDropped, len(latenciesMs), jitterMs, driftMs)
	if sid != "" {
		storeStats(sid, pktsRecv, pktsDropped, latAvgMs, latP95Ms, latMaxMs, jitterMs, driftMs)
	}
	return stream.SendAndClose(&pb.PushResult{
		SessionId:       sid,
		PacketsReceived: pktsRecv,
		PacketsDropped:  pktsDropped,
	})
}

// GetSessionStats — returns packet counts for a completed session.
// Kept for backwards compatibility and ad-hoc debugging.
func (b *bridgeServer) GetSessionStats(ctx context.Context, req *pb.SessionStatsRequest) (*pb.SessionStats, error) {
	sid := req.GetSessionId()
	if sid == "" {
		return nil, status.Error(codes.InvalidArgument, "session_id is required")
	}
	s, ok := getStats(sid)
	if !ok {
		return nil, status.Errorf(codes.NotFound, "session %q stats not found", sid)
	}
	return &pb.SessionStats{
		SessionId:       sid,
		PacketsReceived: s.packetsReceived,
		PacketsDropped:  s.packetsDropped,
	}, nil
}

// ReceiveAudio — available for live debugging; not required by the CI pipeline.
// Waits for PushAudio to register the session then drains the shared channel.
// WAV recording is handled by PushAudio; ReceiveAudio only forwards packets.
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
	ctx := stream.Context()

	select {
	case <-sess.ready:
	case <-time.After(time.Duration(waitS) * time.Second):
		return status.Errorf(codes.DeadlineExceeded, "session %q not seen within %ds", sid, waitS)
	case <-ctx.Done():
		return ctx.Err()
	}

	for {
		select {
		case pkt, ok := <-sess.ch:
			if !ok || pkt == nil {
				return nil
			}
			if err := stream.Send(pkt); err != nil {
				return err
			}
		case <-ctx.Done():
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
	port := flag.String("port", "50052", "gRPC listen port")
	recordDir := flag.String("record-dir", "", "Directory for per-session WAV files (disabled if empty)")
	statsOut := flag.String("stats-out", "", "Write e2e JSON stats to this file after each session")
	expPkts := flag.Uint64("expected-packets", 0, "Expected packets per session for sess_ok check (0 = skip)")
	flag.Parse()

	statsOutPath = *statsOut
	expectedPkts = *expPkts

	if *recordDir != "" {
		if err := os.MkdirAll(*recordDir, 0o755); err != nil {
			log.Fatalf("Cannot create record-dir %s: %v", *recordDir, err)
		}
		log.Printf("Recording sessions → %s", *recordDir)
	}
	if statsOutPath != "" {
		log.Printf("Stats output → %s", statsOutPath)
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

	// Graceful shutdown: flush final stats on SIGTERM / SIGINT.
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
		<-sigCh
		log.Println("Bridge: signal received — flushing stats and shutting down")
		if statsOutPath != "" {
			flushStats(statsOutPath)
		}
		srv.GracefulStop()
	}()

	log.Printf("Bridge gRPC listening on :%s", *port)
	if err := srv.Serve(lis); err != nil {
		log.Fatalf("Bridge serve: %v", err)
	}
}
