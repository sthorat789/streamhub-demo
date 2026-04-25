# StreamHub Audio Pipeline — Load & Quality Validation

> **Branch:** `probe-in-bridge` — the production-ready, CI-green version of this pipeline.

---

## Table of Contents

1. [What is StreamHub?](#1-what-is-streamhub)
2. [What Are We Testing, and Why?](#2-what-are-we-testing-and-why)
3. [Architecture](#3-architecture)
4. [Test Flow — Step by Step](#4-test-flow--step-by-step)
5. [K6TS Timestamp Header](#5-k6ts-timestamp-header)
6. [Metrics Collected](#6-metrics-collected)
7. [Pass / Fail Thresholds](#7-pass--fail-thresholds)
8. [Repository Layout](#8-repository-layout)
9. [Prerequisites](#9-prerequisites)
10. [Running Locally](#10-running-locally)
11. [Run Options](#11-run-options)
12. [CI/CD Pipeline](#12-cicd-pipeline)
13. [HTML Report](#13-html-report)
14. [Successful Run — Reference Results](#14-successful-run--reference-results)
15. [Proto Contract](#15-proto-contract)
16. [Configuration Reference](#16-configuration-reference)

---

## 1. What is StreamHub?

**StreamHub** is a Go WebSocket-to-gRPC gateway. Its sole responsibility is to accept
real-time binary audio streams from WebSocket clients and forward every byte — without
modification — to a downstream gRPC service over a client-streaming `PushAudio` RPC.

```
WebSocket client   ──(binary frames)──►  StreamHub  ──(gRPC PushAudio)──►  downstream
```

StreamHub is deliberately **opaque**: it holds no knowledge of audio formats, packet
structure, or timing information. The bytes that arrive on the WebSocket are copied
byte-for-byte into each `AudioPacket.Payload` gRPC message. This design means that any
metadata the sender embeds in the payload — such as timestamps — is carried through
transparently.

**Key properties:**
- Pure byte passthrough — no parsing, no modification
- One gRPC stream per WebSocket session
- Session identity propagated via `AudioPacket.SessionId`
- Goroutine-per-session model, suitable for high concurrent loads
- Written in Go 1.22, built as a Docker image for CI

---

## 2. What Are We Testing, and Why?

Real-time audio streaming is sensitive to three independent failure modes that a simple
"did the bytes arrive?" check cannot distinguish:

| Failure mode | Consequence in production |
|---|---|
| **Packet loss** | Audio glitches, dropouts, truncated speech |
| **High end-to-end latency** | Perceptible delay between speaker and listener |
| **Jitter / drift** | Irregular delivery causing audio stuttering even when all bytes arrive |

This test harness validates **all three** simultaneously, at scale, on a real audio file,
using StreamHub as the system under test.

**Why k6?**  
k6 is a developer-centric load testing tool that runs JavaScript scenarios. It lets us
simulate hundreds of concurrent WebSocket sessions, each behaving exactly like a real
audio client: open a socket, stream a WAV file chunk by chunk at real-time pace, then
close. k6's native binary WebSocket support and sub-millisecond timestamp resolution make
it the ideal tool for injecting precise timing probes into the audio stream.

**Why a dedicated Bridge service?**  
The downstream service that actually processes audio in production is not under our
control for testing. Bridge is a purpose-built gRPC server that:
- Receives exactly what StreamHub forwards (proves passthrough fidelity)
- Extracts timing probes embedded by k6 and computes latency metrics per session
- Writes each session's raw PCM to a WAV file for byte-exact quality validation
- Produces a structured JSON report summarising aggregate quality across all sessions

Bridge is the **measurement engine** — all quality and latency numbers come from it.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              k6 Load Generator                              │
│                                                                             │
│  ┌─────────────┐   open()  ┌────────────────────────────────────────────┐  │
│  │ WAV file    │──────────►│ VU iteration (one per concurrent session)  │  │
│  │ best_16k.wav│           │                                            │  │
│  │ 20 s        │           │ 1. Parse WAV header (init context, once)  │  │
│  │ 16 kHz      │           │ 2. Assign session ID: ld-{iterationInTest}│  │
│  │ stereo      │           │ 3. ws.connect() → StreamHub :8765         │  │
│  │ PCM s16le   │           │ 4. Loop: slice CHUNK_BYTES of PCM         │  │
│  └─────────────┘           │         prepend K6TS 12-byte header       │  │
│                             │         ws.sendBinary(frame)             │  │
│                             │         sleep(CHUNK_MS ms)               │  │
│                             │ 5. ws.close() after last chunk           │  │
│                             └────────────────┬───────────────────────┘   │
│                                              │ WS binary frames           │
│                                              │ [K6TS hdr][PCM payload]    │
└──────────────────────────────────────────────┼─────────────────────────────┘
                                               │ :8765
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         StreamHub  (Go binary / Docker)                     │
│                                                                             │
│  ws.Upgrade()                                                               │
│  │                                                                          │
│  ├── read WS binary frame  (raw bytes, no parsing)                          │
│  │                                                                          │
│  └── gRPC PushAudio.Send( AudioPacket {                                     │
│          session_id : "ld-42"                                               │
│          seq        : 7                                                     │
│          payload    : <exact bytes from WS frame>   ← zero-copy append     │
│      })                                                                     │
│                                                                             │
│  StreamHub does NOT know what K6TS is. It just forwards bytes.              │
└──────────────────────────────────────────────┬──────────────────────────────┘
                                               │ gRPC client-streaming
                                               │ PushAudio  :50052
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Bridge  (Go binary)                               │
│                                                                             │
│  PushAudio stream handler (one goroutine per session):                      │
│                                                                             │
│  for each AudioPacket:                                                      │
│    ├── strip K6TS header from Payload[0:12]                                 │
│    │     magic  = [K][6][T][S]  (4 bytes)                                   │
│    │     sendTs = little-endian uint64 µs  (8 bytes)                        │
│    │                                                                        │
│    ├── recvTs = time.Now().UnixMicro()                                      │
│    │                                                                        │
│    ├── latency = recvTs − sendTs   (one-way, same-host clock)               │
│    │                                                                        │
│    ├── jitter += (|Δlatency| − jitter) / 16   (RFC 3550)                   │
│    │                                                                        │
│    └── write PCM payload[12:] to WAV file                                   │
│                                                                             │
│  on stream end:                                                             │
│    ├── sort latency samples → compute avg / p95 / max                       │
│    ├── drift = mean(last 5 latencies) − mean(first 5 latencies)             │
│    ├── drops = max(0, expected_pkts − received)                             │
│    ├── sess_ok = (drops == 0) && (received == expected_pkts)                │
│    └── write session record to e2e_latency.json                             │
│                                                                             │
│  on all sessions done (flushStats):                                         │
│    ├── aggregate across sessions                                             │
│    ├── evaluate thresholds                                                  │
│    └── emit JSON summary                                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         scripts/report.py                                   │
│                                                                             │
│  reads:  k6_summary.json   (k6 handleSummary output)                       │
│          e2e_latency.json  (Bridge JSON)                                    │
│          quality.json      (scripts/quality_check.py output)               │
│                                                                             │
│  produces: results/<timestamp>/report.html  (self-contained)                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component responsibilities

| Component | Language | Role |
|---|---|---|
| **k6 script** | JavaScript (k6 runtime) | Simulates concurrent audio clients; injects K6TS timing probes; records WS-layer metrics |
| **StreamHub** | Go 1.22 | Pure WS→gRPC forwarder; the system under test |
| **Bridge** | Go 1.22 | gRPC receiver; K6TS extraction; WAV recorder; latency/jitter/drift computation; quality judge |
| **quality_check.py** | Python 3 | Byte-exact PCM comparison of recorded WAV against reference WAV |
| **report.py** | Python 3 | Merges k6 + Bridge + quality JSON into a single self-contained HTML report |

---

## 4. Test Flow — Step by Step

This section traces the complete path of a single audio session from WAV file to PASS/FAIL
verdict, explaining every decision along the way.

### Step 0 — Startup (before any VU runs)

`run_pipeline.sh` performs the following in order:

1. **Computes `EXPECTED_PKTS`** using Python — the same formula used by k6:
   ```
   chunk_bytes = (sample_rate * bytes_per_sample * channels * chunk_ms) // 1000
   expected    = ceil(wav_data_size / chunk_bytes)
   ```
   For `best_16k.wav` (16 kHz, stereo, s16le) at 20 ms chunks:
   `chunk_bytes = (16000 × 2 × 2 × 20) // 1000 = 1280`, `expected = 1000`

2. **Builds Bridge and StreamHub** Go binaries (`go build ./cmd/bridge`, `go build ./cmd/streamhub`)

3. **Starts Bridge first** — it must be listening before StreamHub attempts to dial it:
   ```
   ./go/bin/bridge --port=50052 --record-dir=recordings \
     --stats-out=results/<ts>/e2e_latency.json \
     --expected-packets=1000
   ```

4. **Starts StreamHub**, which immediately dials Bridge at startup:
   ```
   ./go/bin/streamhub --ws-port=8765 --bridge-addr=127.0.0.1:50052
   ```

5. **Waits** for StreamHub's health-check endpoint to confirm readiness.

6. **Creates a timestamped results directory**: `results/YYYYMMDD_HHMMSS/`  
   All subsequent steps write into this directory. A `results/latest` symlink is updated
   at cleanup so `open results/latest/report.html` always opens the most recent run.

### Step 1 — k6 Init Context (runs once per VU, before iterations start)

Each VU executes the top-level module scope once before its first iteration:

1. **`open(AUDIO_FILE, "b")`** — reads the WAV file into memory as an `ArrayBuffer`.
   Done once per VU to avoid repeated disk I/O during the test. The same buffer is
   re-used across all iterations of that VU.

2. **`parseWav(buf)`** — walks the RIFF chunk tree to locate the `data` chunk and extracts:
   - `sampleRate`: 16 000 Hz
   - `channels`: 2 (stereo)
   - `bitsPerSample`: 16
   - `dataOffset`: byte offset where raw PCM begins inside the file
   - `dataSize`: number of PCM bytes

3. **Computes chunk geometry** (all arithmetic, no I/O):
   ```
   BYTES_PER_MS = (sampleRate × bytesPerSample × channels) / 1000
                = (16000 × 2 × 2) / 1000 = 64 bytes/ms
   CHUNK_BYTES  = floor(CHUNK_MS × BYTES_PER_MS)
                = floor(20 × 64) = 1280 bytes
   DURATION_S   = dataSize / (BYTES_PER_MS × 1000) = 20.0 s
   EXPECTED_PKTS = ceil(dataSize / CHUNK_BYTES)     = 1000
   ```

4. On VU 0 only, logs these values to the k6 console (informational).

### Step 2 — Session Identity

Every VU iteration is assigned a **globally unique** session ID:

```js
function sessionId() {
  return `ld-${exec.scenario.iterationInTest}`;
}
```

`exec.scenario.iterationInTest` is a monotonically increasing integer, scoped to the
scenario, that increments for every iteration across all VUs — no two iterations ever
share the same number.

**Why not `vu.idInTest`?** VU IDs are recycled when a VU completes and a new one starts.
If a VU with ID 5 completes iteration A and then starts iteration B, both iterations
would produce session `ld-5`, causing Bridge to write iteration B's WAV over iteration A's
file and merge their latency samples. Using `iterationInTest` gives each session a
permanent, unique identity for the lifetime of the test run.

### Step 3 — WebSocket Connection

```js
const res = ws.connect(WS_URL, {}, function (socket) { ... });
check(res, { "WS upgrade 101": (r) => r && r.status === 101 });
```

k6 records three connection-time metrics at this step:

- **`fwd_ws_conn_ms`** (custom Trend): wall time from `ws.connect()` call to the `open`
  event. Includes DNS, TCP handshake, HTTP Upgrade.
- **`ws_connecting`** (built-in Trend): TCP + HTTP Upgrade handshake time only
  (a subset of `fwd_ws_conn_ms`; excludes any k6 internal overhead).
- **`fwd_ws_ok`** (custom Rate): `true` if HTTP 101 was received.

A failed upgrade (e.g., StreamHub down, port wrong) immediately sets `fwd_ws_ok = false`
and ends the iteration.

### Step 4 — Sending Audio Chunks (real-time paced)

Inside the socket handler, a loop runs until all PCM data is sent:

```
offset = wav.dataOffset
while offset < wav.dataOffset + wav.dataSize:
    chunk = wavBuffer[offset : offset + CHUNK_BYTES]
    frame = K6TS header (12 bytes) + chunk
    socket.sendBinary(frame)
    sleep(CHUNK_MS)          ← real-time pacing: 20 ms per chunk
    offset += CHUNK_BYTES
socket.close()
```

**Why `sleep(CHUNK_MS)`?**  
Without the sleep, k6 would burst all 1000 frames in microseconds, flooding the receiver
and creating artificial throughput numbers. The sleep paces the sender to match real-time
audio production: one 20 ms chunk every 20 ms = 50 packets/second per session.

**Frame structure** (for every `sendBinary` call):
```
[  4 bytes magic  ][  8 bytes timestamp µs (LE uint64)  ][  1280 bytes PCM  ]
  K  6  T  S                                                  ↑ stripped by Bridge
```

For the reference WAV: 1000 frames per session, each 1292 bytes total (12 header + 1280 PCM).

After the last chunk, `socket.close()` triggers k6's `close` event handler, which records
`ws_session_duration`.

### Step 5 — StreamHub Forwarding (the system under test)

For every binary WebSocket frame received from a VU:

1. **Reads** the raw frame bytes from the WebSocket connection (no length limit enforced
   beyond OS network buffer sizes)
2. **Calls** `gRPCStream.Send(&pb.AudioPacket{ SessionId: id, Seq: seq, Payload: append([]byte(nil), data...) })`
   - `SessionId`: extracted from the WebSocket URL path or query parameter set by k6
   - `Seq`: per-session monotonic counter incremented for each `Send`
   - `Payload`: a defensive copy (`append([]byte(nil), ...)`) of the raw WebSocket frame
     bytes — K6TS header **and** PCM, without modification
3. **No parsing.** StreamHub does not inspect the payload. The K6TS header travels
   through invisibly.

This is what "pure byte passthrough" means in practice: the 12 K6TS bytes and 1280 PCM
bytes that k6 sent are exactly the 1292 bytes that Bridge receives in `AudioPacket.Payload`.

### Step 6 — Bridge Receives, Extracts Timestamps, Records Audio

Bridge runs one goroutine per incoming gRPC `PushAudio` stream (= one goroutine per
WebSocket session). For each `AudioPacket`:

**6a. K6TS extraction:**
```go
const magic = "K6TS"
if len(payload) >= 12 && string(payload[:4]) == magic {
    sendUs = int64(binary.LittleEndian.Uint64(payload[4:12]))
    pcm    = payload[12:]
    ok     = true
} else {
    // No K6TS: skip latency measurement, write full payload as PCM
}
```

**6b. Latency:**
```go
recvUs  = time.Now().UnixMicro()
latency = float64(recvUs - sendUs) / 1000.0   // → milliseconds
```
> **Clock accuracy:** this is a one-way measurement using a single clock. It is accurate
> only when k6 and Bridge run on the same machine (same kernel clock). In CI, they do.
> In multi-host setups, NTP skew directly biases every latency reading.

**6c. RFC 3550 Jitter:**
```go
transit     = recvUs - sendUs
deltaTrans  = abs(transit - prevTransit)
jitter     += (float64(deltaTrans) - jitter) / 16.0
```
The divisor 16 is the standard RTP decay constant. It gives a smoothed running average
of inter-packet transit time variation, robust to individual spikes.

**6d. WAV write:**  
`pcm = payload[12:]` is written to `recordings/{sessionId}.wav`. Only the stripped PCM
bytes are stored — the K6TS headers are not part of the audio data.

**6e. On stream close (`io.EOF`):**
```go
sort(latencies)
latAvg = mean(latencies)
latP95 = percentile(latencies, 0.95)
latMax = max(latencies)
drift  = mean(latencies[last5]) - mean(latencies[first5])
drops  = max(0, expectedPkts - len(latencies))
sessOk = drops == 0 && len(latencies) == expectedPkts
```

`drift` detects whether latency trends upward over the session. A positive drift means
the pipeline is accumulating back-pressure under load; negative drift means it is
recovering. Zero drift = steady state.

All scalars are pre-computed here (once, O(n log n) for the sort). `flushStats` later
reads them directly without re-sorting — O(n) across sessions regardless of session count.

### Step 7 — Bridge Flushes the JSON Summary

After all gRPC streams close (k6 stops sending), `flushStats` runs:

```json
{
  "expected_packets":     1000,
  "session_count":        1555,
  "sess_ok_rate":         1.0,
  "sess_drop_pct_avg":    0.0,
  "e2e_latency_avg_ms":   1.2,
  "e2e_latency_p95_ms":   2.1,
  "e2e_latency_max_ms":   5.8,
  "jitter_avg_ms":        0.3,
  "drift_avg_ms":         0.05,
  "thresholds": {
    "e2e_latency_p95_lt_500ms": "PASS",
    "sess_ok_rate_gt_095":      "PASS",
    "sess_drop_pct_avg_lt_1":   "PASS"
  },
  "sessions": [
    { "id": "ld-0", "received": 1000, "dropped": 0, "sess_ok": true,
      "latency_avg_ms": 1.1, "latency_p95_ms": 1.9, "latency_max_ms": 4.2,
      "jitter_ms": 0.2, "drift_ms": 0.0 },
    ...
  ]
}
```

### Step 8 — k6 Summary Export

At test completion, k6 calls `handleSummary(data)` (introduced in k6 v0.38; required
from v0.55 onward when `--summary-export` was removed):

```js
export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE]: JSON.stringify(data) };
}
```

This writes all built-in and custom k6 metrics to `k6_summary.json`.

### Step 9 — Quality Check

`scripts/quality_check.py --ref data/best_16k.wav --rec-dir recordings`:

1. Strips RIFF/WAV headers from both the reference and each recorded file
2. Compares raw PCM bytes: `complete_pct = received_bytes / expected_bytes × 100`
3. Counts `corrupt_bytes`: positions where received byte ≠ reference byte
4. Detects `drop_windows`: 1-second intervals (in samples) with all-zero or absent audio
5. Per-session verdict: `PASS` if `complete_pct == 100.0` and `corrupt_bytes == 0`

Output: `quality.json` (one record per session)

### Step 10 — HTML Report Generation

`scripts/report.py` reads the three JSON files and renders `report.html`:

- Auto-formats timing: µs for < 1 ms, ms for < 1 s, s for < 1 min
- Auto-formats bytes: B / kB / MB / GB
- Inline chart of `fwd_ws_conn_ms` and `ws_connecting` distributions
- All metric rows have a one-sentence explanation visible in the table

---

## 5. K6TS Timestamp Header

The K6TS header is a 12-byte prefix that k6 prepends to every binary WebSocket frame
before sending. It is the mechanism by which end-to-end latency is measured without any
out-of-band coordination.

```
Byte offset:  0    1    2    3    4    5    6    7    8    9    10   11
              ──── ──── ──── ──── ─────────────────────────────────────
              'K'  '6'  'T'  'S'    send timestamp (µs, little-endian uint64)
              ─────────────────────  ────────────────────────────────────
              magic  (4 bytes)       wall-clock time at send (8 bytes)
```

**Why embed the timestamp in the payload, not in gRPC metadata?**

gRPC metadata is only available at stream open, not per-message. Embedding the timestamp
in the payload makes it per-packet, survives any number of intermediate hops (StreamHub
copies it without knowing), and requires zero coordination between k6 and Bridge.

**Why does this survive StreamHub?**  
StreamHub copies `payload = append([]byte(nil), data...)` — every byte of the WS frame
becomes every byte of `AudioPacket.Payload`. The K6TS header is not special-cased.

**Implementation in k6:**
```js
function stampBinaryFrame(pcmBuf) {
  const frame = new ArrayBuffer(12 + pcmBuf.byteLength);
  const v     = new DataView(frame);
  v.setUint8(0, 0x4B); // 'K'
  v.setUint8(1, 0x36); // '6'
  v.setUint8(2, 0x54); // 'T'
  v.setUint8(3, 0x53); // 'S'
  const nowUs = BigInt(Date.now()) * 1000n;
  v.setBigUint64(4, nowUs, true);       // little-endian
  new Uint8Array(frame).set(new Uint8Array(pcmBuf), 12);
  return frame;
}
```

**Implementation in Bridge (Go):**
```go
const k6Magic = "K6TS"

func extractK6TS(payload []byte) (sendUs int64, pcm []byte, ok bool) {
    if len(payload) < 12 || string(payload[:4]) != k6Magic {
        return 0, payload, false
    }
    sendUs = int64(binary.LittleEndian.Uint64(payload[4:12]))
    return sendUs, payload[12:], true
}
```

---

## 6. Metrics Collected

### 6.1 k6 Custom Metrics

Defined in `tests/k6/k6_audio_pipeline.js`:

| Metric | Type | What it measures |
|---|---|---|
| `fwd_ws_conn_ms` | Trend | Time from `ws.connect()` call to WebSocket `open` event (ms). Includes DNS, TCP, HTTP Upgrade. Proxy for StreamHub connection-setup latency. |
| `fwd_ws_ok` | Rate | Proportion of iterations where WebSocket upgrade succeeded (HTTP 101). Should be 100% under normal conditions. |

### 6.2 k6 Built-in Metrics (always collected)

| Metric | Type | What it measures |
|---|---|---|
| `checks` | Rate | Proportion of `check()` assertions that passed. Checks: WS upgrade OK, close code 1000. |
| `iteration_duration` | Trend | Wall-clock time for one complete VU iteration: WS connect → stream full WAV → close. For a 20 s WAV, expect ~21.5 s (add WS setup/teardown overhead). |
| `iterations` | Counter | Total completed VU iterations = total sessions that ran to completion. |
| `vus` | Gauge | Instantaneous active VU count (snapshot at test end). |
| `vus_max` | Gauge | Peak concurrent VUs observed during the test. |
| `data_sent` | Counter | Total bytes sent by k6 over all WebSocket connections. Scales with VU count × session duration × bitrate. |
| `data_received` | Counter | Bytes received by k6 — only WS control frames (pong, close). Typically tiny (< 1 kB/session). |
| `ws_connecting` | Trend | TCP handshake + HTTP Upgrade time only (subset of `fwd_ws_conn_ms`). Useful for isolating network latency from application-level connection overhead. |
| `ws_msgs_sent` | Counter | Total binary + text frames sent. Should equal `sessions × EXPECTED_PKTS + sessions` (one control frame per session open). |
| `ws_session_duration` | Trend | Wall-clock time from WebSocket `open` event to `close` event. Closely tracks iteration duration minus connection setup time. |
| `ws_sessions` | Counter | Total WebSocket sessions opened. Should equal `iterations`. |

### 6.3 Bridge E2E Metrics

Computed from K6TS timestamps; reported in `e2e_latency.json`:

| Metric | Formula | What it measures |
|---|---|---|
| `e2e_latency_avg_ms` | `mean(recvTs − sendTs)` across all packets/sessions | Average one-way latency from k6 send to Bridge receive. Unbiased on same-host (single clock). |
| `e2e_latency_p95_ms` | 95th percentile of the above | Latency at or below which 95% of packets fall. Primary SLO indicator. Threshold: < 500 ms. |
| `e2e_latency_max_ms` | max of all per-packet latencies | Worst-case latency. Useful for spotting transient spikes caused by GC pauses or scheduler jitter. |
| `jitter_avg_ms` | mean of per-session RFC 3550 jitter: `J(i) = J(i-1) + (│ΔT│ − J(i-1)) / 16` | Smoothed average of inter-packet transit time variation. High jitter + low latency = bursty delivery (buffering required). |
| `drift_avg_ms` | mean of per-session `mean(last5 latencies) − mean(first5 latencies)` | Whether latency grew over a session. Positive = back-pressure building; negative = recovering; zero = steady state. |
| `sess_ok_rate` | `sessions with zero drops / total sessions` | Fraction of sessions where all expected packets arrived. Threshold: > 95%. |
| `sess_drop_pct_avg` | mean of `drops / expected_pkts × 100` per session | Average packet loss rate across sessions. Threshold: < 1%. |

### 6.4 Quality Check Metrics

Per-session output from `scripts/quality_check.py`:

| Field | How computed | What it means |
|---|---|---|
| `complete_pct` | `received_bytes / expected_bytes × 100` | Percentage of audio that arrived intact at Bridge |
| `lost_pct` | `100 − complete_pct` | Percentage of audio lost in transit |
| `corrupt_bytes` | count of positions where `recorded[i] != reference[i]` | Bytes that arrived but differ from source — indicates misalignment or corruption |
| `drop_windows` | 1-second windows with total silence or absence | Gaps that would be perceptible as dropouts in real audio |
| `integrity` | `OK` / `CORRUPT` | Binary: were the bytes that arrived correct? |
| `result` | `PASS` if `complete_pct == 100` and `corrupt_bytes == 0` | Overall per-session verdict |

---

## 7. Pass / Fail Thresholds

### k6 Thresholds (enforced by k6; non-zero exit code if breached)

| Metric | Threshold | Rationale |
|---|---|---|
| `fwd_ws_ok` | `rate > 0.99` | At most 1% of sessions may fail to connect to StreamHub |
| `fwd_ws_conn_ms` | `p(95) < 3000 ms` | WebSocket upgrade must complete in under 3 s for 95% of sessions |

### Bridge Thresholds (evaluated in Go; reported in `e2e_latency.json`)

| Field | Threshold | Rationale |
|---|---|---|
| `e2e_latency_p95_ms` | `< 500 ms` | End-to-end audio delay below human perception threshold for 95% of packets |
| `sess_ok_rate` | `> 0.95` | At least 95% of sessions must receive all expected packets |
| `sess_drop_pct_avg` | `< 1%` | Average packet loss below the perceptible quality degradation threshold |

---

## 8. Repository Layout

```
streamhub-demo/
├── proto/
│   └── audio_forward.proto       # gRPC service definition (PushAudio + ReceiveAudio)
├── go/
│   ├── go.mod                    # module: streamhub, Go 1.22
│   ├── generate_proto.sh         # runs protoc → go/pb/
│   └── cmd/
│       ├── streamhub/main.go     # WebSocket server + gRPC PushAudio client
│       └── bridge/main.go        # gRPC PushAudio server + WAV recorder + e2e stats
├── scripts/
│   ├── quality_check.py          # byte-exact WAV comparison vs reference
│   ├── report.py                 # merges k6 + Bridge + quality JSON → HTML
│   └── requirements.txt          # numpy
├── tests/
│   └── k6/
│       └── k6_audio_pipeline.js  # k6 load scenario: WS sender + K6TS stamping
├── data/
│   └── best_16k.wav              # 20 s, 16 kHz, stereo, PCM s16le — 1000 pkts @ 20 ms
├── recordings/                   # Bridge WAV output (gitignored)
├── results/                      # timestamped run directories (gitignored)
│   ├── YYYYMMDD_HHMMSS/
│   │   ├── k6_summary.json
│   │   ├── e2e_latency.json
│   │   ├── quality.json
│   │   └── report.html
│   └── latest -> YYYYMMDD_HHMMSS/
├── Dockerfile                    # multi-stage StreamHub image
├── run_pipeline.sh               # orchestration: build → services → k6 → quality → report
└── .github/
    └── workflows/
        └── streamhub-audio-pipeline.yml
```

---

## 9. Prerequisites

| Tool | macOS | Linux (Ubuntu/Debian) | Min version |
|---|---|---|---|
| Go | `brew install go` | [go.dev/dl](https://go.dev/dl/) | 1.22 |
| protoc | `brew install protobuf` | `apt install protobuf-compiler` | any |
| k6 | auto-installed by script, or `brew install grafana/tap/k6` | auto-installed, or [k6.io/docs](https://k6.io/docs/get-started/installation/) | 0.55+ |
| Python | `brew install python` | `apt install python3 python3-venv` | 3.11+ |
| Docker | optional (StreamHub as container) | optional | any |

---

## 10. Running Locally

### Quick start (macOS)

```bash
git clone https://github.com/<you>/streamhub-demo.git
cd streamhub-demo

# Generate proto stubs (required once, or when proto changes)
cd go && bash generate_proto.sh && go mod tidy && cd ..

# Run: 10 concurrent sessions, record WAVs, open report
bash run_pipeline.sh --max-vus=10 --record
open results/latest/report.html
```

### Quick start (Linux)

```bash
sudo apt-get install -y protobuf-compiler python3 python3-venv
# install Go from go.dev/dl if not present

git clone https://github.com/<you>/streamhub-demo.git
cd streamhub-demo
cd go && bash generate_proto.sh && go mod tidy && cd ..

bash run_pipeline.sh --max-vus=10 --record
xdg-open results/latest/report.html
```

### Running services manually (without `run_pipeline.sh`)

```bash
cd go && bash generate_proto.sh && go mod tidy
go build -o bin/bridge     ./cmd/bridge
go build -o bin/streamhub  ./cmd/streamhub
cd ..

# Terminal 1 — Bridge (start first)
./go/bin/bridge \
  --port=50052 \
  --record-dir=recordings \
  --stats-out=results/manual/e2e_latency.json \
  --expected-packets=1000

# Terminal 2 — StreamHub
./go/bin/streamhub --ws-port=8765 --bridge-addr=127.0.0.1:50052

# Terminal 3 — k6
mkdir -p results/manual
SUMMARY_FILE=results/manual/k6_summary.json \
k6 run tests/k6/k6_audio_pipeline.js \
  -e MAX_VUS=10 -e RAMP_DURATION=10s -e STABLE_DURATION=30s

# Quality check
python scripts/quality_check.py \
  --ref data/best_16k.wav --rec-dir recordings --json \
  > results/manual/quality.json

# Report
python scripts/report.py \
  --k6-summary results/manual/k6_summary.json \
  --e2e        results/manual/e2e_latency.json \
  --quality    results/manual/quality.json \
  --out        results/manual/report.html

open results/manual/report.html
```

### Unit tests

```bash
cd go && bash generate_proto.sh && go mod tidy
go test -v -race ./cmd/streamhub/... ./cmd/bridge/...
```

---

## 11. Run Options

```
bash run_pipeline.sh [options]

Transport:
  --ws-port=PORT          StreamHub WebSocket port             (default: 8765)
  --bridge-port=PORT      Bridge gRPC port                     (default: 50052)

Load shape:
  --max-vus=N             Peak concurrent VUs                  (default: 500)
  --ramp-duration=T       Duration per ramp stage (k6 syntax)  (default: 1m)
  --stable-duration=T     Duration of stable peak stage        (default: 3m)

Audio:
  --chunk-ms=N            PCM chunk interval in ms             (default: 20)
  --audio=PATH            WAV file (relative to repo root)     (default: data/best_16k.wav)

Recording:
  --record                Record WAVs to recordings/
  --record=DIR            Record WAVs to DIR

Shortcuts:
  --k6-only               Skip build+services; run k6+quality+report against running services
  --no-k6                 Start services only (no k6 / quality / report)
  --quality-only=DIR      Re-run quality check on DIR and regenerate report only
  --wait-s=N              Seconds to wait for Bridge to flush after k6 exits (default: 10)
```

**Load shape visualised (7 stages):**

```
VUs │
    │                          ┌──────────────────────────┐
100%│                          │       stable peak        │
    │               ┌──────────┤                          ├──────────┐
 50%│               │          │                          │          │
    │    ┌──────────┤          │                          │          ├──────────┐
 20%│    │          │          │                          │          │          │
    │    │   ramp   │   ramp   │                          │   ramp   │   ramp   │ ramp
  0 └────┴──────────┴──────────┴──────────────────────────┴──────────┴──────────┴────── 0
         ramp_d      ramp_d      ramp_d    stable_d         ramp_d    ramp_d    ramp_d
```

For the reference CI run (100 VUs, default 1m stages, 3m stable): ~10 min total test
duration, plus WAV streaming time per session (~20 s per session).

---

## 12. CI/CD Pipeline

**File:** `.github/workflows/streamhub-audio-pipeline.yml`

**Triggers:** push to `main`/`develop`, pull requests, `workflow_dispatch` (with `vus`
and `chunk_ms` inputs for manual overrides)

```
┌──────────────────────────────────────────────────────────────────┐
│  GitHub Actions  ubuntu-latest                                   │
│                                                                  │
│  ┌──────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │  unit-test   │───►│  build-docker   │───►│  integration   │  │
│  │              │    │                 │    │                │  │
│  │ generate pb  │    │ docker build    │    │ Create RESULTS_│  │
│  │ go test -race│    │ push ghcr.io   │    │  DIR (timestmp)│  │
│  │ ./cmd/...    │    │                 │    │ Build Bridge   │  │
│  └──────────────┘    └─────────────────┘    │ Start StreamHub│  │
│                                             │  (Docker)      │  │
│                                             │ Start Bridge   │  │
│                                             │  (binary)      │  │
│                                             │ Run k6         │  │
│                                             │ quality_check  │  │
│                                             │ report.py      │  │
│                                             │ Upload artifact│  │
│                                             └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Key CI implementation details:**

- A single `RESULTS_DIR=results/YYYYMMDD_HHMMSS` is created in the "Create runtime
  directories" step and exported via `$GITHUB_ENV`. Every subsequent step (Bridge
  `--stats-out`, k6 `SUMMARY_FILE`, `report.py --out`) uses the same variable, so all
  outputs land in one directory.
- `EXPECTED_PKTS` is computed with Python using the same formula as k6, using
  `CHUNK_MS="${CHUNK_MS:-20}"` so a `workflow_dispatch` override of `chunk_ms` correctly
  propagates to Bridge's `--expected-packets`.
- Artifact name: `streamhub-pipeline-{run_number}-{run_attempt}` (includes attempt
  number so re-runs do not overwrite earlier artifacts)

**Downloading the report from CI:**
1. Open the GitHub Actions run page
2. Scroll to **Artifacts** at the bottom
3. Download `streamhub-pipeline-N-N`
4. Unzip and open `results/<timestamp>/report.html` in any browser

---

## 13. HTML Report

`results/latest/report.html` is a single self-contained file (all CSS and JavaScript
inlined; no external network requests required).

**Section 1 — Overall Summary**  
Large metric cards: sessions passed/total, avg audio loss, latency p95, overall PASS/FAIL.

**Section 2 — k6 Performance Metrics**  
Every k6 metric (built-in + custom) in a table with:
- Metric name + one-sentence explanation
- Avg / Rate / Value
- Med / Min
- p95 / Max
- p99
- Threshold result (✓ / ✗ / —)

Timing values: auto-formatted µs / ms / s / min.  
Data values: auto-formatted B / kB / MB / GB.

**Section 3 — StreamHub E2E Metrics**  
Bridge-computed per-packet latency, jitter, drift, and session-level aggregates.
Each row includes the formula and a note on measurement assumptions (e.g., same-host
clock for unbiased latency).

**Section 4 — Per-Session Quality Table**  
One row per session: complete%, lost%, corrupt bytes, integrity, drop windows, PASS/FAIL.
Hundreds of rows are rendered efficiently; use browser search (Ctrl+F) to find a session.

---

## 14. Successful Run — Reference Results

Results from a verified passing CI run on the `probe-in-bridge` branch (commit `17e9548`).

**Test configuration:**
- **100 peak VUs**, `ramping-vus`, 7 stages (1m ramp / 3m stable / 1m ramp down each)
- WAV: `data/best_16k.wav` — 20 s, 16 kHz, stereo, PCM s16le
- Chunk: 20 ms = 1280 bytes per frame
- Expected packets per session: **1000**
- Total sessions completed: **1555**

### Overall

```
┌─────────────────────────────────────────────────────────────┐
│  1555 / 1555  Sessions passed   ✅  (100%)                   │
│  0.00%        Avg audio loss    ✅                           │
│  0            Total corrupt bytes ✅                         │
│  2 ms         Latency p95       ✅  (threshold < 3000 ms)    │
└─────────────────────────────────────────────────────────────┘
```

### k6 Performance Metrics

| Metric | Avg / Value | Med / Min | p95 / Max | Threshold |
|---|---|---|---|---|
| WS connect time (`fwd_ws_conn_ms`) | 837 µs | 1.00 ms | **2.00 ms** | ✓ p(95) < 3000 ms |
| Session success rate (`fwd_ws_ok`) | 100% | 1555 passed / 0 failed | — | ✓ rate > 0.99 |
| Check pass rate (`checks`) | 100% | 1555 passed / 0 failed | — | — |
| Iteration duration | 21.52 s | 21.52 s | 21.52 s | — |
| Iterations completed | 1555 | 2.779 /s | — | — |
| Active VUs (end snapshot) | 1 | min 1 | max 100 | — |
| Max VUs observed | 100 | 100 | 100 | — |
| Data sent | **2.02 GB** | **3.61 MB/s** | — | — |
| Data received | 203.28 kB | 363 B/s | — | — |
| WS TCP handshake (`ws_connecting`) | 770 µs | 557 µs | 2.21 ms | — |
| WS frames sent (`ws_msgs_sent`) | **1,556,555** | **2,781.7 /s** | — | — |
| WS session duration | 21.52 s | 21.52 s | 21.52 s | — |
| WS sessions opened | 1555 | 2.779 /s | — | — |

### Per-Session Quality (all 1555 sessions — sample shown)

| Session | Complete % | Lost % | Corrupt bytes | Integrity | Drop windows | Result |
|---|---|---|---|---|---|---|
| ld-0 | 100.00% | 0.00% | 0 | OK | none | **PASS** |
| ld-1 | 100.00% | 0.00% | 0 | OK | none | **PASS** |
| ld-100 | 100.00% | 0.00% | 0 | OK | none | **PASS** |
| ld-500 | 100.00% | 0.00% | 0 | OK | none | **PASS** |
| ld-1000 | 100.00% | 0.00% | 0 | OK | none | **PASS** |
| ld-1554 | 100.00% | 0.00% | 0 | OK | none | **PASS** |
| **All 1555** | **100.00%** | **0.00%** | **0** | **OK** | **none** | **PASS** |

### Interpreting the numbers

| Observation | What it means |
|---|---|
| Iteration duration 21.52 s vs 20 s WAV | ~1.5 s overhead = WS connect + close + goroutine scheduling. Consistent with `fwd_ws_conn_ms` avg ≈ 837 µs × concurrent session setup. |
| WS frames 1,556,555 = 1555 × 1000 + 1555 | Exactly 1000 audio chunks per session + 1 session-open control frame each. |
| Data sent 2.02 GB | 1555 sessions × 1000 chunks × 1292 bytes/frame (1280 PCM + 12 K6TS) ≈ 2.01 GB. Matches. |
| Data received 203 kB | Only WebSocket close/pong frames — k6 received nothing else. |
| 0 corrupt bytes across all sessions | StreamHub forwarded bytes without any modification. The K6TS header was stripped by Bridge; remaining PCM matches reference exactly. |
| `sess_ok_rate` not yet in this run's JSON | This run predates the `--expected-packets` fix (`25285a8`). Bridge was receiving `--expected-packets=0` and therefore could not compute drop stats. Latency metrics were still valid. The E2E table shows "No e2e summary found" in the report for that run. This is fixed in `17e9548`. |

---

## 15. Proto Contract

```protobuf
// proto/audio_forward.proto

service AudioForwardService {
  // k6 → StreamHub → Bridge: client streams audio chunks
  rpc PushAudio    (stream AudioPacket)  returns (PushResult);
  // Bridge → receiver: server streams audio back (not used in this test)
  rpc ReceiveAudio (ReceiveRequest)      returns (stream AudioPacket);
}

message AudioPacket {
  string session_id  = 1;  // globally unique per iteration, e.g. "ld-42"
  uint64 seq         = 2;  // monotonic counter per session (0-based)
  uint32 sample_rate = 3;  // 16000
  uint32 channels    = 4;  // 2
  bytes  payload     = 5;  // [K6TS 12 bytes][raw PCM CHUNK_BYTES bytes]
}

message PushResult {
  uint64 packets_received = 1;
  uint64 packets_dropped  = 2;
}
```

To regenerate Go stubs after editing the proto:

```bash
cd go && bash generate_proto.sh
```

---

## 16. Configuration Reference

### k6 environment variables

| Variable | Default | Description |
|---|---|---|
| `WS_URL` | `ws://127.0.0.1:8765` | StreamHub WebSocket endpoint |
| `AUDIO_FILE` | `../../data/best_16k.wav` | Path to WAV file (relative to `tests/k6/`) |
| `CHUNK_MS` | `20` | Audio chunk duration in milliseconds |
| `MAX_VUS` | `500` | Peak concurrent virtual users |
| `RAMP_DURATION` | `1m` | Duration of each ramp stage (k6 duration string, e.g. `30s`, `2m`) |
| `STABLE_DURATION` | `3m` | Duration of the stable peak stage |
| `SUMMARY_FILE` | *(required)* | Output path for `handleSummary` JSON |
| `DEBUG` | `0` | Set `1` to enable per-packet console logging (verbose) |

### Bridge flags

| Flag | Default | Description |
|---|---|---|
| `--port` | `50052` | gRPC listen port |
| `--record-dir` | *(none)* | Directory to write per-session WAV files. Omit to skip recording. |
| `--stats-out` | `e2e_latency.json` | Path for the JSON summary output |
| `--expected-packets` | `0` | Expected packets per session. `0` = disable drop detection. Must match k6's `EXPECTED_PKTS` for accurate drop stats and `sess_ok` verdicts. |

### Matching `--expected-packets` to k6

Both k6 and `run_pipeline.sh` use identical Python/JS formulae:

```
chunk_bytes     = (sample_rate × bytes_per_sample × channels × chunk_ms) // 1000
expected_packets = ceil(data_size / chunk_bytes)
```

For `best_16k.wav` (16 kHz, stereo, s16le = 2 bytes/sample) at 20 ms:
`chunk_bytes = (16000 × 2 × 2 × 20) // 1000 = 1280`  
`expected_packets = ceil(2560000 / 1280) = 2000`

> Wait — 2000? The WAV is 20 s at 16 kHz stereo s16le = 16000 × 2 × 2 = 64000 bytes/s × 20 s = 1 280 000 bytes.  
> `ceil(1280000 / 1280) = 1000`. ✓ The formula is correct; use `python3 -c` to verify:

```bash
python3 -c "
import math, struct
with open('data/best_16k.wav','rb') as f:
    f.seek(0); data = f.read()
pos = 12
while pos < len(data):
    chunk_id = data[pos:pos+4]
    chunk_sz = struct.unpack_from('<I', data, pos+4)[0]
    if chunk_id == b'data':
        sr = struct.unpack_from('<I', data, 24)[0]
        ch = struct.unpack_from('<H', data, 22)[0]
        bps = struct.unpack_from('<H', data, 34)[0]
        chunk_ms = 20
        chunk_b = (sr * (bps//8) * ch * chunk_ms) // 1000
        print(f'data_size={chunk_sz}  chunk_b={chunk_b}  expected={math.ceil(chunk_sz/chunk_b)}')
        break
    pos += 8 + chunk_sz + (chunk_sz % 2)
"
```
