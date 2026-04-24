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

if (__VU === 0) {
  console.log(
    `WAV: ${AUDIO_FILE}  ${wav.sampleRate} Hz  ch=${wav.channels}` +
    `  ${DURATION_S.toFixed(1)} s  chunk=${CHUNK_BYTES} B @ ${CHUNK_MS} ms`
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

    // ── Load — ramping-vus ────────────────────────────────────────────────────
    load_receiver: {
      executor:         "ramping-vus",
      exec:             "receiveAudio",
      startTime:        "0s",
      stages:           LOAD_STAGES,
      gracefulRampDown: GRACEFUL_S,
      gracefulStop:     GRACEFUL_S,
      tags:             { phase: "load" },
    },
    load_sender: {
      executor:         "ramping-vus",
      exec:             "sendAudio",
      startTime:        SENDER_START_S + "s",
      stages:           LOAD_STAGES,
      gracefulRampDown: GRACEFUL_S,
      gracefulStop:     GRACEFUL_S,
      tags:             { phase: "load" },
    },
  },

  thresholds: {
    // Reliable metrics — do not depend on per-packet Date.now() accuracy.
    fwd_sess_ok:       ["rate>0.95"],   // sessions that received all packets
    fwd_ws_ok:         ["rate>0.99"],   // WebSocket connection success
    fwd_ws_conn_ms:    ["p(95)<3000"],  // WS handshake time
    fwd_sess_drop_pct: ["avg<1"],       // packet sequence drop %
    // Latency metrics: callbacks fire every 50 ms (polling tick), so
    // Date.now() is accurate to ±50 ms — suitable for p95 gating.
    fwd_pkt_latency_ms: ["p(95)<500"],  // end-to-end pipeline p95 < 500 ms
  },
};

// ─── Custom metrics ────────────────────────────────────────────────────────────
// Pipeline latency: Date.now() at receiver − send_ts_us (µs) from StreamHub.
// Accurate to ±50 ms because callbacks fire every 50 ms polling tick.
const pktLatency   = new Trend("fwd_pkt_latency_ms",    true);
const firstPktMs   = new Trend("fwd_first_pkt_ms",      true);
const sessLatMean  = new Trend("fwd_sess_lat_mean_ms",  true);
const sessLatP95   = new Trend("fwd_sess_lat_p95_ms",   true);
const sessJitter   = new Trend("fwd_sess_jitter_ms",    true);
const sessMOS      = new Trend("fwd_sess_mos",          true);
// Reliable metrics (thresholded)
const sessDropPct  = new Trend("fwd_sess_drop_pct",     true);
const cntExpected  = new Counter("fwd_pkts_expected");
const cntReceived  = new Counter("fwd_pkts_received");
const cntDropped   = new Counter("fwd_pkts_dropped");
const cntNoTs      = new Counter("fwd_pkts_no_timestamp");
const wsConnMs     = new Trend("fwd_ws_conn_ms",        true);
const sessOk       = new Rate("fwd_sess_ok");
const wsOk         = new Rate("fwd_ws_ok");

// ─── Session ID ────────────────────────────────────────────────────────────────
// Uses exec.scenario.iterationInTest — a per-scenario global counter that
// increments for each new iteration regardless of VU number.
// receiver iter N and sender iter N will always share the same session_id,
// enabling correct pairing on Bridge even at high VU counts.
function sessionId() {
  return `ld-${exec.scenario.iterationInTest}`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Approximate p95 from a bucket histogram (20 buckets × 50 ms = 0–1000 ms).
// Avoids storing per-packet latencies[] array which at 500 VUs × 5588 pkts
// costs ~22 MB of GC pressure per test.
function approxP95(total, buckets) {
  const target = Math.ceil(total * 0.95);
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen >= target) return (i + 1) * 50; // return upper bound of bucket
  }
  return 1000; // all packets in last bucket (>950 ms)
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
// Used by both load_receiver and load_sender.
// Connects to Bridge gRPC, calls ReceiveAudio, computes all quality metrics.

export function receiveAudio() {
  const sid = sessionId();

  // Per-iteration connect/close: each iteration gets a fresh connection.
  // grpcClient is a per-VU global (k6 gives each VU its own copy); only
  // connect()/close() are called here to satisfy k6's init-context rule.
  grpcClient.connect(BRIDGE_GRPC_ADDR, { plaintext: true });
  const stream = new Stream(grpcClient, "audioforward.AudioForwardService/ReceiveAudio");
  let grpcClosed = false;
  function closeGrpc() { if (!grpcClosed) { grpcClosed = true; grpcClient.close(); } }
  // Bucket histogram instead of latencies[] array.
  // 20 buckets × 50 ms covers 0–1000 ms; beyond that lands in bucket 19.
  let latSum       = 0;
  const buckets    = new Array(20).fill(0);
  let seqLast      = -1;
  let pktsDropped  = 0;
  let pktsRecvd    = 0;
  let prevTransit  = null;  // RFC 3550 smoothed jitter state
  let jitter       = 0;     // running smoothed jitter in µs
  let firstPktSeen = false;
  let streamEnded  = false; // set true by "end"/"error" to exit polling loop
  const startTs    = Date.now();

  stream.on("data", (pkt) => {
    // proto3 int64 fields arrive as lowerCamelCase via proto3 JSON mapping.
    // send_ts_us → sendTsUs. k6 returns int64 as a decimal string.
    // Date.now() is accurate to ±50 ms because we poll every 50 ms (see below).
    const recvUs    = Number(BigInt(Date.now()) * 1000n);
    const rawSendTs = pkt.sendTsUs;
    const seq       = parseInt(pkt.seq || "0", 10);

    // Guard: skip packets with no StreamHub timestamp.
    // Using a "0" fallback would produce latMs ≈ Date.now() (billions of ms)
    // which poisons every Trend metric and collapses MOS to 1.0.
    if (!rawSendTs || rawSendTs === "0" || rawSendTs === 0) {
      cntNoTs.add(1);
      pktsRecvd++;
      if (seqLast >= 0 && seq > seqLast + 1) pktsDropped += seq - seqLast - 1;
      seqLast = seq;
      return;
    }
    const sendUs = Number(BigInt(rawSendTs));
    const latMs  = (recvUs - sendUs) / 1000;

    // Time-to-first-packet.
    if (!firstPktSeen) {
      firstPktSeen = true;
      firstPktMs.add(Date.now() - startTs);
    }

    // Sanity-cap: skip negative (clock skew) or implausibly large values.
    if (latMs < 0 || latMs > 60_000) {
      cntNoTs.add(1);
      return;
    }

    pktsRecvd++;
    pktLatency.add(latMs);
    latSum += latMs;
    buckets[Math.min(Math.floor(latMs / 50), 19)]++;

    if (seqLast >= 0 && seq > seqLast + 1) pktsDropped += seq - seqLast - 1;
    seqLast = seq;

    // RFC 3550 §A.8 smoothed jitter: J += (|D| − J) / 16
    const transit = recvUs - sendUs;
    if (prevTransit !== null) {
      const d = Math.abs(transit - prevTransit);
      jitter += (d - jitter) / 16;
    }
    prevTransit = transit;
  });

  stream.on("end", () => {
    if (!pktsRecvd) {
      console.error(`[load][${sid}] stream ended with 0 packets`);
      sessOk.add(0);
      closeGrpc();
      return;
    }

    const pktsExpect = pktsDropped + pktsRecvd;
    const dropFrac   = pktsExpect > 0 ? pktsDropped / pktsExpect : 0;
    // Bucket-based p95: O(20) instead of O(N log N) sort; saves memory at scale.
    const latMean    = pktsRecvd > 0 ? latSum / pktsRecvd : 0;
    const p95        = approxP95(pktsRecvd, buckets);
    // RFC 3550 smoothed jitter in µs → ms.
    const jitterMs   = jitter / 1000;
    const mos        = eModelMOS(p95 + jitterMs, dropFrac);

    cntExpected.add(pktsExpect);
    cntReceived.add(pktsRecvd);
    cntDropped.add(pktsDropped);
    sessDropPct.add(dropFrac * 100);
    sessLatMean.add(latMean);
    sessLatP95.add(p95);
    sessJitter.add(jitterMs);
    sessMOS.add(mos);
    sessOk.add(1);

    // Log only for first 3 VUs or when DEBUG=1.
    // At 500 VUs, logging every session floods CI output with ~500 lines/run.
    if (DEBUG && exec.vu.idInTest <= 3) {
      console.log(
        `[load][${sid}] pkts=${pktsRecvd}  drop=${(dropFrac*100).toFixed(2)}%` +
        `  lat_mean=${latMean.toFixed(1)}ms  lat_p95=${p95.toFixed(1)}ms` +
        `  jitter=${jitterMs.toFixed(1)}ms  MOS=${mos.toFixed(2)}`
      );
    }

    streamEnded = true;
    closeGrpc();
  });

  stream.on("error", (err) => {
    console.error(`[load][${sid}] gRPC error: ${err.message || JSON.stringify(err)}`);
    sessOk.add(0);
    streamEnded = true;
    closeGrpc();
  });

  stream.write({ session_id: sid, wait_s: WAIT_S });
  stream.end(); // half-close — correct for server-streaming RPCs

  // Poll every 50 ms so k6's event loop can fire "data" callbacks as packets
  // arrive. With a 50 ms tick, Date.now() inside each callback is accurate to
  // ±50 ms — good enough for real latency measurement. A single sleep(N) would
  // batch-fire all callbacks at once, making every timestamp identical.
  while (!streamEnded) { sleep(0.05); }
  closeGrpc(); // safety-net if stream never ended
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
        socket.sendBinary(wavBuffer.slice(offset, end));
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
