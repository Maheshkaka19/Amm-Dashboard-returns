# AMM Pool ALM Dashboard

A lightweight ALM dashboard for uploading two CSV files, running an Automated Liquidity Management (ALM) simulation in the browser, and reviewing swap profitability, impermanent loss, and final ROI.

## Why this version deploys on Firebase App Hosting

Firebase App Hosting supports Next.js, Angular, and generic **Node.js apps**. This repository is now structured explicitly as a Node.js app with:

- `package.json` scripts for `build`, `start`, and `dev`
- `package-lock.json` so App Hosting can detect the npm project cleanly
- `apphosting.yaml` to tell App Hosting exactly how to build and run the app
- a production build step that verifies and snapshots the app into `dist/` while runtime still starts directly from `server.mjs`

## Features

- Upload two CSV datasets with `date` and `close` columns
- Configure virtual capital, real capital, and brokerage fee assumptions
- Run the ALM simulation entirely in the browser
- Restrict swaps to whole stock units only
- Review summary KPIs and a detailed swap-history table
- Download the full swap ledger as CSV
- Deploy through GitHub with Firebase App Hosting

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
5. App Hosting should now recognize this repository as a Node.js app and use `apphosting.yaml` to run `npm run build` and then start the service with `node server.mjs`, which listens on the `PORT` environment variable.
6. After the first successful deploy, each new push to your connected branch can trigger another rollout.

## CSV requirements

Each uploaded file must include:

- `date`: a timestamp parseable by the browser `Date` API
- `close`: numeric close price
- swap execution uses whole stock units only (no fractional shares)
- real pool balances are updated cumulatively from the initial stock quantities after each executed swap
