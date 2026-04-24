# StreamHub Demo

End-to-end audio pipeline for validating that StreamHub passes audio
transparently — correct bytes, no loss, no corruption.

```
k6 sender   ──(WebSocket binary)──────────────► StreamHub  :8765
StreamHub   ──(gRPC PushAudio)────────────────► Bridge     :50052
k6 receiver ◄──(gRPC ReceiveAudio)──────────── Bridge     :50052
```

The k6 load test streams a real WAV file through StreamHub, Bridge records
what arrives, and the quality checker confirms the bytes match the original.

---

## Repository layout

```
streamhub-demo/
├── proto/
│   └── audio_forward.proto       # gRPC contract (PushAudio + ReceiveAudio)
├── go/
│   ├── go.mod                    # module: streamhub
│   ├── generate_proto.sh         # compiles proto → go/pb/
│   └── cmd/
│       ├── streamhub/            # WS server + gRPC client
│       └── bridge/               # gRPC server + WAV recorder
├── scripts/
│   ├── quality_check.py          # byte-exact audio validation
│   ├── report.py                 # HTML report generator
│   └── requirements.txt          # numpy
├── tests/
│   └── k6/
│       └── k6_audio_pipeline.js  # k6 load test (sender + receiver)
├── data/
│   └── best_16k.wav              # reference audio (16 kHz mono PCM)
├── recordings/                   # Bridge WAV output — gitignored
├── results/                      # timestamped run output — gitignored
├── Dockerfile                    # multi-stage StreamHub image
└── run_pipeline.sh               # full orchestration script
```

---

## Prerequisites

| Tool | macOS | Linux | Windows |
|------|-------|-------|---------|
| Go 1.22+ | [go.dev/dl](https://go.dev/dl/) | [go.dev/dl](https://go.dev/dl/) | [go.dev/dl](https://go.dev/dl/) |
| protoc | `brew install protobuf` | `apt install protobuf-compiler` | `choco install protoc` |
| k6 | auto-installed, or `brew install grafana/tap/k6` | auto-installed, or see below | `choco install k6` |
| Python 3.11+ | `brew install python` | `apt install python3` | [python.org](https://python.org) |
| Git Bash / WSL | — | — | required for `run_pipeline.sh` |
| Docker | optional | optional | optional |

---

## Local run — macOS

```bash
# 1. Install tools
brew install go protobuf grafana/tap/k6 python

# 2. Clone and enter the repo
git clone https://github.com/<you>/streamhub-demo.git
cd streamhub-demo

# 3. Generate Go proto stubs (once, or when proto changes)
cd go && bash generate_proto.sh && go mod tidy && cd ..

# 4. Run the full pipeline
bash run_pipeline.sh --vus=3 --record

# 5. Open the report
open results/latest/report.html
```

`run_pipeline.sh` automatically creates `.venv/`, installs Python deps,
builds both Go binaries, starts services, runs k6, validates audio quality,
and generates a self-contained HTML report in `results/<timestamp>/`.

---

## Local run — Linux

```bash
# 1. Install Go (replace version as needed)
curl -fsSL https://go.dev/dl/go1.22.3.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
export PATH=$PATH:/usr/local/go/bin   # add to ~/.bashrc to persist

# 2. Install protoc + Python
sudo apt-get update && sudo apt-get install -y protobuf-compiler python3 python3-venv

# k6 (run_pipeline.sh installs this automatically on apt systems;
#      manual install if preferred)
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] \
  https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install -y k6

# 3. Clone and enter the repo
git clone https://github.com/<you>/streamhub-demo.git
cd streamhub-demo

# 4. Generate Go proto stubs
cd go && bash generate_proto.sh && go mod tidy && cd ..

# 5. Run the full pipeline
bash run_pipeline.sh --vus=3 --record

# 6. Open the report
xdg-open results/latest/report.html
```

---

## Local run — Windows

> **Requires** [Git for Windows](https://git-scm.com/download/win) (provides Git Bash)
> or [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install).
> `run_pipeline.sh` is a bash script and will not run in Command Prompt or plain PowerShell.

### Option A — Git Bash

```bash
# 1. Install tools via Chocolatey (run PowerShell as Administrator)
choco install golang protoc k6 python --yes

# 2. Open Git Bash, clone the repo
git clone https://github.com/<you>/streamhub-demo.git
cd streamhub-demo

# 3. Generate Go proto stubs
cd go && bash generate_proto.sh && go mod tidy && cd ..

# 4. Run the pipeline
bash run_pipeline.sh --vus=3 --record

# 5. Open the report
start results/latest/report.html
```

### Option B — WSL 2 (Ubuntu)

```bash
# Inside WSL terminal — follow the Linux instructions above exactly.
# Access the report from Windows:
explorer.exe "$(wslpath -w results/latest/report.html)"
```

### Manual Windows steps (without run_pipeline.sh)

If you prefer PowerShell / CMD directly:

```powershell
# Generate proto stubs
cd go
bash generate_proto.sh          # Git Bash
go mod tidy

# Build binaries
go build -o bin\bridge.exe     .\cmd\bridge
go build -o bin\streamhub.exe  .\cmd\streamhub

# Terminal 1 — start Bridge
.\go\bin\bridge.exe --port=50052 --record-dir=recordings

# Terminal 2 — start StreamHub
.\go\bin\streamhub.exe --ws-port=8765 --bridge-addr=127.0.0.1:50052

# Terminal 3 — run k6
k6 run tests\k6\k6_audio_pipeline.js

# Quality check
python scripts\quality_check.py --ref data\best_16k.wav --rec-dir recordings

# Report
python scripts\report.py `
  --k6-summary results\latest\k6_summary.json `
  --quality    results\latest\quality.json `
  --out        results\latest\report.html
```

---

## Run options (`run_pipeline.sh`)

```
bash run_pipeline.sh [options]

  --ws-port=PORT      StreamHub WebSocket port          (default: 8765)
  --bridge-port=PORT  Bridge gRPC port                  (default: 50052)
  --vus=N             Concurrent k6 sessions            (default: 1)
  --chunk-ms=N        Audio chunk interval ms           (default: 20)
  --audio=PATH        WAV file relative to repo root    (default: data/best_16k.wav)
  --wait-s=N          Bridge session wait timeout       (default: 10)
  --record[=DIR]      Record sessions to DIR            (default: recordings/)
  --k6-only           Skip build+services; hit running services
  --no-k6             Start services only, no test
  --quality-only=DIR  Re-run quality check on a recordings dir
```

---

## Running services manually (macOS / Linux)

```bash
# Build
cd go && bash generate_proto.sh && go mod tidy
go build -o bin/bridge     ./cmd/bridge
go build -o bin/streamhub  ./cmd/streamhub

# Start Bridge (gRPC server — must start first)
./go/bin/bridge --port=50052 --record-dir=recordings

# Start StreamHub (WS server, dials Bridge)
./go/bin/streamhub --ws-port=8765 --bridge-addr=127.0.0.1:50052

# Run k6 (from repo root)
k6 run tests/k6/k6_audio_pipeline.js
```

---

## Running with Docker

```bash
# Build StreamHub image (context = repo root)
docker build -t streamhub .

# Start Bridge as a plain binary
./go/bin/bridge --port=50052 --record-dir=recordings

# Start StreamHub as a container
# --network=host lets the container reach Bridge on 127.0.0.1:50052
docker run --rm --network=host streamhub \
  --ws-port=8765 --bridge-addr=127.0.0.1:50052
```

---

## Unit tests

```bash
cd go
bash generate_proto.sh
go test -v -race ./cmd/streamhub/... ./cmd/bridge/...
```

Tests cover: `shortID`, metadata JSON parsing, session registry
(`getOrCreate`, `markReady`, `remove`).

---

## Quality check

```bash
python scripts/quality_check.py \
  --ref data/best_16k.wav \
  --rec-dir recordings

# Machine-readable output
python scripts/quality_check.py \
  --ref data/best_16k.wav \
  --rec-dir recordings \
  --json
```

Checks per recorded session:

| Check | Pass condition |
|-------|----------------|
| Integrity | Recorded PCM bytes exactly match reference |
| Completeness | ≥ 99 % of audio arrived |
| Drop map | No 1-second windows with total loss |

---

## k6 metrics

| Metric | Description |
|--------|-------------|
| `fwd_pkt_latency_ms` | Per-packet one-way latency |
| `fwd_sess_drop_pct` | Drop % per session |
| `fwd_sess_mos` | E-model MOS estimate |
| `fwd_sess_lat_p50/p95/p99_ms` | Session latency percentiles |
| `fwd_sess_jitter_ms` | Inter-packet jitter |
| `fwd_sess_buf_delay_ms` | Buffer delay (p95 − p50) |
| `fwd_ws_conn_ms` | WebSocket connect time |
| `fwd_sess_ok` | Session success rate |

Default thresholds (edit in `tests/k6/k6_audio_pipeline.js`):

```js
fwd_sess_ok:        rate > 0.99
fwd_ws_conn_ms:     p(95) < 3000 ms
fwd_pkt_latency_ms: p(95) < 500 ms
fwd_sess_mos:       avg > 3.5
fwd_sess_drop_pct:  avg < 1 %
```

---

## CI/CD

GitHub Actions workflow: `.github/workflows/streamhub-audio-pipeline.yml`

```
unit-test  →  build-docker  →  integration
```

| Job | What it does |
|-----|--------------|
| `unit-test` | Generates proto stubs, runs `go test -race` |
| `build-docker` | Builds and pushes StreamHub image to `ghcr.io` |
| `integration` | Builds Bridge, starts services, runs k6 + quality + report, uploads `results/` as artifact |

Triggers: push to `main`/`develop`, pull requests, manual dispatch
(with `vus` and `chunk_ms` inputs).

The Docker image is published to:
```
ghcr.io/<owner>/streamhub:latest
ghcr.io/<owner>/streamhub:<commit-sha>
```

---

## Proto contract

```protobuf
service AudioForwardService {
  rpc PushAudio    (stream AudioPacket)    returns (PushResult);
  rpc ReceiveAudio (ReceiveRequest)        returns (stream AudioPacket);
}
```

After editing `proto/audio_forward.proto`, regenerate Go stubs:

```bash
cd go && bash generate_proto.sh
```

---

## Configuration reference

| Env var | Default | Used by |
|---------|---------|---------|
| `WS_URL` | `ws://127.0.0.1:8765` | k6 |
| `BRIDGE_GRPC_ADDR` | `127.0.0.1:50052` | k6 |
| `AUDIO_FILE` | `data/best_16k.wav` | k6 |
| `CHUNK_MS` | `20` | k6 |
| `VUS` | `1` | k6 |
| `WAIT_S` | `10` | k6 |
