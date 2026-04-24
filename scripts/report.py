#!/usr/bin/env python3
"""report.py — Generate a self-contained HTML report from k6 + quality results.

Inputs:
  --k6-summary FILE    k6 summary JSON (from k6 run --summary-export)
  --quality FILE       quality_check.py JSON output (--json flag)
  --out FILE           output HTML path  (default: report.html alongside inputs)

Usage (from the streamhub-demo/ repo root):
  python scripts/report.py \\
      --k6-summary results/k6_summary.json \\
      --quality    results/quality.json \\
      --out        results/report.html
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone


# ─── k6 summary parsing ────────────────────────────────────────────────────────

METRIC_LABELS = {
    "fwd_pkt_latency_ms":    "Packet latency",
    "fwd_sess_lat_mean_ms":  "Session lat mean",
    "fwd_sess_lat_p50_ms":   "Session lat p50",
    "fwd_sess_lat_p95_ms":   "Session lat p95",
    "fwd_sess_lat_p99_ms":   "Session lat p99",
    "fwd_sess_jitter_ms":    "Jitter",
    "fwd_sess_buf_delay_ms": "Buffer delay (p95−p50)",
    "fwd_sess_mos":          "MOS score",
    "fwd_sess_drop_pct":     "Drop %",
    "fwd_ws_conn_ms":        "WS connect time",
    "fwd_sess_ok":           "Session success rate",
    "fwd_pkts_expected":     "Packets expected",
    "fwd_pkts_received":     "Packets received",
    "fwd_pkts_dropped":      "Packets dropped",
}


def parse_k6_summary(path: str) -> dict:
    if not path or not os.path.isfile(path):
        return {}
    with open(path) as f:
        return json.load(f)


def k6_all_thresholds_pass(summary: dict) -> bool:
    # k6 < v0.43: threshold value is {"ok": bool, ...}
    # k6 >= v0.43: threshold value is a plain bool
    for m in summary.get("metrics", {}).values():
        for thr in m.get("thresholds", {}).values():
            ok = thr.get("ok", True) if isinstance(thr, dict) else bool(thr)
            if not ok:
                return False
    return True


def fmt_val(v, decimals=2):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.{decimals}f}"
    return str(v)


def k6_rows(summary: dict) -> list[dict]:
    rows = []
    for key, label in METRIC_LABELS.items():
        m = summary.get("metrics", {}).get(key)
        if not m:
            continue
        vals = m.get("values", {})
        thresholds = m.get("thresholds", {})
        thr_ok = all(
            (t.get("ok", True) if isinstance(t, dict) else bool(t))
            for t in thresholds.values()
        )
        thr_str = " / ".join(
            f"{'\u2713' if (t.get('ok') if isinstance(t, dict) else bool(t)) else '\u2717'} {expr}"
            for expr, t in thresholds.items()
        ) if thresholds else "—"

        mtype = m.get("type", "")
        if mtype == "trend":
            rows.append({
                "label": label,
                "avg":   fmt_val(vals.get("avg")),
                "p50":   fmt_val(vals.get("med")),
                "p95":   fmt_val(vals.get("p(95)")),
                "p99":   fmt_val(vals.get("p(99)")),
                "threshold": thr_str,
                "ok": thr_ok,
            })
        elif mtype == "rate":
            rows.append({
                "label": label,
                "avg":   fmt_val(vals.get("rate", 0) * 100, 1) + "%",
                "p50":   "—",
                "p95":   "—",
                "p99":   "—",
                "threshold": thr_str,
                "ok": thr_ok,
            })
        elif mtype == "counter":
            rows.append({
                "label": label,
                "avg":   str(int(vals.get("count", 0))),
                "p50":   "—",
                "p95":   "—",
                "p99":   "—",
                "threshold": thr_str,
                "ok": thr_ok,
            })
    return rows


# ─── Quality parsing ───────────────────────────────────────────────────────────

def parse_quality(path: str) -> list[dict]:
    if not path or not os.path.isfile(path):
        return []
    with open(path) as f:
        return json.load(f)


def quality_all_pass(results: list[dict]) -> bool:
    return all(r.get("pass", False) for r in results if "error" not in r)


# ─── Chart.js data for latency ─────────────────────────────────────────────────

def latency_chart_data(summary: dict) -> str:
    labels, avg_vals, p95_vals = [], [], []
    trend_keys = [
        ("fwd_pkt_latency_ms",    "Pkt latency"),
        ("fwd_sess_lat_p50_ms",   "Sess p50"),
        ("fwd_sess_lat_p95_ms",   "Sess p95"),
        ("fwd_sess_jitter_ms",    "Jitter"),
        ("fwd_sess_buf_delay_ms", "Buf delay"),
    ]
    for key, label in trend_keys:
        m = summary.get("metrics", {}).get(key)
        if not m:
            continue
        vals = m.get("values", {})
        labels.append(label)
        avg_vals.append(round(vals.get("avg", 0), 2))
        p95_vals.append(round(vals.get("p(95)", 0), 2))
    return json.dumps({"labels": labels, "avg": avg_vals, "p95": p95_vals})


# ─── HTML template ─────────────────────────────────────────────────────────────

CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #f5f6fa; color: #2c3e50; font-size: 14px; }
.header { background: #1a1a2e; color: white; padding: 24px 32px;
          display: flex; align-items: center; gap: 16px; }
.header h1 { font-size: 22px; font-weight: 600; }
.header .sub { font-size: 12px; color: #aaa; margin-top: 4px; }
.badge { padding: 6px 16px; border-radius: 20px; font-weight: 700;
         font-size: 14px; letter-spacing: 0.5px; }
.badge.pass { background: #27ae60; color: white; }
.badge.fail { background: #e74c3c; color: white; }
.container { max-width: 1100px; margin: 32px auto; padding: 0 24px; }
.section { background: white; border-radius: 8px; margin-bottom: 24px;
           box-shadow: 0 1px 4px rgba(0,0,0,.08); overflow: hidden; }
.section-header { background: #f8f9fb; padding: 14px 20px;
                  border-bottom: 1px solid #eef0f3;
                  font-weight: 600; font-size: 13px; color: #555;
                  text-transform: uppercase; letter-spacing: 0.6px; }
table { width: 100%; border-collapse: collapse; }
th { background: #f8f9fb; padding: 10px 14px; text-align: left;
     font-weight: 600; font-size: 12px; color: #666;
     border-bottom: 2px solid #eef0f3; }
td { padding: 10px 14px; border-bottom: 1px solid #f0f2f5;
     font-size: 13px; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: #fafbfc; }
.ok   { color: #27ae60; font-weight: 600; }
.fail { color: #e74c3c; font-weight: 600; }
.mono { font-family: 'SF Mono', 'Consolas', monospace; font-size: 12px; }
.chart-wrap { padding: 20px; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr));
                gap: 16px; padding: 20px; }
.stat-card { background: #f8f9fb; border-radius: 6px; padding: 16px; }
.stat-card .val { font-size: 28px; font-weight: 700; color: #1a1a2e; }
.stat-card .lbl { font-size: 12px; color: #888; margin-top: 4px; }
"""

HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StreamHub Pipeline Report — {timestamp}</title>
  <style>{css}</style>
</head>
<body>

<div class="header">
  <div style="flex:1">
    <h1>StreamHub Audio Pipeline Report</h1>
    <div class="sub">{timestamp} UTC</div>
  </div>
  <span class="badge {overall_cls}">{overall_label}</span>
</div>

<div class="container">

  <!-- Summary cards -->
  <div class="section">
    <div class="section-header">Pipeline Summary</div>
    <div class="summary-grid">
      {summary_cards}
    </div>
  </div>

  <!-- k6 metrics -->
  <div class="section">
    <div class="section-header">k6 Performance Metrics</div>
    {k6_table}
  </div>

  <!-- Latency chart -->
  {chart_section}

  <!-- Quality check -->
  <div class="section">
    <div class="section-header">Audio Pass-Through Quality</div>
    {quality_table}
  </div>

</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script>
(function(){{
  var el = document.getElementById('latChart');
  if (!el) return;
  var d = {chart_data};
  new Chart(el, {{
    type: 'bar',
    data: {{
      labels: d.labels,
      datasets: [
        {{ label: 'avg (ms)', data: d.avg, backgroundColor: 'rgba(52,152,219,.7)' }},
        {{ label: 'p95 (ms)', data: d.p95, backgroundColor: 'rgba(231,76,60,.7)'  }},
      ]
    }},
    options: {{
      responsive: true,
      plugins: {{ legend: {{ position: 'top' }} }},
      scales: {{ y: {{ beginAtZero: true, title: {{ display:true, text:'ms' }} }} }}
    }}
  }});
}})();
</script>
</body>
</html>
"""


def stat_card(val: str, label: str) -> str:
    return f'<div class="stat-card"><div class="val">{val}</div><div class="lbl">{label}</div></div>'


def build_k6_table(rows: list[dict]) -> str:
    if not rows:
        return "<p style='padding:20px;color:#aaa'>No k6 summary data found.</p>"
    hdr = ("<thead><tr>"
           "<th>Metric</th><th>avg</th><th>p50</th><th>p95</th><th>p99</th><th>Threshold</th>"
           "</tr></thead>")
    body = "<tbody>"
    for r in rows:
        ok_cls = "ok" if r["ok"] else "fail"
        body += (
            f"<tr>"
            f"<td>{r['label']}</td>"
            f"<td>{r['avg']}</td>"
            f"<td>{r['p50']}</td>"
            f"<td>{r['p95']}</td>"
            f"<td>{r['p99']}</td>"
            f"<td class='{ok_cls} mono'>{r['threshold']}</td>"
            f"</tr>"
        )
    body += "</tbody>"
    return f"<table>{hdr}{body}</table>"


def build_quality_table(results: list[dict]) -> str:
    if not results:
        return "<p style='padding:20px;color:#aaa'>No quality data found.</p>"
    hdr = ("<thead><tr>"
           "<th>Session</th><th>Complete %</th><th>Lost %</th>"
           "<th>Corrupt bytes</th><th>Integrity</th><th>Drop windows</th><th>Result</th>"
           "</tr></thead>")
    body = "<tbody>"
    for r in results:
        sess = r.get("session", "?")
        if "error" in r:
            body += f"<tr><td>{sess}</td><td colspan='6' class='fail'>ERROR: {r['error']}</td></tr>"
            continue
        ok     = r.get("pass", False)
        ok_cls = "ok" if ok else "fail"
        wins   = r.get("drop_windows_s", [])
        win_str = ", ".join(f"{w}s" for w in wins[:8])
        if len(wins) > 8:
            win_str += f" +{len(wins)-8} more"
        if not win_str:
            win_str = "none"
        integ = "OK" if r.get("integrity_ok") else "FAIL"
        integ_cls = "ok" if r.get("integrity_ok") else "fail"
        body += (
            f"<tr>"
            f"<td class='mono'>{sess}</td>"
            f"<td>{r.get('completeness_pct','—'):.2f}%</td>"
            f"<td>{r.get('lost_pct','—'):.2f}%</td>"
            f"<td>{r.get('corrupted_bytes','—')}</td>"
            f"<td class='{integ_cls}'>{integ}</td>"
            f"<td class='mono' style='font-size:11px'>{win_str}</td>"
            f"<td class='{ok_cls}'>{'PASS' if ok else 'FAIL'}</td>"
            f"</tr>"
        )
    body += "</tbody>"
    return f"<table>{hdr}{body}</table>"


def build_chart_section(chart_data: str) -> str:
    return f"""
  <div class="section">
    <div class="section-header">Latency Breakdown (ms)</div>
    <div class="chart-wrap">
      <canvas id="latChart" height="80"></canvas>
    </div>
  </div>
"""


# ─── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Generate HTML pipeline report")
    ap.add_argument("--k6-summary", metavar="FILE", help="k6 --summary-export JSON")
    ap.add_argument("--quality",    metavar="FILE", help="quality_check.py --json output")
    ap.add_argument("--out",        metavar="FILE", default="report.html", help="Output HTML")
    args = ap.parse_args()

    summary  = parse_k6_summary(args.k6_summary)
    quality  = parse_quality(args.quality)

    k6_pass  = k6_all_thresholds_pass(summary) if summary else True
    q_pass   = quality_all_pass(quality)        if quality else True
    overall  = k6_pass and q_pass

    ts       = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    rows     = k6_rows(summary)
    cdata    = latency_chart_data(summary)

    # Summary cards
    sess_count = len([r for r in quality if "error" not in r])
    sess_pass  = len([r for r in quality if r.get("pass")])
    loss_avg   = (
        sum(r.get("lost_pct", 0) for r in quality if "error" not in r) / sess_count
        if sess_count else 0
    )
    # MOS from k6 summary
    mos_avg = summary.get("metrics", {}).get("fwd_sess_mos", {}).get("values", {}).get("avg")
    # Latency p95 from k6 summary
    lat_p95 = summary.get("metrics", {}).get("fwd_pkt_latency_ms", {}).get("values", {}).get("p(95)")

    cards = "".join([
        stat_card("PASS" if overall else "FAIL", "Overall result"),
        stat_card(f"{sess_pass}/{sess_count}", "Sessions passed"),
        stat_card(f"{loss_avg:.2f}%", "Avg audio loss"),
        stat_card(f"{mos_avg:.2f}" if mos_avg else "—", "Avg MOS"),
        stat_card(f"{lat_p95:.1f} ms" if lat_p95 else "—", "Latency p95"),
    ])

    html = HTML_TEMPLATE.format(
        css=CSS,
        timestamp=ts,
        overall_cls="pass" if overall else "fail",
        overall_label="ALL PASS" if overall else "FAILED",
        summary_cards=cards,
        k6_table=build_k6_table(rows),
        chart_section=build_chart_section(cdata),
        quality_table=build_quality_table(quality),
        chart_data=cdata,
    )

    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w") as f:
        f.write(html)

    print(f"Report written → {out}")
    print(f"  Overall: {'PASS' if overall else 'FAIL'}  "
          f"k6={'PASS' if k6_pass else 'FAIL'}  "
          f"quality={'PASS' if q_pass else 'FAIL'}")


if __name__ == "__main__":
    main()
