/* ==========================================================================
   pie.js — "Invest in pie": one dollar amount spread across your stocks and
   ETFs by target weights (like a Trading212 pie).
   --------------------------------------------------------------------------
   • The pie (target split) is YOUR data: saved in PT.store.book.
   • Investing creates one ordinary buy per slice (entered as an amount), all
     tagged with the same `batch` id — so every buy is a normal transaction
     you can edit or delete individually, and positions/P&L need no special
     handling.
   • The amount is split into whole cents that add up exactly to what you
     typed; fees (if any) are split the same way.
   • Stocks & ETFs only — crypto and memecoins are deliberately left out.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc, UI = PT.ui, P = PT.portfolio, C = PT.config, book = PT.store.book;
  const PIE_TYPES = ['stock', 'etf'];
  const TOL = 0.01;                          // weights must total 100 ± 0.01

  let draft = null;                          // slices being edited (null = no unsaved edits)
  const prices = {};                         // key -> price text the user typed for this investment

  const tidy = v => (U.isNum(v) ? String(+v.toPrecision(10)) : '');

  /* ---------------- the pie ---------------- */

  /** Fill in name / meta for a slice from what you hold, else the seed list. */
  function resolve(slice, app) {
    const key = P.assetKey(slice);
    const pos = app.state.derived.positions[key];
    const seed = C.SEED_HOLDINGS.find(h => h.type === slice.type && h.symbol === slice.symbol);
    return {
      type: slice.type, symbol: String(slice.symbol).toUpperCase(),
      name: slice.name || (pos && pos.name) || (seed && seed.name) || slice.symbol,
      meta: Object.assign({}, (seed && seed.meta) || {}, (pos && pos.meta) || {}, slice.meta || {}),
      weight: +slice.weight, key
    };
  }
  function savedPie(app) {
    const p = book.pie();
    const slices = p && Array.isArray(p.slices) ? p.slices : C.DEFAULT_PIE;
    return { slices: slices.map(s => resolve(s, app)), saved: !!p, savedAt: p && p.savedAt };
  }
  const current = app => (draft ? { slices: draft, saved: false, dirty: true } : savedPie(app));
  const sumW = slices => slices.reduce((a, s) => a + (U.isNum(s.weight) ? s.weight : 0), 0);
  const weightsOk = slices => slices.length > 0 && slices.every(s => s.weight > 0) && Math.abs(sumW(slices) - 100) <= TOL;

  function livePrice(app, key) {
    const r = app.state.summary.rows.find(x => x.key === key);
    return r && r.priced ? r.price : null;
  }

  /* ---------------- drift: where the pie is now vs its targets ---------------- */
  function driftHtml(app) {
    const pie = savedPie(app);
    const rows = pie.slices.map(s => {
      const r = app.state.summary.rows.find(x => x.key === s.key);
      return { s, value: r && r.priced ? r.value : null };
    });
    const priced = rows.filter(x => x.value != null);
    const total = priced.reduce((a, x) => a + x.value, 0);
    const missing = rows.length - priced.length;
    return '<div class="pie-drift">' + rows.map(x => {
      const now = x.value != null && total > 0 ? (x.value / total) * 100 : null;
      const d = now == null ? null : now - x.s.weight;
      return '<div class="pie-drift__row"><span class="pie-drift__name"><span class="swatch swatch--' + x.s.type + '" aria-hidden="true"></span>' + esc(x.s.symbol) + '</span>' +
        '<span class="pie-drift__bars" role="img" aria-label="' + esc(x.s.symbol) + ': target ' + x.s.weight + '%, now ' + (now == null ? 'unknown' : now.toFixed(1) + '%') + '">' +
          '<span class="pie-drift__target" style="width:' + Math.min(100, x.s.weight) + '%"></span>' +
          (now == null ? '' : '<span class="pie-drift__now" style="width:' + Math.min(100, now).toFixed(2) + '%;background:var(--c-' + x.s.type + ')"></span>') + '</span>' +
        '<span class="pie-drift__nums num">' + (now == null ? '—' : F.pct(now, { plain: true })) + ' <span class="muted">/ ' + x.s.weight + '%</span></span>' +
        '<span class="pie-drift__d num ' + (d == null ? '' : Math.abs(d) < 0.5 ? 'muted' : '') + '">' +
          (d == null ? '<span class="muted">no price</span>' : Math.abs(d) < 0.05 ? 'on target' : (d > 0 ? '▲ +' : '▼ −') + Math.abs(d).toFixed(1) + ' pts ' + (d > 0 ? 'over' : 'under')) + '</span></div>';
    }).join('') + '</div>' +
      '<p class="field__hint" style="margin-top:10px">Actual share of the pie\'s current value' + (total > 0 ? ' (' + F.money(total) + ')' : '') + ' vs your target.' +
      (missing ? ' ' + missing + ' slice' + (missing > 1 ? 's have' : ' has') + ' no price yet, so shares are of the priced slices only.' : '') + '</p>';
  }

  /* ---------------- editor ---------------- */
  function editorHtml(app) {
    const pie = current(app);
    const total = sumW(pie.slices);
    const ok = weightsOk(pie.slices);
    const inPie = new Set(pie.slices.map(s => s.key));
    const addable = Object.values(app.state.derived.positions)
      .filter(p => p.open && PIE_TYPES.includes(p.type) && !inPie.has(p.key)).sort((a, b) => a.symbol.localeCompare(b.symbol));
    return '<div class="pie-slices">' + pie.slices.map((s, i) =>
      '<div class="pie-slice">' + PT.views.assetCell(s) +
        '<label class="pie-slice__w"><span class="sr-only">' + esc(s.symbol) + ' target weight in percent</span>' +
          '<input class="input input--sm num" inputmode="decimal" data-pie-w="' + i + '" value="' + esc(tidy(s.weight)) + '" aria-describedby="pie-total"><span aria-hidden="true">%</span></label>' +
        '<button type="button" class="btn btn--ghost btn--sm btn--icon" data-pie-rm="' + i + '" aria-label="Remove ' + esc(s.symbol) + ' from the pie"' + (pie.slices.length < 2 ? ' disabled' : '') + '>' + UI.icon('close') + '</button></div>'
    ).join('') + '</div>' +
      '<div class="pie-total ' + (ok ? 'is-ok' : 'is-bad') + '" id="pie-total" role="status">' +
        (ok ? '✓ Weights total 100%' : '⚠ Weights total ' + (+total.toFixed(2)) + '% — they must add up to exactly 100%' + (pie.slices.some(s => !(s.weight > 0)) ? ', and each slice needs a weight above 0' : '') + '.') + '</div>' +
      '<div class="row" style="gap:8px">' +
        (addable.length ? '<select class="select select--sm" id="pie-add" aria-label="Add a stock or ETF to the pie" style="flex:1 1 160px;width:auto"><option value="">Add a stock or ETF…</option>' +
          addable.map(p => '<option value="' + esc(p.key) + '">' + esc(p.symbol + ' — ' + p.name) + '</option>').join('') + '</select>' : '') +
        '<button type="button" class="btn btn--sm" data-pie="equal">Split equally</button>' +
        (pie.dirty ? '<button type="button" class="btn btn--sm btn--ghost" data-pie="discard">Discard changes</button>' : '') +
        '<button type="button" class="btn btn--sm btn--primary" data-pie="save"' + (pie.dirty ? '' : ' disabled') + '>Save pie</button></div>' +
      (!savedPie(app).saved && !pie.dirty ? '<p class="field__hint">This is the starting split from <code>js/config.js</code>. Change the weights and press Save to make it yours.</p>' : '');
  }

  /* ---------------- invest form ---------------- */
  function investHtml(app) {
    const cash = app.state.cash;
    const useCash = cash.balance > P.CASH_TOLERANCE;
    return '<div class="trade-grid">' +
        '<div class="field" id="fld-pie-amount"><label for="pie-amount">Amount to invest (USD)</label>' +
          '<div class="input-affix"><span class="input-affix__sym" aria-hidden="true">$</span><input class="input num" id="pie-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"></div></div>' +
        '<div class="field" id="fld-pie-date"><label for="pie-date">Date & time</label><input class="input" type="datetime-local" id="pie-date" value="' + U.toLocalInput(Date.now()) + '"></div>' +
        '<div class="field" id="fld-pie-fees"><label for="pie-fees">Total fees <span class="muted">(optional, split by weight)</span></label>' +
          '<div class="input-affix"><span class="input-affix__sym" aria-hidden="true">$</span><input class="input num" id="pie-fees" inputmode="decimal" autocomplete="off" placeholder="0"></div></div>' +
        '<div class="field" id="fld-pie-cash" style="justify-content:flex-end"><label class="cash-opt"><input type="checkbox" id="pie-usecash"' + (useCash ? ' checked' : '') + '>' +
          '<span><strong>Pay from cash reserve</strong><span class="cash-opt__sub" id="pie-cash-sub">Available ' + F.money(cash.balance) + '</span></span></label></div>' +
      '</div>' +
      '<div id="pie-preview"></div>' +
      '<div class="total" style="margin-top:4px"><div><div class="total__label">Total cost</div><div class="total__calc" id="pie-calc">amount + fees</div></div>' +
        '<div class="total__value" id="pie-total-cost">—</div></div>' +
      '<div class="row" style="justify-content:flex-end"><button type="submit" class="btn btn--primary" id="pie-buy">Buy pie</button></div>';
  }

  function readForm() {
    const g = id => document.getElementById(id);
    const feesTxt = g('pie-fees').value.trim();
    return { amount: U.parseNum(g('pie-amount').value), fees: feesTxt === '' ? 0 : U.parseNum(feesTxt),
      date: U.fromLocalInput(g('pie-date').value), useCash: g('pie-usecash').checked };
  }

  /** The per-slice plan for the amount typed: split, price, units. */
  function plan(app) {
    const pie = savedPie(app);
    const f = readForm();
    const w = pie.slices.map(s => s.weight);
    const amts = U.isNum(f.amount) && f.amount > 0 ? P.splitAmount(f.amount, w) : pie.slices.map(() => null);
    const fees = U.isNum(f.fees) && f.fees > 0 ? P.splitAmount(f.fees, w) : pie.slices.map(() => 0);
    return { pie, f, rows: pie.slices.map((s, i) => {
      const typed = prices[s.key];
      const price = typed != null ? U.parseNum(typed) : livePrice(app, s.key);
      return { s, amount: amts[i], fee: fees[i], price, priceText: typed != null ? typed : tidy(livePrice(app, s.key)),
        units: amts[i] != null && price > 0 ? amts[i] / price : null, live: livePrice(app, s.key) };
    }) };
  }

  function renderPreview(app) {
    const host = document.getElementById('pie-preview');
    if (!host) return;
    const pl = plan(app);
    const unit = s => (s.type === 'stock' ? 'shares' : 'units');
    // Build once; afterwards only update the numbers, so typing in a price box never loses focus.
    if (!host.querySelector('table')) {
      host.innerHTML = '<div class="table-wrap table-wrap--cards"><table class="tbl pie-plan"><caption class="sr-only">How the amount is split</caption>' +
        '<thead><tr><th scope="col">Slice</th><th scope="col" class="r">Target</th><th scope="col" class="r">Amount</th><th scope="col" class="r">Price per unit</th><th scope="col" class="r">Buys</th></tr></thead><tbody>' +
        pl.rows.map((r, i) => '<tr><td data-label="Slice"><span class="type-tag"><span class="swatch swatch--' + r.s.type + '" aria-hidden="true"></span><strong>' + esc(r.s.symbol) + '</strong></span></td>' +
          '<td data-label="Target" class="r num">' + tidy(r.s.weight) + '%</td>' +
          '<td data-label="Amount" class="r num" data-pie-amt="' + i + '"></td>' +
          '<td data-label="Price per unit" class="r" id="fld-pie-price-' + i + '"><div class="input-affix pie-price"><span class="input-affix__sym" aria-hidden="true">$</span>' +
            '<input class="input input--sm num" inputmode="decimal" data-pie-price="' + esc(r.s.key) + '" id="pie-price-' + i + '" aria-label="' + esc(r.s.symbol) + ' price per unit" value="' + esc(r.priceText) + '" placeholder="price"></div></td>' +
          '<td data-label="Buys" class="r num" data-pie-units="' + i + '"></td></tr>').join('') +
        '</tbody></table></div>';
    }
    pl.rows.forEach((r, i) => {
      host.querySelector('[data-pie-amt="' + i + '"]').textContent = r.amount == null ? '—' : F.moneyIn(r.amount, 'USD') + (r.fee ? ' + ' + F.moneyIn(r.fee, 'USD') + ' fee' : '');
      host.querySelector('[data-pie-units="' + i + '"]').textContent = r.units == null ? '—' : F.qtyFull(r.units) + ' ' + unit(r.s);
    });
    const f = pl.f;
    const cost = (U.isNum(f.amount) ? f.amount : 0) + (U.isNum(f.fees) ? f.fees : 0);
    document.getElementById('pie-total-cost').textContent = U.isNum(f.amount) && f.amount > 0 ? F.moneyIn(cost, 'USD') : '—';
    document.getElementById('pie-calc').textContent = U.isNum(f.amount) && f.amount > 0
      ? F.moneyIn(f.amount, 'USD') + ' across ' + pl.rows.length + ' holdings' + (f.fees > 0 ? ' + ' + F.moneyIn(f.fees, 'USD') + ' fees' : '') : 'amount + fees';
    const bal = app.state.cash.balance;
    document.getElementById('pie-cash-sub').innerHTML = f.useCash && U.isNum(f.amount) && f.amount > 0
      ? 'Cash ' + F.money(bal) + ' → <strong>' + F.money(bal - cost) + '</strong>' + (bal - cost < -P.CASH_TOLERANCE ? ' <span class="is-loss">— not enough cash</span>' : '')
      : 'Available ' + F.money(bal);
  }

  /* ---------------- view ---------------- */
  function view(root, app) {
    const pie = savedPie(app);
    if (PT.store.book.readOnly) {
      root.innerHTML =
        '<header class="page-head"><div><p class="eyebrow">' + UI.icon('pie') + ' Stocks & ETFs</p><h1 class="page-title">Pie</h1></div>' +
        '<div class="page-head__meta"><span>Target split for new money, and how the holdings compare today</span></div></header>' +
        '<div class="stack"><section class="card" aria-labelledby="pie-d-t"><div class="card__head" style="margin-bottom:6px"><div><h2 class="card__title" id="pie-d-t">Now vs target</h2>' +
        '<p class="card__sub">Saved split</p></div></div><div id="pie-drift">' + driftHtml(app) + '</div></section></div>';
      return;
    }
    root.innerHTML =
      '<header class="page-head"><div><p class="eyebrow">' + UI.icon('pie') + ' Stocks & ETFs</p><h1 class="page-title">Pie</h1></div>' +
      '<div class="page-head__meta"><span>Invest one amount across your stocks and ETFs by target weights</span></div></header>' +
      '<div class="stack">' +
      '<div class="grid-2 grid-2--even">' +
        '<section class="card" aria-labelledby="pie-e-t"><div class="card__head" style="margin-bottom:6px"><div><h2 class="card__title" id="pie-e-t">Target split</h2>' +
          '<p class="card__sub">Stocks & ETFs only</p></div></div><div id="pie-editor" class="stack" style="gap:12px">' + editorHtml(app) + '</div></section>' +
        '<section class="card" aria-labelledby="pie-d-t"><div class="card__head" style="margin-bottom:6px"><div><h2 class="card__title" id="pie-d-t">Now vs target</h2>' +
          '<p class="card__sub">Saved split</p></div></div><div id="pie-drift">' + driftHtml(app) + '</div></section>' +
      '</div>' +
      '<section class="card" aria-labelledby="pie-i-t"><div class="card__head"><div><h2 class="card__title" id="pie-i-t">Invest in pie</h2>' +
        '<p class="card__sub">One buy per slice is recorded — each is a normal transaction you can edit or delete later</p></div></div>' +
        '<div id="pie-unsaved" class="banner" hidden>' + UI.icon('warn') + '<span>You have unsaved changes to the split. Save or discard them before investing — the saved split is what gets bought.</span></div>' +
        '<form id="pie-form" class="stack" style="gap:14px" novalidate>' + investHtml(app) + '</form></section>' +
      '</div>';
    document.getElementById('pie-unsaved').hidden = !draft;
    renderPreview(app);
    bind(root, app);
  }

  function rerenderEditor(app) {
    const host = document.getElementById('pie-editor');
    const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.pieW : null;
    const sel = active != null ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    host.innerHTML = editorHtml(app);
    document.getElementById('pie-unsaved').hidden = !draft;
    if (active != null) {
      const el = host.querySelector('[data-pie-w="' + active + '"]');
      if (el) { el.focus(); try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* ignore */ } }
    }
  }

  function fieldError(id, msg, focusId) {
    const box = document.getElementById('fld-' + id);
    if (!box) return;
    box.querySelectorAll('.field-error').forEach(x => x.remove());
    box.classList.toggle('is-invalid', !!msg);
    const input = document.getElementById(focusId || id);
    if (!msg) { if (input) input.removeAttribute('aria-invalid'); return; }
    const p = document.createElement('p'); p.className = 'field-error'; p.id = 'err-' + id; p.textContent = msg;
    box.appendChild(p);
    if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', p.id); input.focus(); input.scrollIntoView({ block: 'center' }); }
    return true;
  }
  function clearErrors() {
    document.querySelectorAll('#pie-form .field-error').forEach(x => x.remove());
    document.querySelectorAll('#pie-form .is-invalid').forEach(x => x.classList.remove('is-invalid'));
  }

  function bind(root, app) {
    const editor = root.querySelector('#pie-editor');
    const ensureDraft = () => { if (!draft) draft = savedPie(app).slices.map(s => Object.assign({}, s)); };
    editor.addEventListener('input', e => {
      const i = e.target.dataset.pieW;
      if (i == null) return;
      ensureDraft();
      draft[+i].weight = U.parseNum(e.target.value);
      rerenderEditor(app);
    });
    editor.addEventListener('change', e => {
      if (e.target.id !== 'pie-add' || !e.target.value) return;
      ensureDraft();
      const pos = app.state.derived.positions[e.target.value];
      draft.push(resolve({ type: pos.type, symbol: pos.symbol, name: pos.name, meta: pos.meta, weight: 0 }, app));
      rerenderEditor(app);
      const last = editor.querySelector('[data-pie-w="' + (draft.length - 1) + '"]'); if (last) last.focus();
    });
    editor.addEventListener('click', async e => {
      const rm = e.target.closest('[data-pie-rm]');
      if (rm) { ensureDraft(); draft.splice(+rm.dataset.pieRm, 1); rerenderEditor(app); return; }
      const b = e.target.closest('[data-pie]');
      if (!b) return;
      if (b.dataset.pie === 'equal') {
        ensureDraft();
        // equal split in hundredths of a percent that total exactly 100
        const parts = P.splitAmount(100, draft.map(() => 1));
        draft.forEach((s, i) => { s.weight = parts[i]; });
        rerenderEditor(app);
      } else if (b.dataset.pie === 'discard') {
        draft = null; rerenderEditor(app);
      } else if (b.dataset.pie === 'save') {
        if (!weightsOk(draft)) { UI.toast('The weights must add up to exactly 100% before saving.', 'error'); const w = editor.querySelector('[data-pie-w]'); if (w) w.focus(); return; }
        const slices = draft.map(s => ({ type: s.type, symbol: s.symbol, name: s.name, meta: s.meta, weight: +(+s.weight).toFixed(4) }));
        draft = null;
        book.savePie({ slices, savedAt: Date.now() });
        UI.toast('Pie saved: ' + slices.map(s => s.symbol + ' ' + tidy(s.weight) + '%').join(', '), 'ok');
      }
    });

    const form = root.querySelector('#pie-form');
    form.addEventListener('input', e => {
      if (e.target.dataset.piePrice) { prices[e.target.dataset.piePrice] = e.target.value; fieldError('pie-price-' + e.target.id.split('-').pop(), null, e.target.id); }
      else if (e.target.id === 'pie-amount' || e.target.id === 'pie-fees' || e.target.id === 'pie-date') fieldError(e.target.id, null);
      renderPreview(app);
    });
    form.addEventListener('change', e => { if (e.target.id === 'pie-usecash') renderPreview(app); });
    form.addEventListener('submit', e => { e.preventDefault(); invest(app); });
  }

  /* ---------------- invest ---------------- */
  function invest(app) {
    clearErrors();
    if (draft) { UI.toast('Save or discard your changes to the split first.', 'error'); document.getElementById('pie-unsaved').scrollIntoView({ block: 'center' }); return; }
    const pl = plan(app);
    const f = pl.f;
    if (!weightsOk(pl.pie.slices)) return UI.toast('The saved split doesn\'t add up to 100% — fix it above first.', 'error');
    if (!(U.isNum(f.amount) && f.amount > 0)) return fieldError('pie-amount', 'Enter how much you want to invest, in dollars.');
    if (pl.rows.some(r => !(r.amount > 0))) return fieldError('pie-amount', 'That amount is too small to split ' + pl.rows.length + ' ways — every slice needs at least 1 cent.');
    if (!(U.isNum(f.fees) && f.fees >= 0)) return fieldError('pie-fees', 'Fees can\'t be negative — leave empty if there were none.');
    if (!f.date) return fieldError('pie-date', 'Enter when you bought.');
    if (f.date > Date.now() + 5 * 60000) return fieldError('pie-date', 'That date is in the future — enter when the buy actually happened.');
    for (let i = 0; i < pl.rows.length; i++) {
      const r = pl.rows[i];
      if (!(r.price > 0)) return fieldError('pie-price-' + i, 'Enter the price per unit you paid for ' + r.s.symbol + (r.live == null ? ' — no live price is available for it yet.' : '.'), 'pie-price-' + i);
    }
    const cost = f.amount + f.fees;
    const bal = app.state.cash.balance;
    if (f.useCash && bal - cost < -P.CASH_TOLERANCE) {
      return fieldError('pie-cash', 'Your cash reserve has ' + F.money(bal) + ' — this pie buy costs ' + F.money(cost) + '. Add cash first, or untick "Pay from cash reserve".', 'pie-usecash');
    }

    const batch = U.uid('pie');
    const when = new Date(f.date).toISOString();
    const items = pl.rows.map((r, i) => {
      const tx = P.normalise({
        type: r.s.type, symbol: r.s.symbol, name: r.s.name, meta: r.s.meta, side: 'buy',
        quantity: r.amount / r.price, price: r.price, fees: r.fee, currency: 'USD', date: when,
        entry: 'amount', amount: r.amount, batch,
        notes: 'Pie buy — ' + tidy(r.s.weight) + '% of ' + F.moneyIn(f.amount, 'USD'), createdAt: Date.now() + i
      });
      return { tx, cashEntry: f.useCash ? { id: U.uid('cash'), date: when, kind: 'trade', amount: -(r.amount + r.fee), note: '' } : null };
    });
    // every buy must pass the same checks as a buy entered by hand
    for (const it of items) {
      const errs = P.validate(it.tx, app.state.txs, app.state.rates);
      if (errs.length) { UI.toast(it.tx.symbol + ': ' + errs[0].msg, 'error', 7000); return; }
    }
    book.saveTrades(items);
    Object.keys(prices).forEach(k => delete prices[k]);
    UI.toast('Bought pie: ' + F.moneyIn(f.amount, 'USD') + ' across ' + items.map(it => it.tx.symbol).join(', ') + (f.useCash ? ' — paid from cash' : ''), 'ok', 5000);
  }

  /** Background refresh (prices changed): update the drift panel and preview numbers only. */
  function refreshFigures(app) {
    const d = document.getElementById('pie-drift');
    if (d) d.innerHTML = driftHtml(app);
    // untouched price boxes follow the live price
    document.querySelectorAll('[data-pie-price]').forEach(inp => {
      const k = inp.dataset.piePrice;
      if (prices[k] == null && document.activeElement !== inp) inp.value = tidy(livePrice(app, k));
    });
    renderPreview(app);
  }

  PT.pieView = { view, refreshFigures, _plan: plan,
    resetDraft() { draft = null; Object.keys(prices).forEach(k => delete prices[k]); } };
})(window.PT);
