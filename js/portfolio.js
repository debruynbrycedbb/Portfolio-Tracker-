/* ==========================================================================
   portfolio.js — positions and P&L, derived from the transaction list.
   --------------------------------------------------------------------------
   Positions are NEVER stored. They are rebuilt from the full transaction
   history on every read, so they cannot drift out of sync with it.

     costBasis     = Σ (quantity × price)        fees EXCLUDED
     averageEntry  = costBasis ÷ quantity
     totalInvested = costBasis + Σ fees          fees INCLUDED
     positionValue = quantity × currentPrice
     unrealisedPL  = positionValue − totalInvested
     plPercent     = unrealisedPL ÷ totalInvested × 100

   Sells remove units at the running average cost (plus the matching share
   of buy fees) and bank the difference as realised P&L. The average entry
   of the units that remain does not move.

   Everything here is pure: no storage, no network, no DOM.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const EPS = 1e-12;
  const P = {};

  const TYPES = ['stock', 'etf', 'crypto', 'memecoin'];
  P.TYPES = TYPES;

  /* ---------------- identity ----------------
     stocks / ETFs / crypto: type + ticker
     memecoins: type + blockchain + contract (or pair) address — names and
     symbols are not unique, two different tokens can share both. */
  P.assetKey = function (a) {
    const type = a.type;
    if (type === 'memecoin') {
      const m = a.meta || {};
      const addr = String(m.contract || m.pairAddress || a.symbol || '').toLowerCase();
      return 'memecoin:' + String(m.chain || 'unknown').toLowerCase() + ':' + addr;
    }
    return type + ':' + String(a.symbol || '').trim().toUpperCase();
  };

  P.txTime = tx => Date.parse(tx.date) || 0;

  /** rates: { EUR: usdPerEur }. Transactions keep their own currency; USD is the working unit. */
  P.toUsd = function (amount, currency, rates) {
    if (!currency || currency === 'USD') return amount;
    const r = rates && rates[currency];
    return r ? amount * r : amount;
  };

  function sortTx(txs) {
    return txs.slice().sort((a, b) => (P.txTime(a) - P.txTime(b)) || ((a.createdAt || 0) - (b.createdAt || 0)) ||
      (a.side === b.side ? 0 : a.side === 'buy' ? -1 : 1));
  }
  P.sortTx = sortTx;

  function newPosition(tx, key) {
    return {
      key, type: tx.type, symbol: String(tx.symbol || '').toUpperCase(), name: tx.name || tx.symbol,
      meta: Object.assign({}, tx.meta || {}),
      qty: 0, costBasis: 0, fees: 0, realised: 0,
      boughtQty: 0, boughtCost: 0,
      firstBuyAt: null, lastTxAt: null, txIds: []
    };
  }

  /**
   * Replay the transaction history.
   * Returns { positions: {key: pos}, perTx: {id: {realised, avgAtSale, ...}}, problems: [...] }
   * `problems` lists sells that exceed what was held at that moment.
   */
  P.derive = function (txs, rates, opts) {
    const positions = {}, perTx = {}, problems = [];
    const until = opts && opts.until;
    sortTx(txs).forEach(tx => {
      const t = P.txTime(tx);
      if (until != null && t > until) return;
      const key = P.assetKey(tx);
      const pos = positions[key] || (positions[key] = newPosition(tx, key));
      // richest metadata wins; later records fill gaps without erasing earlier facts
      Object.keys(tx.meta || {}).forEach(k => { if (tx.meta[k] != null && tx.meta[k] !== '') pos.meta[k] = tx.meta[k]; });
      if (tx.name) pos.name = tx.name;
      pos.txIds.push(tx.id);
      pos.lastTxAt = t;

      const q = +tx.quantity, pUsd = P.toUsd(+tx.price, tx.currency, rates), fUsd = P.toUsd(+tx.fees || 0, tx.currency, rates);
      if (tx.side === 'sell') {
        if (q > pos.qty + Math.max(EPS, pos.qty * 1e-9)) {
          problems.push({ txId: tx.id, key, held: pos.qty, wanted: q, symbol: pos.symbol });
          perTx[tx.id] = { realised: null, invalid: true };
          return;
        }
        const avg = pos.qty > 0 ? pos.costBasis / pos.qty : 0;
        const share = pos.qty > 0 ? q / pos.qty : 0;
        const feeShare = pos.fees * share;
        const proceeds = q * pUsd - fUsd;
        const costOut = avg * q + feeShare;
        const realised = proceeds - costOut;
        pos.realised += realised;
        pos.qty -= q;
        pos.costBasis -= avg * q;
        pos.fees -= feeShare;
        if (pos.qty <= Math.max(EPS, 1e-10 * q)) { pos.qty = 0; pos.costBasis = 0; pos.fees = 0; }
        perTx[tx.id] = { realised, avgAtSale: avg, proceeds, costOut };
      } else {
        pos.qty += q;
        pos.costBasis += q * pUsd;
        pos.fees += fUsd;
        pos.boughtQty += q;
        pos.boughtCost += q * pUsd;
        if (pos.firstBuyAt == null) pos.firstBuyAt = t;
        perTx[tx.id] = { cost: q * pUsd + fUsd };
      }
    });
    Object.values(positions).forEach(p => {
      p.invested = p.costBasis + p.fees;
      p.avgEntry = p.qty > 0 ? p.costBasis / p.qty : 0;
      p.open = p.qty > 0;
    });
    return { positions, perTx, problems };
  };

  /* ---------------- validation ---------------- */

  /**
   * Validate a candidate transaction against the rest of the history.
   * Returns [] when fine, else [{ field, msg }] with actionable messages.
   */
  P.validate = function (tx, allTxs, rates) {
    const errs = [];
    if (!TYPES.includes(tx.type)) errs.push({ field: 'type', msg: 'Choose an asset type: Stock, ETF, Cryptocurrency or Memecoin.' });
    if (tx.side !== 'buy' && tx.side !== 'sell') errs.push({ field: 'side', msg: 'Choose Buy or Sell.' });
    if (!tx.symbol || (tx.type === 'memecoin' && !(tx.meta && (tx.meta.contract || tx.meta.pairAddress)))) {
      errs.push({ field: 'asset', msg: tx.type === 'memecoin'
        ? 'No token selected yet. Paste the token contract, pair address or a Dexscreener link above, then pick the pool.'
        : 'No asset selected yet. Search by ticker or name above and pick a result — or pick one of your holdings.' });
    }
    if (!(+tx.quantity > 0)) errs.push({ field: 'quantity', msg: 'Enter a quantity greater than zero.' });
    if (!(+tx.price >= 0) || tx.price === '' || tx.price == null || isNaN(+tx.price)) errs.push({ field: 'price', msg: 'Enter the price per unit you paid or received (0 is allowed for an airdrop).' });
    if (!(+tx.fees >= 0)) errs.push({ field: 'fees', msg: 'Fees can\'t be negative — leave at 0 if there were none.' });
    const t = P.txTime(tx);
    if (!t) errs.push({ field: 'date', msg: 'Enter the date and time of the trade.' });
    else if (t > Date.now() + 5 * 60 * 1000) errs.push({ field: 'date', msg: 'That date is in the future — enter when the trade actually happened.' });
    if (errs.length) return errs;

    // Replay history with the candidate in place: no sell may exceed what was held at that moment.
    const others = allTxs.filter(x => x.id !== tx.id);
    const { problems } = P.derive(others.concat([tx]), rates);
    const mine = problems.find(p => p.txId === tx.id);
    if (mine) {
      const F = PT.util.fmt;
      // If both numbers look identical when rounded, show them at full precision so the difference is visible.
      const fq = F.qty(mine.wanted) === F.qty(mine.held) ? F.qtyFull : F.qty;
      const held = mine.held > 0 ? fq(mine.held) + ' ' + mine.symbol : 'no ' + mine.symbol;
      errs.push({ field: 'quantity', msg: 'You can\'t sell ' + fq(mine.wanted) + ' ' + mine.symbol +
        ' — on that date you hold ' + held + '.' + (mine.held > 0 ? ' Use "Sell all" to sell exactly that.' : '') });
    } else if (problems.length) {
      const p = problems[0];
      errs.push({ field: 'quantity', msg: 'This change would make a later sell of ' + PT.util.fmt.qty(p.wanted) + ' ' + p.symbol +
        ' exceed what you\'d hold then (' + PT.util.fmt.qty(p.held) + '). Adjust or delete that sell first.' });
    }
    return errs;
  };

  /** Normalise user/imported input into a clean record. */
  P.normalise = function (raw) {
    const meta = Object.assign({}, raw.meta || {});
    Object.keys(meta).forEach(k => { if (meta[k] == null || meta[k] === '') delete meta[k]; });
    const d = raw.date ? new Date(typeof raw.date === 'number' ? raw.date : Date.parse(raw.date)) : null;
    const out = {
      id: raw.id || PT.util.uid('tx'),
      type: String(raw.type || '').toLowerCase(),
      symbol: String(raw.symbol || '').trim().toUpperCase(),
      name: String(raw.name || raw.symbol || '').trim(),
      side: String(raw.side || 'buy').toLowerCase(),
      quantity: +raw.quantity,
      price: +raw.price,
      fees: +(raw.fees || 0),
      currency: raw.currency === 'EUR' ? 'EUR' : 'USD',
      date: d && !isNaN(d) ? d.toISOString() : '',
      notes: String(raw.notes || ''),
      meta,
      createdAt: raw.createdAt || Date.now()
    };
    // A buy entered as a money amount keeps what you typed, so editing it shows the same figure.
    // quantity (= amount ÷ price) is still what every calculation uses.
    if (raw.batch) out.batch = String(raw.batch);          // e.g. all the buys made by one pie investment
    if (raw.entry === 'amount' && String(raw.side || 'buy').toLowerCase() === 'buy' && isFinite(+raw.amount) && raw.amount !== '' && raw.amount != null) {
      out.entry = 'amount';
      out.amount = +raw.amount;
    }
    return out;
  };

  /* ---------------- valuation ---------------- */

  /**
   * Value open positions against prices.
   *   priceOf(pos) -> { price, change24h|null, stale, source, ... } | null
   * Unpriced positions are excluded from BOTH value and the invested base
   * P&L is measured against, so a dead feed never reads as a loss.
   */
  P.summarise = function (derived, priceOf) {
    const all = Object.values(derived.positions);
    const open = all.filter(p => p.open);
    const rows = open.map(p => {
      const q = priceOf(p);
      const priced = !!(q && PT.util.isNum(q.price));
      const r = Object.assign({}, p, { quote: q || null, priced });
      if (priced) {
        r.price = q.price;
        r.value = p.qty * q.price;
        r.pl = r.value - p.invested;
        r.plPct = p.invested > 0 ? (r.pl / p.invested) * 100 : null;
        r.change = PT.util.isNum(q.change24h) ? q.change24h : null;
        r.todayPL = r.change != null ? (q.price - q.price / (1 + r.change / 100)) * p.qty : null;
      } else {
        r.price = r.value = r.pl = r.plPct = r.change = r.todayPL = null;
      }
      return r;
    });

    const priced = rows.filter(r => r.priced);
    const value = priced.reduce((s, r) => s + r.value, 0);
    const investedPriced = priced.reduce((s, r) => s + r.invested, 0);
    const investedAll = rows.reduce((s, r) => s + r.invested, 0);
    const todayRows = priced.filter(r => r.todayPL != null);
    const todayPL = todayRows.reduce((s, r) => s + r.todayPL, 0);
    const todayBase = todayRows.reduce((s, r) => s + r.value, 0) - todayPL;
    const realised = all.reduce((s, p) => s + p.realised, 0);

    rows.forEach(r => { r.weight = r.priced && value > 0 ? (r.value / value) * 100 : null; });

    const ranked = priced.filter(r => r.plPct != null).sort((a, b) => b.plPct - a.plPct);

    const byClass = {};
    TYPES.forEach(t => {
      const cr = rows.filter(r => r.type === t), cp = cr.filter(r => r.priced);
      const v = cp.reduce((s, r) => s + r.value, 0), inv = cp.reduce((s, r) => s + r.invested, 0);
      const tr = cp.filter(r => r.todayPL != null), tpl = tr.reduce((s, r) => s + r.todayPL, 0);
      const tbase = tr.reduce((s, r) => s + r.value, 0) - tpl;
      byClass[t] = {
        type: t, rows: cr, count: cr.length, pricedCount: cp.length,
        value: v, invested: inv, investedAll: cr.reduce((s, r) => s + r.invested, 0),
        pl: cp.length ? v - inv : null, plPct: cp.length && inv > 0 ? ((v - inv) / inv) * 100 : null,
        todayPL: tr.length ? tpl : null, todayPct: tr.length && tbase > 0 ? (tpl / tbase) * 100 : null,
        pct: value > 0 ? (v / value) * 100 : 0,
        realised: all.filter(p => p.type === t).reduce((s, p) => s + p.realised, 0)
      };
    });

    return {
      rows, openCount: rows.length, pricedCount: priced.length,
      partial: priced.length > 0 && priced.length < rows.length,
      nonePriced: rows.length > 0 && priced.length === 0,
      value: priced.length ? value : null,
      invested: investedPriced,
      investedAll,
      pl: priced.length ? value - investedPriced : null,
      plPct: priced.length && investedPriced > 0 ? ((value - investedPriced) / investedPriced) * 100 : null,
      todayPL: todayRows.length ? todayPL : null,
      todayPct: todayRows.length && todayBase > 0 ? (todayPL / todayBase) * 100 : null,
      realised,
      best: ranked[0] || null,
      worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
      byClass,
      closed: all.filter(p => !p.open)
    };
  };

  /* ---------------- cash reserve ---------------- */
  const CENT = 0.005;
  P.CASH_TOLERANCE = CENT;

  /** Balance and chronological running history of the cash ledger (USD). */
  P.cash = function (entries) {
    const sorted = (entries || []).slice().sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
    let bal = 0, deposited = 0, withdrawn = 0, intoTrades = 0, fromTrades = 0;
    const rows = sorted.map(e => {
      bal += e.amount;
      if (e.txId) { if (e.amount < 0) intoTrades -= e.amount; else fromTrades += e.amount; }
      else if (e.amount >= 0) deposited += e.amount; else withdrawn -= e.amount;
      return Object.assign({}, e, { balance: bal });
    });
    const balance = Math.abs(bal) < 1e-9 ? 0 : bal;
    return { balance, rows, deposited, withdrawn, intoTrades, fromTrades, used: rows.length > 0 };
  };

  /** Cash effect of a trade in USD: a buy spends cost + fees, a sell brings in proceeds − fees. */
  P.tradeCash = function (tx, rates) {
    const q = +tx.quantity, p = P.toUsd(+tx.price, tx.currency, rates), f = P.toUsd(+tx.fees || 0, tx.currency, rates);
    return tx.side === 'sell' ? q * p - f : -(q * p + f);
  };

  /* ---------------- pie split ---------------- */
  /**
   * Split `total` dollars by `weights` into whole cents that add up to exactly the total
   * (largest-remainder method: every cent goes somewhere, none is invented).
   */
  P.splitAmount = function (total, weights) {
    const cents = Math.round(total * 100);
    const sumW = weights.reduce((a, w) => a + w, 0);
    if (!(sumW > 0) || !(cents >= 0)) return weights.map(() => 0);
    const raw = weights.map(w => (cents * w) / sumW);
    const out = raw.map(Math.floor);
    let left = cents - out.reduce((a, c) => a + c, 0);
    raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || weights[b.i] - weights[a.i])
      .forEach(x => { if (left > 0) { out[x.i]++; left--; } });
    return out.map(c => c / 100);
  };

  /** A sell within float noise of the full holding is the full holding. */
  P.snapToHolding = function (q, held) {
    return held > 0 && Math.abs(q - held) <= Math.max(EPS, held * 1e-9) ? held : q;
  };

  /** What a prospective trade does to a position — for the preview in the form. */
  P.preview = function (pos, side, q, pUsd, fUsd) {
    if (!pos || !(q > 0) || !(pUsd >= 0)) return null;
    if (side === 'buy') {
      const qty = pos.qty + q, cost = pos.costBasis + q * pUsd, fees = pos.fees + (fUsd || 0);
      return { qty, avg: qty > 0 ? cost / qty : 0, invested: cost + fees };
    }
    if (q > pos.qty + Math.max(EPS, pos.qty * 1e-9)) return { oversell: true };
    const avg = pos.qty > 0 ? pos.costBasis / pos.qty : 0;
    const share = pos.qty > 0 ? q / pos.qty : 0;
    const feeShare = pos.fees * share;
    const qty = pos.qty - q;
    return {
      qty, avg: qty > 1e-12 ? avg : 0,
      invested: qty > 1e-12 ? pos.costBasis - avg * q + pos.fees - feeShare : 0,
      realised: q * pUsd - (fUsd || 0) - (avg * q + feeShare)
    };
  };

  PT.portfolio = P;
})(window.PT);
