# V3 Pool — Alpha Reinvestment Dashboard  v3.0

## What changed in v3.0
- **No recentering ever.** `rL` and `rH` are set once at the opening
  price ratio and never move. The band is permanent.
- **No rebalancing events.** When price exits the band the pool holds its
  position and waits. No forced reset, no brokerage event.
- **Fixed L between reinvestments.** L is computed once at init. It only
  grows when cash profits are reinvested — not on every price tick.
- **Cash-balanced trades.** Sell N shares → take proceeds → buy only what
  proceeds cover after brokerage. No inventory bleed, no phantom shares.
- **Dynamic initial band (optional).** Band width is derived from the
  first N hours of data volatility (k × σ). Set once. Never moves.
- **Out-of-range tracking.** Chart shows red shading when pool is OOR.
  Status bar and health panel report OOR %, with advice to widen band.

## Deploy (Firebase App Hosting)
1. Push this folder to GitHub
2. Connect to a Firebase App Hosting backend
3. App Hosting reads `apphosting.yaml` → `npm run build` → `node server.mjs`

## Local dev
```bash
npm run dev
# http://localhost:3000
```

## CSV format
Columns required: `date`, `close`, `volume`
- `date`: ISO-8601 e.g. `2025-01-02 09:15:00+05:30`
- `close`: price in ₹
- 1-minute bars → merged to hourly automatically
