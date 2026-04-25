#!/usr/bin/env bash
# run_pipeline.sh — Full StreamHub audio pipeline: build → services → k6 → quality → report
#
# Topology:
#   k6 sender  ──(WS)──────────────────► StreamHub :WS_PORT
#   StreamHub  ──(gRPC PushAudio)──────► Bridge    :BRIDGE_PORT
#   k6 receiver ◄──(gRPC ReceiveAudio)── Bridge    :BRIDGE_PORT
#
# Usage (from the streamhub-demo/ repo root):
#   bash run_pipeline.sh
#   bash run_pipeline.sh --record
#   bash run_pipeline.sh --k6-only --record=recordings
#
# Options:
#   --ws-port=PORT     StreamHub WebSocket port       (default: 8765)
#   --bridge-port=PORT Bridge gRPC port               (default: 50052)
#   --chunk-ms=N       Audio chunk interval ms        (default: 20)
#   --max-vus=N        Peak load VUs (ramp shape is auto-generated) (default: 500)
#   --ramp-duration=T  k6 duration per ramp stage        (default: 1m)
#   --stable-duration=T k6 stable peak stage duration    (default: 3m)
#   --audio=PATH       WAV file (relative to repo root) (default: data/best_16k.wav)
#   --wait-s=N         Bridge session wait timeout    (default: 10)
#   --record[=DIR]     Record sessions to DIR         (default: recordings/)
#   --quality-only=DIR Skip pipeline; run quality check on DIR
#   --k6-only          Skip build+services; run k6+quality+report against running services
#   --no-k6            Start services but skip k6/quality/report

set -euo pipefail

# ─── Paths (streamhub-demo/ is the repo root) ─────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GO_DIR="$SCRIPT_DIR/go"

# ─── Defaults ──────────────────────────────────────────────────────────────────
WS_PORT=8765
BRIDGE_PORT=50052
CHUNK_MS=20
MAX_VUS=500
RAMP_DURATION="1m"
STABLE_DURATION="3m"
AUDIO_FILE="data/best_16k.wav"
WAIT_S=10
K6_ONLY=false
NO_K6=false
RECORD_DIR=""

# ─── Parse args ────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --ws-port=*)      WS_PORT="${arg#*=}"      ;;
    --bridge-port=*)  BRIDGE_PORT="${arg#*=}"  ;;
    --chunk-ms=*)     CHUNK_MS="${arg#*=}"     ;;
    --max-vus=*)      MAX_VUS="${arg#*=}"      ;;
    --ramp-duration=*)   RAMP_DURATION="${arg#*=}"   ;;
    --stable-duration=*) STABLE_DURATION="${arg#*=}" ;;
    --audio=*)        AUDIO_FILE="${arg#*=}"   ;;
    --wait-s=*)       WAIT_S="${arg#*=}"       ;;
    --record)         RECORD_DIR="$SCRIPT_DIR/recordings" ;;
    --record=*)       RECORD_DIR="${arg#*=}"   ;;
    --quality-only=*) RECORD_DIR="${arg#*=}"; K6_ONLY=true; NO_K6=true ;;
    --k6-only)        K6_ONLY=true             ;;
    --no-k6)          NO_K6=true               ;;
    *) echo "Unknown option: $arg"; exit 1     ;;
  esac
done

# ─── Timestamped results directory ─────────────────────────────────────────────
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
RESULTS_DIR="$SCRIPT_DIR/results/$TIMESTAMP"
mkdir -p "$RESULTS_DIR"

# ─── Cleanup on exit ───────────────────────────────────────────────────────────
PIDS=()
cleanup() {
  echo ""
  echo "==> Shutting down..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  # Always symlink results/latest to this run
  ln -sfn "$RESULTS_DIR" "$SCRIPT_DIR/results/latest" 2>/dev/null || true
  echo "==> Results → $RESULTS_DIR"
  echo "==> Latest  → $SCRIPT_DIR/results/latest"
}
trap cleanup EXIT INT TERM

# ─── Helpers ───────────────────────────────────────────────────────────────────
check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' not found. $2"; exit 1
  fi
}

wait_for_port() {
  local name="$1" port="$2" timeout=15 i=0
  echo -n "==> Waiting for $name on :$port"
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    sleep 0.5; i=$((i+1)); echo -n "."
    if [[ $i -ge $((timeout * 2)) ]]; then
      echo " TIMEOUT"; echo "ERROR: $name did not start within ${timeout}s"; exit 1
    fi
  done
  echo " ready"
}

# ─── Python virtual environment ────────────────────────────────────────────────
VENV="$SCRIPT_DIR/.venv"
if [[ ! -d "$VENV" ]]; then
  echo "==> Creating Python virtual environment..."
  python3 -m venv "$VENV"
fi
PYTHON="$VENV/bin/python"
PIP="$VENV/bin/pip"
echo "==> Installing Python dependencies..."
"$PIP" install -q -r "$SCRIPT_DIR/scripts/requirements.txt"

# ─── k6 auto-install ───────────────────────────────────────────────────────────
if ! command -v k6 &>/dev/null; then
  echo "==> k6 not found — installing..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install grafana/tap/k6
  elif command -v apt-get &>/dev/null; then
    sudo gpg --no-default-keyring \
      --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
      --keyserver hkp://keyserver.ubuntu.com:80 \
      --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
    echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] \
      https://dl.k6.io/deb stable main" \
      | sudo tee /etc/apt/sources.list.d/k6.list
    sudo apt-get update -q && sudo apt-get install -y k6
  else
    echo "ERROR: k6 not found. See https://k6.io/docs/get-started/installation/"
    exit 1
  fi
fi

# ─── Preflight ─────────────────────────────────────────────────────────────────
check_cmd go  "Install Go from https://go.dev/dl/"
check_cmd nc  "Install netcat (should be available on macOS/Linux)"

if [[ ! -f "$SCRIPT_DIR/$AUDIO_FILE" ]]; then
  echo "ERROR: Audio file not found: $SCRIPT_DIR/$AUDIO_FILE"; exit 1
fi

# ─── Build ─────────────────────────────────────────────────────────────────────
if [[ "$K6_ONLY" == false ]]; then
  echo "==> Building Go binaries..."
  cd "$GO_DIR"
  if [[ ! -f pb/audio_forward.pb.go ]] || \
     [[ pb/audio_forward.pb.go -ot "$SCRIPT_DIR/proto/audio_forward.proto" ]]; then
    echo "    Generating proto stubs..."
    bash generate_proto.sh
  fi
  go mod tidy -e
  go build -o bin/bridge     ./cmd/bridge
  go build -o bin/streamhub  ./cmd/streamhub
  echo "    Built: bin/bridge  bin/streamhub"
  cd "$SCRIPT_DIR"
fi

# ─── Start services ────────────────────────────────────────────────────────────
if [[ "$K6_ONLY" == false ]]; then
  echo "==> Starting Bridge on :$BRIDGE_PORT..."
  BRIDGE_ARGS=(--port="$BRIDGE_PORT" --stats-out="$RESULTS_DIR/e2e_latency.json")
  if [[ -n "$RECORD_DIR" ]]; then
    mkdir -p "$RECORD_DIR"
    BRIDGE_ARGS+=(--record-dir="$RECORD_DIR")
    echo "    Recording sessions → $RECORD_DIR"
  fi
  "$GO_DIR/bin/bridge" "${BRIDGE_ARGS[@]}" &
  PIDS+=($!)
  wait_for_port "Bridge" "$BRIDGE_PORT"

  echo "==> Starting StreamHub on :$WS_PORT → Bridge :$BRIDGE_PORT..."
  "$GO_DIR/bin/streamhub" \
    --ws-port="$WS_PORT" \
    --bridge-addr="127.0.0.1:$BRIDGE_PORT" &
  PIDS+=($!)
  wait_for_port "StreamHub" "$WS_PORT"
fi

# ─── k6 ────────────────────────────────────────────────────────────────────────
if [[ "$NO_K6" == false ]]; then
  echo "==> Running k6  max_vus=$MAX_VUS  ramp=$RAMP_DURATION  stable=$STABLE_DURATION  chunk_ms=$CHUNK_MS  audio=$AUDIO_FILE"
  echo "──────────────────────────────────────────────────────────────────"
  cd "$SCRIPT_DIR"
  # k6 open() resolves AUDIO_FILE relative to the script file, not CWD.
  # Pass an absolute path so it works regardless of where k6 is invoked from.
  K6_AUDIO_FILE="$SCRIPT_DIR/$AUDIO_FILE"
  k6 run \
    --summary-export "$RESULTS_DIR/k6_summary.json" \
    --env WS_URL="ws://127.0.0.1:$WS_PORT" \
    --env AUDIO_FILE="$K6_AUDIO_FILE" \
    --env CHUNK_MS="$CHUNK_MS" \
    --env MAX_VUS="$MAX_VUS" \
    --env RAMP_DURATION="$RAMP_DURATION" \
    --env STABLE_DURATION="$STABLE_DURATION" \
    tests/k6/k6_audio_pipeline.js
  echo ""


  # ── Quality check ───────────────────────────────────────────────────────────
  if [[ -n "$RECORD_DIR" ]]; then
    echo "==> Quality check  ref=$AUDIO_FILE  rec-dir=$RECORD_DIR"
    echo "──────────────────────────────────────────────────────────────────"
    cd "$SCRIPT_DIR"

    # Machine-readable JSON (for report)
    "$PYTHON" scripts/quality_check.py \
      --ref "$SCRIPT_DIR/$AUDIO_FILE" \
      --rec-dir "$RECORD_DIR" \
      --json > "$RESULTS_DIR/quality.json" 2> "$RESULTS_DIR/quality.log" || true

    # Human-readable table to stdout
    "$PYTHON" scripts/quality_check.py \
      --ref "$SCRIPT_DIR/$AUDIO_FILE" \
      --rec-dir "$RECORD_DIR" || true
    echo ""
  fi

  # ── HTML report ─────────────────────────────────────────────────────────────
  echo "==> Generating HTML report..."
  QUALITY_ARG=""
  if [[ -s "$RESULTS_DIR/quality.json" ]]; then
    QUALITY_ARG="--quality $RESULTS_DIR/quality.json"
  fi
  K6_ARG=""
  if [[ -f "$RESULTS_DIR/k6_summary.json" ]]; then
    K6_ARG="--k6-summary $RESULTS_DIR/k6_summary.json"
  fi
  cd "$SCRIPT_DIR"
  # shellcheck disable=SC2086
  "$PYTHON" scripts/report.py \
    $K6_ARG \
    $QUALITY_ARG \
    --e2e-summary "$RESULTS_DIR/e2e_latency.json" \
    --out "$RESULTS_DIR/report.html"

else
  echo ""
  echo "==> Services running. Press Ctrl+C to stop."
  wait
fi
