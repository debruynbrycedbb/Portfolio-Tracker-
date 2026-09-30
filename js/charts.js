/* ==========================================================================
   charts.js — hand-written SVG charts. No charting library.
   --------------------------------------------------------------------------
   • Smoothed lines use MONOTONE CUBIC interpolation (Steffen / d3's
     curveMonotoneX), not Catmull–Rom. Portfolio snapshots are unevenly
     spaced (dense while the page is open, long gaps overnight); Catmull–Rom
     overshoots across such gaps and invents a spike or dip that isn't in the
     data. Monotone cubic is guaranteed to stay within the values it joins.
   • Series are downsampled to ~1 point per pixel with Largest-Triangle-
     Three-Buckets, which keeps peaks and troughs.
   • Hover is cheap: cached bounding rect, binary search for the nearest point,
     tooltip text updated in place, one update per animation frame, and
     nothing at all when the nearest point hasn't changed.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util;
  const NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* ---------------- monotone cubic ---------------- */
  const sgn = x => (x < 0 ? -1 : 1);
  function slope3(x0, y0, x1, y1, x2, y2) {
    const h0 = x1 - x0, h1 = x2 - x1;
    const s0 = (y1 - y0) / (h0 || (h1 < 0 && -0)), s1 = (y2 - y1) / (h1 || (h0 < 0 && -0));
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (sgn(s0) + sgn(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  function slope2(x0, y0, x1, y1, t) {
    const h = x1 - x0;
    return h ? (3 * (y1 - y0) / h - t) / 2 : t;
  }
  /** Tangents for pixel points [{x,y}] */
  function monotoneTangents(pts) {
    const n = pts.length, t = new Array(n).fill(0);
    if (n < 3) {
      if (n === 2) { const s = (pts[1].y - pts[0].y) / ((pts[1].x - pts[0].x) || 1); t[0] = t[1] = s; }
      return t;
    }
    for (let i = 1; i < n - 1; i++) t[i] = slope3(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    t[0] = slope2(pts[0].x, pts[0].y, pts[1].x, pts[1].y, t[1]);
    t[n - 1] = slope2(pts[n - 2].x, pts[n - 2].y, pts[n - 1].x, pts[n - 1].y, t[n - 2]);
    return t;
  }
  /** Bezier control points for interval i -> i+1 */
  function segment(pts, t, i) {
    const a = pts[i], b = pts[i + 1], dx = (b.x - a.x) / 3;
    return [a.x + dx, a.y + dx * t[i], b.x - dx, b.y - dx * t[i + 1], b.x, b.y];
  }
  function monotonePath(pts) {
    if (!pts.length) return '';
    const t = monotoneTangents(pts);
    let d = 'M' + pts[0].x.toFixed(2) + ',' + pts[0].y.toFixed(2);
    for (let i = 0; i < pts.length - 1; i++) d += 'C' + segment(pts, t, i).map(v => v.toFixed(2)).join(',');
    return d;
  }

  /* ---------------- LTTB downsampling ---------------- */
  function lttb(data, threshold, xk, yk) {
    xk = xk || 't'; yk = yk || 'v';
    const n = data.length;
    if (threshold >= n || threshold < 3) return data.slice();
    const out = [data[0]];
    const every = (n - 2) / (threshold - 2);
    let a = 0;
    for (let i = 0; i < threshold - 2; i++) {
      const avgStart = Math.floor((i + 1) * every) + 1, avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
      let ax = 0, ay = 0;
      for (let j = avgStart; j < avgEnd; j++) { ax += data[j][xk]; ay += data[j][yk]; }
      const len = avgEnd - avgStart || 1; ax /= len; ay /= len;
      const rs = Math.floor(i * every) + 1, re = Math.floor((i + 1) * every) + 1;
      let maxA = -1, pick = rs;
      for (let j = rs; j < re; j++) {
        const area = Math.abs((data[a][xk] - ax) * (data[j][yk] - data[a][yk]) - (data[a][xk] - data[j][xk]) * (ay - data[a][yk]));
        if (area > maxA) { maxA = area; pick = j; }
      }
      out.push(data[pick]); a = pick;
    }
    out.push(data[n - 1]);
    return out;
  }

  /* ---------------- scales & ticks ---------------- */
  function niceStep(span, count) {
    const raw = span / Math.max(1, count), pow = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / pow;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * pow;
  }
  function yDomain(vals, extra) {
    let lo = Math.min.apply(null, vals.concat(extra || [])), hi = Math.max.apply(null, vals.concat(extra || []));
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) { const pad = Math.abs(hi) * 0.02 || 1; lo -= pad; hi += pad; }
    const pad = (hi - lo) * 0.1;
    return [lo - pad, hi + pad];
  }
  function timeTicks(t0, t1, w) {
    const n = Math.max(2, Math.min(6, Math.floor(w / 110)));
    const span = t1 - t0, out = [];
    for (let i = 0; i <= n; i++) out.push(t0 + (span * i) / n);
    return out.slice(1, -1).length ? out.slice(1, -1) : out;
  }
  function timeLabel(t, span) {
    const d = new Date(t);
    if (span <= 36 * 3600000) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (span <= 400 * 86400000) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }

  /* ---------------- shared tooltip ---------------- */
  function makeTip(host, rowsSpec) {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    tip.setAttribute('aria-live', 'off');
    const head = document.createElement('div'); head.className = 'chart-tip__head'; tip.appendChild(head);
    const rows = {};
    rowsSpec.forEach(k => {
      const r = document.createElement('div'); r.className = 'chart-tip__row';
      const l = document.createElement('span'); l.className = 'chart-tip__label';
      const v = document.createElement('span'); v.className = 'chart-tip__value num';
      r.appendChild(l); r.appendChild(v); tip.appendChild(r);
      rows[k] = { row: r, label: l, value: v };
    });
    const foot = document.createElement('div'); foot.className = 'chart-tip__foot'; tip.appendChild(foot);
    host.appendChild(tip);
    return {
      el: tip, head, rows, foot,
      set(k, label, value, cls) {
        const r = rows[k]; if (!r) return;
        if (r.label.textContent !== label) r.label.textContent = label;
        if (r.value.textContent !== value) r.value.textContent = value;
        const c = 'chart-tip__value num' + (cls ? ' ' + cls : '');
        if (r.value.className !== c) r.value.className = c;
        r.row.hidden = value == null || value === '';
      },
      show(x, y, w, h) {
        tip.classList.add('is-on');
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = x + 14; if (left + tw > w) left = x - tw - 14; if (left < 0) left = 4;
        let top = y - th - 12; if (top < 0) top = Math.min(h - th, y + 14);
        tip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
      },
      hide() { tip.classList.remove('is-on'); }
    };
  }

  /* =====================================================================
     Line chart (performance & price)
     opts: {
       points: [{t, v, kind?, est?}], height, ariaLabel, empty,
       yFormat(v), tip(point) -> { head, rows:[[key,label,value,cls]], foot },
       refLine: { value, label }, tone: 'accent' | 'gain' | 'loss'
     }
     ===================================================================== */
  function line(host, opts) {
    host.innerHTML = '';
    host.classList.add('chart');
    const wrap = document.createElement('div'); wrap.className = 'chart__plot'; host.appendChild(wrap);
    const svg = el('svg', { class: 'chart__svg', role: 'img', tabindex: '0', focusable: 'true' }, wrap);
    const title = el('title', null, svg);
    const tip = makeTip(wrap, ['a', 'b', 'c']);
    let data = [], px = [], xs = [], W = 0, H = opts.height || 260, rect = null, cur = -1, raf = 0, pending = null;
    let crossX, dot, ro, lastW = 0;

    const PAD = { l: 8, r: 58, t: 14, b: 26 };

    function render(animate) {
      W = wrap.clientWidth || host.clientWidth || 600;
      H = opts.height || 260;
      lastW = W;
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      while (svg.lastChild && svg.lastChild !== title) svg.removeChild(svg.lastChild);
      tip.hide(); cur = -1;

      const src = (opts.points || []).filter(p => U.isNum(p.v) && U.isNum(p.t));
      if (src.length < 2) {
        el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart__empty' }, svg).textContent = opts.empty || 'Not enough data yet';
        title.textContent = opts.ariaLabel || 'Chart';
        data = []; px = []; xs = [];
        return;
      }
      data = lttb(src, Math.max(3, Math.floor(W - PAD.l - PAD.r)));
      const t0 = data[0].t, t1 = data[data.length - 1].t;
      const vals = data.map(p => p.v);
      const [y0, y1] = yDomain(vals, opts.refLine && U.isNum(opts.refLine.value) ? [opts.refLine.value] : []);
      const X = t => PAD.l + ((t - t0) / ((t1 - t0) || 1)) * (W - PAD.l - PAD.r);
      const Y = v => PAD.t + (1 - (v - y0) / ((y1 - y0) || 1)) * (H - PAD.t - PAD.b);
      px = data.map(p => ({ x: X(p.t), y: Y(p.v), p }));
      xs = px.map(p => p.x);

      // grid + y labels
      const g = el('g', { class: 'chart__grid', 'aria-hidden': 'true' }, svg);
      const step = niceStep(y1 - y0, 4);
      for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
        const y = Y(v);
        el('line', { x1: PAD.l, x2: W - PAD.r + 4, y1: y, y2: y }, g);
        el('text', { x: W - PAD.r + 8, y: y + 4, class: 'chart__ylabel' }, g).textContent = opts.yFormat ? opts.yFormat(v) : v;
      }
      timeTicks(t0, t1, W - PAD.l - PAD.r).forEach(t => {
        el('text', { x: X(t), y: H - 8, 'text-anchor': 'middle', class: 'chart__xlabel' }, g).textContent = timeLabel(t, t1 - t0);
      });

      // area (whole series) + line segments grouped by source
      const tone = opts.tone || 'accent';
      const tangents = monotoneTangents(px);
      const gid = 'g' + Math.random().toString(36).slice(2, 8);
      const defs = el('defs', null, svg);
      const lg = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el('stop', { offset: '0%', class: 'chart__grad-top chart--' + tone }, lg);
      el('stop', { offset: '100%', class: 'chart__grad-bot chart--' + tone }, lg);
      let area = 'M' + px[0].x.toFixed(2) + ',' + px[0].y.toFixed(2);
      for (let i = 0; i < px.length - 1; i++) area += 'C' + segment(px, tangents, i).map(v => v.toFixed(2)).join(',');
      area += 'L' + px[px.length - 1].x.toFixed(2) + ',' + (H - PAD.b) + 'L' + px[0].x.toFixed(2) + ',' + (H - PAD.b) + 'Z';
      el('path', { d: area, fill: 'url(#' + gid + ')', class: 'chart__area' + (animate ? ' is-enter' : '') }, svg);

      const styleOf = i => {
        const a = px[i].p, b = px[i + 1].p;
        if ((a.kind === 'reconstructed' || b.kind === 'reconstructed')) return (a.est || b.est) ? 'est' : 'recon';
        return 'rec';
      };
      let d = '', style = null;
      const flush = () => { if (d) el('path', { d, class: 'chart__line chart__line--' + style + ' chart--' + tone + (animate ? ' is-enter' : '') }, svg); };
      for (let i = 0; i < px.length - 1; i++) {
        const s = styleOf(i);
        if (s !== style) { flush(); style = s; d = 'M' + px[i].x.toFixed(2) + ',' + px[i].y.toFixed(2); }
        d += 'C' + segment(px, tangents, i).map(v => v.toFixed(2)).join(',');
      }
      flush();

      if (opts.refLine && U.isNum(opts.refLine.value)) {
        const y = Y(opts.refLine.value);
        const rg = el('g', { class: 'chart__ref' }, svg);
        el('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }, rg);
        const lbl = el('text', { x: PAD.l + 6, y: y - 6, class: 'chart__ref-label' }, rg);
        lbl.textContent = opts.refLine.label;
      }

      // crosshair
      crossX = el('line', { class: 'chart__cross', y1: PAD.t, y2: H - PAD.b, x1: -10, x2: -10 }, svg);
      dot = el('circle', { class: 'chart__dot chart--' + tone, r: 4.5, cx: -10, cy: -10 }, svg);
      const hit = el('rect', { x: 0, y: 0, width: W, height: H, class: 'chart__hit' }, svg);
      hit.addEventListener('pointerenter', () => { rect = svg.getBoundingClientRect(); });
      hit.addEventListener('pointermove', onMove);
      hit.addEventListener('pointerdown', onMove);
      hit.addEventListener('pointerleave', leave);

      const first = src[0], last = src[src.length - 1];
      title.textContent = (opts.ariaLabel || 'Line chart') + '. From ' + (opts.yFormat ? opts.yFormat(first.v) : first.v) +
        ' on ' + U.fmt.dateTime(first.t) + ' to ' + (opts.yFormat ? opts.yFormat(last.v) : last.v) + ' on ' + U.fmt.dateTime(last.t) +
        '. Use left and right arrow keys to read values.';
    }

    function nearest(x) {
      let lo = 0, hi = xs.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m; else hi = m; }
      return (x - xs[lo] <= xs[hi] - x) ? lo : hi;
    }
    function onMove(ev) {
      if (!xs.length) return;
      if (!rect) rect = svg.getBoundingClientRect();
      pending = ev.clientX - rect.left;
      if (!raf) raf = requestAnimationFrame(apply);
    }
    function apply() {
      raf = 0;
      if (pending == null) return;
      const i = nearest(pending * (W / (rect.width || W)));
      pending = null;
      if (i === cur) return;               // nothing changed: do nothing
      show(i);
    }
    function show(i) {
      cur = i;
      const p = px[i];
      crossX.setAttribute('x1', p.x); crossX.setAttribute('x2', p.x);
      dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y);
      svg.classList.add('is-hover');
      const info = opts.tip ? opts.tip(p.p) : { head: U.fmt.dateTime(p.p.t), rows: [['a', 'Value', String(p.p.v)]] };
      if (tip.head.textContent !== info.head) tip.head.textContent = info.head;
      ['a', 'b', 'c'].forEach(k => {
        const r = (info.rows || []).find(x => x[0] === k);
        if (r) tip.set(k, r[1], r[2], r[3]); else tip.set(k, '', '');
      });
      tip.foot.textContent = info.foot || '';
      tip.foot.hidden = !info.foot;
      const scale = (rect && rect.width ? rect.width : W) / W;
      tip.show(p.x * scale, p.y * scale, rect && rect.width ? rect.width : W, H * scale);
    }
    function leave() {
      pending = null; cur = -1;
      svg.classList.remove('is-hover');
      if (crossX) { crossX.setAttribute('x1', -10); crossX.setAttribute('x2', -10); dot.setAttribute('cx', -10); }
      tip.hide();
    }
    svg.addEventListener('keydown', e => {
      if (!px.length) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        rect = svg.getBoundingClientRect();
        const n = cur < 0 ? (e.key === 'ArrowRight' ? 0 : px.length - 1) : U.clamp(cur + (e.key === 'ArrowRight' ? 1 : -1) * Math.max(1, Math.round(px.length / 60)), 0, px.length - 1);
        show(n);
      } else if (e.key === 'Escape') leave();
    });
    svg.addEventListener('blur', leave);

    render(opts.animate !== false && !reduceMotion());
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => {
        const w = wrap.clientWidth;
        if (Math.abs(w - lastW) > 1) requestAnimationFrame(() => { rect = null; render(false); });
      });
      ro.observe(wrap);
    }
    return {
      update(points, extra) { Object.assign(opts, extra || {}); opts.points = points; rect = null; render(opts.animate !== false && !reduceMotion()); },
      destroy() { ro && ro.disconnect(); host.innerHTML = ''; }
    };
  }

  /* =====================================================================
     Donut (allocation). segments: [{ id, label, value, color, detail:[..] }]
     ===================================================================== */
  function donut(host, opts) {
    host.innerHTML = '';
    host.classList.add('chart', 'chart--donut');
    const size = opts.size || 220, r = size / 2, thick = opts.thickness || 26, ir = r - thick;
    const wrap = document.createElement('div'); wrap.className = 'chart__plot chart__plot--donut'; host.appendChild(wrap);
    const svg = el('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'chart__svg donut', role: 'img', width: size, height: size }, wrap);
    const title = el('title', null, svg);
    const tip = makeTip(wrap, ['a', 'b', 'c']);
    const segs = (opts.segments || []).filter(s => s.value > 0);
    const total = segs.reduce((s, x) => s + x.value, 0);
    title.textContent = (opts.ariaLabel || 'Allocation') + ': ' + segs.map(s => s.label + ' ' + ((s.value / total) * 100).toFixed(1) + '%').join(', ');

    if (!total) {
      el('circle', { cx: r, cy: r, r: r - thick / 2, class: 'donut__empty', 'stroke-width': thick, fill: 'none' }, svg);
    } else {
      const gapAngle = segs.length > 1 ? 2 / (r - thick / 2) : 0;   // ≈2px surface gap
      let a0 = -Math.PI / 2;
      segs.forEach((s, i) => {
        const frac = s.value / total, a1 = a0 + frac * Math.PI * 2;
        const sa = a0 + gapAngle / 2, ea = Math.max(sa + 0.001, a1 - gapAngle / 2);
        const large = ea - sa > Math.PI ? 1 : 0;
        const p = (ang, rad) => (r + rad * Math.cos(ang)).toFixed(2) + ',' + (r + rad * Math.sin(ang)).toFixed(2);
        const d = frac >= 0.9999
          ? 'M' + p(-Math.PI / 2, r) + 'A' + r + ',' + r + ' 0 1 1 ' + p(-Math.PI / 2 + 6.283, r) + 'L' + p(-Math.PI / 2 + 6.283, ir) + 'A' + ir + ',' + ir + ' 0 1 0 ' + p(-Math.PI / 2, ir) + 'Z'
          : 'M' + p(sa, r) + 'A' + r + ',' + r + ' 0 ' + large + ' 1 ' + p(ea, r) + 'L' + p(ea, ir) + 'A' + ir + ',' + ir + ' 0 ' + large + ' 0 ' + p(sa, ir) + 'Z';
        const path = el('path', { d, class: 'donut__seg', style: 'fill:' + s.color, tabindex: '0', role: 'img',
          'aria-label': s.label + ': ' + (s.aria || '') }, svg);
        const mid = (a0 + a1) / 2;
        const showSeg = () => {
          svg.querySelectorAll('.donut__seg').forEach(x => x.classList.toggle('is-dim', x !== path));
          tip.head.textContent = s.label;
          (s.detail || []).forEach((row, k) => tip.set(['a', 'b', 'c'][k], row[0], row[1], row[2]));
          tip.foot.hidden = true;
          const w = wrap.clientWidth, scale = svg.getBoundingClientRect().width / size || 1;
          tip.show((r + (r - thick / 2) * Math.cos(mid)) * scale, (r + (r - thick / 2) * Math.sin(mid)) * scale, w, wrap.clientHeight);
          opts.onHover && opts.onHover(s.id);
        };
        const hide = () => { svg.querySelectorAll('.donut__seg').forEach(x => x.classList.remove('is-dim')); tip.hide(); opts.onHover && opts.onHover(null); };
        path.addEventListener('pointerenter', showSeg);
        path.addEventListener('focus', showSeg);
        path.addEventListener('pointerleave', hide);
        path.addEventListener('blur', hide);
        a0 = a1;
      });
    }
    if (opts.center) {
      const t = el('text', { x: r, y: r - 4, 'text-anchor': 'middle', class: 'donut__center-label' }, svg); t.textContent = opts.center[0];
      const v = el('text', { x: r, y: r + 18, 'text-anchor': 'middle', class: 'donut__center-value' }, svg); v.textContent = opts.center[1];
    }
    return { highlight(id) { /* legend hover hook */ svg.querySelectorAll('.donut__seg').forEach((x, i) => x.classList.toggle('is-dim', id != null && segs[i] && segs[i].id !== id)); } };
  }

  /* =====================================================================
     Diverging horizontal bars (P&L contribution by position)
     items: [{ label, sub, value, pct, onClick }]
     ===================================================================== */
  function bars(host, opts) {
    host.innerHTML = '';
    host.classList.add('chart', 'chart--bars');
    const items = opts.items || [];
    const wrap = document.createElement('div'); wrap.className = 'chart__plot'; host.appendChild(wrap);
    const tip = makeTip(wrap, ['a', 'b', 'c']);
    let ro, lastW = 0;
    function render() {
      [...wrap.querySelectorAll('svg')].forEach(s => s.remove());
      const W = wrap.clientWidth || 500; lastW = W;
      const rowH = 30, labelW = Math.min(110, W * 0.28), valW = 92, H = Math.max(rowH, items.length * rowH) + 8;
      const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'chart__svg', role: 'img' });
      wrap.insertBefore(svg, tip.el);
      const title = el('title', null, svg);
      title.textContent = (opts.ariaLabel || 'Bar chart') + ': ' + items.map(i => i.label + ' ' + opts.format(i.value)).join('; ');
      if (!items.length) { el('text', { x: W / 2, y: 20, 'text-anchor': 'middle', class: 'chart__empty' }, svg).textContent = opts.empty || 'No data'; return; }
      const max = Math.max.apply(null, items.map(i => Math.abs(i.value))) || 1;
      const hasNeg = items.some(i => i.value < 0), hasPos = items.some(i => i.value > 0);
      const plotL = labelW + 8, plotR = W - valW;
      const zero = hasNeg && hasPos ? plotL + (plotR - plotL) * (Math.max(0, ...items.map(i => -i.value)) / (Math.max(0, ...items.map(i => -i.value)) + Math.max(0, ...items.map(i => i.value)))) : hasNeg ? plotR : plotL;
      const scale = (plotR - plotL) / (hasNeg && hasPos ? (Math.max(0, ...items.map(i => -i.value)) + Math.max(0, ...items.map(i => i.value))) : max);
      el('line', { x1: zero, x2: zero, y1: 2, y2: H - 4, class: 'bars__zero' }, svg);
      items.forEach((it, k) => {
        const y = 4 + k * rowH, bh = 16, by = y + (rowH - bh) / 2 - 3;
        const w = Math.max(2, Math.abs(it.value) * scale);
        const x = it.value >= 0 ? zero : zero - w;
        const g = el('g', { class: 'bars__row', tabindex: '0', role: 'button', 'aria-label': it.label + ' ' + opts.format(it.value) + (it.pct != null ? ', ' + U.fmt.pct(it.pct) : '') }, svg);
        el('rect', { x: 0, y, width: W, height: rowH, class: 'bars__hit' }, g);
        el('text', { x: labelW, y: by + bh - 3, 'text-anchor': 'end', class: 'bars__label' }, g).textContent = it.label;
        // rounded data-end, square at the baseline
        const r = Math.min(4, w / 2);
        const d = it.value >= 0
          ? 'M' + x + ',' + by + 'h' + (w - r) + 'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r + 'v' + (bh - 2 * r) + 'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r + 'h' + (-(w - r)) + 'z'
          : 'M' + (x + w) + ',' + by + 'h' + (-(w - r)) + 'a' + r + ',' + r + ' 0 0 0 ' + (-r) + ',' + r + 'v' + (bh - 2 * r) + 'a' + r + ',' + r + ' 0 0 0 ' + r + ',' + r + 'h' + (w - r) + 'z';
        el('path', { d, class: 'bars__bar ' + (it.value >= 0 ? 'is-gain' : 'is-loss') }, g);
        el('text', { x: W - 4, y: by + bh - 3, 'text-anchor': 'end', class: 'bars__value ' + (it.value >= 0 ? 'is-gain' : 'is-loss') }, g).textContent =
          (it.value >= 0 ? '▲ ' : '▼ ') + opts.format(it.value);
        const showRow = () => {
          tip.head.textContent = it.tipHead || it.label;
          (it.detail || []).forEach((row, i) => tip.set(['a', 'b', 'c'][i], row[0], row[1], row[2]));
          tip.foot.hidden = true;
          tip.show(it.value >= 0 ? x + w : x, by, W, H);
          g.classList.add('is-hover');
        };
        const hide = () => { tip.hide(); g.classList.remove('is-hover'); };
        g.addEventListener('pointerenter', showRow); g.addEventListener('focus', showRow);
        g.addEventListener('pointerleave', hide); g.addEventListener('blur', hide);
        if (it.onClick) {
          g.addEventListener('click', it.onClick);
          g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.onClick(); } });
        }
      });
    }
    render();
    if (window.ResizeObserver) { ro = new ResizeObserver(() => { if (Math.abs(wrap.clientWidth - lastW) > 1) requestAnimationFrame(render); }); ro.observe(wrap); }
    return { destroy() { ro && ro.disconnect(); } };
  }

  PT.charts = { line, donut, bars, lttb, monotonePath, monotoneTangents, segment };
})(window.PT);
