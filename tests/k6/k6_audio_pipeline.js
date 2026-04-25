/**
 * k6_audio_pipeline.js — StreamHub audio pipeline load test
 *
 * ── Topology ──────────────────────────────────────────────────────────────────
 *   k6 sender  ──(WS binary, K6TS header)──► StreamHub :8765
 *   StreamHub  ──(gRPC PushAudio, raw)──────► Bridge    :50052
 *   Bridge extracts K6TS timestamp and computes end-to-end latency.
 *
 * ── Load shape (controlled by MAX_VUS, default 500) ──────────────────────────
 *               1 min  ramp  0      → 20% of MAX_VUS
 *               1 min  ramp  20%    → 50% of MAX_VUS
 *               1 min  ramp  50%    → MAX_VUS (peak)
 *               3 min  stable       MAX_VUS
 *               1 min  ramp  MAX_VUS → 50%
 *               1 min  ramp  50%    → 20%
 *               1 min  ramp  20%    → 0
 *
 * ── Usage (from repo root) ────────────────────────────────────────────────────
 *   k6 run tests/k6/k6_audio_pipeline.js
 *
 * ── Configuration (--env) ─────────────────────────────────────────────────────
 *   WS_URL            StreamHub WebSocket URL   (default: ws://127.0.0.1:8765)
 *   AUDIO_FILE        WAV file path             (default: ../../data/best_16k.wav)
 *                     Paths are relative to the script file (tests/k6/), not CWD.
 *   CHUNK_MS          Chunk interval ms         (default: 20)
 *   MAX_VUS           Peak / stable VU count for load phase (default: 500)
 *                     Ramp breakpoints are auto-generated at 20%, 50%, 100%.
 *   RAMP_DURATION     Duration of each ramp stage        (default: 1m)
 *   STABLE_DURATION   Duration of stable peak stage       (default: 3m)
 */

import ws                    from "k6/ws";
import { check }             from "k6";
import { Trend, Rate }       from "k6/metrics";
import exec                  from "k6/execution";

// ─── Configuration ─────────────────────────────────────────────────────────────
const WS_URL           = __ENV.WS_URL           || "ws://127.0.0.1:8765";
const AUDIO_FILE       = __ENV.AUDIO_FILE       || "../../data/best_16k.wav";
const CHUNK_MS         = parseInt(__ENV.CHUNK_MS  || "20",  10);
const MAX_VUS          = parseInt(__ENV.MAX_VUS        || "500", 10);
const RAMP_DURATION    = __ENV.RAMP_DURATION   || "1m";
const STABLE_DURATION  = __ENV.STABLE_DURATION || "3m";
const DEBUG            = __ENV.DEBUG === "1";

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
const EXPECTED_PKTS = Math.ceil(wav.dataSize / CHUNK_BYTES);

if (__VU === 0) {
  console.log(
    `WAV: ${AUDIO_FILE}  ${wav.sampleRate} Hz  ch=${wav.channels}` +
    `  ${DURATION_S.toFixed(1)} s  chunk=${CHUNK_BYTES} B @ ${CHUNK_MS} ms` +
    `  expected_pkts=${EXPECTED_PKTS}`
  );
  console.log(`gRPC receiver → ${BRIDGE_GRPC_ADDR}  WS sender → ${WS_URL}`);
}

// ─── Timing ────────────────────────────────────────────────────────────────────
// How long one full audio session lasts (audio duration + margin for WS teardown).
const SESSION_LIFE_S = Math.ceil(DURATION_S + 30);

// Ramp schedule — generated from MAX_VUS.
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

if (__VU === 0) {
  console.log(
    `Load profile (MAX_VUS=${MAX_VUS}): ` +
    LOAD_STAGES.map((s) => `${s.duration}→${s.target}`).join("  ")
  );
}

// Allow in-flight sessions to finish naturally during ramp-down / scenario end.
const GRACEFUL_S = SESSION_LIFE_S + "s";

// ─── k6 options ────────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    load_sender: {
      executor:         "ramping-vus",
      exec:             "sendAudio",
      startTime:        "0s",
      stages:           LOAD_STAGES,
      gracefulRampDown: GRACEFUL_S,
      gracefulStop:     GRACEFUL_S,
      tags:             { phase: "load" },
    },
  },

  thresholds: {
    fwd_ws_ok:         ["rate>0.99"],  // ≥99% WS connections succeed
    fwd_ws_conn_ms:    ["p(95)<3000"],// WS handshake p95 < 3 s
  },
};

// ─── Custom metrics ────────────────────────────────────────────────────────────
const wsConnMs = new Trend("fwd_ws_conn_ms", true);
const wsOk     = new Rate("fwd_ws_ok");

function stampBinaryFrame(pcmBuf) {
  const pcm = new Uint8Array(pcmBuf);
  const frame = new Uint8Array(12 + pcm.length);
  frame[0] = 75; // K
  frame[1] = 54; // 6
  frame[2] = 84; // T
  frame[3] = 83; // S
  let tsUs = BigInt(Date.now()) * 1000n;
  for (let i = 0; i < 8; i++) {
    frame[4 + i] = Number((tsUs >> BigInt(8 * i)) & 0xffn);
  }
  frame.set(pcm, 12);
  return frame.buffer;
}

// ─── Session ID ────────────────────────────────────────────────────────────────
// Each VU runs one long-lived iteration. Use the test-wide VU id as the session
// suffix so concurrent senders don't collapse onto the same Bridge session.
function sessionId() {
  return `ld-${exec.vu.idInTest - 1}`;
}

// ─── (removed: receiveAudio — latency is now measured inside Bridge) ────────── //
// Placeholder to keep the export visible to the linter. Not used in any scenario.
export function receiveAudio() {}

// ─── Scenario: sendAudio ──────────────────────────────────────────────────────
// Used by both load_receiver and load_sender (sendAudio).
// Connects to StreamHub via WebSocket and streams the reference WAV file.

export function sendAudio() {
  const sid    = sessionId();
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
        socket.sendBinary(stampBinaryFrame(wavBuffer.slice(offset, end)));
        offset = end;
      }, CHUNK_MS);
    });

    socket.on("error", (err) => console.error(`[load][${sid}] WS error: ${err}`));
    socket.on("close", ()    => console.log(`[load][${sid}] WS closed`));
  });

  const ok = res && res.status === 101;
  wsOk.add(ok ? 1 : 0);
  check(res, { "WS connected (101)": () => ok });
}
