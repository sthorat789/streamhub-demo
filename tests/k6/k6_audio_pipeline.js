/**
 * k6_audio_pipeline.js — Two-phase StreamHub audio pipeline load test
 *
 * ── Topology ──────────────────────────────────────────────────────────────────
 *   k6 sender   ──(WebSocket binary)──────────► StreamHub  :8765
 *   StreamHub   ──(gRPC PushAudio)────────────► Bridge     :50052
 *   k6 receiver ◄──(gRPC ReceiveAudio)───────── Bridge     :50052
 *
 * ── Test phases ───────────────────────────────────────────────────────────────
 *   Phase 1 — Baseline   1 VU · 1 iteration · establishes reference values
 *   Phase 2 — Load       ramping-vus:
 *               Shape (controlled by MAX_VUS, default 500):
 *               1 min  ramp  0      → 20% of MAX_VUS
 *               1 min  ramp  20%    → 50% of MAX_VUS
 *               1 min  ramp  50%    → MAX_VUS (peak)
 *               3 min  stable       MAX_VUS
 *               1 min  ramp  MAX_VUS → 50%
 *               1 min  ramp  50%    → 20%
 *               1 min  ramp  20%    → 0
 *
 * ── Session coordination ──────────────────────────────────────────────────────
 *   session_id = "<scenario>-iter-<N>"
 *   Both receiver and sender scenarios use exec.scenario.iterationInTest as N.
 *   Since they ramp at the same rate and sender starts SENDER_START_S seconds
 *   after receiver, receiver iter N will always be waiting when sender iter N
 *   arrives (provided WAIT_S > SENDER_START_S).
 *
 * ── Usage (from repo root) ────────────────────────────────────────────────────
 *   k6 run tests/k6/k6_audio_pipeline.js
 *
 *   # or from any directory — proto path is relative to the script file
 *   k6 run /path/to/streamhub-demo/tests/k6/k6_audio_pipeline.js
 *
 * ── Configuration (--env) ─────────────────────────────────────────────────────
 *   WS_URL            StreamHub WebSocket URL   (default: ws://127.0.0.1:8765)
 *   BRIDGE_GRPC_ADDR  Bridge gRPC address       (default: 127.0.0.1:50052)
 *   AUDIO_FILE        WAV file path             (default: ../../data/best_16k.wav)
 *                     Paths are relative to the script file (tests/k6/), not CWD.
 *   CHUNK_MS          Chunk interval ms         (default: 20)
 *   WAIT_S            Bridge session wait s     (default: 10)
 *   MAX_VUS           Peak / stable VU count for load phase (default: 500)
 *                     Ramp breakpoints are auto-generated at 20%, 50%, 100%.
 *   RAMP_DURATION     Duration of each ramp stage        (default: 1m)
 *   STABLE_DURATION   Duration of stable peak stage       (default: 3m)
 */

import ws                    from "k6/ws";
import { Client, Stream }    from "k6/net/grpc";
import { check, sleep }      from "k6";
import { Counter, Trend, Rate } from "k6/metrics";
import exec                  from "k6/execution";

// ─── Configuration ─────────────────────────────────────────────────────────────
const WS_URL           = __ENV.WS_URL           || "ws://127.0.0.1:8765";
const BRIDGE_GRPC_ADDR = __ENV.BRIDGE_GRPC_ADDR || "127.0.0.1:50052";
const AUDIO_FILE       = __ENV.AUDIO_FILE       || "../../data/best_16k.wav";
const CHUNK_MS         = parseInt(__ENV.CHUNK_MS  || "20",  10);
const WAIT_S           = parseInt(__ENV.WAIT_S    || "10",  10);
const MAX_VUS          = parseInt(__ENV.MAX_VUS        || "500", 10);
const RAMP_DURATION    = __ENV.RAMP_DURATION   || "1m";
const STABLE_DURATION  = __ENV.STABLE_DURATION || "3m";

// ─── gRPC client — init context ────────────────────────────────────────────────
const grpcClient = new Client();
grpcClient.load(["../../proto"], "audio_forward.proto");
// k6 resolves load() paths relative to the script file (tests/k6/),
// so ../../proto points to proto/ at the repo root.

// ─── WAV loading & parsing — init context ──────────────────────────────────────
const wavBuffer = open(AUDIO_FILE, "b");

function parseWav(buf) {
  const v   = new DataView(buf);
  const tag = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (tag !== "RIFF") throw new Error("Not a WAV file: " + AUDIO_FILE);

  const channels      = v.getUint16(22, true);
  const sampleRate    = v.getUint32(24, true);
  const bitsPerSample = v.getUint16(34, true);

  let pos = 12;
  while (pos + 8 <= buf.byteLength) {
    const id = String.fromCharCode(
      v.getUint8(pos), v.getUint8(pos+1), v.getUint8(pos+2), v.getUint8(pos+3));
    const sz = v.getUint32(pos + 4, true);
    if (id === "data") return { channels, sampleRate, bitsPerSample, dataOffset: pos + 8, dataSize: sz };
    pos += 8 + sz + (sz % 2 !== 0 ? 1 : 0);
  }
  throw new Error("No 'data' chunk in " + AUDIO_FILE);
}

const wav          = parseWav(wavBuffer);
const BYTES_PER_MS = (wav.sampleRate * (wav.bitsPerSample / 8) * wav.channels) / 1000;
const CHUNK_BYTES  = Math.max(1, Math.floor(CHUNK_MS * BYTES_PER_MS));
const DURATION_S   = wav.dataSize / (BYTES_PER_MS * 1000);

console.log(
  `WAV: ${AUDIO_FILE}  ${wav.sampleRate} Hz  ch=${wav.channels}` +
  `  ${DURATION_S.toFixed(1)} s  chunk=${CHUNK_BYTES} B @ ${CHUNK_MS} ms`
);
console.log(`gRPC receiver → ${BRIDGE_GRPC_ADDR}  WS sender → ${WS_URL}`);

// ─── Timing ────────────────────────────────────────────────────────────────────
// Sender starts this many seconds after receiver (within every phase).
// Receivers register on Bridge first; senders arrive within WAIT_S.
const SENDER_START_S = 5;

// How long one full audio session lasts end-to-end.
const SESSION_LIFE_S = Math.ceil(SENDER_START_S + DURATION_S + WAIT_S + 20);

// Phase 1 (baseline) ends SESSION_LIFE_S + 30 s buffer after t=0.
const BASELINE_END_S = SESSION_LIFE_S + 30;

// Phase 2 ramp schedule — generated from MAX_VUS.
// Shape: ramp to 20% → 50% → 100% (stable 3m) → 50% → 20% → 0.
// Sender scenario starts SENDER_START_S seconds after receiver, so receiver
// VUs are always registered before the matching sender VUs connect.
function buildLoadStages(peak) {
  const p20 = Math.max(1, Math.round(peak * 0.20));
  const p50 = Math.max(1, Math.round(peak * 0.50));
  return [
    { duration: RAMP_DURATION,   target: p20  },  // ramp   0 → 20%
    { duration: RAMP_DURATION,   target: p50  },  // ramp  20% → 50%
    { duration: RAMP_DURATION,   target: peak },  // ramp  50% → peak
    { duration: STABLE_DURATION, target: peak },  // stable peak
    { duration: RAMP_DURATION,   target: p50  },  // ramp peak → 50%
    { duration: RAMP_DURATION,   target: p20  },  // ramp  50% → 20%
    { duration: RAMP_DURATION,   target: 0    },  // ramp  20% → 0
  ];
}
const LOAD_STAGES = buildLoadStages(MAX_VUS);

console.log(
  `Load profile (MAX_VUS=${MAX_VUS}): ` +
  LOAD_STAGES.map((s) => `${s.duration}→${s.target}`).join("  ")
);

// Allow in-flight sessions to finish naturally during ramp-down / scenario end.
const GRACEFUL_S = SESSION_LIFE_S + "s";

// ─── k6 options ────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {

    // ── Phase 1: Baseline — 1 VU, 1 iteration ─────────────────────────────────
    baseline_receiver: {
      executor:    "shared-iterations",
      vus:         1,
      iterations:  1,
      exec:        "receiveAudio",
      startTime:   "0s",
      maxDuration: BASELINE_END_S + "s",
      gracefulStop: GRACEFUL_S,
      tags:        { phase: "baseline" },
    },
    baseline_sender: {
      executor:    "shared-iterations",
      vus:         1,
      iterations:  1,
      exec:        "sendAudio",
      startTime:   SENDER_START_S + "s",
      maxDuration: (BASELINE_END_S - SENDER_START_S) + "s",
      gracefulStop: GRACEFUL_S,
      tags:        { phase: "baseline" },
    },

    // ── Phase 2: Load — ramping-vus ────────────────────────────────────────────
    load_receiver: {
      executor:         "ramping-vus",
      exec:             "receiveAudio",
      startTime:        BASELINE_END_S + "s",
      stages:           LOAD_STAGES,
      gracefulRampDown: GRACEFUL_S,
      gracefulStop:     GRACEFUL_S,
      tags:             { phase: "load" },
    },
    load_sender: {
      executor:         "ramping-vus",
      exec:             "sendAudio",
      startTime:        (BASELINE_END_S + SENDER_START_S) + "s",
      stages:           LOAD_STAGES,
      gracefulRampDown: GRACEFUL_S,
      gracefulStop:     GRACEFUL_S,
      tags:             { phase: "load" },
    },
  },

  thresholds: {
    // Applied across both phases; baseline values inform whether load passes.
    fwd_sess_ok:        ["rate>0.95"],
    fwd_ws_conn_ms:     ["p(95)<3000"],
    fwd_pkt_latency_ms: ["p(95)<500"],
    fwd_sess_mos:       ["avg>3.5"],
    fwd_sess_drop_pct:  ["avg<1"],
  },
};

// ─── Custom metrics ────────────────────────────────────────────────────────────
const pktLatency   = new Trend("fwd_pkt_latency_ms",    true);
const sessDropPct  = new Trend("fwd_sess_drop_pct",     true);
const sessLatMean  = new Trend("fwd_sess_lat_mean_ms",  true);
const sessLatP50   = new Trend("fwd_sess_lat_p50_ms",   true);
const sessLatP95   = new Trend("fwd_sess_lat_p95_ms",   true);
const sessLatP99   = new Trend("fwd_sess_lat_p99_ms",   true);
const sessJitter   = new Trend("fwd_sess_jitter_ms",    true);
const sessBufDelay = new Trend("fwd_sess_buf_delay_ms", true);
const sessMOS      = new Trend("fwd_sess_mos",          true);
const cntExpected  = new Counter("fwd_pkts_expected");
const cntReceived  = new Counter("fwd_pkts_received");
const cntDropped   = new Counter("fwd_pkts_dropped");
const wsConnMs     = new Trend("fwd_ws_conn_ms",        true);
const sessOk       = new Rate("fwd_sess_ok");

// ─── Session ID ────────────────────────────────────────────────────────────────
// Uses exec.scenario.iterationInTest — a per-scenario global counter that
// increments for each new iteration regardless of VU number.
// receiver iter N and sender iter N will always share the same session_id,
// enabling correct pairing on Bridge even at high VU counts.
function sessionId() {
  const prefix = exec.scenario.name.startsWith("baseline") ? "bl" : "ld";
  return `${prefix}-${exec.scenario.iterationInTest}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function percentile(sorted, pct) {
  if (!sorted.length) return 0;
  return sorted[Math.min(Math.floor(sorted.length * pct / 100), sorted.length - 1)];
}

function eModelMOS(latMs, dropFrac) {
  const Id  = latMs <= 150 ? 0 : 0.134 * (latMs - 150);
  const ppl = dropFrac * 100;
  const Ie  = ppl > 0 ? 30 * Math.log1p(15 * ppl / 100) : 0;
  const R   = Math.max(0, Math.min(93.2 - Id - Ie, 100));
  const mos = 1 + 0.035 * R + R * (R - 60) * (100 - R) * 7e-6;
  return Math.max(1, Math.min(mos, 4.5));
}

// ─── Scenario: receiveAudio ────────────────────────────────────────────────────
// Used by both baseline_receiver and load_receiver.
// Connects to Bridge gRPC, calls ReceiveAudio, computes all quality metrics.

export function receiveAudio() {
  const sid   = sessionId();
  const phase = exec.scenario.name.startsWith("baseline") ? "baseline" : "load";

  grpcClient.connect(BRIDGE_GRPC_ADDR, { plaintext: true });
  const stream = new Stream(grpcClient, "audioforward.AudioForwardService/ReceiveAudio");
  let grpcClosed = false;
  function closeGrpc() { if (!grpcClosed) { grpcClosed = true; grpcClient.close(); } }

  const latencies = [];
  let seqLast     = -1;
  let pktsDropped = 0;
  let pktsRecvd   = 0;
  let prevRecvUs  = null;
  let prevSendUs  = null;
  let jitterSum   = 0;

  stream.on("data", (pkt) => {
    // proto3 int64 arrives as a decimal string in k6's gRPC client.
    // Use BigInt for subtraction — these are 16-digit µs values that exceed
    // Number.MAX_SAFE_INTEGER, so plain parseInt loses precision → MOS=1.
    const recvUsB  = BigInt(Date.now()) * 1000n;
    const sendUsB  = BigInt(pkt.send_ts_us || "0");
    const seq      = parseInt(pkt.seq || "0", 10);

    const latMs = Number(recvUsB - sendUsB) / 1000;
    latencies.push(latMs);
    pktsRecvd++;
    pktLatency.add(latMs);

    if (seqLast >= 0 && seq > seqLast + 1) pktsDropped += seq - seqLast - 1;
    seqLast = seq;

    if (prevRecvUs !== null) {
      jitterSum += Math.abs(Number(recvUsB - prevRecvUs) - Number(sendUsB - prevSendUs));
    }
    prevRecvUs = recvUsB;
    prevSendUs = sendUsB;
  });

  stream.on("end", () => {
    if (!pktsRecvd) {
      console.error(`[${phase}][${sid}] stream ended with 0 packets`);
      sessOk.add(0);
      closeGrpc();
      return;
    }

    const pktsExpect = pktsDropped + pktsRecvd;
    const dropFrac   = pktsExpect > 0 ? pktsDropped / pktsExpect : 0;
    const sorted     = latencies.slice().sort((a, b) => a - b);
    const latMean    = latencies.reduce((s, v) => s + v, 0) / latencies.length;
    const p50        = percentile(sorted, 50);
    const p95        = percentile(sorted, 95);
    const p99        = percentile(sorted, 99);
    const jitterMs   = pktsRecvd > 1 ? jitterSum / (pktsRecvd - 1) / 1000 : 0;
    const mos        = eModelMOS(latMean, dropFrac);

    cntExpected.add(pktsExpect);
    cntReceived.add(pktsRecvd);
    cntDropped.add(pktsDropped);
    sessDropPct.add(dropFrac * 100);
    sessLatMean.add(latMean);
    sessLatP50.add(p50);
    sessLatP95.add(p95);
    sessLatP99.add(p99);
    sessJitter.add(jitterMs);
    sessBufDelay.add(p95 - p50);
    sessMOS.add(mos);
    sessOk.add(1);

    console.log(
      `[${phase}][${sid}] pkts=${pktsRecvd}  drop=${(dropFrac*100).toFixed(2)}%` +
      `  lat_mean=${latMean.toFixed(1)}ms  lat_p95=${p95.toFixed(1)}ms` +
      `  jitter=${jitterMs.toFixed(1)}ms  buf_delay=${(p95-p50).toFixed(1)}ms` +
      `  MOS=${mos.toFixed(2)}`
    );

    closeGrpc();
  });

  stream.on("error", (err) => {
    console.error(`[${phase}][${sid}] gRPC error: ${err.message || JSON.stringify(err)}`);
    sessOk.add(0);
    closeGrpc();
  });

  stream.write({ session_id: sid, wait_s: WAIT_S });
  sleep(SESSION_LIFE_S);
}

// ─── Scenario: sendAudio ──────────────────────────────────────────────────────
// Used by both baseline_sender and load_sender.
// Connects to StreamHub via WebSocket and streams the reference WAV file.

export function sendAudio() {
  const sid    = sessionId();
  const phase  = exec.scenario.name.startsWith("baseline") ? "baseline" : "load";
  const tStart = Date.now();

  const res = ws.connect(WS_URL, {}, (socket) => {
    wsConnMs.add(Date.now() - tStart);

    socket.on("open", () => {
      socket.send(JSON.stringify({
        session_id:  sid,
        sample_rate: wav.sampleRate,
        channels:    wav.channels,
        chunk_ms:    CHUNK_MS,
      }));

      let offset    = wav.dataOffset;
      const dataEnd = wav.dataOffset + wav.dataSize;
      let done      = false;

      socket.setInterval(() => {
        if (done) return;
        if (offset >= dataEnd) {
          done = true;
          socket.setTimeout(() => socket.close(), 1500);
          return;
        }
        const end = Math.min(offset + CHUNK_BYTES, dataEnd);
        socket.sendBinary(wavBuffer.slice(offset, end));
        offset = end;
      }, CHUNK_MS);
    });

    socket.on("error", (err) => console.error(`[${phase}][${sid}] WS error: ${err}`));
    socket.on("close", ()    => console.log(`[${phase}][${sid}] WS closed`));
  });

  check(res, { "WS connected (101)": (r) => r && r.status === 101 });
}
