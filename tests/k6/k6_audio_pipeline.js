/**
 * k6_audio_pipeline.js — StreamHub audio pipeline load test
 *
 * ── Topology ──────────────────────────────────────────────────────────────────
 *   k6 sender   ──(WebSocket binary)──────────► StreamHub  :8765
 *   StreamHub   ──(gRPC PushAudio)────────────► Bridge     :50052
 *   k6 receiver ◄──(gRPC ReceiveAudio)───────── Bridge     :50052
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
const DEBUG            = __ENV.DEBUG === "1";

// ─── gRPC client — init context (load() must run here; each VU gets its own copy) ─
// k6 global variables are per-VU: each VU initialises its own grpcClient.
// connect()/close() are called per-iteration inside receiveAudio().
const grpcClient = new Client();
grpcClient.load(["../../proto"], "audio_forward.proto");

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
// Sender starts this many seconds after receiver (within every phase).
// Receivers register on Bridge first; senders arrive within WAIT_S.
const SENDER_START_S = 5;

// How long one full audio session lasts end-to-end.
const SESSION_LIFE_S = Math.ceil(SENDER_START_S + DURATION_S + WAIT_S + 20);

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
// Accurate StreamHub→Bridge latency: recv_ts_us - send_ts_us, both set in Go.
const bridgeLatency = new Trend("fwd_bridge_latency_ms", true);
// Jitter: RFC 3550 smoothed IPDV per session (µs → ms). High jitter with low
// drop = StreamHub→Bridge spacing is irregular (jitter buffer required).
const sessJitter    = new Trend("fwd_sess_jitter_ms",    true);
// Latency drift: mean(last-5 pkts) − mean(first-5 pkts) per session.
// Positive drift = pipeline is accumulating delay (StreamHub/Bridge buffering).
// Near-zero drift + high drop = StreamHub dropping/corrupting, not buffering.
const sessLatDrift  = new Trend("fwd_sess_lat_drift_ms", true);
// Drop rate and counters.
const sessDropPct   = new Trend("fwd_sess_drop_pct",     true);
const cntExpected   = new Counter("fwd_pkts_expected");
const cntReceived   = new Counter("fwd_pkts_received");
const cntDropped    = new Counter("fwd_pkts_dropped");
// Corruption: proto3 bytes fields arrive as base64 strings; empty = zero-length
// PCM chunk. Indicates StreamHub sent a packet with no audio payload.
const cntCorrupt    = new Counter("fwd_pkts_corrupt");
const wsConnMs      = new Trend("fwd_ws_conn_ms",        true);
const sessOk        = new Rate("fwd_sess_ok");
const wsOk          = new Rate("fwd_ws_ok");

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
// Uses exec.scenario.iterationInTest — a per-scenario global counter that
// increments for each new iteration regardless of VU number.
// receiver iter N and sender iter N will always share the same session_id,
// enabling correct pairing on Bridge even at high VU counts.
function sessionId() {
  return `ld-${exec.scenario.iterationInTest}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────



// ─── Scenario: receiveAudio ────────────────────────────────────────────────────
// Used by both load_receiver and load_sender.
// Connects to Bridge gRPC, calls ReceiveAudio, computes all quality metrics.

export function receiveAudio() {
  const sid = sessionId();

  // grpcClient is per-VU (k6 gives each VU its own copy of globals).
  // connect()/close() are called per-iteration; load() runs in init context.
  grpcClient.connect(BRIDGE_GRPC_ADDR, { plaintext: true });
  const stream = new Stream(grpcClient, "audioforward.AudioForwardService/ReceiveAudio");
  let grpcClosed = false;
  function closeGrpc() { if (!grpcClosed) { grpcClosed = true; grpcClient.close(); } }

  let seqLast     = -1;
  let pktsDropped = 0;
  let pktsRecvd   = 0;
  let pktsCorrupt = 0;
  let prevTransit = null; // RFC 3550 smoothed jitter state
  let jitter      = 0;    // running smoothed IPDV in µs
  let streamEnded = false;

  // Latency drift: compare mean of first-5 vs last-5 packet latencies.
  // Positive drift  → pipeline accumulating delay (StreamHub/Bridge buffering).
  // Near-zero drift + drops → StreamHub dropping/corrupting upstream, not buffering.
  const DRIFT_N   = 5;
  const earlyLats = []; // first DRIFT_N latency samples
  const lateLats  = new Array(DRIFT_N); // circular buffer for last DRIFT_N
  let   lateIdx   = 0;

  stream.on("data", (pkt) => {
    // proto3 JSON lowerCamelCase: send_ts_us → sendTsUs, recv_ts_us → recvTsUs.
    const rawSendTs = pkt.sendTsUs;
    const rawRecvTs = pkt.recvTsUs;
    const seq       = parseInt(pkt.seq || "0", 10);

    // Sequence-gap drop detection (reliable: no timestamp required).
    if (seqLast >= 0 && seq > seqLast + 1) pktsDropped += seq - seqLast - 1;
    seqLast = seq;
    pktsRecvd++;

    // Corruption probe: proto3 bytes → base64 string in k6 gRPC.
    // Empty string = StreamHub sent a zero-length PCM payload (truncation/corruption).
    if (!pkt.payload || pkt.payload.length === 0) {
      pktsCorrupt++;
      cntCorrupt.add(1);
    }

    // Skip latency + jitter unless both Go-side timestamps are present.
    if (!rawSendTs || rawSendTs === "0" || rawSendTs === 0) return;
    if (!rawRecvTs || rawRecvTs === "0" || rawRecvTs === 0) return;

    const sendUs = Number(BigInt(rawSendTs));
    const recvUs = Number(BigInt(rawRecvTs));
    const latMs  = (recvUs - sendUs) / 1000;

    // Sanity-cap: skip negative (clock skew) or implausibly large values.
    if (latMs < 0 || latMs > 60_000) return;

    bridgeLatency.add(latMs);

    // Drift tracking.
    if (earlyLats.length < DRIFT_N) earlyLats.push(latMs);
    lateLats[lateIdx % DRIFT_N] = latMs;
    lateIdx++;

    // RFC 3550 §A.8 smoothed IPDV: J += (|D| − J) / 16
    const transit = recvUs - sendUs;
    if (prevTransit !== null) {
      const d = Math.abs(transit - prevTransit);
      jitter += (d - jitter) / 16;
    }
    prevTransit = transit;
  });

  stream.on("end", () => {
    streamEnded = true;
  });

  stream.on("error", (err) => {
    console.error(`[${sid}] gRPC error: ${err.message || JSON.stringify(err)}`);
    streamEnded = true;
  });

  stream.write({ session_id: sid, wait_s: WAIT_S });
  stream.end(); // half-close — correct for server-streaming RPCs

  // Poll in 50 ms ticks until "end"/"error" fires or SESSION_LIFE_S expires.
  const deadline = Date.now() + SESSION_LIFE_S * 1000;
  while (!streamEnded && Date.now() < deadline) { sleep(0.05); }

  // Fetch exact server-side packet counts before closing the client.
  let stats = null;
  try {
    stats = grpcClient.invoke("audioforward.AudioForwardService/GetSessionStats", {
      session_id: sid,
    }).message;
  } catch (err) {
    if (DEBUG && exec.vu.idInTest <= 3) {
      console.log(`[${sid}] GetSessionStats failed: ${err.message || JSON.stringify(err)}`);
    }
  }

  // Close then drain buffered async callbacks until packet count stabilizes.
  closeGrpc();
  let stableTicks = 0;
  let lastPktsRecvd = -1;
  const drainDeadline = Date.now() + 2000;
  while (Date.now() < drainDeadline && stableTicks < 5) {
    sleep(0.05);
    if (pktsRecvd === lastPktsRecvd) {
      stableTicks++;
    } else {
      lastPktsRecvd = pktsRecvd;
      stableTicks = 0;
    }
  }

  const statsRecv = stats ? Number(stats.packetsReceived || 0) : pktsRecvd;
  const statsDrop = stats ? Number(stats.packetsDropped || 0) : pktsDropped;
  const pktsExpect = statsRecv + statsDrop;
  const dropFrac   = pktsExpect > 0 ? statsDrop / pktsExpect : 0;
  const sessPassed = statsRecv === EXPECTED_PKTS && statsDrop === 0 && pktsCorrupt === 0;
  sessOk.add(sessPassed ? 1 : 0);

  cntExpected.add(pktsExpect);
  cntReceived.add(statsRecv);
  cntDropped.add(statsDrop);
  sessDropPct.add(dropFrac * 100);

  if (pktsRecvd > 0) {
    const jitterMs   = jitter / 1000;
    const mean      = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const earlyMean = earlyLats.length ? mean(earlyLats) : 0;
    const lateSlice = lateLats.slice(0, Math.min(lateIdx, DRIFT_N)).filter((v) => v !== undefined);
    const lateMean  = lateSlice.length ? mean(lateSlice) : 0;
    const drift     = lateMean - earlyMean;

    sessJitter.add(jitterMs);
    sessLatDrift.add(drift);

    if (DEBUG && exec.vu.idInTest <= 3) {
      const hint = drift > 20 ? "DELAY" : dropFrac > 0.01 ? "DROP/CORRUPT" : "OK";
      console.log(
	        `[${sid}] pkts=${statsRecv}/${EXPECTED_PKTS}  drop=${(dropFrac*100).toFixed(2)}%` +
        `  corrupt=${pktsCorrupt}  jitter=${jitterMs.toFixed(1)}ms` +
        `  drift=${drift.toFixed(1)}ms  ok=${sessPassed}  [${hint}]`
      );
    }
  } else if (DEBUG && exec.vu.idInTest <= 3) {
	    console.log(`[${sid}] pkts=${statsRecv}/${EXPECTED_PKTS}  ok=${sessPassed}  [NO_DATA]`);
  }
}

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
