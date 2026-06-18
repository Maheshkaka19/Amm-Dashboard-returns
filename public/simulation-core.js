// simulation-core.js  v6.0
// ─────────────────────────────────────────────────────────────────
//
//  SYSTEM DESIGN
//  ──────────────
//  POOL — active trading position. Holds two stocks at ~50/50 value.
//    Swaps happen every hour the price ratio is inside the fixed band.
//    Swap sizing uses V3 concentrated liquidity delta math.
//    A swap only executes when gross profit ≥ profitMargin × brokerage.
//
//  VAULT — profit extraction. Funded entirely from accumulated cash.
//    When cashProfit can buy ≥1 share of each stock (50/50 split at
//    current prices), those shares are bought and locked in the vault.
//    Vault shares are never sold for trading — they are realised profit.
//
//  BAND MANAGEMENT (price ratio drifts outside ±bandPct of rInit)
//    Step 1 — try vault first:
//      Compute how many shares of each stock need to move from vault
//      to pool to bring pool ratio back inside the band.
//      If vault holds enough → move them (no cost, internal transfer).
//    Step 2 — if vault insufficient, adjust pool:
//      Move pool shares to vault (shrink pool) until remaining pool
//      is back inside the band. No brokerage — internal rebalance.
//    After adjustment: resume normal V3 swapping next bar.
//
//  V3 SWAP DELTA MATH
//  ───────────────────
//  Pool liquidity parameter L is computed from pool capital and
//  concentration factor C:
//    rLow  = rInit × (1 − 1/C)
//    rHigh = rInit × (1 + 1/C)
//    L = poolCapital / [ (1/√r − 1/√rHigh)×p1 + (√r − √rLow)×p2 ]
//
//  Each hour: if ratio is in band, compute delta:
//    dx = L × (1/√rNew − 1/√rOld)   [Asset1 change]
//    dy = L × (√rNew − √rOld)        [Asset2 change]
//
//  Swap quantities: floor(|dx|) and floor(|dy|).
//  Execute only when gross ≥ profitMargin × brokerage.
//
//  PROFIT MARGIN GUARD
//  ────────────────────
//  gross   = sellQty×pSell − buyQty×pBuy
//  brok    = sellBrok×sellValue + buyBrok×buyValue
//  Execute only when gross ≥ profitMargin × brok   (default 3×)
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

// ─── V3 liquidity parameter ───────────────────────────────────────────────────
function computeL(capital, p1, p2, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r, rLow, rHigh));
  const sra = Math.sqrt(rLow);
  const srb = Math.sqrt(rHigh);
  const denom = (1/sr - 1/srb) * p1 + (sr - sra) * p2;
  return denom > 1e-10 ? capital / denom : 0;
}

// ─── V3 swap delta ────────────────────────────────────────────────────────────
function v3Delta(L, rOld, rNew, rLow, rHigh) {
  const ro = clamp(rOld, rLow, rHigh);
  const rn = clamp(rNew, rLow, rHigh);
  return {
    dx: L * (1/Math.sqrt(rn) - 1/Math.sqrt(ro)),  // Asset1 delta (neg = pool gives out)
    dy: L * (Math.sqrt(rn)   -   Math.sqrt(ro)),   // Asset2 delta (pos = pool takes in)
  };
}

// ─── Performance summary ──────────────────────────────────────────────────────
export function buildPerformanceSummary(ledger, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6.5);
  const trades    = ledger.filter(t => t.type === 'SWAP');
  const gross     = trades.reduce((s, t) => s + t.gross, 0);
  const brok      = trades.reduce((s, t) => s + t.brok,  0);
  const profitable = trades.filter(t => t.net > 0).length;
  const skipped    = ledger.filter(t => t.type === 'SKIP').length;
  const successRate = trades.length > 0 ? profitable / trades.length : 0;

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
    grossSwap: gross, brokSwap: brok, netSwap: gross - brok,
    totalTrades: trades.length, profitable, skipped,
    successRate, successPct: successRate * 100,
    maxDrawdown: maxDD,
    maxDrawdownPct: results.holdValue > 0 ? maxDD / results.holdValue * 100 : 0,
    alphaSharpe: sd > 1e-12 ? (mr / sd) * ANNUALISE : 0,
    vaultShares: results.vaultX + results.vaultY,
    vaultValue:  results.vaultValue,
    vaultDeposits: results.vaultDeposits,
  };
}

// ─── PAIR FITNESS ─────────────────────────────────────────────────────────────
export function pairFitness(df1, df2) {
  const a1 = normalizeRows(df1);
  const a2 = normalizeRows(df2);
  if (!a1.length || !a2.length) return { error: 'Invalid data' };
  const hourly = buildHourly(a1, a2);
  if (hourly.length < 20) return { error: 'Too few bars' };

  const ratios = hourly.map(h => h.c1 / h.c2);
  const n      = ratios.length;
  const mean   = ratios.reduce((s, v) => s + v, 0) / n;
  const std    = Math.sqrt(ratios.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const logRets = ratios.slice(1).map((r, i) => Math.log(r / ratios[i]));

  // Hurst (R/S)
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

  // Lag-1 autocorrelation
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

// ─── MAIN ENGINE ─────────────────────────────────────────────────────────────
export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const a1 = normalizeRows(df1);
  const a2 = normalizeRows(df2);
  if (!a1.length || !a2.length)
    return { error: 'Both files need valid date, close, volume columns.' };

  const hourly = buildHourly(a1, a2);
  if (hourly.length < 10)
    return { error: 'Too few overlapping bars. Check timestamps match.' };

  // ── Config ─────────────────────────────────────────────────────────────────
  const bandPct       = clamp(+(config.bandPct        ?? 5),    0.5, 50)  / 100;  // 0.05
  const concentration = clamp(+(config.concentration  ?? 2),    1.1, 20);          // C factor
  const buyBrok       = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5)   / 100;
  const sellBrok      = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5)   / 100;
  const reinvestBrok  = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;
  const profitMargin  = clamp(+(config.profitMargin    ?? 3),    1, 20);            // gross ≥ N×brok
  const compoundIntervalHours = clamp(+(config.compoundIntervalHours ?? 24), 1, 168);
  const ilHardStop    = clamp(+(config.ilHardStopPct   ?? 0), 0, 100);
  const ilHardResume  = clamp(+(config.ilHardResumePct ?? 0), 0, 100);

  // ── Initialise pool ────────────────────────────────────────────────────────
  const h0    = hourly[0];
  const p1_0  = h0.c1, p2_0 = h0.c2;
  const rInit = p1_0 / p2_0;   // fixed band center — NEVER changes

  // Band width is controlled ONLY by bandPct — fixed ±X% around rInit, forever.
  const rLow  = rInit * (1 - bandPct);
  const rHigh = rInit * (1 + bandPct);

  // Deploy capital 50/50 to pool
  const poolHalf  = realCapital / 2;
  let poolX = Math.max(1, Math.floor(poolHalf / p1_0));  // pool Asset1
  let poolY = Math.max(1, Math.floor(poolHalf / p2_0));  // pool Asset2

  // Hold benchmark — identical, never touched
  const holdX = poolX;
  const holdY = poolY;
  const initCapital = poolX * p1_0 + poolY * p2_0;

  // Vault starts empty
  let vaultX = 0;
  let vaultY = 0;

  // ── Concentration scales swap intensity (L), independent of band width ──────
  //
  // In real V3, L for a given capital and a FIXED range is fixed — there is
  // no separate "concentration knob" once rLow/rHigh are set; concentration
  // is just 1/(1-√(rLow/rHigh)), entirely a function of band width.
  //
  // Here we expose concentration as a SEPARATE user-facing amplifier on top
  // of the natural V3 math: it directly multiplies L, so a wider value
  // produces proportionally larger swap quantities per price tick without
  // changing the band boundaries at all. This is what "concentration" means
  // to the user — more aggressive trading inside the same fixed range.
  const baseL = computeL(initCapital, p1_0, p2_0, rInit, rLow, rHigh);
  let L = baseL * concentration;

  // ── State ──────────────────────────────────────────────────────────────────
  let cashProfit       = 0;
  let totalBrokerage   = 0;
  let grossSwapTotal   = 0;
  let netSwapTotal     = 0;
  let totalSwaps       = 0;
  let profitableSwaps  = 0;
  let skippedSwaps     = 0;   // swap wanted but gross < profitMargin*brok
  let vaultDeposits    = 0;
  let vaultAdjustments = 0;   // times vault shares moved to/from pool
  let poolAdjustments  = 0;   // times pool shrunk to restore range
  let hoursSinceVault  = 0;
  let rPrev            = rInit;
  let swapsHalted      = false;
  let outOfBandLock     = false;  // prevents repeated adjustments while out of band
  let haltReason       = null;
  let ilHaltedAt = null, ilResumedAt = null, haltCount = 0;

  const ledger      = [];
  const equityCurve = [];

  const totalV0 = initCapital;
  equityCurve.push({
    date:       h0.date.toISOString(),
    poolValue:  totalV0, holdValue: totalV0, cashProfit: 0,
    totalValue: totalV0, alphaINR: 0, ilPct: 0,
    vaultValue: 0, inBand: true, halted: false, compoundEvent: false,
  });

  // ── Hour loop ──────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1, p2 = row.c2;
    const rNow = p1 / p2;

    hoursSinceVault++;

    const poolVal  = poolX * p1 + poolY * p2;
    const vaultVal = vaultX * p1 + vaultY * p2;
    const holdVal  = holdX  * p1 + holdY  * p2;
    const totalVal = poolVal + cashProfit + vaultVal;
    const ilPct    = holdVal > 0 ? ((poolVal + vaultVal) / holdVal - 1) * 100 : 0;

    // IL hard stop
    if (swapsHalted && haltReason === 'IL_STOP' && ilHardResume > 0 && ilPct >= -ilHardResume) {
      swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
    }
    if (!swapsHalted && ilHardStop > 0 && ilPct < -ilHardStop) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt  = row.date.toISOString(); haltCount++;
    }

    // ── BAND CHECK ────────────────────────────────────────────────────────────
    //
    // FIX: adjustment must fire ONLY ONCE per breach — on the hour price
    // first crosses outside the band. While price remains outside, the pool
    // sits passively (already adjusted, no further moves, no swaps). When
    // price re-enters the band, the lock clears and swapping resumes.

    const inBand = rNow >= rLow && rNow <= rHigh;

    if (!inBand && !swapsHalted && !outOfBandLock) {
      outOfBandLock = true;

      // Target pool composition at 50/50 value using CURRENT pool value
      // and CURRENT prices — this is what the pool should hold to be centred.
      const xTarget = Math.max(1, Math.floor(poolVal / 2 / p1));
      const yTarget = Math.max(1, Math.floor(poolVal / 2 / p2));

      const xNeed = xTarget - poolX;  // +ve = pool needs more Asset1
      const yNeed = yTarget - poolY;  // +ve = pool needs more Asset2

      let adjType = null;

      if (xNeed > 0 && yNeed < 0) {
        // Pool needs more Asset1, has excess Asset2 to give up.
        const yExcess = Math.abs(yNeed);
        if (vaultX >= xNeed) {
          // Vault fully covers the Asset1 shortfall.
          vaultX -= xNeed;
          poolX  += xNeed;
          poolY  -= yExcess;
          vaultY += yExcess;
          adjType = 'VAULT→POOL';
          vaultAdjustments++;
        } else {
          // Vault insufficient — take whatever it has, surplus Asset2 goes to vault.
          const xFromVault = vaultX;
          vaultX = 0;
          poolX += xFromVault;
          poolY -= yExcess;
          vaultY += yExcess;
          adjType = 'POOL→VAULT';
          poolAdjustments++;
        }
      } else if (xNeed < 0 && yNeed > 0) {
        // Pool needs more Asset2, has excess Asset1 to give up.
        const xExcess = Math.abs(xNeed);
        if (vaultY >= yNeed) {
          vaultY -= yNeed;
          poolY  += yNeed;
          poolX  -= xExcess;
          vaultX += xExcess;
          adjType = 'VAULT→POOL';
          vaultAdjustments++;
        } else {
          const yFromVault = vaultY;
          vaultY = 0;
          poolY += yFromVault;
          poolX -= xExcess;
          vaultX += xExcess;
          adjType = 'POOL→VAULT';
          poolAdjustments++;
        }
      }

      // Recompute L from adjusted pool composition, preserving the
      // concentration amplifier so swap intensity stays consistent.
      const newCap = poolX * p1 + poolY * p2;
      L = computeL(newCap, p1, p2, rInit, rLow, rHigh) * concentration;
      rPrev = clamp(rNow, rLow, rHigh);

      if (adjType) {
        ledger.push({
          date: row.date.toISOString(), type: 'ADJUST',
          adjType,
          rNow: +rNow.toFixed(6), rLow: +rLow.toFixed(6), rHigh: +rHigh.toFixed(6),
          poolX, poolY, vaultX, vaultY,
          asset1Price: p1, asset2Price: p2,
          poolValue: poolX*p1+poolY*p2,
          vaultValue: vaultX*p1+vaultY*p2,
          cashProfit,
        });
      }

    } else if (inBand) {
      // Back inside the band — release the lock so the next breach can
      // trigger a fresh, single adjustment.
      outOfBandLock = false;
    }

    if (inBand && !swapsHalted) {
      // ── IN-BAND: V3 SWAP ──────────────────────────────────────────────────
      //
      // Compute V3 delta from rPrev → rNow.
      // Round both legs with Math.floor (never trade more than delta says).
      // Only execute when gross ≥ profitMargin × brokerage.

      const { dx, dy } = v3Delta(L, rPrev, rNow, rLow, rHigh);

      if (dx < 0 && dy > 0) {
        // Ratio rose: pool gives out Asset1, takes in Asset2
        // → sell Asset1, buy Asset2
        //
        // FIX: if the pool can't afford the full V3 delta, scale BOTH legs
        // down proportionally (keeping the dy/dx ratio intact) instead of
        // capping only the sell leg. Capping one leg without the other
        // breaks the trade's value balance and makes gross deeply negative.
        const rawSellQty = Math.floor(Math.abs(dx));
        const rawBuyQty  = Math.floor(Math.abs(dy));
        const affordable = poolX - 1;
        const scale      = rawSellQty > affordable && rawSellQty > 0
                          ? affordable / rawSellQty
                          : 1;
        const sellQty = Math.min(rawSellQty, affordable);
        const buyQty  = Math.floor(rawBuyQty * scale);

        if (sellQty >= 1 && buyQty >= 1) {
          const sellVal = sellQty * p1;
          const buyVal  = buyQty  * p2;
          const brok    = sellBrok * sellVal + buyBrok * buyVal;
          const gross   = sellVal - buyVal;

          if (gross >= profitMargin * brok) {
            const net = gross - brok;
            poolX -= sellQty; poolY += buyQty;
            cashProfit     += net;
            totalBrokerage += brok;
            grossSwapTotal += gross;
            netSwapTotal   += net;
            totalSwaps++; profitableSwaps++;

            ledger.push({
              date: row.date.toISOString(), type: 'SWAP',
              action: 'Sell A1 / Buy A2',
              sellAsset: 'Asset 1', sellQty, sellVal,
              buyAsset:  'Asset 2', buyQty,  buyVal,
              gross, brok, net, cashProfit,
              asset1Price: p1, asset2Price: p2,
              poolX, poolY, vaultX, vaultY,
              ilPct: +ilPct.toFixed(3), L: +L.toFixed(2),
              rNow: +rNow.toFixed(6), dx, dy,
            });
          } else {
            skippedSwaps++;
          }
        }

      } else if (dx > 0 && dy < 0) {
        // Ratio fell: pool gives out Asset2, takes in Asset1
        // → sell Asset2, buy Asset1
        //
        // FIX: same proportional-scaling logic as the other direction.
        const rawSellQty = Math.floor(Math.abs(dy));
        const rawBuyQty  = Math.floor(Math.abs(dx));
        const affordable = poolY - 1;
        const scale      = rawSellQty > affordable && rawSellQty > 0
                          ? affordable / rawSellQty
                          : 1;
        const sellQty = Math.min(rawSellQty, affordable);
        const buyQty  = Math.floor(rawBuyQty * scale);

        if (sellQty >= 1 && buyQty >= 1) {
          const sellVal = sellQty * p2;
          const buyVal  = buyQty  * p1;
          const brok    = sellBrok * sellVal + buyBrok * buyVal;
          const gross   = sellVal - buyVal;

          if (gross >= profitMargin * brok) {
            const net = gross - brok;
            poolY -= sellQty; poolX += buyQty;
            cashProfit     += net;
            totalBrokerage += brok;
            grossSwapTotal += gross;
            netSwapTotal   += net;
            totalSwaps++; profitableSwaps++;

            ledger.push({
              date: row.date.toISOString(), type: 'SWAP',
              action: 'Sell A2 / Buy A1',
              sellAsset: 'Asset 2', sellQty, sellVal,
              buyAsset:  'Asset 1', buyQty,  buyVal,
              gross, brok, net, cashProfit,
              asset1Price: p1, asset2Price: p2,
              poolX, poolY, vaultX, vaultY,
              ilPct: +ilPct.toFixed(3), L: +L.toFixed(2),
              rNow: +rNow.toFixed(6), dx, dy,
            });
          } else {
            skippedSwaps++;
          }
        }
      }
    }

    rPrev = inBand ? rNow : clamp(rNow, rLow, rHigh);

    // ── VAULT DEPOSIT ─────────────────────────────────────────────────────────
    //
    // Every compoundIntervalHours, if cashProfit can buy ≥1 share of each
    // stock at current prices (50/50 split), lock those shares in the vault.
    //
    // Brokerage is charged on the buy.

    let didVault = false;
    if (hoursSinceVault >= compoundIntervalHours && cashProfit > 0) {
      const gross   = cashProfit;
      const brokCost = gross * reinvestBrok;
      const net     = gross - brokCost;
      const buyX    = Math.floor(net / 2 / p1);
      const buyY    = Math.floor(net / 2 / p2);

      if (buyX >= 1 && buyY >= 1) {
        const actualCost = buyX * p1 + buyY * p2;
        vaultX     += buyX;
        vaultY     += buyY;
        totalBrokerage += brokCost;
        cashProfit  -= (actualCost + brokCost);
        vaultDeposits++;
        didVault = true;

        ledger.push({
          date: row.date.toISOString(), type: 'VAULT_DEPOSIT',
          action: '🔒 Vault Deposit',
          buyX, buyY, actualCost, brokCost,
          cashBefore: cashProfit + actualCost + brokCost,
          cashAfter:  cashProfit,
          vaultX, vaultY,
          asset1Price: p1, asset2Price: p2,
          vaultValue: vaultX * p1 + vaultY * p2,
          depositEvent: vaultDeposits,
        });
      }
      hoursSinceVault = 0;
    }

    // ── Equity snapshot ───────────────────────────────────────────────────────
    const pv   = poolX  * p1 + poolY  * p2;
    const vv2  = vaultX * p1 + vaultY * p2;
    const hv   = holdX  * p1 + holdY  * p2;
    const totV = pv + cashProfit + vv2;
    equityCurve.push({
      date:          row.date.toISOString(),
      poolValue:     pv,
      vaultValue:    vv2,
      cashProfit,
      totalValue:    totV,
      holdValue:     hv,
      alphaINR:      totV - hv,
      ilPct:         hv > 0 ? ((pv + vv2) / hv - 1) * 100 : 0,
      inBand,
      halted:        swapsHalted,
      haltReason,
      compoundEvent: didVault,
    });
  }

  // ── Final results ──────────────────────────────────────────────────────────
  const last      = hourly[hourly.length - 1];
  const holdValue = holdX  * last.c1 + holdY  * last.c2;
  const poolFinal = poolX  * last.c1 + poolY  * last.c2;
  const vaultFinal= vaultX * last.c1 + vaultY * last.c2;
  const totalValue= poolFinal + cashProfit + vaultFinal;
  const vsHold    = totalValue - holdValue;
  const vsHoldPct = holdValue > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    realCapital, initCapital, totalValue, poolFinal, vaultFinal,
    cashProfit, holdValue, totalBrokerage,
    grossSwapTotal, netSwapTotal,
    vsHold, vsHoldPct,
    roiPct:   initCapital > 0 ? (totalValue  / initCapital - 1) * 100 : 0,
    holdRoi:  initCapital > 0 ? (holdValue   / initCapital - 1) * 100 : 0,
    cashRoi:  initCapital > 0 ?  cashProfit  / initCapital * 100 : 0,
    brokRoi:  initCapital > 0 ?  totalBrokerage / initCapital * 100 : 0,
    ilPct:    holdValue > 0 ? ((poolFinal + vaultFinal) / holdValue - 1) * 100 : 0,
    ilINR:    poolFinal + vaultFinal - holdValue,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt, haltCount,
    totalSwaps, profitableSwaps,
    skippedSwaps, vaultDeposits, vaultAdjustments, poolAdjustments,
    successRate: totalSwaps > 0 ? profitableSwaps / totalSwaps : 0,
    poolX, poolY, vaultX, vaultY,
    holdX, holdY,
    vaultValue: vaultFinal,
    bandPct: bandPct * 100, concentration,
    rInit: +rInit.toFixed(6), rLow: +rLow.toFixed(6), rHigh: +rHigh.toFixed(6), L: +L.toFixed(2),
    buyBrokeragePct: buyBrok*100, sellBrokeragePct: sellBrok*100,
    profitMargin,
  };

  return {
    swaps: ledger, equityCurve, results,
    performanceSummary: buildPerformanceSummary(ledger, equityCurve, results),
  };
}
