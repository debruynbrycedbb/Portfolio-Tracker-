/* ==========================================================================
   modal.js — Add / edit trade form.
   --------------------------------------------------------------------------
   • Anything already held is offered first as a one-click pick.
   • Opening from a position (Buy more / Sell) pre-selects it and skips
     asset identification entirely.
   • Memecoins are identified by contract / pair address or a pasted
     Dexscreener URL. One matching pool is selected outright; several are
     listed with chain, DEX and liquidity.
   • Validation names exactly what's missing, then scrolls to and
     highlights the control in question.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc, UI = PT.ui, P = PT.portfolio, C = PT.config, PR = PT.providers;
  let dlg = null, f = null, searchSeq = 0;

  const TYPES = C.ASSET_TYPES;
  const usdToCur = (usd, cur) => (cur === 'EUR' ? usd * (PT.market.usdToEur() || C.FALLBACK_USD_EUR) : usd);
  const curToUsd = (v, cur) => (cur === 'EUR' ? v / (PT.market.usdToEur() || C.FALLBACK_USD_EUR) : v);
  // trimNum: tidy text for PREFILLED prices only (a suggestion the user can change).
  const trimNum = v => { if (!U.isNum(v)) return ''; const a = Math.abs(v); return String(+v.toPrecision(a >= 1 ? 10 : 6)); };
  // exactNum: shortest text that parses back to exactly the same number — for stored quantities.
  // Rounding a holding (even in the 10th digit) can round it UP and turn "sell all" into an oversell.
  const exactNum = v => (U.isNum(v) ? String(v) : '');

  function heldPositions() {
    return Object.values(baseDerived().positions).filter(p => p.open)
      .sort((a, b) => TYPES.findIndex(t => t.id === a.type) - TYPES.findIndex(t => t.id === b.type) || a.symbol.localeCompare(b.symbol));
  }
  /** History without the transaction being edited (so previews and holdings are "before this trade"). */
  function baseDerived() {
    const txs = PT.app.state.txs.filter(t => !f || t.id !== f.editId);
    return P.derive(txs, PT.app.state.rates);
  }
  function currentPos() {
    if (!f.asset) return null;
    const p = baseDerived().positions[P.assetKey(f.asset)];
    return p && p.open ? p : null;
  }
  function livePriceUsd(asset) {
    const key = P.assetKey(asset);
    const row = PT.app.state.summary.rows.find(r => r.key === key);
    return row && row.priced ? row.price : (U.isNum(asset.priceUsd) ? asset.priceUsd : null);
  }

  /* ---------------- open ---------------- */
  function open(opts) {
    opts = opts || {};
    close();
    const st = PT.app.state;
    f = {
      mode: opts.tx ? 'edit' : 'add', editId: opts.tx ? opts.tx.id : null,
      type: opts.type || (opts.tx && opts.tx.type) || (opts.position && opts.position.type) || 'stock',
      side: (opts.tx && opts.tx.side) || opts.side || 'buy',
      asset: null, locked: false, priceTouched: false,
      currency: (opts.tx && opts.tx.currency) || st.settings.baseCurrency,
      chain: '', results: null, resultMsg: '',
      useCash: false, cashTouched: false,
      // Buys can be entered as a dollar amount (default) or as a number of units.
      entry: opts.tx ? (opts.tx.entry === 'amount' ? 'amount' : 'units') : 'amount'
    };
    // Cash reserve: a trade being edited keeps its link; a new trade defaults to using cash when that makes sense.
    const linked = opts.tx ? st.cash.rows.find(e => e.txId === opts.tx.id) : null;
    f.linkedCash = linked || null;
    f.useCash = opts.tx ? !!linked : defaultUseCash(f.side);
    if (opts.tx) {
      const t = opts.tx;
      f.asset = { type: t.type, symbol: t.symbol, name: t.name, meta: Object.assign({}, t.meta) };
      f.locked = true; f.priceTouched = true;
    } else if (opts.position) {
      const p = opts.position;
      f.asset = { type: p.type, symbol: p.symbol, name: p.name, meta: Object.assign({}, p.meta) };
      f.locked = true;
    }

    dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.setAttribute('aria-labelledby', 't-title');
    dlg.innerHTML = '<form class="dlg__body" novalidate id="trade-form">' +
      '<div class="dlg__head"><h2 class="dlg__title" id="t-title">' + (f.mode === 'edit' ? 'Edit trade' : 'Add trade') + '</h2>' +
        '<button type="button" class="btn btn--ghost btn--icon" data-t="close" aria-label="Close">' + UI.icon('close') + '</button></div>' +
      '<div class="trade-grid">' +
        '<div class="full row" style="gap:14px 18px;align-items:flex-start">' +
        '<div class="field" id="fld-type" style="flex:0 1 auto"><span class="field__label" id="lbl-type">Asset type</span><div class="seg seg--nowrap" role="radiogroup" aria-labelledby="lbl-type" id="t-type"></div></div>' +
        '<div class="field" id="fld-side" style="flex:0 1 auto"><span class="field__label" id="lbl-side">Side</span><div class="seg seg--nowrap" role="radiogroup" aria-labelledby="lbl-side" id="t-side"></div></div></div>' +
        '<div class="field full" id="fld-asset"></div>' +
        '<div class="field" id="fld-quantity"><div class="qty-head"><label for="t-qty" id="lbl-qty">Quantity</label>' +
          '<div class="seg seg--xs" role="radiogroup" aria-label="Enter the buy as" id="t-entry">' +
            '<button type="button" role="radio" data-t="entry" data-v="amount">$ Amount</button><button type="button" role="radio" data-t="entry" data-v="units">Units</button></div></div>' +
          '<div class="input-affix" id="wrap-amount"><span class="input-affix__sym" id="t-amount-sym" aria-hidden="true">$</span>' +
            '<input class="input num" id="t-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"></div>' +
          '<input class="input num" id="t-qty" inputmode="decimal" autocomplete="off" placeholder="0">' +
          '<div class="holding-hint" id="t-conv" aria-live="polite"></div>' +
          '<div class="holding-hint" id="t-hold"></div></div>' +
        '<div class="field" id="fld-price"><label for="t-price">Price per unit</label><div class="row" style="flex-wrap:nowrap">' +
          '<input class="input num" id="t-price" inputmode="decimal" autocomplete="off" placeholder="0.00" style="flex:1;min-width:0">' +
          '<select class="select" id="t-cur" aria-label="Currency" style="width:86px;flex:none"><option value="USD">USD</option><option value="EUR">EUR</option></select></div>' +
          '<div class="holding-hint" id="t-pricehint"></div></div>' +
        '<div class="field" id="fld-date"><label for="t-date">Date & time</label><input class="input" type="datetime-local" id="t-date"></div>' +
        '<div class="field" id="fld-fees"><label for="t-fees">Fees <span class="muted">(same currency)</span></label><input class="input num" id="t-fees" inputmode="decimal" autocomplete="off" placeholder="0"></div>' +
        '<div class="field full"><label for="t-notes">Notes <span class="muted">(optional)</span></label><textarea class="input" id="t-notes" rows="2"></textarea></div>' +
        '<div class="full" id="t-total"></div>' +
        '<div class="field full" id="fld-cash"><label class="cash-opt"><input type="checkbox" id="t-usecash">' +
          '<span><strong id="t-cash-label"></strong><span class="cash-opt__sub" id="t-cash-sub"></span></span></label></div>' +
        '<div class="full" id="t-impact"></div>' +
      '</div>' +
      '<div class="dlg__actions"><button type="button" class="btn btn--ghost" data-t="close">Cancel</button><button type="submit" class="btn btn--primary" id="t-submit"></button></div>' +
      '</form>';
    document.body.appendChild(dlg);

    const $ = id => dlg.querySelector('#' + id);
    if (opts.tx) {
      const t = opts.tx;
      $('t-qty').value = exactNum(+t.quantity);
      if (t.entry === 'amount' && U.isNum(+t.amount)) $('t-amount').value = exactNum(+t.amount);
      $('t-price').value = exactNum(+t.price);
      $('t-fees').value = +t.fees ? exactNum(+t.fees) : '';
      $('t-notes').value = t.notes || '';
      $('t-date').value = U.toLocalInput(Date.parse(t.date));
    } else {
      $('t-date').value = U.toLocalInput(Date.now());
    }
    $('t-cur').value = f.currency;
    $('t-usecash').checked = f.useCash;

    renderType(); renderSide(); renderEntry(); renderAsset(); prefillPrice(); update();

    dlg.addEventListener('click', onClick);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onInput);
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dlg.querySelector('#trade-form').addEventListener('submit', onSubmit);
    dlg.showModal();
    const first = f.locked ? qtyInput() : (heldPositions().length ? dlg.querySelector('.pick, #t-search') : $('t-search'));
    (first || qtyInput()).focus();
  }

  /* ---------------- buy by amount ---------------- */
  const byAmount = () => f.side === 'buy' && f.entry === 'amount';
  const qtyInput = () => dlg.querySelector(byAmount() ? '#t-amount' : '#t-qty');
  function unitWord(n) {
    const t = f.asset ? f.asset.type : f.type;
    const w = t === 'stock' ? 'share' : t === 'etf' ? 'unit' : t === 'crypto' ? 'coin' : 'token';
    return w + (n === 1 ? '' : 's');
  }
  /** Show the amount box or the units box. The switch only exists for buys; sells are always in units. */
  function renderEntry() {
    const amount = byAmount();
    dlg.querySelector('#t-entry').hidden = f.side !== 'buy';
    dlg.querySelectorAll('#t-entry button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === (amount ? 'amount' : 'units'))));
    dlg.querySelector('#wrap-amount').hidden = !amount;
    dlg.querySelector('#t-qty').hidden = amount;
    const lbl = dlg.querySelector('#lbl-qty');
    lbl.textContent = amount ? 'Amount to invest' : f.side === 'sell' ? 'Quantity to sell' : 'Quantity';
    lbl.setAttribute('for', amount ? 't-amount' : 't-qty');
    dlg.querySelector('#t-amount-sym').textContent = dlg.querySelector('#t-cur').value === 'EUR' ? '€' : '$';
  }
  /** Switch between amount and units, carrying the value across so nothing typed is lost. */
  function setEntry(mode) {
    if (mode === f.entry) return;
    const v = values();
    f.entry = mode;
    if (mode === 'units' && U.isNum(v.q)) dlg.querySelector('#t-qty').value = exactNum(v.q);
    if (mode === 'amount' && U.isNum(v.q) && U.isNum(v.p)) dlg.querySelector('#t-amount').value = String(+(v.q * v.p).toFixed(2));
    clearError('quantity');
    renderEntry(); update();
    qtyInput().focus();
  }

  function defaultUseCash(side) {
    const c = PT.app.state.cash;
    return side === 'buy' ? c.balance > P.CASH_TOLERANCE : c.used;
  }
  /** Cash available to this trade: the balance, with this trade's own earlier movement undone. */
  function cashAvailable() {
    return PT.app.state.cash.balance - (f.linkedCash ? f.linkedCash.amount : 0);
  }

  function close() {
    if (dlg) { try { dlg.close(); } catch (e) { /* not open */ } dlg.remove(); }
    dlg = null;
  }

  /* ---------------- sections ---------------- */
  function renderType() {
    const host = dlg.querySelector('#t-type');
    host.innerHTML = TYPES.map(t => '<button type="button" role="radio" aria-checked="' + (f.type === t.id) + '" data-t="type" data-v="' + t.id + '"' +
      (f.locked ? ' disabled' : '') + '>' + (t.id === 'crypto' ? 'Crypto' : t.label) + '</button>').join('');
  }
  function renderSide() {
    dlg.querySelector('#t-side').innerHTML = [['buy', 'Buy'], ['sell', 'Sell']].map(s =>
      '<button type="button" role="radio" aria-checked="' + (f.side === s[0]) + '" data-t="side" data-v="' + s[0] + '">' + s[1] + '</button>').join('');
    dlg.querySelector('#t-submit').textContent = f.mode === 'edit' ? 'Save changes' : f.side === 'sell' ? 'Add sell' : 'Add buy';
  }

  function assetMetaLine(a) {
    const m = a.meta || {};
    if (a.type === 'memecoin' || m.pairAddress) {
      return [m.chain, m.dex, m.quoteSymbol ? a.symbol + '/' + m.quoteSymbol : null, m.contract ? 'contract ' + UI.shortAddr(m.contract) : null].filter(Boolean).map(esc).join(' · ');
    }
    return [UI.TYPE[a.type].label, m.exchange, m.coingeckoId ? 'CoinGecko: ' + m.coingeckoId : null, a.manual ? 'entered manually' : null].filter(Boolean).map(esc).join(' · ');
  }

  function renderAsset() {
    const host = dlg.querySelector('#fld-asset');
    if (f.asset) {
      const a = f.asset;
      host.innerHTML = '<span class="field__label">Asset</span><div class="selected" id="t-selected" tabindex="-1">' +
        PT.views.assetCell({ type: a.type, symbol: a.symbol, name: a.name, meta: a.meta }).replace('class="asset"', 'class="asset" style="flex:1;min-width:0"') +
        '<div class="selected__body" hidden></div>' +
        (f.locked ? '' : '<button type="button" class="btn btn--sm" data-t="change">Change</button>') + '</div>' +
        '<span class="field__hint">' + assetMetaLine(a) + '</span>';
      return;
    }
    const held = heldPositions();
    const picks = held.length ? '<div class="field__label" style="margin-top:2px">Your holdings <span class="muted">— one click</span></div><div class="picks">' +
      held.map(p => '<button type="button" class="pick" data-t="pick" data-key="' + esc(p.key) + '"><span class="swatch swatch--' + p.type + '" aria-hidden="true"></span>' + esc(p.symbol) +
        ' <small>' + F.qty(p.qty) + '</small></button>').join('') + '</div>' : '';
    const isMeme = f.type === 'memecoin';
    const ph = { stock: 'Search ticker or company, e.g. AAPL', etf: 'Search ticker or fund, e.g. VOO', crypto: 'Search coin, e.g. bitcoin or BTC', memecoin: 'Paste contract, pair address or Dexscreener link' }[f.type];
    host.innerHTML = picks +
      '<label for="t-search" class="field__label" style="margin-top:' + (held.length ? '10px' : '0') + '">' + (f.side === 'sell' && held.length ? 'Or find another asset' : isMeme ? 'Token' : 'Find asset') + '</label>' +
      '<div class="row" style="flex-wrap:nowrap"><input class="input" id="t-search" autocomplete="off" spellcheck="false" placeholder="' + esc(ph) + '" style="flex:1;min-width:0">' +
      (isMeme ? '<select class="select" id="t-chain" aria-label="Blockchain" style="width:150px;flex:none"><option value="">Any chain</option>' +
        C.CHAINS.map(c => '<option value="' + c[0] + '"' + (f.chain === c[0] ? ' selected' : '') + '>' + c[1] + '</option>').join('') +
        (f.chain && !C.CHAINS.some(c => c[0] === f.chain) ? '<option value="' + esc(f.chain) + '" selected>' + esc(f.chain) + '</option>' : '') + '</select>' : '') + '</div>' +
      (isMeme ? '<span class="field__hint">Identified by address, not name — names and symbols aren\'t unique. A pasted Dexscreener link sets the chain automatically.</span>' : '') +
      '<div id="t-results" aria-live="polite"></div>';
    renderResults();
  }

  function renderResults() {
    const host = dlg && dlg.querySelector('#t-results');
    if (!host) return;
    if (f.resultMsg && !f.results) { host.innerHTML = '<div class="results"><p class="results__msg">' + f.resultMsg + '</p></div>'; return; }
    if (!f.results) { host.innerHTML = ''; return; }
    const txt = (dlg.querySelector('#t-search') || {}).value || '';
    const items = f.results.map((r, i) => {
      if (f.type === 'memecoin') {
        return '<button type="button" class="result" data-t="result" data-i="' + i + '"><span class="result__main">' + esc(r.symbol) + ' <small>' + esc(r.name) + '</small></span>' +
          '<span class="result__side">' + F.priceIn(r.price, 'USD') + '</span><span class="result__meta"><span>' + esc(r.meta.chain) + '</span><span>' + esc(r.meta.dex || '') +
          (r.meta.quoteSymbol ? ' · ' + esc(r.symbol + '/' + r.meta.quoteSymbol) : '') + '</span><span>Liquidity ' + (r.liquidity == null ? 'unavailable' : F.usdCompact(r.liquidity)) + '</span>' +
          (i === 0 && f.results.length > 1 ? '<span>deepest pool</span>' : '') + (r.lowLiquidity ? '<span class="warn">⚠ Very low liquidity</span>' : '') +
          '<span class="mono">' + esc(UI.shortAddr(r.meta.pairAddress)) + '</span></span></button>';
      }
      return '<button type="button" class="result" data-t="result" data-i="' + i + '"><span class="result__main">' + esc(r.symbol) + ' <small>' + esc(r.name || '') + '</small></span>' +
        '<span class="result__side">' + esc(r.type === 'etf' ? 'ETF' : r.type === 'stock' ? 'Stock' : r.meta && r.meta.rank ? '#' + r.meta.rank : '') + '</span>' +
        (r.meta && r.meta.exchange ? '<span class="result__meta">' + esc(r.meta.exchange) + '</span>' : '') + '</button>';
    });
    if (f.type !== 'memecoin' && txt.trim() && /^[A-Za-z0-9.\-^=]{1,15}$/.test(txt.trim())) {
      items.push('<button type="button" class="result result--manual" data-t="manual"><span class="result__main">Use “' + esc(txt.trim().toUpperCase()) + '” as entered</span>' +
        '<span class="result__meta">For a thinly-covered ticker that search doesn\'t find' + (f.type === 'crypto' ? ' — you may need to pin a manual price' : '') + '</span></button>');
    }
    host.innerHTML = '<div class="results" role="list">' + (items.length ? items.join('') : '') +
      (f.resultMsg ? '<p class="results__msg">' + f.resultMsg + '</p>' : '') + (!items.length && !f.resultMsg ? '<p class="results__msg">No matches.</p>' : '') + '</div>';
  }

  /* ---------------- search ---------------- */
  const runSearch = U.debounce(async function () {
    if (!dlg || f.asset) return;
    const input = dlg.querySelector('#t-search');
    const text = input ? input.value.trim() : '';
    const seq = ++searchSeq;
    if (text.length < (f.type === 'memecoin' ? 3 : 1)) { f.results = null; f.resultMsg = ''; renderResults(); return; }
    f.results = null; f.resultMsg = 'Searching…'; renderResults();
    const settings = PT.app.state.settings;
    let results = [], errors = [];
    if (f.type === 'memecoin') {
      const inp = PR.parseDexInput(text);
      if (inp.chain && inp.chain !== f.chain) {
        f.chain = inp.chain;
        const sel = dlg.querySelector('#t-chain');
        if (sel) {
          if (![...sel.options].some(o => o.value === inp.chain)) sel.add(new Option(inp.chain + ' (from link)', inp.chain));
          sel.value = inp.chain;
        }
      }
      try { results = await PR.dexscreener.search(text, { chain: f.chain }); }
      catch (e) { errors.push(PR.describeError(e, { symbol: text }, settings, PR.dexscreener)); }
      if (seq !== searchSeq || !dlg || f.asset) return;
      if (results.length === 1 && inp.address) {        // unambiguous: select outright
        choose(results[0]);
        UI.toast('Found ' + results[0].symbol + ' on ' + results[0].meta.chain + ' (' + (results[0].meta.dex || 'DEX') + ')', 'ok', 2200);
        return;
      }
      f.results = results;
      f.resultMsg = errors.length ? esc(errors[0]) : !results.length ? (inp.address ? 'Dexscreener has no indexed pair for that address' + (f.chain ? ' on ' + esc(f.chain) : '') + '. Check the address and chain.' : 'No pools match. Paste the contract address for an exact match.')
        : inp.query ? 'Names aren\'t unique — check the chain and contract before choosing.' : results.length + ' pools trade this token — choose one (deepest first).';
      renderResults();
      return;
    }
    const provs = PR.searchProvidersFor(f.type, settings);
    for (const p of provs) {
      try { const r = await p.search(text, { settings }); if (r && r.length) { results = r; break; } }
      catch (e) { errors.push(PR.describeError(e, { symbol: text, type: f.type }, settings, p)); }
    }
    if (seq !== searchSeq || !dlg || f.asset) return;
    if (f.type === 'stock' || f.type === 'etf') {
      const same = results.filter(r => r.type === f.type), other = results.filter(r => r.type !== f.type);
      results = same.concat(other);
    }
    f.results = results;
    f.resultMsg = errors.length && !results.length ? 'Search unavailable: ' + esc(errors[0]) + ' You can still use the ticker as entered.' :
      !provs.length ? 'Search needs a relay or a Finnhub key (Settings). You can still use the ticker as entered.' : '';
    renderResults();
  }, 350);

  function choose(r) {
    const type = f.type === 'stock' || f.type === 'etf' ? f.type : r.type;
    f.asset = { type, symbol: r.symbol.toUpperCase(), name: r.name || r.symbol, meta: Object.assign({}, r.meta), priceUsd: U.isNum(r.price) ? r.price : null, manual: !!r.manual };
    // Dexscreener gives a contract: keep only identity fields in the stored metadata
    if (f.asset.type === 'memecoin') {
      const m = r.meta;
      f.asset.meta = { chain: m.chain, pairAddress: m.pairAddress, contract: m.contract, dex: m.dex, quoteSymbol: m.quoteSymbol };
    }
    f.results = null; f.resultMsg = '';
    // If this asset is already held under a different type selection, follow the holding.
    renderAsset(); clearError('asset'); prefillPrice(); update();
    const q = qtyInput(); if (q) q.focus();
    if (!U.isNum(f.asset.priceUsd) && livePriceUsd(f.asset) == null && !f.asset.manual) fetchPrice(f.asset);
  }

  async function fetchPrice(asset) {
    const settings = PT.app.state.settings;
    const pos = Object.assign({ key: P.assetKey(asset) }, asset);
    for (const p of PR.providerFor(pos, settings)) {
      try {
        const q = await p.quote(pos, { settings });
        if (f && f.asset === asset) { asset.priceUsd = q.price; asset.priceSource = q.source; prefillPrice(); update(); }
        return;
      } catch (e) { if (e.kind === 'noroute') break; }
    }
    if (f && f.asset === asset) { const h = dlg.querySelector('#t-pricehint'); if (h) h.textContent = 'No live price found — enter the price you paid.'; }
  }

  function prefillPrice() {
    if (!dlg) return;
    const hint = dlg.querySelector('#t-pricehint');
    const input = dlg.querySelector('#t-price');
    if (!f.asset) { hint.innerHTML = ''; return; }
    const usd = livePriceUsd(f.asset);
    if (usd == null) { hint.innerHTML = f.asset.manual ? 'Entered manually — type the price you paid.' : ''; return; }
    const v = usdToCur(usd, f.currency);
    if (!f.priceTouched) input.value = trimNum(v);
    hint.innerHTML = '<span>Current ' + F.priceIn(v, f.currency) + '</span>' + (f.priceTouched ? '<button type="button" class="btn btn--ghost btn--sm" data-t="use-price">Use current price</button>' : '');
  }

  /* ---------------- live total & impact ---------------- */
  function values() {
    const $ = id => dlg.querySelector('#' + id);
    const price = U.parseNum($('t-price').value);
    let q, amt = null;
    if (byAmount()) {
      // quantity = amount ÷ price, kept at full precision (never rounded)
      amt = U.parseNum($('t-amount').value);
      q = U.isNum(amt) && U.isNum(price) && price > 0 ? amt / price : NaN;
    } else {
      q = U.parseNum($('t-qty').value);
      // A sell that matches the whole holding up to float noise IS the whole holding — never leave dust.
      if (f.side === 'sell' && U.isNum(q)) { const pos = currentPos(); if (pos) q = P.snapToHolding(q, pos.qty); }
    }
    return {
      q, amt, p: price, fees: $('t-fees').value.trim() === '' ? 0 : U.parseNum($('t-fees').value),
      date: $('t-date').value, notes: $('t-notes').value, cur: $('t-cur').value
    };
  }

  function update() {
    if (!dlg) return;
    const v = values(), cur = v.cur;
    const pos = currentPos();
    const hold = dlg.querySelector('#t-hold');
    if (f.asset && f.side === 'sell') {
      hold.innerHTML = pos ? '<span>You hold <strong class="num">' + F.qtyFull(pos.qty) + '</strong> ' + esc(pos.symbol) + '</span><button type="button" class="btn btn--sm" data-t="sell-all">Sell all</button>'
        : '<span class="is-loss">You don\'t hold any ' + esc(f.asset.symbol) + ' right now.</span>';
    } else if (f.asset && pos) hold.innerHTML = '<span>You hold ' + F.qty(pos.qty) + ' ' + esc(pos.symbol) + '</span>';
    else hold.innerHTML = '';

    const conv = dlg.querySelector('#t-conv');
    if (byAmount()) {
      conv.innerHTML = !U.isNum(v.amt) ? '' : !(v.p > 0) ? '<span>Enter the price per unit to work out how much that buys.</span>'
        : '<span>= <strong class="num">' + esc(F.qtyFull(v.q)) + '</strong> ' + unitWord(v.q) + ' at ' + esc(F.priceIn(v.p, cur)) + '</span>';
    } else if (f.side === 'buy' && U.isNum(v.q) && U.isNum(v.p)) {
      conv.innerHTML = '<span>= ' + esc(F.moneyIn(v.q * v.p, cur, { tiny: true })) + ' invested</span>';
    } else conv.innerHTML = '';

    const tot = dlg.querySelector('#t-total');
    const ok = U.isNum(v.q) && U.isNum(v.p);
    const fees = U.isNum(v.fees) ? v.fees : 0;
    const gross = ok ? (byAmount() ? v.amt : v.q * v.p) : null;
    const total = ok ? (f.side === 'sell' ? gross - fees : gross + fees) : null;
    tot.innerHTML = '<div class="total" aria-live="polite"><div><div class="total__label">' + (f.side === 'sell' ? 'Proceeds' : 'Total cost') + '</div>' +
      '<div class="total__calc">' + (ok ? esc((byAmount() ? F.moneyIn(v.amt, cur) + ' invested' : F.qtyFull(v.q) + ' × ' + F.priceIn(v.p, cur)) +
        (fees ? (f.side === 'sell' ? ' − ' : ' + ') + F.moneyIn(fees, cur) + ' fees' : '')) :
        (byAmount() ? 'amount + fees' : 'quantity × price ' + (f.side === 'sell' ? '− fees' : '+ fees'))) + '</div></div>' +
      '<div class="total__value">' + (total == null ? '—' : F.moneyIn(total, cur, { tiny: true })) + '</div></div>';

    // cash reserve line
    const avail = cashAvailable();
    const moveUsd = total == null ? null : curToUsd(f.side === 'sell' ? total : -total, cur);
    dlg.querySelector('#t-cash-label').textContent = f.side === 'sell' ? 'Add proceeds to cash reserve' : 'Pay from cash reserve';
    const sub = dlg.querySelector('#t-cash-sub');
    if (f.useCash && moveUsd != null) {
      const after = avail + moveUsd;
      sub.innerHTML = 'Cash ' + F.money(avail) + ' → <strong>' + F.money(after) + '</strong>' +
        (after < -P.CASH_TOLERANCE ? ' <span class="is-loss">— not enough cash</span>' : '');
    } else {
      sub.textContent = (f.side === 'sell' ? 'Balance ' : 'Available ') + F.money(avail) + (f.useCash ? '' : ' · untouched by this trade');
    }

    const imp = dlg.querySelector('#t-impact');
    if (pos && ok && v.q > 0) {
      const pr = P.preview(pos, f.side, v.q, curToUsd(v.p, cur), curToUsd(fees, cur));
      if (pr && pr.oversell) imp.innerHTML = '<div class="banner banner--error" style="margin:0">' + UI.icon('warn') + '<span>That\'s more than you hold (' + F.qtyFull(pos.qty) + ' ' + esc(pos.symbol) + '). Use Sell all to sell exactly that.</span></div>';
      else if (pr) {
        imp.innerHTML = '<dl class="impact" aria-label="Effect of this trade">' +
          '<div><dt>Now</dt><dd>' + F.qty(pos.qty) + ' @ ' + F.price(pos.avgEntry) + '<small>avg entry</small></dd></div>' +
          '<div><dt>After this ' + f.side + '</dt><dd>' + F.qty(pr.qty) + (pr.qty > 0 ? ' @ ' + F.price(pr.avg) : '') + '<small>' + (f.side === 'sell' ? (pr.qty > 0 ? 'avg entry unchanged' : 'position closed') : 'new avg entry') + '</small></dd></div>' +
          '<div><dt>' + (f.side === 'sell' ? 'Realised P&L' : 'New total invested') + '</dt><dd>' + (f.side === 'sell' ? UI.pl(pr.realised, null) : F.money(pr.invested)) +
            '<small>' + (f.side === 'sell' ? 'remaining invested ' + F.money(pr.invested) : 'was ' + F.money(pos.invested)) + '</small></dd></div></dl>';
      }
    } else imp.innerHTML = '';
  }

  /* ---------------- errors ---------------- */
  const FIELD_CONTROL = { type: 't-type', side: 't-side', asset: 't-search', quantity: 't-qty', price: 't-price', fees: 't-fees', date: 't-date', cash: 't-usecash' };
  const ctlId = field => (field === 'quantity' && byAmount() ? 't-amount' : FIELD_CONTROL[field]);
  function clearError(field) {
    const box = dlg && dlg.querySelector('#fld-' + field);
    if (!box) return;
    box.classList.remove('is-invalid');
    box.querySelectorAll('.field-error').forEach(e => e.remove());
    const c = dlg.querySelector('#' + ctlId(field));
    if (c) c.removeAttribute('aria-invalid');
  }
  function showErrors(errs) {
    Object.keys(FIELD_CONTROL).forEach(clearError);
    errs.forEach(e => {
      const box = dlg.querySelector('#fld-' + e.field);
      if (!box) return;
      box.classList.add('is-invalid');
      const p = document.createElement('p');
      p.className = 'field-error'; p.id = 'err-' + e.field; p.textContent = e.msg;
      box.appendChild(p);
      const c = dlg.querySelector('#' + ctlId(e.field)) || box;
      c.setAttribute('aria-invalid', 'true');
      c.setAttribute('aria-describedby', 'err-' + e.field);
    });
    // Scroll to and highlight the first problem — the form is tall enough that it may be off-screen.
    const first = errs[0];
    const box = dlg.querySelector('#fld-' + first.field);
    let ctl = dlg.querySelector('#' + ctlId(first.field));
    if (first.field === 'asset' && !ctl) ctl = dlg.querySelector('.pick') || box;
    const target = ctl || box;
    const smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    const hl = first.field === 'asset' ? box : (ctl && ctl.classList.contains('input') ? ctl : box);
    hl.classList.remove('flash'); void hl.offsetWidth; hl.classList.add('flash');
    if (ctl && ctl.focus) ctl.focus({ preventScroll: true });
  }

  /* ---------------- events ---------------- */
  function onClick(e) {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = b.dataset.t;
    if (t === 'close') close();
    else if (t === 'entry') setEntry(b.dataset.v);
    else if (t === 'type' && !f.locked) {
      f.type = b.dataset.v; f.asset = null; f.results = null; f.resultMsg = ''; f.chain = '';
      renderType(); renderAsset(); clearError('type'); prefillPrice(); update();
      const s = dlg.querySelector('#t-search'); if (s) s.focus();
    } else if (t === 'side') {
      const before = values();
      f.side = b.dataset.v;
      // leaving amount mode for a sell: carry the computed quantity into the units box
      if (f.side === 'sell' && f.entry === 'amount' && U.isNum(before.q)) dlg.querySelector('#t-qty').value = exactNum(before.q);
      renderEntry();
      if (!f.cashTouched && f.mode === 'add') { f.useCash = defaultUseCash(f.side); dlg.querySelector('#t-usecash').checked = f.useCash; }
      renderSide(); if (!f.asset) renderAsset(); update(); clearError('quantity'); clearError('cash');
    } else if (t === 'pick') {
      const p = heldPositions().find(x => x.key === b.dataset.key);
      if (!p) return;
      f.type = p.type; renderType();
      f.asset = { type: p.type, symbol: p.symbol, name: p.name, meta: Object.assign({}, p.meta) };
      renderAsset(); clearError('asset'); prefillPrice(); update();
      qtyInput().focus();
    } else if (t === 'change') {
      f.asset = null; f.priceTouched = false; renderAsset(); update();
      const s = dlg.querySelector('#t-search'); if (s) s.focus();
    } else if (t === 'result') {
      choose(f.results[+b.dataset.i]);
    } else if (t === 'manual') {
      const txt = dlg.querySelector('#t-search').value.trim().toUpperCase();
      choose({ symbol: txt, name: txt, type: f.type, meta: {}, manual: true });
    } else if (t === 'sell-all') {
      const pos = currentPos();
      if (pos) { dlg.querySelector('#t-qty').value = exactNum(pos.qty); clearError('quantity'); update(); }
    } else if (t === 'use-price') {
      f.priceTouched = false; prefillPrice(); update();
    }
  }

  function onInput(e) {
    const id = e.target.id;
    if (id === 't-search') { if (e.type === 'input') runSearch(); return; }
    if (id === 't-chain') { f.chain = e.target.value; runSearch(); return; }
    if (id === 't-price') { f.priceTouched = true; clearError('price'); prefillPrice(); }
    if (id === 't-cur') { f.currency = e.target.value; prefillPrice(); }   // a typed price is kept as typed
    if (id === 't-qty' || id === 't-amount') clearError('quantity');
    if (id === 't-cur') renderEntry();
    if (id === 't-fees') clearError('fees');
    if (id === 't-date') clearError('date');
    if (id === 't-usecash') { f.useCash = e.target.checked; f.cashTouched = true; clearError('cash'); }
    update();
  }

  function onSubmit(e) {
    e.preventDefault();
    const v = values();
    const a = f.asset;
    const raw = {
      id: f.editId || undefined,
      type: a ? a.type : f.type, symbol: a ? a.symbol : '', name: a ? a.name : '', side: f.side,
      quantity: v.q, price: v.p, fees: v.fees, currency: v.cur, date: U.fromLocalInput(v.date), notes: v.notes.trim(),
      entry: byAmount() ? 'amount' : undefined, amount: byAmount() ? v.amt : undefined,
      meta: a ? a.meta : {}
    };
    if (f.mode === 'edit') {
      const old = PT.app.state.txs.find(t => t.id === f.editId);
      raw.createdAt = old ? old.createdAt : Date.now();
    }
    const tx = P.normalise(raw);
    if (!U.isNum(v.q)) tx.quantity = NaN;
    if (!U.isNum(v.p)) tx.price = NaN;
    if (!U.isNum(v.fees)) tx.fees = NaN;
    if (!a) tx.symbol = '';
    let errs = P.validate(tx, PT.app.state.txs, PT.app.state.rates);
    if (byAmount()) {
      // Say what's missing in terms of the amount, not the derived quantity.
      errs = errs.filter(e => e.field !== 'quantity');
      if (!(U.isNum(v.amt) && v.amt > 0)) errs.unshift({ field: 'quantity', msg: 'Enter how much you invested, in ' + (v.cur === 'EUR' ? 'euros' : 'dollars') + ' — or switch to Units to enter a quantity.' });
      if (!(v.p > 0)) {
        errs = errs.filter(e => e.field !== 'price');
        errs.push({ field: 'price', msg: 'Enter the price per unit you paid — it\'s needed to work out how many ' + unitWord(2) + ' your amount bought.' });
      }
      const order = ['type', 'side', 'asset', 'quantity', 'price', 'date', 'fees', 'cash'];
      errs.sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field));
    }
    // Cash reserve: the balance may never end up below zero.
    let cashEntry = null;
    if (!errs.length) {
      const avail = cashAvailable();
      const move = f.useCash ? P.tradeCash(tx, PT.app.state.rates) : 0;
      if (avail + move < -P.CASH_TOLERANCE) {
        errs.push({ field: 'cash', msg: f.useCash && tx.side === 'buy'
          ? 'Your cash reserve has ' + F.money(avail) + ' available — this buy costs ' + F.money(-move) + '. Add cash on the Cash page first, or untick "Pay from cash reserve" if you paid from elsewhere.'
          : 'This would take your cash reserve to ' + F.money(avail + move) + ', because cash from this sale has already been spent. Keep "Add proceeds to cash reserve" ticked, or add cash first.' });
      }
      if (f.useCash) cashEntry = { id: f.linkedCash ? f.linkedCash.id : U.uid('cash'), date: tx.date, kind: 'trade', amount: move, note: '' };
    }
    if (errs.length) { showErrors(errs); return; }
    try {
      PT.store.book.saveTrade(tx, cashEntry, f.mode === 'edit');
    } catch (err) {
      UI.toast('Couldn\'t save: ' + err.message, 'error'); return;
    }
    UI.toast((f.mode === 'edit' ? 'Saved ' : 'Added ') + tx.side + ' of ' + F.qty(tx.quantity) + ' ' + tx.symbol +
      (cashEntry ? (cashEntry.amount < 0 ? ' — ' + F.money(-cashEntry.amount) + ' from cash' : ' — ' + F.money(cashEntry.amount) + ' to cash') : ''), 'ok');
    close();
  }

  PT.modal = { open, close, isOpen: () => !!dlg };
})(window.PT);
