# AMM Pool ALM Dashboard

A lightweight hourly event-driven ALM dashboard for uploading two CSV files, running an Arrakis-style concentrated-liquidity simulation in the browser, and reviewing swap profitability, impermanent loss, and final ROI.

## Why this version deploys on Firebase App Hosting

Firebase App Hosting supports Next.js, Angular, and generic **Node.js apps**. This repository is now structured explicitly as a Node.js app with:

- `package.json` scripts for `build`, `start`, and `dev`
- `package-lock.json` so App Hosting can detect the npm project cleanly
- `apphosting.yaml` to tell App Hosting exactly how to build and run the app
- a production build step that verifies and snapshots the app into `dist/` while runtime still starts directly from `server.mjs`

## Features

- Upload two CSV datasets with `date`, `close`, and `volume` columns
- Run an hourly event-driven ALM engine with:
  - dynamic volume risk mode switching (LOW / MID / HIGH)
  - dynamic rolling correlation
  - dynamic concentration width
  - dynamic re-centering when drift reaches configured threshold
- Restrict swaps to whole stock units only
- Configure swap friction fee (default 0.3%)
- Review summary KPIs and detailed swap history
- Download the full swap ledger as CSV

## Settings guide

- **Total Real Capital**: capital split 50:50 by value at initialization.
- **Virtual Capital per Asset**: controls concentrated-curve depth and target inventory profile.
- **0.3% Fee Setting**: flat friction (STT + brokerage) charged on swap revenue each trade.
- **LOW/MID/HIGH Width (%)**: base concentration width per risk mode.
- **Sigma Threshold**: sensitivity of mode switching using hourly volume mean ± sigma band.
- **Volume Lookback (Hours)**: lookback used for mode detection statistics.
- **Correlation Lookback (Hours)**: lookback used for rolling return correlation.
- **Correlation Impact (0-1)**: how strongly weak correlation widens active concentration.
- **Recenter Trigger (% of Width)**: drift threshold to recenter range around current ratio.
- **Pause swaps in HIGH mode**: optional risk brake during volatile periods.

## Local development

```bash
npm run dev
```

Open http://localhost:3000.

## Production build check

```bash
npm run build
npm start
```

## Deploy with Firebase App Hosting

1. Push this repository to GitHub.
2. Install the Firebase CLI if needed:
   ```bash
   npm install -g firebase-tools
   ```
3. Authenticate:
   ```bash
   firebase login
   ```
4. In the Firebase console, create a new **App Hosting** backend and connect your GitHub repository.
5. App Hosting uses `apphosting.yaml` to run `npm run build` and start with `node server.mjs`.

## CSV requirements

Each uploaded file must include:

- `date`: a timestamp parseable by the browser `Date` API
- `close`: numeric close price
- `volume`: numeric traded volume

## Engine API

`runAlmSimulation(df1, df2, realCapital, config)`

Config fields:
- `virtualCapital`
- `feePct`
- `lowWidth`, `midWidth`, `highWidth`
- `sigmaThreshold`
- `lookbackHours`
- `corrLookbackHours`
- `correlationImpact`
- `recenterTriggerPct`
- `pauseHighVol`
