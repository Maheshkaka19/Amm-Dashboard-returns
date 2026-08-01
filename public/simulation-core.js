// simulation-core.js  v9.0
// ─────────────────────────────────────────────────────────────────────────────
//
//  EXACT MECHANICS
//  ────────────────
//
//  POOL STATE MACHINE — strict alternating swaps
//  ───────────────────────────────────────────────
//  lastSwapDir ∈ { null, 'SELL_A1', 'SELL_A2' }
//  rAtLastSwap = ratio at the moment the last swap fired
//
//  A swap is eligible only when:
//    1. Direction alternates from lastSwapDir
//    2. Ratio has moved ≥ minMovePct in the new direction since rAtLastSwap
//       i.e. if lastSwapDir='SELL_A1' (ratio rose), next swap needs
//            rNow ≤ rAtLastSwap × (1 − minMovePct)  [ratio fell ≥ minMovePct]
//       and  if lastSwapDir='SELL_A2' (ratio fell), next swap needs
//            rNow ≥ rAtLastSwap × (1 + minMovePct)  [ratio rose ≥ minMovePct]
//    3. Both legs are profitable after brokerage (net > 0)
//    4. Pool is inside the band [rLow, rHigh]
//
//  When price keeps moving in the SAME direction as the last swap:
//    → No new swap fires.
//    → Vault checks: can it move shares to bring pool ratio to rNow?
//      YES (vault has enough of the needed asset) → VAULT→POOL transfer
//      NO                                         → POOL→VAULT transfer
//    This is an internal share transfer, not a market trade. No brokerage.
//    Fires edge-triggered once per continuous out-of-direction run.
//
//  ALPHA REINVESTMENT
//  ───────────────────
//  Every compoundIntervalHours, if cashProfit > threshold:
//    Identify which of the two stocks has appreciated MORE from its price
//    at pool initialisation (p1_0, p2_0):
//      gainA1 = (p1 − p1_0) / p1_0
//      gainA2 = (p2 − p2_0) / p2_0
//    Buy shares of whichever has the higher gain (the winner).
//    Lock bought shares in the vault — available for future vault→pool use.
//    Brokerage charged on the buy.
//
//  V3 SWAP SIZING
//  ───────────────
//  L = concentration × poolValue / [ (1/√rInit − 1/√rHigh)×p1
//                                   + (√rInit   −   √rLow) ×p2 ]
//
//  When eligible swap fires (ratio moved ≥ minMovePct in alternate direction):
//    delta = L × |1/√rNow − 1/√rAtLastSwap|   for the sell asset
//    sellQty = min(floor(delta), poolSell − 5, floor(poolVal×maxLegPct/pSell))
//    buyQty  = floor(sellQty × pSell / pBuy)     ← derived from proceeds
//    Execute only when net = (sellQty×pSell − buyQty×pBuy) − brokerage > 0
//
//  ROUNDING
//  ─────────
//  buyQty always derived from exact sell proceeds → gross ≥ 0 always.
//  Pool floor = 5 shares on each side.
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

function computeL(concentration, capital, p1, p2, r, rLow, rHigh) {
  const rC  = clamp(r, rLow, rHigh);
  const sr  = Math.sqrt(rC), srl = Math.sqrt(rLow), srh = Math.sqrt(rHigh);
  const denom = (1/sr - 1/srh) * p1 + (sr - srl) * p2;
  return denom > 1e-10 ? concentration * capital / denom : 0;
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

// ─── PERFORMANCE SUMMARY ──────────────────────────────────────────────────
export function buildPerformanceSummary(ledger, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 375);
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
  const thrashCount   = sizePcts.filter(p => p > 20).length;

  const alpha = equityCurve.map(p => p.totalValue - p.holdValue);
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) { if (v > peak) peak = v; if (v - peak < maxDD) maxDD = v - peak; }
  const aRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mr = aRets.reduce((s, v) => s + v, 0) / (aRets.length || 1);
  let vv = 0; for (const v of aRets) vv += (v - mr)**2;
  const sd = Math.sqrt(vv / Math.max(aRets.length - 1, 1));

  return {
    grossTotal: grossSum, brokTotal: brokSum, netTotal: grossSum - brokSum,
    totalTrades: trades.length, profitable, successRate, successPct: successRate * 100,
    frictionPct: Math.abs(grossSum) > 0 ? brokSum / Math.abs(grossSum) * 100 : 0,
    medianSizePct: +medianSizePct.toFixed(2),
    maxSizePct:    +maxSizePct.toFixed(2),
    thrashCount,
    maxDrawdown: maxDD,
    maxDrawdownPct: results.holdValue > 0 ? maxDD / results.holdValue * 100 : 0,
    alphaSharpe: sd > 1e-12 ? (mr / sd) * ANNUALISE : 0,
    vaultValue: results.vaultFinal,
    vaultDeposits: results.vaultDeposits,
    narrative: {
      sizing: thrashCount === 0
        ? `HEALTHY — max single swap was ${maxSizePct.toFixed(2)}% of pool`
        : `WARNING — ${thrashCount} swaps exceeded 20% of pool`,
      friction: brokSum / Math.max(Math.abs(grossSum), 1) < 0.30
        ? 'GOOD — brokerage < 30% of gross P&L'
        : brokSum / Math.max(Math.abs(grossSum), 1) < 0.60
        ? 'MODERATE — consider widening minMovePct'
        : 'HIGH — brokerage exceeds trading edge',
      quality: successRate > 0.55 ? 'GOOD — pair mean-reverts within band'
             : successRate > 0.45 ? 'MIXED — weak mean-reversion'
             : 'POOR — pair is trending',
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
  const bandPct       = clamp(+(config.bandPct       ?? 5),    0.5, 50)  / 100;
  const concentration = clamp(+(config.concentration  ?? 2),   1,   20);
  const minMovePct    = clamp(+(config.minMovePct     ?? 0.5), 0.1, 10)  / 100;
  const buyBrok       = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5)  / 100;
  const sellBrok      = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5)  / 100;
  const reinvestBrok  = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;
  const ilHardStop    = clamp(+(config.ilHardStopPct  ?? 0),   0,  100);
  const ilHardResume  = clamp(+(config.ilHardResumePct ?? 0),  0,  100);
  const compoundHours = clamp(+(config.compoundIntervalHours ?? 24), 1, 168);
  const maxLegPct     = 0.05;   // hard cap: max 5% of pool per trade leg

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
  let L = computeL(concentration, poolX * p1_0 + poolY * p2_0, p1_0, p2_0, rInit, rLow, rHigh);
  const initialL = L;

  // ── Swap state machine ────────────────────────────────────────────────────
  // lastSwapDir: null | 'SELL_A1' | 'SELL_A2'
  // rAtLastSwap: the ratio when the last swap fired (used to measure minMovePct)
  // sameDirectionLock: true while price keeps moving the same way as last swap
  //   → prevents new swap, triggers vault check instead (edge-triggered)
  let lastSwapDir       = null;
  let rAtLastSwap       = rInit;
  let sameDirectionLock = false;   // edge-trigger: vault adj fires once per run

  // ── General state ─────────────────────────────────────────────────────────
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

    // IL stop
    if (swapsHalted && haltReason === 'IL_STOP' && ilHardResume > 0 && ilPct >= -ilHardResume) {
      swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
    }
    if (!swapsHalted && ilHardStop > 0 && ilPct < -ilHardStop) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt = row.date.toISOString(); haltCount++;
    }

    // ── Determine swap direction eligibility ──────────────────────────────
    // After a SELL_A1 swap (ratio rose), the NEXT eligible swap is SELL_A2
    // which requires ratio to FALL ≥ minMovePct from rAtLastSwap.
    // After a SELL_A2 swap (ratio fell), the NEXT eligible swap is SELL_A1
    // which requires ratio to RISE ≥ minMovePct from rAtLastSwap.
    //
    // "Same direction" = ratio continuing to move AWAY from mean in the
    // direction of the last swap (further rise after SELL_A1, further fall
    // after SELL_A2).

    let swapEligible = false;
    let eligibleDir  = null;   // 'SELL_A1' or 'SELL_A2'
    let inSameDirection = false;

    if (lastSwapDir === null) {
      // No swap yet — first eligible swap is whichever direction ratio has moved
      if (rNow > rAtLastSwap * (1 + minMovePct)) {
        swapEligible = true; eligibleDir = 'SELL_A1';
      } else if (rNow < rAtLastSwap * (1 - minMovePct)) {
        swapEligible = true; eligibleDir = 'SELL_A2';
      }
    } else if (lastSwapDir === 'SELL_A1') {
      // Last swap sold A1 (ratio rose). Next must be SELL_A2 (ratio falls).
      if (rNow <= rAtLastSwap * (1 - minMovePct)) {
        swapEligible = true; eligibleDir = 'SELL_A2';
      } else if (rNow > rAtLastSwap) {
        // Ratio STILL rising — same direction as last swap
        inSameDirection = true;
      }
    } else if (lastSwapDir === 'SELL_A2') {
      // Last swap sold A2 (ratio fell). Next must be SELL_A1 (ratio rises).
      if (rNow >= rAtLastSwap * (1 + minMovePct)) {
        swapEligible = true; eligibleDir = 'SELL_A1';
      } else if (rNow < rAtLastSwap) {
        // Ratio STILL falling — same direction as last swap
        inSameDirection = true;
      }
    }

    // ── Same-direction: vault rebalance (edge-triggered once per run) ──────
    if (inSameDirection && !swapsHalted && !sameDirectionLock) {
      sameDirectionLock = true;

      // Target: poolX/poolY = rNow  (track current market ratio)
      // We cannot trade — only move shares between pool and vault.
      let adjType = null;

      if (rNow > rAtLastSwap) {
        // Ratio rising → pool needs more A1, less A2
        // Fix poolX, derive poolY = floor(poolX / rNow), shed excess A2
        if (vaultX > 0) {
          const poolY_want = Math.floor(poolX / rNow);
          const yAdd = Math.min(vaultX, Math.max(0, poolY_want - poolY));
          // Actually we need A1 from vault to increase poolX
          const xAdd = Math.min(vaultX, Math.max(0, Math.floor(poolY * rNow) - poolX));
          if (xAdd > 0) { vaultX -= xAdd; poolX += xAdd; }
          adjType = 'VAULT→POOL'; vaultAdjUp++;
        }
        const poolY_target = Math.max(5, Math.floor(poolX / rNow));
        const yShed = poolY - poolY_target;
        if (yShed > 0) { poolY -= yShed; vaultY += yShed; if (!adjType) { adjType = 'POOL→VAULT'; vaultAdjDown++; } }
        if (!adjType) { adjType = 'POOL→VAULT'; vaultAdjDown++; }

      } else {
        // Ratio falling → pool needs more A2, less A1
        if (vaultY > 0) {
          const yAdd = Math.min(vaultY, Math.max(0, Math.floor(poolX / rNow) - poolY));
          if (yAdd > 0) { vaultY -= yAdd; poolY += yAdd; }
          adjType = 'VAULT→POOL'; vaultAdjUp++;
        }
        const poolY_target = Math.max(5, Math.floor(poolX / rNow));
        const yShed = poolY - poolY_target;
        if (yShed > 0) { poolY -= yShed; vaultY += yShed; if (!adjType) { adjType = 'POOL→VAULT'; vaultAdjDown++; } }
        if (!adjType) { adjType = 'POOL→VAULT'; vaultAdjDown++; }
      }

      // Recompute L for updated pool
      L = computeL(concentration, poolX * p1 + poolY * p2, p1, p2, rNow, rLow, rHigh);

      if (adjType) ledger.push({
        date: row.date.toISOString(), type: 'ADJUST', adjType,
        rNow: +rNow.toFixed(6), rAtLastSwap: +rAtLastSwap.toFixed(6),
        poolX, poolY, vaultX, vaultY,
        asset1Price: p1, asset2Price: p2,
        poolValue: poolX*p1+poolY*p2,
        vaultValue: vaultX*p1+vaultY*p2,
        cashProfit, L: +L.toFixed(2),
      });
    }

    // Release same-direction lock when ratio reverses toward eligible direction
    if (sameDirectionLock && swapEligible) sameDirectionLock = false;

    // ── SWAP ──────────────────────────────────────────────────────────────
    if (inBand && swapEligible && !swapsHalted) {
      // V3 delta from rAtLastSwap → rNow (both clamped to band)
      const rFrom = clamp(rAtLastSwap, rLow, rHigh);
      const rTo   = clamp(rNow,        rLow, rHigh);
      const maxLeg = poolVal * maxLegPct;

      if (eligibleDir === 'SELL_A1') {
        // Ratio rose → sell A1, buy A2
        const delta    = L * Math.abs(1/Math.sqrt(rTo) - 1/Math.sqrt(rFrom));
        const sellQty  = Math.min(
          Math.floor(delta),
          Math.floor(maxLeg / p1),
          poolX - 5,
        );
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
              lastSwapDir   = 'SELL_A1';
              rAtLastSwap   = rNow;
              sameDirectionLock = false;
              L = computeL(concentration, poolX*p1+poolY*p2, p1, p2, rNow, rLow, rHigh);
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
        // Ratio fell → sell A2, buy A1
        const delta    = L * Math.abs(Math.sqrt(rTo) - Math.sqrt(rFrom));
        const sellQty  = Math.min(
          Math.floor(delta),
          Math.floor(maxLeg / p2),
          poolY - 5,
        );
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
              lastSwapDir   = 'SELL_A2';
              rAtLastSwap   = rNow;
              sameDirectionLock = false;
              L = computeL(concentration, poolX*p1+poolY*p2, p1, p2, rNow, rLow, rHigh);
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

    // ── ALPHA REINVESTMENT ────────────────────────────────────────────────
    // Buy whichever stock appreciated more from its initial price.
    // Lock shares in vault — available for future vault→pool rebalancing.
    const hoursSinceVault = (row.date.getTime() - lastVaultCheckMs) / 3600000;
    let didVault = false;
    if (hoursSinceVault >= compoundHours && cashProfit > 0) {
      const gross    = cashProfit;
      const brokCost = gross * reinvestBrok;
      const net      = gross - brokCost;
      if (net > 0) {
        const gainA1 = (p1 - p1_0) / p1_0;
        const gainA2 = (p2 - p2_0) / p2_0;
        // Buy the winner (more appreciated asset)
        let buyX = 0, buyY = 0;
        if (gainA1 >= gainA2) {
          // A1 appreciated more → buy A1 for vault
          buyX = Math.floor(net / p1);
          buyY = 0;
        } else {
          // A2 appreciated more → buy A2 for vault
          buyX = 0;
          buyY = Math.floor(net / p2);
        }
        const winner = gainA1 >= gainA2 ? 'Asset 1' : 'Asset 2';
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
    bandPct: bandPct * 100, concentration, minMovePct: minMovePct * 100,
    L: +L.toFixed(2), initialL: +initialL.toFixed(2),
    rInit: +rInit.toFixed(6), rLow: +rLow.toFixed(6), rHigh: +rHigh.toFixed(6),
    buyBrokeragePct: buyBrok*100, sellBrokeragePct: sellBrok*100,
  };

  return {
    swaps: ledger, equityCurve, results,
    performanceSummary: buildPerformanceSummary(ledger, equityCurve, results),
  };
}
