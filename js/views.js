/* ==========================================================================
   views.js — Dashboard, asset-class pages and the position detail view.
   Views read derived state from PT.app.state and render HTML; charts are
   mounted after the markup is in place.
   ========================================================================== */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  const U = PT.util, F = U.fmt, esc = U.esc, UI = PT.ui, C = PT.config;
  const P_TOL = 0.005;                // cash below half a cent counts as none
  const V = {};
  let mounted = [];                 // chart instances to dispose on the next render
  const perfCache = {};             // range -> last built history (so re-renders don't flash)
  const priceCache = {};            // key|range -> points

  V.dispose = function () { mounted.forEach(c => c && c.destroy && c.destroy()); mounted = []; };

  const href = key => '#/position/' + encodeURIComponent(key);
  const classRoute = type => '#/' + UI.TYPE[type].route;

  function assetCell(r) {
    const s = (r.symbol || '?').replace(/[^A-Z0-9]/gi, '').slice(0, 4);
    return '<span class="asset"><span class="asset__icon asset__icon--' + r.type + '" aria-hidden="true">' + esc(s) + '</span>' +
      '<span style="min-width:0"><span class="asset__name">' + esc(r.name || r.symbol) + '</span><span class="asset__sym">' + esc(r.symbol) +
      (r.type === 'memecoin' && r.meta && r.meta.chain ? ' · ' + esc(r.meta.chain) : '') + '</span></span></span>';
  }

  const qtyLabel = t => (t === 'stock' ? 'Shares' : t === 'etf' ? 'Units' : t ? 'Amount' : 'Quantity');

  /** Holdings table columns. `type` null = dashboard (all classes). */
  function holdingColumns(type) {
    const cols = [
      { key: 'name', label: type === 'crypto' || type === 'memecoin' ? 'Coin' : 'Name', sort: r => (r.name || r.symbol).toLowerCase(), html: assetCell },
    ];
    // The dashboard shows the ticker under the name; class pages give it its own column.
    if (type) cols.push({ key: 'symbol', label: type === 'crypto' || type === 'memecoin' ? 'Symbol' : 'Ticker', sort: r => r.symbol, html: r => '<span class="num">' + esc(r.symbol) + '</span>' });
    if (!type) cols.push({ key: 'type', label: 'Class', sort: r => r.type, html: r => UI.typeTag(r.type) });
    cols.push(
      { key: 'qty', label: qtyLabel(type), align: 'r', sort: r => r.qty, html: r => '<span class="num">' + F.qty(r.qty) + '</span>' },
      { key: 'avg', label: 'Avg entry', align: 'r', sort: r => r.avgEntry, html: r => '<span class="num">' + F.price(r.avgEntry) + '</span>' },
      { key: 'invested', label: 'Invested', align: 'r', sort: r => r.invested, html: r => '<span class="num">' + F.money(r.invested) + '</span>' },
      { key: 'price', label: 'Price', align: 'r', sort: r => r.price, html: r => UI.priceCell(r) },
      { key: 'value', label: 'Value', align: 'r', sort: r => r.value, html: r => '<span class="num">' + (r.priced ? F.money(r.value) : '—') + '</span>' },
      { key: 'pl', label: 'P&L', align: 'r', sort: r => r.pl, html: r => UI.pl(r.pl, type ? null : r.plPct, { noPct: !!type }) }
    );
    if (type) cols.push({ key: 'plPct', label: 'P&L %', align: 'r', sort: r => r.plPct, html: r => (r.plPct == null ? '<span class="pl is-flat">—</span>' : UI.chg(r.plPct)) });
    cols.push(
      { key: 'change', label: type === 'crypto' || type === 'memecoin' ? '24h' : type ? 'Today' : 'Today / 24h', align: 'r', sort: r => r.change, html: r => UI.chg(r.change) }
    );
    if (type === 'memecoin') {
      cols.push({ key: 'liq', label: 'Liquidity', align: 'r', sort: r => liqOf(r), html: r => liqCell(r) });
    }
    cols.push({ key: 'weight', label: 'Allocation', align: 'r', sort: r => r.weight, html: r => '<span class="num">' + (r.weight == null ? '—' : F.pct(r.weight, { plain: true })) + '</span>' });
    return cols;
  }
  const liqOf = r => (r.quote && r.quote.extra && U.isNum(r.quote.extra.liquidity) ? r.quote.extra.liquidity : null);
  function liqCell(r) {
    const l = liqOf(r);
    if (l == null) return '<span class="muted">unavailable</span>';
    const low = l < C.LOW_LIQUIDITY_USD;
    return '<span class="num">' + F.usdCompact(l) + '</span>' + (low ? ' ' + UI.badge('Thin', 'warn', 'Liquidity under ' + F.usdCompact(C.LOW_LIQUIDITY_USD) + ' — price may not be tradeable') : '');
  }

  /* ---------------- shared bits ---------------- */
  function marketSessionLine(summary, settings) {
    const eq = summary.rows.filter(r => (r.type === 'stock' || r.type === 'etf') && r.quote && r.quote.extra && !r.quote.manual);
    if (!eq.length) return '';
    const sessions = eq.map(r => r.quote.extra.marketSession).filter(Boolean);
    const s = sessions.sort((a, b) => sessions.filter(x => x === b).length - sessions.filter(x => x === a).length)[0];
    const name = { pre: 'Pre-market', regular: 'Open', post: 'After-hours', closed: 'Closed' }[s] || '—';
    const ext = eq.filter(r => r.quote.extra.priceSession === 'pre' || r.quote.extra.priceSession === 'post').length;
    const noExt = eq.filter(r => r.quote.extra.noExtendedData).length;
    let txt = '<span class="badge badge--' + (s === 'regular' ? 'ok' : s === 'closed' ? 'muted' : 'session') + '">US market · ' + name + '</span>';
    if (settings.extendedHours) {
      if (ext) txt += ' <span>' + ext + ' of ' + eq.length + ' stock & ETF positions priced from ' + (s === 'pre' ? 'pre-market' : 'extended-hours') + ' trades</span>';
      if (noExt) txt += ' <span>· ' + noExt + ' priced by a source without extended-hours data</span>';
    } else if (s !== 'regular') {
      txt += ' <span>Using regular-session closes (change in Settings)</span>';
    }
    return txt;
  }

  function lastUpdated() {
    const st = PT.market.state.status;
    return st && st.lastRefresh ? 'Updated ' + F.ago(st.lastRefresh) : 'Not refreshed yet';
  }

  function coverageNote(s) {
    if (s.nonePriced) {
      return '<p class="hero__note">' + UI.icon('warn') + '<span>No prices are available yet, so P&L isn\'t shown. Nothing is counted as a loss while a price is missing.</span></p>';
    }
    if (!s.partial) return '';
    const missing = s.rows.filter(r => !r.priced).map(r => r.symbol);
    return '<p class="hero__note">' + UI.icon('warn') + '<span>This P&L covers <strong>' + F.money(s.invested) + '</strong> of the <strong>' +
      F.money(s.investedAll) + '</strong> you have invested. ' + missing.length + ' position' + (missing.length > 1 ? 's have' : ' has') +
      ' no price yet (' + esc(missing.join(', ')) + ') and ' + (missing.length > 1 ? 'are' : 'is') + ' left out of value and P&L rather than counted as a loss.</span></p>';
  }

  function emptyState() {
    return '<section class="card empty"><h2>No investments yet</h2><p>Add your first trade to start tracking. Everything is stored in this browser — export a backup from Settings once you\'ve added a few.</p>' +
      '<div class="row" style="justify-content:center"><button class="btn btn--primary" data-action="add-trade">' + UI.icon('plus') + ' Add trade</button>' +
      '<button class="btn" data-action="load-seed">Load the starter portfolio</button></div></section>';
  }

  /* =====================================================================
     DASHBOARD
     ===================================================================== */
  V.dashboard = function (root, app) {
    const st = app.state, s = st.summary;
    if (!st.txs.length) { root.innerHTML = emptyState(); return; }

    const kpis = [];
    const cash = st.cash;
    kpis.push(['Total invested', F.money(s.investedAll), s.partial ? F.money(s.invested) + ' of it priced' : 'cost + fees']);
    kpis.push(['Cash reserve', '<a href="#/cash" class="row-link">' + F.money(cash.balance) + '</a>',
      cash.used ? '<a href="#/cash">ready to deploy</a>' : '<a href="#/cash">add spare cash</a>']);
    kpis.push(['Today\'s P&L', UI.pl(s.todayPL, s.todayPct), 'from each asset\'s day / 24h change']);
    kpis.push(['Positions', String(s.openCount), s.pricedCount + ' priced' + (s.closed.length ? ' · ' + s.closed.length + ' closed' : '')]);
    if (Math.abs(s.realised) > 1e-9) kpis.push(['Realised P&L', UI.pl(s.realised, null), 'banked from sells']);
    kpis.push(['Best performer', s.best ? '<a href="' + href(s.best.key) + '" class="row-link">' + esc(s.best.symbol) + ' ' + UI.chg(s.best.plPct) + '</a>' : '—', s.best ? esc(s.best.name) : 'needs prices']);
    kpis.push(['Worst performer', s.worst ? '<a href="' + href(s.worst.key) + '" class="row-link">' + esc(s.worst.symbol) + ' ' + UI.chg(s.worst.plPct) + '</a>' : '—', s.worst ? esc(s.worst.name) : '']);

    const sess = marketSessionLine(s, st.settings);
    root.innerHTML =
      '<header class="page-head"><div><p class="eyebrow">Portfolio · ' + esc(st.settings.baseCurrency) + '</p><h1 class="page-title">Overview</h1></div>' +
      '<div class="page-head__meta">' + sess + '<span>' + lastUpdated() + '</span></div></header>' +
      (!PT.ctx.fxOk ? '<div class="banner">' + UI.icon('warn') + '<span>No EUR exchange rate could be fetched yet — amounts use a fallback rate of ' + C.FALLBACK_USD_EUR + ' until one loads.</span></div>' : '') +
      '<div class="stack">' +
      '<section class="card hero" aria-labelledby="hv-label"><div>' +
        '<p class="hero__label" id="hv-label">Total portfolio value</p>' +
        '<p class="hero__value">' + (s.value == null ? '—' : F.money(s.value)) + '</p>' +
        '<p class="hero__pl">' + (s.pl == null ? '<span class="pl is-flat">— P&L</span>' : UI.pl(s.pl, s.plPct)) + '<span class="muted">total unrealised P&L</span></p>' +
        (cash.used && s.value != null ? '<p class="hero__cash"><span>+ Cash reserve <strong>' + F.money(cash.balance) + '</strong></span>' +
          '<span>= Total incl. cash <strong>' + F.money(s.value + cash.balance) + '</strong></span></p>' : '') +
        coverageNote(s) +
      '</div><dl class="kpis">' + kpis.map(k => '<div class="kpi"><dt>' + k[0] + '</dt><dd>' + k[1] + (k[2] ? '<span class="kpi__sub">' + k[2] + '</span>' : '') + '</dd></div>').join('') + '</dl></section>' +

      '<section class="card" aria-labelledby="perf-t">' +
        '<div class="perf-head"><div><h2 class="card__title" id="perf-t">Performance</h2><div class="perf-figure" id="perf-figure">&nbsp;</div></div>' +
        '<div class="seg" role="tablist" aria-label="Time range">' + PT.history.RANGES.map(r =>
          '<button type="button" role="tab" aria-selected="' + (app.perfRange === r.id) + '" data-perf-range="' + r.id + '">' + r.id + '</button>').join('') + '</div></div>' +
        '<div id="perf-chart"><div class="skeleton" style="height:280px"></div></div>' +
        '<div class="perf-legend" aria-hidden="true"><span><i></i>Recorded while open</span><span><i class="recon"></i>Reconstructed from price history</span><span><i class="est"></i>Reconstructed, includes estimates</span></div>' +
        '<p class="chart-note" id="perf-note" hidden></p>' +
      '</section>' +

      '<div class="grid-2">' +
        '<section class="card" aria-labelledby="alloc-t"><div class="card__head"><div><h2 class="card__title" id="alloc-t">Allocation</h2><p class="card__sub">By asset class, priced positions' + (st.cash.balance > P_TOL ? ' + cash reserve' : '') + '</p></div></div>' +
          '<div class="alloc"><div id="alloc-chart"></div><div class="legend" id="alloc-legend"></div></div></section>' +
        '<section class="card" aria-labelledby="plc-t"><div class="card__head"><div><h2 class="card__title" id="plc-t">P&L by position</h2><p class="card__sub">Unrealised, largest contribution first</p></div></div>' +
          '<div id="pl-chart"></div></section>' +
      '</div>' +

      '<section class="card card--flush" aria-labelledby="hold-t"><div class="card__head"><div><h2 class="card__title" id="hold-t">Holdings</h2><p class="card__sub">' + s.openCount + ' open positions · click a row for details</p></div></div>' +
        UI.table('holdings', holdingColumns(null), s.rows, { defaultSort: 'value', rowHref: r => href(r.key), caption: 'All holdings' }) +
      '</section></div>';

    mountAllocation(s, st.cash);
    mountPLBars(s);
    mountPerf(app, false);
  };

  function mountAllocation(s, cash) {
    // Cash is shown beside the asset classes (so you can see how much is still undeployed),
    // with every share measured against investments + cash.
    const cashBal = cash && cash.balance > P_TOL ? cash.balance : 0;
    const base = (s.value || 0) + cashBal;
    const share = v => (base > 0 ? (v / base) * 100 : 0);
    const segs = PT.portfolio.TYPES.map(t => {
      const c = s.byClass[t];
      return { id: t, label: UI.TYPE[t].plural, value: c.value, color: 'var(--c-' + t + ')',
        aria: F.money(c.value) + ', ' + F.pct(share(c.value), { plain: true }) + ' of total, P&L ' + (c.pl == null ? 'unavailable' : F.money(c.pl, { signed: true })),
        detail: [['Value', F.money(c.value)], ['Share', F.pct(share(c.value), { plain: true })],
          ['P&L', c.pl == null ? '—' : F.money(c.pl, { signed: true }) + (c.plPct != null ? ' (' + F.pct(c.plPct) + ')' : ''), UI.tone(c.pl)]] };
    });
    if (cashBal) {
      segs.push({ id: 'cash', label: 'Cash reserve', value: cashBal, color: 'var(--c-cash)',
        aria: F.money(cashBal) + ', ' + F.pct(share(cashBal), { plain: true }) + ' of total, ready to deploy',
        detail: [['Value', F.money(cashBal)], ['Share', F.pct(share(cashBal), { plain: true })], ['Status', 'ready to deploy']] });
    }
    const donut = PT.charts.donut(document.getElementById('alloc-chart'), {
      segments: segs, size: 180, thickness: 26, ariaLabel: 'Allocation by asset class' + (cashBal ? ' and cash' : ''),
      center: cashBal ? ['Total', F.money(base, { compact: true })] : ['Priced', s.value == null ? '—' : F.money(s.value, { compact: true })]
    });
    document.getElementById('alloc-legend').innerHTML = PT.portfolio.TYPES.map(t => {
      const c = s.byClass[t];
      return '<a class="legend__row" href="' + classRoute(t) + '" data-legend="' + t + '"><span class="swatch swatch--' + t + '" aria-hidden="true"></span>' +
        '<span class="legend__name">' + UI.TYPE[t].plural + '</span><span class="legend__val">' + F.pct(share(c.value), { plain: true }) + '</span>' +
        '<span class="legend__meta"><span class="num">' + F.money(c.value) + '</span>' + (c.pl == null ? '<span>—</span>' : UI.pl(c.pl, c.plPct)) + '</span></a>';
    }).join('') + (cashBal ? '<a class="legend__row" href="#/cash" data-legend="cash"><span class="swatch swatch--cash" aria-hidden="true"></span>' +
        '<span class="legend__name">Cash reserve</span><span class="legend__val">' + F.pct(share(cashBal), { plain: true }) + '</span>' +
        '<span class="legend__meta"><span class="num">' + F.money(cashBal) + '</span><span>ready to deploy</span></span></a>' : '');
    document.querySelectorAll('[data-legend]').forEach(a => {
      a.addEventListener('pointerenter', () => donut.highlight(a.dataset.legend));
      a.addEventListener('pointerleave', () => donut.highlight(null));
      a.addEventListener('focus', () => donut.highlight(a.dataset.legend));
      a.addEventListener('blur', () => donut.highlight(null));
    });
  }

  function mountPLBars(s) {
    const items = s.rows.filter(r => r.priced).sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl)).map(r => ({
      label: r.symbol, value: r.pl, pct: r.plPct, tipHead: r.name + ' (' + r.symbol + ')',
      detail: [['P&L', F.money(r.pl, { signed: true }), UI.tone(r.pl)], ['Return', F.pct(r.plPct), UI.tone(r.pl)], ['Value', F.money(r.value)]],
      onClick: () => { location.hash = href(r.key); }
    }));
    mounted.push(PT.charts.bars(document.getElementById('pl-chart'), {
      items, format: v => F.money(v, { signed: true }), ariaLabel: 'Unrealised P&L by position',
      empty: 'P&L appears once positions are priced'
    }));
  }

  function perfTip(p, base) {
    const kindLabel = p.kind === 'recorded' ? 'Recorded' : p.kind === 'live' ? 'Live' : p.est ? 'Reconstructed · estimated' : 'Reconstructed';
    return {
      head: F.dateTime(p.t),
      rows: [['a', 'Value', F.money(p.v)], ['b', 'P&L', F.money(p.pl, { signed: true }), UI.tone(p.pl)], ['c', 'P&L %', p.plPct == null ? '—' : F.pct(p.plPct), UI.tone(p.pl)]],
      foot: kindLabel + (p.est ? ' — includes interpolated memecoin prices (no public price history)' : '')
    };
  }

  function mountPerf(app, animate) {
    const host = document.getElementById('perf-chart');
    if (!host) return;
    const range = app.perfRange;
    let chart = null;
    const draw = (res, anim) => {
      if (!document.body.contains(host)) return;
      const pts = res.points;
      const first = pts.find(p => U.isNum(p.v)), last = pts[pts.length - 1];
      const tone = !first || !last ? 'accent' : last.pl >= first.pl ? 'gain' : 'loss';
      const opts = {
        points: pts, height: 280, tone, ariaLabel: 'Portfolio value, ' + range, animate: !!anim,
        yFormat: v => F.money(v, { compact: true }),
        tip: p => perfTip(p), empty: 'Not enough history for this range yet'
      };
      if (chart) chart.update(pts, opts); else { host.innerHTML = ''; chart = PT.charts.line(host, opts); mounted.push(chart); }
      const fig = document.getElementById('perf-figure');
      if (fig && first && last) {
        const d = last.pl - first.pl;
        fig.innerHTML = F.money(last.v) + UI.pl(d, first.v > 0 ? (d / first.v) * 100 : null) + ' <span class="muted" style="font-size:13px;font-weight:450">' + range + ' change in P&L</span>';
      }
      const note = document.getElementById('perf-note');
      if (note) {
        const bits = [];
        if (res.estimated && res.estimated.length) bits.push('Estimated: ' + res.estimated.join(', ') + ' — no public price history, so reconstructed stretches interpolate between entry and current price.');
        if (res.recordedCount === 0) bits.push('No recorded snapshots in this range yet — they accumulate while this page is open.');
        note.hidden = !bits.length;
        note.textContent = bits.join(' ');
      }
    };
    const cached = perfCache[range];
    if (cached) draw(cached, animate);
    const st = app.state;
    PT.history.build(range, { txs: st.txs, rates: st.rates, summary: st.summary, settings: st.settings }).then(res => {
      perfCache[range] = res;
      if (app.perfRange === range) draw(res, !cached && animate);
    }).catch(e => {
      console.error(e);
      if (!cached && document.body.contains(host)) host.innerHTML = '<p class="muted">Couldn\'t build the performance history: ' + esc(e.message) + '</p>';
    });
  }
  V.setPerfRange = function (app, id) {
    app.perfRange = id;
    document.querySelectorAll('[data-perf-range]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.perfRange === id)));
    mountPerf(app, true);
  };

  /* =====================================================================
     ASSET CLASS PAGES
     ===================================================================== */
  V.assetClass = function (root, app, type) {
    const st = app.state, s = st.summary, c = s.byClass[type], T = UI.TYPE[type];
    const isCrypto = type === 'crypto' || type === 'memecoin';
    const rows = c.rows;
    const caution = type === 'memecoin'
      ? '<div class="banner">' + UI.icon('warn') + '<span><strong>Thin, volatile markets.</strong> Prices come from the deepest liquidity pool Dexscreener lists for each token. Check liquidity before trusting a price as tradeable — a price from a tiny pool is not a price you could sell at.</span></div>' : '';
    const partial = c.pricedCount < c.count && c.count
      ? '<div class="banner">' + UI.icon('warn') + '<span>' + (c.count - c.pricedCount) + ' of ' + c.count + ' positions have no price and are left out of value and P&L — this P&L covers ' + F.money(c.invested) + ' of the ' + F.money(c.investedAll) + ' invested.</span></div>' : '';

    const weights = rows.filter(r => r.priced && c.value > 0).sort((a, b) => b.value - a.value);
    root.innerHTML =
      '<header class="page-head"><div><p class="eyebrow"><span class="swatch swatch--' + type + '" aria-hidden="true"></span>Asset class</p><h1 class="page-title">' + T.plural + '</h1></div>' +
      '<div class="page-head__meta">' + (type === 'stock' || type === 'etf' ? marketSessionLine(s, st.settings) : '<span>Trades 24/7</span>') + '<span>' + lastUpdated() + '</span></div></header>' +
      caution + partial +
      '<div class="stack">' +
      '<section class="card kpi-strip" aria-label="' + T.plural + ' summary">' +
        kpi('Value', c.pricedCount ? F.money(c.value) : '—', F.pct(c.pct, { plain: true }) + ' of portfolio') +
        kpi('Invested', F.money(c.investedAll), c.count + ' position' + (c.count === 1 ? '' : 's')) +
        kpi('Unrealised P&L', UI.pl(c.pl, c.plPct), c.realised ? 'Realised ' + F.money(c.realised, { signed: true }) : '') +
        kpi(isCrypto ? '24h change' : 'Today', UI.pl(c.todayPL, c.todayPct), isCrypto ? 'rolling 24 hours' : 'vs previous regular close') +
      '</section>' +
      (c.count ? '<section class="card" aria-labelledby="w-t"><div class="card__head"><div><h2 class="card__title" id="w-t">Weight within ' + T.plural + '</h2><p class="card__sub">Share of this class\'s priced value</p></div></div>' +
        '<div class="weights">' + (weights.length ? weights.map(r => {
          const pct = (r.value / c.value) * 100;
          return '<a class="weight" href="' + href(r.key) + '"><span class="weight__name">' + esc(r.symbol) + '<small>' + esc(r.name) + '</small></span>' +
            '<span class="weight__track" role="img" aria-label="' + esc(r.symbol) + ' ' + pct.toFixed(1) + '%"><span class="weight__bar" style="width:' + pct.toFixed(2) + '%;background:var(--c-' + type + ')"></span></span>' +
            '<span class="weight__pct">' + F.pct(pct, { plain: true }) + '</span></a>';
        }).join('') : '<p class="muted">Weights appear once prices load.</p>') + '</div></section>' : '') +
      '<section class="card card--flush" aria-labelledby="t-t"><div class="card__head"><div><h2 class="card__title" id="t-t">Positions</h2><p class="card__sub">Click a row for details</p></div>' +
        '<button class="btn btn--sm" data-action="add-trade" data-type="' + type + '">' + UI.icon('plus') + ' Add ' + T.label.toLowerCase() + '</button></div>' +
        UI.table('class-' + type, holdingColumns(type), rows, { defaultSort: 'value', rowHref: r => href(r.key), caption: T.plural + ' positions',
          empty: 'No ' + T.plural.toLowerCase() + ' yet. <button class="btn btn--sm" data-action="add-trade" data-type="' + type + '">Add one</button>' }) +
      '</section></div>';
  };
  function kpi(label, val, sub) {
    return '<div class="kpi"><dt>' + label + '</dt><dd>' + val + (sub ? '<span class="kpi__sub">' + sub + '</span>' : '') + '</dd></div>';
  }

  /* =====================================================================
     POSITION DETAIL
     ===================================================================== */
  const DETAIL_RANGES = [['1D', 1], ['1W', 7], ['1M', 30], ['3M', 90], ['1Y', 365], ['All', null]];
  let detailRange = '1M';

  V.position = function (root, app, key) {
    const st = app.state;
    const pos = st.derived.positions[key];
    if (!pos) {
      root.innerHTML = '<a class="back" href="#/dashboard">' + UI.icon('back') + ' Dashboard</a><section class="card empty"><h2>Position not found</h2><p>It may have been deleted. Its transactions would be listed under Transactions.</p></section>';
      return;
    }
    const row = st.summary.rows.find(r => r.key === key) || Object.assign({}, pos, { quote: PT.market.quoteFor(pos, st.overrides), priced: false });
    const q = row.quote || null, x = (q && q.extra) || {};
    const T = UI.TYPE[pos.type];
    const isEq = pos.type === 'stock' || pos.type === 'etf';
    const dexPriced = (q && (q.providerId === 'dexscreener' || x.pairAddress)) || pos.type === 'memecoin';
    const meta = Object.assign({}, pos.meta, x.pairAddress ? { chain: x.chain, pairAddress: x.pairAddress, contract: x.contract || pos.meta.contract, url: x.url } : {});

    const facts = [];
    const add = (k, v) => facts.push('<div class="fact"><dt>' + k + '</dt><dd>' + v + '</dd></div>');
    add('Quantity', '<span class="num">' + F.qty(pos.qty) + '</span>');
    add('Average entry', '<span class="num">' + F.price(pos.avgEntry) + '</span>' + ' <span class="muted">(excl. fees)</span>');
    add('Total invested', '<span class="num">' + F.money(pos.invested) + '</span>' + (pos.fees > 0 ? ' <span class="muted">incl. ' + F.money(pos.fees) + ' fees</span>' : ' <span class="muted">no fees</span>'));
    add('Current price', row.priced ? UI.priceCell(row) : UI.priceCell(row));
    add('Portfolio weight', row.weight == null ? '—' : '<span class="num">' + F.pct(row.weight, { plain: true }) + '</span>');
    add('Price source', q ? esc(q.source || '—') + (x.via ? ' <span class="muted">via ' + esc(x.via) + '</span>' : '') + (x.resolvedBy ? ' <span class="muted">· ' + esc(x.resolvedBy) + '</span>' : '') : '—');
    add('Last updated', q && (q.fetchedAt || q.lastGoodAt) ? F.dateTime(q.fetchedAt || q.lastGoodAt) + (q.stale ? ' ' + UI.badge('May be out of date', 'warn') : '') : '—');
    if (Math.abs(pos.realised) > 1e-9) add('Realised P&L', UI.pl(pos.realised, null));
    if (isEq) {
      add('Exchange', esc(x.exchange || pos.meta.exchange || '—'));
      add('Previous close', '<span class="num">' + F.price(x.referenceClose != null ? x.referenceClose : x.previousClose) + '</span>');
      add('Regular-session close', '<span class="num">' + F.price(x.regularPrice) + '</span>' + (x.regularTime ? ' <span class="muted">' + F.dateTime(x.regularTime) + '</span>' : ''));
      add('Extended-hours price', x.extendedPrice != null ? '<span class="num">' + F.price(x.extendedPrice) + '</span> ' + UI.badge(x.extendedSession === 'pre' ? 'Pre-market' : 'After-hours', 'session') +
        (x.extendedTime ? ' <span class="muted">' + F.time(x.extendedTime) + '</span>' : '') : (x.noExtendedData ? '<span class="muted">Not available from ' + esc(q.source) + '</span>' : '<span class="muted">No trades outside regular hours</span>'));
      add('Day range', U.isNum(x.dayLow) ? '<span class="num">' + F.price(x.dayLow) + ' – ' + F.price(x.dayHigh) + '</span>' : '—');
      add('52-week range', U.isNum(x.w52Low) ? '<span class="num">' + F.price(x.w52Low) + ' – ' + F.price(x.w52High) + '</span>' : '—');
    }
    if (dexPriced) {
      const un = '<span class="muted">unavailable</span>';
      add('Liquidity', U.isNum(x.liquidity) ? '<span class="num">' + F.usdCompact(x.liquidity) + '</span>' + (x.liquidity < C.LOW_LIQUIDITY_USD ? ' ' + UI.badge('Thin', 'warn') : '') : un);
      add('24h volume', U.isNum(x.volume24h) ? '<span class="num">' + F.usdCompact(x.volume24h) + '</span>' : un);
      add('Market cap', U.isNum(x.marketCap) ? '<span class="num">' + F.usdCompact(x.marketCap) + '</span>' : un);
      add('FDV', U.isNum(x.fdv) ? '<span class="num">' + F.usdCompact(x.fdv) + '</span>' : un);
      add('Blockchain', esc(meta.chain || '—'));
      add('DEX', esc(x.dex || '—') + (x.labels && x.labels.length ? ' <span class="muted">' + esc(x.labels.join(', ')) + '</span>' : ''));
      add('Trading pair', x.tokenSymbol ? esc(x.tokenSymbol + ' / ' + (x.quoteSymbol || '?')) : '—');
      add('24h trades', U.isNum(x.txns24h) ? '<span class="num">' + F.num(x.txns24h) + '</span>' : un);
      if (meta.contract) add('Contract', '<button type="button" class="addr-btn" data-copy="' + esc(meta.contract) + '" title="Copy contract address">' + esc(UI.shortAddr(meta.contract)) + UI.icon('copy') + '<span class="sr-only">Copy contract address</span></button>');
      if (meta.pairAddress) add('Pair address', '<button type="button" class="addr-btn" data-copy="' + esc(meta.pairAddress) + '" title="Copy pair address">' + esc(UI.shortAddr(meta.pairAddress)) + UI.icon('copy') + '<span class="sr-only">Copy pair address</span></button>');
      const page = PT.providers.dexscreener.pageUrl(meta);
      if (page) add('Dexscreener', '<a class="ext-link" href="' + esc(page) + '" target="_blank" rel="noopener noreferrer">Open token page' + UI.icon('ext') + '</a>');
    } else if (pos.type === 'crypto') {
      add('Market cap', U.isNum(x.marketCap) ? '<span class="num">' + F.usdCompact(x.marketCap) + '</span>' : '<span class="muted">unavailable</span>');
      add('24h volume', U.isNum(x.volume24h) ? '<span class="num">' + F.usdCompact(x.volume24h) + '</span>' : '<span class="muted">unavailable</span>');
      add('CoinGecko id', pos.meta.coingeckoId ? '<span class="num">' + esc(pos.meta.coingeckoId) + '</span>' : '—');
    }

    const txs = PT.portfolio.sortTx(st.txs.filter(t => PT.portfolio.assetKey(t) === key)).reverse();
    const useEmbed = pos.type === 'memecoin' || (dexPriced && !pos.meta.coingeckoId);
    const embedUrl = useEmbed ? PT.providers.dexscreener.embedUrl(meta, document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) : null;

    root.innerHTML =
      '<a class="back" href="' + classRoute(pos.type) + '">' + UI.icon('back') + ' ' + T.plural + '</a>' +
      '<header class="detail-head"><div><p class="eyebrow">' + UI.typeTag(pos.type) + '<span class="num">' + esc(pos.symbol) + '</span>' + (pos.meta.chain && pos.type === 'memecoin' ? '<span>· ' + esc(pos.meta.chain) + '</span>' : '') + '</p>' +
        '<h1 class="page-title">' + esc(pos.name) + '</h1>' +
        '<div class="detail-price"><span>' + (row.priced ? F.price(row.price) : '—') + '</span>' + (row.priced ? UI.chg(row.change) : '') + ' ' + (q && !q.manual ? UI.sessionBadge(q) : '') + (q && q.manual ? UI.badge('Manual price', 'manual') : '') + '</div></div>' +
        '<div class="detail-actions"><button class="btn btn--primary" data-action="buy-more" data-key="' + esc(key) + '">' + UI.icon('plus') + ' Buy more</button>' +
        (pos.open ? '<button class="btn" data-action="sell" data-key="' + esc(key) + '">Sell</button>' : '') + '</div></header>' +
      (q && q.error ? '<div class="banner banner--error">' + UI.icon('warn') + '<span><strong>' + (row.priced ? 'Price feed failing — showing the last good price from ' + F.dateTime(q.lastGoodAt) + '.' : 'No price.') + '</strong> ' + esc(q.error) + '</span></div>' : '') +
      (!pos.open ? '<div class="banner banner--info">' + UI.icon('warn') + '<span>This position is closed — you sold everything. Realised P&L: ' + UI.pl(pos.realised, null) + '</span></div>' : '') +
      '<div class="stack">' +
      '<section class="card kpi-strip" aria-label="Position summary">' +
        kpi('Position value', row.priced ? F.money(row.value) : '—', row.priced ? F.qty(pos.qty) + ' × ' + F.price(row.price) : 'no price') +
        kpi('Unrealised P&L', UI.pl(row.pl, row.plPct), 'vs ' + F.money(pos.invested) + ' invested') +
        kpi(isEq ? 'Today' : '24h change', UI.pl(row.todayPL, row.change), isEq ? 'vs previous regular close' : 'rolling 24 hours') +
        kpi('Portfolio weight', row.weight == null ? '—' : F.pct(row.weight, { plain: true }), '') +
      '</section>' +
      '<section class="card" aria-labelledby="pc-t"><div class="card__head"><div><h2 class="card__title" id="pc-t">Price</h2>' +
        '<p class="card__sub">' + (useEmbed ? 'Dexscreener\'s live chart — their public API has no price history, so none is drawn here' : 'Dashed line: your average entry ' + F.price(pos.avgEntry)) + '</p></div>' +
        (useEmbed ? '' : '<div class="seg" role="tablist" aria-label="Chart range">' + DETAIL_RANGES.map(r => '<button type="button" role="tab" aria-selected="' + (detailRange === r[0]) + '" data-detail-range="' + r[0] + '">' + r[0] + '</button>').join('') + '</div>') +
      '</div>' +
        (useEmbed ? (embedUrl ? '<iframe class="embed" src="' + esc(embedUrl) + '" title="Dexscreener price chart for ' + esc(pos.symbol) + '" loading="lazy" referrerpolicy="no-referrer"></iframe>' : '<p class="muted">No pair recorded for this token, so no chart is available.</p>')
          : '<div id="price-chart"><div class="skeleton" style="height:260px"></div></div><p class="chart-note" id="price-note" hidden></p>') +
      '</section>' +
      '<section class="card" aria-labelledby="f-t"><div class="card__head"><h2 class="card__title" id="f-t">Details</h2></div><dl class="facts">' + facts.join('') + '</dl></section>' +
      '<section class="card card--flush" aria-labelledby="tx-t"><div class="card__head"><div><h2 class="card__title" id="tx-t">Transactions</h2><p class="card__sub">' + txs.length + ' recorded — every trade is kept</p></div></div>' +
        PT.txview.miniTable(txs, st) + '</section>' +
      '</div>';

    if (!useEmbed) mountPriceChart(app, pos, row);
  };

  function mountPriceChart(app, pos, row) {
    const host = document.getElementById('price-chart');
    if (!host) return;
    const r = DETAIL_RANGES.find(x => x[0] === detailRange) || DETAIL_RANGES[2];
    const days = r[1] || Math.max(2, Math.ceil((Date.now() - (pos.firstBuyAt || Date.now())) / 86400000) + 30);
    const ck = pos.key + '|' + r[0];
    let chart = null;
    const draw = (pts, note, anim) => {
      if (!document.body.contains(host)) return;
      if (pts && row.priced && pts.length) {
        const last = pts[pts.length - 1];
        if (Date.now() - last.t > 60000) pts = pts.concat([{ t: Date.now(), c: row.price }]);
      }
      const points = (pts || []).map(p => ({ t: p.t, v: p.c, kind: 'recorded' }));
      const f = points[0], l = points[points.length - 1];
      const opts = {
        points, height: 260, tone: f && l ? (l.v >= f.v ? 'gain' : 'loss') : 'accent',
        refLine: pos.avgEntry > 0 ? { value: pos.avgEntry, label: 'Avg entry ' + F.price(pos.avgEntry) } : null,
        yFormat: v => F.price(v), ariaLabel: pos.symbol + ' price, ' + r[0], animate: !!anim,
        tip: p => ({ head: F.dateTime(p.t), rows: [['a', 'Price', F.price(p.v)], ['b', 'vs your entry', pos.avgEntry > 0 ? F.pct((p.v / pos.avgEntry - 1) * 100) : '—', UI.tone(p.v - pos.avgEntry)],
          ['c', 'Your value', F.money(p.v * pos.qty)]] }),
        empty: note || 'No price history available'
      };
      if (chart) chart.update(points, opts); else { host.innerHTML = ''; chart = PT.charts.line(host, opts); mounted.push(chart); }
      const n = document.getElementById('price-note');
      if (n) { n.hidden = !note; n.textContent = note || ''; }
    };
    const q = row.quote;
    if (r[1] === 1 && q && q.extra && q.extra.intraday && q.extra.intraday.length > 1) {
      draw(q.extra.intraday, (pos.type === 'stock' || pos.type === 'etf') ? 'Includes pre-market and after-hours trades.' : null);
      return;
    }
    if (priceCache[ck]) draw(priceCache[ck]);
    PT.market.series(pos, days, app.state.settings).then(s => {
      if (s.pts) { priceCache[ck] = s.pts; draw(s.pts, s.stale ? 'Showing cached history — the latest fetch failed.' : null); }
      else if (!priceCache[ck]) draw(null, s.error || 'No price history available for this asset.');
    });
  }
  V.setDetailRange = function (app, id, key) {
    detailRange = id;
    document.querySelectorAll('[data-detail-range]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.detailRange === id)));
    const row = app.state.summary.rows.find(r => r.key === key) || { quote: null, priced: false };
    mountPriceChart(app, app.state.derived.positions[key], row);
  };

  V.holdingColumns = holdingColumns;
  V.assetCell = assetCell;
  V.href = href;
  PT.views = V;
})(window.PT);
