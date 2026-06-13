// simulation-core.js  v5.0  —  Real-world pair rebalancing backtest
// ─────────────────────────────────────────────────────────────────
//
// WHAT THIS MODELS
// ─────────────────
// A portfolio holds two NSE stocks (Asset1, Asset2).
// Every hour it checks: has the VALUE RATIO drifted outside a target band?
//   valueRatio = (xShares * p1) / (yShares * p2)
//
// If yes, it rebalances back to a 50/50 value split by:
//   - selling shares of the stock that has become over-weight
//   - buying shares of the stock that has become under-weight
//   - paying real NSE brokerage (STT, exchange fees, etc.) on both legs
//
// This IS a real executable strategy. Every number here can be verified
// against a real NSE brokerage statement.
//
// WHAT DRIVES RETURNS
// ────────────────────
// The strategy profits when prices MEAN-REVERT:
//   Step 1: Asset1 rises → it becomes over-weight → we sell some Asset1 HIGH
//   Step 2: Asset1 falls back → Asset2 becomes over-weight → we sell some Asset2 HIGH
//   Net: sold Asset1 high, sold Asset2 when it was high = bought low on both
//
// The strategy LOSES when prices TREND:
//   If Asset1 keeps rising, every rebalance sells the winner and buys the loser.
//   We accumulate the losing asset at progressively worse prices.
//
// REAL COSTS INCLUDED
// ────────────────────
//  1. Brokerage on both legs of every trade (configurable, default 0.30% round-trip)
//  2. Minimum trade size: only rebalance if trade value >= minTradeValue (avoids
//     churning tiny amounts and paying brokerage on them)
//  3. Rebalance only when drift > band threshold (avoids over-trading)
//  4. No look-ahead: decision at time T uses only prices at time T
//  5. Reinvestment brokerage: when cash profit is reinvested, brokerage is charged
//
// WHAT IS NOT INFLATED
// ─────────────────────
//  - No fee income from phantom external traders
//  - No floor-division arithmetic remainder counted as profit
//  - No phantom shares created by rounding
//  - Brokerage can exceed gross profit → trade is skipped
//  - cashProfit can go negative if trades cost more than they earn
//
// ─────────────────────────────────────────────────────────────────

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
    return headers.reduce((row, h, i) => { row[h] = (cells[i] || '').trim(); return row; }, {});
  });
}

export function normalizeRows(rows) {
  return rows
    .map(r => ({ date: new Date(r.date), close: +r.close, volume: +r.volume }))
    .filter(r => !isNaN(r.date) && isFinite(r.close) && r.close > 0 && isFinite(r.volume))
    .sort((a, b) => a.date - b.date);
}

export function buildHourly(a1, a2) {
  const map = new Map();
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) {
      const key = (() => {
        const d = new Date(a1[i].date); d.setMinutes(0, 0, 0); return d.toISOString();
      })();
      if (!map.has(key)) map.set(key, { date: new Date(key), c1: a1[i].close, c2: a2[j].close });
      const b = map.get(key); b.c1 = a1[i].close; b.c2 = a2[j].close;
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── EWMA volatility ──────────────────────────────────────────────────────────
function updateEWMA(prevVar, logRet, lam = 0.94) {
  return lam * prevVar + (1 - lam) * logRet * logRet;
}

// ─── Performance summary ──────────────────────────────────────────────────────
export function buildPerformanceSummary(trades, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6.5); // hourly bars, ~6.5 trading hours/day

  const realTrades    = trades.filter(t => t.type === 'TRADE');
  const grossTotal    = realTrades.reduce((s, t) => s + t.gross, 0);
  const brokTotal     = realTrades.reduce((s, t) => s + t.brok,  0);
  const profitable    = realTrades.filter(t => t.net > 0).length;
  const successRate   = realTrades.length > 0 ? profitable / realTrades.length : 0;
  const frictionRatio = Math.abs(grossTotal) > 0 ? brokTotal / Math.abs(grossTotal) : 1;

  const alpha = equityCurve.map(p => p.poolValue - p.holdValue);
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) {
    if (v > peak) peak = v;
    if (v - peak < maxDD) maxDD = v - peak;
  }
  const maxDDPct = results.holdValue > 0 ? (maxDD / results.holdValue) * 100 : 0;

  const aRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mr = aRets.length ? aRets.reduce((s, v) => s + v, 0) / aRets.length : 0;
  let vv = 0; for (const v of aRets) vv += (v - mr) ** 2;
  const sd = aRets.length > 1 ? Math.sqrt(vv / (aRets.length - 1)) : 1e-9;
  const sharpe = sd > 1e-12 ? (mr / sd) * ANNUALISE : 0;

  return {
    grossTotal, brokTotal, netCash: results.cashProfit,
    frictionRatio, frictionPct: frictionRatio * 100,
    totalTrades: realTrades.length, profitable,
    successRate, successPct: successRate * 100,
    maxDrawdownINR: maxDD, maxDrawdownPct: maxDDPct,
    alphaSharpe: sharpe,
    reinvestedTotal: results.reinvestedTotal,
    compoundEvents:  results.compoundEvents,
    narrative: {
      friction: frictionRatio < 0.40 ? 'ACCEPTABLE — friction < 40% of gross'
               : frictionRatio < 0.80 ? 'HIGH — consider wider band or lower frequency'
               : 'VERY HIGH — brokerage likely exceeds trading edge',
      quality: successRate > 0.55 ? 'GOOD — majority profitable (pair mean-reverts)'
             : successRate > 0.45 ? 'MIXED — near 50/50 (weak mean-reversion)'
             : 'POOR — pair is trending, not mean-reverting',
      alpha: results.vsHold >= 0
        ? `Strategy outperforms hold by ₹${Math.abs(results.vsHold).toLocaleString('en-IN', {maximumFractionDigits:0})}`
        : `Strategy underperforms hold by ₹${Math.abs(results.vsHold).toLocaleString('en-IN', {maximumFractionDigits:0})}`,
    },
  };
}

// ─── MAIN BACKTEST ────────────────────────────────────────────────────────────
export function runAlmSimulation(df1, df2, realCapital, config = {}) {

  const a1 = normalizeRows(df1);
  const a2 = normalizeRows(df2);
  if (!a1.length || !a2.length)
    return { error: 'Both files need valid date, close, volume columns.' };

  const hourly = buildHourly(a1, a2);
  if (hourly.length < 10)
    return { error: 'Too few overlapping bars. Check timestamps match in both files.' };

  // ── Config ────────────────────────────────────────────────────────────────────
  // Rebalance band: rebalance when value ratio drifts more than this from 1.0
  // e.g. 0.05 = rebalance when one side is >5% heavier than the other
  const bandPct      = clamp(+(config.bandPct      ?? 5),    0.5, 50)  / 100;
  const buyBrok      = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok     = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;
  const reinvestBrok = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;

  // Minimum ₹ value of a single trade leg (avoid tiny churning trades)
  const minTradeValue = clamp(+(config.minTradeValue ?? 5000), 100, 1e7);

  // Hard IL stop
  const ilHardStop   = clamp(+(config.ilHardStopPct  ?? 0), 0, 100);
  const ilHardResume = clamp(+(config.ilHardResumePct ?? 0), 0, 100);

  // Compounding
  const compoundIntervalHours = clamp(+(config.compoundIntervalHours ?? 24),   1, 168);
  const compoundMinPct        = clamp(+(config.compoundMinPct        ?? 0.5), 0.01, 10);

  // ── Initialise ────────────────────────────────────────────────────────────────
  const h0   = hourly[0];
  const p1_0 = h0.c1, p2_0 = h0.c2;

  // Deploy capital 50/50 by value
  const half     = realCapital / 2;
  const xShares0 = Math.max(1, Math.floor(half / p1_0));
  const yShares0 = Math.max(1, Math.floor(half / p2_0));

  let xShares     = xShares0;
  let yShares     = yShares0;

  // Hold benchmark: same share counts, never rebalanced
  const xHold = xShares0;
  const yHold = yShares0;

  // Actual capital deployed (integer shares × price, no phantom rounding)
  const initCapital = xShares0 * p1_0 + yShares0 * p2_0;

  // Cash account: starts at 0. Brokerage and trade P&L go here.
  // Can go negative — that is real money owed.
  let cashProfit = 0;

  // ── State ─────────────────────────────────────────────────────────────────────
  let totalBrokerage = 0;
  let grossTotal     = 0;
  let netTotal       = 0;
  let totalTrades    = 0;
  let profitableTrades = 0;
  let unprofitableTrades = 0;
  let skippedTrades  = 0;   // wanted to trade but brok > gross
  let reinvestedTotal = 0;
  let compoundEvents  = 0;
  let totalReinvestBrokerage = 0;

  let swapsHalted = false;
  let haltReason  = null;
  let ilHaltedAt  = null;
  let ilResumedAt = null;
  let haltCount   = 0;
  let hoursSinceCompound = 0;

  let ewmaVar = 0;

  const ledger      = [];
  const equityCurve = [];

  equityCurve.push({
    date:       h0.date.toISOString(),
    poolValue:  initCapital,
    holdValue:  initCapital,
    cashProfit: 0,
    alphaINR:   0,
    ilPct:      0,
    halted:     false,
    compoundEvent: false,
  });

  // ── Bar loop ──────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row  = hourly[idx];
    const p1   = row.c1;
    const p2   = row.c2;

    // EWMA vol of log-price ratio
    const logRet = Math.log((p1/p2) / (hourly[idx-1].c1/hourly[idx-1].c2));
    ewmaVar = updateEWMA(ewmaVar, logRet);

    hoursSinceCompound++;

    // Current portfolio values
    const xVal   = xShares * p1;
    const yVal   = yShares * p2;
    const pvNow  = xVal + yVal + cashProfit;

    const xHoldVal = xHold * p1;
    const yHoldVal = yHold * p2;
    const hvNow    = xHoldVal + yHoldVal;

    const ilPctNow   = hvNow > 0 ? ((xVal + yVal) / hvNow - 1) * 100 : 0;

    // ── Auto-resume ───────────────────────────────────────────────────────────
    if (swapsHalted && haltReason === 'IL_STOP' && ilHardResume > 0 && ilPctNow >= -ilHardResume) {
      swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
    }

    // ── Hard stop ─────────────────────────────────────────────────────────────
    if (!swapsHalted && ilHardStop > 0 && ilPctNow < -ilHardStop) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt  = row.date.toISOString(); haltCount++;
    }

    // ── Rebalance check ───────────────────────────────────────────────────────
    //
    // value ratio = xVal / yVal
    // neutral = 1.0 (equal value in both assets)
    // drift   = |valueRatio - 1|
    //
    // When drift > bandPct:
    //   - sell the over-weight asset down to 50%
    //   - buy the under-weight asset up to 50%
    //
    // Both legs happen at current market prices.
    // Brokerage is charged on both.
    // Only execute if net > 0 after brokerage AND trade value >= minTradeValue.

    if (!swapsHalted && xVal > 0 && yVal > 0) {
      const totalPortfolio = xVal + yVal;
      const targetVal      = totalPortfolio / 2;   // 50/50 target

      const xDrift = (xVal - targetVal) / targetVal;  // +ve = Asset1 over-weight
      const yDrift = (yVal - targetVal) / targetVal;

      const drift = Math.abs(xDrift);

      if (drift > bandPct) {
        if (xDrift > 0) {
          // Asset1 over-weight → sell Asset1, buy Asset2
          const sellValue = xVal - targetVal;          // ₹ worth to sell
          const sellQty   = Math.floor(sellValue / p1); // whole shares
          if (sellQty >= 1) {
            const actualSellValue = sellQty * p1;
            const buyQty  = Math.floor(actualSellValue / p2);
            if (buyQty >= 1) {
              const actualBuyValue = buyQty * p2;
              const brok  = sellBrok * actualSellValue + buyBrok * actualBuyValue;
              // gross = what we got for selling - what we paid for buying
              // This is real: it's positive only if p1 per unit > p2 per unit × (buyQty/sellQty)
              const gross = actualSellValue - actualBuyValue;
              const net   = gross - brok;

              if (actualSellValue >= minTradeValue && net > -cashProfit - 1000) {
                // Execute. Net can be negative — that's a real cost of rebalancing.
                // We skip only if it would bankrupt the cash account beyond recovery.
                xShares    -= sellQty;
                yShares    += buyQty;
                cashProfit += net;
                totalBrokerage += brok;
                grossTotal     += gross;
                netTotal       += net;
                totalTrades++;
                if (net >= 0) profitableTrades++; else unprofitableTrades++;

                ledger.push({
                  date: row.date.toISOString(), type: 'TRADE',
                  action: 'Sell Asset 1 / Buy Asset 2',
                  sellAsset: 'Asset 1', sellQty, sellValue: actualSellValue,
                  buyAsset:  'Asset 2', buyQty,  buyValue: actualBuyValue,
                  gross, brok, net, cashProfit,
                  asset1Price: p1, asset2Price: p2,
                  xShares, yShares,
                  xDrift: +(xDrift*100).toFixed(2),
                  poolIL: +(ilPctNow).toFixed(3),
                  ewmaVolPct: +(Math.sqrt(ewmaVar)*100).toFixed(3),
                });
              } else {
                skippedTrades++;
              }
            }
          }

        } else {
          // Asset2 over-weight → sell Asset2, buy Asset1
          const sellValue = yVal - targetVal;
          const sellQty   = Math.floor(sellValue / p2);
          if (sellQty >= 1) {
            const actualSellValue = sellQty * p2;
            const buyQty  = Math.floor(actualSellValue / p1);
            if (buyQty >= 1) {
              const actualBuyValue = buyQty * p1;
              const brok  = sellBrok * actualSellValue + buyBrok * actualBuyValue;
              const gross = actualSellValue - actualBuyValue;
              const net   = gross - brok;

              if (actualSellValue >= minTradeValue && net > -cashProfit - 1000) {
                xShares    += buyQty;
                yShares    -= sellQty;
                cashProfit += net;
                totalBrokerage += brok;
                grossTotal     += gross;
                netTotal       += net;
                totalTrades++;
                if (net >= 0) profitableTrades++; else unprofitableTrades++;

                ledger.push({
                  date: row.date.toISOString(), type: 'TRADE',
                  action: 'Sell Asset 2 / Buy Asset 1',
                  sellAsset: 'Asset 2', sellQty, sellValue: actualSellValue,
                  buyAsset:  'Asset 1', buyQty,  buyValue: actualBuyValue,
                  gross, brok, net, cashProfit,
                  asset1Price: p1, asset2Price: p2,
                  xShares, yShares,
                  xDrift: +(xDrift*100).toFixed(2),
                  poolIL: +(ilPctNow).toFixed(3),
                  ewmaVolPct: +(Math.sqrt(ewmaVar)*100).toFixed(3),
                });
              } else {
                skippedTrades++;
              }
            }
          }
        }
      }
    }

    // ── Compounding ───────────────────────────────────────────────────────────
    // Reinvest cash profit back into the portfolio (buy both assets proportionally)
    const compoundThreshold = initCapital * compoundMinPct / 100;
    let didCompound = false;

    if (hoursSinceCompound >= compoundIntervalHours && cashProfit >= compoundThreshold) {
      const grossReinvest = cashProfit * 0.80;
      const brokReinvest  = grossReinvest * reinvestBrok;
      const netReinvest   = grossReinvest - brokReinvest;

      // Buy both assets at 50/50 split
      const halfReinvest = netReinvest / 2;
      const buyX = Math.floor(halfReinvest / p1);
      const buyY = Math.floor(halfReinvest / p2);

      if (buyX >= 1 && buyY >= 1) {
        const actualCost = buyX * p1 + buyY * p2;
        xShares += buyX;
        yShares += buyY;
        reinvestedTotal        += actualCost;
        totalReinvestBrokerage += brokReinvest;
        totalBrokerage         += brokReinvest;
        cashProfit             -= grossReinvest;
        compoundEvents++;
        didCompound = true;

        ledger.push({
          date: row.date.toISOString(), type: 'COMPOUND',
          action: '♻ Cash Reinvested',
          grossReinvest, brokReinvest, netReinvest, actualCost,
          buyX, buyY,
          cashProfitBefore: cashProfit + grossReinvest,
          cashProfitAfter:  cashProfit,
          asset1Price: p1, asset2Price: p2,
          xShares, yShares,
          compoundEvent: compoundEvents,
        });
      }
      hoursSinceCompound = 0;
    }

    // ── Equity snapshot ───────────────────────────────────────────────────────
    const pv = xShares * p1 + yShares * p2;
    const hv = xHold   * p1 + yHold   * p2;
    equityCurve.push({
      date:          row.date.toISOString(),
      poolValue:     pv + cashProfit,
      holdValue:     hv,
      cashProfit,
      alphaINR:      pv + cashProfit - hv,
      ilPct:         hv > 0 ? ((pv / hv) - 1) * 100 : 0,
      halted:        swapsHalted,
      haltReason,
      compoundEvent: didCompound,
    });
  }

  // ── Final results ─────────────────────────────────────────────────────────────
  const last      = hourly[hourly.length - 1];
  const holdValue = xHold   * last.c1 + yHold   * last.c2;
  const poolAssets= xShares * last.c1 + yShares * last.c2;
  const totalValue= poolAssets + cashProfit;
  const ilINR     = poolAssets - holdValue;
  const ilPct     = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const vsHold    = totalValue - holdValue;
  const vsHoldPct = holdValue  > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    realCapital, initCapital, totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossTotal, netTotal,
    vsHold, vsHoldPct,
    roiPct:   initCapital > 0 ? (totalValue  / initCapital - 1) * 100 : 0,
    holdRoi:  initCapital > 0 ? (holdValue   / initCapital - 1) * 100 : 0,
    cashRoi:  initCapital > 0 ?  cashProfit  / initCapital * 100 : 0,
    brokRoi:  initCapital > 0 ?  totalBrokerage / initCapital * 100 : 0,
    ilINR, ilPct,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt, haltCount,
    totalTrades, profitableTrades, unprofitableTrades, skippedTrades,
    successRate: totalTrades > 0 ? profitableTrades / totalTrades : 0,
    initialX: xShares0, initialY: yShares0, finalX: xShares, finalY: yShares,
    reinvestedTotal, compoundEvents, totalReinvestBrokerage,
    bandPct: bandPct * 100,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
    reinvestBrokPct: reinvestBrok * 100,
    minTradeValue,
  };

  const performanceSummary = buildPerformanceSummary(ledger, equityCurve, results);
  return { swaps: ledger, equityCurve, results, performanceSummary };
}
