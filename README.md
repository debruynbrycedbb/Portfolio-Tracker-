# Ledgerline — personal portfolio tracker

A single-person investment dashboard for **stocks, ETFs, cryptocurrency and memecoins**.
Plain HTML, CSS and JavaScript: no build step, no npm, no server, nothing to pay for.

- Open `index.html` straight from disk, or push the folder to GitHub Pages.
- Your data stays in your browser (`localStorage`). There is no account and no backend.
- Prices refresh automatically from free sources: Dexscreener, CoinGecko, and Yahoo Finance
  (through a small relay you deploy yourself for free), with Nasdaq and Finnhub as fallbacks.

> **Where your data lives:** in your browser (`localStorage`), per device. On its own, another
> browser or your phone starts empty, and clearing site data deletes everything. Turn on
> **[Sync across devices](#sync-across-devices)** to keep one portfolio on all your devices, and
> export a JSON backup now and then either way.

---

## Contents

1. [Run it locally](#run-it-locally)
2. [Deploy to GitHub Pages](#deploy-to-github-pages)
3. [Deploy the stock-data relay](#deploy-the-stock-data-relay-5-minutes)
4. [How the market-data APIs connect](#how-the-market-data-apis-connect)
5. [Optional API key (Finnhub)](#optional-api-key-finnhub)
6. [Adding investments](#adding-investments)
7. [How the portfolio calculations work](#how-the-portfolio-calculations-work)
8. [Dexscreener integration](#dexscreener-integration)
9. [Extended-hours pricing](#extended-hours-pricing-pre-market--after-hours)
10. [Pie: invest one amount across stocks & ETFs](#pie-invest-one-amount-across-stocks--etfs)
11. [Cash reserve](#cash-reserve)
12. [Sync across devices](#sync-across-devices)
13. [Share a read-only view](#share-a-read-only-view)
14. [Charts and history](#charts-and-history)
15. [Backups](#backups)
16. [Troubleshooting](#troubleshooting)
17. [Project layout](#project-layout)

---

## Run it locally

Double-click `index.html`. That's it — scripts are classic `<script>` tags (not ES modules), so
the page works from `file://`.

If you prefer a local server (closer to how GitHub Pages behaves):

```bash
cd portfolio-tracker
python3 -m http.server 8000
# open http://localhost:8000
```

On first open the starter portfolio from `js/config.js` is loaded (8 holdings, $977 invested).
Edit or empty `SEED_HOLDINGS` in that file to change it; it only applies to a brand-new install.

Keyboard: **A** adds a trade, **R** refreshes prices.

## Deploy to GitHub Pages

1. Create a repository and push the contents of this folder to its root (the `.nojekyll` file
   must be included — it stops GitHub's Jekyll step from touching the files).
2. Repository → **Settings → Pages** → *Build and deployment*: **Deploy from a branch**,
   branch `main`, folder `/ (root)`. Save.
3. After a minute the site is live at `https://<you>.github.io/<repo>/`.

All paths are relative, so it also works from a subdirectory. No GitHub Actions workflow is needed.

Your holdings are **not** in the repository — they live in the browser you use. The repository
only contains the app (and the seed list in `js/config.js`; empty it if the repo is public and
you'd rather not publish those numbers).

### Updating the site (and making phones pick it up)

Phones cache web pages hard, so after an upload a phone can keep running the old files. To avoid that:

1. When you change the app, bump the version in **three places** to the same new value:
   `APP_VERSION` in `js/config.js`, `version.json`, and every `?v=` in `index.html`.
2. Upload the files. Any device still running the old copy shows **"Update available — Reload"**
   (checked on open and whenever you switch back to the tab). Tap it.
3. The running version is printed at the bottom of **Settings** — compare it across devices.

## Deploy the stock-data relay (5 minutes)

Dexscreener and CoinGecko can be called directly from a browser. **Yahoo Finance cannot**: it
sends no CORS headers, so a static page needs something in between. Public CORS relays exist
but are not dependable — they rate-limit, hang, and change their terms. When this app was built
(23 Sep 2026) `corsproxy.io` had started demanding an API key, `allorigins.win` hung, and
`codetabs.com` failed outright; only `cors.lol` answered. So the app ships its own relay:
`cors-worker.js`, a free **Cloudflare Worker**.

1. Sign in at <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → *Create Worker*.
   Name it (e.g. `pt-relay`) → **Deploy**.
2. **Edit code** → replace the sample with the whole of `cors-worker.js` → **Deploy**.
3. Copy the Worker URL, e.g. `https://pt-relay.yourname.workers.dev`.
4. In the app: **Settings → Stock data relay** → paste the URL → **Save**.
   A URL missing its `?url=` parameter is corrected automatically.
5. Press **Test connection**.

What the relay does:

- **Allowlists** only `query1/query2.finance.yahoo.com` and `api.nasdaq.com` — it is not an open proxy.
- **Retries** upstream `429` and `5xx` up to 3 times with backoff (honouring `Retry-After`).
- **Caches** successful answers at the edge for 45 seconds.
- Marks its own refusals with an `X-Relay-Refused` header so the app can tell *"the relay
  refused"* from *"Yahoo refused"*.
- Optional: set a Worker variable `ALLOWED_ORIGINS` (e.g. `https://you.github.io`) to lock it to
  your site. Add `null` if you also open the page from disk.

CLI alternative: `npx wrangler deploy cors-worker.js --name pt-relay`.

**Relay modes** (Settings): *Automatic* — your relay first, public relays as spares;
*My relay only*; *None* — no relay (stocks then need a Finnhub key).

## How the market-data APIs connect

| Asset | Provider | Key | Route |
|---|---|---|---|
| Memecoins | Dexscreener | none | direct from the browser |
| Crypto | CoinGecko (Dexscreener when a DEX pair is recorded, and as fallback) | none | direct |
| Stocks & ETFs | Yahoo Finance → Nasdaq fallback | none | through the relay |
| Stocks & ETFs | Finnhub | optional | direct |
| FX (USD→EUR) | Frankfurter (ECB rates) → exchangerate-api fallback | none | direct, only when needed |

Verified live on 23 Sep 2026 before building. Two planned sources had changed and were
replaced: **Stooq** (its CSV endpoints now return "page does not exist" / "Access denied") was
replaced by **Nasdaq's quote API** as the keyless fallback, and **api.frankfurter.app** (no longer
answering cross-origin) by **api.frankfurter.dev**.

Every provider is one object in `js/providers.js` with the same three methods:

```js
quote(position)        // -> { ok, price, change24h, currency, source, extra }
search(text)           // -> [ { symbol, name, type, meta } ]
series(position, days) // -> [ { t, c } ]
```

and `providerFor(position, settings)` is the one routing function that decides which provider
prices an asset. To switch to a paid feed, edit one provider object (and `providerFor` if the
routing changes) — nothing else.

**Failure handling.** An HTTP error *from the data provider* (429, 404, 5xx) says nothing about
the relay that carried it, so it never takes the relay out of service; 429/5xx are retried once
on the same relay. A relay is benched for 90 seconds only when it doesn't answer at all or refuses
the request itself (401/402/403/407). When every relay is down, at most one is re-probed every
20 seconds — never the whole list per symbol. Stocks are fetched two at a time. Every error
message names the actual cause, e.g. *"Yahoo Finance is rate-limiting SPCX (HTTP 429) — your relay
is fine"* versus *"No stock data route is working"*.

**Test connection** (Settings) probes route by route, one at a time, using the exact request the
app really makes: each relay with a control ticker (AAPL), then each of your own tickers
separately, so "the relay is dead" and "this one symbol is refused" are never confused. Public
spares that are never reached while your relay works are shown as **Standby**, not as failures.

## Optional API key (Finnhub)

Get a free key at <https://finnhub.io>, paste it in **Settings → Finnhub API key**.

- Finnhub is called directly (it supports CORS), so it works without a relay.
- Its free tier is **regular session only** — no pre-market/after-hours — so while the
  extended-hours setting is on it is used only after Yahoo and Nasdaq; positions it prices are
  marked "Reg. only".
- **Any key used by a static website is visible to anyone who can open the page** (it's in the
  browser's storage and in every request). The key is stored only in your browser and is left
  out of JSON exports. **Never commit a key to your repository.**

## Adding investments

Press **Add trade** (or **A**) anywhere.

1. **Asset type** and **Buy / Sell**.
2. **Pick the asset.** Anything you already hold is offered first as one-click chips. From a
   position's page, **Buy more** / **Sell** skip identification entirely.
   - *Stocks, ETFs, crypto:* search by ticker or name. If a thinly-covered ticker isn't found,
     choose **Use "XYZ" as entered**.
   - *Memecoins:* paste the **token contract**, the **pair address**, or a full **Dexscreener
     URL** (the chain is read from the URL, even one not in the picker). If it resolves to
     exactly one pool it is selected immediately; if several pools trade it they are listed with
     chain, DEX and liquidity, deepest first, and very thin pools are flagged.
3. **How much you bought.** Buys default to **$ Amount**: type the money you put in (e.g. $100)
   and the app works out the quantity as *amount ÷ price per unit*, shown live ("= 0.65142 shares
   at $153.51"). Fees are added **on top** of the amount. Switch to **Units** to enter a quantity
   instead — whatever you typed is carried across. Sells are always entered in units (with
   **Sell all**). A buy entered as an amount remembers the figure you typed, so editing it later
   shows the same $100. The quantity is stored at full precision; nothing is rounded.
4. **Price per unit, currency, date & time, fees, notes.** The price is pre-filled with
   the current price. A running total shows *cost* (`qty × price + fees`) for a buy and
   *proceeds* (`qty × price − fees`) for a sell. When selling you see how much you hold and a
   **Sell all** button.
5. If you already hold the asset, the form previews the effect **before** you commit: position
   now, position after, new average entry, new total invested (or realised P&L for a sell).

If something is missing, the form says exactly what and scrolls to and highlights that control.
Transactions can be edited and deleted (with confirmation) from **Transactions** or from a
position's page. Repeat purchases never overwrite earlier ones — every trade stays in the history.

## How the portfolio calculations work

Positions are **never stored**. They are rebuilt from the full transaction list every time,
so they can't drift out of sync with your history.

```
costBasis     = Σ (quantity × price)          fees excluded
averageEntry  = costBasis ÷ quantity
totalInvested = costBasis + Σ fees            fees included
positionValue = quantity × currentPrice
unrealisedPL  = positionValue − totalInvested
plPercent     = unrealisedPL ÷ totalInvested × 100
```

Fees are kept out of the average entry (a clean "what I paid per unit") but inside total
invested (so P&L tells the truth about your money).

Example: buy 10 at 100, later 5 at 120 → quantity **15**, invested **1,600**, average entry **106.67**.

**Sells** remove units at the running average cost (plus the matching share of buy fees) and
bank the difference as **realised P&L**. The average entry of what remains doesn't move.
A sell larger than what you held at that date is refused, naming what you actually held.

**Today's P&L** = Σ `(price − price ÷ (1 + change/100)) × quantity`, using each asset's day /
24h change.

**Missing prices are never counted as losses.** A position without a price is left out of the
total value **and** of the invested amount P&L is measured against; the dashboard then says
"this P&L covers X of the Y you have invested". If nothing can be priced, P&L shows "—", never
−100%. A failed feed keeps the last known price, marks it with ◷ and the time it was last good,
and explains the failure.

**Currency.** Everything is fetched in USD. With EUR selected, amounts are converted at the live
ECB rate at display time only. Transactions entered in EUR keep their EUR figures; they are
converted to USD with the current rate when positions are calculated.

**Manual price overrides** (Settings) pin a price for anything without a reliable feed. They are
stored separately from fetched prices and exported in their own section.

## Dexscreener integration

- Pricing order for a DEX token: **recorded chain + pair** → if that returns nothing, the **token
  contract across all chains** → then a **text search**. Whenever a token trades in several
  pools, the **deepest liquidity** pool is used — a price from a tiny pool is not a price.
- Shown per token: name, symbol, contract (click to copy), chain, USD price, liquidity, 24h
  volume, 24h change, market cap, FDV, DEX, trading pair, 24h trade count, and a link to the
  token's Dexscreener page. Missing figures read "unavailable", never "$0".
- A token with no indexed pair gets a specific message, not a silent zero.
- Dexscreener's public API has **no OHLC/history endpoint**, so no price history is invented:
  memecoin pages embed Dexscreener's own live chart.
- Memecoins are identified by **chain + contract address**, because names and symbols aren't
  unique. Stocks, ETFs and crypto are identified by ticker.
- TRAC is filed under Cryptocurrency but priced through its Ethereum Dexscreener pair (CoinGecko
  `origintrail` is the fallback and supplies its price history).

## Extended-hours pricing (pre-market & after-hours)

US stocks trade 04:00–09:30 ET pre-market and 16:00–20:00 ET after-hours. Most quote fields only
report the last regular session, which would freeze your portfolio at yesterday's close all
morning. So on every refresh the app reads **both** the last regular-session close **and** the most
recent trade of any kind:

- The extended price is the **last actual trade in the intraday series** (`includePrePost=true`),
  not a summary field (those lag and carry no timestamp).
- A trade counts as extended when its **timestamp falls outside the regular session window** —
  never by comparing prices (a pre-market trade at exactly the closing price still counts).
- **Settings → Include pre-market & after-hours prices** (on by default). Off = last regular close.
- **Day change is always measured against the previous regular close**: a pre-market price
  against the last close; a regular or after-hours price against the close before today's session.
- Prices taken outside regular hours carry a **Pre-mkt / After-hrs** badge; the position page
  shows both the regular close and the extended price; the dashboard says which session the US
  market is in and how many positions are priced from extended trading.
- Sources without extended data (Finnhub free tier) are marked "Reg. only".
- The 1D charts include extended trades, so they don't flatline overnight.
- Crypto and memecoins trade continuously and are unaffected.

## Pie: invest one amount across stocks & ETFs

**Pie** (in the menu) works like a Trading212 pie for your stocks and ETFs (crypto and memecoins
are deliberately left out).

- **Target split.** Starts as ARKG 30%, SPCX 30%, ARKX 20%, BOTZ 20% (set in `DEFAULT_PIE` in
  `js/config.js`). Change a weight, add another stock/ETF you hold, remove one, or press
  **Split equally** — then **Save pie**. Weights must total exactly 100%; you're told live if
  they don't.
- **Invest in pie.** Type one amount (e.g. $300). The preview shows each slice's share ($90 /
  $90 / $60 / $60), the price per unit (pre-filled with the live price — change it to what you
  actually paid) and how many shares/units that buys. Optional total fees are split by weight
  and added on top. Tick **Pay from cash reserve** to fund it from your cash.
- **Exact cents.** The amount is split into whole cents that add up to exactly what you typed
  ($333.33 → $100.00 + $100.00 + $66.67 + $66.66).
- **Ordinary transactions.** Pressing **Buy pie** records one normal buy per slice (entered as a
  $ amount), all saved together and tagged "pie" in Transactions. Each can be edited or deleted on
  its own like any other trade.
- **Now vs target.** Shows each slice's actual share of the pie's current value against its target,
  e.g. "ARKG 31.97% / 30% · ▲ +2.0 pts over", so you can see what's drifted.
- The saved split is included in JSON backups.

## Cash reserve

**Cash** (in the menu) holds spare dollars you plan to deploy later.

- **Add cash**, **Withdraw**, or **Set balance** (type what you actually have; the difference is
  recorded as an adjustment). Every movement is kept in a history with the balance after it.
- **Trades can use it.** The trade form has a tick-box: *Pay from cash reserve* on a buy (cost incl.
  fees comes out) and *Add proceeds to cash reserve* on a sell (proceeds after fees go in). It's
  ticked by default when you have cash; untick it for trades funded from elsewhere.
- **Linked movements follow their trade.** Editing a trade updates its cash movement; deleting it
  reverses it. The balance is never allowed to go below zero — a buy costing more than you have,
  a withdrawal larger than the balance, or deleting cash that trades already spent is refused
  with the amounts involved.
- **Kept beside the investments, not inside them.** The headline *Total portfolio value* and all
  P&L figures cover investments only, so cash doesn't dilute your returns. The dashboard adds a
  *Cash reserve* tile and a *Total incl. cash* line, and the allocation chart shows cash as its
  own slice.
- Amounts are in US dollars (shown in euros when EUR is your display currency). The cash ledger is
  included in JSON backups; CSV exports are trades only.

## Sync across devices

Keeps your trades, cash reserve, pie, manual prices, display currency and extended-hours setting
the same on your computer, phone and any other browser. Prices aren't synced — each device fetches
its own, and the same trades at the same prices give the same portfolio value. Theme, refresh
interval, relay URL and API keys stay per device.

**Where it's stored:** a free **Cloudflare D1** database in your own Cloudflare account, served by
the same Worker as the stock-data relay (`/sync` on it). Nothing is readable without your sync key.

> Why D1 and not Cloudflare KV: KV is eventually consistent — Cloudflare's docs say a write can take
> 60 seconds or more to be visible elsewhere — and it has no atomic compare-and-set, so two devices
> could silently overwrite each other. D1 keeps one primary copy, and every save states which
> revision it was based on; a stale save is refused and merged instead.
> (D1 free plan: 5 million rows read and 100,000 rows written per day — this app uses a tiny fraction.)

**Set up (about 5 minutes):**

1. Deploy the latest `cors-worker.js` to your Worker (it adds `/sync` next to the relay).
2. Cloudflare dashboard → **Storage & databases → D1 SQLite Database → Create Database** → Name
   `ledgerline`, leave *Data location* as it is → **Create**. No tables to create — the Worker makes
   its one table on first use.
3. **Workers & Pages** → your Worker → **Bindings** → **Add binding** → **D1 database** → Variable name
   **`DB`** → select `ledgerline` → **Add binding**.
4. In Ledgerline on your computer: **Settings → Sync across devices → Generate** a key. Then your Worker →
   **Settings → Variables and Secrets → Add** → Type **Secret**, Variable name **`SYNC_KEY`**, Value = that
   key → **Deploy**.
5. Press **Connect**. Your computer's portfolio becomes the synced copy.
6. On your phone: open the site → Settings → paste your relay URL → paste the same sync key →
   **Connect** → choose **Use the synced portfolio**.

**How it behaves:**

- A change is saved about a second after you make it. Other devices pick it up when you open the
  app, return to the tab, or within a minute while it's open. **Sync now** forces it.
- The sidebar (top bar on phones) shows *Synced*, *Syncing…*, *Unsynced changes* or *Sync problem*.
- **Offline is fine:** changes stay on the device and sync when the server is reachable again.
- **Both devices changed things?** They're merged record by record: each device remembers the copy it
  last synced, so it can tell a deletion from a new trade on the other device. If both devices edited
  the *same* record, the device syncing now wins. If the combination would be impossible (e.g. both
  sold the same shares), you're asked which version to keep — nothing is silently discarded.
- **Disconnect this device** stops syncing without touching other devices. **Reset everything**
  disconnects the device first, so a reset never wipes your other devices.
- The sync key is stored only in each browser and never in backups. Anyone with both the key and
  your Worker URL could read your portfolio — keep it private.

## Share a read-only view

Send people a link that shows your portfolio, kept up to date, without giving them your sync key
or asking them to set anything up.

**Make the link:** needs sync set up (above) and the latest `cors-worker.js` deployed — nothing
else in Cloudflare. On any connected device: **Settings → Sync across devices → Share a read-only
view → Create share link → Copy link**. It looks like
`https://you.github.io/ledgerline/?view=<random token>&w=pt-relay.you.workers.dev`.

**What people who open it see:** the dashboard, every asset class, position pages, Pie (now vs
target), Transactions and Cash — full values, P&L, notes and cash — with live prices fetched
through your Worker. They can't add, edit or delete anything: the buttons are gone, the app's
storage refuses writes, and on the server the view token only opens `GET /view`, which can't write
and can't read `/sync`. There is no Settings page in the shared view.

**Up to date:** it reloads your latest synced copy when opened, when the viewer returns to the
tab, and every minute while it's open. Prices refresh on the viewer's own schedule.

**Your control:**

- **New link** replaces the token; the old link immediately shows *"This link is switched off"*
  and its cached copy is removed from the viewer's browser.
- **Turn off** deletes the token. Your own devices keep syncing as normal.
- The link is shown again on any of your connected devices, so you can copy it from your phone.

**Good to know:**

- Anyone who gets hold of the link can see the portfolio — treat it like a private document link.
  If it spreads further than you meant, press **New link**.
- Opening a share link in your own browser doesn't touch your own portfolio: the shared view uses
  its own storage (`pt:v1:view:*`) and never syncs.
- If you've set `ALLOWED_ORIGINS` on the Worker, it must include your site's address (it already
  does if the site works for you) — viewers open the same site.
- Make the link from the site's real address (e.g. GitHub Pages), not a local copy, or the link
  will point at `localhost`.

## Charts and history

All charts are hand-written SVG — no chart library.

- **Performance** (1D, 1W, 1M, 3M, 6M, 1Y, All) merges two sources, drawn differently:
  - **Recorded** (solid): snapshots of portfolio value captured while the page is open, only when
    every position has a fresh price. Thinned automatically (10-minute spacing for two days,
    hourly to 90 days, daily after): a year of use is roughly 2,700 points, about 160 KB.
  - **Reconstructed** (faint): what the holdings you actually had on each date were worth, from
    historical prices — useful from day one.
  - **Estimated** (faint, dashed): memecoins have no public history, so inside reconstructed
    stretches they are interpolated between entry and current price. Always labelled.
- Lines use **monotone cubic interpolation** (not Catmull–Rom), which never overshoots the values
  it joins — important when snapshots are dense by day and sparse overnight. Series are
  downsampled to about one point per pixel with Largest-Triangle-Three-Buckets.
- Hover (or focus and use ←/→) for exact values: value, P&L in currency and %, timestamp, source.
- Allocation by class, weight within each class, P&L by position, and a price chart per position
  with your average entry as a dashed reference line.

## Backups

**Settings → Backup**

- **Export JSON** — full fidelity: transactions, cash reserve ledger, manual price overrides (their own section),
  settings (without the API key), plus an informational snapshot of positions.
- **Export CSV** — transactions only, one per row, spreadsheet-friendly.
- **Import** a `.json` or `.csv` export, choosing **Merge** (adds only transactions not already
  present) or **Replace all**. Imports that would make any sell exceed its holding are refused
  and nothing changes.

**Reset** options (each asks first): clear the price cache, clear recorded history, reset everything.

Storage keys are versioned (`pt:v1:…`) so a future schema change can migrate your data. `js/store.js`
is the only module that touches storage (apart from a one-line read of the theme in `index.html`
before first paint, to avoid a flash) — to add a real backend later, reimplement just that file.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Stocks show **No price**, "No stock data route is working" | No relay answers. Deploy `cors-worker.js` and paste its URL in Settings. Run **Test connection**. |
| "…is rate-limiting SPCX (HTTP 429) — your relay is fine" | Yahoo is throttling that symbol (Cloudflare's shared IPs get throttled sometimes). The Nasdaq fallback is tried automatically; it usually clears within minutes. |
| "Yahoo has no data for XYZ" | Ticker wrong or not a US listing. Non-US listings need a suffix, e.g. `VUSA.L`. |
| Test connection shows **Standby** rows | Normal — public spares aren't used while your relay works. |
| Relay row: "refused the request itself (HTTP 403)" | `ALLOWED_ORIGINS` on the Worker doesn't include your site's origin. |
| A memecoin shows no price | Dexscreener has no pair for that contract/chain. Check both, or pin a manual price. |
| ◷ next to a price | The feed failed on the last refresh; the last good price is shown with its time. Hover for the cause. |
| Portfolio looks frozen before 09:30 ET | Check Settings → *Include pre-market & after-hours prices* is on and your relay works. |
| Everything vanished | Site data was cleared, or you're in another browser / private window. Connect sync (it restores from the synced copy) or import your latest JSON backup. |
| "Sync problem" / key doesn't match | The key on this device must equal the Worker's `SYNC_KEY` secret exactly. Settings → Sync shows the exact cause. |
| Phone shows old data | Open Settings → Sync now. If it says "not set up", the phone isn't connected yet — paste the relay URL and sync key there. |
| Phone's Settings is missing cards (e.g. no **Sync across devices**) | The phone is running an older copy. Reload the page, or tap **Update available — Reload**. The version at the bottom of Settings should match your computer's. |
| Share link says "This link is switched off" | It was replaced (**New link**) or turned off. Copy the current link from Settings → Sync on a connected device. |
| Settings shows no *Share a read-only view* option, or "older version without share links" | Sync must be connected on that device, and the Worker must run the latest `cors-worker.js` (paste + Deploy). |
| "Browser storage is full" | Export a backup, then Settings → Clear recorded history. |

## Project layout

```
index.html            page shell, loads the scripts in order
.nojekyll             tells GitHub Pages to serve files as-is
cors-worker.js        the Cloudflare Worker: stock-data relay + /sync (setup steps in its header)
css/app.css           all styles, light & dark palettes
js/config.js          constants and the SEED PORTFOLIO (edit / empty here)
js/util.js            formatting, events, helpers
js/store.js           the only module that touches browser storage (book vs market namespaces)
js/portfolio.js       positions & P&L derived from transactions (pure maths)
js/providers.js       market-data providers, relay chain, routing, error messages
js/market.js          refresh orchestration, quote cache, FX, snapshots, connection test
js/history.js         performance-over-time reconstruction
js/charts.js          SVG charts: monotone cubic line, donut, bars, LTTB
js/ui.js              shared UI: P&L cells, badges, sortable tables, dialogs, toasts
js/views.js           dashboard, asset-class pages, position detail
js/transactions.js    transactions screen and delete flow
js/settings.js        settings, backup/import, reset
js/cash.js            cash reserve screen (deposits, withdrawals, history)
js/pie.js             pie: target split, drift, invest one amount across stocks & ETFs
js/sync.js            sync across devices: push/pull, three-way merge, Settings card
js/viewer.js          read-only share link: fetches /view, viewer banner and status
js/modal.js           add / edit trade form
js/app.js             boot, routing (#/…), refresh timer, shortcuts
```

A price refresh has no code path to your transactions: the market layer is only given the
`market` half of the store, whose writes refuse any key outside the market namespace.
