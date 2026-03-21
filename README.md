# AMM Pool ALM Dashboard

A lightweight Firebase App Hosting-ready dashboard for uploading two CSV files, running an Automated Liquidity Management (ALM) simulation in the browser, and reviewing swap profitability, impermanent loss, and final ROI.

## Features

- Upload two CSV datasets with `date` and `close` columns.
- Configure virtual capital, real capital, and brokerage fee assumptions.
- Run the ALM simulation entirely in the browser.
- Review summary KPIs and a detailed swap-history table.
- Download the full swap ledger as CSV.
- Deploy on Firebase App Hosting from GitHub.

## Local development

```bash
npm run dev
```

Open http://localhost:3000.

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
5. Keep the included `firebase.json`; App Hosting will use the repo root and run the app with the included `npm start` command.
6. Once the backend is connected, each push to your selected branch can trigger a new deployment.

## CSV requirements

Each uploaded file must include:

- `date`: a timestamp parseable by the browser `Date` API
- `close`: numeric close price
