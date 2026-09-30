/* ==========================================================================
   providers.js — market-data providers.
   --------------------------------------------------------------------------
   One object per provider, each exposing the same three methods:

     quote(position, ctx)        -> { ok, price, change24h, currency, source, extra }
     search(text, ctx)           -> [ { symbol, name, type, meta } ]
     series(position, days, ctx) -> [ { t, c } ]   (null = provider has no history)

   providerFor(position, settings) is the single routing function that decides
   which provider(s) handle an asset. Swapping to a different or paid feed means
   editing one provider object (and, if needed, providerFor) — nothing else.

   This module never touches storage. It cannot write the transaction book.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const C = PT.config, U = PT.util;

  /* =====================================================================
     Network primitives and error classification
     ===================================================================== */

  /**
   * NetError fields:
   *   status       HTTP status if a server answered (0 if nothing answered)
   *   networkError true if nothing answered (DNS, CORS, reset, timeout)
   *   timeout      true if we gave up waiting
   *   upstream     true if the DATA PROVIDER answered with an error
   *   kind         'noroute' | 'nopair' | 'noid' | 'parse' | undefined
   */
  class NetError extends Error {
    constructor(msg, o) { super(msg); this.name = 'NetError'; Object.assign(this, o || {}); }
  }

  async function fetchText(url, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const t0 = performance.now();
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
      const body = await res.text();
      return { status: res.status, ok: res.ok, body, headers: res.headers, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      const timedOut = ctrl.signal.aborted;
      throw new NetError(timedOut ? 'timed out after ' + Math.round(timeout / 1000) + 's' : 'no response (network or CORS)',
        { status: 0, networkError: true, timeout: timedOut, ms: Math.round(performance.now() - t0) });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Direct call to a CORS-enabled API. Non-2xx => upstream error. */
  async function getJSON(url, timeout, via) {
    const r = await fetchText(url, timeout || C.DIRECT_TIMEOUT);
    if (!r.ok) throw new NetError('HTTP ' + r.status, { status: r.status, upstream: true, via: via || 'direct', body: r.body.slice(0, 300) });
    try { return JSON.parse(r.body); }
    catch (e) { throw new NetError('unreadable response', { status: r.status, upstream: true, kind: 'parse' }); }
  }

  /* =====================================================================
     Relay chain (for providers without CORS: Yahoo, Nasdaq)
     ===================================================================== */

  /** Auto-correct a pasted relay URL so it ends with a `url=` parameter. */
  function normaliseRelayUrl(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    if (/[?&]url=$/.test(s)) return s;
    if (/[?&]url=/.test(s)) return s.replace(/([?&]url=).*$/, '$1');   // strip a pasted example target
    if (s.indexOf('?') === -1) return s.replace(/\/?$/, '/') + '?url=';
    return s + (/[?&]$/.test(s) ? '' : '&') + 'url=';
  }

  function ownRelay(settings) {
    const base = normaliseRelayUrl(settings.relayUrl);
    if (!base) return null;
    let host = base;
    try { host = new URL(base).host; } catch (e) { /* keep */ }
    return { id: 'own', label: 'Your relay (' + host + ')', own: true, host, timeout: C.OWN_RELAY_TIMEOUT,
      url: t => base + encodeURIComponent(t) };
  }

  function relayChain(settings) {
    const own = ownRelay(settings);
    if (settings.relayMode === 'none') return [];
    if (settings.relayMode === 'own') return own ? [own] : [];
    return (own ? [own] : []).concat(C.PUBLIC_RELAYS);
  }

  // In-memory only: a relay that didn't answer is benched briefly so it isn't
  // re-probed once per symbol. Never persisted.
  const relayState = { benched: {}, preferred: null, allDownProbeAt: 0, lastUsed: {} };

  const RELAY_REFUSAL = [401, 402, 403, 407];

  /**
   * Fetch `target` through the relay chain.
   * - A relay that doesn't answer, or refuses us itself (401/402/403/407), is benched.
   * - An HTTP error from the DATA PROVIDER (404/429/5xx...) says nothing about the relay:
   *   the relay is kept, 429/5xx is retried once on the same relay, then reported as upstream.
   */
  async function viaRelay(target, settings, validate) {
    const chain = relayChain(settings);
    if (!chain.length) {
      throw new NetError(settings.relayMode === 'none' ? 'relays are switched off' : 'no relay configured',
        { kind: 'noroute', noRelays: true, mode: settings.relayMode });
    }
    const now = Date.now();
    let order = chain.filter(r => !(relayState.benched[r.id] > now));
    if (relayState.preferred) {
      const i = order.findIndex(r => r.id === relayState.preferred);
      if (i > 0) order.unshift(order.splice(i, 1)[0]);
    }
    if (!order.length) {
      // Everything is down. Probe exactly ONE relay (the one benched longest ago),
      // and at most once every 20s — never the whole list per symbol.
      // (a relay benched moments ago by a concurrent request counts as that probe)
      const lastBench = Math.max.apply(null, chain.map(r => (relayState.benched[r.id] || 0) - C.RELAY_BENCH_MS));
      if (now - Math.max(relayState.allDownProbeAt, lastBench) < 20000) {
        throw new NetError('all relays down', { kind: 'noroute', allBenched: true, failures: relayState.lastFailures || [], chain: chain.map(r => r.id) });
      }
      relayState.allDownProbeAt = now;
      order = [chain.slice().sort((a, b) => (relayState.benched[a.id] || 0) - (relayState.benched[b.id] || 0))[0]];
    }

    const failures = [];
    for (const r of order) {
      let attempt = 0;
      for (;;) {
        let res;
        try {
          res = await fetchText(r.url(target), r.timeout);
        } catch (e) {
          relayState.benched[r.id] = Date.now() + C.RELAY_BENCH_MS;
          failures.push({ relay: r, reason: e.message, timeout: e.timeout });
          break;                                                    // next relay
        }
        const ours = (res.headers.get('x-relay') || '') === 'pt-relay';
        const refusedByRelay = ours ? !!res.headers.get('x-relay-refused') : RELAY_REFUSAL.includes(res.status);
        if (refusedByRelay) {
          relayState.benched[r.id] = Date.now() + C.RELAY_BENCH_MS;
          failures.push({ relay: r, reason: 'relay refused the request (HTTP ' + res.status + ')', status: res.status });
          break;
        }
        if (res.ok) {
          if (validate && !validate(res.body)) {
            // A 200 that isn't the provider's data (an HTML error page, a quota notice): relay problem.
            relayState.benched[r.id] = Date.now() + C.RELAY_BENCH_MS;
            failures.push({ relay: r, reason: 'relay returned something that is not market data' });
            break;
          }
          relayState.preferred = r.id;
          delete relayState.benched[r.id];
          relayState.lastUsed[r.id] = Date.now();
          return { body: res.body, status: res.status, via: r, ms: res.ms };
        }
        // The relay answered and carried an upstream error. The relay is fine.
        relayState.preferred = r.id;
        delete relayState.benched[r.id];
        if ((res.status === 429 || res.status >= 500) && attempt < 1) {
          attempt++;
          await U.sleep(900 + Math.random() * 400);
          continue;
        }
        throw new NetError('HTTP ' + res.status + ' from the data provider',
          { status: res.status, upstream: true, via: r, body: res.body.slice(0, 300) });
      }
    }
    relayState.lastFailures = failures;
    throw new NetError('no relay answered', { kind: 'noroute', failures, chain: chain.map(r => r.id) });
  }

  /* =====================================================================
     Yahoo Finance (via relay) — primary for stocks & ETFs, has extended hours
     ===================================================================== */
  const Y = 'https://query1.finance.yahoo.com';
  const isYahooJSON = b => /^\s*\{/.test(b) && (b.indexOf('"chart"') !== -1 || b.indexOf('"quotes"') !== -1 || b.indexOf('"finance"') !== -1);

  function pickRegularWindow(meta, t) {
    const cands = [];
    const ctp = meta.currentTradingPeriod;
    if (ctp && ctp.regular) cands.push(ctp.regular);
    const tp = meta.tradingPeriods;
    const reg = tp && (Array.isArray(tp) ? tp : tp.regular);
    if (Array.isArray(reg)) reg.forEach(x => (Array.isArray(x) ? x : [x]).forEach(w => w && w.start && cands.push(w)));
    if (!cands.length) return null;
    let best = null, bestD = Infinity;
    cands.forEach(w => {
      const d = t < w.start ? w.start - t : t > w.end ? t - w.end : 0;
      if (d < bestD) { bestD = d; best = w; }
    });
    return best;
  }

  function sessionNow(meta, nowSec) {
    const p = meta.currentTradingPeriod;
    if (!p) return 'unknown';
    if (p.pre && nowSec >= p.pre.start && nowSec < p.pre.end) return 'pre';
    if (p.regular && nowSec >= p.regular.start && nowSec < p.regular.end) return 'regular';
    if (p.post && nowSec >= p.post.start && nowSec < p.post.end) return 'post';
    return 'closed';
  }

  /**
   * Parse a v8 chart response into a quote.
   * - Reads BOTH the last regular-session close and the most recent print of any kind.
   * - The extended price is the LAST ACTUAL TRADE in the intraday series (not a summary field).
   * - A print is "extended" when its TIMESTAMP falls outside the regular window — never by price.
   * - Day change is always measured against the regular close preceding the price's session:
   *     pre-market print  -> vs the last regular close (regularMarketPrice)
   *     regular / after-hours -> vs previousClose (the close before today's session)
   */
  function parseYahooChart(j, extendedOn, nowMs) {
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) {
      const err = j && j.chart && j.chart.error;
      throw new NetError(err ? err.description || err.code : 'no data', { status: 404, upstream: true });
    }
    const m = res.meta || {};
    const ts = res.timestamp || [];
    const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
    const closes = q.close || [];
    const intraday = [];
    for (let i = 0; i < ts.length; i++) if (closes[i] != null) intraday.push({ t: ts[i] * 1000, c: closes[i] });

    const last = intraday[intraday.length - 1] || null;
    const lastT = last ? last.t / 1000 : null;
    const rmp = m.regularMarketPrice;
    const prev = U.isNum(m.previousClose) ? m.previousClose : m.chartPreviousClose;
    const regTime = m.regularMarketTime || 0;

    let printSession = null;
    if (lastT) {
      const w = pickRegularWindow(m, lastT);
      printSession = !w ? 'regular' : lastT < w.start ? 'pre' : lastT >= w.end ? 'post' : 'regular';
    }
    const hasExtended = (printSession === 'pre' || printSession === 'post') && lastT > regTime;
    const marketSession = sessionNow(m, Math.floor((nowMs || Date.now()) / 1000));

    let price, ref, priceSession, priceTime;
    if (extendedOn && hasExtended) {
      price = last.c; priceSession = printSession; priceTime = last.t;
      ref = printSession === 'pre' ? rmp : prev;
    } else {
      price = rmp; priceSession = 'regular'; priceTime = regTime * 1000;
      ref = prev;
    }
    if (!U.isNum(price)) throw new NetError('no price in response', { status: 200, upstream: true, kind: 'parse' });

    return {
      ok: true, price, currency: m.currency || 'USD',
      change24h: U.isNum(ref) && ref > 0 ? (price / ref - 1) * 100 : null,
      source: 'Yahoo Finance',
      extra: {
        name: m.longName || m.shortName, exchange: m.fullExchangeName || m.exchangeName,
        regularPrice: rmp, regularTime: regTime * 1000,
        extendedPrice: hasExtended ? last.c : null, extendedTime: hasExtended ? last.t : null,
        extendedSession: hasExtended ? printSession : null,
        priceSession, priceTime, marketSession,
        referenceClose: ref, previousClose: prev,
        dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow,
        w52High: m.fiftyTwoWeekHigh, w52Low: m.fiftyTwoWeekLow,
        hasExtendedData: m.hasPrePostMarketData !== false,
        intraday
      }
    };
  }

  function yahooQuoteUrl(sym) {
    return Y + '/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1d&interval=5m&includePrePost=true';
  }

  function yahooRange(days) {
    if (days <= 1) return 'range=1d&interval=5m&includePrePost=true';
    if (days <= 7) return 'range=5d&interval=30m&includePrePost=true';
    if (days <= 31) return 'range=1mo&interval=1d';
    if (days <= 92) return 'range=3mo&interval=1d';
    if (days <= 183) return 'range=6mo&interval=1d';
    if (days <= 366) return 'range=1y&interval=1d';
    if (days <= 1830) return 'range=5y&interval=1d';
    return 'range=max&interval=1wk';
  }

  const yahoo = {
    id: 'yahoo', label: 'Yahoo Finance', needsRelay: true, extendedHours: true,
    quoteUrl: yahooQuoteUrl,
    parse: parseYahooChart,
    async quote(pos, ctx) {
      const r = await viaRelay(yahooQuoteUrl(pos.symbol), ctx.settings, isYahooJSON);
      const q = parseYahooChart(JSON.parse(r.body), ctx.settings.extendedHours);
      q.extra.via = r.via.label;
      return q;
    },
    async search(text, ctx) {
      const url = Y + '/v1/finance/search?q=' + encodeURIComponent(text) + '&quotesCount=10&newsCount=0&listsCount=0';
      const r = await viaRelay(url, ctx.settings, isYahooJSON);
      const j = JSON.parse(r.body);
      return (j.quotes || []).filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF').map(q => ({
        symbol: q.symbol, name: q.longname || q.shortname || q.symbol,
        type: q.quoteType === 'ETF' ? 'etf' : 'stock', meta: { exchange: q.exchDisp || q.exchange }
      }));
    },
    async series(pos, days, ctx) {
      const url = Y + '/v8/finance/chart/' + encodeURIComponent(pos.symbol) + '?' + yahooRange(days);
      const r = await viaRelay(url, ctx.settings, isYahooJSON);
      const res = JSON.parse(r.body).chart.result[0];
      const ts = res.timestamp || [], cl = (res.indicators.quote[0] || {}).close || [];
      const out = [];
      for (let i = 0; i < ts.length; i++) if (cl[i] != null) out.push({ t: ts[i] * 1000, c: cl[i] });
      return out;
    }
  };

  /* =====================================================================
     Nasdaq (via relay) — keyless fallback for stocks & ETFs.
     (Stooq was the planned fallback; verified 23 Sep 2026 its CSV endpoints
     now return "page does not exist" / "Access denied", so it was dropped.)
     ===================================================================== */
  const NQ = 'https://api.nasdaq.com/api/quote/';
  const nnum = s => { const v = parseFloat(String(s == null ? '' : s).replace(/[$,%+\s]/g, '')); return isFinite(v) ? v : null; };
  const isNasdaqJSON = b => /^\s*\{/.test(b) && b.indexOf('"status"') !== -1;

  const nasdaq = {
    id: 'nasdaq', label: 'Nasdaq', needsRelay: true, extendedHours: true,
    async quote(pos, ctx) {
      const classes = pos.type === 'etf' ? ['etf', 'stocks'] : ['stocks', 'etf'];
      for (const cls of classes) {
        const r = await viaRelay(NQ + encodeURIComponent(pos.symbol) + '/info?assetclass=' + cls, ctx.settings, isNasdaqJSON);
        const d = JSON.parse(r.body).data;
        if (!d || !d.primaryData) continue;
        const prim = d.primaryData, sec = d.secondaryData;
        const status = String(d.marketStatus || '');
        const session = /pre/i.test(status) ? 'pre' : /after|post/i.test(status) ? 'post' : /open/i.test(status) ? 'regular' : 'closed';
        const primPrice = nnum(prim.lastSalePrice);
        let price, ref, priceSession = 'regular', regularPrice = primPrice, ext = null, extSession = null;
        if (sec && nnum(sec.lastSalePrice) != null) {
          const close = nnum(sec.lastSalePrice), closeChg = nnum(sec.netChange) || 0;
          regularPrice = close;
          ext = primPrice; extSession = session === 'pre' ? 'pre' : 'post';
          const prevClose = close - closeChg;
          if (ctx.settings.extendedHours) { price = ext; priceSession = extSession; ref = extSession === 'pre' ? close : prevClose; }
          else { price = close; ref = prevClose; }
        } else {
          price = primPrice;
          const chg = nnum(prim.netChange);
          ref = chg != null ? price - chg : null;
        }
        if (price == null) continue;
        return {
          ok: true, price, currency: 'USD', source: 'Nasdaq',
          change24h: ref ? (price / ref - 1) * 100 : null,
          extra: { name: d.companyName, exchange: d.exchange, regularPrice, extendedPrice: ext, extendedSession: extSession,
            priceSession, marketSession: session, referenceClose: ref, via: r.via.label }
        };
      }
      throw new NetError('Nasdaq has no data for ' + pos.symbol, { status: 404, upstream: true });
    },
    async search() { return []; },
    async series(pos, days, ctx) {
      const cls = pos.type === 'etf' ? 'etf' : 'stocks';
      const to = new Date(), from = new Date(Date.now() - Math.max(days, 7) * 86400000);
      const iso = d => d.toISOString().slice(0, 10);
      const r = await viaRelay(NQ + encodeURIComponent(pos.symbol) + '/historical?assetclass=' + cls + '&fromdate=' + iso(from) +
        '&todate=' + iso(to) + '&limit=9999', ctx.settings, isNasdaqJSON);
      const rows = (((JSON.parse(r.body).data || {}).tradesTable || {}).rows) || [];
      return rows.map(x => {
        const [mm, dd, yy] = String(x.date).split('/');
        return { t: Date.UTC(+yy, +mm - 1, +dd, 20), c: nnum(x.close) };
      }).filter(p => p.c != null && isFinite(p.t)).sort((a, b) => a.t - b.t);
    }
  };

  /* =====================================================================
     Finnhub (direct, CORS-enabled) — optional, needs a free key.
     Free tier is regular-session only: quotes are marked as having no extended data.
     ===================================================================== */
  const FH = 'https://finnhub.io/api/v1/';
  const finnhub = {
    id: 'finnhub', label: 'Finnhub', needsRelay: false, extendedHours: false,
    async quote(pos, ctx) {
      const k = ctx.settings.finnhubKey;
      if (!k) throw new NetError('no Finnhub key', { kind: 'nokey' });
      const j = await getJSON(FH + 'quote?symbol=' + encodeURIComponent(pos.symbol) + '&token=' + encodeURIComponent(k));
      if (!j || (!j.c && !j.t)) throw new NetError('Finnhub has no data for ' + pos.symbol, { status: 404, upstream: true });
      return {
        ok: true, price: j.c, change24h: U.isNum(j.dp) ? j.dp : null, currency: 'USD', source: 'Finnhub',
        extra: { previousClose: j.pc, referenceClose: j.pc, dayHigh: j.h, dayLow: j.l, regularPrice: j.c,
          priceSession: 'regular', noExtendedData: true, priceTime: j.t * 1000 }
      };
    },
    async search(text, ctx) {
      const k = ctx.settings.finnhubKey;
      if (!k) return [];
      const j = await getJSON(FH + 'search?q=' + encodeURIComponent(text) + '&token=' + encodeURIComponent(k));
      return (j.result || []).filter(x => x.symbol && x.symbol.indexOf('.') === -1).slice(0, 10).map(x => ({
        symbol: x.symbol, name: x.description, type: /ETP|ETF/i.test(x.type) ? 'etf' : 'stock', meta: {}
      }));
    },
    async series() { return null; } // candles are a paid endpoint
  };

  /* =====================================================================
     CoinGecko (direct, CORS-enabled, no key) — crypto
     Quote calls in the same tick are batched into one simple/price request.
     ===================================================================== */
  const CG = 'https://api.coingecko.com/api/v3/';
  let cgBatch = null;
  function cgPrice(id) {
    if (!cgBatch) {
      const b = cgBatch = { ids: new Set(), promise: null };
      b.promise = U.sleep(30).then(() => {
        cgBatch = null;
        return getJSON(CG + 'simple/price?ids=' + [...b.ids].map(encodeURIComponent).join(',') +
          '&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true');
      });
    }
    cgBatch.ids.add(id);
    return cgBatch.promise.then(j => j[id]);
  }
  const cgDays = d => (d > 3650 ? 'max' : Math.max(1, Math.ceil(d)));

  const coingecko = {
    id: 'coingecko', label: 'CoinGecko', needsRelay: false,
    async quote(pos) {
      const id = pos.meta && pos.meta.coingeckoId;
      if (!id) throw new NetError('no CoinGecko id for ' + pos.symbol, { kind: 'noid' });
      const d = await cgPrice(id);
      if (!d || !U.isNum(d.usd)) throw new NetError('CoinGecko has no price for "' + id + '"', { status: 404, upstream: true });
      return {
        ok: true, price: d.usd, change24h: U.isNum(d.usd_24h_change) ? d.usd_24h_change : null, currency: 'USD', source: 'CoinGecko',
        extra: { marketCap: d.usd_market_cap, volume24h: d.usd_24h_vol, priceTime: d.last_updated_at ? d.last_updated_at * 1000 : null }
      };
    },
    async search(text) {
      const j = await getJSON(CG + 'search?query=' + encodeURIComponent(text));
      return (j.coins || []).slice(0, 10).map(c => ({
        symbol: String(c.symbol || '').toUpperCase(), name: c.name, type: 'crypto',
        meta: { coingeckoId: c.id, rank: c.market_cap_rank }
      }));
    },
    async series(pos, days) {
      const id = pos.meta && pos.meta.coingeckoId;
      if (!id) return null;
      const j = await getJSON(CG + 'coins/' + encodeURIComponent(id) + '/market_chart?vs_currency=usd&days=' + cgDays(days));
      return (j.prices || []).map(p => ({ t: p[0], c: p[1] }));
    }
  };

  /* =====================================================================
     Dexscreener (direct, CORS-enabled, no key) — memecoins & DEX-priced tokens
     Resolution: recorded chain + pair  ->  token contract across all chains
                 (deepest pool)  ->  text search (deepest pool).
     Dexscreener has NO OHLC endpoint: series() returns null and the UI embeds
     their live chart instead. No price series is ever fabricated.
     ===================================================================== */
  const DS = 'https://api.dexscreener.com/';
  const eqAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  const liq = p => (p && p.liquidity && U.isNum(p.liquidity.usd) ? p.liquidity.usd : -1);
  const deepest = pairs => (pairs || []).filter(p => p && p.priceUsd).sort((a, b) => liq(b) - liq(a))[0] || null;
  const shortAddr = a => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a);

  function dexQuote(p, how) {
    const price = parseFloat(p.priceUsd);
    if (!isFinite(price)) throw new NetError('pair has no USD price', { status: 200, upstream: true, kind: 'parse' });
    const tx = p.txns && p.txns.h24;
    return {
      ok: true, price, currency: 'USD', source: 'Dexscreener',
      change24h: p.priceChange && U.isNum(p.priceChange.h24) ? p.priceChange.h24 : null,
      extra: {
        liquidity: p.liquidity && U.isNum(p.liquidity.usd) ? p.liquidity.usd : null,
        volume24h: p.volume && U.isNum(p.volume.h24) ? p.volume.h24 : null,
        marketCap: U.isNum(p.marketCap) ? p.marketCap : null,
        fdv: U.isNum(p.fdv) ? p.fdv : null,
        chain: p.chainId, dex: p.dexId, labels: p.labels || [],
        pairAddress: p.pairAddress, contract: p.baseToken && p.baseToken.address,
        tokenName: p.baseToken && p.baseToken.name, tokenSymbol: p.baseToken && p.baseToken.symbol,
        quoteSymbol: p.quoteToken && p.quoteToken.symbol,
        txns24h: tx ? (tx.buys || 0) + (tx.sells || 0) : null,
        url: p.url, resolvedBy: how, pairCreatedAt: p.pairCreatedAt || null
      }
    };
  }

  /** Parse what the user pasted: a Dexscreener URL, a pair/contract address, or free text. */
  function parseDexInput(s) {
    s = String(s || '').trim();
    const m = /dexscreener\.com\/([a-z0-9_-]+)\/([A-Za-z0-9]+)/i.exec(s);
    if (m) return { chain: m[1].toLowerCase(), address: m[2], fromUrl: true };
    if (/^0x[0-9a-fA-F]{40}$/.test(s) || /^0x[0-9a-fA-F]{64}$/.test(s)) return { address: s };
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { address: s };        // base58 (Solana etc.)
    if (/^(EQ|UQ)[A-Za-z0-9_-]{46}$/.test(s)) return { address: s };           // TON
    return { query: s };
  }

  function pairToResult(p) {
    const l = liq(p);
    return {
      symbol: String(p.baseToken.symbol || '').toUpperCase(), name: p.baseToken.name, type: 'memecoin',
      price: parseFloat(p.priceUsd), change24h: p.priceChange && p.priceChange.h24,
      liquidity: l >= 0 ? l : null, lowLiquidity: l < C.LOW_LIQUIDITY_USD,
      meta: { chain: p.chainId, pairAddress: p.pairAddress, contract: p.baseToken.address, dex: p.dexId,
              quoteSymbol: p.quoteToken && p.quoteToken.symbol, url: p.url }
    };
  }

  const dexscreener = {
    id: 'dexscreener', label: 'Dexscreener', needsRelay: false,
    parseInput: parseDexInput,
    async quote(pos) {
      const m = pos.meta || {};
      let pair = null, how = '';
      if (m.chain && m.pairAddress) {
        const j = await getJSON(DS + 'latest/dex/pairs/' + encodeURIComponent(m.chain) + '/' + encodeURIComponent(m.pairAddress));
        pair = j.pair || (j.pairs || [])[0] || null; how = 'recorded pair';
      }
      if (!pair && m.contract) {
        const j = await getJSON(DS + 'latest/dex/tokens/' + encodeURIComponent(m.contract));
        const all = j.pairs || [];
        pair = deepest(all.filter(p => eqAddr(p.baseToken && p.baseToken.address, m.contract))) || deepest(all);
        how = 'token contract (deepest pool)';
      }
      if (!pair && pos.symbol) {
        const j = await getJSON(DS + 'latest/dex/search?q=' + encodeURIComponent(pos.symbol));
        pair = deepest((j.pairs || []).filter(p => String(p.baseToken.symbol).toUpperCase() === pos.symbol.toUpperCase() &&
          (!m.chain || p.chainId === m.chain)));
        how = 'symbol search (deepest pool)';
      }
      if (!pair) {
        throw new NetError('Dexscreener has no indexed trading pair for ' + pos.symbol +
          (m.contract ? ' (' + shortAddr(m.contract) + (m.chain ? ' on ' + m.chain : '') + ')' : '') +
          '. Check the contract address and chain, or pin a manual price in Settings.', { kind: 'nopair', status: 404, upstream: true });
      }
      return dexQuote(pair, how);
    },
    /**
     * search(text, {chain}) — text may be a contract, a pair address, a Dexscreener URL, or a name.
     * Returns pools sorted deepest-first.
     */
    async search(text, ctx) {
      const inp = parseDexInput(text);
      const chain = inp.chain || (ctx && ctx.chain) || '';
      let pairs = [];
      if (inp.address) {
        const a = inp.address;
        if (chain) {
          try {
            const j = await getJSON(DS + 'latest/dex/pairs/' + encodeURIComponent(chain) + '/' + encodeURIComponent(a));
            pairs = (j.pairs || (j.pair ? [j.pair] : [])).filter(Boolean);
          } catch (e) { if (!e.upstream) throw e; }
          if (pairs.length && inp.fromUrl) {
            // A pasted pair URL identifies exactly one pool.
            return pairs.slice(0, 1).map(pairToResult);
          }
          if (!pairs.length) {
            try {
              const arr = await getJSON(DS + 'tokens/v1/' + encodeURIComponent(chain) + '/' + encodeURIComponent(a));
              pairs = Array.isArray(arr) ? arr : [];
            } catch (e) { if (!e.upstream) throw e; }
          }
        }
        if (!pairs.length) {
          const j = await getJSON(DS + 'latest/dex/tokens/' + encodeURIComponent(a));
          pairs = (j.pairs || []).filter(p => eqAddr(p.baseToken.address, a) || eqAddr(p.pairAddress, a));
          if (chain && !inp.fromUrl) { const onChain = pairs.filter(p => p.chainId === chain); if (onChain.length) pairs = onChain; }
        }
        if (!pairs.length) {
          const j = await getJSON(DS + 'latest/dex/search?q=' + encodeURIComponent(a));
          pairs = (j.pairs || []).filter(p => eqAddr(p.baseToken.address, a) || eqAddr(p.pairAddress, a));
        }
      } else if (inp.query) {
        const j = await getJSON(DS + 'latest/dex/search?q=' + encodeURIComponent(inp.query));
        pairs = (j.pairs || []).filter(p => !chain || p.chainId === chain);
      }
      const seen = new Set();
      return pairs.filter(p => p && p.baseToken && p.pairAddress && !seen.has(p.pairAddress.toLowerCase()) && seen.add(p.pairAddress.toLowerCase()))
        .sort((a, b) => liq(b) - liq(a)).slice(0, 25).map(pairToResult);
    },
    async series() { return null; },
    embedUrl(meta, dark) {
      if (!meta || !meta.chain || !meta.pairAddress) return null;
      return 'https://dexscreener.com/' + encodeURIComponent(meta.chain) + '/' + encodeURIComponent(meta.pairAddress) +
        '?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartDefaultOnMobile=1&chartTheme=' +
        (dark ? 'dark' : 'light') + '&theme=' + (dark ? 'dark' : 'light') + '&chartStyle=1&chartType=usd&interval=15';
    },
    pageUrl(meta) {
      if (!meta) return null;
      if (meta.url) return meta.url;
      if (meta.chain && meta.pairAddress) return 'https://dexscreener.com/' + meta.chain + '/' + meta.pairAddress;
      return null;
    }
  };

  /* =====================================================================
     FX — ECB reference rates via Frankfurter; exchangerate-api as spare.
     (Verified 23 Sep 2026: api.frankfurter.app no longer answers cross-origin;
     api.frankfurter.dev/v1 does.)
     ===================================================================== */
  const fx = {
    id: 'fx', label: 'FX (ECB via Frankfurter)',
    async usdEur() {
      try {
        const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', 7000);
        if (j && j.rates && U.isNum(j.rates.EUR)) return { usdToEur: j.rates.EUR, source: 'ECB (Frankfurter)', date: j.date, at: Date.now() };
      } catch (e) { /* fall through */ }
      const j = await getJSON('https://open.er-api.com/v6/latest/USD', 7000);
      if (j && j.rates && U.isNum(j.rates.EUR)) return { usdToEur: j.rates.EUR, source: 'exchangerate-api', at: Date.now() };
      throw new NetError('no FX rate', { status: 0 });
    }
  };

  /* =====================================================================
     Routing
     ===================================================================== */
  const all = { yahoo, nasdaq, finnhub, coingecko, dexscreener };

  /** The single routing function: ordered list of providers for a position's quote. */
  function providerFor(pos, settings) {
    const m = pos.meta || {};
    switch (pos.type) {
      case 'memecoin':
        return [dexscreener];
      case 'crypto':
        if (m.pairAddress || m.contract) return m.coingeckoId ? [dexscreener, coingecko] : [dexscreener];
        return m.coingeckoId ? [coingecko, dexscreener] : [dexscreener];
      default: {                                     // stock, etf
        const key = !!settings.finnhubKey;
        const relays = settings.relayMode !== 'none';
        const relayed = relays ? [yahoo, nasdaq] : [];
        if (!key) return relayed;
        // Finnhub's free tier is regular-session only: prefer the extended-hours feeds while that setting is on.
        return settings.extendedHours ? relayed.concat([finnhub]) : [finnhub].concat(relayed);
      }
    }
  }

  /** Providers that can supply a historical price series for this position. */
  function seriesProvidersFor(pos, settings) {
    if (pos.type === 'stock' || pos.type === 'etf') return settings.relayMode === 'none' ? [] : [yahoo, nasdaq];
    if (pos.type === 'crypto') return pos.meta && pos.meta.coingeckoId ? [coingecko] : [];
    return [];
  }

  function searchProvidersFor(type, settings) {
    if (type === 'memecoin') return [dexscreener];
    if (type === 'crypto') return [coingecko, dexscreener];
    const list = [];
    if (settings.relayMode !== 'none') list.push(yahoo);
    if (settings.finnhubKey) list.push(finnhub);
    return list;
  }

  /* =====================================================================
     Human-readable failure messages: name the actual cause and what to do.
     ===================================================================== */
  function describeError(e, pos, settings, provider) {
    const sym = pos ? pos.symbol : '';
    const pname = provider ? provider.label : 'The data provider';
    if (!e) return 'Unknown error.';
    if (e.kind === 'nopair') return e.message;
    if (e.kind === 'noid') return 'No CoinGecko id is recorded for ' + sym + ' and no DEX pair either — edit a transaction to add one, or pin a manual price.';
    if (e.kind === 'nokey') return 'Finnhub needs an API key (Settings).';
    if (e.kind === 'noroute') {
      if (e.noRelays) {
        return settings.relayMode === 'none'
          ? 'Stock prices need a relay, and relays are switched off. Turn on "Automatic" or "My relay only" in Settings → Stock data relay, or add a Finnhub key.'
          : 'No relay is configured. Paste your relay URL in Settings → Stock data relay (the README shows how to deploy one free in a few minutes).';
      }
      const own = (e.failures || []).find(f => f.relay.own);
      if (own) {
        return 'No stock data route is working. Your relay (' + own.relay.host + ') ' +
          (own.status ? 'refused the request (HTTP ' + own.status + ') — check its allowlist/origin settings.' :
            own.timeout ? 'timed out — check the Worker is deployed and the URL in Settings is right.' :
            'didn\'t answer — check the Worker is deployed and the URL in Settings is right.') +
          (settings.relayMode === 'auto' ? ' The public fallbacks failed too.' : '');
      }
      return 'No stock data route is working — no relay answered. Public relays are unreliable: deploy your own (Settings → Stock data relay; README has the steps).';
    }
    if (e.upstream) {
      const via = e.via && e.via.label ? ' — your relay is fine' : '';
      if (e.status === 429) return pname + ' is rate-limiting ' + (sym || 'this request') + ' (HTTP 429)' + (via || '') + '. It will retry on the next refresh.';
      if (e.status === 404) return pname + ' has no data for ' + sym + ' — check the ticker' + (pos && (pos.type === 'stock' || pos.type === 'etf') ? ' (non-US listings need a suffix, e.g. VUSA.L).' : '.');
      if (e.status === 401 || e.status === 403) return pname + ' refused the request (HTTP ' + e.status + ')' + (provider === finnhub ? ' — check your Finnhub API key.' : '.');
      if (e.status >= 500) return pname + ' returned a server error (HTTP ' + e.status + ')' + via + '. This is on their side; it will retry.';
      return pname + ': ' + e.message + '.';
    }
    if (e.networkError) return pname + ' didn\'t answer (' + e.message + '). Check your internet connection.';
    return pname + ': ' + (e.message || String(e));
  }

  PT.providers = {
    NetError, fetchText, getJSON, viaRelay, relayChain, ownRelay, normaliseRelayUrl, relayState,
    yahoo, nasdaq, finnhub, coingecko, dexscreener, fx, all,
    providerFor, seriesProvidersFor, searchProvidersFor, describeError,
    parseDexInput, isYahooJSON
  };
})(window.PT);
