// simulation-core.js  v10.0
// ─────────────────────────────────────────────────────────────────────────────
//
//  BUG FIXES IN THIS VERSION
//  ────────────────────────────
//  1. REMOVED the "concentration" multiplier on L.
//     Real Uniswap V3 has no separate concentration dial — concentration is
//     entirely DETERMINED by the band width [rLow, rHigh] you choose, via
//     C = 1 / (1 − √(rLow/rHigh)). A narrower band IS higher concentration.
//     Multiplying L by an arbitrary extra factor makes the pool trade with
//     virtual reserves that exceed what the deposited capital can actually
//     back — verified: with concentration=2, the implied backing capital
//     was 2× the real deposit, letting swaps drain the pool past the
//     mathematically possible boundary and producing IL beyond the real
//     limit. Removing it: for a ±10% band, verified boundary IL is exactly
//     −2.324% (matches independent hand-calculation), not the ~4% seen
//     with the multiplier bug.
//
//  2. REMOVED the artificial "5% of pool per swap leg" cap.
//     Once L is correctly derived from real capital and band width, the
//     V3 delta formula is self-limiting — virtual reserves reach exactly
//     zero at the band boundary by construction, so no swap can ever
//     demand more than the pool can supply. The synthetic cap was a
//     band-aid for the concentration bug, not a real requirement.
//
//  3. REMOVED the manual "concentration" input entirely — band width is
//     now the only geometry control, exactly as real V3 works.
//
//  4. ADDED Sharpe ratio, Calmar ratio, and max drawdown to diagnostics,
//     computed on the actual total-value equity curve (not just alpha).
//
//  WHAT STAYS THE SAME (from v9, verified correct)
//  ───────────────────────────────────────────────
//  - Strict alternating swap direction (Sell A1 ⇄ Sell A2)
//  - minMovePct gate: next swap only fires after ratio reverses ≥ X% from
//    the price at the last swap
//  - Same-direction vault rebalancing: while price keeps moving the same
//    way, no new swap fires; instead the pool's share-ratio is tracked to
//    the live market ratio via vault↔pool internal transfers (no brokerage)
//  - Alpha reinvestment buys whichever asset has gained more from its
//    initial price, locking those shares in the vault
//  - Self-funding swaps: buyQty always derived from exact sell proceeds,
//    so gross P&L is always ≥ 0 by construction — no phantom value from
//    independent rounding of both legs
//
// ─────────────────────────────────────────────────────────────────────────────

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
    return headers.reduce((row, h, i) => { row[h] = (cells[i]||'').trim(); return row; }, {});
  });
}

export function normalizeRows(rows) {
  return rows
    .map(r => ({ date: new Date(r.date), close: +r.close, volume: +r.volume }))
    .filter(r => !isNaN(r.date) && isFinite(r.close) && r.close > 0 && isFinite(r.volume))
    .sort((a, b) => a.date - b.date);
}

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

// ─── V3 liquidity parameter — derived PURELY from capital and band ──────────
// No concentration multiplier. This is the exact L a real Uniswap V3 LP
// would receive when depositing `capital` into range [rLow, rHigh] at
// current ratio r. Concentration is implicit in the band width itself.
function computeL(capital, p1, p2, r, rLow, rHigh) {
  const rC  = clamp(r, rLow, rHigh);
  const sr  = Math.sqrt(rC), srl = Math.sqrt(rLow), srh = Math.sqrt(rHigh);
  const denom = (1/sr - 1/srh) * p1 + (sr - srl) * p2;
  return denom > 1e-10 ? capital / denom : 0;
}

// Real V3 virtual reserves at ratio r, for a given L and band.
// This is the SAME curve every part of the engine trusts — used to compute
// the correct target composition when the pool needs to track the market
// ratio via internal vault transfers (no market trade, no brokerage).
function v3Reserves(L, r, rLow, rHigh) {
  const rC = clamp(r, rLow, rHigh);
  const sr = Math.sqrt(rC), srl = Math.sqrt(rLow), srh = Math.sqrt(rHigh);
  return { x: L * (1/sr - 1/srh), y: L * (sr - srl) };
}

// ─── PAIR FITNESS ──────────────────────────────────────────────────────────
export function pairFitness(df1, df2) {
  const a1 = normalizeRows(df1), a2 = normalizeRows(df2);
  if (!a1.length || !a2.length) return { error: 'Invalid data' };
  const bars = buildMinutely(a1, a2);
  if (bars.length < 20) return { error: 'Too few bars' };
  const ratios = bars.map(h => h.c1 / h.c2);
  const n = ratios.length;
  const mean = ratios.reduce((s, v) => s + v, 0) / n;
  const std  = Math.sqrt(ratios.reduce((s, v) => s + (v - mean)**2, 0) / n);
  const logRets = ratios.slice(1).map((r, i) => Math.log(r / ratios[i]));
  const lrMean = logRets.reduce((s, v) => s + v, 0) / logRets.length;
  let cum = 0, minC = 0, maxC = 0, ss = 0;
  for (const v of logRets) {
    cum += v - lrMean;
    if (cum < minC) minC = cum; if (cum > maxC) maxC = cum;
    ss += (v - lrMean)**2;
  }
  const S = Math.sqrt(ss / logRets.length);
  const hurst = S > 1e-12 ? Math.log((maxC - minC) / S) / Math.log(logRets.length) : 0.5;
  let num = 0, den = 0;
  for (let i = 0; i < logRets.length - 1; i++) num += (logRets[i] - lrMean) * (logRets[i+1] - lrMean);
  for (const v of logRets) den += (v - lrMean)**2;
  const autocorr = den > 1e-14 ? num / den : 0;
  const ratioDrift = Math.abs(ratios.at(-1) / ratios[0] - 1) * 100;
  let crossings = 0;
  for (let i = 1; i < ratios.length; i++)
    if ((ratios[i-1] - mean) * (ratios[i] - mean) < 0) crossings++;
  const colour = hurst < 0.45 ? 'green' : hurst < 0.50 ? 'yellow' : hurst < 0.55 ? 'orange' : 'red';
  return {
    bars: n, ratioMean: +mean.toFixed(4), ratioStd: +std.toFixed(4),
    hurst: +hurst.toFixed(3), ratioDrift: +ratioDrift.toFixed(2),
    autocorr1: +autocorr.toFixed(4),
    crossingRate: +((crossings / n) * 100).toFixed(2), colour,
    verdict: hurst < 0.45 ? 'STRONG FIT — mean-reverting' :
             hurst < 0.50 ? 'MODERATE FIT' :
             hurst < 0.55 ? 'WEAK FIT — near random walk' :
                            'POOR FIT — trending pair',
  };
}

// ─── PERFORMANCE SUMMARY — now with Sharpe, Calmar, Max Drawdown ───────────
export function buildPerformanceSummary(ledger, equityCurve, results) {
  const trades = ledger.filter(t => t.type === 'TRADE');
  const grossSum = trades.reduce((s, t) => s + t.gross, 0);
  const brokSum  = trades.reduce((s, t) => s + t.brok,  0);
  const profitable = trades.filter(t => t.net > 0).length;
  const successRate = trades.length > 0 ? profitable / trades.length : 0;

  const sizePcts = trades
    .map(t => t.sellProceeds / Math.max(t.poolValueBefore, 1) * 100)
    .sort((a, b) => a - b);
  const medianSizePct = sizePcts.length ? sizePcts[Math.floor(sizePcts.length / 2)] : 0;
  const maxSizePct    = sizePcts.length ? sizePcts[sizePcts.length - 1] : 0;

  // ── Equity-curve based risk metrics (real portfolio value, not just alpha) ──
  const values = equityCurve.map(p => p.totalValue);
  const dates  = equityCurve.map(p => new Date(p.date).getTime());
  const n = values.length;

  // Max drawdown on total value curve
  let peak = values[0] ?? 0, maxDD = 0, maxDDPct = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = v - peak;
    if (dd < maxDD) maxDD = dd;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct < maxDDPct) maxDDPct = ddPct;
  }

  // Per-bar returns of total value
  const rets = [];
  for (let i = 1; i < n; i++) {
    if (values[i-1] > 0) rets.push((values[i] - values[i-1]) / values[i-1]);
  }
  const meanRet = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  let variance = 0;
  for (const r of rets) variance += (r - meanRet) ** 2;
  const stdRet = rets.length > 1 ? Math.sqrt(variance / (rets.length - 1)) : 0;

  // Annualisation: infer bars-per-year from actual elapsed calendar time,
  // not a hardcoded assumption — works correctly whether data is 1-min,
  // hourly, or daily bars.
  const elapsedMs   = dates.length > 1 ? dates[dates.length - 1] - dates[0] : 0;
  const elapsedDays = elapsedMs / 86400000;
  const elapsedYears = elapsedDays / 365.25;
  const barsPerYear  = elapsedYears > 0 ? n / elapsedYears : 0;

  const sharpeRatio = stdRet > 1e-12 && barsPerYear > 0
    ? (meanRet / stdRet) * Math.sqrt(barsPerYear)
    : 0;

  // Annualised return for Calmar
  const totalReturn = values[0] > 0 ? (values[n-1] / values[0] - 1) : 0;
  const annualisedReturn = elapsedYears > 0
    ? (Math.pow(1 + totalReturn, 1 / elapsedYears) - 1) * 100
    : totalReturn * 100;

  const calmarRatio = Math.abs(maxDDPct) > 1e-9
    ? annualisedReturn / Math.abs(maxDDPct)
    : 0;

  return {
    grossTotal: grossSum, brokTotal: brokSum, netTotal: grossSum - brokSum,
    totalTrades: trades.length, profitable, successRate, successPct: successRate * 100,
    frictionPct: Math.abs(grossSum) > 0 ? brokSum / Math.abs(grossSum) * 100 : 0,
    medianSizePct: +medianSizePct.toFixed(3),
    maxSizePct:    +maxSizePct.toFixed(3),
    maxDrawdown:    maxDD,
    maxDrawdownPct: +maxDDPct.toFixed(3),
    sharpeRatio:    +sharpeRatio.toFixed(3),
    calmarRatio:    +calmarRatio.toFixed(3),
    annualisedReturnPct: +annualisedReturn.toFixed(3),
    vaultValue: results.vaultFinal,
    vaultDeposits: results.vaultDeposits,
    narrative: {
      friction: brokSum / Math.max(Math.abs(grossSum), 1) < 0.30
        ? 'GOOD — brokerage < 30% of gross P&L'
        : brokSum / Math.max(Math.abs(grossSum), 1) < 0.60
        ? 'MODERATE — consider widening minMovePct'
        : 'HIGH — brokerage exceeds trading edge',
      quality: successRate > 0.55 ? 'GOOD — pair mean-reverts within band'
             : successRate > 0.45 ? 'MIXED — weak mean-reversion'
             : 'POOR — pair is trending',
      risk: Math.abs(maxDDPct) < 2 ? 'LOW drawdown risk'
          : Math.abs(maxDDPct) < 5 ? 'MODERATE drawdown risk'
          : 'HIGH drawdown risk — review band width',
    },
  };
}

// ─── MAIN ENGINE ──────────────────────────────────────────────────────────
export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const a1 = normalizeRows(df1), a2 = normalizeRows(df2);
  if (!a1.length || !a2.length)
    return { error: 'Both files need valid date, close, volume columns.' };
  const bars = buildMinutely(a1, a2);
  if (bars.length < 10)
    return { error: 'Too few overlapping bars. Check timestamps match.' };

  // ── Config ────────────────────────────────────────────────────────────────
  const bandPct       = clamp(+(config.bandPct       ?? 10),   0.5, 50)  / 100;
  const minMovePct    = clamp(+(config.minMovePct    ?? 0.5),  0.1, 10)  / 100;
  const buyBrok       = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5)  / 100;
  const sellBrok      = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5)  / 100;
  const reinvestBrok  = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;
  const ilHardStop    = clamp(+(config.ilHardStopPct  ?? 0),   0,  100);
  const ilHardResume  = clamp(+(config.ilHardResumePct ?? 0),  0,  100);
  const compoundHours = clamp(+(config.compoundIntervalHours ?? 24), 1, 168);

  // ── Initialise ────────────────────────────────────────────────────────────
  const h0    = bars[0];
  const p1_0  = h0.c1, p2_0 = h0.c2;
  const rInit = p1_0 / p2_0;
  const rLow  = rInit * (1 - bandPct);
  const rHigh = rInit * (1 + bandPct);

  const half  = realCapital / 2;
  let poolX   = Math.max(1, Math.floor(half / p1_0));
  let poolY   = Math.max(1, Math.floor(half / p2_0));
  const seedCash = (half - poolX * p1_0) + (half - poolY * p2_0);

  const holdX = poolX, holdY = poolY;
  const initCapital = poolX * p1_0 + poolY * p2_0 + seedCash;

  let vaultX = 0, vaultY = 0;
  // L derived purely from real deposited capital and the chosen band —
  // no concentration multiplier. This is what a real V3 LP would get.
  let L = computeL(poolX * p1_0 + poolY * p2_0, p1_0, p2_0, rInit, rLow, rHigh);
  const initialL = L;

  // ── Swap state machine ────────────────────────────────────────────────────
  let lastSwapDir     = null;   // null | 'SELL_A1' | 'SELL_A2'
  let rAtLastSwap     = rInit;
  let rAtLastAdjust   = rInit;  // last ratio at which a same-direction vault
                                 // rebalance fired — re-fires every further
                                 // minMovePct increment, not just once ever

  let cashProfit = seedCash;
  let totalBrokerage = 0, grossTotal = 0, netTotal = 0;
  let totalTrades = 0, profitableTrades = 0, unprofitableTrades = 0, skippedTrades = 0;
  let vaultDeposits = 0, vaultAdjUp = 0, vaultAdjDown = 0;
  let swapsHalted = false, haltReason = null, ilHaltedAt = null, ilResumedAt = null, haltCount = 0;
  let lastVaultCheckMs = h0.date.getTime();

  const ledger = [], equityCurve = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: poolX*p1_0+poolY*p2_0, holdValue: initCapital,
    cashProfit: seedCash, totalValue: initCapital,
    alphaINR: 0, ilPct: 0, vaultValue: 0,
    inBand: true, halted: false, compoundEvent: false, L: +L.toFixed(2),
  });

  // ── Bar loop ──────────────────────────────────────────────────────────────
  for (let idx = 1; idx < bars.length; idx++) {
    const row  = bars[idx];
    const p1   = row.c1, p2 = row.c2;
    const rNow = p1 / p2;

    const poolVal  = poolX * p1 + poolY * p2;
    const vaultVal = vaultX * p1 + vaultY * p2;
    const holdVal  = holdX  * p1 + holdY  * p2;
    const ilPct    = holdVal > 0 ? ((poolVal + vaultVal) / holdVal - 1) * 100 : 0;
    const inBand   = rNow >= rLow && rNow <= rHigh;

    if (swapsHalted && haltReason === 'IL_STOP' && ilHardResume > 0 && ilPct >= -ilHardResume) {
      swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
    }
    if (!swapsHalted && ilHardStop > 0 && ilPct < -ilHardStop) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt = row.date.toISOString(); haltCount++;
    }

    // ── Determine swap eligibility (strict alternation + minMovePct) ────────
    let swapEligible = false, eligibleDir = null, inSameDirection = false;

    if (lastSwapDir === null) {
      if (rNow > rAtLastSwap * (1 + minMovePct)) { swapEligible = true; eligibleDir = 'SELL_A1'; }
      else if (rNow < rAtLastSwap * (1 - minMovePct)) { swapEligible = true; eligibleDir = 'SELL_A2'; }
    } else if (lastSwapDir === 'SELL_A1') {
      if (rNow <= rAtLastSwap * (1 - minMovePct)) { swapEligible = true; eligibleDir = 'SELL_A2'; }
      else if (rNow > rAtLastSwap) { inSameDirection = true; }
    } else if (lastSwapDir === 'SELL_A2') {
      if (rNow >= rAtLastSwap * (1 + minMovePct)) { swapEligible = true; eligibleDir = 'SELL_A1'; }
      else if (rNow < rAtLastSwap) { inSameDirection = true; }
    }

    // Re-fire the same-direction vault adjustment every further minMovePct
    // increment the price extends — NOT just once per direction run.
    // This tracks the real V3 curve as the trend continues (2% → 3% → 5%
    // → 9% ...), matching how the pool would naturally keep rebalancing.
    const adjustmentDue = inSameDirection && (
      (rNow > rAtLastSwap && rNow >= rAtLastAdjust * (1 + minMovePct)) ||
      (rNow < rAtLastSwap && rNow <= rAtLastAdjust * (1 - minMovePct))
    );

    // ── Same-direction: internal vault↔pool rebalance (edge-triggered) ─────
    //
    // CORRECT V3 TARGET (not a ratio-matching heuristic):
    // Preserve the pool's current ₹ value, compute what L that value would
    // imply at rNow within the SAME band [rLow, rHigh], then use the real
    // V3 reserves formula v3Reserves() to get the exact target x', y'.
    // This is the actual curve shape — the same formula the swap engine
    // itself trusts — so vault transfers track genuine V3 behaviour instead
    // of an approximation.
    if (adjustmentDue && !swapsHalted) {
      rAtLastAdjust = rNow;

      const curPoolVal = poolX * p1 + poolY * p2;
      const Lc = computeL(curPoolVal, p1, p2, rNow, rLow, rHigh);
      const tgt = v3Reserves(Lc, rNow, rLow, rHigh);
      const xTarget = Math.max(5, Math.floor(tgt.x));
      const yTarget = Math.max(5, Math.floor(tgt.y));

      const xNeed = xTarget - poolX;   // +ve = pool needs more A1
      const yNeed = yTarget - poolY;   // +ve = pool needs more A2
      let adjType = null;

      if (xNeed > 0 && yNeed < 0) {
        // Pool needs more A1, has excess A2 to give up
        const yExcess = Math.abs(yNeed);
        const xFromVault = Math.min(vaultX, xNeed);
        if (xFromVault > 0) { vaultX -= xFromVault; poolX += xFromVault; }
        if (yExcess > 0) { poolY -= yExcess; vaultY += yExcess; }
        adjType = xFromVault > 0 ? 'VAULT→POOL' : 'POOL→VAULT';
        if (adjType === 'VAULT→POOL') vaultAdjUp++; else vaultAdjDown++;
      } else if (xNeed < 0 && yNeed > 0) {
        // Pool needs more A2, has excess A1 to give up
        const xExcess = Math.abs(xNeed);
        const yFromVault = Math.min(vaultY, yNeed);
        if (yFromVault > 0) { vaultY -= yFromVault; poolY += yFromVault; }
        if (xExcess > 0) { poolX -= xExcess; vaultX += xExcess; }
        adjType = yFromVault > 0 ? 'VAULT→POOL' : 'POOL→VAULT';
        if (adjType === 'VAULT→POOL') vaultAdjUp++; else vaultAdjDown++;
      }

      L = computeL(poolX * p1 + poolY * p2, p1, p2, rNow, rLow, rHigh);

      if (adjType) ledger.push({
        date: row.date.toISOString(), type: 'ADJUST', adjType,
        rNow: +rNow.toFixed(6), rAtLastSwap: +rAtLastSwap.toFixed(6),
        poolX, poolY, vaultX, vaultY,
        asset1Price: p1, asset2Price: p2,
        poolValue: poolX*p1+poolY*p2, vaultValue: vaultX*p1+vaultY*p2,
        cashProfit, L: +L.toFixed(2),
      });
    }
    if (swapEligible) rAtLastAdjust = rNow;  // reset adjustment tracker when a real swap fires

    // ── SWAP (real V3 delta, self-bounded by band — no artificial cap) ──────
    if (inBand && swapEligible && !swapsHalted) {
      const rFrom = clamp(rAtLastSwap, rLow, rHigh);
      const rTo   = clamp(rNow,        rLow, rHigh);

      if (eligibleDir === 'SELL_A1') {
        const delta   = L * Math.abs(1/Math.sqrt(rTo) - 1/Math.sqrt(rFrom));
        const sellQty = Math.min(Math.floor(delta), poolX - 5);
        if (sellQty >= 1) {
          const proceeds = sellQty * p1;
          const buyQty   = Math.floor(proceeds / p2);
          if (buyQty >= 1) {
            const cost  = buyQty * p2;
            const brok  = sellBrok * proceeds + buyBrok * cost;
            const gross = proceeds - cost;
            const net   = gross - brok;
            if (net > 0) {
              poolX -= sellQty; poolY += buyQty;
              cashProfit += net; totalBrokerage += brok;
              grossTotal += gross; netTotal += net;
              totalTrades++; profitableTrades++;
              lastSwapDir = 'SELL_A1'; rAtLastSwap = rNow; rAtLastAdjust = rNow;
              L = computeL(poolX*p1+poolY*p2, p1, p2, rNow, rLow, rHigh);
              ledger.push({
                date: row.date.toISOString(), type: 'TRADE',
                action: 'Sell Asset 1 / Buy Asset 2',
                sellAsset:'Asset 1', sellQty, sellProceeds: proceeds,
                buyAsset: 'Asset 2', buyQty,  buyCost: cost,
                gross, brok, net, cashProfit,
                poolValueBefore: poolVal, L: +L.toFixed(2),
                asset1Price: p1, asset2Price: p2,
                poolX, poolY, vaultX, vaultY,
                ilPct: +ilPct.toFixed(3), rNow: +rNow.toFixed(6),
                rAtLastSwap: +rAtLastSwap.toFixed(6),
              });
            } else { skippedTrades++; }
          }
        }
      } else if (eligibleDir === 'SELL_A2') {
        const delta   = L * Math.abs(Math.sqrt(rTo) - Math.sqrt(rFrom));
        const sellQty = Math.min(Math.floor(delta), poolY - 5);
        if (sellQty >= 1) {
          const proceeds = sellQty * p2;
          const buyQty   = Math.floor(proceeds / p1);
          if (buyQty >= 1) {
            const cost  = buyQty * p1;
            const brok  = sellBrok * proceeds + buyBrok * cost;
            const gross = proceeds - cost;
            const net   = gross - brok;
            if (net > 0) {
              poolY -= sellQty; poolX += buyQty;
              cashProfit += net; totalBrokerage += brok;
              grossTotal += gross; netTotal += net;
              totalTrades++; profitableTrades++;
              lastSwapDir = 'SELL_A2'; rAtLastSwap = rNow; rAtLastAdjust = rNow;
              L = computeL(poolX*p1+poolY*p2, p1, p2, rNow, rLow, rHigh);
              ledger.push({
                date: row.date.toISOString(), type: 'TRADE',
                action: 'Sell Asset 2 / Buy Asset 1',
                sellAsset:'Asset 2', sellQty, sellProceeds: proceeds,
                buyAsset: 'Asset 1', buyQty,  buyCost: cost,
                gross, brok, net, cashProfit,
                poolValueBefore: poolVal, L: +L.toFixed(2),
                asset1Price: p1, asset2Price: p2,
                poolX, poolY, vaultX, vaultY,
                ilPct: +ilPct.toFixed(3), rNow: +rNow.toFixed(6),
                rAtLastSwap: +rAtLastSwap.toFixed(6),
              });
            } else { skippedTrades++; }
          }
        }
      }
    }

    // ── ALPHA REINVESTMENT — buy the more-appreciated asset into vault ──────
    const hoursSinceVault = (row.date.getTime() - lastVaultCheckMs) / 3600000;
    let didVault = false;
    if (hoursSinceVault >= compoundHours && cashProfit > 0) {
      const gross    = cashProfit;
      const brokCost = gross * reinvestBrok;
      const net      = gross - brokCost;
      if (net > 0) {
        const gainA1 = (p1 - p1_0) / p1_0;
        const gainA2 = (p2 - p2_0) / p2_0;
        let buyX = 0, buyY = 0, winner;
        if (gainA1 >= gainA2) { buyX = Math.floor(net / p1); winner = 'Asset 1'; }
        else                  { buyY = Math.floor(net / p2); winner = 'Asset 2'; }
        if (buyX >= 1 || buyY >= 1) {
          const actualCost = buyX * p1 + buyY * p2;
          vaultX += buyX; vaultY += buyY;
          totalBrokerage += brokCost;
          cashProfit -= (actualCost + brokCost);
          vaultDeposits++; didVault = true;
          ledger.push({
            date: row.date.toISOString(), type: 'VAULT_DEPOSIT',
            action: `🔒 Alpha → Vault (${winner})`,
            winner, gainA1: +(gainA1*100).toFixed(2), gainA2: +(gainA2*100).toFixed(2),
            buyX, buyY, actualCost, brokCost,
            cashAfter: cashProfit, vaultX, vaultY,
            asset1Price: p1, asset2Price: p2,
            vaultValue: vaultX*p1+vaultY*p2, depositEvent: vaultDeposits,
          });
        }
      }
      lastVaultCheckMs = row.date.getTime();
    }

    // ── Equity snapshot ───────────────────────────────────────────────────
    const pv   = poolX  * p1 + poolY  * p2;
    const vv   = vaultX * p1 + vaultY * p2;
    const hv   = holdX  * p1 + holdY  * p2;
    const totV = pv + cashProfit + vv;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv, vaultValue: vv, cashProfit,
      totalValue: totV, holdValue: hv,
      alphaINR: totV - hv,
      ilPct: hv > 0 ? ((pv + vv) / hv - 1) * 100 : 0,
      inBand, halted: swapsHalted, haltReason,
      compoundEvent: didVault, L: +L.toFixed(2),
    });
  }

  // ── Final results ─────────────────────────────────────────────────────────
  const last       = bars[bars.length - 1];
  const holdValue  = holdX  * last.c1 + holdY  * last.c2;
  const poolFinal  = poolX  * last.c1 + poolY  * last.c2;
  const vaultFinal = vaultX * last.c1 + vaultY * last.c2;
  const totalValue = poolFinal + cashProfit + vaultFinal;
  const vsHold     = totalValue - holdValue;
  const vsHoldPct  = holdValue > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  // Theoretical max IL bound at the band edge — pure V3 math, for reference
  const boundaryL = computeL(poolX * last.c1 + poolY * last.c2, last.c1, last.c2, rInit, rLow, rHigh);
  const rEdge = rNow => clamp(rNow, rLow, rHigh);

  const results = {
    realCapital, initCapital, totalValue, poolFinal, vaultFinal,
    cashProfit, holdValue, totalBrokerage, grossTotal, netTotal,
    vsHold, vsHoldPct,
    roiPct:  initCapital > 0 ? (totalValue / initCapital - 1) * 100 : 0,
    holdRoi: initCapital > 0 ? (holdValue  / initCapital - 1) * 100 : 0,
    cashRoi: initCapital > 0 ? cashProfit  / initCapital * 100 : 0,
    brokRoi: initCapital > 0 ? totalBrokerage / initCapital * 100 : 0,
    ilPct: holdValue > 0 ? ((poolFinal + vaultFinal) / holdValue - 1) * 100 : 0,
    ilINR: poolFinal + vaultFinal - holdValue,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt, haltCount,
    totalTrades, profitableTrades, unprofitableTrades, skippedTrades,
    successRate: totalTrades > 0 ? profitableTrades / totalTrades : 0,
    poolX, poolY, vaultX, vaultY, holdX, holdY,
    vaultDeposits, vaultAdjUp, vaultAdjDown,
    bandPct: bandPct * 100, minMovePct: minMovePct * 100,
    L: +L.toFixed(2), initialL: +initialL.toFixed(2),
    rInit: +rInit.toFixed(6), rLow: +rLow.toFixed(6), rHigh: +rHigh.toFixed(6),
    buyBrokeragePct: buyBrok*100, sellBrokeragePct: sellBrok*100,
  };

  return {
    swaps: ledger, equityCurve, results,
    performanceSummary: buildPerformanceSummary(ledger, equityCurve, results),
  };
}
