/* ==========================================================================
   pwa.js — running Ledgerline as an app in your Mac's Dock.
   --------------------------------------------------------------------------
   Registers the offline worker (sw.js), holds the browser's install prompt
   for the Settings card, notices going offline and back, and handles the
   one part of installing that is easy to get wrong: your data does not
   automatically come with you.

   Why the first-launch notice exists: everything lives in the browser's
   storage. An app installed from Chrome shares Chrome's storage, so the
   portfolio, relay and sync are simply there. An app added to the Dock from
   Safari does NOT — Safari copies cookies into it and nothing else. It opens
   with the starter holdings, which look perfectly believable and are missing
   every trade since. A believable wrong number is the worst kind, so the app
   says so the first time it opens, and points at Sync to fix it.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, esc = U.esc, C = PT.config;
  const SEEN_KEY = 'pt:v1:app:welcomed';       // device-local; outside the book, never synced or exported
  const VIEWER = !!C.VIEW;
  let deferredPrompt = null;

  /* ---------------- detection ---------------- */
  function isInstalled() {
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    } catch (e) { /* old browser */ }
    return window.navigator.standalone === true;
  }
  function browser() {
    const ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'edge';
    if (/Chrome\/|Chromium\//.test(ua)) return 'chrome';
    if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
    if (/Firefox\//.test(ua)) return 'firefox';
    return 'other';
  }
  const isMac = () => /Mac/.test(navigator.platform || navigator.userAgent || '');
  const canPrompt = () => !!deferredPrompt;
  const secure = () => location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  /** The book holds the untouched starter holdings and nothing else. */
  function looksLikeStartingData() {
    const book = PT.store.book;
    const txs = book.transactions();
    const seed = C.SEED_HOLDINGS || [];
    if (!seed.length || txs.length !== seed.length) return false;
    if (book.cash().length || Object.keys(book.overrides()).length) return false;
    return txs.every(t => seed.some((h, i) => t.id === 'seed-' + h.symbol.toLowerCase() + '-' + i &&
      t.side === 'buy' && Math.abs(t.price - h.avg) < 1e-9 && Math.abs(t.quantity - h.invested / h.avg) < 1e-9));
  }

  function seen() { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ } }

  /* ---------------- offline worker ---------------- */
  function registerWorker() {
    // Workers need https (GitHub Pages) or localhost. Opened from a file on disk the site
    // still works — it just can't be installed.
    if (!('serviceWorker' in navigator) || !secure()) return;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => { reg.update().catch(() => {}); })        // look for a newer worker on every launch
      .catch(e => console.warn('[pwa] worker registration failed', e));
  }

  /* ---------------- install prompt (Chrome / Edge) ---------------- */
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();                 // offer it from Settings instead of at a random moment
    deferredPrompt = e;
    U.emit('pwa:changed');
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    PT.ui.toast('Installed — Ledgerline is in your Applications. Right-click its Dock icon → Options → Keep in Dock.', 'ok', 7000);
    U.emit('pwa:changed');
  });
  function promptInstall() {
    if (!deferredPrompt) return Promise.resolve(false);
    const p = deferredPrompt; deferredPrompt = null;
    p.prompt();
    return p.userChoice.then(c => { U.emit('pwa:changed'); return !!c && c.outcome === 'accepted'; });
  }

  /* ---------------- online / offline ---------------- */
  const setOnline = () => document.documentElement.classList.toggle('is-offline', !navigator.onLine);
  window.addEventListener('offline', () => {
    setOnline();
    PT.ui.toast('You\'re offline — showing the last prices received. They refresh when you reconnect.', 'info', 5000);
    if (PT.app && PT.app.route) PT.app.render(true);
  });
  window.addEventListener('online', () => {
    setOnline();
    PT.ui.toast('Back online — refreshing prices', 'ok', 2500);
    if (PT.app && PT.app.refresh) PT.app.refresh(false);
  });

  /* ---------------- first launch as an app ---------------- */
  // Any change to the book that isn't the starter holdings (sync pulled, import, a new trade)
  // means the data question is settled.
  U.on('book:changed', () => { if (!VIEWER && isInstalled() && !seen() && !looksLikeStartingData()) markSeen(); });

  function maybeWelcome() {
    if (VIEWER || !isInstalled() || seen()) return;
    const st = PT.store.book.settings();
    if (PT.sync && PT.sync.enabled()) {
      markSeen();
      PT.ui.toast('Ledgerline is running as an app — your portfolio and sync came with it.', 'ok', 5000);
      return;
    }
    if (!looksLikeStartingData()) {
      markSeen();
      PT.ui.toast('Ledgerline is running as an app — your portfolio is all here.' + (st.relayUrl ? '' : ' Add your relay URL in Settings for stock prices.'), 'ok', 6000);
      return;
    }
    showWelcome();
  }

  async function showWelcome() {
    const safari = browser() === 'safari';
    const html =
      '<p>' + (safari
        ? 'Apps added to the Dock from Safari get their own, empty storage — Safari copies nothing across except cookies. So this app has opened with the <strong>starter holdings</strong>, not your portfolio.'
        : 'This app has opened with the <strong>starter holdings</strong>. If you\'ve been using Ledgerline in another browser or profile, your portfolio is there, not here.') + '</p>' +
      '<div class="banner" style="margin:12px 0 0">' + PT.ui.icon('warn') + '<span>Every trade since the start — the KEYCAT sale, for example — is missing here. The figures will look reasonable and be wrong until you connect this app.</span></div>' +
      '<p style="margin:16px 0 6px;color:var(--ink)"><strong>Connect it with Sync — about a minute</strong></p>' +
      '<ol class="pwa-steps">' +
        '<li>In ' + (safari ? 'Safari' : 'your browser') + ', open Ledgerline → Settings. Copy your <strong>relay URL</strong> (Stock data relay) and, under Sync across devices, <strong>Show sync key → Copy</strong>.</li>' +
        '<li>Here in the app: Settings → Stock data relay → paste the relay URL → <strong>Save</strong>.</li>' +
        '<li>Settings → Sync across devices → paste the sync key → <strong>Connect</strong> → <em>Use the synced portfolio</em>.</li>' +
      '</ol>' +
      '<p class="field__hint" style="margin-top:10px">The relay URL and sync key are kept on each device and never synced, which is why they need entering once here. Not using Sync? In ' + (safari ? 'Safari' : 'your browser') + ' use Settings → Backup → Export JSON, then here Import it with <em>Replace all</em>.</p>';

    const pick = await PT.ui.choose({
      title: 'Bring your portfolio into the app',
      html,
      options: [
        { id: 'go', label: 'Open Settings', primary: true },
        { id: 'fresh', label: 'This is a fresh start — don\'t ask again' }
      ]
    });
    if (pick === 'fresh') { markSeen(); return; }
    if (pick !== 'go') return;                       // Cancel / Esc: ask again next launch
    location.hash = '#/settings';
    setTimeout(() => {
      const target = document.getElementById(PT.store.book.settings().relayUrl ? 'sync-card' : 's-relay');
      const card = target && target.closest('section');
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      card.classList.add('needs-attention');
      setTimeout(() => card.classList.remove('needs-attention'), 2600);
    }, 150);
  }

  /* ---------------- Settings card ---------------- */
  function cardHtml() {
    if (isInstalled()) {
      return '<p class="muted" style="font-size:13px">You\'re using the installed app. It runs the newest version whenever the site is updated, and opens offline with the last prices it received.</p>' +
        '<p class="field__hint">Right-click the Dock icon for shortcuts to Add trade, Transactions and Memecoins. To keep it there: right-click the icon while it\'s open → Options → <strong>Keep in Dock</strong>.</p>';
    }
    const b = browser();
    if (!secure()) {
      return '<p class="muted" style="font-size:13px">Open Ledgerline from its https:// address (GitHub Pages) to install it — apps can\'t be installed from a file on disk.</p>';
    }
    if (canPrompt()) {
      return '<p class="muted" style="font-size:13px">Opens in its own window with an icon in the Dock and works offline. Installed from ' + (b === 'edge' ? 'Edge' : 'Chrome') + ', it shares this browser\'s storage — your portfolio, relay and sync are already there.</p>' +
        '<div class="row"><button class="btn btn--primary" type="button" data-pwa="install">Install on this ' + (isMac() ? 'Mac' : 'computer') + '</button></div>';
    }
    if (b === 'safari') {
      return '<p class="muted" style="font-size:13px">Opens in its own window with an icon in the Dock and works offline. Needs macOS Sonoma or later.</p>' +
        '<ol class="pwa-steps">' +
          '<li>Copy your <strong>relay URL</strong> (Stock data relay card) and your <strong>sync key</strong> (Sync across devices → Show sync key) — the app starts with empty storage and needs both once.</li>' +
          '<li>In the menu bar choose <strong>File → Add to Dock…</strong> and click Add.</li>' +
          '<li>Open Ledgerline from the Dock and follow its prompt: paste the relay URL, then Connect with the sync key → <em>Use the synced portfolio</em>.</li>' +
        '</ol>' +
        (PT.sync && PT.sync.enabled() ? '' : '<div class="banner" style="margin:10px 0 0">' + PT.ui.icon('warn') + '<span>Sync isn\'t connected in this browser, so it can\'t carry your trades across. Connect Sync first, or use Backup → Export JSON and import it in the app.</span></div>');
    }
    if (b === 'chrome' || b === 'edge') {
      return '<ol class="pwa-steps">' +
        '<li>Click the install icon at the right of the address bar, or open the <strong>⋮</strong> menu → Cast, save and share → <strong>Install page as app</strong>.</li>' +
        '<li>Open it, then right-click its Dock icon → Options → <strong>Keep in Dock</strong>.</li></ol>' +
        '<p class="field__hint">Installed from ' + (b === 'edge' ? 'Edge' : 'Chrome') + ', it shares this browser\'s storage — your data comes with it.</p>';
    }
    return '<p class="muted" style="font-size:13px">Open Ledgerline in Safari or Chrome to install it as a Mac app.' + (b === 'firefox' ? ' Firefox can\'t install web apps on the Mac.' : '') + '</p>';
  }
  function bindCard(root) {
    const host = root.querySelector('#pwa-card');
    if (!host) return;
    host.addEventListener('click', e => {
      if (!e.target.closest('[data-pwa="install"]')) return;
      promptInstall().then(() => { const h = document.getElementById('pwa-card'); if (h) h.innerHTML = cardHtml(); });
    });
  }
  U.on('pwa:changed', () => { const h = document.getElementById('pwa-card'); if (h) h.innerHTML = cardHtml(); });

  /* ---------------- start ---------------- */
  function init() {
    document.documentElement.classList.toggle('is-app', isInstalled());
    setOnline();
    registerWorker();
    setTimeout(maybeWelcome, 500);        // after the first render, so the notice sits on real content
  }

  PT.pwa = { init, isInstalled, browser, isMac, canPrompt, promptInstall, looksLikeStartingData, showWelcome, cardHtml, bindCard, markSeen };
})(window.PT);
