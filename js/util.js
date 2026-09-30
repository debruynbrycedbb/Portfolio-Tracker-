/* ==========================================================================
   util.js — small shared helpers: escaping, events, formatting, concurrency.
   No DOM rendering and no storage access lives here.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = {};

  U.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  U.uid = function (prefix) {
    return (prefix || 't') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  U.sleep = ms => new Promise(r => setTimeout(r, ms));
  U.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  U.isNum = v => typeof v === 'number' && isFinite(v);

  U.debounce = function (fn, ms) {
    let t;
    return function () { const a = arguments, self = this; clearTimeout(t); t = setTimeout(() => fn.apply(self, a), ms); };
  };

  /* Parse a user-typed number. Accepts "1,234.5", "1234,5" (EU decimal) and spaces. */
  U.parseNum = function (s) {
    if (typeof s === 'number') return s;
    s = String(s == null ? '' : s).trim().replace(/[\s '_]/g, '');
    if (!s) return NaN;
    if (s.indexOf(',') !== -1 && s.indexOf('.') === -1) {
      // "1234,5" -> decimal comma; "1,234" (3 digits after) stays ambiguous: treat as thousands.
      const parts = s.split(',');
      if (parts.length === 2 && parts[1].length !== 3) s = parts[0] + '.' + parts[1];
      else s = s.replace(/,/g, '');
    } else {
      s = s.replace(/,/g, '');
    }
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    return parseFloat(s);
  };

  /* ---------------- event bus ---------------- */
  const handlers = {};
  U.on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return () => U.off(ev, fn); };
  U.off = (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); };
  U.emit = (ev, data) => { (handlers[ev] || []).slice().forEach(fn => { try { fn(data); } catch (e) { console.error('[PT] handler for', ev, e); } }); };

  /* Run fn over items with at most n in flight. Results keep input order. */
  U.pool = async function (items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    async function worker() {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
    return out;
  };

  /* ---------------- display currency context ----------------
     All amounts inside the app are USD. Conversion to the base currency
     happens here, at display time only. */
  PT.ctx = PT.ctx || { base: 'USD', rate: 1, fxOk: true };

  const nfCache = {};
  function nf(key, opts) { return nfCache[key] || (nfCache[key] = new Intl.NumberFormat('en-US', opts)); }

  const MINUS = '−';

  function toBase(usd) { return usd * (PT.ctx.base === 'USD' ? 1 : PT.ctx.rate); }
  U.toBase = toBase;
  U.fromBase = v => v / (PT.ctx.base === 'USD' ? 1 : PT.ctx.rate);

  function sym() { return PT.ctx.base === 'EUR' ? '€' : '$'; }
  U.curSymbol = sym;

  /* Money: 2 decimals; tiny non-zero amounts keep significant digits. */
  function moneyRaw(v, opts) {
    opts = opts || {};
    const a = Math.abs(v);
    let s;
    if (opts.compact && a >= 10000) {
      s = nf('c', { notation: 'compact', maximumFractionDigits: 2 }).format(a);
    } else if (a > 0 && a < 0.995 && opts.tiny === true) {
      s = nf('t', { minimumSignificantDigits: 2, maximumSignificantDigits: 4 }).format(a);
    } else {
      s = nf('m', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(a);
    }
    const sign = v < 0 ? MINUS : (opts.signed && v > 0 ? '+' : '');
    return sign + (opts.symbol || sym()) + s;
  }

  const F = {};
  /* usd -> formatted in base currency */
  F.money = (usd, opts) => (U.isNum(usd) ? moneyRaw(toBase(usd), opts) : '—');
  /* already in some currency, no conversion */
  F.moneyIn = (v, cur, opts) => (U.isNum(v) ? moneyRaw(v, Object.assign({}, opts, { symbol: cur === 'EUR' ? '€' : '$' })) : '—');

  /* Unit prices: more precision for sub-dollar tokens. */
  F.price = function (usd, opts) {
    if (!U.isNum(usd)) return '—';
    const v = toBase(usd), a = Math.abs(v);
    let s;
    if (a === 0) s = '0.00';
    else if (a < 1) s = nf('p1', { minimumSignificantDigits: 2, maximumSignificantDigits: 4 }).format(a);
    else if (a < 10000) s = nf('p2', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(a);
    else s = nf('p3', { maximumFractionDigits: 0 }).format(a);
    return (v < 0 ? MINUS : '') + ((opts && opts.symbol) || sym()) + s;
  };
  F.priceIn = (v, cur) => {
    if (!U.isNum(v)) return '—';
    const save = PT.ctx.base, r = PT.ctx.rate;
    PT.ctx.base = 'USD'; PT.ctx.rate = 1;
    const s = F.price(v, { symbol: cur === 'EUR' ? '€' : '$' });
    PT.ctx.base = save; PT.ctx.rate = r;
    return s;
  };

  F.qty = function (q) {
    if (!U.isNum(q)) return '—';
    const a = Math.abs(q);
    const d = a >= 1000 ? 2 : a >= 1 ? 4 : 8;
    return nf('q' + d, { maximumFractionDigits: d }).format(q).replace('-', MINUS);
  };

  /** Full precision (12 significant digits) — for holdings you might sell, and error messages. */
  F.qtyFull = function (q) {
    if (!U.isNum(q)) return '—';
    return nf('qf', { maximumSignificantDigits: 12 }).format(q).replace('-', MINUS);
  };

  F.pct = function (v, opts) {
    if (!U.isNum(v)) return '—';
    const a = Math.abs(v);
    const s = nf('pc', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(a) + '%';
    if (opts && opts.plain) return (v < 0 ? MINUS : '') + s;
    return (v < 0 ? MINUS : v > 0 ? '+' : '') + s;
  };

  F.num = (v, d) => (U.isNum(v) ? nf('n' + (d || 0), { maximumFractionDigits: d || 0 }).format(v) : '—');

  F.usdCompact = function (v) {
    if (!U.isNum(v)) return 'unavailable';
    return '$' + nf('uc', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
  };

  const dtf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const dtt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const tmf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  F.date = t => (t ? dtf.format(new Date(t)) : '—');
  F.dateTime = t => (t ? dtt.format(new Date(t)) : '—');
  F.time = t => (t ? tmf.format(new Date(t)) : '—');
  F.ago = function (t) {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return F.date(t);
  };

  /* datetime-local <-> epoch ms (local time) */
  U.toLocalInput = function (t) {
    const d = new Date(t), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  U.fromLocalInput = function (s) {
    if (!s) return NaN;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
    if (!m) return Date.parse(s);
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0)).getTime();
  };

  U.fmt = F;
  PT.util = U;
})(window.PT);
