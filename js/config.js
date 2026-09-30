/* ==========================================================================
   config.js — constants and the SEED PORTFOLIO.
   --------------------------------------------------------------------------
   This is the one file to edit if you want a different starting portfolio.
   The seed is only written on a brand-new install (empty browser storage).
   To start empty, set SEED_HOLDINGS to [] — or use Settings → Reset everything.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  /* ------------------------------------------------------------------------
     SEED HOLDINGS
     quantity = invested ÷ average price, so the stated averages and invested
     totals reproduce exactly. `date` is when the trade is recorded as bought —
     edit it in the Transactions screen if you know the real date.
     ------------------------------------------------------------------------ */
  const SEED_DATE = '2026-09-01T12:00';

  const SEED_HOLDINGS = [
    { type: 'stock', symbol: 'SPCX', name: 'SpaceX', avg: 126.48, invested: 167,
      meta: { exchange: 'NASDAQ' } },
    { type: 'etf', symbol: 'ARKG', name: 'ARK Genomic Revolution ETF', avg: 44.56, invested: 191, meta: {} },
    { type: 'etf', symbol: 'ARKX', name: 'ARK Space & Defense Innovation ETF', avg: 31.60, invested: 127, meta: {} },
    { type: 'etf', symbol: 'BOTZ', name: 'Global X Robotics & Artificial Intelligence ETF', avg: 35.76, invested: 125, meta: {} },

    // An established token: filed under Cryptocurrency, priced through its Dexscreener pair.
    { type: 'crypto', symbol: 'TRAC', name: 'OriginTrail', avg: 0.33, invested: 165,
      meta: { coingeckoId: 'origintrail', chain: 'ethereum',
              pairAddress: '0xb1914469141ebb6e244e75cee3f35d43bf6b85e5',
              contract: '0xaA7a9CA87d3694B5755f213B5D04094b8d0F0A6F' } },

    { type: 'memecoin', symbol: 'KEYCAT', name: 'Keyboard Cat', avg: 0.00051, invested: 86,
      meta: { chain: 'base', pairAddress: '0x377feeed4820b3b28d1ab429509e7a0789824fca',
              contract: '0x9a26F5433671751C3276a065f57e5a02D2817973' } },
    { type: 'memecoin', symbol: 'INDEX', name: 'The Index', avg: 0.0267, invested: 38,
      meta: { chain: 'robinhood', pairAddress: '0x00dd2df2f17d431cf3a0938f06c9cf9abc5e9643b6cc466ca3f71f3af246edf3',
              contract: '0x56910D4409F3a0C78C64DD8D0545FF0705389870' } },
    { type: 'memecoin', symbol: 'NET', name: 'NetNet Capital', avg: 560, invested: 78,
      meta: { chain: 'robinhood', pairAddress: '0x59f95461e68e0c77605299791e1449f175165b54',
              contract: '0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf' } }
  ];

  /* ------------------------------------------------------------------------
     DEFAULT PIE — target split for "Invest in pie" (stocks & ETFs only).
     Used until you save your own pie on the Pie screen. Weights must total 100.
     ------------------------------------------------------------------------ */
  const DEFAULT_PIE = [
    { type: 'etf',   symbol: 'ARKG', weight: 30 },
    { type: 'stock', symbol: 'SPCX', weight: 30 },
    { type: 'etf',   symbol: 'ARKX', weight: 20 },
    { type: 'etf',   symbol: 'BOTZ', weight: 20 }
  ];

  /* ------------------------------------------------------------------------
     Everything below is app configuration — safe to leave alone.
     ------------------------------------------------------------------------ */
  PT.config = {
    APP_NAME: 'Ledgerline',
    // Bump this (and version.json, and the ?v= in index.html) whenever the site's files change.
    // Browsers that still run an older copy then show "A new version is available — Reload".
    APP_VERSION: '2026.09.30-3',
    SCHEMA_VERSION: 1,
    SEED_DATE,
    SEED_HOLDINGS,
    DEFAULT_PIE,

    ASSET_TYPES: [
      { id: 'stock',    label: 'Stock',          plural: 'Stocks',    route: 'stocks' },
      { id: 'etf',      label: 'ETF',            plural: 'ETFs',      route: 'etfs' },
      { id: 'crypto',   label: 'Cryptocurrency', plural: 'Crypto',    route: 'crypto', short: 'Crypto' },
      { id: 'memecoin', label: 'Memecoin',       plural: 'Memecoins', route: 'memecoins' }
    ],

    // Chains offered in the memecoin picker (Dexscreener chain ids).
    // A chain read from a pasted Dexscreener URL is accepted even if it isn't listed.
    CHAINS: [
      ['solana', 'Solana'], ['ethereum', 'Ethereum'], ['base', 'Base'], ['bsc', 'BNB Chain'],
      ['arbitrum', 'Arbitrum'], ['polygon', 'Polygon'], ['avalanche', 'Avalanche'],
      ['optimism', 'Optimism'], ['robinhood', 'Robinhood Chain'], ['sui', 'Sui'],
      ['ton', 'TON'], ['tron', 'Tron'], ['blast', 'Blast'], ['linea', 'Linea'],
      ['zksync', 'zkSync'], ['sonic', 'Sonic'], ['abstract', 'Abstract'], ['hyperevm', 'HyperEVM']
    ],

    DEFAULT_SETTINGS: {
      baseCurrency: 'USD',        // 'USD' | 'EUR'
      theme: 'system',            // 'system' | 'light' | 'dark'
      refreshSec: 60,             // 0 = manual only
      extendedHours: true,        // include pre-market / after-hours prints
      relayMode: 'auto',          // 'auto' | 'own' | 'none'
      relayUrl: '',               // e.g. https://pt-relay.you.workers.dev/?url=
      finnhubKey: '',
      syncUrl: '',                // e.g. https://pt-relay.you.workers.dev/sync (defaults to your relay's /sync)
      syncKey: '',                // the SYNC_KEY secret set on the Worker — stored only on this device
      syncOn: false,
      deviceName: ''
    },

    REFRESH_OPTIONS: [[0, 'Manual only'], [30, 'Every 30 seconds'], [60, 'Every minute'],
      [120, 'Every 2 minutes'], [300, 'Every 5 minutes'], [900, 'Every 15 minutes']],

    // Public CORS relays: unreliable spares, never infrastructure.
    // Verified 23 Sep 2026: cors.lol answered; allorigins hung; codetabs failed.
    PUBLIC_RELAYS: [
      { id: 'corslol',    label: 'cors.lol (public)',       url: t => 'https://api.cors.lol/?url=' + encodeURIComponent(t), timeout: 5000 },
      { id: 'allorigins', label: 'allorigins.win (public)', url: t => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(t), timeout: 5000 },
      { id: 'codetabs',   label: 'codetabs.com (public)',   url: t => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(t), timeout: 5000 }
    ],
    OWN_RELAY_TIMEOUT: 7000,
    DIRECT_TIMEOUT: 9000,
    RELAY_BENCH_MS: 90 * 1000,    // how long a relay that didn't answer is skipped
    CONTROL_TICKER: 'AAPL',       // used by the connection test to check a relay independent of your holdings

    EQUITY_CONCURRENCY: 2,        // stocks go a couple at a time: one relay, one upstream
    OTHER_CONCURRENCY: 4,

    LOW_LIQUIDITY_USD: 10000,     // flag pools thinner than this
    STALE_AFTER_MS: 60 * 60 * 1000,

    SNAPSHOT_MIN_GAP_MS: 10 * 60 * 1000,

    FALLBACK_USD_EUR: 0.87,       // only used if no FX rate has ever been fetched

    /* Read-only share link: ?view=<token>&w=<worker host>. When present, the whole app runs as a
       viewer — its own storage namespace, nothing can be edited, data comes from the Worker's /view. */
    VIEW: (function () {
      try {
        const q = new URLSearchParams(location.search);
        const token = q.get('view'), w = q.get('w');
        if (!token || !w || !/^[A-Za-z0-9]{16,64}$/.test(token)) return null;
        const origin = new URL(/^https?:\/\//.test(w) ? w : 'https://' + w).origin;
        return { token, worker: origin };
      } catch (e) { return null; }
    })()
  };
})(window.PT);
