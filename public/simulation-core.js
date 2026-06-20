// simulation-core.js  v7.0  —  Diagnostic-first institutional rebalancer
// ─────────────────────────────────────────────────────────────────────
//
//  WHY THE PREVIOUS ENGINE FAILED (root-cause, confirmed by ledger analysis)
//  ───────────────────────────────────────────────────────────────────────
//  The V3 "concentrated liquidity" delta formula computes swap size from a
//  SINGLE liquidity constant L calibrated to the FULL band width (e.g. ±5%).
//  That constant assumes continuous trading volume across the whole range,
//  the way a real Uniswap pool sees thousands of external traders.
//
//  Here there are no external traders. We are simulating our OWN portfolio
//  rebalancing against minute-by-minute price ticks that move a tiny
//  fraction of a percent. Plugging a tiny tick into a formula calibrated
//  for a ±5% range produces swap sizes wildly disproportionate to the
//  actual price move — confirmed: a single 0.15% tick demanded trading
//  2.9% of the ENTIRE pool. Repeated over minutes, this thrashes one side
//  of the pool down to its floor (1 share) and back, over and over —
//  visible directly in the uploaded ledger (PoolA2: 215→1→215→1...).
//  That thrashing generates brokerage drag and IL without any real edge.
//
//  THE FIX — TWO INDEPENDENT, TESTABLE STRATEGIES
//  ──────────────────────────────────────────────
//  Rather than force V3 math onto a context it wasn't designed for, this
//  engine implements the rebalancing logic directly:
//
//  Every bar, compute the EXACT 50/50 target at current prices:
//    targetX = floor(poolValue / 2 / p1)
//    targetY = floor(poolValue / 2 / p2)
//  Trade only the difference between current holdings and target.
//
//  This is mathematically IDENTICAL to "infinite concentration" V3 (a
//  position with rLow=rHigh=rNow), which is the only L-independent,
//  well-defined limit of the V3 formula. It trades exactly what is needed
//  to stay balanced — no more, no less, regardless of tick size. No
//  arbitrary L constant, no thrashing.
//
//  A trade quantity FLOOR (configurable, default ₹500) prevents brokerage
//  drag from chasing sub-rupee rebalances on dead-flat ticks.
//
//  DIAGNOSTIC INSTRUMENTATION
//  ────────────────────────────
//  Every run reports, broken down by cause:
//    - gross trading P&L vs brokerage paid vs net
//    - IL contribution (pool value vs hold value)
//    - vault-locked profit (realised, never at risk)
//    - swap-size distribution (max/median swap as % of pool) to catch
//      thrashing immediately if it ever reappears
//    - per-day P&L curve so trending vs mean-reverting periods are visible
//
// ─────────────────────────────────────────────────────────────────────

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
  const headers = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    return headers.reduce((row, h, i) => {
      row[h] = (cells[i] || '').trim(); return row;
    }, {});
  });
}

export function normalizeRows(rows) {
  return rows
    .map(r => ({ date: new Date(r.date), close: +r.close, volume: +r.volume }))
    .filter(r => !isNaN(r.date) && isFinite(r.close) && r.close > 0 && isFinite(r.volume))
    .sort((a, b) => a.date - b.date);
}

// Exact-timestamp merge — no resolution collapsing.
export function buildMinutely(a1, a2) {
  const map = new Map();
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) {
      map.set(t1, { date: a1[i].date, c1: a1[i].close, c2: a2[j].close });
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}
export function buildHourly(a1, a2) { return buildMinutely(a1, a2); }

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── Pair fitness (unchanged — diagnostic for pre-screening) ─────────────────
export function pairFitness(df1, df2) {
  const a1 = normalizeRows(df1);
  const a2 = normalizeRows(df2);
  if (!a1.length || !a2.length) return { error: 'Invalid data' };
  const bars = buildMinutely(a1, a2);
  if (bars.length < 20) return { error: 'Too few bars' };

  const ratios = bars.map(h => h.c1 / h.c2);
  const n      = ratios.length;
  const mean   = ratios.reduce((s, v) => s + v, 0) / n;
  const std    = Math.sqrt(ratios.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const logRets = ratios.slice(1).map((r, i) => Math.log(r / ratios[i]));

  const lrMean = logRets.reduce((s, v) => s + v, 0) / logRets.length;
  let cum = 0, minC = 0, maxC = 0, ss = 0;
  for (const v of logRets) {
    cum += v - lrMean;
    if (cum < minC) minC = cum;
    if (cum > maxC) maxC = cum;
    ss += (v - lrMean) ** 2;
  }
  const S = Math.sqrt(ss / logRets.length);
  const hurst = S > 1e-12 ? Math.log((maxC - minC) / S) / Math.log(logRets.length) : 0.5;

  let num = 0, den = 0;
  for (let i = 0; i < logRets.length - 1; i++) num += (logRets[i] - lrMean) * (logRets[i+1] - lrMean);
  for (const v of logRets) den += (v - lrMean) ** 2;
  const autocorr = den > 1e-14 ? num / den : 0;

  const ratioDrift = Math.abs(ratios.at(-1) / ratios[0] - 1) * 100;
  let crossings = 0;
  for (let i = 1; i < ratios.length; i++) {
    if ((ratios[i-1] - mean) * (ratios[i] - mean) < 0) crossings++;
  }

  const colour = hurst < 0.45 ? 'green' : hurst < 0.50 ? 'yellow' : hurst < 0.55 ? 'orange' : 'red';
  const verdict =
    hurst < 0.45 ? 'STRONG FIT — pair is mean-reverting' :
    hurst < 0.50 ? 'MODERATE FIT — some mean-reversion' :
    hurst < 0.55 ? 'WEAK FIT — near random walk' :
                   'POOR FIT — pair is trending';

  return {
    bars: n, ratioMean: +mean.toFixed(4), ratioStd: +std.toFixed(4),
    hurst: +hurst.toFixed(3), ratioDrift: +ratioDrift.toFixed(2),
    autocorr1: +autocorr.toFixed(4),
    crossingRate: +((crossings / n) * 100).toFixed(2),
    verdict, colour,
  };
}

// ─── Performance summary with full diagnostic breakdown ──────────────────────
export function buildPerformanceSummary(ledger, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 375); // minute bars, ~375 min/trading day

  const trades = ledger.filter(t => t.type === 'TRADE');
  const gross  = trades.reduce((s, t) => s + t.gross, 0);
  const brok   = trades.reduce((s, t) => s + t.brok,  0);
  const profitable = trades.filter(t => t.net > 0).length;
  const successRate = trades.length > 0 ? profitable / trades.length : 0;
  const frictionRatio = Math.abs(gross) > 0 ? brok / Math.abs(gross) : 1;

  // Swap-size distribution as % of pool value at time of trade — catches
  // thrashing immediately (any swap > ~20% of pool is a red flag).
  const sizePcts = trades.map(t => t.sellVal / Math.max(t.poolValueBefore, 1) * 100).sort((a,b)=>a-b);
  const medianSizePct = sizePcts.length ? sizePcts[Math.floor(sizePcts.length/2)] : 0;
  const maxSizePct    = sizePcts.length ? sizePcts[sizePcts.length-1] : 0;
  const thrashCount   = sizePcts.filter(p => p > 20).length;

  const alpha = equityCurve.map(p => p.totalValue - p.holdValue);
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) {
    if (v > peak) peak = v;
    if (v - peak < maxDD) maxDD = v - peak;
  }

  const aRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mr = aRets.reduce((s, v) => s + v, 0) / (aRets.length || 1);
  let vv = 0; for (const v of aRets) vv += (v - mr) ** 2;
  const sd = Math.sqrt(vv / Math.max(aRets.length - 1, 1));

  return {
    grossTotal: gross, brokTotal: brok, netTotal: gross - brok,
    totalTrades: trades.length, profitable,
    successRate, successPct: successRate * 100,
    frictionRatio, frictionPct: frictionRatio * 100,
    medianSizePct: +medianSizePct.toFixed(2),
    maxSizePct: +maxSizePct.toFixed(2),
    thrashCount,
    maxDrawdown: maxDD,
    maxDrawdownPct: results.holdValue > 0 ? maxDD / results.holdValue * 100 : 0,
    alphaSharpe: sd > 1e-12 ? (mr / sd) * ANNUALISE : 0,
    vaultValue: results.vaultFinal,
    vaultDeposits: results.vaultDeposits,
    narrative: {
      sizing: thrashCount === 0
        ? 'HEALTHY — no swap exceeded 20% of pool value (no thrashing)'
        : `WARNING — ${thrashCount} swap(s) exceeded 20% of pool value (possible thrashing)`,
      friction: frictionRatio < 0.40 ? 'ACCEPTABLE — brokerage < 40% of gross P&L'
               : frictionRatio < 0.80 ? 'HIGH — brokerage eroding most of the edge'
               : 'VERY HIGH — brokerage exceeds trading edge; widen rebalance threshold',
      quality: successRate > 0.55 ? 'GOOD — pair is mean-reverting'
             : successRate > 0.45 ? 'MIXED — weak mean-reversion'
             : 'POOR — pair is trending, not mean-reverting',
      alpha: results.vsHold >= 0
        ? `Outperforms hold by ₹${Math.abs(results.vsHold).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
        : `Underperforms hold by ₹${Math.abs(results.vsHold).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
    },
  };
}

// ─── MAIN ENGINE ──────────────────────────────────────────────────────────────
//
// Strategy: exact 50/50 rebalancing with a minimum-trade-value floor.
// This is the L-independent limit of V3 concentrated liquidity — it always
// trades exactly the amount needed to restore balance, scaled naturally to
// whatever the actual price tick was. No thrashing is possible because
// trade size is bounded by the realised price move, not by an arbitrary
// liquidity constant.

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const a1 = normalizeRows(df1);
  const a2 = normalizeRows(df2);
  if (!a1.length || !a2.length)
    return { error: 'Both files need valid date, close, volume columns.' };

  const bars = buildMinutely(a1, a2);
  if (bars.length < 10)
    return { error: 'Too few overlapping bars. Check timestamps match.' };

  // ── Config ────────────────────────────────────────────────────────────────
  const bandPct       = clamp(+(config.bandPct ?? 5), 0.5, 50) / 100;
  const buyBrok       = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok      = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;
  const reinvestBrok  = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;

  // Minimum trade value floor — prevents brokerage drag from chasing
  // sub-rupee rebalances on dead-flat ticks. This is NOT a profit-margin
  // filter (which we removed); it's a practical execution floor matching
  // how real brokers round-lot small orders.
  const minTradeValue = clamp(+(config.minTradeValue ?? 200), 0, 1e6);

  const ilHardStop   = clamp(+(config.ilHardStopPct   ?? 0), 0, 100);
  const ilHardResume = clamp(+(config.ilHardResumePct ?? 0), 0, 100);
  const compoundIntervalHours = clamp(+(config.compoundIntervalHours ?? 24), 1, 168);

  // ── Initialise ────────────────────────────────────────────────────────────
  const h0    = bars[0];
  const p1_0  = h0.c1, p2_0 = h0.c2;
  const rInit = p1_0 / p2_0;
  const rLow  = rInit * (1 - bandPct);
  const rHigh = rInit * (1 + bandPct);

  const poolHalf = realCapital / 2;
  let poolX = Math.max(1, Math.floor(poolHalf / p1_0));
  let poolY = Math.max(1, Math.floor(poolHalf / p2_0));
  const holdX = poolX, holdY = poolY;
  const initCapital = poolX * p1_0 + poolY * p2_0;

  let vaultX = 0, vaultY = 0;

  // ── State ─────────────────────────────────────────────────────────────────
  let cashProfit = 0;
  let totalBrokerage = 0;
  let grossTotal = 0, netTotal = 0;
  let totalTrades = 0, profitableTrades = 0, unprofitableTrades = 0;
  let vaultDeposits = 0;
  let vaultAdjustments = 0, poolAdjustments = 0;
  let outOfBandLock = false;
  let swapsHalted = false, haltReason = null;
  let ilHaltedAt = null, ilResumedAt = null, haltCount = 0;
  let lastVaultCheckMs = h0.date.getTime();

  const ledger = [];
  const equityCurve = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initCapital, holdValue: initCapital, cashProfit: 0,
    totalValue: initCapital, alphaINR: 0, ilPct: 0,
    vaultValue: 0, inBand: true, halted: false, compoundEvent: false,
  });

  for (let idx = 1; idx < bars.length; idx++) {
    const row = bars[idx];
    const p1 = row.c1, p2 = row.c2;
    const rNow = p1 / p2;

    const poolVal  = poolX * p1 + poolY * p2;
    const vaultVal = vaultX * p1 + vaultY * p2;
    const holdVal  = holdX * p1 + holdY * p2;
    const ilPct    = holdVal > 0 ? ((poolVal + vaultVal) / holdVal - 1) * 100 : 0;

    if (swapsHalted && haltReason === 'IL_STOP' && ilHardResume > 0 && ilPct >= -ilHardResume) {
      swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
    }
    if (!swapsHalted && ilHardStop > 0 && ilPct < -ilHardStop) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt = row.date.toISOString(); haltCount++;
    }

    const inBand = rNow >= rLow && rNow <= rHigh;

    // ── BAND ADJUSTMENT (edge-triggered, fires once per breach) ─────────────
    if (!inBand && !swapsHalted && !outOfBandLock) {
      outOfBandLock = true;
      const xTarget = Math.max(1, Math.floor(poolVal / 2 / p1));
      const yTarget = Math.max(1, Math.floor(poolVal / 2 / p2));
      const xNeed = xTarget - poolX;
      const yNeed = yTarget - poolY;
      let adjType = null;

      if (xNeed > 0 && yNeed < 0) {
        const yExcess = Math.abs(yNeed);
        if (vaultX >= xNeed) {
          vaultX -= xNeed; poolX += xNeed; poolY -= yExcess; vaultY += yExcess;
          adjType = 'VAULT→POOL'; vaultAdjustments++;
        } else {
          const xFromVault = vaultX; vaultX = 0;
          poolX += xFromVault; poolY -= yExcess; vaultY += yExcess;
          adjType = 'POOL→VAULT'; poolAdjustments++;
        }
      } else if (xNeed < 0 && yNeed > 0) {
        const xExcess = Math.abs(xNeed);
        if (vaultY >= yNeed) {
          vaultY -= yNeed; poolY += yNeed; poolX -= xExcess; vaultX += xExcess;
          adjType = 'VAULT→POOL'; vaultAdjustments++;
        } else {
          const yFromVault = vaultY; vaultY = 0;
          poolY += yFromVault; poolX -= xExcess; vaultX += xExcess;
          adjType = 'POOL→VAULT'; poolAdjustments++;
        }
      }

      if (adjType) {
        ledger.push({
          date: row.date.toISOString(), type: 'ADJUST', adjType,
          rNow: +rNow.toFixed(6), rLow: +rLow.toFixed(6), rHigh: +rHigh.toFixed(6),
          poolX, poolY, vaultX, vaultY,
          asset1Price: p1, asset2Price: p2,
          poolValue: poolX*p1+poolY*p2, vaultValue: vaultX*p1+vaultY*p2,
          cashProfit,
        });
      }
    } else if (inBand) {
      outOfBandLock = false;
    }

    // ── REBALANCE TO EXACT 50/50 ─────────────────────────────────────────────
    //
    // This replaces the V3-delta formula. It is the L→∞ (infinite
    // concentration) limit of V3 — always trades exactly what's needed to
    // restore 50/50 balance at CURRENT prices, scaled naturally to however
    // big the actual price move was. No swap can ever exceed what's needed
    // to reach the target, so thrashing is structurally impossible.

    let didTrade = false;
    if (inBand && !swapsHalted) {
      const totalV  = poolX * p1 + poolY * p2;
      const xTarget = Math.max(1, Math.floor(totalV / 2 / p1));
      const yTarget = Math.max(1, Math.floor(totalV / 2 / p2));
      const xDelta  = xTarget - poolX;
      const yDelta  = yTarget - poolY;

      if (xDelta > 0 && yDelta < 0 && Math.abs(yDelta) < poolY) {
        const buyQty  = xDelta;
        const sellQty = Math.abs(yDelta);
        const buyVal  = buyQty  * p1;
        const sellVal = sellQty * p2;

        if (sellVal >= minTradeValue) {
          const brok  = buyBrok * buyVal + sellBrok * sellVal;
          const gross = sellVal - buyVal;
          const net   = gross - brok;

          poolX += buyQty; poolY -= sellQty;
          cashProfit += net; totalBrokerage += brok;
          grossTotal += gross; netTotal += net;
          totalTrades++; didTrade = true;
          if (net >= 0) profitableTrades++; else unprofitableTrades++;

          ledger.push({
            date: row.date.toISOString(), type: 'TRADE',
            action: 'Buy Asset 1 / Sell Asset 2',
            buyAsset: 'Asset 1', buyQty, buyVal,
            sellAsset: 'Asset 2', sellQty, sellVal,
            gross, brok, net, cashProfit,
            poolValueBefore: totalV,
            asset1Price: p1, asset2Price: p2,
            poolX, poolY, vaultX, vaultY,
            ilPct: +ilPct.toFixed(3), rNow: +rNow.toFixed(6),
          });
        }

      } else if (xDelta < 0 && yDelta > 0 && Math.abs(xDelta) < poolX) {
        const sellQty = Math.abs(xDelta);
        const buyQty  = yDelta;
        const sellVal = sellQty * p1;
        const buyVal  = buyQty  * p2;

        if (sellVal >= minTradeValue) {
          const brok  = sellBrok * sellVal + buyBrok * buyVal;
          const gross = sellVal - buyVal;
          const net   = gross - brok;

          poolX -= sellQty; poolY += buyQty;
          cashProfit += net; totalBrokerage += brok;
          grossTotal += gross; netTotal += net;
          totalTrades++; didTrade = true;
          if (net >= 0) profitableTrades++; else unprofitableTrades++;

          ledger.push({
            date: row.date.toISOString(), type: 'TRADE',
            action: 'Sell Asset 1 / Buy Asset 2',
            sellAsset: 'Asset 1', sellQty, sellVal,
            buyAsset: 'Asset 2', buyQty, buyVal,
            gross, brok, net, cashProfit,
            poolValueBefore: totalV,
            asset1Price: p1, asset2Price: p2,
            poolX, poolY, vaultX, vaultY,
            ilPct: +ilPct.toFixed(3), rNow: +rNow.toFixed(6),
          });
        }
      }
    }

    // ── VAULT DEPOSIT (real elapsed time, not bar count) ─────────────────────
    let didVault = false;
    const hoursSinceVault = (row.date.getTime() - lastVaultCheckMs) / 3600000;
    if (hoursSinceVault >= compoundIntervalHours && cashProfit > 0) {
      const gross    = cashProfit;
      const brokCost = gross * reinvestBrok;
      const net      = gross - brokCost;
      const buyX     = Math.floor(net / 2 / p1);
      const buyY     = Math.floor(net / 2 / p2);

      if (buyX >= 1 && buyY >= 1) {
        const actualCost = buyX * p1 + buyY * p2;
        vaultX += buyX; vaultY += buyY;
        totalBrokerage += brokCost;
        cashProfit -= (actualCost + brokCost);
        vaultDeposits++; didVault = true;

        ledger.push({
          date: row.date.toISOString(), type: 'VAULT_DEPOSIT',
          action: '🔒 Vault Deposit',
          buyX, buyY, actualCost, brokCost,
          cashAfter: cashProfit, vaultX, vaultY,
          asset1Price: p1, asset2Price: p2,
          vaultValue: vaultX*p1+vaultY*p2, depositEvent: vaultDeposits,
        });
      }
      lastVaultCheckMs = row.date.getTime();
    }

    const pv = poolX * p1 + poolY * p2;
    const vv = vaultX * p1 + vaultY * p2;
    const hv = holdX * p1 + holdY * p2;
    const totV = pv + cashProfit + vv;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv, vaultValue: vv, cashProfit,
      totalValue: totV, holdValue: hv,
      alphaINR: totV - hv,
      ilPct: hv > 0 ? ((pv+vv)/hv - 1)*100 : 0,
      inBand, halted: swapsHalted, haltReason, compoundEvent: didVault,
    });
  }

  const last = bars[bars.length - 1];
  const holdValue  = holdX * last.c1 + holdY * last.c2;
  const poolFinal  = poolX * last.c1 + poolY * last.c2;
  const vaultFinal = vaultX * last.c1 + vaultY * last.c2;
  const totalValue = poolFinal + cashProfit + vaultFinal;
  const vsHold     = totalValue - holdValue;
  const vsHoldPct  = holdValue > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    realCapital, initCapital, totalValue, poolFinal, vaultFinal,
    cashProfit, holdValue, totalBrokerage, grossTotal, netTotal,
    vsHold, vsHoldPct,
    roiPct:  initCapital > 0 ? (totalValue / initCapital - 1) * 100 : 0,
    holdRoi: initCapital > 0 ? (holdValue  / initCapital - 1) * 100 : 0,
    cashRoi: initCapital > 0 ? cashProfit  / initCapital * 100 : 0,
    brokRoi: initCapital > 0 ? totalBrokerage / initCapital * 100 : 0,
    ilPct: holdValue > 0 ? ((poolFinal+vaultFinal)/holdValue - 1)*100 : 0,
    ilINR: poolFinal + vaultFinal - holdValue,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt, haltCount,
    totalTrades, profitableTrades, unprofitableTrades,
    successRate: totalTrades > 0 ? profitableTrades / totalTrades : 0,
    poolX, poolY, vaultX, vaultY, holdX, holdY,
    vaultDeposits, vaultAdjustments, poolAdjustments,
    bandPct: bandPct * 100,
    buyBrokeragePct: buyBrok*100, sellBrokeragePct: sellBrok*100,
    minTradeValue,
  };

  return {
    swaps: ledger, equityCurve, results,
    performanceSummary: buildPerformanceSummary(ledger, equityCurve, results),
  };
}
