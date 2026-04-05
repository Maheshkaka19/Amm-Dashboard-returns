// simulation-core.js — AMM Volatility Harvesting Backtester v4
// Institutional-grade. All quantities are whole shares (NSE rules).
// ═══════════════════════════════════════════════════════════════════════════════
//
// TRADE MECHANICS (Indian stock market):
//   Stocks cannot be transferred between demats in fractions of seconds,
//   so each AMM rebalance is simulated as two simultaneous market orders:
//
//   SCENARIO A — ratio moved so AMM needs more X, less Y:
//     Step 1: BUY  boughtQty (whole) of Asset1 from NSE   → cost  = boughtQty × p1
//     Step 2: AMM releases soldQty  (whole) of Asset2      → rev   = soldQty  × p2
//     Gross profit  = rev − cost
//     Brokerage buy = buyBrokerPct  × cost
//     Brokerage sell= sellBrokerPct × rev
//     Net profit    = gross − brokerage_buy − brokerage_sell
//     ONLY execute if net profit > 0 AND both quantities ≥ 1
//
//   SCENARIO B — ratio moved so AMM needs more Y, less X:
//     Step 1: BUY  boughtQty (whole) of Asset2 from NSE   → cost  = boughtQty × p2
//     Step 2: AMM releases soldQty  (whole) of Asset1      → rev   = soldQty  × p1
//     same profit formula
//
// WHOLE-UNIT ENFORCEMENT:
//   Quantities are floored to integers BEFORE any P&L calculation.
//   Leftover fractional "dust" is DISCARDED (not banked), preventing
//   compounding leakage over hundreds of hours.
//   The pool tracks integer shares; the invariant L is re-derived
//   from the actual integer holdings after each trade.
//
// RECENTERING — REAL MARKET REBALANCE COST:
//   When recentering, the required x/y ratio for the new range differs from
//   what you currently hold. In real life you must sell one asset and buy the
//   other to hit the new ratio. This rebalancing trade is executed at market
//   price and brokerage is charged. The new L is derived from the adjusted
//   integer holdings, not from a hypothetical lossless teleport.
//
// IL STOP-LOSS:
//   If (poolAssetValue / holdValue − 1) < −ilStopLossPct%, all swaps halt.
//
// DUST CONTROL:
//   After every trade the pool stores only floor(x) and floor(y).
//   Fractional remainders are not tracked — they represent sub-share
//   quantities that NSE cannot execute.
// ═══════════════════════════════════════════════════════════════════════════════

export function splitCsvLine(line) {
  const cells = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i+1] === '"') { cur += '"'; i++; } else { q = !q; } }
    else if (c === ',' && !q) { cells.push(cur); cur = ''; }
    else { cur += c; }
  }
  cells.push(cur);
  return cells;
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map(v => v.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    return headers.reduce((row, h, i) => { row[h] = (cells[i] || '').trim(); return row; }, {});
  });
}

export function normalizeRows(rows) {
  return rows
    .map(row => ({ date: new Date(row.date), close: Number(row.close), volume: Number(row.volume) }))
    .filter(row => !isNaN(row.date) && isFinite(row.close) && row.close > 0 && isFinite(row.volume))
    .sort((a, b) => a.date - b.date);
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function mean(arr) { return arr.length ? arr.reduce((s,v) => s+v, 0)/arr.length : 0; }

function stdDev(arr, avg) {
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((s,v) => s + (v-avg)**2, 0) / arr.length);
}

function pearsonCorr(a, b) {
  if (a.length < 2 || a.length !== b.length) return 0;
  const ma = mean(a), mb = mean(b);
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]-ma, db = b[i]-mb;
    num += da*db; va += da*da; vb += db*db;
  }
  const denom = Math.sqrt(va*vb);
  return denom > 0 ? num/denom : 0;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── 1-minute → hourly merge ──────────────────────────────────────────────────

function hourKey(date) { const d = new Date(date); d.setMinutes(0,0,0); return d.toISOString(); }

function mergeMinutely(a1, a2) {
  const merged = [];
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) { merged.push({ date: a1[i].date, c1: a1[i].close, c2: a2[j].close, v1: a1[i].volume, v2: a2[j].volume }); i++; j++; }
    else if (t1 < t2) i++; else j++;
  }
  return merged;
}

function toHourly(merged) {
  const map = new Map();
  for (const row of merged) {
    const key = hourKey(row.date);
    if (!map.has(key)) map.set(key, { date: new Date(key), c1: row.c1, c2: row.c2, vol: 0 });
    const b = map.get(key);
    b.c1 = row.c1; b.c2 = row.c2; b.vol += row.v1 + row.v2; // last close of hour
  }
  const arr = [...map.values()].sort((a,b) => a.date - b.date);
  for (let k = 0; k < arr.length; k++) {
    arr[k].ret1 = k === 0 ? 0 : arr[k].c1/arr[k-1].c1 - 1;
    arr[k].ret2 = k === 0 ? 0 : arr[k].c2/arr[k-1].c2 - 1;
  }
  return arr;
}

// ─── Volume regime ────────────────────────────────────────────────────────────

function volMode(vol, win, sigma) {
  if (!win.length) return 'MID';
  const avg = mean(win), sd = stdDev(win, avg), band = sigma * sd;
  if (vol < avg - band) return 'LOW';
  if (vol > avg + band) return 'HIGH';
  return 'MID';
}

// ─── Uniswap V3 concentrated liquidity math ───────────────────────────────────
//
// Price ratio p = p1/p2  (how many units of Asset2 equal 1 unit of Asset1)
// Active range [pa, pb] symmetric around center price ratio.
//
// Given liquidity constant L:
//   x(p) = L · (1/√p  − 1/√pb)    ← Asset1 inventory at price p
//   y(p) = L · (√p    − √pa )     ← Asset2 inventory at price p
//
// We re-derive L from the actual integer pool holdings after each trade.
// This prevents the "ghost liquidity" bug where non-integer holding assumptions
// silently diverge from the integer-constrained real portfolio.

function xFromL(L, p, pa, pb) {
  if (p <= pa) return L * (1/Math.sqrt(pa) - 1/Math.sqrt(pb));
  if (p >= pb) return 0;
  return L * (1/Math.sqrt(p) - 1/Math.sqrt(pb));
}

function yFromL(L, p, pa, pb) {
  if (p <= pa) return 0;
  if (p >= pb) return L * (Math.sqrt(pb) - Math.sqrt(pa));
  return L * (Math.sqrt(p) - Math.sqrt(pa));
}

function lFromXY(x, y, p, pa, pb) {
  // Derives L that is consistent with both integer holdings at price p within [pa,pb]
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  const lx = (1/sp - 1/spb) > 1e-14 ? x / (1/sp - 1/spb) : Infinity;
  const ly = (sp  - spa    ) > 1e-14 ? y / (sp  - spa)     : Infinity;
  // Use the binding constraint (smaller L) to avoid over-representing inventory
  return Math.min(lx, ly);
}

// ─── Target ratio helper (for recentering rebalance) ─────────────────────────
// At the center of a new range [pa_new, pb_new] at price p:
//   x_target / y_target = (1/√p − 1/√pb) / (√p − √pa) × (p2/p1)
// We use this to determine how to rebalance existing stock before locking in L.

function targetXYRatio(p, pa, pb) {
  // returns x/y ratio (in share counts) at center of range
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  const xFactor = 1/sp - 1/spb;   // proportional to x
  const yFactor = sp - spa;        // proportional to y
  return (yFactor > 1e-14 && xFactor > 1e-14) ? xFactor/yFactor : null;
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);

  if (!asset1.length || !asset2.length)
    return { error: 'Both CSV files must contain valid date, close, and volume columns.' };

  const merged = mergeMinutely(asset1, asset2);
  if (!merged.length)
    return { error: 'No overlapping timestamps found. Confirm both CSVs cover the same trading period.' };

  const hourly = toHourly(merged);
  if (hourly.length < 2)
    return { error: 'Need at least 2 hourly buckets after preprocessing.' };

  // ── Config ──────────────────────────────────────────────────────────────────
  const lowW         = clamp(Number(config.lowWidth          ?? 0.75), 0.05, 50) / 100;
  const midW         = clamp(Number(config.midWidth          ?? 2),    0.05, 50) / 100;
  const highW        = clamp(Number(config.highWidth         ?? 5),    0.05, 50) / 100;
  const sigmaT       = Number(config.sigmaThreshold          ?? 1);
  const lookbackH    = Math.max(2, Number(config.lookbackHours       ?? 24));
  const corrLB       = Math.max(2, Number(config.corrLookbackHours   ?? 24));
  const corrImpact   = clamp(Number(config.correlationImpact ?? 0.6), 0, 2);
  const recTrigF     = clamp(Number(config.recenterTriggerPct ?? 75) / 100, 0.05, 2);
  // Brokerage: separate buy-side and sell-side rates (default 0.15% each = 0.30% total)
  const buyBrokerPct  = clamp(Number(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrokerPct = clamp(Number(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;
  const pauseHigh    = Boolean(config.pauseHighVol           ?? false);
  const ilStopLossPct = clamp(Number(config.ilStopLossPct   ?? 0), 0, 100); // in percent

  // ── Initial pool setup ──────────────────────────────────────────────────────
  const h0 = hourly[0];
  const p0 = h0.c1 / h0.c2;  // initial price ratio

  let centerP   = p0;
  let rangeHalf = midW;
  let pa = centerP * (1 - rangeHalf);
  let pb = centerP * (1 + rangeHalf);

  // Whole-share initial allocation (floor to integer — dust discarded)
  const halfCap = realCapital / 2;
  const xInit   = Math.floor(halfCap / h0.c1);  // integer Asset1 shares
  const yInit   = Math.floor(halfCap / h0.c2);  // integer Asset2 shares

  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low: cannot purchase even 1 share of each asset.' };

  // Derive L from actual integer holdings (not theoretical fractional amounts)
  let L = lFromXY(xInit, yInit, p0, pa, pb);

  let poolX = xInit;   // always integers
  let poolY = yInit;   // always integers

  // Cash account: net profit from all profitable swaps
  let cashProfit     = 0;
  let totalBrokerage = 0;
  let recenterCount  = 0;
  let ilHalted       = false;
  let ilHaltedAt     = null;
  let currentMode    = 'MID';
  const modeHours    = { LOW: 0, MID: 0, HIGH: 0 };

  // Track actual cash spent on initial stock purchase (for true ROI)
  const initCashDeployed = xInit * h0.c1 + yInit * h0.c2;

  const swapRecords  = [];
  const equityCurve  = [];

  equityCurve.push({
    date:            h0.date.toISOString(),
    poolValue:       initCashDeployed,
    holdValue:       initCashDeployed,
    cashProfit:      0,
    ilPct:           0,
    correlation:     0,
    dynamicWidthPct: rangeHalf * 100,
    mode:            'MID',
    halted:          false,
  });

  // ── Hour-by-hour loop ───────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1;   // Asset1 price ₹
    const p2  = row.c2;   // Asset2 price ₹
    const p   = p1 / p2;  // current price ratio

    // 1. Volume regime
    const volWin = hourly.slice(Math.max(0, idx - lookbackH), idx).map(h => h.vol);
    currentMode = volMode(row.vol, volWin, sigmaT);
    modeHours[currentMode]++;

    // 2. Rolling correlation of hourly returns
    const corrWin = hourly.slice(Math.max(0, idx - corrLB), idx);
    const corr = pearsonCorr(corrWin.map(h => h.ret1), corrWin.map(h => h.ret2));

    // 3. Dynamic width: lower corr → wider (assets diverge → keep both in range)
    const baseW = currentMode === 'LOW' ? lowW : currentMode === 'HIGH' ? highW : midW;
    const dynW  = clamp(baseW * (1 + corrImpact * (1 - Math.abs(corr))), lowW * 0.4, highW * 3);

    // 4. Should we recenter?
    const drift    = Math.abs(p / centerP - 1);
    const recThresh = dynW * recTrigF;
    const doRecenter = drift >= recThresh && !ilHalted && !(pauseHigh && currentMode === 'HIGH');

    // ── RECENTERING — REAL MARKET REBALANCE ──────────────────────────────────
    // Changing the range means the required x/y ratio changes.
    // We must execute a real stock trade to match the new ratio at the new center.
    // This is NOT free — brokerage applies.
    if (doRecenter) {
      const newPa = p * (1 - dynW);
      const newPb = p * (1 + dynW);

      // Required x/y ratio at center of new range
      const ratio = targetXYRatio(p, newPa, newPb);

      if (ratio !== null) {
        // Current portfolio value in ₹
        const portfolioValue = poolX * p1 + poolY * p2;

        // New target: x_new = ratio * y_new, and x_new*p1 + y_new*p2 = portfolioValue (pre-cost)
        // → y_new = portfolioValue / (ratio*p1 + p2)
        const yNew_f = portfolioValue / (ratio * p1 + p2);
        const xNew_f = ratio * yNew_f;

        // Floor to whole shares
        const xNew = Math.max(0, Math.floor(xNew_f));
        const yNew = Math.max(0, Math.floor(yNew_f));

        // Rebalancing deltas
        const sellX = poolX - xNew;   // > 0 means sell Asset1
        const buyX  = xNew - poolX;   // > 0 means buy  Asset1
        const sellY = poolY - yNew;   // > 0 means sell Asset2
        const buyY  = yNew - poolY;   // > 0 means buy  Asset2

        // Exactly one of (sellX, buyX) and one of (sellY, buyY) will be positive
        // depending on the direction of the range shift
        let recenterBrokerage = 0;
        let recenterProfit    = 0;

        if (sellX > 0 && buyY > 0) {
          // Sell Asset1 to buy Asset2
          const rev  = sellX * p1;
          const cost = buyY  * p2;
          recenterBrokerage = sellBrokerPct * rev + buyBrokerPct * cost;
          recenterProfit    = rev - cost - recenterBrokerage;
          cashProfit     += recenterProfit;
          totalBrokerage += recenterBrokerage;
          poolX = xNew;
          poolY = yNew;

          swapRecords.push({
            date:              row.date.toISOString(),
            mode:              currentMode,
            rollingCorrelation: corr,
            dynamicWidthPct:   dynW * 100,
            recentered:        true,
            isRecenterTrade:   true,
            action:            'RECENTER: Sell Asset1 / Buy Asset2',
            boughtAsset:       'Asset 2',
            boughtQty:         buyY,
            boughtCost:        cost,
            soldAsset:         'Asset 1',
            soldQty:           sellX,
            soldRevenue:       rev,
            grossProfit:       rev - cost,
            brokerageOnBuy:    buyBrokerPct * cost,
            brokerageOnSell:   sellBrokerPct * rev,
            totalBrokerage:    recenterBrokerage,
            netProfit:         recenterProfit,
            cashProfit,
            asset1Price:       p1,
            asset2Price:       p2,
            priceRatio:        p,
            centerRatio:       p,
            poolX,
            poolY,
            poolAssetValue:    poolX * p1 + poolY * p2,
            ilPct:             0,  // filled below
            totalValue:        0,  // filled below
          });

        } else if (buyX > 0 && sellY > 0) {
          // Buy Asset1 to sell Asset2
          const cost = buyX  * p1;
          const rev  = sellY * p2;
          recenterBrokerage = buyBrokerPct * cost + sellBrokerPct * rev;
          recenterProfit    = rev - cost - recenterBrokerage;
          cashProfit     += recenterProfit;
          totalBrokerage += recenterBrokerage;
          poolX = xNew;
          poolY = yNew;

          swapRecords.push({
            date:              row.date.toISOString(),
            mode:              currentMode,
            rollingCorrelation: corr,
            dynamicWidthPct:   dynW * 100,
            recentered:        true,
            isRecenterTrade:   true,
            action:            'RECENTER: Buy Asset1 / Sell Asset2',
            boughtAsset:       'Asset 1',
            boughtQty:         buyX,
            boughtCost:        cost,
            soldAsset:         'Asset 2',
            soldQty:           sellY,
            soldRevenue:       rev,
            grossProfit:       rev - cost,
            brokerageOnBuy:    buyBrokerPct * cost,
            brokerageOnSell:   sellBrokerPct * rev,
            totalBrokerage:    recenterBrokerage,
            netProfit:         recenterProfit,
            cashProfit,
            asset1Price:       p1,
            asset2Price:       p2,
            priceRatio:        p,
            centerRatio:       p,
            poolX,
            poolY,
            poolAssetValue:    poolX * p1 + poolY * p2,
            ilPct:             0,
            totalValue:        0,
          });
        }
        // If deltas are both < 1 share, no rebalance needed; just update range
      }

      // Update range
      centerP   = p;
      rangeHalf = dynW;
      pa = centerP * (1 - rangeHalf);
      pb = centerP * (1 + rangeHalf);

      // Re-derive L from the NEW integer holdings within the NEW range
      L = lFromXY(poolX, poolY, p, pa, pb);
      recenterCount++;

    } else {
      // Not recentering — just update range width, keep center
      rangeHalf = dynW;
      pa = centerP * (1 - rangeHalf);
      pb = centerP * (1 + rangeHalf);
    }

    // ── 5. AMM-dictated target inventory at current price ─────────────────────
    const pC      = clamp(p, pa, pb);
    const xTarget = xFromL(L, pC, pa, pb);
    const yTarget = yFromL(L, pC, pa, pb);

    // Delta in continuous space
    const dxCont = xTarget - poolX;
    const dyCont = yTarget - poolY;

    // ── 6. Whole-share quantities (no fractions) ──────────────────────────────
    // Floor the raw delta to whole shares.
    // BUY side: floor the quantity we need to buy (conservative)
    // SELL side: floor the quantity we need to sell (don't sell more than we bought)
    let boughtQty = 0, soldQty = 0;
    let boughtAsset = '', soldAsset = '';
    let boughtCost = 0, soldRevenue = 0;

    if (dxCont > 0 && dyCont < 0) {
      // Need more X, less Y → BUY Asset1, SELL Asset2
      boughtAsset = 'Asset 1'; soldAsset = 'Asset 2';
      boughtQty   = Math.floor(dxCont);      // whole shares to buy
      soldQty     = Math.floor(-dyCont);     // whole shares to sell
      boughtCost  = boughtQty * p1;
      soldRevenue = soldQty   * p2;
    } else if (dxCont < 0 && dyCont > 0) {
      // Need less X, more Y → SELL Asset1, BUY Asset2
      boughtAsset = 'Asset 2'; soldAsset = 'Asset 1';
      boughtQty   = Math.floor(dyCont);      // whole shares to buy
      soldQty     = Math.floor(-dxCont);     // whole shares to sell
      boughtCost  = boughtQty * p2;
      soldRevenue = soldQty   * p1;
    }

    // ── 7. Execute only if both legs ≥ 1 share and net profit > 0 ─────────────
    let tradeExecuted = false;
    let grossProfit   = 0;
    let brokerageOnBuy  = 0;
    let brokerageOnSell = 0;
    let brokerage     = 0;
    let netProfit     = 0;
    let action        = '';

    if (!ilHalted && !(pauseHigh && currentMode === 'HIGH') &&
        boughtQty >= 1 && soldQty >= 1) {

      grossProfit   = soldRevenue - boughtCost;
      brokerageOnBuy  = buyBrokerPct  * boughtCost;
      brokerageOnSell = sellBrokerPct * soldRevenue;
      brokerage     = brokerageOnBuy + brokerageOnSell;
      netProfit     = grossProfit - brokerage;

      if (netProfit > 0) {
        cashProfit     += netProfit;
        totalBrokerage += brokerage;

        // Update integer pool inventory
        // DUST CONTROL: after updating, store only the floor.
        // The fractional remainder from the continuous AMM is discarded here.
        if (boughtAsset === 'Asset 1') {
          poolX = Math.floor(poolX + boughtQty);
          poolY = Math.floor(poolY - soldQty);
        } else {
          poolY = Math.floor(poolY + boughtQty);
          poolX = Math.floor(poolX - soldQty);
        }

        // Re-derive L from new integer holdings to keep the invariant clean
        L = lFromXY(poolX, poolY, clamp(p, pa, pb), pa, pb);

        action = `Buy ${boughtAsset} / Sell ${soldAsset}`;
        tradeExecuted = true;
      }
    }

    // ── 8. Impermanent loss ───────────────────────────────────────────────────
    const poolAssetValue = poolX * p1 + poolY * p2;
    const holdValue      = xInit * p1 + yInit * p2;
    const ilINR          = poolAssetValue - holdValue;
    // IL% vs hold — negative = LP did worse than holding
    const ilPct = holdValue > 0 ? (poolAssetValue / holdValue - 1) * 100 : 0;

    // ── 9. IL stop-loss ───────────────────────────────────────────────────────
    if (!ilHalted && ilStopLossPct > 0 && ilPct < -ilStopLossPct) {
      ilHalted   = true;
      ilHaltedAt = row.date.toISOString();
    }

    // ── 10. Record swap ────────────────────────────────────────────────────────
    if (tradeExecuted) {
      const lastRec = swapRecords[swapRecords.length - 1];
      // Patch IL into the recenter record that preceded this (same hour)
      if (lastRec && lastRec.isRecenterTrade && lastRec.ilPct === 0) {
        lastRec.ilPct      = ilPct;
        lastRec.totalValue = poolAssetValue + cashProfit;
      }

      swapRecords.push({
        date:              row.date.toISOString(),
        mode:              currentMode,
        rollingCorrelation: corr,
        dynamicWidthPct:   dynW * 100,
        recentered:        doRecenter,
        isRecenterTrade:   false,
        action,
        boughtAsset,
        boughtQty,         // integer shares bought
        boughtCost,        // ₹ cost of buy leg
        soldAsset,
        soldQty,           // integer shares sold
        soldRevenue,       // ₹ revenue of sell leg
        grossProfit,
        brokerageOnBuy,
        brokerageOnSell,
        totalBrokerage:    brokerage,
        netProfit,
        cashProfit,
        asset1Price:       p1,
        asset2Price:       p2,
        priceRatio:        p,
        centerRatio:       centerP,
        poolX,             // integer Asset1 held
        poolY,             // integer Asset2 held
        poolAssetValue,
        ilINR,
        ilPct,
        totalValue:        poolAssetValue + cashProfit,
      });
    } else if (doRecenter && swapRecords.length > 0) {
      // Patch IL into the recenter record even when no swap followed
      const lastRec = swapRecords[swapRecords.length - 1];
      if (lastRec && lastRec.isRecenterTrade && lastRec.ilPct === 0) {
        lastRec.ilPct      = ilPct;
        lastRec.totalValue = poolAssetValue + cashProfit;
      }
    }

    // ── 11. Equity curve ──────────────────────────────────────────────────────
    equityCurve.push({
      date:            row.date.toISOString(),
      poolValue:       poolAssetValue + cashProfit,
      holdValue,
      cashProfit,
      ilPct,
      correlation:     corr,
      dynamicWidthPct: dynW * 100,
      mode:            currentMode,
      halted:          ilHalted,
    });
  }

  // ── Final metrics ────────────────────────────────────────────────────────────
  const last       = hourly[hourly.length - 1];
  const holdValue  = xInit * last.c1 + yInit * last.c2;
  const poolAssets = poolX * last.c1 + poolY * last.c2;
  const totalValue = poolAssets + cashProfit;
  const ilINR      = poolAssets - holdValue;
  const ilPct      = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const roiPct     = initCashDeployed > 0 ? (totalValue / initCashDeployed - 1) * 100 : 0;
  const holdRoiPct = initCashDeployed > 0 ? (holdValue  / initCashDeployed - 1) * 100 : 0;
  const cashRoiPct = initCashDeployed > 0 ? cashProfit  / initCashDeployed * 100 : 0;
  const brokerageRoiPct = initCashDeployed > 0 ? totalBrokerage / initCashDeployed * 100 : 0;

  return {
    swaps: swapRecords,
    equityCurve,
    results: {
      initCashDeployed,
      totalValue,
      poolAssets,
      holdValue,
      cashProfit,
      totalBrokerage,
      roiPct,
      holdRoiPct,
      cashRoiPct,
      brokerageRoiPct,
      ilINR,
      ilPct,
      ilHalted,
      ilHaltedAt,
      totalSwaps:     swapRecords.filter(s => !s.isRecenterTrade).length,
      recenterTrades: swapRecords.filter(s =>  s.isRecenterTrade).length,
      recenterCount,
      buyBrokeragePct:  buyBrokerPct  * 100,
      sellBrokeragePct: sellBrokerPct * 100,
      initialX: xInit,
      initialY: yInit,
      finalX:   poolX,
      finalY:   poolY,
      lowModeHours:  modeHours.LOW,
      midModeHours:  modeHours.MID,
      highModeHours: modeHours.HIGH,
    },
  };
}
