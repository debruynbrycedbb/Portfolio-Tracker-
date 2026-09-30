/* ==========================================================================
   store.js — THE ONLY MODULE THAT TOUCHES BROWSER STORAGE.
   --------------------------------------------------------------------------
   Two kinds of data, kept strictly apart:

     PT.store.book    — YOUR data: transactions, cash reserve, pie, settings,
                        manual price overrides. Written only through the UI.
     PT.store.market  — MARKET data: cached quotes, price series, FX,
                        recorded value snapshots. Derived, disposable,
                        refetchable.

   The market-data layer (providers.js / market.js / history.js) is only
   ever handed PT.store.market. `market` has no function that can reach a
   book key: every market write goes through marketWrite(), which refuses
   any key outside the market namespace.

   To move to a real backend later, reimplement this file and nothing else.
   Keys are versioned (pt:v1:*) so a schema change can migrate safely.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const V = 1;
  // Opened from a read-only share link? Then everything "book" lives in a separate namespace
  // (pt:v1:view:*), so viewing a shared portfolio can never touch this browser's own portfolio.
  const VIEW = PT.config.VIEW;
  const NS = VIEW ? 'view' : 'book';
  const BOOK = {
    transactions: 'pt:v' + V + ':' + NS + ':transactions',
    settings:     'pt:v' + V + ':' + NS + ':settings',
    overrides:    'pt:v' + V + ':' + NS + ':overrides',
    seeded:       'pt:v' + V + ':' + NS + ':seeded',
    cash:         'pt:v' + V + ':' + NS + ':cash',
    pie:          'pt:v' + V + ':' + NS + ':pie'
  };
  if (VIEW) BOOK.source = 'pt:v' + V + ':view:source';
  const MKT_PREFIX = 'pt:v' + V + ':market:';
  const MKT = {
    quotes:    MKT_PREFIX + 'quotes',
    series:    MKT_PREFIX + 'series',
    snapshots: MKT_PREFIX + (VIEW ? 'view-snapshots' : 'snapshots'),     // prices are shared; value history is not
    fx:        MKT_PREFIX + 'fx',
    status:    MKT_PREFIX + 'status'
  };
  const SCHEMA_KEY = 'pt:schema';
  // This device's sync bookkeeping (last synced revision + the snapshot it was based on). Never synced itself.
  const SYNC_STATE = 'pt:v' + V + ':sync:state';
  // Settings every device shares; the rest (theme, refresh, relay, keys) stay per device.
  const SHARED_SETTINGS = ['baseCurrency', 'extendedHours'];

  /* In-memory fallback when localStorage is unavailable (private mode, file:// quirks). */
  const mem = {};
  let persistent = true;
  try { const k = '__pt_probe__'; localStorage.setItem(k, '1'); localStorage.removeItem(k); }
  catch (e) { persistent = false; }

  function rawGet(key) {
    if (!persistent) return key in mem ? mem[key] : null;
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function rawSet(key, str) {
    if (!persistent) { mem[key] = str; return true; }
    try { localStorage.setItem(key, str); return true; }
    catch (e) {
      console.warn('[store] write failed for', key, e);
      PT.util && PT.util.emit('store:quota', { key });
      return false;
    }
  }
  function rawDel(key) {
    if (!persistent) { delete mem[key]; return; }
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
  function readJSON(key, def) {
    const s = rawGet(key);
    if (s == null) return def;
    try { return JSON.parse(s); } catch (e) { console.warn('[store] corrupt JSON at', key); return def; }
  }
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ---------------- migrations ---------------- */
  function migrate() {
    const v = +rawGet(SCHEMA_KEY) || 0;
    if (v === V) return;
    // v0 -> v1: nothing to move (first schema). Future: read old keys, transform, write new keys.
    rawSet(SCHEMA_KEY, String(V));
  }
  migrate();

  // A different share link (or a replaced one) than last time: start the viewer copy clean.
  if (VIEW) {
    const src = VIEW.worker + '|' + VIEW.token;
    if (rawGet(BOOK.source) !== src) {
      ['transactions', 'overrides', 'seeded', 'cash', 'pie'].forEach(k => rawDel(BOOK[k]));
      rawDel(MKT.snapshots);
      rawSet(BOOK.source, src);
    }
  }

  /* =====================================================================
     BOOK — your data
     ===================================================================== */
  const book = {
    isPersistent: () => persistent,

    transactions() { return clone(readJSON(BOOK.transactions, [])); },

    /** Append one transaction. Never overwrites an existing record. */
    addTransaction(tx) {
      const all = readJSON(BOOK.transactions, []);
      if (all.some(t => t.id === tx.id)) throw new Error('Duplicate transaction id ' + tx.id);
      all.push(clone(tx));
      const ok = rawSet(BOOK.transactions, JSON.stringify(all));
      PT.util.emit('book:changed');
      return ok;
    },

    /** Replace one transaction by id (an explicit edit from the UI). */
    updateTransaction(tx) {
      const all = readJSON(BOOK.transactions, []);
      const i = all.findIndex(t => t.id === tx.id);
      if (i < 0) throw new Error('No transaction ' + tx.id);
      all[i] = clone(tx);
      rawSet(BOOK.transactions, JSON.stringify(all));
      PT.util.emit('book:changed');
    },

    deleteTransaction(id) {
      const all = readJSON(BOOK.transactions, []);
      rawSet(BOOK.transactions, JSON.stringify(all.filter(t => t.id !== id)));
      PT.util.emit('book:changed');
    },

    /** Used by import (replace / merge) only. */
    replaceTransactions(list) {
      rawSet(BOOK.transactions, JSON.stringify(clone(list)));
      PT.util.emit('book:changed');
    },

    settings() {
      return Object.assign({}, PT.config.DEFAULT_SETTINGS, readJSON(BOOK.settings, {}));
    },
    saveSettings(patch) {
      const next = Object.assign(book.settings(), patch);
      rawSet(BOOK.settings, JSON.stringify(next));
      PT.util.emit('settings:changed', patch);
      return next;
    },

    /** Manual price overrides: { [assetKey]: { price (USD), setAt, note, symbol, name } } */
    overrides() { return clone(readJSON(BOOK.overrides, {})); },
    setOverride(key, o) {
      const all = readJSON(BOOK.overrides, {});
      all[key] = clone(o);
      rawSet(BOOK.overrides, JSON.stringify(all));
      PT.util.emit('book:changed');
    },
    removeOverride(key) {
      const all = readJSON(BOOK.overrides, {});
      delete all[key];
      rawSet(BOOK.overrides, JSON.stringify(all));
      PT.util.emit('book:changed');
    },
    replaceOverrides(o) { rawSet(BOOK.overrides, JSON.stringify(clone(o || {}))); PT.util.emit('book:changed'); },

    /* Cash reserve: a ledger of movements (USD). Balance = sum of amounts.
       { id, date (ISO), kind: 'deposit'|'withdraw'|'adjust'|'trade', amount (signed USD), note, txId? }
       Entries with a txId belong to a trade and are kept in step with it. */
    cash() { return clone(readJSON(BOOK.cash, [])); },
    addCash(entry) {
      const all = readJSON(BOOK.cash, []);
      all.push(clone(entry));
      rawSet(BOOK.cash, JSON.stringify(all));
      PT.util.emit('book:changed');
    },
    removeCash(id) {
      rawSet(BOOK.cash, JSON.stringify(readJSON(BOOK.cash, []).filter(e => e.id !== id)));
      PT.util.emit('book:changed');
    },
    replaceCash(list) { rawSet(BOOK.cash, JSON.stringify(clone(list || []))); PT.util.emit('book:changed'); },

    /**
     * Save a trade and its linked cash movement together (one write each, one change event),
     * so the book is never seen with a trade whose cash effect is missing or stale.
     * cashEntry = null removes any cash movement linked to this trade.
     */
    saveTrade(tx, cashEntry, isEdit) {
      const txs = readJSON(BOOK.transactions, []);
      if (isEdit) {
        const i = txs.findIndex(t => t.id === tx.id);
        if (i < 0) throw new Error('No transaction ' + tx.id);
        txs[i] = clone(tx);
      } else {
        if (txs.some(t => t.id === tx.id)) throw new Error('Duplicate transaction id ' + tx.id);
        txs.push(clone(tx));
      }
      const cash = readJSON(BOOK.cash, []).filter(e => e.txId !== tx.id);
      if (cashEntry) cash.push(clone(Object.assign({}, cashEntry, { txId: tx.id })));
      rawSet(BOOK.transactions, JSON.stringify(txs));
      rawSet(BOOK.cash, JSON.stringify(cash));
      PT.util.emit('book:changed');
    },
    /**
     * Save several new trades (a pie buy) and their cash movements in one go:
     * one write per key and a single change event, so a half-saved pie can't be seen.
     * items: [{ tx, cashEntry|null }]
     */
    saveTrades(items) {
      const txs = readJSON(BOOK.transactions, []), cash = readJSON(BOOK.cash, []);
      const ids = new Set(txs.map(t => t.id));
      items.forEach(it => {
        if (ids.has(it.tx.id)) throw new Error('Duplicate transaction id ' + it.tx.id);
        txs.push(clone(it.tx)); ids.add(it.tx.id);
        if (it.cashEntry) cash.push(clone(Object.assign({}, it.cashEntry, { txId: it.tx.id })));
      });
      rawSet(BOOK.transactions, JSON.stringify(txs));
      rawSet(BOOK.cash, JSON.stringify(cash));
      PT.util.emit('book:changed');
    },

    /** Pie target split: { slices: [{ type, symbol, name, meta, weight }], savedAt } — null until you save one. */
    pie() { return readJSON(BOOK.pie, null); },
    savePie(pie) { rawSet(BOOK.pie, JSON.stringify(clone(pie))); PT.util.emit('book:changed'); },
    replacePie(pie) { if (pie) rawSet(BOOK.pie, JSON.stringify(clone(pie))); else rawDel(BOOK.pie); PT.util.emit('book:changed'); },

    /** Delete a trade and any cash movement linked to it. */
    deleteTrade(id) {
      rawSet(BOOK.transactions, JSON.stringify(readJSON(BOOK.transactions, []).filter(t => t.id !== id)));
      rawSet(BOOK.cash, JSON.stringify(readJSON(BOOK.cash, []).filter(e => e.txId !== id)));
      PT.util.emit('book:changed');
    },

    /* ---------------- sync ---------------- */
    /** Everything that should be the same on every device, as one document. */
    syncDoc() {
      const st = book.settings(), shared = {};
      SHARED_SETTINGS.forEach(k => { shared[k] = st[k]; });
      return {
        transactions: readJSON(BOOK.transactions, []),
        cash: readJSON(BOOK.cash, []),
        pie: readJSON(BOOK.pie, null),
        overrides: readJSON(BOOK.overrides, {}),
        settings: shared
      };
    },
    /** Replace this device's book with a synced document — one change event, flagged fromSync. */
    applySyncDoc(doc) {
      rawSet(BOOK.transactions, JSON.stringify(doc.transactions || []));
      rawSet(BOOK.cash, JSON.stringify(doc.cash || []));
      if (doc.pie) rawSet(BOOK.pie, JSON.stringify(doc.pie)); else rawDel(BOOK.pie);
      rawSet(BOOK.overrides, JSON.stringify(doc.overrides || {}));
      const before = book.settings(), patch = {};
      SHARED_SETTINGS.forEach(k => { if (doc.settings && k in doc.settings && doc.settings[k] !== before[k]) patch[k] = doc.settings[k]; });
      if (Object.keys(patch).length) rawSet(BOOK.settings, JSON.stringify(Object.assign(before, patch)));
      rawSet(BOOK.seeded, '1');
      PT.util.emit('book:changed', { fromSync: true });
      if (Object.keys(patch).length) PT.util.emit('settings:changed', Object.assign({ fromSync: true }, patch));
    },
    SHARED_SETTINGS,

    wasSeeded: () => rawGet(BOOK.seeded) === '1',
    markSeeded: () => rawSet(BOOK.seeded, '1'),
    hasBook: () => rawGet(BOOK.transactions) != null
  };

  /* =====================================================================
     MARKET — derived, disposable data. Cannot reach a book key.
     ===================================================================== */
  function marketWrite(key, value) {
    if (key.indexOf(MKT_PREFIX) !== 0) throw new Error('market layer may not write ' + key);
    return rawSet(key, JSON.stringify(value));
  }

  /* Read-only share view: every way of changing the book is closed. Only the viewer's own display
     settings and the copy fetched from the Worker (applySyncDoc) can be written. */
  if (VIEW) {
    ['addTransaction', 'updateTransaction', 'deleteTransaction', 'replaceTransactions', 'setOverride', 'removeOverride',
      'replaceOverrides', 'addCash', 'removeCash', 'replaceCash', 'saveTrade', 'saveTrades', 'savePie', 'replacePie', 'deleteTrade']
      .forEach(m => { book[m] = () => { throw new Error('This is a read-only shared view.'); }; });
    book.readOnly = true;
  }

  const market = {
    quotes: () => readJSON(MKT.quotes, {}),
    saveQuotes: q => marketWrite(MKT.quotes, q),

    series: () => readJSON(MKT.series, {}),
    saveSeries(s) {
      // keep the series cache bounded: drop oldest entries beyond 60
      const keys = Object.keys(s);
      if (keys.length > 60) {
        keys.sort((a, b) => (s[a].at || 0) - (s[b].at || 0)).slice(0, keys.length - 60).forEach(k => delete s[k]);
      }
      if (!marketWrite(MKT.series, s)) { rawDel(MKT.series); }
    },

    snapshots: () => readJSON(MKT.snapshots, []),
    saveSnapshots: list => marketWrite(MKT.snapshots, list),

    fx: () => readJSON(MKT.fx, null),
    saveFx: fx => marketWrite(MKT.fx, fx),

    status: () => readJSON(MKT.status, {}),
    saveStatus: s => marketWrite(MKT.status, s),

    clearPriceCache() { rawDel(MKT.quotes); rawDel(MKT.series); rawDel(MKT.fx); rawDel(MKT.status); },
    clearHistory() { rawDel(MKT.snapshots); }
  };

  const syncState = {
    get: () => readJSON(SYNC_STATE, null),
    set: s => rawSet(SYNC_STATE, JSON.stringify(s)),
    clear: () => rawDel(SYNC_STATE)
  };

  /** Settings → Reset everything. Clears both namespaces — and disconnects this device from sync
      first, so a reset can never be pushed to your other devices. */
  function resetEverything() {
    rawDel(SYNC_STATE);
    Object.values(BOOK).forEach(rawDel);
    Object.values(MKT).forEach(rawDel);
    rawSet(BOOK.seeded, '1');        // don't silently re-seed after an explicit reset
    rawSet(BOOK.transactions, '[]');
    PT.util.emit('book:changed');
    PT.util.emit('settings:changed', {});
  }

  function usageBytes() {
    let n = 0;
    [].concat(Object.values(BOOK), Object.values(MKT)).forEach(k => { const s = rawGet(k); if (s) n += s.length * 2; });
    return n;
  }

  PT.store = { book, market, syncState, resetEverything, usageBytes, KEYS: { BOOK, MKT, SYNC_STATE } };
})(window.PT);
