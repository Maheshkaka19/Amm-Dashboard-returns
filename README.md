# V3 Pool — Alpha Reinvestment Dashboard
**Version 2.0  |  Built 2026-05-13**

A clean, investor-grade Uniswap V3 concentrated liquidity simulation
for NSE stock pairs with automatic alpha reinvestment.

## What it does
- Runs hourly V3 swap arbitrage between two NSE stocks
- Reinvests accumulated swap profits back into the pool (compounding L)
- Shows plain-₹ results: Pool Value, vs Hold, Cash Collected, IL
- Merged swap + reinvestment event ledger with CSV download

## Deploy to Firebase App Hosting
1. Push this repo to GitHub
2. Connect it to a Firebase App Hosting backend
3. App Hosting reads `apphosting.yaml` → runs `npm run build` → starts `node server.mjs`

## Local development
```bash
npm run dev
# Open http://localhost:3000
```

## CSV format required
Each uploaded file must have columns: `date`, `close`, `volume`
- `date`: any ISO-8601 timestamp (e.g. `2025-01-01 09:15:00+05:30`)
- `close`: numeric price in ₹
- `volume`: numeric traded volume (used for bucketing, not weighting)
- 1-minute bars are automatically merged to hourly

## Configuration (in-browser)
| Setting | Default | Notes |
|---------|---------|-------|
| Band Width ± % | 20% | Price range around opening ratio. Narrower = more fees, more IL risk |
| Buy Brokerage | 0.15% | STT + broker on buy leg |
| Sell Brokerage | 0.15% | STT + broker on sell leg |
| Reinvest Brokerage | 0.15% | Applied when buying reinvestment lots |
| Reinvest enabled | Yes | Buys 1 A + round(Y/X) B shares when cash accumulates |
