/* ==========================================================================
   ui.js — shared UI pieces: P&L cells, badges, sortable tables, toasts,
   confirmation dialogs, copy-to-clipboard.
   Meaning never rests on colour alone: gains/losses carry ▲/▼ and a sign,
   status badges carry a word.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc;
  const UI = {};

  const TYPE = {};
  PT.config.ASSET_TYPES.forEach(t => { TYPE[t.id] = t; });
  UI.TYPE = TYPE;

  UI.tone = v => (v == null ? 'is-flat' : v > 0 ? 'is-gain' : v < 0 ? 'is-loss' : 'is-flat');
  UI.arrow = v => (v == null ? '' : v > 0 ? '▲' : v < 0 ? '▼' : '■');
  const srWord = v => (v > 0 ? 'gain' : v < 0 ? 'loss' : 'unchanged');

  /** P&L: amount and percent together, with arrow + sign + colour. */
  UI.pl = function (usd, pct, opts) {
    if (usd == null && pct == null) return '<span class="pl is-flat">—</span>';
    const v = usd != null ? usd : pct;
    const parts = [];
    if (usd != null) parts.push('<span class="pl__abs">' + F.money(usd, { signed: true }) + '</span>');
    if (pct != null && !(opts && opts.noPct)) parts.push('<span class="pl__pct">' + (usd != null ? '(' + F.pct(pct) + ')' : F.pct(pct)) + '</span>');
    return '<span class="pl ' + UI.tone(v) + '"><span class="pl__icon" aria-hidden="true">' + UI.arrow(v) + '</span>' +
      '<span class="sr-only">' + srWord(v) + ' </span>' + parts.join(' ') + '</span>';
  };

  UI.chg = function (pct) {
    if (pct == null) return '<span class="pl is-flat" title="No daily change available">—</span>';
    return '<span class="pl ' + UI.tone(pct) + '"><span class="pl__icon" aria-hidden="true">' + UI.arrow(pct) + '</span>' +
      '<span class="sr-only">' + srWord(pct) + ' </span>' + F.pct(pct) + '</span>';
  };

  UI.badge = (text, tone, title) =>
    '<span class="badge badge--' + (tone || 'neutral') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';

  UI.typeTag = function (type) {
    const t = TYPE[type] || { label: type };
    return '<span class="type-tag type-tag--' + type + '"><span class="swatch swatch--' + type + '" aria-hidden="true"></span>' +
      esc(t.short || t.label) + '</span>';
  };

  /** Session badge for prices taken outside regular hours. */
  UI.sessionBadge = function (q) {
    if (!q || !q.extra) return '';
    const x = q.extra;
    if (x.noExtendedData) return UI.badge('Reg. only', 'muted', 'This source has no pre/after-hours data — price is the regular session');
    if (x.priceSession === 'pre') return UI.badge('Pre-mkt', 'session', 'Pre-market trade at ' + F.time(x.priceTime || x.extendedTime));
    if (x.priceSession === 'post') return UI.badge(x.marketSession === 'closed' ? 'After-hrs · closed' : 'After-hrs', 'session',
      'After-hours trade at ' + F.dateTime(x.priceTime || x.extendedTime));
    if (x.marketSession === 'closed' || x.marketSession === 'pre' || x.marketSession === 'post') return UI.badge('Close', 'muted', 'Last regular-session close');
    return '';
  };

  /** Price with its honesty markers: manual, stale, failing. */
  UI.priceCell = function (row) {
    const q = row.quote;
    if (!row.priced) {
      return '<span class="nodata" title="' + esc(q && q.error ? q.error : 'No price yet') + '"><span aria-hidden="true">⚠</span> No price</span>';
    }
    let s = '<span class="num">' + F.price(row.price) + '</span>';
    if (q.manual) s += ' ' + UI.badge('Manual', 'manual', 'Price pinned by you in Settings');
    else {
      if (q.stale) s += ' <span class="stale" title="' + esc((q.error ? q.error + ' ' : '') + 'Last good price ' + F.dateTime(q.lastGoodAt)) + '"><span aria-hidden="true">◷</span><span class="stale__txt">' + esc(F.ago(q.lastGoodAt)) + '</span></span>';
      s += ' ' + UI.sessionBadge(q);
    }
    return s;
  };

  /* ---------------- sortable table ----------------
     columns: [{ key, label, sort(row)->value, html(row)->string, cls, align:'r', hideSm }]
     State is kept per table id so a re-render keeps the user's sort.            */
  const sortState = {};
  UI.table = function (id, columns, rows, opts) {
    opts = opts || {};
    const st = sortState[id] || (sortState[id] = { key: opts.defaultSort || columns[0].key, dir: opts.defaultDir || 'desc' });
    const col = columns.find(c => c.key === st.key) || columns[0];
    const sorted = rows.slice();
    if (col.sort) {
      const dir = st.dir === 'asc' ? 1 : -1;
      sorted.sort((a, b) => {
        const va = col.sort(a), vb = col.sort(b);
        const na = va == null || (typeof va === 'number' && isNaN(va)), nb = vb == null || (typeof vb === 'number' && isNaN(vb));
        if (na && nb) return 0; if (na) return 1; if (nb) return -1;     // blanks always last
        if (typeof va === 'string') return va.localeCompare(vb) * dir;
        return (va - vb) * dir;
      });
    }
    const head = columns.map(c => {
      const active = c.key === st.key;
      const aria = active ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const ind = active ? (st.dir === 'asc' ? '↑' : '↓') : '↕';
      return '<th scope="col" class="' + (c.align === 'r' ? 'r ' : '') + (c.cls || '') + '" aria-sort="' + aria + '">' +
        (c.sort ? '<button type="button" class="th-btn' + (active ? ' is-active' : '') + '" data-sort-table="' + id + '" data-sort-key="' + c.key + '">' +
          esc(c.label) + '<span class="th-ind" aria-hidden="true">' + ind + '</span></button>' : esc(c.label)) + '</th>';
    }).join('');
    const body = sorted.length ? sorted.map(r => {
      const href = opts.rowHref ? opts.rowHref(r) : null;
      return '<tr' + (href ? ' class="is-link" data-href="' + esc(href) + '"' : '') + (opts.rowClass ? ' ' + opts.rowClass(r) : '') + '>' +
        columns.map((c, i) => {
          const inner = c.html(r);
          const cell = (i === 0 && href) ? '<a class="row-link" href="' + esc(href) + '">' + inner + '</a>' : inner;
          return '<td data-label="' + esc(c.label) + '" class="' + (c.align === 'r' ? 'r ' : '') + (c.cls || '') + '">' + cell + '</td>';
        }).join('') + '</tr>';
    }).join('') : '<tr class="empty-row"><td colspan="' + columns.length + '">' + (opts.empty || 'Nothing here yet.') + '</td></tr>';
    // On phones the header row is hidden (rows become cards), so sorting moves to a select.
    const sortable = columns.filter(c => c.sort);
    const bar = opts.cards === false || opts.sortBar === false || !sortable.length ? '' :
      '<div class="sort-bar"><label for="sb-' + id + '">Sort by</label><select class="select select--sm" id="sb-' + id + '" data-sort-select="' + id + '">' +
      sortable.map(c => ['desc', 'asc'].map(d => '<option value="' + c.key + '|' + d + '"' + (st.key === c.key && st.dir === d ? ' selected' : '') + '>' +
        esc(c.label) + (d === 'desc' ? ' ↓' : ' ↑') + '</option>').join('')).join('') + '</select></div>';
    return bar + '<div class="table-wrap' + (opts.cards === false ? '' : ' table-wrap--cards') + '"><table class="tbl" id="tbl-' + id + '">' +
      (opts.caption ? '<caption class="sr-only">' + esc(opts.caption) + '</caption>' : '') +
      '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  };
  UI.setSort = function (id, key) {
    const st = sortState[id] || (sortState[id] = { key, dir: 'desc' });
    if (st.key === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else { st.key = key; st.dir = (key === 'name' || key === 'symbol' || key === 'asset') ? 'asc' : 'desc'; }
  };
  UI.setSortExact = function (id, key, dir) { sortState[id] = { key, dir }; };
  UI.sortState = sortState;

  /* ---------------- toasts ---------------- */
  UI.toast = function (msg, tone, ms) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const t = document.createElement('div');
    t.className = 'toast toast--' + (tone || 'info');
    t.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    t.innerHTML = '<span class="toast__icon" aria-hidden="true">' + (tone === 'error' ? '⚠' : tone === 'ok' ? '✓' : 'ℹ') + '</span><span>' + esc(msg) + '</span>';
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('is-on'));
    setTimeout(() => { t.classList.remove('is-on'); setTimeout(() => t.remove(), 300); }, ms || 3800);
  };

  /* ---------------- confirmation dialog ---------------- */
  UI.confirm = function (o) {
    return new Promise(resolve => {
      const d = document.createElement('dialog');
      d.className = 'dlg dlg--confirm';
      d.innerHTML = '<form method="dialog" class="dlg__body">' +
        '<h2 class="dlg__title">' + esc(o.title) + '</h2>' +
        '<div class="dlg__text">' + (o.html || esc(o.body || '')) + '</div>' +
        '<div class="dlg__actions">' +
        '<button type="button" class="btn btn--ghost" value="cancel" data-act="cancel">' + esc(o.cancelLabel || 'Cancel') + '</button>' +
        '<button type="button" class="btn ' + (o.danger ? 'btn--danger' : 'btn--primary') + '" data-act="ok">' + esc(o.confirmLabel || 'Confirm') + '</button>' +
        '</div></form>';
      document.body.appendChild(d);
      const done = v => { d.close(); d.remove(); resolve(v); };
      d.addEventListener('click', e => {
        const a = e.target.closest('[data-act]');
        if (a) done(a.dataset.act === 'ok');
        else if (e.target === d) done(false);
      });
      d.addEventListener('cancel', e => { e.preventDefault(); done(false); });
      d.showModal();
      d.querySelector('[data-act="cancel"]').focus();
    });
  };

  /** Ask the user to pick one of several options. Resolves the option id, or null if dismissed. */
  UI.choose = function (o) {
    return new Promise(resolve => {
      const d = document.createElement('dialog');
      d.className = 'dlg dlg--confirm';
      d.innerHTML = '<form method="dialog" class="dlg__body"><h2 class="dlg__title">' + esc(o.title) + '</h2>' +
        '<div class="dlg__text">' + (o.html || esc(o.body || '')) + '</div>' +
        '<div class="dlg__choices">' + o.options.map(x => '<button type="button" class="btn ' + (x.primary ? 'btn--primary' : x.danger ? 'btn--danger-ghost' : '') + '" data-choice="' + esc(x.id) + '">' + esc(x.label) + '</button>').join('') +
        '<button type="button" class="btn btn--ghost" data-choice="">Cancel</button></div></form>';
      document.body.appendChild(d);
      const done = v => { d.close(); d.remove(); resolve(v || null); };
      d.addEventListener('click', e => { const b = e.target.closest('[data-choice]'); if (b) done(b.dataset.choice); });
      d.addEventListener('cancel', e => { e.preventDefault(); done(null); });
      d.showModal();
      const p = d.querySelector('.btn--primary'); (p || d.querySelector('[data-choice]')).focus();
    });
  };

  UI.copy = async function (text, label) {
    try {
      await navigator.clipboard.writeText(text);
      UI.toast((label || 'Copied') + ' to clipboard', 'ok', 2000);
    } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); UI.toast((label || 'Copied') + ' to clipboard', 'ok', 2000); } catch (e2) { UI.toast('Couldn\'t copy — select it manually', 'error'); }
      ta.remove();
    }
  };

  UI.shortAddr = a => (a && a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');

  UI.download = function (name, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };

  UI.icon = function (name) {
    const P = {
      dash: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z"/>',
      stock: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
      etf: '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="2"/>',
      crypto: '<circle cx="12" cy="12" r="8"/><path d="M9.5 8.5h4a2 2 0 010 4h-4zm0 4h4.5a2 2 0 010 4H9.5zM11 7v2M11 16v1.5"/>',
      meme: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/>',
      tx: '<path d="M7 7h13l-3-3M17 17H4l3 3"/>',
      cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      pie: '<path d="M12 3a9 9 0 109 9h-9z"/><path d="M15 3.5A9 9 0 0120.5 9H15z"/>',
      cash: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
      refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
      back: '<path d="M15 18l-6-6 6-6"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
      ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
      trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
      warn: '<path d="M12 3l10 18H2zM12 10v5M12 18v.5"/>',
      eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
      link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'
    };
    return '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (P[name] || '') + '</svg>';
  };

  PT.ui = UI;
})(window.PT);
