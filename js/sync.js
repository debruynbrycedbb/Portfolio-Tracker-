/* ==========================================================================
   sync.js — keeps your data the same on every device.
   --------------------------------------------------------------------------
   What syncs: transactions, cash reserve, pie, manual prices, and the shared
   settings (display currency, extended hours). What doesn't: prices and
   history caches (each device fetches its own — same trades + same prices =
   same portfolio value), theme, refresh interval, relay URL and API keys.

   How:
     • The server (your Cloudflare Worker + D1, see cors-worker.js) holds one
       document with a revision number.
     • A change here is saved ("pushed") ~1s later, stating the revision it
       was based on. If another device saved in between, the server refuses
       (409) and sends its copy; the two are merged and saved again.
     • Other devices' changes are fetched ("pulled") when the app opens, when
       you come back to the tab, and every minute while it's visible.
     • Merging is three-way and per record (trade, cash movement, manual
       price): this device remembers the copy it last synced, so it can tell
       "you deleted this" from "the other device added this". If both devices
       changed the SAME record, this device's version wins. If the merged
       result would be impossible (e.g. both sold the same shares), you're
       asked which version to keep — nothing is silently lost.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc, P = PT.portfolio, book = PT.store.book, store = PT.store;
  const PUSH_DELAY = 1200, PULL_EVERY = 60000, TIMEOUT = 15000;

  const S = {
    status: 'off',          // off | idle | syncing | error
    message: '',
    busy: null,             // in-flight promise
    pushTimer: 0,
    retryTimer: 0,
    share: { loaded: false, loading: false, token: null, createdAt: null, error: '' }   // read-only link
  };

  /* ---------------- helpers ---------------- */
  const settings = () => book.settings();
  function syncUrl(st) {
    st = st || settings();
    if (st.syncUrl) return st.syncUrl.trim();
    const relay = PT.providers.normaliseRelayUrl(st.relayUrl);
    if (!relay) return '';
    try { return new URL(relay).origin + '/sync'; } catch (e) { return ''; }
  }
  const enabled = st => { st = st || settings(); return !!(st.syncOn && st.syncKey && syncUrl(st)); };

  /** Canonical JSON (sorted keys), so equal data always compares equal. */
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  const same = (a, b) => canon(a) === canon(b);
  const clone = o => JSON.parse(JSON.stringify(o));

  function deviceName() {
    const st = settings();
    if (st.deviceName) return st.deviceName;
    const ua = navigator.userAgent || '';
    return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
      : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux computer' : 'This device';
  }

  function local() { return store.syncState.get() || { rev: 0, base: null, dirty: false, lastSyncAt: null }; }
  function saveLocal(patch) { const s = Object.assign(local(), patch); store.syncState.set(s); return s; }

  function setStatus(status, message) {
    S.status = status; S.message = message || '';
    U.emit('sync:status');
  }

  /** Low-level request with the sync key. Resolves { status, body } or throws on network failure. */
  async function request(method, body, st) {
    st = st || settings();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(syncUrl(st), {
        method, signal: ctrl.signal, credentials: 'omit', cache: 'no-store',
        headers: Object.assign({ Authorization: 'Bearer ' + st.syncKey }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* not JSON */ }
      return { status: res.status, body: json };
    } catch (e) {
      const err = new Error(ctrl.signal.aborted ? 'the sync server didn\'t answer within ' + TIMEOUT / 1000 + 's' : 'couldn\'t reach the sync server');
      err.network = true;
      throw err;
    } finally { clearTimeout(t); }
  }

  function explain(r) {
    const b = r.body || {};
    if (r.status === 401) return 'The sync key doesn\'t match the SYNC_KEY set on your Worker. Check it on both sides.';
    if (r.status === 501) return b.message || 'Sync isn\'t set up on your Worker yet (D1 binding "DB" and secret "SYNC_KEY").';
    if (r.status === 404 || r.status === 405) return 'That URL isn\'t a Ledgerline sync server — redeploy the latest cors-worker.js, which adds /sync.';
    if (r.status === 413) return b.message || 'Your data is too large to sync.';
    if (r.status === 403) return 'The Worker refused this site (ALLOWED_ORIGINS). Add this site\'s address there.';
    return (b && b.message) || 'The sync server answered HTTP ' + r.status + '.';
  }

  /* ---------------- three-way merge ---------------- */
  function mergeList(base, mine, theirs, idOf) {
    const idx = list => { const m = new Map(); (list || []).forEach(x => m.set(idOf(x), x)); return m; };
    const B = idx(base), L = idx(mine), R = idx(theirs);
    const ids = [...new Set([...R.keys(), ...L.keys()])];
    const out = [];
    ids.forEach(id => {
      const b = B.get(id), l = L.get(id), r = R.get(id);
      if (!b) { out.push(l && r ? (same(l, r) ? r : l) : (l || r)); return; }      // added on one or both sides
      const lc = !l ? 'del' : same(l, b) ? 'same' : 'mod';
      const rc = !r ? 'del' : same(r, b) ? 'same' : 'mod';
      if (lc === 'same') { if (rc !== 'del') out.push(r); return; }
      if (rc === 'same') { if (lc !== 'del') out.push(l); return; }
      if (lc === 'del' && rc === 'del') return;
      if (lc === 'del') { out.push(r); return; }        // edited there, deleted here: keep the edit (never lose data)
      if (rc === 'del') { out.push(l); return; }
      out.push(l);                                      // both edited the same record: this device wins
    });
    return out;
  }
  function mergeValue(b, l, r) { return same(l, b) ? r : same(r, b) ? l : l; }

  function merge3(base, mine, theirs) {
    base = base || { transactions: [], cash: [], pie: null, overrides: {}, settings: {} };
    const toList = o => Object.keys(o || {}).map(k => ({ k, v: o[k] }));
    const fromList = l => { const o = {}; l.forEach(x => { o[x.k] = x.v; }); return o; };
    const settingsOut = {};
    book.SHARED_SETTINGS.forEach(k => { settingsOut[k] = mergeValue((base.settings || {})[k], (mine.settings || {})[k], (theirs.settings || {})[k]); });
    const merged = {
      transactions: mergeList(base.transactions, mine.transactions, theirs.transactions, x => x.id),
      cash: mergeList(base.cash, mine.cash, theirs.cash, x => x.id),
      pie: mergeValue(base.pie, mine.pie, theirs.pie),
      overrides: fromList(mergeList(toList(base.overrides), toList(mine.overrides), toList(theirs.overrides), x => x.k)),
      settings: settingsOut
    };
    // a cash movement tied to a trade that no longer exists goes with it
    const ids = new Set(merged.transactions.map(t => t.id));
    merged.cash = merged.cash.filter(e => !e.txId || ids.has(e.txId));
    return merged;
  }
  /** Is a merged document still a possible history? */
  function problemsIn(doc) {
    const d = P.derive(doc.transactions, PT.app.state.rates);
    if (d.problems.length) {
      const p = d.problems[0];
      return 'a sell of ' + F.qty(p.wanted) + ' ' + p.symbol + ' would exceed the ' + F.qty(p.held) + ' held at the time';
    }
    const bal = P.cash(doc.cash).balance;
    if (bal < -P.CASH_TOLERANCE) return 'the cash reserve would go below zero (' + F.money(bal) + ')';
    return null;
  }

  const summaryOf = doc => (doc ? doc.transactions.length + ' trade' + (doc.transactions.length === 1 ? '' : 's') +
    (doc.cash && doc.cash.length ? ', ' + doc.cash.length + ' cash movement' + (doc.cash.length === 1 ? '' : 's') : '') : 'nothing');

  /* ---------------- core: reconcile with a copy from the server ---------------- */
  async function reconcile(remote) {
    const st = local();
    const mine = book.syncDoc();
    const theirs = remote.data;
    if (!st.dirty) {
      // nothing unsynced here: simply take the server's copy
      if (!same(mine, theirs)) book.applySyncDoc(theirs);
      saveLocal({ rev: remote.rev, base: theirs, dirty: false, lastSyncAt: Date.now() });
      return false;
    }
    const merged = merge3(st.base, mine, theirs);
    const problem = problemsIn(merged);
    if (problem) {
      const pick = await PT.ui.choose({
        title: 'Your devices made conflicting changes',
        html: '<p>Combining this device\'s changes with those saved from <strong>' + esc(remote.device || 'another device') + '</strong>' +
          (remote.updatedAt ? ' at ' + esc(F.dateTime(remote.updatedAt)) : '') + ' isn\'t possible: ' + esc(problem) + '.</p>' +
          '<p style="margin-top:8px">Choose which version to keep. Tip: export a backup of this device first (Settings → Backup) if you want to keep both.</p>',
        options: [{ id: 'theirs', label: 'Use the other device\'s version (' + summaryOf(theirs) + ')' }, { id: 'mine', label: 'Keep this device\'s version (' + summaryOf(mine) + ')', primary: true }]
      });
      if (pick === 'theirs') { book.applySyncDoc(theirs); saveLocal({ rev: remote.rev, base: theirs, dirty: false, lastSyncAt: Date.now() }); return false; }
      if (pick === 'mine') { saveLocal({ rev: remote.rev, base: theirs, dirty: true }); return true; }
      setStatus('error', 'Sync paused: conflicting changes are waiting for your choice. Press "Sync now" to decide.');
      throw Object.assign(new Error('conflict unresolved'), { quiet: true });
    }
    if (!same(merged, mine)) book.applySyncDoc(merged);
    const stillDirty = !same(merged, theirs);
    saveLocal({ rev: remote.rev, base: theirs, dirty: stillDirty, lastSyncAt: Date.now() });
    return stillDirty;
  }

  /* ---------------- pull & push ---------------- */
  async function pullOnce() {
    const r = await request('GET');
    if (r.status !== 200) throw Object.assign(new Error(explain(r)), { http: r.status });
    const remote = r.body;
    const st = local();
    if (remote.rev === 0 || remote.data == null) {
      // server is empty (new or wiped): this device's copy becomes the synced one
      saveLocal({ rev: 0, dirty: true });
      return true;
    }
    if (remote.rev === st.rev) return st.dirty;
    return reconcile(remote);
  }

  async function pushOnce() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const st = local();
      const doc = book.syncDoc();
      const r = await request('PUT', { baseRev: st.rev, data: doc, device: deviceName() });
      if (r.status === 200) {
        const changedMeanwhile = !same(doc, book.syncDoc());
        saveLocal({ rev: r.body.rev, base: doc, dirty: changedMeanwhile, lastSyncAt: Date.now() });
        if (!changedMeanwhile) return;
        continue;
      }
      if (r.status === 409 && r.body && r.body.current) {
        const needPush = await reconcile(r.body.current);
        if (!needPush) return;
        continue;
      }
      throw Object.assign(new Error(explain(r)), { http: r.status });
    }
    throw new Error('the server kept changing while saving — try again in a moment');
  }

  /** Pull, then push if anything here is unsynced. Serialised: one run at a time. */
  function syncNow(reason) {
    if (!enabled()) return Promise.resolve();
    if (S.busy) { S.again = true; return S.busy; }
    clearTimeout(S.retryTimer);
    setStatus('syncing', reason === 'push' ? 'Saving your changes…' : 'Checking for changes…');
    S.busy = (async () => {
      try {
        const needPush = await pullOnce();
        if (needPush || local().dirty) await pushOnce();
        setStatus('idle', '');
      } catch (e) {
        if (e.quiet) return;
        setStatus('error', e.network ? 'Offline — ' + e.message + '. Changes are kept here and will sync when the server is reachable.' : e.message);
        // retry automatically only for temporary problems
        if (e.network || !e.http || e.http >= 500) S.retryTimer = setTimeout(() => syncNow('retry'), 30000);
      }
    })().finally(() => {
      S.busy = null;
      if (S.again) { S.again = false; syncNow('push'); }
    });
    return S.busy;
  }

  function schedulePush() {
    saveLocal({ dirty: true });
    if (!enabled()) return;
    clearTimeout(S.pushTimer);
    S.pushTimer = setTimeout(() => syncNow('push'), PUSH_DELAY);
    U.emit('sync:status');
  }

  /* ---------------- connect / disconnect ---------------- */
  /**
   * First connection on this device. If the server already holds a portfolio that differs
   * from this device's, you choose: use the synced one (usual on a new phone) or replace it.
   */
  async function connect(opts) {
    const st = Object.assign(settings(), opts);
    if (!st.syncKey || st.syncKey.length < 16) return { ok: false, message: 'Enter the sync key (at least 16 characters) — the same SYNC_KEY secret you set on the Worker.' };
    if (!syncUrl(st)) return { ok: false, message: 'Enter the sync server URL, or set your relay URL first (sync uses the same Worker).' };
    let r;
    try { r = await request('GET', null, st); }
    catch (e) { return { ok: false, message: 'Couldn\'t connect: ' + e.message + '. Check the URL and that the Worker is deployed.' }; }
    if (r.status !== 200) return { ok: false, message: explain(r) };
    const remote = r.body;
    const mine = book.syncDoc();
    store.syncState.clear();
    if (remote.rev > 0 && remote.data && !same(remote.data, mine)) {
      const pick = await PT.ui.choose({
        title: 'This portfolio is already synced from another device',
        html: '<p>The synced copy (saved by <strong>' + esc(remote.device || 'another device') + '</strong>' + (remote.updatedAt ? ' on ' + esc(F.dateTime(remote.updatedAt)) : '') +
          ') has <strong>' + esc(summaryOf(remote.data)) + '</strong>. This device has <strong>' + esc(summaryOf(mine)) + '</strong>.</p>' +
          '<p style="margin-top:8px">On a new phone or browser, choose <em>Use the synced portfolio</em>.</p>',
        options: [
          { id: 'mine', label: 'Replace the synced copy with this device\'s', danger: true },
          { id: 'theirs', label: 'Use the synced portfolio', primary: true }
        ]
      });
      if (!pick) return { ok: false, message: 'Not connected — nothing was changed.' };
      book.saveSettings({ syncUrl: st.syncUrl || '', syncKey: st.syncKey, deviceName: st.deviceName || '', syncOn: true });
      if (pick === 'theirs') {
        book.applySyncDoc(remote.data);
        saveLocal({ rev: remote.rev, base: remote.data, dirty: false, lastSyncAt: Date.now() });
      } else {
        saveLocal({ rev: remote.rev, base: remote.data, dirty: true });
        // overwrite: make this device's copy win every record
        await syncNowReplacing();
      }
    } else {
      book.saveSettings({ syncUrl: st.syncUrl || '', syncKey: st.syncKey, deviceName: st.deviceName || '', syncOn: true });
      saveLocal({ rev: remote.rev, base: remote.rev ? remote.data : null, dirty: remote.rev === 0, lastSyncAt: remote.rev ? Date.now() : null });
    }
    await syncNow('connect');
    return { ok: S.status !== 'error', message: S.status === 'error' ? S.message : 'Connected — this device is in sync.' };
  }
  /** "Replace the synced copy": push this device's document as-is on top of the latest revision. */
  async function syncNowReplacing() {
    const r = await request('GET');
    if (r.status === 200) saveLocal({ rev: r.body.rev, base: r.body.data, dirty: true });
    const put = await request('PUT', { baseRev: local().rev, data: book.syncDoc(), device: deviceName() });
    if (put.status === 200) saveLocal({ rev: put.body.rev, base: book.syncDoc(), dirty: false, lastSyncAt: Date.now() });
  }

  function disconnect() {
    clearTimeout(S.pushTimer); clearTimeout(S.retryTimer);
    store.syncState.clear();
    S.share = { loaded: false, loading: false, token: null, createdAt: null, error: '' };
    book.saveSettings({ syncOn: false });
    setStatus('off', '');
  }

  function generateKey() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';          // no look-alikes (l/1, o/0)
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    let s = '';
    bytes.forEach((b, i) => { s += alphabet[b % 32] + ((i % 4 === 3 && i < 23) ? '-' : ''); });
    return s;                                                  // 6 groups of 4: ~120 bits
  }

  /* ---------------- read-only share link ----------------
     The Worker keeps one random view token (D1). A link carrying it opens this site as a
     read-only viewer. The sync key is never in the link. */
  async function shareRequest(method) {
    const st = settings();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(syncUrl(st).replace(/\/+$/, '') + '/share', {
        method, signal: ctrl.signal, credentials: 'omit', cache: 'no-store', headers: { Authorization: 'Bearer ' + st.syncKey }
      });
      let body = null;
      try { body = await res.json(); } catch (e) { /* not JSON */ }
      if (res.status === 200 && body) return body;
      if (res.status === 404 || res.status === 405) throw new Error('Your Worker is an older version without share links — paste the latest cors-worker.js into it and Deploy.');
      throw new Error(explain({ status: res.status, body }));
    } catch (e) {
      if (e.name === 'AbortError' || ctrl.signal.aborted) throw new Error('the sync server didn\'t answer');
      if (e instanceof TypeError) throw new Error('couldn\'t reach the sync server');
      throw e;
    } finally { clearTimeout(t); }
  }
  async function shareDo(method) {
    const sh = S.share;
    sh.loading = true; sh.error = ''; U.emit('sync:status');
    try { const b = await shareRequest(method); sh.token = b.token || null; sh.createdAt = b.createdAt || null; sh.loaded = true; }
    catch (e) { sh.error = e.message; }
    finally { sh.loading = false; U.emit('sync:status'); }
    return !sh.error;
  }
  function loadShare() {
    const sh = S.share;
    if (sh.loaded || sh.loading || sh.error || !enabled()) return;
    shareDo('GET');
  }
  /** The link to send: this site's address + ?view=<token>&w=<your Worker's host>. */
  function shareLink(token) {
    const worker = new URL(syncUrl()).origin;
    const w = worker.indexOf('https://') === 0 ? worker.slice(8) : worker;
    return location.origin + location.pathname + '?view=' + encodeURIComponent(token) + '&w=' + encodeURIComponent(w);
  }
  function shareHtml() {
    const sh = S.share;
    const head = '<div class="share-box" id="share-box"><div class="share-box__title">' + PT.ui.icon('link') + 'Share a read-only view</div>';
    if (location.protocol === 'file:') return head + '<p class="field__hint">Open the site from its web address (e.g. your GitHub Pages URL) to make a share link.</p></div>';
    if (sh.error) return head + '<p class="field__hint is-loss" role="alert">' + esc(sh.error) + '</p><div class="row"><button type="button" class="btn btn--sm" data-sync="share-retry">Try again</button></div></div>';
    if (!sh.loaded) return head + '<p class="field__hint">Checking…</p></div>';
    if (!sh.token) {
      return head + '<p class="field__hint">Make a private link that shows your portfolio — holdings, values, P&L, trades and cash — with live prices. People who open it can\'t change anything and don\'t need a key. You can replace or switch off the link at any time.</p>' +
        '<div class="row"><button type="button" class="btn" data-sync="share-create"' + (sh.loading ? ' disabled' : '') + '>' + (sh.loading ? 'Creating…' : 'Create share link') + '</button></div></div>';
    }
    const link = shareLink(sh.token);
    return head + '<div class="share-link"><input class="input" id="share-url" readonly value="' + esc(link) + '" aria-label="Read-only share link">' +
      '<button type="button" class="btn btn--primary" data-sync="share-copy">Copy link</button></div>' +
      '<p class="field__hint">Anyone with this link sees your full portfolio (read-only) and it stays up to date as you trade. Your sync key is not in the link.' +
      (sh.createdAt ? ' Made ' + esc(F.ago(sh.createdAt)) + '.' : '') + '</p>' +
      '<div class="row"><button type="button" class="btn btn--sm" data-sync="share-new"' + (sh.loading ? ' disabled' : '') + '>New link</button>' +
      '<button type="button" class="btn btn--sm btn--ghost" data-sync="share-off"' + (sh.loading ? ' disabled' : '') + '>Turn off</button>' +
      '<a class="btn btn--sm btn--ghost" href="' + esc(link) + '" target="_blank" rel="noopener">Preview</a></div></div>';
  }

  /* ---------------- status & UI ---------------- */
  function statusLine() {
    if (!enabled()) return null;
    const st = local();
    if (S.status === 'syncing') return { tone: 'busy', text: 'Syncing…' };
    if (S.status === 'error') return { tone: 'warn', text: 'Sync problem' };
    if (st.dirty) return { tone: 'busy', text: 'Unsynced changes' };
    return { tone: 'ok', text: 'Synced' + (st.lastSyncAt ? ' ' + F.ago(st.lastSyncAt) : '') };
  }

  function cardHtml(app) {
    const st = settings();
    const on = enabled(st);
    const ls = local();
    const derived = syncUrl(Object.assign({}, st, { syncUrl: '' }));
    const badge = !on ? PT.ui.badge('Off', 'muted') : S.status === 'error' ? PT.ui.badge('Problem', 'fail') : S.status === 'syncing' || ls.dirty ? PT.ui.badge('Syncing', 'session') : PT.ui.badge('Synced', 'ok');
    const statusText = !on ? 'This device keeps its own copy. Connect to share one portfolio across your computer, phone and other browsers.'
      : S.status === 'error' ? S.message
      : 'Connected as <strong>' + esc(deviceName()) + '</strong> · ' + (ls.lastSyncAt ? 'last synced ' + esc(F.ago(ls.lastSyncAt)) : 'not synced yet') + ' · revision ' + (ls.rev || 0);
    return '<div class="sync-status" id="sync-status" role="status">' + badge + '<span>' + statusText + '</span></div>' +
      (on
        ? '<div class="row"><button type="button" class="btn btn--primary" data-sync="now">Sync now</button>' +
          '<button type="button" class="btn" data-sync="showkey">Show sync key</button>' +
          '<button type="button" class="btn btn--ghost" data-sync="off">Disconnect this device</button></div>' +
          '<p class="field__hint" id="sync-key-reveal" hidden></p>' +
          '<p class="field__hint">Syncs trades, cash reserve, pie, manual prices, display currency and extended-hours setting. Prices are fetched on each device, so the same trades give the same portfolio value.</p>' +
          (setTimeout(loadShare, 0), shareHtml())
        : '<div class="field"><label for="sync-key">Sync key</label><div class="row" style="flex-wrap:nowrap">' +
            '<input class="input num" id="sync-key" type="password" autocomplete="off" spellcheck="false" placeholder="the SYNC_KEY secret on your Worker" value="' + esc(st.syncKey) + '" style="flex:1;min-width:0">' +
            '<button type="button" class="btn" data-sync="gen">Generate</button></div>' +
            '<span class="field__hint" id="sync-gen-hint">Use the same key on every device. Generate one on your first device, then set it as SYNC_KEY on the Worker.</span></div>' +
          '<div class="field"><label for="sync-url">Sync server</label><input class="input" id="sync-url" type="url" autocomplete="off" spellcheck="false" placeholder="' + esc(derived || 'https://pt-relay.yourname.workers.dev/sync') + '" value="' + esc(st.syncUrl) + '">' +
            '<span class="field__hint">' + (derived ? 'Leave empty to use your relay Worker: <code>' + esc(derived) + '</code>' : 'Set your relay URL above first, or paste your Worker URL followed by <code>/sync</code>.') + '</span></div>' +
          '<div class="field"><label for="sync-device">Name for this device <span class="muted">(optional)</span></label><input class="input" id="sync-device" autocomplete="off" placeholder="' + esc(deviceName()) + '" value="' + esc(st.deviceName) + '"></div>' +
          '<div class="row"><button type="button" class="btn btn--primary" data-sync="connect">Connect</button><span class="muted" id="sync-msg" style="font-size:13px" role="status"></span></div>' +
          '<details class="sync-steps"><summary>How to set it up (about 5 minutes, free)</summary><ol>' +
            '<li>Deploy the latest <code>cors-worker.js</code> to your Cloudflare Worker (the same one used for stock prices).</li>' +
            '<li>Cloudflare dashboard → Storage & databases → <strong>D1 SQLite Database</strong> → <strong>Create Database</strong> → Name <code>ledgerline</code> → leave Data location as it is → <strong>Create</strong>.</li>' +
            '<li>Workers & Pages → your Worker → <strong>Bindings</strong> → <strong>Add binding</strong> → <strong>D1 database</strong> → Variable name <code>DB</code> → pick <code>ledgerline</code> → <strong>Add binding</strong>.</li>' +
            '<li>Your Worker → <strong>Settings</strong> → Variables and Secrets → <strong>Add</strong> → Type <strong>Secret</strong> → Variable name <code>SYNC_KEY</code> → Value: the key from <em>Generate</em> above → <strong>Deploy</strong>.</li>' +
            '<li>Press <strong>Connect</strong> here. Then on your phone: open the site → Settings → set the relay URL, paste the same sync key → Connect → <em>Use the synced portfolio</em>.</li>' +
          '</ol><p class="field__hint">The key is stored only in each device\'s browser and is never included in backups. Anyone with the key and your Worker URL could read your portfolio, so keep it private.</p></details>');
  }

  function bindCard(root, app) {
    const card = root.querySelector('#sync-card');
    if (!card) return;
    card.addEventListener('click', async e => {
      const b = e.target.closest('[data-sync]');
      if (!b) return;
      const act = b.dataset.sync;
      if (act === 'gen') {
        const k = generateKey();
        const input = card.querySelector('#sync-key');
        input.value = k; input.type = 'text';
        card.querySelector('#sync-gen-hint').innerHTML = 'New key generated. Copy it into the Worker as the <code>SYNC_KEY</code> secret, then press Connect. <button type="button" class="btn btn--sm" data-sync="copy">Copy key</button>';
      } else if (act === 'copy') {
        PT.ui.copy(card.querySelector('#sync-key').value, 'Sync key copied');
      } else if (act === 'connect') {
        const msg = card.querySelector('#sync-msg');
        b.disabled = true; msg.textContent = 'Connecting…';
        const res = await connect({ syncKey: card.querySelector('#sync-key').value.trim(), syncUrl: card.querySelector('#sync-url').value.trim(), deviceName: card.querySelector('#sync-device').value.trim() });
        const m = document.getElementById('sync-msg');
        if (m) { m.textContent = res.message; m.className = res.ok ? 'is-gain' : 'is-loss'; }
        const btn = card.querySelector('[data-sync="connect"]'); if (btn) btn.disabled = false;
        if (res.ok) PT.ui.toast(res.message, 'ok');
      } else if (act === 'now') {
        await syncNow('manual');
        PT.ui.toast(S.status === 'error' ? S.message : 'Everything is in sync', S.status === 'error' ? 'error' : 'ok', 4000);
      } else if (act === 'showkey') {
        const p = card.querySelector('#sync-key-reveal');
        p.hidden = !p.hidden;
        p.innerHTML = 'Sync key: <code>' + esc(settings().syncKey) + '</code> <button type="button" class="btn btn--sm" data-sync="copykey">Copy</button>';
      } else if (act === 'copykey') {
        PT.ui.copy(settings().syncKey, 'Sync key copied');
      } else if (act === 'share-create') {
        if (await shareDo('POST')) PT.ui.toast('Share link ready — copy it and send it to whoever you like', 'ok', 4000);
      } else if (act === 'share-copy') {
        PT.ui.copy(document.getElementById('share-url').value, 'Share link copied');
      } else if (act === 'share-new') {
        const ok = await PT.ui.confirm({ title: 'Make a new link?', confirmLabel: 'New link',
          body: 'The current link stops working straight away. Anyone you want to keep access will need the new link.' });
        if (ok && await shareDo('POST')) PT.ui.toast('New link made — the old one no longer works', 'ok', 4000);
      } else if (act === 'share-off') {
        const ok = await PT.ui.confirm({ title: 'Turn off the share link?', confirmLabel: 'Turn off', danger: true,
          body: 'The link stops working straight away and viewers see "This link is switched off". Your own devices keep syncing as normal.' });
        if (ok && await shareDo('DELETE')) PT.ui.toast('Share link switched off', 'ok');
      } else if (act === 'share-retry') {
        S.share.error = ''; S.share.loaded = false; loadShare();
      } else if (act === 'off') {
        const ok = await PT.ui.confirm({ title: 'Disconnect this device?', confirmLabel: 'Disconnect',
          body: 'This device keeps its current data but stops syncing. Your other devices and the synced copy are not affected. You can reconnect any time with the same key.' });
        if (ok) { disconnect(); PT.ui.toast('This device no longer syncs', 'ok'); }
      }
    });
  }

  /* ---------------- wiring ---------------- */
  U.on('book:changed', info => { if (!(info && info.fromSync) && enabled()) schedulePush(); });
  U.on('settings:changed', patch => {
    if (!patch || patch.fromSync) return;
    if (book.SHARED_SETTINGS.some(k => k in patch) && enabled()) schedulePush();
  });
  const pullIfVisible = () => { if (!document.hidden && enabled()) syncNow('pull'); };
  document.addEventListener('visibilitychange', pullIfVisible);
  window.addEventListener('focus', pullIfVisible);
  window.addEventListener('online', pullIfVisible);
  setInterval(pullIfVisible, PULL_EVERY);

  PT.sync = {
    start() { if (enabled()) { setStatus('idle'); syncNow('start'); } },
    syncNow, connect, disconnect, generateKey, enabled, syncUrl, statusLine, cardHtml, bindCard,
    merge3, state: S, _local: local, shareLink
  };
})(window.PT);
