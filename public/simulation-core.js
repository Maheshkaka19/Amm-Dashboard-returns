// simulation-core.js  — AMM Volatility Harvesting  v6
// Industry-standard Arrakis / Uniswap V3 – style active liquidity management
// ═══════════════════════════════════════════════════════════════════════════════
//
//  POOL MODEL
//  ──────────
//  Constant-product invariant:   x · y = k
//  where x = integer shares of Asset1, y = integer shares of Asset2.
//  k is re-derived after every trade to absorb integer-rounding residuals
//  cleanly (no phantom cash, no dust accumulation).
//
//  CONCENTRATION (Arrakis / Uniswap V3 style)
//  ───────────────────────────────────────────
//  The pool is "active" only while the external price ratio stays within
//  a dynamic band  [center*(1-w), center*(1+w)]  where w is the half-width.
//  • Inside the band  → execute constant-product arbitrage swaps.
//  • Outside the band → trigger a RECENTER event.
//
//  Dynamic half-width w is adjusted each hour by rolling Pearson correlation:
//    w = base_w × (1 + corr_impact × (1 – |corr|))
//  Low correlation → assets diverge more → widen band to reduce recenter churn.
//  High correlation → assets move together → tighten band for more fee capture.
//  Volume regime (LOW/MID/HIGH) sets base_w.
//
//  SWAP MECHANIC (two simultaneous NSE market orders)
//  ────────────────────────────────────────────────────
//  When the external ratio moves inside the band, the pool is out of alignment.
//  We execute:
//    1. BUY  Δ shares of the input asset from NSE market.
//    2. Pool absorbs input → constant-product law gives output qty.
//    3. SELL output shares to NSE market.
//
//  Quantity rounding policy — "nearest, not floor":
//    dxBuy = round(x_target – x)
//    dyOut = round(y – k / (x + dxBuy))     ← derived from k, not approximated
//  This minimises systematic under-participation caused by always flooring.
//  Guard: if rounding pushes dyOut > actual_y we use floor instead (never
//  sell more than we hold).
//
//  Net profit = revenue – cost – buy_brokerage – sell_brokerage
//  Trade executes only if net_profit > 0 AND both quantities ≥ 1 share.
//
//  RECENTER MECHANIC (real market rebalance, brokerage charged)
//  ─────────────────────────────────────────────────────────────
//  When price exits the band:
//    1. New center = current external ratio.
//    2. New target: equal value split (x_new·p1 ≈ y_new·p2 = portfolio_value/2).
//       x_new = round(portfolio_value / 2 / p1)
//       y_new = round(portfolio_value / 2 / p2)
//    3. Execute one rebalancing trade to move from (x,y) to (x_new,y_new).
//       Brokerage charged on both legs.
//       Net P&L added to cashProfit (can be negative — that's real cost).
//    4. k re-derived from new (x_new, y_new).
//
//  NET-ZERO / POSITIVE vs HOLD CONDITIONS
//  ────────────────────────────────────────
//  AMM Total Value = Pool Asset Value + Cash Profit
//  IL = Pool Asset Value – Hold Value  (negative when pool has less than hold)
//  Net vs hold = AMM Total Value – Hold Value
//
//  For net-positive vs hold: cash_profit > |IL|
//  This depends on: frequency of profitable swaps, width, brokerage, pair divergence.
//  With tight width (0.5–2%) + fast recentering + correlated pairs → achievable.
//
//  INSTITUTIONAL SAFEGUARDS
//  ─────────────────────────
//  • Integer-only shares throughout (round-to-nearest with floor guard).
//  • k re-derived from actual holdings after every trade → no ghost liquidity.
//  • Recenter costs are real (brokerage charged, P&L can go negative).
//  • IL stop-loss: halt swaps when IL exceeds threshold.
//  • No trade executed unless net profit > 0 (regular swaps only).
//  • Pool inventory never goes negative (guard on all subtractions).
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

// ─── Statistics ───────────────────────────────────────────────────────────────

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function stdDev(a, m) {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[a.length - n + i] - ma, db = b[b.length - n + i] - mb;
    num += da * db; va += da * da; vb += db * db;
  }
  const d = Math.sqrt(va * vb);
  return d > 0 ? num / d : 0;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── 1-minute → hourly merge ──────────────────────────────────────────────────

function hourKey(date) {
  const d = new Date(date); d.setMinutes(0, 0, 0); return d.toISOString();
}

function buildHourly(a1, a2) {
  const map = new Map();
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) {
      const key = hourKey(a1[i].date);
      if (!map.has(key)) map.set(key, { date: new Date(key), c1: a1[i].close, c2: a2[j].close, vol: 0 });
      const b = map.get(key);
      b.c1 = a1[i].close; b.c2 = a2[j].close;   // last close of the hour
      b.vol += a1[i].volume + a2[j].volume;
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  const arr = [...map.values()].sort((a, b) => a.date - b.date);
  // Compute hourly log-returns for correlation
  for (let k = 0; k < arr.length; k++) {
    arr[k].ret1 = k === 0 ? 0 : arr[k].c1 / arr[k - 1].c1 - 1;
    arr[k].ret2 = k === 0 ? 0 : arr[k].c2 / arr[k - 1].c2 - 1;
  }
  return arr;
}

// ─── Volume regime ────────────────────────────────────────────────────────────

function volMode(vol, window, sigma) {
  if (!window.length) return 'MID';
  const avg = mean(window), sd = stdDev(window, avg);
  if (vol < avg - sigma * sd) return 'LOW';
  if (vol > avg + sigma * sd) return 'HIGH';
  return 'MID';
}

// ─── Core constant-product swap ───────────────────────────────────────────────
//
// Returns null if no profitable integer swap exists.
// Uses round-to-nearest for quantity, with a floor guard to never
// sell more than the pool holds.

function computeSwap(x, y, p1, p2, buyBrok, sellBrok) {
  const k = x * y;
  if (k === 0) return null;

  // Continuous target balances where internal price matches external
  const xTarget = Math.sqrt(k * p2 / p1);
  const yTarget = Math.sqrt(k * p1 / p2);
  const dx = xTarget - x;   // + → buy A1 into pool; − → sell A1 out
  const dy = yTarget - y;   // opposite direction

  if (dx >= 0.5 && dy <= -0.5) {
    // BUY Asset1, pool releases Asset2
    const dxBuy = Math.round(dx);
    if (dxBuy < 1) return null;
    const xAfter = x + dxBuy;
    // dyOut derived strictly from k — not from yTarget (avoids float drift)
    let dyOut = Math.round(y - k / xAfter);
    dyOut = Math.min(dyOut, y - 1);   // guard: keep at least 1 share in pool
    if (dyOut < 1) return null;
    const yAfter = y - dyOut;
    const cost = dxBuy * p1, revenue = dyOut * p2;
    const gross = revenue - cost;
    const brokerage = buyBrok * cost + sellBrok * revenue;
    const netProfit = gross - brokerage;
    return { direction: 'BUY1_SELL2', dxBuy, dyOut, xAfter, yAfter, cost, revenue, gross, brokerage, netProfit };
  }

  if (dy >= 0.5 && dx <= -0.5) {
    // BUY Asset2, pool releases Asset1
    const dyBuy = Math.round(-dy);
    if (dyBuy < 1) return null;
    const yAfter = y + dyBuy;
    let dxOut = Math.round(x - k / yAfter);
    dxOut = Math.min(dxOut, x - 1);   // guard
    if (dxOut < 1) return null;
    const xAfter = x - dxOut;
    const cost = dyBuy * p2, revenue = dxOut * p1;
    const gross = revenue - cost;
    const brokerage = buyBrok * cost + sellBrok * revenue;
    const netProfit = gross - brokerage;
    return { direction: 'BUY2_SELL1', dyBuy, dxOut, xAfter, yAfter, cost, revenue, gross, brokerage, netProfit };
  }

  return null; // price move too small for any integer trade
}

// ─── Recenter rebalance ───────────────────────────────────────────────────────
//
// Rebalances pool to equal-value split at the new center price.
// Target: x_new · p1 ≈ y_new · p2 ≈ portfolio_value / 2
// Uses round-to-nearest for both legs.

function computeRecenterTrade(x, y, p1, p2, buyBrok, sellBrok) {
  const totalVal = x * p1 + y * p2;
  const xNew = Math.max(1, Math.round(totalVal / 2 / p1));
  const yNew = Math.max(1, Math.round(totalVal / 2 / p2));

  const dx = xNew - x;   // + → buy A1; − → sell A1
  const dy = yNew - y;   // + → buy A2; − → sell A2

  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    // Already balanced — just update k
    return { xNew: x, yNew: y, cost: 0, revenue: 0, gross: 0, brokerage: 0, netProfit: 0, noTrade: true };
  }

  let cost = 0, revenue = 0, boughtAsset = '', soldAsset = '', boughtQty = 0, soldQty = 0;

  if (dx > 0 && dy < 0) {
    // Buy A1, sell A2
    boughtAsset = 'Asset 1'; soldAsset = 'Asset 2';
    boughtQty = Math.abs(dx); soldQty = Math.min(Math.abs(dy), y - 1);
    cost = boughtQty * p1; revenue = soldQty * p2;
  } else if (dx < 0 && dy > 0) {
    // Sell A1, buy A2
    boughtAsset = 'Asset 2'; soldAsset = 'Asset 1';
    boughtQty = Math.abs(dy); soldQty = Math.min(Math.abs(dx), x - 1);
    cost = boughtQty * p2; revenue = soldQty * p1;
  } else {
    // Same direction delta (rounding artifact) — skip
    return { xNew: x, yNew: y, cost: 0, revenue: 0, gross: 0, brokerage: 0, netProfit: 0, noTrade: true };
  }

  if (boughtQty < 1 || soldQty < 1) {
    return { xNew: x, yNew: y, cost: 0, revenue: 0, gross: 0, brokerage: 0, netProfit: 0, noTrade: true };
  }

  const gross = revenue - cost;
  const brokerage = buyBrok * cost + sellBrok * revenue;
  const netProfit = gross - brokerage;

  return { xNew, yNew, cost, revenue, gross, brokerage, netProfit, noTrade: false, boughtAsset, soldAsset, boughtQty, soldQty };
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);

  if (!asset1.length || !asset2.length)
    return { error: 'Both CSV files must contain valid date, close, and volume columns.' };

  const hourly = buildHourly(asset1, asset2);
  if (hourly.length < 2)
    return { error: 'No overlapping timestamps found. Confirm both CSVs cover the same trading period.' };

  // ── Config ──────────────────────────────────────────────────────────────────
  const lowW        = clamp(+(config.lowWidth           ?? 0.5),  0.05, 50) / 100;
  const midW        = clamp(+(config.midWidth           ?? 1.0),  0.05, 50) / 100;
  const highW       = clamp(+(config.highWidth          ?? 2.0),  0.05, 50) / 100;
  const sigmaT      = clamp(+(config.sigmaThreshold     ?? 1.0),  0.1, 5);
  const lookbackH   = Math.max(2, +(config.lookbackHours        ?? 24));
  const corrLB      = Math.max(2, +(config.corrLookbackHours    ?? 24));
  const corrImpact  = clamp(+(config.correlationImpact  ?? 0.6),  0, 2);
  const buyBrok     = clamp(+(config.buyBrokeragePct    ?? 0.15), 0, 5) / 100;
  const sellBrok    = clamp(+(config.sellBrokeragePct   ?? 0.15), 0, 5) / 100;
  const pauseHigh   = !!config.pauseHighVol;
  const ilStopPct   = clamp(+(config.ilStopLossPct      ?? 0),    0, 100);  // 0 = disabled
  const recenterOn  = config.recenterEnabled !== false;

  // ── Pool initialisation ──────────────────────────────────────────────────────
  const h0 = hourly[0];
  const p1_0 = h0.c1, p2_0 = h0.c2;

  // Round-to-nearest for initial allocation (not floor — avoids systematic
  // undershoot that compounds over hundreds of recenters)
  const xInit = Math.max(1, Math.round(realCapital / 2 / p1_0));
  const yInit = Math.max(1, Math.round(realCapital / 2 / p2_0));

  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low: cannot purchase even 1 share of each asset.' };

  let x = xInit, y = yInit;
  let k = x * y;

  // Active range center
  let center = p1_0 / p2_0;      // price ratio: p1/p2

  // Running totals
  let cashProfit     = 0;
  let totalBrokerage = 0;
  let totalSwaps     = 0;
  let recenterCount  = 0;
  let ilHalted       = false;
  let ilHaltedAt     = null;
  let currentMode    = 'MID';
  const modeHours    = { LOW: 0, MID: 0, HIGH: 0 };

  const initCashDeployed = xInit * p1_0 + yInit * p2_0;
  const swapRecords  = [];
  const equityCurve  = [];

  equityCurve.push({
    date: h0.date.toISOString(), poolValue: initCashDeployed,
    holdValue: initCashDeployed, cashProfit: 0, ilPct: 0,
    correlation: 0, dynamicWidthPct: midW * 100, mode: 'MID', halted: false,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1 = row.c1, p2 = row.c2;
    const extRatio = p1 / p2;

    // 1. Volume regime
    const volWin = hourly.slice(Math.max(0, idx - lookbackH), idx).map(h => h.vol);
    currentMode = volMode(row.vol, volWin, sigmaT);
    modeHours[currentMode]++;

    // 2. Rolling Pearson correlation of hourly returns
    const corrWindow = hourly.slice(Math.max(0, idx - corrLB), idx);
    const corr = pearsonCorr(
      corrWindow.map(h => h.ret1),
      corrWindow.map(h => h.ret2),
    );

    // 3. Dynamic half-width
    //    High correlation → tight band → capital efficiency
    //    Low correlation  → wide band  → reduce recenter churn
    const baseW = currentMode === 'LOW' ? lowW : currentMode === 'HIGH' ? highW : midW;
    const dynW  = clamp(baseW * (1 + corrImpact * (1 - Math.abs(corr))), lowW * 0.3, highW * 4);

    // 4. Band check
    const drift   = Math.abs(extRatio / center - 1);
    const inBand  = drift <= dynW;

    // ── RECENTER ─────────────────────────────────────────────────────────────
    if (!inBand && !ilHalted && recenterOn && !(pauseHigh && currentMode === 'HIGH')) {
      const rec = computeRecenterTrade(x, y, p1, p2, buyBrok, sellBrok);

      if (!rec.noTrade) {
        cashProfit     += rec.netProfit;
        totalBrokerage += rec.brokerage;
        // Update inventory to new balanced state
        if (rec.boughtAsset === 'Asset 1') {
          x = Math.max(1, x + rec.boughtQty); y = Math.max(1, y - rec.soldQty);
        } else {
          y = Math.max(1, y + rec.boughtQty); x = Math.max(1, x - rec.soldQty);
        }
        k = x * y;   // re-derive invariant from actual integer holdings
      }

      center = extRatio;  // reset center unconditionally
      recenterCount++;

      const poolVal = x * p1 + y * p2;
      const holdVal = xInit * p1 + yInit * p2;
      const ilPct   = holdVal > 0 ? (poolVal / holdVal - 1) * 100 : 0;

      if (!rec.noTrade) {
        swapRecords.push({
          date: row.date.toISOString(), mode: currentMode,
          rollingCorrelation: corr, dynamicWidthPct: dynW * 100,
          isRecenter: true,
          action: `RECENTER: Buy ${rec.boughtAsset} / Sell ${rec.soldAsset}`,
          boughtAsset: rec.boughtAsset, boughtQty: rec.boughtQty, boughtCost: rec.cost,
          soldAsset: rec.soldAsset, soldQty: rec.soldQty, soldRevenue: rec.revenue,
          grossProfit: rec.gross,
          brokerageOnBuy:  (rec.boughtAsset === 'Asset 1' ? buyBrok : sellBrok) * rec.cost,
          brokerageOnSell: (rec.soldAsset   === 'Asset 2' ? sellBrok: buyBrok)  * rec.revenue,
          totalBrokerageRow: rec.brokerage,
          netProfit: rec.netProfit, cashProfit,
          asset1Price: p1, asset2Price: p2,
          poolX: x, poolY: y, poolAssetValue: poolVal, ilPct,
          totalValue: poolVal + cashProfit,
        });
      }

      // IL stop-loss check on recenter
      const ilPctChk = holdVal > 0 ? (x * p1 + y * p2) / holdVal * 100 - 100 : 0;
      if (!ilHalted && ilStopPct > 0 && ilPctChk < -ilStopPct) {
        ilHalted = true; ilHaltedAt = row.date.toISOString();
      }

      const pv2 = x*p1+y*p2, hv2 = xInit*p1+yInit*p2;
      equityCurve.push({
        date: row.date.toISOString(), poolValue: pv2 + cashProfit, holdValue: hv2,
        cashProfit, ilPct: (pv2/hv2 - 1) * 100, correlation: corr,
        dynamicWidthPct: dynW * 100, mode: currentMode, halted: ilHalted,
      });
      continue;
    }

    // ── REGULAR SWAP (in-band) ────────────────────────────────────────────────
    if (inBand && !ilHalted && !(pauseHigh && currentMode === 'HIGH')) {
      const swap = computeSwap(x, y, p1, p2, buyBrok, sellBrok);

      if (swap && swap.netProfit > 0) {
        cashProfit     += swap.netProfit;
        totalBrokerage += swap.brokerage;
        x = swap.xAfter; y = swap.yAfter;
        k = x * y;   // re-derive invariant
        totalSwaps++;

        const boughtAsset = swap.direction === 'BUY1_SELL2' ? 'Asset 1' : 'Asset 2';
        const soldAsset   = swap.direction === 'BUY1_SELL2' ? 'Asset 2' : 'Asset 1';
        const boughtQty   = swap.direction === 'BUY1_SELL2' ? swap.dxBuy : swap.dyBuy;
        const soldQty     = swap.direction === 'BUY1_SELL2' ? swap.dyOut : swap.dxOut;

        const poolVal = x * p1 + y * p2;
        const holdVal = xInit * p1 + yInit * p2;
        const ilPct   = holdVal > 0 ? (poolVal / holdVal - 1) * 100 : 0;

        swapRecords.push({
          date: row.date.toISOString(), mode: currentMode,
          rollingCorrelation: corr, dynamicWidthPct: dynW * 100,
          isRecenter: false,
          action: `Buy ${boughtAsset} / Sell ${soldAsset}`,
          boughtAsset, boughtQty, boughtCost: swap.cost,
          soldAsset, soldQty, soldRevenue: swap.revenue,
          grossProfit: swap.gross,
          brokerageOnBuy:  buyBrok  * swap.cost,
          brokerageOnSell: sellBrok * swap.revenue,
          totalBrokerageRow: swap.brokerage,
          netProfit: swap.netProfit, cashProfit,
          asset1Price: p1, asset2Price: p2,
          poolX: x, poolY: y, poolAssetValue: poolVal, ilPct,
          totalValue: poolVal + cashProfit,
        });

        if (!ilHalted && ilStopPct > 0 && ilPct < -ilStopPct) {
          ilHalted = true; ilHaltedAt = row.date.toISOString();
        }
      }
    }

    // ── Equity curve ──────────────────────────────────────────────────────────
    const pv = x * p1 + y * p2;
    const hv = xInit * p1 + yInit * p2;
    const ilPct = hv > 0 ? (pv / hv - 1) * 100 : 0;
    if (!ilHalted && ilStopPct > 0 && ilPct < -ilStopPct) {
      ilHalted = true; ilHaltedAt = row.date.toISOString();
    }
    equityCurve.push({
      date: row.date.toISOString(), poolValue: pv + cashProfit, holdValue: hv,
      cashProfit, ilPct, correlation: corr,
      dynamicWidthPct: dynW * 100, mode: currentMode, halted: ilHalted,
    });
  }

  // ── Final metrics ────────────────────────────────────────────────────────────
  const last     = hourly[hourly.length - 1];
  const holdVal  = xInit * last.c1 + yInit * last.c2;
  const poolVal  = x     * last.c1 + y     * last.c2;
  const totVal   = poolVal + cashProfit;
  const ilINR    = poolVal - holdVal;
  const ilPct    = holdVal > 0 ? (poolVal / holdVal - 1) * 100 : 0;
  const vsHold   = totVal - holdVal;
  const vsHoldPct = holdVal > 0 ? (totVal / holdVal - 1) * 100 : 0;
  const roiPct   = initCashDeployed > 0 ? (totVal  / initCashDeployed - 1) * 100 : 0;
  const holdRoi  = initCashDeployed > 0 ? (holdVal / initCashDeployed - 1) * 100 : 0;
  const cashRoi  = initCashDeployed > 0 ?  cashProfit / initCashDeployed * 100 : 0;
  const brokRoi  = initCashDeployed > 0 ?  totalBrokerage / initCashDeployed * 100 : 0;

  const recenterSwaps = swapRecords.filter(s => s.isRecenter).length;

  return {
    swaps: swapRecords,
    equityCurve,
    results: {
      initCashDeployed,
      totalValue:    totVal,
      poolAssets:    poolVal,
      holdValue:     holdVal,
      cashProfit,
      totalBrokerage,
      vsHold,
      vsHoldPct,
      roiPct,
      holdRoi,
      cashRoi,
      brokRoi,
      ilINR,
      ilPct,
      ilHalted,
      ilHaltedAt,
      totalSwaps,
      recenterSwaps,
      recenterCount,
      buyBrokeragePct:  buyBrok  * 100,
      sellBrokeragePct: sellBrok * 100,
      initialX: xInit, initialY: yInit,
      finalX:   x,     finalY:   y,
      lowModeHours:  modeHours.LOW,
      midModeHours:  modeHours.MID,
      highModeHours: modeHours.HIGH,
    },
  };
}
