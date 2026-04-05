// simulation-core.js — AMM Volatility Harvesting Backtester v3
//
// ═══════════════════════════════════════════════════════════════════════════════
// HOW THE REAL TRADE WORKS (Indian stock market context)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Stocks cannot be transferred between demats instantly, so we SIMULATE a swap
// using simultaneous buy + sell orders:
//
//  SCENARIO A — "Price of Asset1 rose relative to Asset2":
//    AMM wants more Asset2, less Asset1.
//    → BUY  Δx units of Asset1 from the open market  (cash out: Δx × p1)
//    → AMM equation gives us Δy units of Asset2 to release
//    → SELL Δy units of Asset2 to the open market     (cash in:  Δy × p2)
//    → Gross profit = (Δy × p2) − (Δx × p1)
//    → Brokerage    = feeRate × (Δx × p1 + Δy × p2)   [0.3% on total notional]
//    → Net profit   = Gross profit − Brokerage
//    → Only execute if net profit > 0
//
//  SCENARIO B — "Price of Asset2 rose relative to Asset1":
//    AMM wants more Asset1, less Asset2.
//    → BUY  Δy units of Asset2 from the open market  (cash out: Δy × p2)
//    → AMM equation gives us Δx units of Asset1 to release
//    → SELL Δx units of Asset1 to the open market     (cash in:  Δx × p1)
//    → Gross profit = (Δx × p1) − (Δy × p2)
//    → Brokerage    = feeRate × (Δx × p1 + Δy × p2)
//    → Net profit   = Gross profit − Brokerage
//    → Only execute if net profit > 0
//
// The pool inventory (x units of Asset1, y units of Asset2) is updated only
// when a trade executes. All net profits accumulate as cash.
//
// IL STOP-LOSS: If impermanent loss (pool asset value vs hold value) drops
// below −ilStopLossPct%, all new swaps are suspended for the rest of the run.
//
// DYNAMIC CONCENTRATION: Range width is widened when correlation drops
// (assets diverge) and tightened when correlation is high (move together).
//
// DYNAMIC RECENTERING: When the price ratio drifts beyond recenterTrigger×width
// from the center, the pool center is reset to the current price.
// ═══════════════════════════════════════════════════════════════════════════════

export function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else { quoted = !quoted; }
    } else if (ch === ',' && !quoted) {
      cells.push(current); current = '';
    } else { current += ch; }
  }
  cells.push(current);
  return cells;
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((v) => v.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return headers.reduce((row, h, i) => { row[h] = (cells[i] || '').trim(); return row; }, {});
  });
}

export function normalizeRows(rows) {
  return rows
    .map((row) => ({
      date:   new Date(row.date),
      close:  Number(row.close),
      volume: Number(row.volume),
    }))
    .filter((row) =>
      !Number.isNaN(row.date.getTime()) &&
      Number.isFinite(row.close) && row.close > 0 &&
      Number.isFinite(row.volume))
    .sort((a, b) => a.date - b.date);
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stdDev(arr, avg) {
  if (arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
}

function pearsonCorr(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  const ma = mean(a), mb = mean(b);
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    num += da * db; va += da * da; vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom > 0 ? num / denom : 0;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── 1-minute → hourly merge ──────────────────────────────────────────────────

function hourKey(date) {
  const d = new Date(date); d.setMinutes(0, 0, 0); return d.toISOString();
}

function mergeMinutely(a1, a2) {
  const merged = [];
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) {
      merged.push({ date: a1[i].date, c1: a1[i].close, c2: a2[j].close, v1: a1[i].volume, v2: a2[j].volume });
      i++; j++;
    } else if (t1 < t2) { i++; } else { j++; }
  }
  return merged;
}

function toHourly(merged) {
  const map = new Map();
  for (const row of merged) {
    const key = hourKey(row.date);
    if (!map.has(key)) map.set(key, { date: new Date(key), c1: row.c1, c2: row.c2, vol: 0 });
    const b = map.get(key);
    b.c1 = row.c1; b.c2 = row.c2;          // last-price-of-hour
    b.vol += row.v1 + row.v2;
  }
  const arr = [...map.values()].sort((a, b) => a.date - b.date);
  for (let k = 0; k < arr.length; k++) {
    arr[k].ret1 = k === 0 ? 0 : arr[k].c1 / arr[k - 1].c1 - 1;
    arr[k].ret2 = k === 0 ? 0 : arr[k].c2 / arr[k - 1].c2 - 1;
  }
  return arr;
}

// ─── Volume regime ────────────────────────────────────────────────────────────

function volMode(vol, window, sigma) {
  if (!window.length) return 'MID';
  const avg = mean(window), sd = stdDev(window, avg), band = sigma * sd;
  if (vol < avg - band) return 'LOW';
  if (vol > avg + band) return 'HIGH';
  return 'MID';
}

// ─── Uniswap V3 concentrated liquidity ───────────────────────────────────────
//
// We track the virtual pool as a standard V3 pool.
// Price p = p1 / p2  (asset2 units per 1 asset1).
// Range [pa, pb].
//
// x = L · (1/√p  − 1/√pb)   (asset1 inventory)
// y = L · (√p    − √pa )    (asset2 inventory)
//
// These give us the AMM-dictated inventory at any price.
// The DIFFERENCE from the previous hour is the actual trade we execute.

function amountsFromL(L, p, pa, pb) {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  if (p <= pa) return { x: L * (1 / spa - 1 / spb), y: 0 };
  if (p >= pb) return { x: 0, y: L * (spb - spa) };
  return { x: L * (1 / sp - 1 / spb), y: L * (sp - spa) };
}

function liquidityFromAmounts(x, y, p, pa, pb) {
  const sp = Math.sqrt(p), spa = Math.sqrt(pa), spb = Math.sqrt(pb);
  const lx = (1 / sp - 1 / spb) > 1e-14 ? x / (1 / sp - 1 / spb) : Infinity;
  const ly = (sp - spa)          > 1e-14 ? y / (sp - spa)          : Infinity;
  return Math.min(lx, ly);
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
    return { error: 'Need at least two hourly buckets after preprocessing.' };

  // ── Parse config ────────────────────────────────────────────────────────────
  const lowW        = clamp(Number(config.lowWidth           ?? 0.75), 0.05, 50) / 100;
  const midW        = clamp(Number(config.midWidth           ?? 2),    0.05, 50) / 100;
  const highW       = clamp(Number(config.highWidth          ?? 5),    0.05, 50) / 100;
  const sigmaT      = Number(config.sigmaThreshold           ?? 1);
  const lookbackH   = Math.max(2, Number(config.lookbackHours        ?? 24));
  const corrLB      = Math.max(2, Number(config.corrLookbackHours    ?? 24));
  const corrImpact  = clamp(Number(config.correlationImpact  ?? 0.6), 0, 2);
  const recTrigF    = clamp(Number(config.recenterTriggerPct ?? 75) / 100, 0.05, 2);
  const feeRate     = clamp(Number(config.feePct             ?? 0.3), 0, 10) / 100;
  const pauseHigh   = Boolean(config.pauseHighVol            ?? false);
  // IL stop-loss: if IL% drops below −ilStopLoss (e.g. −5%), halt all swaps.
  // 0 = disabled.
  const ilStopLoss  = clamp(Number(config.ilStopLossPct      ?? 0), 0, 100) / 100;

  // ── Initialise pool ─────────────────────────────────────────────────────────
  const h0 = hourly[0];
  const p0 = h0.c1 / h0.c2;   // initial price ratio (p1/p2)

  let centerP   = p0;
  let rangeHalf = midW;
  let pa = centerP * (1 - rangeHalf);
  let pb = centerP * (1 + rangeHalf);

  // Split capital 50/50 by value
  const halfCap = realCapital / 2;
  const xInit   = halfCap / h0.c1;   // asset1 whole-units start
  const yInit   = halfCap / h0.c2;   // asset2 whole-units start

  // Derive liquidity L from initial inventory
  let L = liquidityFromAmounts(xInit, yInit, p0, pa, pb);

  // Pool inventory (fractional units — simulation precision)
  let poolX = xInit;
  let poolY = yInit;

  // Running cash from profitable swaps
  let cashProfit   = 0;
  let totalBrokerage = 0;
  let recenterCount  = 0;
  let ilHalted       = false;   // flag: IL stop-loss triggered
  let ilHaltedAt     = null;    // timestamp when halted
  let currentMode    = 'MID';
  const modeHours    = { LOW: 0, MID: 0, HIGH: 0 };

  const swapRecords = [];
  const equityCurve = [];

  const initCapital = xInit * h0.c1 + yInit * h0.c2;

  equityCurve.push({
    date:            h0.date.toISOString(),
    poolValue:       initCapital,
    holdValue:       initCapital,
    cashProfit:      0,
    ilPct:           0,
    correlation:     0,
    dynamicWidthPct: rangeHalf * 100,
    mode:            'MID',
    halted:          false,
  });

  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1;         // asset1 price in ₹
    const p2  = row.c2;         // asset2 price in ₹
    const p   = p1 / p2;        // price ratio

    // ── 1. Volume regime ────────────────────────────────────────────────────
    const volWin = hourly.slice(Math.max(0, idx - lookbackH), idx).map((h) => h.vol);
    currentMode = volMode(row.vol, volWin, sigmaT);
    modeHours[currentMode] += 1;

    // ── 2. Rolling correlation ──────────────────────────────────────────────
    const corrWin = hourly.slice(Math.max(0, idx - corrLB), idx);
    const corr = pearsonCorr(
      corrWin.map((h) => h.ret1),
      corrWin.map((h) => h.ret2),
    );

    // ── 3. Dynamic width (correlation-adjusted) ─────────────────────────────
    // Lower corr → widen (assets diverge, need wider range to stay in-range)
    // Higher corr → tighten (capital efficiency)
    const baseW = currentMode === 'LOW' ? lowW : currentMode === 'HIGH' ? highW : midW;
    const dynW  = clamp(baseW * (1 + corrImpact * (1 - Math.abs(corr))), lowW * 0.4, highW * 3);

    // ── 4. Recentering ──────────────────────────────────────────────────────
    const drift = Math.abs(p / centerP - 1);
    const recThresh = dynW * recTrigF;
    let recentered = false;

    if (drift >= recThresh && !(pauseHigh && currentMode === 'HIGH') && !ilHalted) {
      // Snap current inventory to what the V3 math says at the old range
      const snap = amountsFromL(L, clamp(p, pa, pb), pa, pb);
      poolX = snap.x; poolY = snap.y;

      centerP   = p;
      rangeHalf = dynW;
      pa = centerP * (1 - rangeHalf);
      pb = centerP * (1 + rangeHalf);

      L = liquidityFromAmounts(poolX, poolY, p, pa, pb);
      recenterCount++;
      recentered = true;
    } else {
      rangeHalf = dynW;
      pa = centerP * (1 - rangeHalf);
      pb = centerP * (1 + rangeHalf);
    }

    // ── 5. AMM-dictated inventory at current price ──────────────────────────
    const pClamped = clamp(p, pa, pb);
    const { x: targetX, y: targetY } = amountsFromL(L, pClamped, pa, pb);

    // ── 6. Determine trade direction and size ───────────────────────────────
    //
    // The AMM tells us where inventory SHOULD be. The delta is the trade.
    //
    //  targetX > poolX → we need MORE asset1 → BUY asset1, SELL asset2
    //    BUY  (targetX − poolX) units of asset1  → spend (dx × p1)
    //    SELL (poolY − targetY) units of asset2  → earn  (dy × p2)
    //    gross = (dy × p2) − (dx × p1)
    //
    //  targetX < poolX → we need LESS asset1 → SELL asset1, BUY asset2
    //    BUY  (targetY − poolY) units of asset2  → spend (dy × p2)
    //    SELL (poolX − targetX) units of asset1  → earn  (dx × p1)
    //    gross = (dx × p1) − (dy × p2)

    const rawDx = Math.abs(targetX - poolX);
    const rawDy = Math.abs(targetY - poolY);

    let tradeExecuted = false;
    let action        = '';
    let boughtAsset   = '';
    let soldAsset     = '';
    let boughtQty     = 0;
    let soldQty       = 0;
    let boughtCost    = 0;
    let soldRevenue   = 0;
    let grossProfit   = 0;
    let brokerage     = 0;
    let netProfit     = 0;

    // Only trade when not IL-halted, not paused, and there's a real delta
    if (!ilHalted && !(pauseHigh && currentMode === 'HIGH') && rawDx > 1e-9 && rawDy > 1e-9) {

      if (targetX > poolX) {
        // BUY asset1 (dx), SELL asset2 (dy)
        boughtAsset  = 'Asset 1';
        soldAsset    = 'Asset 2';
        boughtQty    = rawDx;
        soldQty      = rawDy;
        boughtCost   = boughtQty * p1;
        soldRevenue  = soldQty   * p2;
      } else {
        // BUY asset2 (dy), SELL asset1 (dx)
        boughtAsset  = 'Asset 2';
        soldAsset    = 'Asset 1';
        boughtQty    = rawDy;
        soldQty      = rawDx;
        boughtCost   = boughtQty * p2;
        soldRevenue  = soldQty   * p1;
      }

      grossProfit = soldRevenue - boughtCost;
      // Brokerage = 0.3% on total notional (buy side + sell side)
      brokerage   = feeRate * (boughtCost + soldRevenue);
      netProfit   = grossProfit - brokerage;

      // Only execute if the swap is actually profitable after brokerage
      if (netProfit > 0) {
        cashProfit     += netProfit;
        totalBrokerage += brokerage;

        // Update pool inventory to AMM-dictated amounts
        poolX = targetX;
        poolY = targetY;

        action = `Buy ${boughtAsset} / Sell ${soldAsset}`;
        tradeExecuted = true;
      }
    }

    // ── 7. Impermanent loss calculation ─────────────────────────────────────
    const poolAssetValue = poolX * p1 + poolY * p2;
    const holdValue      = xInit * p1 + yInit * p2;
    const ilINR          = poolAssetValue - holdValue;
    const ilPct          = holdValue > 0 ? (poolAssetValue / holdValue - 1) * 100 : 0;

    // ── 8. IL stop-loss check ───────────────────────────────────────────────
    if (!ilHalted && ilStopLoss > 0 && ilPct < -ilStopLoss * 100) {
      ilHalted   = true;
      ilHaltedAt = row.date.toISOString();
    }

    // ── 9. Record swap if executed ──────────────────────────────────────────
    if (tradeExecuted) {
      swapRecords.push({
        date:             row.date.toISOString(),
        mode:             currentMode,
        rollingCorrelation: corr,
        dynamicWidthPct:  dynW * 100,
        recentered,
        action,
        boughtAsset,
        soldAsset,
        boughtQty,
        soldQty,
        boughtCost,
        soldRevenue,
        grossProfit,
        brokerage,
        netProfit,
        cashProfit,
        asset1Price:      p1,
        asset2Price:      p2,
        priceRatio:       p,
        centerRatio:      centerP,
        poolX,
        poolY,
        poolAssetValue,
        ilINR,
        ilPct,
        totalValue:       poolAssetValue + cashProfit,
      });
    }

    // ── 10. Equity curve (every hour, traded or not) ─────────────────────────
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
  const last          = hourly[hourly.length - 1];
  const holdValue     = xInit * last.c1 + yInit * last.c2;
  const poolAssets    = poolX * last.c1 + poolY * last.c2;
  const totalValue    = poolAssets + cashProfit;
  const ilINR         = poolAssets - holdValue;
  const ilPct         = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const roiPct        = initCapital > 0 ? (totalValue  / initCapital - 1) * 100 : 0;
  const holdRoiPct    = initCapital > 0 ? (holdValue   / initCapital - 1) * 100 : 0;
  const cashRoiPct    = initCapital > 0 ? cashProfit   / initCapital       * 100 : 0;
  const brokerageRoiPct = initCapital > 0 ? totalBrokerage / initCapital   * 100 : 0;

  return {
    swaps:  swapRecords,
    equityCurve,
    results: {
      // Capital
      initCapital,
      totalValue,
      poolAssets,
      holdValue,
      cashProfit,
      totalBrokerage,
      // Returns
      roiPct,
      holdRoiPct,
      cashRoiPct,
      brokerageRoiPct,
      // IL
      ilINR,
      ilPct,
      ilHalted,
      ilHaltedAt,
      // Trades
      totalSwaps: swapRecords.length,
      recenterCount,
      feePct:      feeRate * 100,
      // Inventory
      initialX: xInit,
      initialY: yInit,
      finalX:   poolX,
      finalY:   poolY,
      // Modes
      lowModeHours:  modeHours.LOW,
      midModeHours:  modeHours.MID,
      highModeHours: modeHours.HIGH,
    },
  };
}
