/* ==========================================================================
   history.js — the portfolio-value-over-time series behind the performance
   chart. Merges two sources and labels each point with where it came from:

     recorded       snapshots captured while the page was open (market store)
     reconstructed  what the holdings you actually had on each date were worth,
                    from historical price series — useful on day one.

   Assets with no public price history (memecoins: Dexscreener has no OHLC)
   are interpolated between entry price and current price inside a
   reconstructed stretch, and those points are flagged `est` — ESTIMATED,
   never presented as recorded data.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, P = PT.portfolio;
  const DAY = 86400000;

  const RANGES = [
    { id: '1D', days: 1, step: 15 * 60000, tol: 25 * 60000 },
    { id: '1W', days: 7, step: 60 * 60000, tol: 2 * 3600000 },
    { id: '1M', days: 30, step: DAY, tol: 30 * 3600000 },
    { id: '3M', days: 90, step: DAY, tol: 30 * 3600000 },
    { id: '6M', days: 180, step: DAY, tol: 30 * 3600000 },
    { id: '1Y', days: 365, step: DAY, tol: 30 * 3600000 },
    { id: 'All', days: null, step: DAY, tol: 30 * 3600000 }
  ];

  function lastAtOrBefore(pts, t) {
    let lo = 0, hi = pts.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (pts[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  /** State of one asset after each of its transactions: [{t, qty, invested, realised}] */
  function assetTimeline(txs, rates) {
    const sorted = P.sortTx(txs);
    return sorted.map((tx, i) => {
      const d = P.derive(sorted.slice(0, i + 1), rates);
      const pos = Object.values(d.positions)[0];
      return { t: P.txTime(tx), qty: pos.qty, invested: pos.qty > 0 ? pos.costBasis + pos.fees : 0, realised: pos.realised };
    });
  }

  /**
   * Build the series for a range.
   * ctx: { txs, rates, summary, settings }
   */
  async function build(rangeId, ctx) {
    const range = RANGES.find(r => r.id === rangeId) || RANGES[2];
    const now = Date.now();
    const txs = ctx.txs;
    if (!txs.length) return { points: [], estimated: [], range };
    const firstTx = Math.min.apply(null, txs.map(P.txTime));
    const start = Math.max(range.days ? now - range.days * DAY : firstTx, firstTx - 60000);
    const spanDays = Math.max(1, (now - start) / DAY);
    const fetchDays = range.days ? range.days : Math.ceil(spanDays) + 1;

    const derived = P.derive(txs, ctx.rates);
    const priceNow = {};
    ctx.summary.rows.forEach(r => { if (r.priced) priceNow[r.key] = r.price; });

    // Which assets take part: open positions that are priced now (same set the headline uses)
    // plus closed positions, which contribute realised P&L and past value when history exists.
    const assets = [];
    for (const pos of Object.values(derived.positions)) {
      if (pos.open && !(pos.key in priceNow)) continue;
      const own = txs.filter(t => P.assetKey(t) === pos.key);
      assets.push({ pos, events: assetTimeline(own, ctx.rates), firstBuyPrice: pos.boughtQty > 0 ? pos.boughtCost / pos.boughtQty : 0 });
    }

    // Price history, fetched in sequence-friendly batches (equities go through one relay).
    await U.pool(assets, 2, async a => {
      if (a.pos.type === 'memecoin') { a.series = null; return; }
      const s = await PT.market.series(a.pos, fetchDays, ctx.settings);
      a.series = s && s.pts && s.pts.length ? s.pts : null;
    });
    // A closed position with no history can't be valued in the past: leave it out entirely.
    const used = assets.filter(a => a.pos.open || a.series);

    // Timeline: a regular grid, plus every series timestamp in range, plus each trade.
    const tset = new Set();
    const step = Math.max(range.step, (now - start) / 600);
    for (let t = start; t < now; t += step) tset.add(Math.round(t));
    used.forEach(a => {
      (a.series || []).forEach(p => { if (p.t >= start && p.t <= now) tset.add(p.t); });
      a.events.forEach(e => { if (e.t >= start && e.t <= now) tset.add(e.t); });
    });
    const times = [...tset].sort((a, b) => a - b);

    const estimated = new Set();
    const recon = [];
    times.forEach(t => {
      let v = 0, inv = 0, rl = 0, est = false, any = false;
      used.forEach(a => {
        const ei = lastAtOrBefore(a.events, t);
        if (ei < 0) return;
        const st = a.events[ei];
        rl += st.realised;
        if (!(st.qty > 0)) return;
        any = true;
        let px;
        if (a.series) {
          const si = lastAtOrBefore(a.series, t);
          px = a.series[si >= 0 ? si : 0].c;
        } else {
          // No public price history: straight line from entry price to today's price. ESTIMATED.
          const p1 = priceNow[a.pos.key];
          if (!U.isNum(p1)) return;
          const t0 = a.pos.firstBuyAt || firstTx;
          const f = now > t0 ? U.clamp((t - t0) / (now - t0), 0, 1) : 1;
          px = a.firstBuyPrice + (p1 - a.firstBuyPrice) * f;
          est = true;
          estimated.add(a.pos.symbol);
        }
        v += st.qty * px;
        inv += st.invested;
      });
      if (any) recon.push({ t, v, inv, r: rl, kind: 'reconstructed', est });
    });

    // Recorded snapshots take precedence wherever they exist.
    const snaps = PT.market.snapshots().filter(s => s.t >= start && s.t <= now)
      .map(s => ({ t: s.t, v: s.v, inv: s.inv, r: s.r || 0, kind: 'recorded', est: false }));
    const covered = t => {
      const i = lastAtOrBefore(snaps, t);
      return (i >= 0 && t - snaps[i].t <= range.tol) || (i + 1 < snaps.length && snaps[i + 1].t - t <= range.tol);
    };
    const merged = recon.filter(p => !covered(p.t)).concat(snaps).sort((a, b) => a.t - b.t);

    // End exactly on the live headline figure.
    const s = ctx.summary;
    if (s.value != null) {
      while (merged.length && merged[merged.length - 1].t >= now - 1000) merged.pop();
      merged.push({ t: now, v: s.value, inv: s.invested, r: s.realised, kind: 'live', est: false });
    }
    merged.forEach(p => { p.pl = p.v - p.inv; p.plPct = p.inv > 0 ? (p.pl / p.inv) * 100 : null; });

    return {
      points: merged, range,
      estimated: [...estimated],
      recordedCount: snaps.length, reconstructedCount: merged.filter(p => p.kind === 'reconstructed').length,
      missing: assets.filter(a => a.pos.type !== 'memecoin' && !a.series && a.pos.open).map(a => a.pos.symbol)
    };
  }

  PT.history = { RANGES, build };
})(window.PT);
