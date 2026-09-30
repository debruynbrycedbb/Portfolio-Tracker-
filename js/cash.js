/* ==========================================================================
   cash.js — the Cash reserve screen: spare cash waiting to be deployed.
   --------------------------------------------------------------------------
   Cash is a ledger of movements in USD (stored in PT.store.book, it's your
   data). Deposits, withdrawals and "set balance" adjustments are entered
   here; buys paid from cash and sells whose proceeds go back to cash are
   linked to their trade and follow it when the trade is edited or deleted.

   Cash sits NEXT TO the investments: it is never part of their value or
   P&L, so P&L % isn't diluted by money that isn't invested.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc, UI = PT.ui, P = PT.portfolio, book = PT.store.book;
  let mode = 'deposit';                     // 'deposit' | 'withdraw' | 'set'

  const KIND_LABEL = { deposit: 'Cash added', withdraw: 'Cash withdrawn', adjust: 'Balance set' };

  function kpis(app) {
    const c = app.state.cash, s = app.state.summary;
    const inv = s.value || 0, total = inv + c.balance;
    const k = (label, val, sub) => '<div class="kpi"><dt>' + label + '</dt><dd>' + val + (sub ? '<span class="kpi__sub">' + sub + '</span>' : '') + '</dd></div>';
    return k('Available to deploy', F.money(c.balance), c.balance < 0 ? '<span class="is-loss">below zero — check the history</span>' : 'cash reserve') +
      k('Share of total', total > 0 ? F.pct((c.balance / total) * 100, { plain: true }) : '—', 'of ' + F.money(total) + ' incl. investments') +
      k('Added, net', F.money(c.deposited - c.withdrawn), F.money(c.deposited) + ' in · ' + F.money(c.withdrawn) + ' out') +
      k('Deployed into trades', F.money(c.intoTrades), c.fromTrades ? F.money(c.fromTrades) + ' returned from sells' : 'from buys paid with cash');
  }

  function movementLabel(e, txById) {
    if (e.txId) {
      const tx = txById[e.txId];
      if (!tx) return 'Trade (deleted)';
      return (tx.side === 'sell' ? 'Sell ' : 'Buy ') + '<a class="row-link" style="display:inline" href="' + PT.views.href(P.assetKey(tx)) + '">' + esc(tx.symbol) + '</a>' +
        ' <span class="muted">' + esc(F.qty(+tx.quantity)) + ' @ ' + esc(F.priceIn(+tx.price, tx.currency)) + '</span>';
    }
    return esc(KIND_LABEL[e.kind] || 'Movement');
  }

  function history(app) {
    const txById = {};
    app.state.txs.forEach(t => { txById[t.id] = t; });
    // rows arrive in chronological order; the index breaks ties between movements in the same minute
    const rows = app.state.cash.rows.map((e, i) => Object.assign({ t: Date.parse(e.date) || 0, seq: i }, e));
    const cols = [
      { key: 'date', label: 'Date', sort: r => r.t + r.seq / 1000, html: r => '<span class="num">' + F.dateTime(r.t) + '</span>' },
      { key: 'what', label: 'Movement', sort: r => (r.txId ? 'z' : r.kind), html: r => movementLabel(r, txById) },
      { key: 'amount', label: 'Amount', align: 'r', sort: r => r.amount, html: r =>
        '<span class="num cash-amt ' + (r.amount >= 0 ? 'cash-amt--in' : 'cash-amt--out') + '">' + (r.amount >= 0 ? '+' : '−') + F.money(Math.abs(r.amount)) +
        '</span> <span class="muted" style="font-size:11px">' + (r.amount >= 0 ? 'in' : 'out') + '</span>' },
      { key: 'bal', label: 'Balance after', align: 'r', sort: r => r.t + r.seq / 1000, html: r => '<span class="num">' + F.money(r.balance) + '</span>' },
      { key: 'note', label: 'Note', cls: 'wrap', html: r => (r.note ? esc(r.note) : '<span class="faint">—</span>') },
      { key: 'act', label: 'Actions', cls: 'actions-cell', align: 'r', html: r => r.txId
        ? (txById[r.txId] ? '<button type="button" class="btn btn--sm" data-action="edit-tx" data-id="' + esc(r.txId) + '" title="Linked to a trade — change it there">Edit trade</button>' : '')
        : '<span class="tbl-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" data-cash-del="' + esc(r.id) + '" aria-label="Delete this cash movement">' + UI.icon('trash') + '</button></span>' }
    ];
    if (PT.store.book.readOnly) cols.pop();          // shared view: no actions column
    return UI.table('cash', cols, rows, { defaultSort: 'date', defaultDir: 'desc', caption: 'Cash movements',
      empty: 'No cash recorded yet. Add some above — it will show on the dashboard as money ready to deploy.' });
  }

  function formHtml(app) {
    const bal = app.state.cash.balance;
    const btn = { deposit: 'Add cash', withdraw: 'Withdraw cash', set: 'Set balance' }[mode];
    const hint = {
      deposit: 'Money you\'ve set aside to invest later.',
      withdraw: 'Cash you\'ve taken out of the reserve (not into a trade — the trade form handles that).',
      set: 'Type the balance you actually have; the difference from ' + F.money(bal) + ' is recorded as an adjustment.'
    }[mode];
    return '<div class="seg" role="radiogroup" aria-label="What do you want to do?">' +
      [['deposit', 'Add cash'], ['withdraw', 'Withdraw'], ['set', 'Set balance']].map(m =>
        '<button type="button" role="radio" aria-checked="' + (mode === m[0]) + '" data-cash-mode="' + m[0] + '">' + m[1] + '</button>').join('') + '</div>' +
      '<p class="field__hint" style="margin-top:-4px">' + hint + '</p>' +
      '<div class="trade-grid">' +
        '<div class="field" id="fld-cash-amount"><label for="cash-amount">' + (mode === 'set' ? 'New balance' : 'Amount') + ' (USD)</label>' +
          '<input class="input num" id="cash-amount" inputmode="decimal" autocomplete="off" placeholder="0.00"></div>' +
        '<div class="field" id="fld-cash-date"><label for="cash-date">Date & time</label><input class="input" type="datetime-local" id="cash-date" value="' + U.toLocalInput(Date.now()) + '"></div>' +
        '<div class="field full"><label for="cash-note">Note <span class="muted">(optional)</span></label><input class="input" id="cash-note" autocomplete="off" placeholder="e.g. September salary"></div>' +
      '</div>' +
      '<div class="row" style="justify-content:space-between"><span class="muted" id="cash-preview" style="font-size:13px"></span>' +
        '<button type="submit" class="btn btn--primary">' + btn + '</button></div>';
  }

  function view(root, app) {
    if (PT.store.book.readOnly) {
      root.innerHTML =
        '<header class="page-head"><div><p class="eyebrow">' + UI.icon('cash') + ' Records</p><h1 class="page-title">Cash reserve</h1></div>' +
        '<div class="page-head__meta"><span>Spare cash ready to invest — shown next to the investments, not inside their P&L</span></div></header>' +
        '<div class="stack"><section class="card kpi-strip" aria-label="Cash summary" id="cash-kpis">' + kpis(app) + '</section>' +
        '<section class="card card--flush" aria-labelledby="cash-t"><div class="card__head"><div><h2 class="card__title" id="cash-t">History</h2>' +
        '<p class="card__sub">' + app.state.cash.rows.length + ' movement' + (app.state.cash.rows.length === 1 ? '' : 's') + '</p></div></div>' +
        '<div id="cash-history">' + history(app) + '</div></section></div>';
      return;
    }
    root.innerHTML =
      '<header class="page-head"><div><p class="eyebrow">' + UI.icon('cash') + ' Records</p><h1 class="page-title">Cash reserve</h1></div>' +
      '<div class="page-head__meta"><span>Spare cash you can deploy later — shown next to your investments, not inside their P&L</span></div></header>' +
      '<div class="stack">' +
      '<section class="card kpi-strip" aria-label="Cash summary" id="cash-kpis">' + kpis(app) + '</section>' +
      '<div class="grid-2 grid-2--even">' +
        '<section class="card" aria-labelledby="cash-f-t"><h2 class="card__title" id="cash-f-t" style="margin-bottom:12px">Update cash</h2>' +
          '<form id="cash-form" class="stack" style="gap:14px" novalidate>' + formHtml(app) + '</form></section>' +
        '<section class="card" aria-labelledby="cash-h-t"><h2 class="card__title" id="cash-h-t" style="margin-bottom:10px">How cash works here</h2>' +
          '<ul class="cash-help">' +
          '<li><strong>Buying with it:</strong> in the trade form, tick <em>Pay from cash reserve</em> and the cost (including fees) comes out of this balance.</li>' +
          '<li><strong>Selling into it:</strong> tick <em>Add proceeds to cash reserve</em> and the proceeds (after fees) land here.</li>' +
          '<li><strong>Linked movements follow their trade.</strong> Edit or delete the trade and the cash updates with it.</li>' +
          '<li><strong>Kept separate:</strong> the dashboard shows investments and cash side by side, so your P&L % measures only money that\'s actually invested.</li>' +
          '<li>Amounts are in US dollars' + (app.state.settings.baseCurrency === 'EUR' ? ' and displayed in euros at the live rate' : '') + '.</li>' +
          '</ul></section>' +
      '</div>' +
      '<section class="card card--flush" aria-labelledby="cash-t"><div class="card__head"><div><h2 class="card__title" id="cash-t">History</h2>' +
        '<p class="card__sub">' + app.state.cash.rows.length + ' movement' + (app.state.cash.rows.length === 1 ? '' : 's') + '</p></div></div>' +
        '<div id="cash-history">' + history(app) + '</div></section>' +
      '</div>';
    bind(root, app);
  }

  function preview(app) {
    const el = document.getElementById('cash-preview');
    if (!el) return;
    const v = U.parseNum(document.getElementById('cash-amount').value);
    const bal = app.state.cash.balance;
    if (!U.isNum(v)) { el.textContent = 'Balance now ' + F.money(bal); return; }
    const next = mode === 'deposit' ? bal + v : mode === 'withdraw' ? bal - v : v;
    el.textContent = 'Balance ' + F.money(bal) + ' → ' + F.money(next);
  }

  function fieldError(id, msg) {
    const box = document.getElementById('fld-' + id);
    box.querySelectorAll('.field-error').forEach(x => x.remove());
    box.classList.toggle('is-invalid', !!msg);
    const input = box.querySelector('input');
    if (!msg) { input.removeAttribute('aria-invalid'); return; }
    const p = document.createElement('p'); p.className = 'field-error'; p.id = 'err-' + id; p.textContent = msg;
    box.appendChild(p);
    input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', p.id);
    input.focus();
  }

  function bind(root, app) {
    const form = root.querySelector('#cash-form');
    preview(app);
    form.addEventListener('click', e => {
      const m = e.target.closest('[data-cash-mode]');
      if (!m) return;
      mode = m.dataset.cashMode;
      const keep = { amount: document.getElementById('cash-amount').value, date: document.getElementById('cash-date').value, note: document.getElementById('cash-note').value };
      form.innerHTML = formHtml(app);
      document.getElementById('cash-amount').value = keep.amount;
      document.getElementById('cash-date').value = keep.date;
      document.getElementById('cash-note').value = keep.note;
      form.querySelector('[data-cash-mode="' + mode + '"]').focus();
      preview(app);
    });
    form.addEventListener('input', e => { if (e.target.id === 'cash-amount') { fieldError('cash-amount', null); preview(app); } if (e.target.id === 'cash-date') fieldError('cash-date', null); });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const bal = app.state.cash.balance;
      const v = U.parseNum(document.getElementById('cash-amount').value);
      const t = U.fromLocalInput(document.getElementById('cash-date').value);
      const note = document.getElementById('cash-note').value.trim();
      if (!U.isNum(v) || v < 0 || (mode !== 'set' && v === 0)) {
        return fieldError('cash-amount', mode === 'set' ? 'Enter the balance you have, in dollars (0 or more).' : 'Enter an amount in dollars, greater than zero.');
      }
      if (!t) return fieldError('cash-date', 'Enter when this happened.');
      if (t > Date.now() + 5 * 60000) return fieldError('cash-date', 'That date is in the future — enter when it actually happened.');
      let amount, kind;
      if (mode === 'deposit') { amount = v; kind = 'deposit'; }
      else if (mode === 'withdraw') {
        if (v > bal + P.CASH_TOLERANCE) return fieldError('cash-amount', 'Your cash reserve holds ' + F.money(bal) + ' — you can\'t withdraw ' + F.money(v) + '.');
        amount = -(v > bal ? bal : v); kind = 'withdraw';   // within a cent of everything = everything
      } else {
        amount = v - bal; kind = 'adjust';
        if (Math.abs(amount) < P.CASH_TOLERANCE) { UI.toast('The balance is already ' + F.money(v), 'info'); return; }
      }
      book.addCash({ id: U.uid('cash'), date: new Date(t).toISOString(), kind, amount, note });
      mode = 'deposit';
      UI.toast(kind === 'deposit' ? 'Added ' + F.money(v) + ' to your cash reserve' : kind === 'withdraw' ? 'Withdrew ' + F.money(v) : 'Cash balance set to ' + F.money(v), 'ok');
    });
    // (bound to the history block, which is rebuilt each render — #view itself persists)
    root.querySelector('#cash-history').addEventListener('click', async e => {
      const d = e.target.closest('[data-cash-del]');
      if (!d) return;
      const entry = app.state.cash.rows.find(x => x.id === d.dataset.cashDel);
      if (!entry) return;
      const after = app.state.cash.balance - entry.amount;
      if (after < -P.CASH_TOLERANCE) {
        await UI.confirm({ title: 'Can\'t remove this yet', confirmLabel: 'OK', cancelLabel: 'Close',
          body: 'Removing it would leave your cash reserve at ' + F.money(after) + ', because trades have already spent that cash. Untick "Pay from cash reserve" on those trades (or delete them) first.' });
        return;
      }
      const ok = await UI.confirm({ title: 'Delete this cash movement?', danger: true, confirmLabel: 'Delete',
        body: (KIND_LABEL[entry.kind] || 'Movement') + ' of ' + F.money(Math.abs(entry.amount)) + ' on ' + F.dateTime(entry.date) + '. Your balance becomes ' + F.money(after) + '.' });
      if (ok) { book.removeCash(entry.id); UI.toast('Cash movement deleted', 'ok'); }
    });
  }

  /** Background refresh (prices changed): only the figures that depend on prices. */
  function refreshFigures(app) {
    const k = document.getElementById('cash-kpis');
    if (k) k.innerHTML = kpis(app);
  }

  PT.cashView = { view, refreshFigures };
})(window.PT);
