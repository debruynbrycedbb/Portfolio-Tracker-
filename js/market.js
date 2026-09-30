/* ==========================================================================
   market.js — price refresh orchestration, quote cache, FX, value snapshots,
   price-series cache and the connection test.
   --------------------------------------------------------------------------
   This module is handed PT.store.market only. There is no code path from a
   price refresh to the transaction book: positions come IN as arguments
   (already derived by the app), prices go OUT through the market store.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const C = PT.config, U = PT.util, PR = PT.providers;
  const mstore = PT.store.market;          // the only store namespace this module may use

  const state = {
    quotes: mstore.quotes(),               // { key: { lastGood:{price,change24h,source,providerId,extra,at}, failing, error, lastAttempt } }
    fx: mstore.fx(),                       // { usdToEur, source, at }
    status: mstore.status(),               // { lastRefresh, lastDuration, byProvider:{}, ok, failed, stale }
    refreshing: null
  };

  /* ---------------- reading quotes ---------------- */

  /** Merge a position with its manual override and cached quote, for valuation and display. */
  function quoteFor(pos, overrides) {
    const ov = overrides && overrides[pos.key];
    if (ov && U.isNum(ov.price)) {
      return { price: ov.price, change24h: null, source: 'Manual price', manual: true, fetchedAt: ov.setAt, note: ov.note,
        stale: false, extra: (state.quotes[pos.key] && state.quotes[pos.key].lastGood && state.quotes[pos.key].lastGood.extra) || {} };
    }
    const q = state.quotes[pos.key];
    if (!q || !q.lastGood) return q && q.error ? { price: null, error: q.error, failing: true, lastAttempt: q.lastAttempt } : null;
    const g = q.lastGood;
    const age = Date.now() - g.at;
    return {
      price: g.price, change24h: g.change24h, source: g.source, providerId: g.providerId, extra: g.extra || {},
      fetchedAt: g.at, lastGoodAt: g.at,
      failing: !!q.failing, error: q.failing ? q.error : null,
      stale: !!q.failing || age > C.STALE_AFTER_MS
    };
  }

  /* ---------------- FX ---------------- */
  async function ensureFx(force) {
    if (!force && state.fx && Date.now() - state.fx.at < 6 * 3600 * 1000) return state.fx;
    try {
      state.fx = await PR.fx.usdEur();
      mstore.saveFx(state.fx);
    } catch (e) {
      if (state.fx) state.fx.failing = true;
    }
    return state.fx;
  }
  function usdToEur() { return state.fx && U.isNum(state.fx.usdToEur) ? state.fx.usdToEur : null; }

  /* ---------------- refreshing ---------------- */

  async function quoteOne(pos, settings) {
    const providers = PR.providerFor(pos, settings);
    const errors = [];
    let skipRelayed = false;
    for (const p of providers) {
      if (skipRelayed && p.needsRelay) continue;
      try {
        const q = await p.quote(pos, { settings });
        state.quotes[pos.key] = {
          lastGood: { price: q.price, change24h: q.change24h, source: q.source, providerId: p.id, extra: q.extra, at: Date.now(), currency: q.currency },
          failing: false, error: null, lastAttempt: Date.now(),
          // if a fallback priced it, remember why the primary didn't
          fallbackNote: errors.length ? PR.describeError(errors[0].e, pos, settings, errors[0].p) : null
        };
        return { ok: true, provider: p.id };
      } catch (e) {
        errors.push({ p, e });
        // Every relay is down: another relayed provider would hit the same dead routes.
        if (e.kind === 'noroute') skipRelayed = true;
      }
    }
    // Everything failed: keep the last known price, mark it failing, say why.
    const prev = state.quotes[pos.key] || {};
    let msg;
    if (!providers.length) msg = PR.describeError({ kind: 'noroute', noRelays: true }, pos, settings);
    else {
      // Prefer the most informative error: upstream (e.g. 429) beats noroute beats others.
      const pick = errors.find(x => x.e.upstream && x.e.status === 429) || errors.find(x => x.e.kind === 'nopair') ||
        errors.find(x => x.e.kind === 'noroute') || errors.find(x => x.e.upstream) || errors[0];
      msg = PR.describeError(pick.e, pos, settings, pick.p);
    }
    state.quotes[pos.key] = Object.assign({}, prev, { failing: true, error: msg, lastAttempt: Date.now() });
    return { ok: false, error: msg, errors };
  }

  /**
   * Refresh prices for open positions.
   * @param positions  derived open positions (from PT.portfolio.derive)
   * @param settings   current settings
   * @param overrides  manual overrides (positions with an override are not fetched)
   * @param needFx     whether an EUR rate is needed
   */
  function refresh(positions, settings, overrides, needFx) {
    if (state.refreshing) return state.refreshing;
    const t0 = Date.now();
    U.emit('market:refreshing', true);
    state.refreshing = (async () => {
      const fxP = needFx ? ensureFx() : Promise.resolve();
      const todo = positions.filter(p => !(overrides && overrides[p.key]));
      const equities = todo.filter(p => p.type === 'stock' || p.type === 'etf');
      const others = todo.filter(p => !(p.type === 'stock' || p.type === 'etf'));
      const [eqRes, otRes] = await Promise.all([
        U.pool(equities, C.EQUITY_CONCURRENCY, p => quoteOne(p, settings)),
        U.pool(others, C.OTHER_CONCURRENCY, p => quoteOne(p, settings)),
        fxP
      ]);
      const results = eqRes.concat(otRes);
      const byProvider = {};
      results.forEach(r => { if (r.ok) byProvider[r.provider] = (byProvider[r.provider] || 0) + 1; });
      state.status = {
        lastRefresh: Date.now(), lastDuration: Date.now() - t0, byProvider,
        ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length,
        manual: positions.length - todo.length, total: positions.length
      };
      mstore.saveQuotes(state.quotes);
      mstore.saveStatus(state.status);
      return state.status;
    })().finally(() => {
      state.refreshing = null;
      U.emit('market:refreshing', false);
      U.emit('market:updated');
    });
    return state.refreshing;
  }

  /* ---------------- value snapshots (recorded history) ----------------
     Rate-limited and thinned so a year of use stays small:
       < 2 days old   : one per 10 minutes
       < 90 days old  : one per hour
       older          : one per day                                      */
  function thinSnapshots(list, now) {
    const buckets = new Map();
    list.sort((a, b) => a.t - b.t).forEach(s => {
      const age = now - s.t;
      const size = age < 2 * 86400000 ? 600000 : age < 90 * 86400000 ? 3600000 : 86400000;
      buckets.set(size + ':' + Math.floor(s.t / size), s);            // keep the latest in each bucket
    });
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  }

  /**
   * Record a snapshot of portfolio value — only when every open position is
   * priced by a fresh (non-failing) quote, so a gap in the feed can never be
   * recorded as a fall in value.
   */
  function recordSnapshot(summary) {
    if (!summary || !summary.openCount || summary.pricedCount !== summary.openCount) return false;
    if (summary.rows.some(r => r.quote && (r.quote.failing || r.quote.stale))) return false;
    const list = mstore.snapshots();
    const now = Date.now();
    const last = list[list.length - 1];
    if (last && now - last.t < C.SNAPSHOT_MIN_GAP_MS) return false;
    list.push({ t: now, v: +summary.value.toFixed(6), inv: +summary.invested.toFixed(6), r: +summary.realised.toFixed(6) });
    mstore.saveSnapshots(thinSnapshots(list, now));
    return true;
  }

  /* ---------------- price series (cached) ---------------- */
  const seriesMem = {};
  function seriesTTL(days) { return days <= 1 ? 5 * 60000 : days <= 7 ? 30 * 60000 : 6 * 3600000; }

  async function series(pos, days, settings) {
    const k = pos.key + '|' + (days > 3650 ? 'max' : days);
    const now = Date.now();
    const cached = seriesMem[k] || mstore.series()[k];
    if (cached && now - cached.at < seriesTTL(days)) return cached;
    const providers = PR.seriesProvidersFor(pos, settings);
    let lastErr = null;
    for (const p of providers) {
      try {
        const pts = await p.series(pos, days, { settings });
        if (pts && pts.length) {
          const entry = { at: now, pts, source: p.label };
          seriesMem[k] = entry;
          const all = mstore.series(); all[k] = entry; mstore.saveSeries(all);
          return entry;
        }
      } catch (e) { lastErr = { e, p }; if (e.kind === 'noroute') break; }
    }
    if (cached) return Object.assign({}, cached, { stale: true });
    return { at: now, pts: null, error: lastErr ? PR.describeError(lastErr.e, pos, settings, lastErr.p) : null };
  }

  /* ---------------- connection test ----------------
     Sequential probes (so the test doesn't cause the rate limiting it's
     diagnosing), using the EXACT request shape real quotes use.            */
  async function connectionTest(positions, settings, onRow) {
    const rows = [];
    const push = row => { rows.push(row); onRow && onRow(row, rows); return row; };
    const timed = async fn => { const t0 = performance.now(); try { const v = await fn(); return { ok: true, v, ms: Math.round(performance.now() - t0) }; } catch (e) { return { ok: false, e, ms: Math.round(performance.now() - t0) }; } };

    // 1. Dexscreener
    const meme = positions.find(p => p.type === 'memecoin') || positions.find(p => p.meta && p.meta.pairAddress);
    const dexProbe = meme || { symbol: 'KEYCAT', type: 'memecoin', meta: { chain: 'base', pairAddress: '0x377feeed4820b3b28d1ab429509e7a0789824fca' } };
    let r = await timed(() => PR.dexscreener.quote(dexProbe));
    push({ group: 'Crypto & memecoins', label: 'Dexscreener', status: r.ok ? 'ok' : 'fail', ms: r.ms,
      detail: r.ok ? dexProbe.symbol + ' ' + U.fmt.price(r.v.price) + ' — direct from your browser, no relay needed' : PR.describeError(r.e, dexProbe, settings, PR.dexscreener) });

    // 2. CoinGecko
    const cgPos = positions.find(p => p.meta && p.meta.coingeckoId) || { symbol: 'BTC', type: 'crypto', meta: { coingeckoId: 'bitcoin' } };
    r = await timed(() => PR.coingecko.quote(cgPos));
    push({ group: 'Crypto & memecoins', label: 'CoinGecko', status: r.ok ? 'ok' : 'fail', ms: r.ms,
      detail: r.ok ? cgPos.symbol + ' ' + U.fmt.price(r.v.price) + ' — direct, no key' : PR.describeError(r.e, cgPos, settings, PR.coingecko) });

    // 3. FX
    if (settings.baseCurrency !== 'USD' || positions.some(p => p.hasEur)) {
      r = await timed(() => PR.fx.usdEur());
      push({ group: 'Currency', label: 'FX rate (USD→EUR)', status: r.ok ? 'ok' : 'fail', ms: r.ms,
        detail: r.ok ? '1 USD = ' + r.v.usdToEur.toFixed(4) + ' EUR · ' + r.v.source : 'No FX source answered — amounts would stay in USD.' });
    } else {
      push({ group: 'Currency', label: 'FX rate', status: 'skip', detail: 'Not needed — base currency is USD.' });
    }

    // 4. Stock routes, each relay with a CONTROL ticker using the real quote URL.
    const equities = positions.filter(p => p.type === 'stock' || p.type === 'etf');
    const chain = PR.relayChain(settings);
    const own = PR.ownRelay(settings);
    let working = null;
    if (settings.relayMode === 'none') {
      push({ group: 'Stocks & ETFs', label: 'Relays', status: settings.finnhubKey ? 'skip' : 'fail',
        detail: 'Relays are switched off.' + (settings.finnhubKey ? ' Stocks use Finnhub only (regular session only).' : ' Stocks and ETFs cannot be priced without a relay or a Finnhub key.') });
    } else {
      if (!own) {
        push({ group: 'Stocks & ETFs', label: 'Your relay', status: settings.relayMode === 'own' ? 'fail' : 'warn',
          detail: 'Not configured. ' + (settings.relayMode === 'own' ? 'Mode is "My relay only", so nothing can fetch stock prices.' : 'Stocks rely on public relays, which are unreliable. Deploy your own (README).') });
      }
      for (const relay of chain) {
        if (working && !relay.own) {
          push({ group: 'Stocks & ETFs', label: relay.label, status: 'standby',
            detail: 'Standby — not reached while ' + (working.own ? 'your relay' : working.label) + ' works. Not probed.' });
          continue;
        }
        const url = relay.url(PR.yahoo.quoteUrl(C.CONTROL_TICKER));
        r = await timed(() => PR.fetchText(url, relay.timeout));
        let status, detail;
        if (!r.ok) {
          status = relay.own ? 'fail' : 'warn';
          detail = (r.e.timeout ? 'Timed out' : 'No answer (network/CORS)') + ' probing control ticker ' + C.CONTROL_TICKER + '.' +
            (relay.own ? ' Check the Worker is deployed and the URL is right.' : '');
        } else {
          const res = r.v;
          const ours = (res.headers.get('x-relay') || '') === 'pt-relay';
          const refused = ours ? !!res.headers.get('x-relay-refused') : [401, 402, 403, 407].includes(res.status);
          if (refused) { status = relay.own ? 'fail' : 'warn'; detail = 'The relay refused the request itself (HTTP ' + res.status + ').' + (ours ? ' ' + res.body.slice(0, 140) : ''); }
          else if (res.ok) {
            try {
              const q = PR.yahoo.parse(JSON.parse(res.body), settings.extendedHours);
              status = 'ok'; detail = 'Relay works: control ticker ' + C.CONTROL_TICKER + ' ' + U.fmt.price(q.price) + ' via Yahoo (' + res.ms + ' ms).';
              working = relay;
            } catch (e) { status = relay.own ? 'fail' : 'warn'; detail = 'Answered, but not with market data: ' + res.body.slice(0, 100); }
          } else {
            status = 'warn';
            detail = 'The relay answered — Yahoo returned HTTP ' + res.status + ' for the control ticker. ' +
              (res.status === 429 ? 'Yahoo is rate-limiting this relay\'s IP; the relay itself is fine.' : 'The relay itself is fine.');
            working = working || relay;
          }
        }
        push({ group: 'Stocks & ETFs', label: relay.label, status, ms: r.ms, detail });
      }

      // 5. Each of YOUR tickers, separately, through the first working route.
      if (equities.length) {
        if (!working) {
          push({ group: 'Your tickers', label: equities.map(p => p.symbol).join(', '), status: 'fail',
            detail: 'Not probed — no stock data route is working (see above).' });
        } else {
          for (const p of equities) {
            await U.sleep(350);
            r = await timed(() => PR.fetchText(working.url(PR.yahoo.quoteUrl(p.symbol)), working.timeout));
            let status, detail;
            if (!r.ok) { status = 'fail'; detail = 'The route stopped answering (' + r.e.message + ').'; }
            else if (r.v.ok) {
              try {
                const q = PR.yahoo.parse(JSON.parse(r.v.body), settings.extendedHours);
                status = 'ok'; detail = U.fmt.price(q.price) + (q.extra.priceSession !== 'regular' ? ' (' + (q.extra.priceSession === 'pre' ? 'pre-market' : 'after-hours') + ')' : '') + ' via Yahoo';
              } catch (e) { status = 'fail'; detail = 'Unreadable response for this symbol.'; }
            } else if (r.v.status === 429) { status = 'fail'; detail = 'Yahoo is rate-limiting ' + p.symbol + ' (HTTP 429). The relay works — this one symbol is being refused. Nasdaq fallback will be tried on refresh.'; }
            else if (r.v.status === 404) { status = 'fail'; detail = 'Yahoo has no data for ' + p.symbol + ' (HTTP 404) — check the ticker. The relay works.'; }
            else { status = 'fail'; detail = 'Yahoo returned HTTP ' + r.v.status + ' for ' + p.symbol + '. The relay works.'; }
            push({ group: 'Your tickers', label: p.symbol, status, ms: r.ms, detail });
          }
        }
      }
    }

    // 6. Finnhub (only if a key is set)
    if (settings.finnhubKey) {
      r = await timed(() => PR.finnhub.quote({ symbol: C.CONTROL_TICKER, type: 'stock' }, { settings }));
      push({ group: 'Stocks & ETFs', label: 'Finnhub (your key)', status: r.ok ? 'ok' : 'fail', ms: r.ms,
        detail: r.ok ? C.CONTROL_TICKER + ' ' + U.fmt.price(r.v.price) + ' — regular session only on the free tier' : PR.describeError(r.e, { symbol: C.CONTROL_TICKER }, settings, PR.finnhub) });
    }

    // Summary
    const bad = rows.filter(x => x.status === 'fail');
    const stockOk = !!working || (settings.relayMode === 'none' && !!settings.finnhubKey);
    let summary;
    if (!bad.length) summary = { status: 'ok', text: 'Everything your portfolio uses is reachable.' };
    else if (!stockOk && equities.length) summary = { status: 'fail', text: 'No stock data route is working, so stocks and ETFs can\'t be priced. Deploy your own relay (README) and paste its URL above.' };
    else if (bad.every(x => x.group === 'Your tickers')) summary = { status: 'warn', text: 'The relay works, but ' + bad.map(x => x.label).join(', ') + ' still failed — that\'s the data provider refusing those symbols, not your relay.' };
    else summary = { status: 'warn', text: bad.length + ' check' + (bad.length > 1 ? 's' : '') + ' failed — see the rows marked Failed.' };
    return { rows, summary };
  }

  PT.market = {
    state, quoteFor, refresh, ensureFx, usdToEur, recordSnapshot, thinSnapshots, series, connectionTest,
    snapshots: () => mstore.snapshots(),
    clearCache() { mstore.clearPriceCache(); state.quotes = {}; state.status = {}; Object.keys(seriesMem).forEach(k => delete seriesMem[k]); U.emit('market:updated'); },
    clearHistory() { mstore.clearHistory(); U.emit('market:updated'); }
  };
})(window.PT);
