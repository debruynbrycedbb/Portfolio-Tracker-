/* ==========================================================================
   settings.js — Settings screen: display, market data & relay, connection
   test, status panel, manual price overrides, backup (export/import), reset.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc, UI = PT.ui, P = PT.portfolio, C = PT.config, book = PT.store.book;
  let lastTest = null;

  const seg = (name, cur, opts) => '<div class="seg" role="group" aria-label="' + esc(name) + '">' +
    opts.map(o => '<button type="button" aria-pressed="' + (o[0] === cur) + '" data-set="' + name + '" data-val="' + esc(o[0]) + '">' + esc(o[1]) + '</button>').join('') + '</div>';

  /* ---------------- export / import ---------------- */
  const CSV_COLS = ['id', 'date', 'type', 'symbol', 'name', 'side', 'quantity', 'price', 'fees', 'currency', 'notes', 'entry', 'amount', 'batch', 'chain', 'contract', 'pairAddress', 'coingeckoId', 'exchange'];
  const META_COLS = ['chain', 'contract', 'pairAddress', 'coingeckoId', 'exchange'];

  function exportJSON() {
    const st = PT.app.state;
    const settings = Object.assign({}, st.settings);
    delete settings.finnhubKey;                        // never put a key in a backup file
    delete settings.syncKey; delete settings.syncOn; delete settings.deviceName;
    return JSON.stringify({
      format: 'ledgerline-portfolio', schemaVersion: C.SCHEMA_VERSION, exportedAt: new Date().toISOString(),
      note: 'transactions are your record. cashReserve is your cash ledger in USD (entries with txId belong to that trade). manualPriceOverrides are prices you typed in by hand. positionsAtExport is informational and ignored on import.',
      baseCurrency: st.settings.baseCurrency,
      transactions: st.txs,
      cashReserve: book.cash(),
      pie: book.pie(),
      manualPriceOverrides: st.overrides,
      settings,
      positionsAtExport: st.summary.rows.map(r => ({ key: r.key, symbol: r.symbol, type: r.type, quantity: r.qty, averageEntryUsd: r.avgEntry,
        totalInvestedUsd: r.invested, priceUsd: r.price, priceSource: r.quote ? r.quote.source : null }))
    }, null, 2);
  }
  const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function exportCSV() {
    const lines = [CSV_COLS.join(',')];
    P.sortTx(PT.app.state.txs).forEach(t => {
      lines.push(CSV_COLS.map(c => csvCell(META_COLS.includes(c) ? (t.meta || {})[c] : t[c])).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }
  function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const head = (rows.shift() || []).map(h => h.trim());
    return rows.filter(r => r.some(c => c.trim() !== '')).map(r => {
      const o = { meta: {} };
      head.forEach((h, i) => { if (META_COLS.includes(h)) o.meta[h] = r[i]; else o[h] = r[i]; });
      return o;
    });
  }

  function parseImport(text) {
    text = text.replace(/^﻿/, '');
    let txs, overrides = null, settings = null, cash = null, pie = null;
    if (/^\s*[{[]/.test(text)) {
      const j = JSON.parse(text);
      if (Array.isArray(j)) txs = j;
      else { txs = j.transactions || []; overrides = j.manualPriceOverrides || null; settings = j.settings || null; cash = Array.isArray(j.cashReserve) ? j.cashReserve : null; pie = j.pie && Array.isArray(j.pie.slices) ? j.pie : null; }
    } else txs = parseCSV(text);
    if (!Array.isArray(txs)) throw new Error('No transactions found in the file.');
    const clean = txs.map(P.normalise);
    const bad = [];
    clean.forEach((t, i) => {
      const errs = P.validate(t, [], {}).filter(e => e.field !== 'quantity' || !/sell/i.test(e.msg));
      // field-level problems only here; history consistency is checked after merging
      const fieldErrs = errs.filter(e => !/You can't sell|later sell/.test(e.msg));
      if (fieldErrs.length) bad.push('Row ' + (i + 1) + ' (' + (t.symbol || '?') + '): ' + fieldErrs[0].msg);
    });
    if (bad.length) throw new Error(bad.slice(0, 3).join(' ') + (bad.length > 3 ? ' …and ' + (bad.length - 3) + ' more.' : ''));
    if (cash) {
      const badCash = cash.filter(e => !e || !e.id || !isFinite(+e.amount) || !Date.parse(e.date));
      if (badCash.length) throw new Error(badCash.length + ' cash reserve entr' + (badCash.length === 1 ? 'y is' : 'ies are') + ' missing an id, amount or date.');
      cash = cash.map(e => Object.assign({}, e, { amount: +e.amount }));
    }
    return { txs: clean, overrides, settings, cash, pie };
  }

  const sameTrade = (a, b) => P.assetKey(a) === P.assetKey(b) && a.side === b.side && Math.abs(P.txTime(a) - P.txTime(b)) < 60000 &&
    Math.abs(a.quantity - b.quantity) < 1e-12 && Math.abs(a.price - b.price) < 1e-12;

  async function doImport(file, mode) {
    let parsed;
    try { parsed = parseImport(await file.text()); }
    catch (e) { UI.toast('Import failed: ' + e.message, 'error', 7000); return; }
    const existing = book.transactions();
    let next, added = 0, skipped = 0;
    if (mode === 'replace') { next = parsed.txs; added = next.length; }
    else {
      next = existing.slice();
      parsed.txs.forEach(t => {
        if (next.some(x => x.id === t.id || sameTrade(x, t))) { skipped++; return; }
        next.push(t); added++;
      });
    }
    // Cash ledger: replace takes the file's (or keeps only unlinked entries if the file has none); merge adds new entries.
    const existingCash = book.cash();
    let nextCash;
    if (mode === 'replace') nextCash = parsed.cash || existingCash.filter(e => !e.txId);
    else { const ids = new Set(existingCash.map(e => e.id)); nextCash = existingCash.concat((parsed.cash || []).filter(e => !ids.has(e.id))); }
    const txIds = new Set(next.map(t => t.id));
    nextCash = nextCash.filter(e => !e.txId || txIds.has(e.txId));        // no cash tied to a trade that isn't there
    const cashAfter = P.cash(nextCash).balance;
    const { problems } = P.derive(next, PT.app.state.rates);
    if (problems.length) {
      const p = problems[0];
      UI.toast('Import refused: the combined history would sell ' + F.qty(p.wanted) + ' ' + p.symbol + ' while holding only ' + F.qty(p.held) + '. Nothing was changed.', 'error', 8000);
      return;
    }
    const ok = await UI.confirm({
      title: mode === 'replace' ? 'Replace all transactions?' : 'Merge imported transactions?',
      danger: mode === 'replace', confirmLabel: mode === 'replace' ? 'Replace' : 'Merge',
      body: mode === 'replace'
        ? (PT.sync.enabled() ? 'Sync is on, so this replaces the data on all your devices. ' : '') +
          'Your ' + existing.length + ' current transactions will be replaced by the ' + parsed.txs.length + ' in the file' + (parsed.overrides ? ', along with manual price overrides' : '') +
          (parsed.cash ? '; your cash reserve becomes ' + F.money(cashAfter) : '') + '.'
        : added + ' new transaction' + (added === 1 ? '' : 's') + ' will be added' + (skipped ? '; ' + skipped + ' already present will be skipped' : '') + '. Nothing existing is changed.'
    });
    if (!ok) return;
    book.replaceTransactions(next);
    book.replaceCash(nextCash);
    if (parsed.pie && (mode === 'replace' || !book.pie())) book.replacePie(parsed.pie);
    if (parsed.overrides) book.replaceOverrides(mode === 'replace' ? parsed.overrides : Object.assign({}, parsed.overrides, book.overrides()));
    if (mode === 'replace' && parsed.settings) {
      const keep = book.settings();
      book.saveSettings(Object.assign({}, parsed.settings, { finnhubKey: keep.finnhubKey, relayUrl: parsed.settings.relayUrl || keep.relayUrl,
        syncKey: keep.syncKey, syncOn: keep.syncOn, syncUrl: keep.syncUrl, deviceName: keep.deviceName }));
    }
    book.markSeeded();
    UI.toast('Imported ' + added + ' transaction' + (added === 1 ? '' : 's') + (skipped ? ' (' + skipped + ' duplicates skipped)' : ''), 'ok');
  }

  /* ---------------- view ---------------- */
  function renderTest(host) {
    if (!lastTest) { host.innerHTML = ''; return; }
    const rows = lastTest.rows;
    let g = null, html = '';
    if (lastTest.summary) html += '<div class="probe-summary probe-summary--' + lastTest.summary.status + '" role="status">' + (lastTest.summary.status === 'ok' ? '✓' : '⚠') + ' ' + esc(lastTest.summary.text) + '</div>';
    else html += '<div class="probe-summary probe-summary--warn" role="status">Testing… probes run one at a time.</div>';
    rows.forEach(r => {
      if (r.group !== g) { g = r.group; html += '<p class="probe__group">' + esc(g) + '</p>'; }
      const lab = { ok: 'OK', fail: 'Failed', warn: 'Warning', standby: 'Standby', skip: 'Skipped' }[r.status];
      html += '<div class="probe"><span>' + UI.badge(lab, r.status) + '</span><span class="probe__label">' + esc(r.label) + '</span>' +
        '<span class="probe__ms">' + (r.ms != null ? r.ms + ' ms' : '') + '</span><span class="probe__detail">' + esc(r.detail) + '</span></div>';
    });
    host.innerHTML = html;
  }

  function statusPanel(app) {
    const st = PT.market.state.status || {};
    const names = { yahoo: 'Yahoo Finance', nasdaq: 'Nasdaq', finnhub: 'Finnhub', coingecko: 'CoinGecko', dexscreener: 'Dexscreener' };
    const rows = app.state.summary.rows;
    const failing = rows.filter(r => r.quote && r.quote.error);
    const manual = rows.filter(r => r.quote && r.quote.manual).length;
    const byProv = {};
    rows.forEach(r => { if (r.quote && r.quote.providerId && !r.quote.manual) byProv[r.quote.providerId] = (byProv[r.quote.providerId] || 0) + 1; });
    return '<dl class="kv">' +
      Object.keys(byProv).map(k => '<dt>' + esc(names[k] || k) + '</dt><dd>' + byProv[k] + ' position' + (byProv[k] === 1 ? '' : 's') + '</dd>').join('') +
      (manual ? '<dt>Manual price</dt><dd>' + manual + ' position' + (manual === 1 ? '' : 's') + '</dd>' : '') +
      '<dt>No price</dt><dd>' + rows.filter(r => !r.priced).length + '</dd>' +
      '<dt>Last refresh</dt><dd>' + (st.lastRefresh ? F.dateTime(st.lastRefresh) + ' · ' + (st.lastDuration / 1000).toFixed(1) + 's' : 'never') + '</dd>' +
      '<dt>FX</dt><dd>' + (PT.market.state.fx ? '1 USD = ' + PT.market.state.fx.usdToEur.toFixed(4) + ' EUR · ' + esc(PT.market.state.fx.source) : (app.state.settings.baseCurrency === 'USD' ? 'not needed' : 'unavailable')) + '</dd>' +
      '<dt>Storage used</dt><dd>' + (PT.store.usageBytes() / 1024).toFixed(1) + ' KB' + (book.isPersistent() ? '' : ' · <span class="is-loss">not persistent in this browser</span>') + '</dd>' +
      '<dt>Recorded snapshots</dt><dd>' + PT.market.snapshots().length + '</dd>' +
      '</dl>' +
      (failing.length ? '<div class="stack" style="gap:8px;margin-top:4px">' + failing.map(r => '<div class="banner banner--error" style="margin:0">' + UI.icon('warn') + '<span><strong>' + esc(r.symbol) + ':</strong> ' + esc(r.quote.error) + '</span></div>').join('') + '</div>' : '');
  }

  function view(root, app) {
    const s = app.state.settings;
    const ov = app.state.overrides;
    const open = app.state.summary.rows;
    root.innerHTML =
      '<header class="page-head"><div><p class="eyebrow">Preferences & data</p><h1 class="page-title">Settings</h1></div></header>' +
      '<div class="settings"><div class="settings__col">' +
      '<section class="card" aria-labelledby="s-sync"><h2 class="card__title" id="s-sync">Sync across devices</h2><div id="sync-card" class="stack" style="gap:14px">' + PT.sync.cardHtml(app) + '</div></section>' +

      '<section class="card" aria-labelledby="s-disp"><h2 class="card__title" id="s-disp">Display</h2>' +
        '<div class="field"><span class="field__label">Base currency</span>' + seg('baseCurrency', s.baseCurrency, [['USD', 'USD $'], ['EUR', 'EUR €']]) +
          '<span class="field__hint">Prices are fetched in USD and converted at a live ECB rate only for display. Stored transactions are never rewritten.</span></div>' +
        '<div class="field"><span class="field__label">Theme</span>' + seg('theme', s.theme, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) + '</div>' +
        '<div class="field"><label for="s-refresh">Price refresh</label><select class="select" id="s-refresh" data-set-select="refreshSec">' +
          C.REFRESH_OPTIONS.map(o => '<option value="' + o[0] + '"' + (+s.refreshSec === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
          '<span class="field__hint">Refreshing pauses while this tab is hidden. Press R to refresh any time.</span></div>' +
        '<label class="check"><input type="checkbox" data-set-check="extendedHours"' + (s.extendedHours ? ' checked' : '') + '><span><strong>Include pre-market & after-hours prices</strong><br><span class="muted">US stocks trade 04:00–20:00 ET. On: positions use the latest trade of any session. Off: the last regular-session close. Day change is always measured against the previous regular close.</span></span></label>' +
      '</section>' +

      '<section class="card" aria-labelledby="s-stat"><h2 class="card__title" id="s-stat">Data status</h2>' + statusPanel(app) + '</section>' +

      '<section class="card" aria-labelledby="s-bak"><h2 class="card__title" id="s-bak">Backup</h2>' +
        '<p class="muted" style="font-size:13px">Your data lives only in this browser, on this device. Clearing site data wipes it. Export regularly. JSON includes everything (trades, cash reserve, pie, manual prices); CSV is trades only.</p>' +
        '<div class="row"><button class="btn" type="button" data-action="export-json">Export JSON <span class="muted">(full)</span></button><button class="btn" type="button" data-action="export-csv">Export CSV <span class="muted">(transactions)</span></button></div>' +
        '<div class="row" style="align-items:flex-end"><div class="field"><label for="imp-file">Import file (.json or .csv)</label><input class="input" type="file" id="imp-file" accept=".json,.csv,application/json,text/csv"></div>' +
          '<div class="field" style="flex:0 1 160px"><label for="imp-mode">Mode</label><select class="select" id="imp-mode"><option value="merge">Merge</option><option value="replace">Replace all</option></select></div>' +
          '<button class="btn btn--primary" type="button" data-action="import">Import</button></div>' +
      '</section>' +

      (PT.pwa ? '<section class="card" aria-labelledby="s-app"><h2 class="card__title" id="s-app">Mac app</h2><div id="pwa-card" class="stack" style="gap:12px">' + PT.pwa.cardHtml() + '</div></section>' : '') +
      '</div><div class="settings__col">' +

      '<section class="card" aria-labelledby="s-mkt"><h2 class="card__title" id="s-mkt">Stock data relay</h2>' +
        '<p class="muted" style="font-size:13px">Yahoo Finance sends no CORS headers, so a static page needs a relay in between. Public relays rate-limit, hang and change terms — deploy your own free Cloudflare Worker (<code>cors-worker.js</code>, steps in its header and the README).</p>' +
        '<div class="field"><span class="field__label">Relay mode</span>' + seg('relayMode', s.relayMode, [['auto', 'Automatic'], ['own', 'My relay only'], ['none', 'None']]) +
          '<span class="field__hint">' + ({ auto: 'Your relay first, then public relays as unreliable spares.', own: 'Only your relay. Nothing else is tried.', none: 'No relay: stocks and ETFs need a Finnhub key.' })[s.relayMode] + '</span></div>' +
        '<div class="field"><label for="s-relay">Your relay URL</label><div class="row"><input class="input" id="s-relay" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://pt-relay.yourname.workers.dev/?url=" value="' + esc(s.relayUrl) + '" style="flex:1 1 220px">' +
          '<button class="btn" type="button" data-action="save-relay">Save</button></div><span class="field__hint" id="relay-hint">A URL missing its <code>?url=</code> parameter is corrected automatically.</span></div>' +
        '<div class="field"><label for="s-key">Finnhub API key <span class="muted">(optional)</span></label><div class="row"><input class="input" id="s-key" type="password" autocomplete="off" spellcheck="false" placeholder="Free key from finnhub.io" value="' + esc(s.finnhubKey) + '" style="flex:1 1 220px">' +
          '<button class="btn" type="button" data-action="save-key">Save</button></div>' +
          '<span class="field__hint">Stored only in this browser. Any key used by a static site is visible to anyone who can open the page — never commit one to your repository. Finnhub\'s free tier is regular-session only.</span></div>' +
        '<div class="row"><button class="btn btn--primary" type="button" data-action="test-connection" id="test-btn">Test connection</button><span class="muted" style="font-size:12.5px">Probes each route one at a time with the exact request the app uses.</span></div>' +
        '<div id="test-results" aria-live="polite"></div>' +
      '</section>' +

      '<section class="card" aria-labelledby="s-ov"><h2 class="card__title" id="s-ov">Manual price overrides</h2>' +
        '<p class="muted" style="font-size:13px">Pin a price for anything without a reliable feed. Overrides are stored separately from fetched prices and exported in their own section, so it\'s always clear what was typed in by hand.</p>' +
        '<div class="ov-list">' + (Object.keys(ov).length ? Object.entries(ov).map(([k, o]) =>
          '<div class="ov"><span><strong>' + esc(o.symbol || k) + '</strong> <span class="num">' + F.price(o.price) + '</span> <span class="muted">set ' + F.dateTime(o.setAt) + (o.note ? ' · ' + esc(o.note) : '') + '</span></span>' +
          '<button class="btn btn--sm" type="button" data-action="remove-override" data-key="' + esc(k) + '">Remove</button></div>').join('') : '<p class="muted">No overrides.</p>') + '</div>' +
        '<form class="row" id="ov-form" style="align-items:flex-end">' +
          '<div class="field"><label for="ov-pos">Position</label><select class="select" id="ov-pos">' + open.map(r => '<option value="' + esc(r.key) + '">' + esc(r.symbol + ' — ' + r.name) + '</option>').join('') + '</select></div>' +
          '<div class="field" style="flex:0 1 150px"><label for="ov-price">Price (' + s.baseCurrency + ')</label><input class="input num" id="ov-price" inputmode="decimal" autocomplete="off"></div>' +
          '<div class="field"><label for="ov-note">Note</label><input class="input" id="ov-note" placeholder="Where the price came from" autocomplete="off"></div>' +
          '<button class="btn" type="submit"' + (open.length ? '' : ' disabled') + '>Pin price</button></form>' +
      '</section>' +

      '<section class="card danger-zone" aria-labelledby="s-rst"><h2 class="card__title" id="s-rst">Reset</h2>' +
        '<p class="field__hint" id="app-version">Ledgerline version <span class="num">' + esc(C.APP_VERSION) + '</span> — if your phone shows an older number, reload the page.</p>' +
        '<div class="stack" style="gap:8px">' +
        '<button class="btn" type="button" data-action="clear-cache">Clear price cache <span class="muted">— refetches everything</span></button>' +
        '<button class="btn" type="button" data-action="clear-history">Clear recorded history <span class="muted">— snapshots only</span></button>' +
        '<button class="btn btn--danger" type="button" data-action="reset-all">Reset everything</button></div>' +
      '</section>' +
      '</div></div>';

    renderTest(document.getElementById('test-results'));
    bind(root, app);
  }

  function bind(root, app) {
    PT.sync.bindCard(root, app);
    if (PT.pwa) PT.pwa.bindCard(root);
    root.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => {
      book.saveSettings({ [b.dataset.set]: b.dataset.val });
      if (b.dataset.set === 'theme') UI.toast('Theme: ' + b.textContent, 'ok', 1500);
    }));
    root.querySelector('[data-set-select="refreshSec"]').addEventListener('change', e => book.saveSettings({ refreshSec: +e.target.value }));
    root.querySelector('[data-set-check="extendedHours"]').addEventListener('change', e => book.saveSettings({ extendedHours: e.target.checked }));

    const relay = document.getElementById('s-relay');
    const saveRelay = () => {
      const v = PT.providers.normaliseRelayUrl(relay.value);
      if (v && v !== relay.value.trim()) document.getElementById('relay-hint').innerHTML = 'Corrected to <code>' + esc(v) + '</code>';
      relay.value = v;
      book.saveSettings({ relayUrl: v });
      UI.toast(v ? 'Relay saved' : 'Relay removed', 'ok', 1600);
    };
    root.querySelector('[data-action="save-relay"]').addEventListener('click', saveRelay);
    relay.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveRelay(); } });
    root.querySelector('[data-action="save-key"]').addEventListener('click', () => {
      book.saveSettings({ finnhubKey: document.getElementById('s-key').value.trim() });
      UI.toast('Finnhub key saved in this browser', 'ok', 1600);
    });

    root.querySelector('[data-action="test-connection"]').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Testing…';
      lastTest = { rows: [], summary: null };
      const host = document.getElementById('test-results');
      renderTest(host);
      const positions = app.openPositions();
      const res = await PT.market.connectionTest(positions, app.state.settings, (row, rows) => {
        lastTest.rows = rows.slice();
        const h = document.getElementById('test-results'); if (h) renderTest(h);
      });
      lastTest = res;
      const h = document.getElementById('test-results'); if (h) renderTest(h);
      const b = document.getElementById('test-btn'); if (b) { b.disabled = false; b.textContent = 'Test connection'; }
    });

    root.querySelector('#ov-form').addEventListener('submit', e => {
      e.preventDefault();
      const key = document.getElementById('ov-pos').value;
      const priceField = document.getElementById('ov-price');
      const v = U.parseNum(priceField.value);
      if (!(v >= 0) || !key) { priceField.classList.add('is-invalid'); priceField.focus(); UI.toast('Enter a price of 0 or more', 'error'); return; }
      const row = app.state.summary.rows.find(r => r.key === key);
      book.setOverride(key, { price: U.fromBase(v), enteredPrice: v, enteredCurrency: app.state.settings.baseCurrency, setAt: Date.now(),
        note: document.getElementById('ov-note').value.trim(), symbol: row ? row.symbol : '', name: row ? row.name : '' });
      UI.toast('Manual price pinned', 'ok');
    });
    root.querySelectorAll('[data-action="remove-override"]').forEach(b => b.addEventListener('click', () => book.removeOverride(b.dataset.key)));

    const stamp = () => new Date().toISOString().slice(0, 10);
    root.querySelector('[data-action="export-json"]').addEventListener('click', () => UI.download('ledgerline-backup-' + stamp() + '.json', exportJSON(), 'application/json'));
    root.querySelector('[data-action="export-csv"]').addEventListener('click', () => UI.download('ledgerline-transactions-' + stamp() + '.csv', exportCSV(), 'text/csv'));
    root.querySelector('[data-action="import"]').addEventListener('click', () => {
      const f = document.getElementById('imp-file').files[0];
      if (!f) { const i = document.getElementById('imp-file'); i.classList.add('is-invalid'); i.focus(); UI.toast('Choose a .json or .csv file first', 'error'); return; }
      doImport(f, document.getElementById('imp-mode').value);
    });

    root.querySelector('[data-action="clear-cache"]').addEventListener('click', async () => {
      if (await UI.confirm({ title: 'Clear the price cache?', body: 'Cached quotes, price histories and the FX rate are deleted and fetched again. Your transactions are not touched.', confirmLabel: 'Clear cache' })) {
        PT.market.clearCache(); UI.toast('Price cache cleared — refreshing', 'ok'); app.refresh(false);
      }
    });
    root.querySelector('[data-action="clear-history"]').addEventListener('click', async () => {
      if (await UI.confirm({ title: 'Clear recorded history?', body: 'Recorded value snapshots are deleted. The performance chart falls back to reconstruction from price history. Transactions are not touched.', confirmLabel: 'Clear history', danger: true })) {
        PT.market.clearHistory(); UI.toast('Recorded history cleared', 'ok');
      }
    });
    root.querySelector('[data-action="reset-all"]').addEventListener('click', async () => {
      if (await UI.confirm({ title: 'Reset everything?', danger: true, confirmLabel: 'Delete all my data',
        html: '<p>This permanently deletes <strong>all ' + app.state.txs.length + ' transactions</strong>, manual prices, settings and cached market data from this browser.</p><p class="muted" style="margin-top:8px">Export a JSON backup first if you might want it back.</p>' })) {
        PT.store.resetEverything();
        PT.market.state.quotes = {}; PT.market.state.status = {};
        UI.toast('Everything was reset', 'ok');
      }
    });
  }

  PT.settingsView = { view, exportJSON, exportCSV, parseImport, doImport };
})(window.PT);
