/* ==========================================================================
   app.js — boot, state, hash routing, refresh scheduling, shortcuts and
   global event delegation.
   --------------------------------------------------------------------------
   Data flow:
     store.book (your data) ──► portfolio.derive ──► positions (never stored)
     market (prices, read-only view of positions) ──► summarise ──► views
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, S = PT.store, P = PT.portfolio, C = PT.config, UI = PT.ui;
  const app = { state: {}, perfRange: '1M', route: null };
  PT.app = app;
  const VIEWER = !!(PT.viewer && PT.viewer.active);     // opened from a read-only share link
  // things a viewer can't do (their buttons are hidden too — this is the backstop)
  const EDIT_ACTIONS = ['add-trade', 'buy-more', 'sell', 'edit-tx', 'delete-tx', 'load-seed'];

  /* ---------------- seed ---------------- */
  function seedTransactions() {
    const when = new Date(U.fromLocalInput(C.SEED_DATE)).toISOString();
    return C.SEED_HOLDINGS.map((h, i) => P.normalise({
      id: 'seed-' + h.symbol.toLowerCase() + '-' + i, type: h.type, symbol: h.symbol, name: h.name, side: 'buy',
      quantity: h.invested / h.avg, price: h.avg, fees: 0, currency: 'USD', date: when,
      notes: 'Starter holding (' + F.moneyIn(h.invested, 'USD') + ' at ' + h.avg + ')', meta: h.meta, createdAt: i + 1
    }));
  }
  function seedIfNew() {
    if (S.book.hasBook() || S.book.wasSeeded()) return;
    S.book.replaceTransactions(seedTransactions());
    S.book.markSeeded();
  }
  app.loadSeed = function () {
    const existing = S.book.transactions();
    const add = seedTransactions().filter(t => !existing.some(x => x.id === t.id));
    S.book.replaceTransactions(existing.concat(add));
    UI.toast('Loaded ' + add.length + ' starter holdings', 'ok');
  };

  /* ---------------- state ---------------- */
  app.recompute = function () {
    const st = app.state;
    st.settings = S.book.settings();
    st.txs = S.book.transactions();
    st.overrides = S.book.overrides();
    const u2e = PT.market.usdToEur();
    const rate = u2e || C.FALLBACK_USD_EUR;
    PT.ctx.base = st.settings.baseCurrency;
    PT.ctx.rate = st.settings.baseCurrency === 'EUR' ? rate : 1;
    PT.ctx.fxOk = st.settings.baseCurrency === 'USD' || !!u2e;
    st.rates = { EUR: 1 / rate };
    st.derived = P.derive(st.txs, st.rates);
    st.summary = P.summarise(st.derived, pos => PT.market.quoteFor(pos, st.overrides));
    st.cash = P.cash(S.book.cash());
    return st;
  };

  app.openPositions = function () {
    const eurKeys = new Set(app.state.txs.filter(t => t.currency === 'EUR').map(P.assetKey));
    return Object.values(app.state.derived.positions).filter(p => p.open).map(p => Object.assign({}, p, { hasEur: eurKeys.has(p.key) }));
  };
  const needFx = () => app.state.settings.baseCurrency !== 'USD' || app.state.txs.some(t => t.currency === 'EUR');

  /* ---------------- theme ---------------- */
  function applyTheme() {
    const t = app.state.settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }

  /* ---------------- routing ---------------- */
  const NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dash' },
    { id: 'stocks', label: 'Stocks', type: 'stock' },
    { id: 'etfs', label: 'ETFs', type: 'etf' },
    { id: 'crypto', label: 'Crypto', type: 'crypto' },
    { id: 'memecoins', label: 'Memecoins', type: 'memecoin' },
    { id: 'pie', label: 'Pie', icon: 'pie' },
    { id: 'transactions', label: 'Transactions', icon: 'tx' },
    { id: 'cash', label: 'Cash', icon: 'cash' },
    { id: 'settings', label: 'Settings', icon: 'cog' }
  ].filter(n => !(VIEWER && n.id === 'settings'));
  function parseRoute() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    const [name, ...rest] = h.split('/');
    if (name === 'position' && rest.length) return { name: 'position', key: decodeURIComponent(rest.join('/')) };
    if (NAV.some(n => n.id === name)) return { name };      // (Settings isn't in NAV for a viewer)
    return { name: 'dashboard' };
  }

  function renderNav(route) {
    const s = app.state.summary;
    const cur = route.name === 'position' ? (UI.TYPE[(app.state.derived.positions[route.key] || {}).type] || {}).route : route.name;
    const items = NAV.map(n => {
      const count = n.type ? s.byClass[n.type].count : n.id === 'transactions' ? app.state.txs.length :
        n.id === 'cash' && app.state.cash.used ? F.money(app.state.cash.balance, { compact: true }) : null;
      const icon = n.type ? '<span class="swatch swatch--' + n.type + '" aria-hidden="true" style="width:10px;height:10px;margin:0 4px"></span>' : UI.icon(n.icon);
      return { n, count, icon, current: cur === n.id };
    });
    document.getElementById('nav').innerHTML = items.map((x, i) =>
      (i === 1 ? '<div class="nav__label">Asset classes</div>' : i === 5 ? '<div class="nav__label">Invest & records</div>' : '') +
      '<a href="#/' + x.n.id + '"' + (x.current ? ' aria-current="page"' : '') + '>' + x.icon + '<span>' + x.n.label + '</span>' +
      (x.count != null ? '<span class="nav__count">' + x.count + '</span>' : '') + '</a>').join('');
    document.getElementById('topnav').innerHTML = items.map(x =>
      '<a href="#/' + x.n.id + '"' + (x.current ? ' aria-current="page"' : '') + '>' + (x.n.type ? x.icon : '') + x.n.label + '</a>').join('');
    const active = document.querySelector('#topnav [aria-current]');
    if (active && active.scrollIntoView && app._navScrolled !== cur) {
      app._navScrolled = cur;
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  /**
   * Render the current route. soft=true is a background re-render (prices
   * updated): keep scroll and focus, and on form-heavy screens only refresh
   * the data parts so nothing the user is typing is lost.
   */
  app.render = function (mode) {
    // mode: false = navigation, 'full' = same-route full re-render (data you changed),
    //       true = background refresh (prices) — the lightest possible update
    const soft = mode === true;
    const route = parseRoute();
    const view = document.getElementById('view');
    const same = app.route && app.route.name === route.name && app.route.key === route.key;
    app.route = route;
    renderNav(route);
    renderStatus();

    if (soft && same && route.name === 'settings') {
      const card = document.getElementById('s-stat');
      if (card) {
        const tmp = document.createElement('div');
        PT.settingsView.view(tmp, app);    // cheap: build once off-screen, lift the status card out
        const fresh = tmp.querySelector('[aria-labelledby="s-stat"]');
        const old = card.closest('section');
        if (fresh && old) old.replaceWith(fresh);
      }
      return;
    }
    if (soft && same && route.name === 'cash') { PT.cashView.refreshFigures(app); return; }
    if (soft && same && route.name === 'pie') { PT.pieView.refreshFigures(app); return; }
    if (soft && same && route.name === 'transactions' && document.getElementById('tx-table')) {
      // re-render the table only; filters keep their focus and values
      const f = document.activeElement && document.activeElement.id;
      PT.txview.renderTable(app.state);
      if (f && document.getElementById(f)) document.getElementById(f).focus({ preventScroll: true });
      return;
    }
    if (soft && same && route.name === 'position' && view.querySelector('iframe.embed')) {
      // Keep the Dexscreener embed alive: detaching an iframe reloads it.
      const tmp = document.createElement('div');
      PT.views.position(tmp, app, route.key);
      if (patchKeepingEmbed(view, tmp)) {
        if (VIEWER && !view.querySelector('.viewer-bar')) view.insertAdjacentHTML('afterbegin', PT.viewer.bannerHtml());
        return;
      }
    }

    const scrollY = window.scrollY;
    const focusId = document.activeElement && view.contains(document.activeElement) ? document.activeElement.id : null;
    PT.views.dispose();
    const blocked = VIEWER && PT.viewer.blockingHtml();
    if (blocked) { view.innerHTML = blocked; document.title = 'Shared portfolio · Ledgerline'; return; }
    const titles = { dashboard: 'Overview', stocks: 'Stocks', etfs: 'ETFs', crypto: 'Crypto', memecoins: 'Memecoins', transactions: 'Transactions', cash: 'Cash reserve', pie: 'Pie', settings: 'Settings' };
    switch (route.name) {
      case 'stocks': PT.views.assetClass(view, app, 'stock'); break;
      case 'etfs': PT.views.assetClass(view, app, 'etf'); break;
      case 'crypto': PT.views.assetClass(view, app, 'crypto'); break;
      case 'memecoins': PT.views.assetClass(view, app, 'memecoin'); break;
      case 'transactions': PT.txview.view(view, app); break;
      case 'settings': PT.settingsView.view(view, app); break;
      case 'cash': PT.cashView.view(view, app); break;
      case 'pie': PT.pieView.view(view, app); break;
      case 'position': PT.views.position(view, app, route.key); break;
      default: PT.views.dashboard(view, app);
    }
    if (VIEWER) view.insertAdjacentHTML('afterbegin', PT.viewer.bannerHtml());
    const pos = route.name === 'position' ? app.state.derived.positions[route.key] : null;
    document.title = (pos ? pos.symbol + ' · ' : titles[route.name] ? titles[route.name] + ' · ' : '') + (VIEWER ? 'Shared portfolio · ' : '') + 'Ledgerline';
    if (same) {
      window.scrollTo(0, scrollY);
      if (focusId) { const el = document.getElementById(focusId); if (el) el.focus({ preventScroll: true }); }
    } else if (!mode) {
      window.scrollTo(0, 0);
      view.focus({ preventScroll: true });
    }
  };

  function patchKeepingEmbed(view, tmp) {
    const keep = view.querySelector('iframe.embed');
    const keepSection = keep && keep.closest('section');
    const oldStack = view.querySelector('.stack'), newStack = tmp.querySelector('.stack');
    if (!keepSection || !oldStack || !newStack || oldStack.children.length !== newStack.children.length) return false;
    const oldKids = [...oldStack.children], newKids = [...newStack.children];
    [...view.children].forEach(c => { if (c !== oldStack) c.remove(); });
    [...tmp.children].forEach(c => { if (c !== newStack) view.insertBefore(c, oldStack); });
    oldKids.forEach((c, i) => { if (c !== keepSection) c.replaceWith(newKids[i]); });
    return true;
  }

  /* ---------------- status line ---------------- */
  function renderStatus() {
    const st = PT.market.state.status || {};
    const busy = !!PT.market.state.refreshing;
    const failing = app.state.summary ? app.state.summary.rows.filter(r => r.quote && r.quote.error).length : 0;
    const offline = navigator.onLine === false;
    const txt = offline ? 'Offline · ' + (st.lastRefresh ? 'prices from ' + F.ago(st.lastRefresh) : 'no prices yet')
      : busy ? 'Refreshing prices…' : st.lastRefresh ? 'Updated ' + F.ago(st.lastRefresh) + (failing ? ' · ' + failing + ' failing' : '') : 'Prices not loaded yet';
    const dot = offline ? ' is-warn' : busy ? ' is-busy' : failing ? ' is-warn' : '';
    const html = '<span class="status-dot' + dot + '" aria-hidden="true"></span><span>' + U.esc(txt) + '</span>';
    const a = document.getElementById('status-line'); if (a) a.innerHTML = html;
    const b = document.getElementById('status-line-m'); if (b) b.innerHTML = '<span class="status-dot' + dot + '" aria-hidden="true" title="' + U.esc(txt) + '"></span>';
    // device sync status (only when sync is on)
    const sl = VIEWER ? PT.viewer.statusLine() : PT.sync && PT.sync.statusLine();
    const where = VIEWER ? '#/dashboard' : '#/settings';
    const short = VIEWER ? (sl && sl.tone === 'warn' ? '⚠ Read-only' : 'Read-only') : sl && (sl.tone === 'ok' ? '⟳ Synced' : sl.tone === 'warn' ? '⚠ Sync' : '⟳ …');
    const sHtml = sl ? '<span class="status-dot' + (sl.tone === 'busy' ? ' is-busy' : sl.tone === 'warn' ? ' is-warn' : '') + '" aria-hidden="true"></span><a href="' + where + '" class="status-link">' + U.esc(sl.text) + '</a>' : '';
    const c = document.getElementById('sync-line'); if (c) { c.innerHTML = sHtml; c.hidden = !sl; }
    const d = document.getElementById('sync-line-m'); if (d) { d.innerHTML = sl ? '<a href="' + where + '" class="status-link" title="' + U.esc(sl.text) + '">' + short + '</a>' : ''; d.hidden = !sl; }
    document.querySelectorAll('[data-action="refresh"]').forEach(btn => btn.classList.toggle('is-spinning', busy));
  }

  /* ---------------- refresh ---------------- */
  app.refresh = function (manual) {
    const st = app.state;
    const positions = app.openPositions();
    if (!positions.length && !needFx()) { if (manual) UI.toast('Nothing to price yet', 'info'); return Promise.resolve(); }
    return PT.market.refresh(positions, st.settings, st.overrides, needFx()).then(res => {
      if (manual && res) {
        if (res.failed) UI.toast(res.ok + ' priced, ' + res.failed + ' failed — see the warning markers (details in Settings → Data status)', 'error', 5000);
        else UI.toast('Prices updated (' + res.ok + ')', 'ok', 1800);
      }
    });
  };

  let timer = null;
  function schedule() {
    clearInterval(timer);
    const sec = +app.state.settings.refreshSec;
    if (!sec) return;
    timer = setInterval(() => { if (!document.hidden) app.refresh(false); }, sec * 1000);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const sec = +app.state.settings.refreshSec;
    const last = (PT.market.state.status || {}).lastRefresh || 0;
    if (sec && Date.now() - last > sec * 1000) app.refresh(false);
  });

  /* ---------------- events ---------------- */
  U.on('book:changed', () => {
    app.recompute();
    app.render('full');
    // price anything newly added that has no quote yet
    const missing = app.state.summary.rows.some(r => !r.quote);
    if (missing) app.refresh(false);
  });
  U.on('settings:changed', patch => {
    app.recompute();
    applyTheme();
    if ('refreshSec' in patch) schedule();
    app.render('full');
    if (['baseCurrency', 'extendedHours', 'relayMode', 'relayUrl', 'finnhubKey'].some(k => k in patch)) app.refresh(false);
  });
  U.on('market:updated', () => {
    app.recompute();
    PT.market.recordSnapshot(app.state.summary);
    app.render(true);
  });
  U.on('market:refreshing', renderStatus);
  U.on('sync:status', () => {
    renderStatus();
    // on Settings, refresh the sync card (only the status line while the connect form may be in use)
    const card = document.getElementById('sync-card');
    if (!card) return;
    if (PT.sync.enabled()) { card.innerHTML = PT.sync.cardHtml(app); }
    else { const tmp = document.createElement('div'); tmp.innerHTML = PT.sync.cardHtml(app); const s = card.querySelector('#sync-status'); if (s) s.replaceWith(tmp.querySelector('#sync-status')); }
  });
  U.on('viewer:status', () => {
    renderStatus();
    const blocking = !!PT.viewer.blockingHtml();
    const showing = !!document.querySelector('#view .viewer-empty');
    if (blocking || showing) { app.render('full'); return; }   // switch between the message and the portfolio
    const bar = document.querySelector('#view .viewer-bar');
    if (bar) bar.outerHTML = PT.viewer.bannerHtml();
  });
  U.on('store:quota', () => UI.toast('Browser storage is full — export a backup, then clear recorded history in Settings.', 'error', 8000));

  /* #/add — the Dock icon's "Add trade" shortcut: open the form over the dashboard. */
  function takeAddRoute() {
    if (!/^#\/?add$/.test(location.hash)) return false;
    history.replaceState(null, '', location.pathname + location.search + '#/dashboard');
    if (!VIEWER) setTimeout(() => PT.modal.open({}), 0);
    return true;
  }
  window.addEventListener('hashchange', () => {
    if (takeAddRoute()) { app.render(false); return; }
    if (PT.modal.isOpen()) PT.modal.close();
    app.render(false);
  });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (app.state.settings.theme === 'system' && app.route && app.route.name === 'position') app.render('full'); });

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]');
    if (a) {
      const act = a.dataset.action;
      const key = a.dataset.key;
      if (VIEWER && EDIT_ACTIONS.includes(act)) { e.preventDefault(); return; }
      if (act === 'add-trade') { e.preventDefault(); PT.modal.open({ type: a.dataset.type }); return; }
      if (act === 'refresh') { app.refresh(true); return; }
      if (act === 'load-seed') { app.loadSeed(); return; }
      if (act === 'buy-more' || act === 'sell') { PT.modal.open({ position: app.state.derived.positions[key], side: act === 'sell' ? 'sell' : 'buy' }); return; }
      if (act === 'edit-tx') { const tx = app.state.txs.find(t => t.id === a.dataset.id); if (tx) PT.modal.open({ tx }); return; }
      if (act === 'delete-tx') { PT.txview.remove(a.dataset.id); return; }
      if (act === 'clear-filters') { PT.txview.clearFilters(); app.render(false); return; }
    }
    const sortBtn = e.target.closest('[data-sort-table]');
    if (sortBtn) {
      UI.setSort(sortBtn.dataset.sortTable, sortBtn.dataset.sortKey);
      const id = sortBtn.dataset.sortTable, key = sortBtn.dataset.sortKey;
      if (id === 'transactions') PT.txview.renderTable(app.state); else app.render('full');
      const again = document.querySelector('[data-sort-table="' + id + '"][data-sort-key="' + key + '"]');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) { UI.copy(copy.dataset.copy, 'Address copied'); return; }
    const pr = e.target.closest('[data-perf-range]');
    if (pr) { PT.views.setPerfRange(app, pr.dataset.perfRange); return; }
    const dr = e.target.closest('[data-detail-range]');
    if (dr) { PT.views.setDetailRange(app, dr.dataset.detailRange, app.route.key); return; }
    // whole-row navigation for tables (the first cell holds the real link for keyboard users)
    const tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a, button, input, select, label')) { location.hash = tr.dataset.href; }
  });
  document.addEventListener('change', e => {
    const sel = e.target.closest('[data-sort-select]');
    if (sel) {
      const [k, d] = sel.value.split('|');
      UI.setSortExact(sel.dataset.sortSelect, k, d);
      const id = sel.id;
      if (sel.dataset.sortSelect === 'transactions') PT.txview.renderTable(app.state); else app.render('full');
      const again = document.getElementById(id); if (again) again.focus({ preventScroll: true });
    }
  });

  /* keyboard: A = add trade, R = refresh (not while typing or in a dialog) */
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector('dialog[open]')) return;
    if ((e.key === 'a' || e.key === 'A') && !VIEWER) { e.preventDefault(); PT.modal.open({}); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); app.refresh(true); }
  });

  /* ---------------- "new version available" ----------------
     Browsers (Safari on iPhone especially) can keep running an old copy of the site after
     you upload new files. version.json is fetched fresh; if it names a different version
     than the one running, offer a one-tap reload. Your data is untouched by reloading. */
  let updateShown = false;
  async function checkForUpdate() {
    if (updateShown || location.protocol === 'file:') return;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const v = (await r.json()).version;
      if (v && v !== C.APP_VERSION) {
        updateShown = true;
        const bar = document.createElement('div');
        bar.className = 'update-bar'; bar.setAttribute('role', 'status');
        bar.innerHTML = '<span>Update available — version ' + U.esc(v) + '</span><button type="button" class="btn btn--sm btn--primary">Reload</button>';
        bar.querySelector('button').addEventListener('click', () => {
          const u = new URL(location.href); u.searchParams.set('v', v);    // new URL = no stale cache
          location.replace(u.toString());
        });
        document.body.appendChild(bar);
      }
    } catch (e) { /* offline or no version.json: nothing to say */ }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

  // tick the "updated x ago" text
  setInterval(renderStatus, 30000);

  /* ---------------- boot ---------------- */
  function boot() {
    if (VIEWER) document.body.classList.add('is-viewer');
    else seedIfNew();
    if (VIEWER) PT.viewer.start();      // shows any cached copy at once, then fetches the latest
    takeAddRoute();
    app.recompute();
    applyTheme();
    if (!S.book.isPersistent()) setTimeout(() => UI.toast('This browser is blocking storage — changes will be lost when the tab closes.', 'error', 9000), 400);
    app.render(false);
    schedule();
    app.refresh(false);
    if (!VIEWER) PT.sync.start();          // pull other devices' changes, push any unsynced ones
    checkForUpdate();
    if (PT.pwa) PT.pwa.init();             // Mac app: offline worker, install prompt, first-launch check
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})(window.PT);
