/* ==========================================================================
   viewer.js — the read-only shared view (?view=<token>&w=<worker>).
   --------------------------------------------------------------------------
   Someone you send the link to sees your synced portfolio with live prices,
   without a sync key or any setup. Their copy lives in its own storage
   namespace (see store.js) and every write to it is blocked, except the copy
   fetched from your Worker's GET /view.

     • The view token only unlocks /view on the Worker — it can't read or
       write /sync, and can't create or change share links.
     • Refreshed when the page opens, when the viewer comes back to the tab,
       and every minute while it's visible.
     • If you press "New link" or "Turn off", the old link shows a clear
       "switched off" message and the cached copy is removed.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, book = PT.store.book, VIEW = PT.config.VIEW;
  const PULL_EVERY = 60000, TIMEOUT = 15000;
  const S = { state: 'loading', message: '', rev: 0, updatedAt: null, fetchedAt: null, busy: null };

  function set(state, message) { S.state = state; S.message = message || ''; U.emit('viewer:status'); }

  async function pull() {
    if (!VIEW) return;
    if (S.busy) return S.busy;
    S.busy = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT);
      try {
        const res = await fetch(VIEW.worker + '/view', {
          signal: ctrl.signal, credentials: 'omit', cache: 'no-store',
          headers: { Authorization: 'Bearer ' + VIEW.token }
        });
        let body = null;
        try { body = await res.json(); } catch (e) { /* not JSON */ }
        if (res.status === 404 && body && body.error === 'link-off') {
          // the owner switched this link off (or replaced it): don't keep showing their data
          if (book.transactions().length) book.applySyncDoc({ transactions: [], cash: [], pie: null, overrides: {}, settings: {} });
          return set('off', 'This shared link has been switched off or replaced. Ask for a new link.');
        }
        if (res.status === 403) return set(hasCopy() ? 'stale' : 'error', 'The Worker refused this site (its ALLOWED_ORIGINS setting doesn\'t include this address).');
        if (res.status !== 200 || !body) return set(hasCopy() ? 'stale' : 'error', (body && body.message) || 'The portfolio server answered HTTP ' + res.status + '.');
        S.fetchedAt = Date.now();
        if (!body.data || !body.rev) return set('empty', 'Nothing has been synced to share yet.');
        if (body.rev !== S.rev || !book.transactions().length) {
          S.rev = body.rev; S.updatedAt = body.updatedAt;
          book.applySyncDoc(body.data);
        }
        set('ok');
      } catch (e) {
        set(hasCopy() ? 'stale' : 'error', ctrl.signal.aborted ? 'The portfolio server didn\'t answer.' : 'Couldn\'t reach the portfolio server — check your connection.');
      } finally { clearTimeout(t); S.busy = null; }
    })();
    return S.busy;
  }
  const hasCopy = () => book.transactions().length > 0;

  /** Status for the sidebar / top bar. */
  function statusLine() {
    if (!VIEW) return null;
    if (S.state === 'loading') return { tone: 'busy', text: 'Loading shared portfolio…' };
    if (S.state === 'stale' || S.state === 'error') return { tone: 'warn', text: 'Read-only · offline copy' };
    if (S.state === 'off') return { tone: 'warn', text: 'Link switched off' };
    return { tone: 'ok', text: 'Read-only view' + (S.updatedAt ? ' · changed ' + F.ago(S.updatedAt) : '') };
  }

  /** Full-page message when there's nothing to show (first load, link off, error). */
  function blockingHtml() {
    if (!VIEW) return null;
    if (S.state === 'loading' && !hasCopy()) return msg('Loading the shared portfolio…', '', true);
    if (S.state === 'off') return msg('This link is switched off', S.message);
    if (S.state === 'empty') return msg('Nothing shared yet', 'The owner hasn\'t synced a portfolio to this link yet. Check back later.');
    if (S.state === 'error' && !hasCopy()) return msg('Couldn\'t load the shared portfolio', S.message + ' <button type="button" class="btn btn--sm" data-viewer="retry">Try again</button>');
    return null;
  }
  function msg(title, body, busy) {
    return '<section class="card empty viewer-empty" role="status"><h2>' + U.esc(title) + '</h2>' + (body ? '<p>' + body + '</p>' : '') +
      (busy ? '<p><span class="status-dot is-busy" aria-hidden="true"></span></p>' : '') + '</section>';
  }

  /** Thin strip at the top of every page. */
  function bannerHtml() {
    if (!VIEW) return '';
    const bits = [];
    if (S.state === 'stale' || S.state === 'error') bits.push('<span class="viewer-bar__warn">' + U.esc(S.message) + ' Showing the last copy loaded.</span>');
    else bits.push('<span><strong>Read-only view</strong> of a shared portfolio' + (S.updatedAt ? ' · last changed ' + U.esc(F.ago(S.updatedAt)) : '') + '. Prices are live.</span>');
    return '<div class="viewer-bar" role="note">' + PT.ui.icon('eye') + bits.join('') + '</div>';
  }

  function start() {
    if (!VIEW) return;
    // the viewer's own display settings: prices through the owner's Worker, no sync
    const st = book.settings();
    if (st.relayUrl !== VIEW.worker || st.syncOn || st.syncKey) book.saveSettings({ relayUrl: VIEW.worker, relayMode: 'auto', syncOn: false, syncKey: '', syncUrl: '' });
    if (hasCopy()) S.state = 'ok';           // show the cached copy straight away, then refresh
    pull();
    const again = () => { if (!document.hidden) pull(); };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    window.addEventListener('online', again);
    setInterval(again, PULL_EVERY);
    document.addEventListener('click', e => { if (e.target.closest('[data-viewer="retry"]')) { set('loading'); pull(); } });
  }

  PT.viewer = { active: !!VIEW, start, pull, statusLine, blockingHtml, bannerHtml, state: S };
})(window.PT);
