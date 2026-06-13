// simulation-core.js  v5.1  —  Real-world 50/50 pair rebalancing
// ─────────────────────────────────────────────────────────────────
//
//  STRATEGY
//  ─────────
//  Hold two NSE stocks. Every hour, compute what a perfect 50/50 split
//  by value looks like at current prices. If the target share counts
//  differ from what the portfolio holds, execute the rebalance trade.
//
//  No band. No minimum trade filter. The market moves every hour and the
//  portfolio responds every hour. That is what a real automated system does.
//
//  WHAT IS TRADEABLE EACH HOUR
//  ────────────────────────────
//  Total portfolio value V = xShares*p1 + yShares*p2
//  Target shares of Asset1: x_target = floor(V/2 / p1)
//  Target shares of Asset2: y_target = floor(V/2 / p2)
//
//  If x_target > xShares  → buy (x_target - xShares) Asset1
//                           sell enough Asset2 to fund it
//  If x_target < xShares  → sell (xShares - x_target) Asset1
//                           buy Asset2 with the proceeds
//
//  Both legs are sized from the same ₹ amount so they are always self-funding.
//  Brokerage is charged on both legs. Net P&L = gross − brokerage.
//  Cash account accumulates net P&L; can go negative.
//
//  GROSS P&L PER TRADE (correct definition)
//  ──────────────────────────────────────────
//  gross = sell_proceeds − buy_cost
//        = sellQty*pSell − buyQty*pBuy
//
//  This is positive when the sold asset's total value exceeds the bought
//  asset's total value. It is zero when prices are equal. It can be
//  negative. It has NOTHING to do with floor-division remainder.
//
//  COMPOUNDING
//  ────────────
//  Accumulated cash profit is reinvested as additional shares every N hours.
//  Brokerage is charged on reinvestment. Shares are bought at current prices.
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

function updateEWMA(prevVar, logRet, lam = 0.94) {
  return lam * prevVar + (1 - lam) * logRet * logRet;
}

// ─── Performance summary ──────────────────────────────────────────────────────
export function buildPerformanceSummary(ledger, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6.5);
  const trades     = ledger.filter(t => t.type === 'TRADE');
  const grossTotal = trades.reduce((s, t) => s + t.gross, 0);
  const brokTotal  = trades.reduce((s, t) => s + t.brok,  0);
  const profitable = trades.filter(t => t.net > 0).length;
  const successRate = trades.length > 0 ? profitable / trades.length : 0;
  const frictionRatio = Math.abs(grossTotal) > 0 ? brokTotal / Math.abs(grossTotal) : 1;

  const alpha = equityCurve.map(p => p.poolValue - p.holdValue);
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) {
    if (v > peak) peak = v;
    if (v - peak < maxDD) maxDD = v - peak;
  }
  const maxDDPct = results.holdValue > 0 ? maxDD / results.holdValue * 100 : 0;

  const aRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mr = aRets.length ? aRets.reduce((s, v) => s + v, 0) / aRets.length : 0;
  let vv = 0; for (const v of aRets) vv += (v - mr) ** 2;
  const sd = aRets.length > 1 ? Math.sqrt(vv / (aRets.length - 1)) : 1e-9;

  return {
    grossTotal, brokTotal, netCash: results.cashProfit,
    frictionRatio, frictionPct: frictionRatio * 100,
    totalTrades: trades.length, profitable,
    successRate, successPct: successRate * 100,
    maxDrawdownINR: maxDD, maxDrawdownPct: maxDDPct,
    alphaSharpe: sd > 1e-12 ? (mr / sd) * ANNUALISE : 0,
    reinvestedTotal: results.reinvestedTotal,
    compoundEvents:  results.compoundEvents,
    narrative: {
      friction: frictionRatio < 0.40 ? 'ACCEPTABLE — brokerage < 40% of gross P&L'
               : frictionRatio < 0.80 ? 'HIGH — brokerage eroding most of the edge'
               : 'VERY HIGH — brokerage exceeds trading edge',
      quality: successRate > 0.55 ? 'GOOD — pair is mean-reverting'
             : successRate > 0.45 ? 'MIXED — weak mean-reversion'
             : 'POOR — pair is trending, not mean-reverting',
      alpha: results.vsHold >= 0
        ? `Outperforms hold by ₹${Math.abs(results.vsHold).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
        : `Underperforms hold by ₹${Math.abs(results.vsHold).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
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
  const buyBrok      = clamp(+(config.buyBrokeragePct      ?? 0.15), 0, 5) / 100;
  const sellBrok     = clamp(+(config.sellBrokeragePct     ?? 0.15), 0, 5) / 100;
  const reinvestBrok = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;

  const ilHardStop   = clamp(+(config.ilHardStopPct  ?? 0), 0, 100);
  const ilHardResume = clamp(+(config.ilHardResumePct ?? 0), 0, 100);

  const compoundIntervalHours = clamp(+(config.compoundIntervalHours ?? 24),  1, 168);
  const compoundMinPct        = clamp(+(config.compoundMinPct        ?? 0.5), 0.01, 10);

  // ── Initialise ────────────────────────────────────────────────────────────────
  const h0   = hourly[0];
  const p1_0 = h0.c1, p2_0 = h0.c2;

  // Deploy capital 50/50 — integer shares only, no fractional positions
  const xShares0 = Math.max(1, Math.floor(realCapital / 2 / p1_0));
  const yShares0 = Math.max(1, Math.floor(realCapital / 2 / p2_0));

  let xShares = xShares0;
  let yShares = yShares0;

  // Hold benchmark — identical initial shares, never touched
  const xHold = xShares0;
  const yHold = yShares0;

  // initCapital = exactly what was deployed (integer shares × price)
  const initCapital = xShares0 * p1_0 + yShares0 * p2_0;

  // Cash account — accumulates net P&L from every trade, can go negative
  let cashProfit = 0;

  // ── State ─────────────────────────────────────────────────────────────────────
  let totalBrokerage     = 0;
  let grossTotal         = 0;
  let netTotal           = 0;
  let totalTrades        = 0;
  let profitableTrades   = 0;
  let unprofitableTrades = 0;
  let reinvestedTotal    = 0;
  let compoundEvents     = 0;
  let totalReinvestBrok  = 0;

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
    date: h0.date.toISOString(),
    poolValue: initCapital, holdValue: initCapital,
    cashProfit: 0, alphaINR: 0, ilPct: 0,
    halted: false, compoundEvent: false,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1, p2 = row.c2;
    const prev = hourly[idx - 1];

    ewmaVar = updateEWMA(ewmaVar, Math.log((p1/p2) / (prev.c1/prev.c2)));
    hoursSinceCompound++;

    const xVal  = xShares * p1;
    const yVal  = yShares * p2;
    const hvNow = xHold   * p1 + yHold * p2;
    const ilPctNow = hvNow > 0 ? ((xVal + yVal) / hvNow - 1) * 100 : 0;

    // IL hard stop / resume
    if (swapsHalted && haltReason === 'IL_STOP' && ilHardResume > 0 && ilPctNow >= -ilHardResume) {
      swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
    }
    if (!swapsHalted && ilHardStop > 0 && ilPctNow < -ilHardStop) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt  = row.date.toISOString(); haltCount++;
    }

    // ── Rebalance every hour ──────────────────────────────────────────────────
    //
    // Compute what a perfect 50/50 split looks like at today's prices.
    // Trade only the difference between current holdings and target.
    //
    // Example:
    //   Portfolio: 100 RELIANCE @ ₹2500 + 400 KOTAK @ ₹1800
    //   Total = ₹2,50,000 + ₹7,20,000 = ₹9,70,000
    //   Target each side = ₹4,85,000
    //   Target RELIANCE = floor(485000 / 2500) = 194 shares
    //   Target KOTAK    = floor(485000 / 1800) = 269 shares
    //   → Buy 94 RELIANCE, sell 131 KOTAK
    //
    // The sell leg funds the buy leg. Both at current market price.

    let didTrade = false;
    if (!swapsHalted) {
      const totalV  = xVal + yVal;
      const halfV   = totalV / 2;
      const xTarget = Math.max(1, Math.floor(halfV / p1));
      const yTarget = Math.max(1, Math.floor(halfV / p2));

      const xDelta = xTarget - xShares;  // +ve = need to buy Asset1
      const yDelta = yTarget - yShares;  // +ve = need to buy Asset2

      // Exactly one side sells, the other buys.
      // xDelta and yDelta have opposite signs (when one rises, other falls).
      if (xDelta > 0 && yDelta < 0) {
        // Buy Asset1, sell Asset2
        const buyQty  = xDelta;
        const sellQty = Math.abs(yDelta);
        if (buyQty >= 1 && sellQty >= 1 && sellQty < yShares) {
          const buyValue  = buyQty  * p1;
          const sellValue = sellQty * p2;
          const brok = buyBrok * buyValue + sellBrok * sellValue;
          const gross = sellValue - buyValue;   // real P&L: sold yAsset, bought xAsset
          const net   = gross - brok;

          xShares += buyQty;
          yShares -= sellQty;
          cashProfit     += net;
          totalBrokerage += brok;
          grossTotal     += gross;
          netTotal       += net;
          totalTrades++;
          if (net >= 0) profitableTrades++; else unprofitableTrades++;
          didTrade = true;

          ledger.push({
            date: row.date.toISOString(), type: 'TRADE',
            action: 'Buy Asset 1 / Sell Asset 2',
            buyAsset: 'Asset 1', buyQty,  buyValue,
            sellAsset:'Asset 2', sellQty, sellValue,
            gross, brok, net, cashProfit,
            asset1Price: p1, asset2Price: p2,
            xShares, yShares,
            ilPct: +(ilPctNow).toFixed(3),
            ewmaVolPct: +(Math.sqrt(ewmaVar) * 100).toFixed(3),
          });
        }

      } else if (xDelta < 0 && yDelta > 0) {
        // Sell Asset1, buy Asset2
        const sellQty = Math.abs(xDelta);
        const buyQty  = yDelta;
        if (sellQty >= 1 && buyQty >= 1 && sellQty < xShares) {
          const sellValue = sellQty * p1;
          const buyValue  = buyQty  * p2;
          const brok = sellBrok * sellValue + buyBrok * buyValue;
          const gross = sellValue - buyValue;
          const net   = gross - brok;

          xShares -= sellQty;
          yShares += buyQty;
          cashProfit     += net;
          totalBrokerage += brok;
          grossTotal     += gross;
          netTotal       += net;
          totalTrades++;
          if (net >= 0) profitableTrades++; else unprofitableTrades++;
          didTrade = true;

          ledger.push({
            date: row.date.toISOString(), type: 'TRADE',
            action: 'Sell Asset 1 / Buy Asset 2',
            sellAsset:'Asset 1', sellQty, sellValue,
            buyAsset: 'Asset 2', buyQty,  buyValue,
            gross, brok, net, cashProfit,
            asset1Price: p1, asset2Price: p2,
            xShares, yShares,
            ilPct: +(ilPctNow).toFixed(3),
            ewmaVolPct: +(Math.sqrt(ewmaVar) * 100).toFixed(3),
          });
        }
      }
      // If xDelta=0 and yDelta=0: already at target, no trade needed
    }

    // ── Compounding ───────────────────────────────────────────────────────────
    const compoundThreshold = initCapital * compoundMinPct / 100;
    let didCompound = false;

    if (hoursSinceCompound >= compoundIntervalHours && cashProfit >= compoundThreshold) {
      const grossReinvest = cashProfit * 0.80;
      const brokReinvest  = grossReinvest * reinvestBrok;
      const netReinvest   = grossReinvest - brokReinvest;
      const halfR         = netReinvest / 2;
      const buyX          = Math.floor(halfR / p1);
      const buyY          = Math.floor(halfR / p2);

      if (buyX >= 1 && buyY >= 1) {
        const actualCost = buyX * p1 + buyY * p2;
        xShares += buyX;
        yShares += buyY;
        reinvestedTotal += actualCost;
        totalReinvestBrok += brokReinvest;
        totalBrokerage    += brokReinvest;
        cashProfit        -= grossReinvest;
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
          xShares, yShares, compoundEvent: compoundEvents,
        });
      }
      hoursSinceCompound = 0;
    }

    // ── Equity snapshot ───────────────────────────────────────────────────────
    const pv = xShares * p1 + yShares * p2;
    const hv = xHold   * p1 + yHold   * p2;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue:  pv + cashProfit,
      holdValue:  hv,
      cashProfit,
      alphaINR:   pv + cashProfit - hv,
      ilPct:      hv > 0 ? (pv / hv - 1) * 100 : 0,
      halted:     swapsHalted,
      haltReason,
      compoundEvent: didCompound,
    });
  }

  // ── Final results ─────────────────────────────────────────────────────────────
  const last       = hourly[hourly.length - 1];
  const holdValue  = xHold   * last.c1 + yHold   * last.c2;
  const poolAssets = xShares * last.c1 + yShares * last.c2;
  const totalValue = poolAssets + cashProfit;
  const ilINR      = poolAssets - holdValue;
  const ilPct      = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const vsHold     = totalValue - holdValue;
  const vsHoldPct  = holdValue  > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    realCapital, initCapital, totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossTotal, netTotal,
    vsHold, vsHoldPct,
    roiPct:  initCapital > 0 ? (totalValue / initCapital - 1) * 100 : 0,
    holdRoi: initCapital > 0 ? (holdValue  / initCapital - 1) * 100 : 0,
    cashRoi: initCapital > 0 ? cashProfit  / initCapital * 100 : 0,
    brokRoi: initCapital > 0 ? totalBrokerage / initCapital * 100 : 0,
    ilINR, ilPct, swapsHalted, haltReason, ilHaltedAt, ilResumedAt, haltCount,
    totalTrades, profitableTrades, unprofitableTrades,
    successRate: totalTrades > 0 ? profitableTrades / totalTrades : 0,
    initialX: xShares0, initialY: yShares0, finalX: xShares, finalY: yShares,
    reinvestedTotal, compoundEvents,
    totalReinvestBrokerage: totalReinvestBrok,
    reinvestBrokPct: reinvestBrok * 100,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
  };

  return {
    swaps: ledger, equityCurve, results,
    performanceSummary: buildPerformanceSummary(ledger, equityCurve, results),
  };
}
