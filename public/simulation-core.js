// simulation-core.js  — AMM Volatility Harvesting Backtester v5
// ═══════════════════════════════════════════════════════════════════════════════
//
//  POOL MODEL: simple constant-product  x · y = k
//  (NOT Uniswap V3 concentrated liquidity — this is a self-managed pool)
//
//  TRADE MECHANICS — exactly as described:
//    Each hour the external market moves, shifting p1/p2.
//    The pool's internal "fair price" is  p_pool = y/x  (Asset2 per Asset1).
//    When the external ratio diverges from the pool ratio, an arbitrage swap
//    is available.  We simulate it with two simultaneous NSE market orders:
//
//    CASE A — external p1 rose relative to p2  (pool has "too much" Asset1):
//      1. BUY  Δx whole shares of Asset1 from NSE market   cost  = Δx · p1
//      2. Pool now has (x+Δx) Asset1; AMM gives back Δy Asset2
//         where Δy = y − k/(x+Δx)                (constant-product law)
//      3. SELL Δy whole shares of Asset2 to NSE market      rev   = Δy · p2
//      Profit = rev − cost − brok_buy − brok_sell
//      Execute only if profit > 0
//
//    CASE B — external p2 rose relative to p1  (pool has "too much" Asset2):
//      1. BUY  Δy whole shares of Asset2 from NSE market   cost  = Δy · p2
//      2. Pool now has (y+Δy) Asset2; AMM gives back Δx Asset1
//         where Δx = x − k/(y+Δy)                (constant-product law)
//      3. SELL Δx whole shares of Asset1 to NSE market      rev   = Δx · p1
//      Profit = rev − cost − brok_buy − brok_sell
//      Execute only if profit > 0
//
//  CONCENTRATED RANGE:
//    We only trade while the price ratio stays within ±width% of the center.
//    Outside the range we pause (or recenter if enabled).
//    This is modelled as a GATE — not V3 math — because V3 is for permissionless
//    pools.  In our self-managed pool the concentration is a policy decision.
//
//  RECENTERING:
//    When price drifts beyond the range, optionally recenter at a cost:
//    The pool's x/y ratio must match the new center price, so we execute
//    one rebalancing market trade (buy the deficit asset, sell the excess).
//    Brokerage is charged on this rebalancing trade too.
//
//  INVENTORY ACCOUNTING  (no leakages):
//    • Pool holds only INTEGER shares (floor at purchase).
//    • After buying Δx and releasing Δy, we update:
//        x_new = x + Δx_floor
//        y_new = y − Δy_floor   (Δy derived from constant-product with integer Δx)
//        k_new = x_new · y_new  (k is re-derived, not assumed constant)
//    • The tiny mismatch from integer rounding is absorbed into k, not into
//      phantom cash. This is the correct approach for a discrete pool.
//
//  IL CALCULATION:
//    IL% = (poolAssetValue / holdValue − 1) × 100
//    where holdValue = xInit · p1 + yInit · p2 (buy-and-hold baseline)
//    This is pure IL from the AMM rebalancing, separate from cash profit.
//
// ═══════════════════════════════════════════════════════════════════════════════

export function splitCsvLine(line) {
  const cells = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i+1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur); return cells;
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
    .map(r => ({ date: new Date(r.date), close: +r.close, volume: +r.volume }))
    .filter(r => !isNaN(r.date) && isFinite(r.close) && r.close > 0 && isFinite(r.volume))
    .sort((a, b) => a.date - b.date);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function mean(a) { return a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0; }
function stdDev(a, m) {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length);
}
function pearsonCorr(a, b) {
  if (a.length < 2 || a.length !== b.length) return 0;
  const ma=mean(a), mb=mean(b);
  let n=0,va=0,vb=0;
  for (let i=0;i<a.length;i++){const da=a[i]-ma,db=b[i]-mb;n+=da*db;va+=da*da;vb+=db*db;}
  const d=Math.sqrt(va*vb); return d>0?n/d:0;
}
function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}

// ─── 1-minute → hourly ───────────────────────────────────────────────────────
function hourKey(date){const d=new Date(date);d.setMinutes(0,0,0);return d.toISOString();}

function mergeAndBucket(a1, a2) {
  // merge on exact timestamp, then bucket to hourly last-close
  const map = new Map();
  let i=0, j=0;
  while (i<a1.length && j<a2.length) {
    const t1=a1[i].date.getTime(), t2=a2[j].date.getTime();
    if (t1===t2) {
      const key = hourKey(a1[i].date);
      if (!map.has(key)) map.set(key, {date:new Date(key),c1:a1[i].close,c2:a2[j].close,vol:0});
      const b=map.get(key);
      b.c1=a1[i].close; b.c2=a2[j].close; b.vol+=a1[i].volume+a2[j].volume;
      i++; j++;
    } else if (t1<t2) i++; else j++;
  }
  const arr=[...map.values()].sort((a,b)=>a.date-b.date);
  for (let k=0;k<arr.length;k++){
    arr[k].ret1 = k===0?0:arr[k].c1/arr[k-1].c1-1;
    arr[k].ret2 = k===0?0:arr[k].c2/arr[k-1].c2-1;
  }
  return arr;
}

// ─── Volume regime ────────────────────────────────────────────────────────────
function volMode(vol, win, sigma) {
  if (!win.length) return 'MID';
  const avg=mean(win), sd=stdDev(win,avg), band=sigma*sd;
  if (vol < avg-band) return 'LOW';
  if (vol > avg+band) return 'HIGH';
  return 'MID';
}

// ─── Core AMM math (constant product x·y=k) ──────────────────────────────────
//
// Given current pool (x, y) with k = x·y:
// External prices p1 (Asset1), p2 (Asset2).
//
// Target pool state where internal price matches external:
//   y_new/x_new = p1/p2   and   x_new·y_new = k
//   ⟹  x_new = sqrt(k·p2/p1)
//       y_new = sqrt(k·p1/p2)
//
// This gives the CONTINUOUS target.  We then floor to integers and
// apply the constant-product law to get the exact integer Δ:
//
//  If x_new > x  (need more Asset1 in pool):
//    Δx_buy = floor(x_new - x)                   ← buy this from market
//    x_after = x + Δx_buy                         ← pool absorbs
//    Δy_out  = floor(y - k / x_after)             ← pool releases this (law)
//    y_after = y - Δy_out
//
//  If x_new < x  (need less Asset1 in pool):
//    Δy_buy = floor(y_new - y)                    ← buy Asset2 from market
//    y_after = y + Δy_buy                          ← pool absorbs
//    Δx_out  = floor(x - k / y_after)             ← pool releases Asset1
//    x_after = x - Δx_out

function computeSwap(x, y, p1, p2) {
  const k = x * y;
  const xTarget = Math.sqrt(k * p2 / p1);
  const yTarget = Math.sqrt(k * p1 / p2);
  const dx = xTarget - x;  // + → buy Asset1; − → sell Asset1
  const dy = yTarget - y;  // opposite sign of dx

  if (dx >= 0.5 && dy <= -0.5) {
    // CASE A: Buy Asset1 (Δx), AMM releases Asset2 (Δy)
    const dxBuy = Math.floor(dx);                       // integer shares to buy
    if (dxBuy < 1) return null;
    const xAfter = x + dxBuy;
    const dyOut  = Math.floor(y - k / xAfter);         // integer shares released
    if (dyOut < 1) return null;
    const yAfter = y - dyOut;
    return {
      direction: 'BUY1_SELL2',
      dxBuy, dyOut,
      xAfter, yAfter,
      cost:    dxBuy * p1,
      revenue: dyOut * p2,
    };
  }

  if (dy >= 0.5 && dx <= -0.5) {
    // CASE B: Buy Asset2 (Δy), AMM releases Asset1 (Δx)
    const dyBuy = Math.floor(dy);                       // integer shares to buy
    if (dyBuy < 1) return null;
    const yAfter = y + dyBuy;
    const dxOut  = Math.floor(x - k / yAfter);         // integer shares released
    if (dxOut < 1) return null;
    const xAfter = x - dxOut;
    return {
      direction: 'BUY2_SELL1',
      dyBuy, dxOut,
      xAfter, yAfter,
      cost:    dyBuy * p2,
      revenue: dxOut * p1,
    };
  }

  return null; // price move too small for integer trade
}

// ─── Main simulation ──────────────────────────────────────────────────────────
export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);
  if (!asset1.length || !asset2.length)
    return { error: 'Both CSV files must contain valid date, close, and volume columns.' };

  const hourly = mergeAndBucket(asset1, asset2);
  if (hourly.length < 2)
    return { error: 'No overlapping timestamps found, or fewer than 2 hourly buckets. Check that both CSVs cover the same trading period.' };

  // ── Config ──────────────────────────────────────────────────────────────────
  const lowW          = clamp(+( config.lowWidth          ?? 0.75), 0.05, 50) / 100;
  const midW          = clamp(+( config.midWidth          ?? 2),    0.05, 50) / 100;
  const highW         = clamp(+( config.highWidth         ?? 5),    0.05, 50) / 100;
  const sigmaT        = +( config.sigmaThreshold           ?? 1);
  const lookbackH     = Math.max(2, +( config.lookbackHours        ?? 24));
  const corrLB        = Math.max(2, +( config.corrLookbackHours    ?? 24));
  const corrImpact    = clamp(+( config.correlationImpact  ?? 0.6), 0, 2);
  const recTrigF      = clamp(+( config.recenterTriggerPct ?? 75) / 100, 0.05, 2);
  const buyBrok       = clamp(+( config.buyBrokeragePct    ?? 0.15), 0, 5) / 100;
  const sellBrok      = clamp(+( config.sellBrokeragePct   ?? 0.15), 0, 5) / 100;
  const pauseHigh     = !!config.pauseHighVol;
  const ilStopLoss    = clamp(+( config.ilStopLossPct      ?? 0), 0, 100); // %
  const recenterOn    = config.recenterEnabled !== false; // default true

  // ── Pool initialisation ──────────────────────────────────────────────────────
  const h0   = hourly[0];
  const p1_0 = h0.c1, p2_0 = h0.c2;

  // Integer share allocation — floor to avoid sub-share purchases
  const xInit = Math.floor(realCapital / 2 / p1_0);
  const yInit = Math.floor(realCapital / 2 / p2_0);
  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low: cannot purchase even 1 whole share of each asset.' };

  let x = xInit, y = yInit;      // pool inventory (always integers)
  let k = x * y;                  // constant product (re-derived after each trade)

  // Initial center ratio and range
  let centerRatio = p1_0 / p2_0;  // in (Asset2 per Asset1) terms
  let curWidth    = midW;          // current half-width fraction

  // Running totals
  let cashProfit     = 0;
  let totalBrokerage = 0;
  let totalSwaps     = 0;
  let recenterCount  = 0;
  let recenterSwaps  = 0;
  let ilHalted       = false;
  let ilHaltedAt     = null;
  let currentMode    = 'MID';
  const modeHours    = { LOW: 0, MID: 0, HIGH: 0 };

  const initCashDeployed = xInit * p1_0 + yInit * p2_0;
  const swapRecords = [];
  const equityCurve = [];

  equityCurve.push({
    date: h0.date.toISOString(), poolValue: initCashDeployed,
    holdValue: initCashDeployed, cashProfit: 0, ilPct: 0,
    correlation: 0, dynamicWidthPct: curWidth * 100, mode: 'MID', halted: false,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1, p2 = row.c2;
    const extRatio = p1 / p2;   // external price ratio (Asset2 per Asset1... wait:
    // p1 is Asset1 price in ₹, p2 is Asset2 price in ₹
    // extRatio = p1/p2 means "how many Asset2 units equal 1 Asset1 unit in value"
    // This is NOT the same as the pool's y/x ratio.
    // Pool internal price: 1 Asset1 costs y/x Asset2 shares
    // External price: 1 Asset1 worth (p1/p2) Asset2 shares ✓

    // 1. Volume regime
    const volWin = hourly.slice(Math.max(0,idx-lookbackH), idx).map(h=>h.vol);
    currentMode = volMode(row.vol, volWin, sigmaT);
    modeHours[currentMode]++;

    // 2. Rolling correlation
    const corrWin = hourly.slice(Math.max(0,idx-corrLB), idx);
    const corr = pearsonCorr(corrWin.map(h=>h.ret1), corrWin.map(h=>h.ret2));

    // 3. Dynamic width (correlation-adjusted)
    //    Low corr → stocks diverge more → widen range
    //    High corr → move together → tighten
    const baseW = currentMode==='LOW' ? lowW : currentMode==='HIGH' ? highW : midW;
    const dynW  = clamp(baseW * (1 + corrImpact*(1-Math.abs(corr))), lowW*0.4, highW*3);
    curWidth    = dynW;

    // 4. Check if price is within active range
    const drift    = Math.abs(extRatio / centerRatio - 1);
    const rangeMax = dynW * recTrigF;   // fraction of half-width before recenter
    const inRange  = drift <= dynW;     // within the concentration band

    // ── 4a. Handle out-of-range (recenter or skip) ───────────────────────────
    let didRecenter = false;

    if (!inRange && !ilHalted) {
      if (recenterOn && !(pauseHigh && currentMode === 'HIGH')) {
        // Rebalance pool to match new center (p1_new/p2_new = extRatio)
        // Target: y_new/x_new = p1/p2, x_new*y_new = k
        const xTarget_f = Math.sqrt(k * p2 / p1);
        const yTarget_f = Math.sqrt(k * p1 / p2);
        const dx = xTarget_f - x;
        const dy = yTarget_f - y;

        let recSwap = null;
        if (dx >= 0.5 && dy <= -0.5) {
          const dxB = Math.floor(dx); if (dxB >= 1) {
            const xA = x+dxB, dyO = Math.floor(y - k/xA);
            if (dyO >= 1) recSwap = {dir:'BUY1_SELL2', dxBuy:dxB, dyOut:dyO, xA, yA:y-dyO, cost:dxB*p1, rev:dyO*p2};
          }
        } else if (dy >= 0.5 && dx <= -0.5) {
          const dyB = Math.floor(dy); if (dyB >= 1) {
            const yA = y+dyB, dxO = Math.floor(x - k/yA);
            if (dxO >= 1) recSwap = {dir:'BUY2_SELL1', dyBuy:dyB, dxOut:dxO, xA:x-dxO, yA, cost:dyB*p2, rev:dxO*p1};
          }
        }

        if (recSwap) {
          const gross = recSwap.rev - recSwap.cost;
          const brok  = buyBrok*recSwap.cost + sellBrok*recSwap.rev;
          const net   = gross - brok;
          // Always execute recenter (even if net < 0) to keep pool aligned
          cashProfit     += net;
          totalBrokerage += brok;
          x = recSwap.xA; y = recSwap.yA; k = x*y;
          recenterSwaps++;

          const poolVal = x*p1 + y*p2;
          const holdVal = xInit*p1 + yInit*p2;
          const ilPct   = holdVal>0 ? (poolVal/holdVal-1)*100 : 0;

          const action = recSwap.dir==='BUY1_SELL2'
            ? 'RECENTER: Buy Asset1 / Sell Asset2'
            : 'RECENTER: Buy Asset2 / Sell Asset1';
          const boughtAsset = recSwap.dir==='BUY1_SELL2' ? 'Asset 1' : 'Asset 2';
          const soldAsset   = recSwap.dir==='BUY1_SELL2' ? 'Asset 2' : 'Asset 1';
          const boughtQty   = recSwap.dir==='BUY1_SELL2' ? recSwap.dxBuy : recSwap.dyBuy;
          const soldQty     = recSwap.dir==='BUY1_SELL2' ? recSwap.dyOut : recSwap.dxOut;

          swapRecords.push({
            date: row.date.toISOString(), mode: currentMode,
            rollingCorrelation: corr, dynamicWidthPct: dynW*100,
            isRecenter: true, action,
            boughtAsset, boughtQty, boughtCost: recSwap.cost,
            soldAsset, soldQty, soldRevenue: recSwap.rev,
            grossProfit: gross, brokerageOnBuy: buyBrok*recSwap.cost,
            brokerageOnSell: sellBrok*recSwap.rev, totalBrokerage: brok,
            netProfit: net, cashProfit,
            asset1Price: p1, asset2Price: p2,
            poolX: x, poolY: y, poolAssetValue: poolVal, ilPct,
            totalValue: poolVal + cashProfit,
          });
        }
        centerRatio = extRatio;
        recenterCount++;
        didRecenter = true;
      } else {
        // Pause — skip trade, optionally still update center
        // (do nothing; pool stays as-is)
      }
    }

    // ── 4b. Regular swap (in-range hours) ────────────────────────────────────
    if (inRange && !ilHalted && !(pauseHigh && currentMode==='HIGH')) {
      const swap = computeSwap(x, y, p1, p2);
      if (swap) {
        const gross = swap.revenue - swap.cost;
        const brok  = buyBrok*swap.cost + sellBrok*swap.revenue;
        const net   = gross - brok;

        if (net > 0) {
          cashProfit     += net;
          totalBrokerage += brok;
          x = swap.xAfter; y = swap.yAfter; k = x*y;
          totalSwaps++;

          const boughtAsset = swap.direction==='BUY1_SELL2' ? 'Asset 1' : 'Asset 2';
          const soldAsset   = swap.direction==='BUY1_SELL2' ? 'Asset 2' : 'Asset 1';
          const boughtQty   = swap.direction==='BUY1_SELL2' ? swap.dxBuy : swap.dyBuy;
          const soldQty     = swap.direction==='BUY1_SELL2' ? swap.dyOut : swap.dxOut;
          const action      = `Buy ${boughtAsset} / Sell ${soldAsset}`;

          const poolVal = x*p1 + y*p2;
          const holdVal = xInit*p1 + yInit*p2;
          const ilPct   = holdVal>0 ? (poolVal/holdVal-1)*100 : 0;

          swapRecords.push({
            date: row.date.toISOString(), mode: currentMode,
            rollingCorrelation: corr, dynamicWidthPct: dynW*100,
            isRecenter: false, action,
            boughtAsset, boughtQty, boughtCost: swap.cost,
            soldAsset, soldQty, soldRevenue: swap.revenue,
            grossProfit: gross, brokerageOnBuy: buyBrok*swap.cost,
            brokerageOnSell: sellBrok*swap.revenue, totalBrokerage: brok,
            netProfit: net, cashProfit,
            asset1Price: p1, asset2Price: p2,
            poolX: x, poolY: y, poolAssetValue: poolVal, ilPct,
            totalValue: poolVal + cashProfit,
          });

          // IL stop-loss check
          if (!ilHalted && ilStopLoss > 0 && ilPct < -ilStopLoss) {
            ilHalted = true; ilHaltedAt = row.date.toISOString();
          }
        }
      }
    }

    // ── Equity curve ──────────────────────────────────────────────────────────
    const poolVal = x*p1 + y*p2;
    const holdVal = xInit*p1 + yInit*p2;
    const ilPct   = holdVal>0 ? (poolVal/holdVal-1)*100 : 0;
    if (!ilHalted && ilStopLoss > 0 && ilPct < -ilStopLoss) {
      ilHalted = true; ilHaltedAt = row.date.toISOString();
    }
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: poolVal + cashProfit, holdValue: holdVal,
      cashProfit, ilPct,
      correlation: corr, dynamicWidthPct: dynW*100,
      mode: currentMode, halted: ilHalted,
    });
  }

  // ── Final metrics ────────────────────────────────────────────────────────────
  const last     = hourly[hourly.length-1];
  const holdVal  = xInit*last.c1 + yInit*last.c2;
  const poolVal  = x*last.c1 + y*last.c2;
  const totVal   = poolVal + cashProfit;
  const ilINR    = poolVal - holdVal;
  const ilPct    = holdVal>0 ? (poolVal/holdVal-1)*100 : 0;
  const roiPct   = initCashDeployed>0 ? (totVal/initCashDeployed-1)*100 : 0;
  const holdRoi  = initCashDeployed>0 ? (holdVal/initCashDeployed-1)*100 : 0;
  const cashRoi  = initCashDeployed>0 ? cashProfit/initCashDeployed*100 : 0;
  const brokRoi  = initCashDeployed>0 ? totalBrokerage/initCashDeployed*100 : 0;

  return {
    swaps: swapRecords,
    equityCurve,
    results: {
      initCashDeployed, totalValue: totVal, poolAssets: poolVal,
      holdValue: holdVal, cashProfit, totalBrokerage,
      roiPct, holdRoi, cashRoi, brokRoi,
      ilINR, ilPct, ilHalted, ilHaltedAt,
      totalSwaps, recenterSwaps, recenterCount,
      buyBrokeragePct: buyBrok*100, sellBrokeragePct: sellBrok*100,
      initialX: xInit, initialY: yInit, finalX: x, finalY: y,
      lowModeHours: modeHours.LOW, midModeHours: modeHours.MID,
      highModeHours: modeHours.HIGH,
    },
  };
}
