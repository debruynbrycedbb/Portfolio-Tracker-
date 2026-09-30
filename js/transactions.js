/* ==========================================================================
   transactions.js — the Transactions screen (every trade ever entered),
   the per-position transaction list, and the delete flow.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc, UI = PT.ui, P = PT.portfolio;
  const filters = { type: 'all', asset: 'all', from: '', to: '', outcome: 'all', q: '' };

  /** Enrich transactions with totals, current value and P&L (all USD). */
  function enrich(txs, st) {
    const priceByKey = {}, cashByTx = {};
    (st.cash ? st.cash.rows : []).forEach(e => { if (e.txId) cashByTx[e.txId] = e.amount; });
    st.summary.rows.forEach(r => { if (r.priced) priceByKey[r.key] = r.price; });
    return txs.map(tx => {
      const key = P.assetKey(tx);
      const qty = +tx.quantity, pUsd = P.toUsd(+tx.price, tx.currency, st.rates), fUsd = P.toUsd(+tx.fees || 0, tx.currency, st.rates);
      const pt = st.derived.perTx[tx.id] || {};
      const px = priceByKey[key];
      const r = { tx, key, time: P.txTime(tx), qty, pUsd, fUsd, sell: tx.side === 'sell', cash: cashByTx[tx.id] };
      if (r.sell) {
        r.total = qty * pUsd - fUsd;                  // proceeds
        r.value = null;
        r.pl = pt.realised != null ? pt.realised : null;
        r.plPct = r.pl != null && pt.costOut ? (r.pl / pt.costOut) * 100 : null;
      } else {
        r.total = qty * pUsd + fUsd;                  // cost
        r.value = U.isNum(px) ? qty * px : null;
        r.pl = r.value != null ? r.value - r.total : null;
        r.plPct = r.pl != null && r.total > 0 ? (r.pl / r.total) * 100 : null;
      }
      return r;
    });
  }

  function actions(tx) {
    return '<span class="tbl-actions"><button type="button" class="btn btn--ghost btn--sm btn--icon" data-action="edit-tx" data-id="' + esc(tx.id) + '" aria-label="Edit ' + esc(tx.side + ' ' + tx.symbol + ' on ' + F.date(tx.date)) + '">' + UI.icon('edit') + '</button>' +
      '<button type="button" class="btn btn--ghost btn--sm btn--icon" data-action="delete-tx" data-id="' + esc(tx.id) + '" aria-label="Delete ' + esc(tx.side + ' ' + tx.symbol + ' on ' + F.date(tx.date)) + '">' + UI.icon('trash') + '</button></span>';
  }
  const sideTag = s => '<span class="side-tag side-tag--' + s + '">' + (s === 'sell' ? 'Sell' : 'Buy') + '</span>';
  const plCell = r => (r.pl == null ? '<span class="pl is-flat">—</span>' : UI.pl(r.pl, r.plPct) + (r.sell ? ' <span class="muted" style="font-size:11px">realised</span>' : ''));

  function columns(full) {
    const cols = [
      { key: 'date', label: 'Date', sort: r => r.time, html: r => '<span class="num">' + F.dateTime(r.time) + '</span>' }
    ];
    if (full) {
      cols.push({ key: 'asset', label: 'Asset', sort: r => (r.tx.name || r.tx.symbol).toLowerCase(), html: r => '<a class="row-link" href="' + PT.views.href(r.key) + '">' + PT.views.assetCell(Object.assign({}, r.tx, { meta: r.tx.meta })) + '</a>' });
      cols.push({ key: 'type', label: 'Type', sort: r => r.tx.type, html: r => UI.typeTag(r.tx.type) });
    }
    cols.push(
      { key: 'side', label: 'Side', sort: r => r.tx.side, html: r => sideTag(r.tx.side) +
        (r.tx.batch && /^pie/.test(r.tx.batch) ? '<span class="cash-tag" title="Part of a pie investment">pie</span>' : '') +
        (r.cash != null ? '<span class="cash-tag" title="' + (r.cash < 0 ? 'Paid from cash reserve' : 'Proceeds added to cash reserve') + '">cash</span>' : '') },
      { key: 'qty', label: 'Quantity', align: 'r', sort: r => r.qty, html: r => '<span class="num">' + F.qty(r.qty) + '</span>' },
      { key: 'price', label: 'Price', align: 'r', sort: r => r.pUsd, html: r => '<span class="num">' + F.priceIn(+r.tx.price, r.tx.currency) + '</span>' },
      { key: 'fees', label: 'Fees', align: 'r', sort: r => r.fUsd, html: r => '<span class="num">' + F.moneyIn(+r.tx.fees || 0, r.tx.currency) + '</span>' },
      { key: 'total', label: 'Total cost / proceeds', align: 'r', sort: r => (r.sell ? -r.total : r.total), html: r => '<span class="num">' + F.money(r.total) + '</span>' + (r.sell ? ' <span class="muted" style="font-size:11px">proceeds</span>' : '') },
      { key: 'value', label: 'Current value', align: 'r', sort: r => r.value, html: r => '<span class="num">' + (r.value == null ? (r.sell ? '<span class="muted">sold</span>' : '—') : F.money(r.value)) + '</span>' },
      { key: 'pl', label: 'P&L', align: 'r', sort: r => r.pl, html: plCell },
      { key: 'notes', label: 'Notes', cls: 'wrap', html: r => (r.tx.notes ? esc(r.tx.notes) : '<span class="faint">—</span>') },
      { key: 'actions', label: 'Actions', cls: 'actions-cell', align: 'r', html: r => actions(r.tx) }
    );
    if (PT.store.book.readOnly) cols.pop();          // shared view: no edit / delete
    return cols;
  }

  function applyFilters(rows) {
    const from = filters.from ? U.fromLocalInput(filters.from + 'T00:00') : null;
    const to = filters.to ? U.fromLocalInput(filters.to + 'T23:59') + 59999 : null;
    return rows.filter(r => {
      if (filters.type !== 'all' && r.tx.type !== filters.type) return false;
      if (filters.asset !== 'all' && r.key !== filters.asset) return false;
      if (from && r.time < from) return false;
      if (to && r.time > to) return false;
      if (filters.outcome === 'profit' && !(r.pl > 0)) return false;
      if (filters.outcome === 'loss' && !(r.pl < 0)) return false;
      return true;
    });
  }

  function renderTable(st) {
    const host = document.getElementById('tx-table');
    if (!host) return;
    const all = enrich(st.txs, st);
    const rows = applyFilters(all);
    const invested = rows.filter(r => !r.sell).reduce((s, r) => s + r.total, 0);
    const pl = rows.reduce((s, r) => s + (r.pl || 0), 0);
    document.getElementById('tx-summary').innerHTML = '<span>Showing <strong>' + rows.length + '</strong> of ' + all.length + ' transactions</span>' +
      '<span>Bought ' + F.money(invested) + ' · P&L on shown rows ' + UI.pl(pl, null) + '</span>';
    host.innerHTML = UI.table('transactions', columns(true), rows, {
      defaultSort: 'date', defaultDir: 'desc', caption: 'All transactions', sortBar: false,
      empty: all.length ? 'No transactions match these filters. <button class="btn btn--sm" data-action="clear-filters">Clear filters</button>' : 'No transactions yet.'
    });
  }

  function view(root, app) {
    const st = app.state;
    const assets = {};
    st.txs.forEach(t => { const k = P.assetKey(t); if (!assets[k]) assets[k] = { key: k, label: t.symbol + ' — ' + (t.name || '') + (t.type === 'memecoin' && t.meta && t.meta.chain ? ' (' + t.meta.chain + ')' : ''), type: t.type }; });
    const assetOpts = Object.values(assets).filter(a => filters.type === 'all' || a.type === filters.type).sort((a, b) => a.label.localeCompare(b.label));
    if (filters.asset !== 'all' && !assetOpts.some(a => a.key === filters.asset)) filters.asset = 'all';
    const sel = (v, cur) => (v === cur ? ' selected' : '');
    root.innerHTML =
      '<header class="page-head"><div><p class="eyebrow">History</p><h1 class="page-title">Transactions</h1></div>' +
      (PT.store.book.readOnly ? '</header>' : '<div class="page-head__meta"><button class="btn btn--primary" data-action="add-trade">' + UI.icon('plus') + ' Add trade</button></div></header>') +
      '<section class="card card--flush"><div style="padding:18px 20px 0">' +
      '<form class="filters" id="tx-filters" onsubmit="return false" aria-label="Filter transactions">' +
        '<div class="field"><label for="f-type">Asset type</label><select class="select select--sm" id="f-type" data-filter="type"><option value="all">All types</option>' +
          PT.config.ASSET_TYPES.map(t => '<option value="' + t.id + '"' + sel(t.id, filters.type) + '>' + t.plural + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="f-asset">Asset</label><select class="select select--sm" id="f-asset" data-filter="asset"><option value="all">All assets</option>' +
          assetOpts.map(a => '<option value="' + esc(a.key) + '"' + sel(a.key, filters.asset) + '>' + esc(a.label) + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="f-from">From</label><input class="input input--sm" type="date" id="f-from" data-filter="from" value="' + esc(filters.from) + '"></div>' +
        '<div class="field"><label for="f-to">To</label><input class="input input--sm" type="date" id="f-to" data-filter="to" value="' + esc(filters.to) + '"></div>' +
        '<div class="field"><label for="f-out">Outcome</label><select class="select select--sm" id="f-out" data-filter="outcome">' +
          [['all', 'All'], ['profit', 'Profitable'], ['loss', 'Loss-making']].map(o => '<option value="' + o[0] + '"' + sel(o[0], filters.outcome) + '>' + o[1] + '</option>').join('') + '</select></div>' +
        '<div class="field"><label for="f-sort">Sort by</label><select class="select select--sm" id="f-sort">' +
          [['date|desc', 'Newest first'], ['date|asc', 'Oldest first'], ['total|desc', 'Amount invested'], ['pl|desc', 'Best P&L'], ['pl|asc', 'Worst P&L'], ['asset|asc', 'Asset A–Z']]
            .map(o => { const s = UI.sortState.transactions; const cur = s ? s.key + '|' + s.dir : 'date|desc'; return '<option value="' + o[0] + '"' + sel(o[0], cur) + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
      '</form><div class="filters__summary" id="tx-summary"></div></div>' +
      '<div id="tx-table"></div></section>';
    renderTable(st);

    const form = document.getElementById('tx-filters');
    form.addEventListener('change', e => {
      const f = e.target.dataset.filter;
      if (f) {
        filters[f] = e.target.value;
        if (f === 'type') { filters.asset = 'all'; view(root, app); document.getElementById('f-type').focus(); return; }
      }
      if (e.target.id === 'f-sort') { const [k, d] = e.target.value.split('|'); UI.setSortExact('transactions', k, d); }
      renderTable(st);
    });
  }

  /** Compact list for the position detail view. */
  function miniTable(txs, st) {
    return UI.table('ptx', columns(false), enrich(txs, st), { defaultSort: 'date', defaultDir: 'desc', caption: 'Transactions for this position', empty: 'No transactions.' });
  }

  /** Delete with confirmation; refuses if it would break a later sell. */
  async function remove(id) {
    const all = PT.store.book.transactions();
    const tx = all.find(t => t.id === id);
    if (!tx) return;
    const rest = all.filter(t => t.id !== id);
    const { problems } = P.derive(rest, PT.app.state.rates);
    if (problems.length) {
      const p = problems[0];
      await PT.ui.confirm({ title: 'Can\'t delete this buy yet', body: 'Without it, a later sell of ' + F.qty(p.wanted) + ' ' + p.symbol +
        ' would exceed what you held then (' + F.qty(p.held) + '). Delete or edit that sell first.', confirmLabel: 'OK', cancelLabel: 'Close' });
      return;
    }
    // A linked cash movement goes with the trade; that must not push the cash reserve below zero.
    const cash = PT.app.state.cash;
    const link = cash.rows.find(e => e.txId === id);
    if (link && cash.balance - link.amount < -P.CASH_TOLERANCE) {
      await PT.ui.confirm({ title: 'Can\'t delete this sell yet', confirmLabel: 'OK', cancelLabel: 'Close',
        body: 'Its ' + F.money(link.amount) + ' of proceeds went into your cash reserve and has since been spent — removing it would leave the reserve at ' +
          F.money(cash.balance - link.amount) + '. Add cash first, or untick "Pay from cash reserve" on the buys that used it.' });
      return;
    }
    const ok = await PT.ui.confirm({
      title: 'Delete this transaction?', danger: true, confirmLabel: 'Delete',
      html: '<p>' + (tx.side === 'sell' ? 'Sell' : 'Buy') + ' <strong>' + esc(F.qty(+tx.quantity) + ' ' + tx.symbol) + '</strong> at ' +
        esc(F.priceIn(+tx.price, tx.currency)) + ' on ' + esc(F.dateTime(tx.date)) + '.</p>' +
        (link ? '<p style="margin-top:8px">Its cash movement is reversed too: <strong>' + (link.amount < 0 ? F.money(-link.amount) + ' goes back into' : F.money(link.amount) + ' comes out of') + '</strong> your cash reserve.</p>' : '') +
        '<p class="muted" style="margin-top:8px">Positions are rebuilt from the remaining history. This can\'t be undone — export a backup first if unsure.</p>'
    });
    if (!ok) return;
    PT.store.book.deleteTrade(id);
    UI.toast('Transaction deleted', 'ok');
  }

  PT.txview = { view, miniTable, remove, filters, enrich, renderTable,
    clearFilters() { Object.assign(filters, { type: 'all', asset: 'all', from: '', to: '', outcome: 'all' }); } };
})(window.PT);
