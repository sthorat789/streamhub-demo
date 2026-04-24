#!/usr/bin/env python3
"""quality_check.py — Validate that StreamHub is a transparent pass-through.

Goal
----
StreamHub must not:
  - corrupt audio bytes (bit flips, reordering, re-encoding)
  - drop audio chunks (packet loss)
  - introduce silence gaps

This script compares each Bridge-recorded WAV (what k6 received) against the
reference WAV (what k6 sent) and answers: "is the audio identical?"

It does NOT measure codec quality (PESQ/STOI) — StreamHub is not a codec.
Latency/jitter/buffer-delay are already measured live by k6.

What is checked
---------------
  integrity   Byte-exact match of PCM payload vs reference
              Any mismatch = StreamHub corrupted data in transit
  completeness % of reference audio that arrived
              < 100% = packet loss; > 100% = impossible (bug)
  drop_map    Which 1-second windows have missing chunks
              Pinpoints where in the audio drops occurred

Usage
-----
  # After running: bash run_pipeline.sh --record --vus=5
  python scripts/quality_check.py --ref data/best_16k.wav --rec-dir recordings

  python scripts/quality_check.py --ref data/best_16k.wav --rec-dir recordings --json
  python scripts/quality_check.py --ref data/best_16k.wav --rec-dir recordings --fail-fast

Install
-------
  pip install soundfile   (optional, faster WAV load; stdlib wave used as fallback)
"""

import argparse
import glob
import json
import os
import sys
import wave

import numpy as np


# ─── WAV I/O ───────────────────────────────────────────────────────────────────

def load_pcm_bytes(path: str) -> tuple[bytes, int, int, int]:
    """Return (raw_pcm_bytes, sample_rate, channels, bits_per_sample)."""
    with wave.open(path, "rb") as w:
        sr   = w.getframerate()
        ch   = w.getnchannels()
        bps  = w.getsampwidth() * 8
        data = w.readframes(w.getnframes())
    return data, sr, ch, bps


# ─── Per-session validation ────────────────────────────────────────────────────

def validate(ref_pcm: bytes, ref_sr: int, ref_ch: int,
             rec_path: str) -> dict:
    result = {"session": os.path.splitext(os.path.basename(rec_path))[0]}

    try:
        rec_pcm, rec_sr, rec_ch, _ = load_pcm_bytes(rec_path)
    except Exception as exc:
        result["error"] = str(exc)
        return result

    # Sample format must match — if not, StreamHub changed the format
    if rec_sr != ref_sr or rec_ch != ref_ch:
        result["error"] = (
            f"format mismatch: ref={ref_sr}Hz/{ref_ch}ch "
            f"rec={rec_sr}Hz/{rec_ch}ch"
        )
        return result

    ref_len = len(ref_pcm)
    rec_len = len(rec_pcm)

    # ── Completeness ──────────────────────────────────────────────────────────
    completeness_pct = round(100.0 * rec_len / ref_len, 2) if ref_len > 0 else 0.0
    lost_pct         = round(max(0.0, 100.0 - completeness_pct), 2)
    result["ref_bytes"]        = ref_len
    result["rec_bytes"]        = rec_len
    result["completeness_pct"] = completeness_pct
    result["lost_pct"]         = lost_pct

    # ── Byte integrity (only on bytes that arrived) ───────────────────────────
    cmp_len = min(ref_len, rec_len)
    ref_arr = np.frombuffer(ref_pcm[:cmp_len], dtype=np.uint8)
    rec_arr = np.frombuffer(rec_pcm[:cmp_len], dtype=np.uint8)

    diff       = ref_arr != rec_arr
    bad_bytes  = int(diff.sum())
    integrity  = bad_bytes == 0
    result["corrupted_bytes"] = bad_bytes
    result["integrity_ok"]    = integrity

    # ── Drop map — which 1-second windows have data missing ──────────────────
    bytes_per_sec = ref_sr * ref_ch * 2  # 16-bit PCM
    n_windows     = max(1, (ref_len + bytes_per_sec - 1) // bytes_per_sec)
    drop_windows  = []

    for i in range(n_windows):
        start = i * bytes_per_sec
        end   = min(start + bytes_per_sec, ref_len)
        # window is "dropped" if we have no recorded bytes for that range
        if start >= rec_len:
            drop_windows.append(i)

    result["duration_s"]    = round(ref_len / bytes_per_sec, 1)
    result["received_s"]    = round(rec_len / bytes_per_sec, 1)
    result["drop_windows_s"] = drop_windows  # list of 1s windows with full loss

    # ── Pass / fail ───────────────────────────────────────────────────────────
    result["pass"] = (
        integrity
        and lost_pct    < THRESHOLD_LOST_PCT
        and bad_bytes   == 0
    )

    return result


# ─── Thresholds ────────────────────────────────────────────────────────────────

THRESHOLD_LOST_PCT = 1.0   # > 1% audio loss = fail


# ─── Output ────────────────────────────────────────────────────────────────────

def print_table(results: list):
    hdr = (
        f"\n{'Session':<28} {'Complete%':>9} {'Lost%':>6} "
        f"{'Corrupt B':>10} {'Integrity':>9} {'Result':>6}"
    )
    sep = "─" * len(hdr.lstrip())
    print(hdr)
    print(sep)

    for r in results:
        sess = r["session"][:28]
        if "error" in r:
            print(f"{sess:<28}  ERROR: {r['error']}")
            continue
        ok = "PASS" if r["pass"] else "FAIL"
        print(
            f"{sess:<28}"
            f" {r['completeness_pct']:>9.2f}"
            f" {r['lost_pct']:>6.2f}"
            f" {r['corrupted_bytes']:>10}"
            f" {'OK' if r['integrity_ok'] else 'FAIL':>9}"
            f" {ok:>6}"
        )
        if r["drop_windows_s"]:
            wins = r["drop_windows_s"]
            if len(wins) <= 10:
                spans = ", ".join(f"{w}s" for w in wins)
            else:
                spans = ", ".join(f"{w}s" for w in wins[:10]) + f" ... (+{len(wins)-10} more)"
            print(f"  {'':28}  drop windows: [{spans}]")

    print(sep)
    passed = sum(1 for r in results if r.get("pass"))
    total  = sum(1 for r in results if "error" not in r)
    print(f"\n{passed}/{total} sessions passed")
    print(
        f"Thresholds: audio_loss < {THRESHOLD_LOST_PCT}%  |  zero byte corruption\n"
    )


# ─── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="Pass-through integrity check: byte correctness + completeness"
    )
    ap.add_argument("--ref",       required=True, help="Reference (original) WAV")
    ap.add_argument("--rec-dir",   required=True, help="Directory of Bridge-recorded WAVs")
    ap.add_argument("--session",   default=None,  help="Validate one session only")
    ap.add_argument("--json",      action="store_true")
    ap.add_argument("--fail-fast", action="store_true", help="Exit 1 if any session fails")
    args = ap.parse_args()

    if not os.path.isfile(args.ref):
        print(f"ERROR: reference not found: {args.ref}", file=sys.stderr)
        sys.exit(1)
    if not os.path.isdir(args.rec_dir):
        print(f"ERROR: rec-dir not found: {args.rec_dir}", file=sys.stderr)
        sys.exit(1)

    ref_pcm, ref_sr, ref_ch, ref_bps = load_pcm_bytes(args.ref)
    if not args.json:
        print(
            f"\nReference: {args.ref}  "
            f"{ref_sr} Hz  {ref_ch}ch  {ref_bps}-bit  "
            f"{len(ref_pcm)/(ref_sr*ref_ch*2):.1f}s"
        )

    pattern = (
        os.path.join(args.rec_dir, f"*{args.session}*.wav")
        if args.session else
        os.path.join(args.rec_dir, "*.wav")
    )
    files = sorted(glob.glob(pattern))
    if not files:
        print(f"No WAV files found: {pattern}", file=sys.stderr)
        sys.exit(1)

    if not args.json:
        print(f"Sessions to validate: {len(files)}")

    results = [validate(ref_pcm, ref_sr, ref_ch, f) for f in files]

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print_table(results)

    if args.fail_fast:
        failed = [r for r in results if not r.get("pass")]
        if failed:
            sys.exit(1)


if __name__ == "__main__":
    main()
