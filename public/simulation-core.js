// simulation-core.js  —  Concentrated Liquidity Pool with Virtual Depth
// ─────────────────────────────────────────────────────────────────────────────
//
//  CORE CONCEPT: VIRTUAL LIQUIDITY
//  ────────────────────────────────
//  Real capital   = what you actually deploy (e.g. ₹20 L).
//                   This determines how many real shares you hold.
//
//  Virtual capital = a larger notional number (e.g. ₹2 Cr, ₹20 Cr).
//                   This sets the depth of the constant-product pool:
//                     k_virtual = xVirtual × yVirtual
//                   where xVirtual = virtualCapital/2 / p1  (fractional)
//
//  WHY THIS MATTERS
//  ─────────────────
//  The TRADE SIGNAL (how many shares to swap) is derived from the VIRTUAL
//  pool depth, then scaled back to real share quantities.
//
//    xVTarget = sqrt(k_virt × p2/p1)          ← equilibrium in virtual pool
//    delta_v  = xVTarget − xVirtual            ← signal in virtual shares
//    fraction = delta_v / xVirtual             ← normalised (−1 to +1)
//    actualBuy = round(fraction × xReal)       ← scaled to real shares
//
//  Higher virtual capital = tighter concentration = more frequent signals.
//  Lower virtual capital  = wider spread = fewer, chunkier trades.
//  Real capital just determines P&L magnitude; virtual capital sets sensitivity.
//
//  SWAP MECHANIC (two simultaneous NSE market orders)
//  ───────────────────────────────────────────────────
//  1. Compute virtual equilibrium to get the fractional signal
//  2. Scale to real shares and round to nearest integer
//  3. BUY actualBuy shares from NSE market
//  4. Pool releases output via real x·y=k_real (floor-guarded)
//  5. SELL output shares to NSE market
//  6. Net = revenue − cost − brokerage. Execute only if net > 0.
//
//  No band check. No recentering. The pool runs continuously.
//
//  IL STOP-LOSS + AUTO-RESUME
//  ───────────────────────────
//  Halt when: IL% = (poolAssets/holdValue − 1) × 100 < −ilStopPct
//  Resume when: IL% recovers above −ilResumePct (0 = stay halted forever)
//
//  ALPHA-PROTECTION
//  ─────────────────
//  After cashProfit crosses alphaProtectThresholdPct % of real capital:
//    Halt if |IL%| ≥ cashROI%   (IL threatening to erase alpha)
//    Resume if |IL%| < cashROI%  (alpha is safe again)
// ─────────────────────────────────────────────────────────────────────────────

// ─── CSV parsing ──────────────────────────────────────────────────────────────

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

// ─── Merge 1-minute bars to hourly last-close ─────────────────────────────────

export function buildHourly(a1, a2) {
  const map = new Map();
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) {
      const key = (() => { const d = new Date(a1[i].date); d.setMinutes(0,0,0); return d.toISOString(); })();
      if (!map.has(key)) map.set(key, { date: new Date(key), c1: a1[i].close, c2: a2[j].close });
      const b = map.get(key);
      b.c1 = a1[i].close; b.c2 = a2[j].close;
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── Compute swap via virtual-depth signal ─────────────────────────────────────
//
// xReal, yReal  — actual integer shares in the pool
// kReal         — real invariant (xReal × yReal)
// xVirt, yVirt  — virtual (fractional) shares at virtualCapital
// p1, p2        — current prices
// Returns null if no profitable integer trade possible.

function computeSwap(xReal, yReal, kReal, xVirt, yVirt, p1, p2, buyBrok, sellBrok) {
  if (kReal === 0 || xReal < 2 || yReal < 2) return null;

  // Virtual equilibrium position
  const kVirt    = xVirt * yVirt;
  const xVTarget = Math.sqrt(kVirt * p2 / p1);
  const deltaV   = xVTarget - xVirt;          // signal in virtual shares

  // Normalise to real pool
  const fraction = deltaV / xVirt;            // typically −0.05 to +0.05 per hour
  const rawBuy   = fraction * xReal;          // in real shares (fractional)

  if (Math.abs(rawBuy) < 0.5) return null;   // move too small for any integer trade

  if (rawBuy >= 0.5) {
    // ── BUY Asset1, pool releases Asset2 ──────────────────────────────────────
    const buyQty  = Math.round(rawBuy);
    if (buyQty < 1) return null;
    const xAfter  = xReal + buyQty;
    let   sellQty = Math.round(yReal - kReal / xAfter);
    sellQty = Math.min(sellQty, yReal - 1);    // floor guard
    if (sellQty < 1) return null;
    const cost    = buyQty  * p1;
    const revenue = sellQty * p2;
    const brok    = buyBrok * cost + sellBrok * revenue;
    const net     = revenue - cost - brok;
    if (net <= 0) return null;
    return { dir: 'BUY1', buyQty, sellQty,
             xAfter, yAfter: yReal - sellQty,
             cost, revenue, brok, net };

  } else {
    // ── BUY Asset2, pool releases Asset1 ──────────────────────────────────────
    const buyQty  = Math.round(-rawBuy);
    if (buyQty < 1) return null;
    const yAfter  = yReal + buyQty;
    let   sellQty = Math.round(xReal - kReal / yAfter);
    sellQty = Math.min(sellQty, xReal - 1);
    if (sellQty < 1) return null;
    const cost    = buyQty  * p2;
    const revenue = sellQty * p1;
    const brok    = buyBrok * cost + sellBrok * revenue;
    const net     = revenue - cost - brok;
    if (net <= 0) return null;
    return { dir: 'BUY2', buyQty, sellQty,
             xAfter: xReal - sellQty, yAfter,
             cost, revenue, brok, net };
  }
}

// ─── Performance summary ───────────────────────────────────────────────────────

export function buildPerformanceSummary(swapRecords, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6);  // NSE ~6 trading hours/day

  const grossFees    = swapRecords.reduce((s, r) => s + (r.gross ?? 0), 0);
  const frictionRatio= grossFees > 0 ? results.totalBrokerage / grossFees : 1;
  const successful   = swapRecords.filter(r => (r.net ?? 0) > 0).length;
  const successRate  = swapRecords.length > 0 ? successful / swapRecords.length : 0;

  // Max drawdown of alpha curve (poolValue − holdValue)
  const alpha = equityCurve.map(p => (p.poolValue ?? 0) - (p.holdValue ?? 0));
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) { if (v > peak) peak = v; if (v - peak < maxDD) maxDD = v - peak; }
  const initHV   = equityCurve[0]?.holdValue ?? 1;
  const maxDDPct = (maxDD / initHV) * 100;

  // Alpha Sharpe (annualised)
  const alphaRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mrA = alphaRets.length ? alphaRets.reduce((s, v) => s + v, 0) / alphaRets.length : 0;
  let v2A = 0; for (const v of alphaRets) v2A += (v - mrA) ** 2;
  const sdA = alphaRets.length > 1 ? Math.sqrt(v2A / (alphaRets.length - 1)) : 1e-9;
  const alphaSharpe = sdA > 1e-12 ? (mrA / sdA) * ANNUALISE : 0;

  const virtualMultiplier = results.virtualCapital / results.realCapital;

  return {
    grossFees,
    totalFriction: results.totalBrokerage,
    netSwapIncome: grossFees - results.totalBrokerage,
    frictionRatio, frictionRatioPct: frictionRatio * 100,
    successfulSwaps: successful, totalSwaps: swapRecords.length,
    successRate, successRatePct: successRate * 100,
    maxDrawdownINR: maxDD, maxDrawdownPct: maxDDPct,
    alphaSharpe, virtualMultiplier,
    unrealizedIL: results.ilINR,
    netAlphaFinal: results.vsHold,
    narrative: {
      friction: frictionRatio < 0.10 ? 'GOOD — friction < 10% of gross'
                : frictionRatio < 0.25 ? 'MODERATE — lower brokerage or reduce virtual multiple'
                : 'HIGH — virtual liquidity too deep for this brokerage rate',
      swapQuality: successRate >= 1.0 ? 'PERFECT — every swap was profitable'
                   : successRate > 0.85 ? 'EXCELLENT — >85% profitable'
                   : successRate > 0.70 ? 'GOOD — >70% profitable'
                   : 'LOW — too many unprofitable swaps; raise virtual capital',
      ilStatus: results.ilPct >= 0
        ? 'POSITIVE — pool assets exceed hold value'
        : `NEGATIVE — pool ₹${Math.abs(results.ilINR).toLocaleString('en-IN', { maximumFractionDigits: 0 })} below hold`,
      virtualDepth: `${virtualMultiplier.toFixed(1)}× concentration (₹${(results.virtualCapital/1e5).toFixed(0)} L virtual on ₹${(results.realCapital/1e5).toFixed(0)} L real)`,
    },
  };
}

// ─── Main simulation ───────────────────────────────────────────────────────────

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const a1 = normalizeRows(df1);
  const a2 = normalizeRows(df2);
  if (!a1.length || !a2.length)
    return { error: 'Both CSV files must have valid date, close, and volume columns.' };

  const hourly = buildHourly(a1, a2);
  if (hourly.length < 2)
    return { error: 'No overlapping timestamps found. Confirm both CSVs cover the same trading period.' };

  // ── Config ──────────────────────────────────────────────────────────────────

  // Virtual liquidity: this is the "concentration" lever.
  // Must be >= realCapital. Defaults to realCapital (no concentration boost).
  const virtualCapital = Math.max(realCapital, +(config.virtualCapital ?? realCapital));

  const buyBrok  = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;

  // IL stop-loss + auto-resume
  const ilStopPct  = clamp(+(config.ilStopLossPct ?? 3.0), 0, 100);  // 0 = disabled
  const ilResumePct= clamp(+(config.ilResumePct   ?? 1.0), 0, 100);  // 0 = no auto-resume

  // Alpha protection
  const alphaProtectThresh = clamp(+(config.alphaProtectThresholdPct ?? 0.3), 0, 100);
  const alphaProtectOn     = config.alphaProtectEnabled !== false;

  // ── Pool init ───────────────────────────────────────────────────────────────

  const h0 = hourly[0];

  // Real integer shares (what actually sits in the portfolio)
  const xInit = Math.max(1, Math.round(realCapital    / 2 / h0.c1));
  const yInit = Math.max(1, Math.round(realCapital    / 2 / h0.c2));
  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low to purchase at least 1 share of each asset.' };

  // Virtual fractional shares (set pool depth — updated each hour at current prices)
  // We keep xVirt/yVirt as the initial ratio and scale with price each hour.
  // Simple approach: recalculate virtual shares each hour at virtualCapital/2.
  // This keeps virtual pool perpetually at virtualCapital notional.

  let xReal = xInit, yReal = yInit;
  let kReal  = xReal * yReal;

  const realInitCapital = xInit * h0.c1 + yInit * h0.c2;
  const virtMultiple    = virtualCapital / realCapital;  // e.g. 10× if virt = 2Cr, real = 20L

  // ── Running state ────────────────────────────────────────────────────────────

  let cashProfit      = 0;
  let totalBrokerage  = 0;
  let grossSwapFees   = 0;
  let totalSwaps      = 0;
  let successfulSwaps = 0;

  // Halt state
  let swapsHalted   = false;
  let haltReason    = null;      // 'IL_STOP' | 'ALPHA_PROTECT' | null
  let ilHaltedAt    = null;
  let ilResumedAt   = null;
  let haltCount     = 0;
  let alphaProtected= false;

  const swapRecords = [];
  const equityCurve = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: realInitCapital, holdValue: realInitCapital,
    cashProfit: 0, alphaINR: 0, ilPct: 0,
    halted: false, haltReason: null,
    virtualMultiple: virtMultiple,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────

  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1, p2 = row.c2;

    // Recompute virtual shares each hour at current prices
    // Virtual pool is always capitalised at virtualCapital notional
    const xVirt = virtualCapital / 2 / p1;   // fractional
    const yVirt = virtualCapital / 2 / p2;   // fractional

    // Current real snapshots
    const pvNow = xReal * p1 + yReal * p2;
    const hvNow = xInit * p1 + yInit * p2;
    const ilPctNow   = hvNow > 0 ? (pvNow / hvNow - 1) * 100 : 0;
    const cashRoiNow = realInitCapital > 0 ? cashProfit / realInitCapital * 100 : 0;

    // ── AUTO-RESUME ────────────────────────────────────────────────────────────
    if (swapsHalted) {
      if (haltReason === 'IL_STOP' && ilResumePct > 0 && ilPctNow >= -ilResumePct) {
        swapsHalted = false; haltReason = null;
        ilResumedAt = row.date.toISOString();
      } else if (haltReason === 'ALPHA_PROTECT'
                 && cashRoiNow > 0
                 && Math.abs(ilPctNow) < cashRoiNow) {
        swapsHalted = false; haltReason = null;
        ilResumedAt = row.date.toISOString();
      }
    }

    // ── HALT CHECKS ────────────────────────────────────────────────────────────
    if (!swapsHalted) {
      if (ilStopPct > 0 && ilPctNow < -ilStopPct) {
        swapsHalted = true; haltReason = 'IL_STOP';
        ilHaltedAt  = row.date.toISOString(); haltCount++;
      }
      if (!swapsHalted && alphaProtectOn
          && cashRoiNow >= alphaProtectThresh
          && ilPctNow < 0
          && Math.abs(ilPctNow) >= cashRoiNow) {
        swapsHalted    = true; haltReason = 'ALPHA_PROTECT';
        alphaProtected = true;
        ilHaltedAt     = row.date.toISOString(); haltCount++;
      }
    }

    // ── SWAP ────────────────────────────────────────────────────────────────────
    if (!swapsHalted) {
      const sw = computeSwap(xReal, yReal, kReal, xVirt, yVirt, p1, p2, buyBrok, sellBrok);
      if (sw) {
        grossSwapFees  += sw.gross;
        cashProfit     += sw.net;
        totalBrokerage += sw.brok;
        xReal = sw.xAfter; yReal = sw.yAfter;
        kReal = xReal * yReal;               // re-derive from actual integer holdings
        totalSwaps++;
        if (sw.net > 0) successfulSwaps++;

        const bA  = sw.dir === 'BUY1' ? 'Asset 1' : 'Asset 2';
        const sA  = sw.dir === 'BUY1' ? 'Asset 2' : 'Asset 1';
        const pvS = xReal * p1 + yReal * p2;
        const hvS = xInit  * p1 + yInit  * p2;
        swapRecords.push({
          date: row.date.toISOString(),
          action: `Buy ${bA} / Sell ${sA}`,
          buyAsset: bA, buyQty: sw.buyQty, cost: sw.cost,
          sellAsset: sA, sellQty: sw.sellQty, revenue: sw.revenue,
          gross: sw.gross, brok: sw.brok, net: sw.net,
          cashProfit, asset1Price: p1, asset2Price: p2,
          poolX: xReal, poolY: yReal,
          poolValue: pvS, ilPct: hvS > 0 ? (pvS / hvS - 1) * 100 : 0,
          totalValue: pvS + cashProfit, haltReason,
          virtualMultiple: virtMultiple,
        });
      }
    }

    // ── Equity snapshot ─────────────────────────────────────────────────────────
    const pv = xReal * p1 + yReal * p2;
    const hv = xInit  * p1 + yInit  * p2;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv + cashProfit,
      holdValue: hv,
      cashProfit,
      alphaINR: pv + cashProfit - hv,
      ilPct: hv > 0 ? (pv / hv - 1) * 100 : 0,
      halted: swapsHalted,
      haltReason,
      virtualMultiple: virtMultiple,
    });
  }

  // ── Final metrics ────────────────────────────────────────────────────────────

  const last       = hourly[hourly.length - 1];
  const holdValue  = xInit  * last.c1 + yInit  * last.c2;
  const poolAssets = xReal  * last.c1 + yReal  * last.c2;
  const totalValue = poolAssets + cashProfit;
  const ilINR      = poolAssets - holdValue;
  const ilPct      = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const vsHold     = totalValue - holdValue;
  const vsHoldPct  = holdValue  > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    realCapital, virtualCapital, virtMultiple,
    realInitCapital, totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossSwapFees,
    vsHold, vsHoldPct,
    roiPct:   realInitCapital > 0 ? (totalValue  / realInitCapital - 1) * 100 : 0,
    holdRoi:  realInitCapital > 0 ? (holdValue   / realInitCapital - 1) * 100 : 0,
    cashRoi:  realInitCapital > 0 ?  cashProfit   / realInitCapital * 100 : 0,
    brokRoi:  realInitCapital > 0 ?  totalBrokerage / realInitCapital * 100 : 0,
    ilINR, ilPct,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt,
    haltCount, alphaProtected,
    totalSwaps, successfulSwaps,
    successRate: totalSwaps > 0 ? successfulSwaps / totalSwaps : 0,
    initialX: xInit, initialY: yInit, finalX: xReal, finalY: yReal,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
  };

  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);
  return { swaps: swapRecords, equityCurve, results, performanceSummary };
}
