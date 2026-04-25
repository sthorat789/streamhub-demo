package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "streamhub/pb"
)

type wavInfo struct {
	channels      uint16
	sampleRate    uint32
	bitsPerSample uint16
	dataSize      uint32
}

type sessionResult struct {
	SessionID       string  `json:"session_id"`
	PacketsReceived uint64  `json:"packets_received"`
	PacketsDropped  uint64  `json:"packets_dropped"`
	CorruptPackets  uint64  `json:"corrupt_packets"`
	BridgeAvgMs     float64 `json:"bridge_latency_avg_ms"`
	BridgeP95Ms     float64 `json:"bridge_latency_p95_ms"`
	BridgeMaxMs     float64 `json:"bridge_latency_max_ms"`
	LatencyAvgMs    float64 `json:"latency_avg_ms"`
	LatencyP95Ms    float64 `json:"latency_p95_ms"`
	LatencyMaxMs    float64 `json:"latency_max_ms"`
	OK              bool    `json:"ok"`
	Error           string  `json:"error,omitempty"`
}

type summary struct {
	ExpectedPackets    uint64          `json:"expected_packets"`
	SessionCount       int             `json:"session_count"`
	SessOKRate         float64         `json:"sess_ok_rate"`
	SessDropPctAvg     float64         `json:"sess_drop_pct_avg"`
	BridgeLatencyAvgMs float64         `json:"bridge_latency_avg_ms"`
	BridgeLatencyP95Ms float64         `json:"bridge_latency_p95_ms"`
	BridgeLatencyMaxMs float64         `json:"bridge_latency_max_ms"`
	E2ELatencyAvgMs    float64         `json:"e2e_latency_avg_ms"`
	E2ELatencyP95Ms    float64         `json:"e2e_latency_p95_ms"`
	E2ELatencyMaxMs    float64         `json:"e2e_latency_max_ms"`
	Thresholds         map[string]bool `json:"thresholds"`
	Sessions           []sessionResult `json:"sessions"`
}

func parseWav(path string) (wavInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return wavInfo{}, err
	}
	if len(data) < 44 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WAVE" {
		return wavInfo{}, fmt.Errorf("not a wav file: %s", path)
	}
	info := wavInfo{
		channels:      binary.LittleEndian.Uint16(data[22:24]),
		sampleRate:    binary.LittleEndian.Uint32(data[24:28]),
		bitsPerSample: binary.LittleEndian.Uint16(data[34:36]),
	}
	for pos := 12; pos+8 <= len(data); {
		id := string(data[pos : pos+4])
		sz := int(binary.LittleEndian.Uint32(data[pos+4 : pos+8]))
		if id == "data" {
			info.dataSize = uint32(sz)
			return info, nil
		}
		pos += 8 + sz
		if sz%2 != 0 {
			pos++
		}
	}
	return wavInfo{}, fmt.Errorf("wav file has no data chunk: %s", path)
}

func expectedPackets(path string, chunkMS int) (uint64, error) {
	wav, err := parseWav(path)
	if err != nil {
		return 0, err
	}
	bytesPerMS := float64(wav.sampleRate) * float64(wav.bitsPerSample/8) * float64(wav.channels) / 1000.0
	chunkBytes := math.Floor(float64(chunkMS) * bytesPerMS)
	if chunkBytes <= 0 {
		return 0, fmt.Errorf("invalid chunk size derived from %s", path)
	}
	return uint64(math.Ceil(float64(wav.dataSize) / chunkBytes)), nil
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

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

func runSession(stub pb.AudioForwardServiceClient, sid string, waitS uint32, timeout time.Duration, expectedPkts uint64) sessionResult {
	res := sessionResult{SessionID: sid}
	deadline := time.Now().Add(timeout)

	var stream pb.AudioForwardService_ReceiveAudioClient
	var streamCancel context.CancelFunc
	defer func() {
		if streamCancel != nil {
			streamCancel()
		}
	}()
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			res.Error = fmt.Sprintf("session %s did not appear within %s", sid, timeout)
			return res
		}
		attemptWait := waitS
		remainingS := uint32(math.Ceil(remaining.Seconds()))
		if remainingS == 0 {
			remainingS = 1
		}
		if attemptWait == 0 || attemptWait > remainingS {
			attemptWait = remainingS
		}
		ctx, cancel := context.WithTimeout(context.Background(), remaining)
		s, err := stub.ReceiveAudio(ctx, &pb.ReceiveRequest{SessionId: sid, WaitS: attemptWait})
		if err == nil {
			stream = s
			streamCancel = cancel
			break
		}
		cancel()
		code := status.Code(err)
		if code == codes.DeadlineExceeded || code == codes.NotFound {
			time.Sleep(200 * time.Millisecond)
			continue
		}
		res.Error = err.Error()
		return res
	}

	latencies := make([]float64, 0, expectedPkts)
	bridgeLatencies := make([]float64, 0, expectedPkts)
	for {
		pkt, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			res.Error = err.Error()
			break
		}
		if len(pkt.Payload) == 0 {
			res.CorruptPackets++
		}
		if pkt.SendTsUs != 0 && pkt.RecvTsUs != 0 {
			bridgeMs := float64(pkt.RecvTsUs-pkt.SendTsUs) / 1000.0
			if bridgeMs >= 0 && bridgeMs < 60000 {
				bridgeLatencies = append(bridgeLatencies, bridgeMs)
			}
		}
		if pkt.ClientSendTsUs != 0 {
			arrivalUs := time.Now().UnixMicro()
			latMs := float64(arrivalUs-pkt.ClientSendTsUs) / 1000.0
			if latMs >= 0 && latMs < 60000 {
				latencies = append(latencies, latMs)
			}
		}
	}

	var stats *pb.SessionStats
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			if res.Error == "" {
				res.Error = fmt.Sprintf("session %s stats not available within %s", sid, timeout)
			}
			return res
		}
		ctx, cancel := context.WithTimeout(context.Background(), minDuration(remaining, 3*time.Second))
		s, err := stub.GetSessionStats(ctx, &pb.SessionStatsRequest{SessionId: sid})
		cancel()
		if err == nil {
			stats = s
			break
		}
		code := status.Code(err)
		if code == codes.NotFound || code == codes.DeadlineExceeded {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if res.Error == "" {
			res.Error = err.Error()
		}
		return res
	}
	res.PacketsReceived = stats.PacketsReceived
	res.PacketsDropped = stats.PacketsDropped

	sort.Float64s(latencies)
	sort.Float64s(bridgeLatencies)
	if len(bridgeLatencies) > 0 {
		sum := 0.0
		for _, v := range bridgeLatencies {
			sum += v
		}
		res.BridgeAvgMs = sum / float64(len(bridgeLatencies))
		res.BridgeP95Ms = percentile(bridgeLatencies, 95)
		res.BridgeMaxMs = bridgeLatencies[len(bridgeLatencies)-1]
	}
	if len(latencies) > 0 {
		sum := 0.0
		for _, v := range latencies {
			sum += v
		}
		res.LatencyAvgMs = sum / float64(len(latencies))
		res.LatencyP95Ms = percentile(latencies, 95)
		res.LatencyMaxMs = latencies[len(latencies)-1]
	}
	res.OK = res.PacketsReceived == expectedPkts && res.PacketsDropped == 0 && res.CorruptPackets == 0 && res.Error == ""
	return res
}

func main() {
	bridgeAddr := flag.String("bridge-addr", "127.0.0.1:50052", "Bridge gRPC address")
	waitS := flag.Uint("wait-s", 30, "Seconds to wait for each session to appear")
	sessionCount := flag.Int("session-count", 10, "Number of sessions to probe (ld-0..ld-N)")
	sessionPrefix := flag.String("session-prefix", "ld-", "Session ID prefix")
	audioFile := flag.String("audio-file", filepath.Join("..", "data", "best_16k.wav"), "Reference WAV path")
	chunkMS := flag.Int("chunk-ms", 20, "Chunk size in milliseconds")
	sessionTimeoutS := flag.Int("session-timeout-s", 180, "Per-session receiver timeout in seconds")
	outPath := flag.String("out", "", "Write JSON summary to this path")
	flag.Parse()

	expectedPkts, err := expectedPackets(*audioFile, *chunkMS)
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2eprobe: %v\n", err)
		os.Exit(2)
	}

	conn, err := grpc.NewClient(*bridgeAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(4*1024*1024),
			grpc.MaxCallSendMsgSize(4*1024*1024),
		),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "e2eprobe dial: %v\n", err)
		os.Exit(2)
	}
	defer conn.Close()
	stub := pb.NewAudioForwardServiceClient(conn)

	results := make([]sessionResult, *sessionCount)
	var wg sync.WaitGroup
	for i := 0; i < *sessionCount; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sid := fmt.Sprintf("%s%d", *sessionPrefix, i)
			results[i] = runSession(stub, sid, uint32(*waitS), time.Duration(*sessionTimeoutS)*time.Second, expectedPkts)
		}(i)
	}
	wg.Wait()

	allLatencies := make([]float64, 0, expectedPkts*uint64(*sessionCount))
	allBridgeLatencies := make([]float64, 0, expectedPkts*uint64(*sessionCount))
	okCount := 0
	dropPctSum := 0.0
	for _, r := range results {
		if r.OK {
			okCount++
		}
		pktsExpect := r.PacketsReceived + r.PacketsDropped
		if pktsExpect > 0 {
			dropPctSum += float64(r.PacketsDropped) * 100.0 / float64(pktsExpect)
		}
		if r.LatencyP95Ms > 0 || r.LatencyAvgMs > 0 || r.LatencyMaxMs > 0 {
			// Reconstruct representative samples from session aggregates is not possible,
			// so use session p95s for an upper-bound aggregate when summarizing.
			allLatencies = append(allLatencies, r.LatencyP95Ms)
		}
		if r.BridgeP95Ms > 0 || r.BridgeAvgMs > 0 || r.BridgeMaxMs > 0 {
			allBridgeLatencies = append(allBridgeLatencies, r.BridgeP95Ms)
		}
	}
	sort.Float64s(allLatencies)
	sort.Float64s(allBridgeLatencies)

	sessRate := 0.0
	if *sessionCount > 0 {
		sessRate = float64(okCount) / float64(*sessionCount)
	}
	dropAvg := 0.0
	if *sessionCount > 0 {
		dropAvg = dropPctSum / float64(*sessionCount)
	}
	latAvg := 0.0
	latP95 := 0.0
	latMax := 0.0
	bridgeAvg := 0.0
	bridgeP95 := 0.0
	bridgeMax := 0.0
	if len(allBridgeLatencies) > 0 {
		sum := 0.0
		for _, v := range allBridgeLatencies {
			sum += v
			if v > bridgeMax {
				bridgeMax = v
			}
		}
		bridgeAvg = sum / float64(len(allBridgeLatencies))
		bridgeP95 = percentile(allBridgeLatencies, 95)
	}
	if len(allLatencies) > 0 {
		sum := 0.0
		for _, v := range allLatencies {
			sum += v
			if v > latMax {
				latMax = v
			}
		}
		latAvg = sum / float64(len(allLatencies))
		latP95 = percentile(allLatencies, 95)
	}

	s := summary{
		ExpectedPackets: expectedPkts,
		SessionCount:    *sessionCount,
		SessOKRate:      sessRate,
		SessDropPctAvg:  dropAvg,
		BridgeLatencyAvgMs: bridgeAvg,
		BridgeLatencyP95Ms: bridgeP95,
		BridgeLatencyMaxMs: bridgeMax,
		E2ELatencyAvgMs: latAvg,
		E2ELatencyP95Ms: latP95,
		E2ELatencyMaxMs: latMax,
		Thresholds: map[string]bool{
			"e2e_latency_p95_lt_500ms": latP95 < 500,
			"sess_ok_rate_gt_095":      sessRate > 0.95,
			"sess_drop_pct_avg_lt_1":   dropAvg < 1,
		},
		Sessions: results,
	}

	fmt.Println("E2E PROBE")
	fmt.Printf("  bridge_latency_p95_ms: %.3f\n", s.BridgeLatencyP95Ms)
	fmt.Printf("  e2e_latency_p95_ms: %.2f\n", s.E2ELatencyP95Ms)
	fmt.Printf("  sess_ok_rate: %.2f%%\n", s.SessOKRate*100)
	fmt.Printf("  sess_drop_pct_avg: %.2f\n", s.SessDropPctAvg)

	if *outPath != "" {
		if err := os.MkdirAll(filepath.Dir(*outPath), 0o755); err == nil {
			if b, err := json.MarshalIndent(s, "", "  "); err == nil {
				_ = os.WriteFile(*outPath, b, 0o644)
			}
		}
	}

	if !s.Thresholds["e2e_latency_p95_lt_500ms"] || !s.Thresholds["sess_ok_rate_gt_095"] || !s.Thresholds["sess_drop_pct_avg_lt_1"] {
		os.Exit(99)
	}
}
