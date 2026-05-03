// simulation-core.js  —  Uniswap V3 Concentrated Liquidity Pool
// ─────────────────────────────────────────────────────────────────────────────
//
//  UNISWAP V3 MATHEMATICS  (Adams et al. 2021)
//  ─────────────────────────────────────────────
//  Reference: https://uniswap.org/whitepaper-v3.pdf
//
//  Full-range AMM (x*y=k) provides liquidity at every price.
//  V3 concentrates all liquidity within [p_lower, p_upper],
//  amplifying fees by 1/(1 - sqrt(p_lower/p_upper)).
//
//  Core invariant within the range:
//    (x + L/√p_upper) × (y + L×√p_lower) = L²
//
//  Virtual reserves at current price p (within [p_a, p_b]):
//    x_virtual = L × (1/√p   − 1/√p_b)    [Asset1]
//    y_virtual = L × (√p     −   √p_a)    [Asset2]
//
//  L is the liquidity parameter (fixed for a given position).
//  It is computed from deposited capital at initialization:
//    capital = x_virtual × p1 + y_virtual × p2
//    L = capital / [ (1/√r − 1/√r_b)×p1 + (√r − √r_a)×p2 ]
//  where r = p1/p2  (price ratio, the "price" in ratio-space).
//
//  SWAP DELTA (price ratio moves r_old → r_new within [r_a, r_b]):
//    Δx = L × (1/√r_new − 1/√r_old)   [signed; negative = pool releases Asset1]
//    Δy = L × (√r_new   −   √r_old)   [signed; positive = pool absorbs Asset2]
//
//  NSE TWO-ORDER MECHANIC:
//  Case A — ratio RISES (r_new > r_old): Δx < 0, Δy > 0
//    → Pool releases Asset1, absorbs Asset2
//    → NSE: BUY |Δy| Asset2 from market, SELL |Δx| Asset1 to market
//  Case B — ratio FALLS (r_new < r_old): Δx > 0, Δy < 0
//    → Pool releases Asset2, absorbs Asset1
//    → NSE: BUY |Δx| Asset1 from market, SELL |Δy| Asset2 to market
//
//  Quantities rounded to nearest integer. Floor-guarded (never sell last share).
//  Execute only when net profit > 0 after brokerage on both legs.
//
//  RECENTER (out-of-range):
//  When price exits [p_a, p_b], pool goes entirely into one asset.
//  We recompute L from current portfolio value at new center price.
//  Brokerage is NOT charged on recentering — it is a position reset.
//
//  IL STOP-LOSS + AUTO-RESUME:
//  Halt swaps when IL% < −ilStopPct. Resume when IL% > −ilResumePct.
//
//  ALPHA PROTECTION:
//  After cashROI% ≥ alphaProtectThresholdPct, halt if |IL%| ≥ cashROI%.
//  Resume when |IL%| < cashROI%.
// ─────────────────────────────────────────────────────────────────────────────

// ─── CSV ──────────────────────────────────────────────────────────────────────

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

// ─── Hourly merge ─────────────────────────────────────────────────────────────

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

// ─── V3 Core: Liquidity parameter ─────────────────────────────────────────────
//
// Computes L from capital and price range. This is the only place where
// the USD value of the position enters; from here on everything is L-based.
//
// Formula (NSE two-asset form):
//   capital = L×(1/√r − 1/√r_b)×p1 + L×(√r − √r_a)×p2
//   L = capital / denom
//   where denom = (1/√r − 1/√r_b)×p1 + (√r − √r_a)×p2
//
// Edge cases:
//   r ≤ r_a  → position is 100% Asset2, denom = (√r_b − √r_a)×p2
//   r ≥ r_b  → position is 100% Asset1, denom = (1/√r_a − 1/√r_b)×p1

function computeL(capital, p1, p2, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r,    rLow, rHigh));
  const sra = Math.sqrt(rLow);
  const srb = Math.sqrt(rHigh);
  const denom = (1/sr - 1/srb) * p1 + (sr - sra) * p2;
  return denom > 1e-10 ? capital / denom : 0;
}

// ─── V3 Core: Virtual reserves ────────────────────────────────────────────────

function v3Reserves(L, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r, rLow, rHigh));
  const sra = Math.sqrt(rLow);
  const srb = Math.sqrt(rHigh);
  return {
    x: L * (1/sr - 1/srb),   // Asset1 (can be fractional)
    y: L * (sr   - sra),     // Asset2 (can be fractional)
  };
}

// ─── V3 Core: Swap delta ───────────────────────────────────────────────────────
//
// Price ratio moves rOld → rNew (both within [rLow, rHigh]).
//
// Returns signed deltas:
//   dx = L × (1/√rNew − 1/√rOld)   negative → pool releases Asset1
//   dy = L × (√rNew   −   √rOld)   positive → pool absorbs Asset2
//
// The NSE orders mirror these:
//   dx < 0:  BUY |dy| Asset2 from NSE, SELL |dx| Asset1 to NSE
//   dx > 0:  BUY |dx| Asset1 from NSE, SELL |dy| Asset2 to NSE

function v3SwapDelta(L, rOld, rNew) {
  const srOld = Math.sqrt(rOld);
  const srNew = Math.sqrt(rNew);
  const dx = L * (1/srNew - 1/srOld);   // Asset1 delta
  const dy = L * (srNew   -   srOld);   // Asset2 delta
  return { dx, dy };
}

// ─── Performance summary ───────────────────────────────────────────────────────

export function buildPerformanceSummary(swapRecords, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6);

  const grossFees     = swapRecords.reduce((s, r) => s + (r.gross ?? 0), 0);
  const totalFriction = results.totalBrokerage;
  const frictionRatio = grossFees > 0 ? totalFriction / grossFees : 1;
  const successful    = swapRecords.filter(r => (r.net ?? 0) > 0).length;
  const successRate   = swapRecords.length > 0 ? successful / swapRecords.length : 0;

  const alpha = equityCurve.map(p => (p.poolValue ?? 0) - (p.holdValue ?? 0));
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) { if (v > peak) peak = v; if (v - peak < maxDD) maxDD = v - peak; }
  const maxDDPct = equityCurve[0]?.holdValue > 0 ? maxDD / equityCurve[0].holdValue * 100 : 0;

  const aRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mr = aRets.length ? aRets.reduce((s, v) => s + v, 0) / aRets.length : 0;
  let v2 = 0; for (const v of aRets) v2 += (v - mr) ** 2;
  const sd = aRets.length > 1 ? Math.sqrt(v2 / (aRets.length - 1)) : 1e-9;
  const alphaSharpe = sd > 1e-12 ? (mr / sd) * ANNUALISE : 0;

  // Concentration factor vs full-range
  const rCenter = results.rCenter ?? 1;
  const rLow    = results.rLow    ?? rCenter * 0.8;
  const rHigh   = results.rHigh   ?? rCenter * 1.2;
  const concentrationFactor = 1 / (1 - Math.sqrt(rLow / rHigh));

  return {
    grossFees, totalFriction,
    netSwapIncome: grossFees - totalFriction,
    frictionRatio, frictionRatioPct: frictionRatio * 100,
    successfulSwaps: successful, totalSwaps: swapRecords.length,
    successRate, successRatePct: successRate * 100,
    maxDrawdownINR: maxDD, maxDrawdownPct: maxDDPct,
    alphaSharpe, concentrationFactor,
    unrealizedIL: results.ilINR,
    netAlphaFinal: results.vsHold,
    narrative: {
      friction: frictionRatio < 0.10 ? 'GOOD — friction < 10% of gross'
               : frictionRatio < 0.25 ? 'MODERATE'
               : 'HIGH — band may be too tight for this brokerage',
      swapQuality: successRate >= 1.0 ? 'PERFECT — every swap profitable'
                  : successRate > 0.85 ? 'EXCELLENT — >85% profitable'
                  : successRate > 0.70 ? 'GOOD — >70% profitable'
                  : 'LOW — widen band or reduce brokerage',
      ilStatus: results.ilPct >= 0 ? 'POSITIVE — pool assets exceed hold value'
               : `NEGATIVE — ${Math.abs(results.ilINR).toLocaleString('en-IN', { maximumFractionDigits: 0 })} below hold`,
      concentration: `${concentrationFactor.toFixed(1)}× amplification vs full-range pool`,
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
    return { error: 'No overlapping timestamps. Confirm both CSVs cover the same period.' };

  // ── Config ──────────────────────────────────────────────────────────────────
  // Band half-width as a fraction (e.g. 0.20 = ±20% range = 40% total range)
  const bandPct    = clamp(+(config.bandPct       ?? 20.0), 0.5, 99) / 100;
  const buyBrok    = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok   = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;

  const ilStopPct   = clamp(+(config.ilStopLossPct ?? 0), 0, 100);   // 0 = disabled
  const ilResumePct = clamp(+(config.ilResumePct   ?? 0), 0, 100);

  const alphaProtectThresh = clamp(+(config.alphaProtectThresholdPct ?? 0.3), 0, 100);
  const alphaProtectOn     = config.alphaProtectEnabled !== false;

  // ── Initialise pool ──────────────────────────────────────────────────────────
  const h0   = hourly[0];
  const p1_0 = h0.c1, p2_0 = h0.c2;

  // Initial price ratio (Asset1/Asset2)
  let rCenter = p1_0 / p2_0;
  let rLow    = rCenter * (1 - bandPct);
  let rHigh   = rCenter * (1 + bandPct);

  // Compute initial L from real capital
  let L = computeL(realCapital, p1_0, p2_0, rCenter, rLow, rHigh);
  if (L <= 0) return { error: 'Band width too small or capital too low — L is zero.' };

  // Integer share positions (real NSE holdings)
  const res0 = v3Reserves(L, rCenter, rLow, rHigh);
  let xShares = Math.max(1, Math.round(res0.x));  // Asset1 integer shares
  let yShares = Math.max(1, Math.round(res0.y));  // Asset2 integer shares

  // Hold reference (unchanged throughout)
  const xInit = xShares;
  const yInit = yShares;
  const initCapital = xInit * p1_0 + yInit * p2_0;

  // ── State ────────────────────────────────────────────────────────────────────
  let rPrev          = rCenter;  // ratio at end of previous hour
  let cashProfit     = 0;
  let totalBrokerage = 0;
  let grossSwapFees  = 0;
  let totalSwaps     = 0;
  let successSwaps   = 0;
  let recenterCount  = 0;

  let swapsHalted    = false;
  let haltReason     = null;
  let ilHaltedAt     = null;
  let ilResumedAt    = null;
  let haltCount      = 0;
  let alphaProtected = false;

  const swapRecords  = [];
  const equityCurve  = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initCapital, holdValue: initCapital,
    cashProfit: 0, alphaINR: 0, ilPct: 0,
    rCenter, rLow, rHigh, L,
    halted: false, haltReason: null,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row  = hourly[idx];
    const p1   = row.c1, p2 = row.c2;
    const rNew = p1 / p2;   // current ratio

    // Current real portfolio values
    const pvNow = xShares * p1 + yShares * p2;
    const hvNow = xInit   * p1 + yInit   * p2;
    const ilPctNow   = hvNow > 0 ? (pvNow / hvNow - 1) * 100 : 0;
    const cashRoiNow = initCapital > 0 ? cashProfit / initCapital * 100 : 0;

    // ── AUTO-RESUME ────────────────────────────────────────────────────────────
    if (swapsHalted) {
      if (haltReason === 'IL_STOP' && ilResumePct > 0 && ilPctNow >= -ilResumePct) {
        swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
      } else if (haltReason === 'ALPHA_PROTECT' && cashRoiNow > 0 && Math.abs(ilPctNow) < cashRoiNow) {
        swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
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

    // ── OUT OF RANGE → RECENTER ────────────────────────────────────────────────
    if (rNew < rLow || rNew > rHigh) {
      // Recompute position at new center, preserving portfolio value.
      // No brokerage on recenter — this is a position rebalance, not an NSE order.
      const capNow = xShares * p1 + yShares * p2;
      rCenter = rNew;
      rLow    = rCenter * (1 - bandPct);
      rHigh   = rCenter * (1 + bandPct);
      L       = computeL(capNow, p1, p2, rCenter, rLow, rHigh);
      if (L > 0) {
        const resNew = v3Reserves(L, rCenter, rLow, rHigh);
        xShares = Math.max(1, Math.round(resNew.x));
        yShares = Math.max(1, Math.round(resNew.y));
      }
      rPrev = rCenter;
      recenterCount++;

      const pv2 = xShares * p1 + yShares * p2;
      const hv2 = xInit   * p1 + yInit   * p2;
      equityCurve.push({
        date: row.date.toISOString(),
        poolValue: pv2 + cashProfit, holdValue: hv2,
        cashProfit, alphaINR: pv2 + cashProfit - hv2,
        ilPct: hv2 > 0 ? (pv2/hv2-1)*100 : 0,
        rCenter, rLow, rHigh, L,
        halted: swapsHalted, haltReason,
      });
      continue;
    }

    // ── IN RANGE → V3 SWAP ────────────────────────────────────────────────────
    if (!swapsHalted) {
      const { dx, dy } = v3SwapDelta(L, rPrev, rNew);

      // Convert continuous V3 deltas to integer NSE share counts
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const dxInt = absDx >= 0.5 ? Math.round(absDx) : 0;
      const dyInt = absDy >= 0.5 ? Math.round(absDy) : 0;

      if (dxInt >= 1 && dyInt >= 1) {
        let didSwap = false;

        if (dx < 0) {
          // ── Ratio ROSE: pool releases Asset1, absorbs Asset2 ────────────────
          // NSE: BUY dyInt Asset2, SELL dxInt Asset1
          const sellQty = Math.min(dxInt, xShares - 1);  // floor guard
          if (sellQty >= 1) {
            const cost    = dyInt   * p2;  // pay for Asset2
            const revenue = sellQty * p1;  // receive from selling Asset1
            const brok    = buyBrok * cost + sellBrok * revenue;
            const gross   = revenue - cost;
            const net     = gross - brok;
            if (net > 0) {
              xShares -= sellQty;
              yShares += dyInt;
              cashProfit     += net;
              totalBrokerage += brok;
              grossSwapFees  += gross;
              totalSwaps++; successSwaps++;
              didSwap = true;

              const pvS = xShares * p1 + yShares * p2;
              const hvS = xInit   * p1 + yInit   * p2;
              swapRecords.push({
                date: row.date.toISOString(),
                action: 'Buy Asset 2 / Sell Asset 1',
                buyAsset: 'Asset 2', buyQty: dyInt,   cost,
                sellAsset:'Asset 1', sellQty,          revenue,
                gross, brok, net, cashProfit,
                asset1Price: p1, asset2Price: p2,
                poolX: xShares, poolY: yShares,
                ilPct: hvS > 0 ? (pvS/hvS-1)*100 : 0,
                totalValue: pvS + cashProfit,
                haltReason, rLow, rHigh, rCenter, L,
                dx, dy,  // raw V3 deltas (for transparency)
              });
            }
          }

        } else if (dx > 0) {
          // ── Ratio FELL: pool releases Asset2, absorbs Asset1 ────────────────
          // NSE: BUY dxInt Asset1, SELL dyInt Asset2
          const sellQty = Math.min(dyInt, yShares - 1);
          if (sellQty >= 1) {
            const cost    = dxInt   * p1;
            const revenue = sellQty * p2;
            const brok    = buyBrok * cost + sellBrok * revenue;
            const gross   = revenue - cost;
            const net     = gross - brok;
            if (net > 0) {
              xShares += dxInt;
              yShares -= sellQty;
              cashProfit     += net;
              totalBrokerage += brok;
              grossSwapFees  += gross;
              totalSwaps++; successSwaps++;
              didSwap = true;

              const pvS = xShares * p1 + yShares * p2;
              const hvS = xInit   * p1 + yInit   * p2;
              swapRecords.push({
                date: row.date.toISOString(),
                action: 'Buy Asset 1 / Sell Asset 2',
                buyAsset: 'Asset 1', buyQty: dxInt,   cost,
                sellAsset:'Asset 2', sellQty,          revenue,
                gross, brok, net, cashProfit,
                asset1Price: p1, asset2Price: p2,
                poolX: xShares, poolY: yShares,
                ilPct: hvS > 0 ? (pvS/hvS-1)*100 : 0,
                totalValue: pvS + cashProfit,
                haltReason, rLow, rHigh, rCenter, L,
                dx, dy,
              });
            }
          }
        }
      }
    }

    rPrev = rNew;  // update ratio for next hour's delta calculation

    // ── Equity snapshot ─────────────────────────────────────────────────────────
    const pv = xShares * p1 + yShares * p2;
    const hv = xInit   * p1 + yInit   * p2;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv + cashProfit, holdValue: hv,
      cashProfit, alphaINR: pv + cashProfit - hv,
      ilPct: hv > 0 ? (pv/hv-1)*100 : 0,
      rCenter, rLow, rHigh, L,
      halted: swapsHalted, haltReason,
    });
  }

  // ── Final results ─────────────────────────────────────────────────────────────
  const last       = hourly[hourly.length - 1];
  const holdValue  = xInit   * last.c1 + yInit   * last.c2;
  const poolAssets = xShares * last.c1 + yShares * last.c2;
  const totalValue = poolAssets + cashProfit;
  const ilINR      = poolAssets - holdValue;
  const ilPct      = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const vsHold     = totalValue - holdValue;
  const vsHoldPct  = holdValue  > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  // Concentration factor (V3 amplification vs full-range)
  const concentrationFactor = rLow > 0 ? 1 / (1 - Math.sqrt(rLow / rHigh)) : 1;

  const results = {
    realCapital, initCapital, totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossSwapFees,
    vsHold, vsHoldPct,
    roiPct:   initCapital > 0 ? (totalValue  / initCapital - 1) * 100 : 0,
    holdRoi:  initCapital > 0 ? (holdValue   / initCapital - 1) * 100 : 0,
    cashRoi:  initCapital > 0 ?  cashProfit  / initCapital * 100 : 0,
    brokRoi:  initCapital > 0 ?  totalBrokerage / initCapital * 100 : 0,
    ilINR, ilPct,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt,
    haltCount, alphaProtected,
    totalSwaps, successSwaps, recenterCount,
    successRate: totalSwaps > 0 ? successSwaps / totalSwaps : 0,
    initialX: xInit, initialY: yInit, finalX: xShares, finalY: yShares,
    bandPct: bandPct * 100, concentrationFactor,
    rCenter, rLow, rHigh, L,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
  };

  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);
  return { swaps: swapRecords, equityCurve, results, performanceSummary };
}
