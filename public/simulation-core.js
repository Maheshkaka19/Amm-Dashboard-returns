// simulation-core.js  —  Uniswap V3 Concentrated Liquidity  (v4.1 — rounding fixes)
// ─────────────────────────────────────────────────────────────────────────────
//
//  ROUNDING-ERROR FIXES (v4.1)
//  ────────────────────────────
//  Root cause: independent Math.round() on both legs of every swap breaks the
//  V3 invariant and silently adds/removes value.
//
//  Fix strategy:
//  1. SELL side is rounded first (floor, not round — never sell more than held).
//  2. BUY side is derived from sell proceeds so the trade is always self-funding:
//       buyQty = floor(sellRevenue / buyPrice)   [whole shares the proceeds cover]
//     This guarantees revenue ≥ cost before brokerage, which is the only condition
//     for a real-world profitable round-trip.
//  3. Recenter rounding residual is reconciled: after rounding xShares/yShares,
//     the ₹ difference vs the exact fractional position is added to cashProfit
//     as a "rounding adjustment" (could be small positive or negative).
//  4. Compound rounding residual is reconciled the same way.
//  5. No trade executes if buyQty < 1 or sellQty < 1.
//
//  UNISWAP V3 MATHEMATICS (Adams et al. 2021)
//  ─────────────────────────────────────────────
//  Core invariant within [p_lower, p_upper]:
//    (x + L/√p_upper) × (y + L×√p_lower) = L²
//
//  Virtual reserves at ratio r ∈ [rLow, rHigh]:
//    x_virtual = L × (1/√r   − 1/√rHigh)
//    y_virtual = L × (√r     −   √rLow)
//
//  Swap delta (rOld → rNew, both in range):
//    Δx = L × (1/√rNew − 1/√rOld)
//    Δy = L × (√rNew   −   √rOld)
//
//  Optimal half-width via Lagrangian:
//    f(α) = 2√(1−α)/(2−α) − 1 + θ = 0   solved by Newton-Raphson
//
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

export function buildHourly(a1, a2) {
  const map = new Map();
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) {
      const key = (() => { const d = new Date(a1[i].date); d.setMinutes(0,0,0); return d.toISOString(); })();
      if (!map.has(key)) map.set(key, { date: new Date(key), c1: a1[i].close, c2: a2[j].close });
      const b = map.get(key); b.c1 = a1[i].close; b.c2 = a2[j].close;
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── CALCULUS ENGINE ──────────────────────────────────────────────────────────

function exactIL(alpha) {
  const rRatio = 1 - alpha;
  if (rRatio <= 0) return -1;
  return 2 * Math.sqrt(rRatio) / (1 + rRatio) - 1;
}

function exactILDeriv(alpha) {
  const rRatio = 1 - alpha;
  if (rRatio <= 0) return 0;
  const sr = Math.sqrt(rRatio);
  return -(1 - rRatio) / (sr * (1 + rRatio) ** 2);
}

function solveOptimalAlpha(theta, maxIter = 20) {
  if (theta <= 0) return 0.05;
  if (theta >= 0.5) return 0.85;
  let alpha = clamp(Math.sqrt(8 * theta), 0.01, 0.90);
  for (let i = 0; i < maxIter; i++) {
    const f  = exactIL(alpha) + theta;
    const fp = exactILDeriv(alpha);
    if (Math.abs(fp) < 1e-12) break;
    const delta = f / fp;
    alpha = clamp(alpha - delta, 0.01, 0.92);
    if (Math.abs(delta) < 1e-8) break;
  }
  return clamp(alpha, 0.03, 0.90);
}

function adaptiveBudget(thetaBase, cashROIpct, lambda = 3.0, thetaMin = 0.01) {
  return Math.max(thetaMin, thetaBase * Math.exp(-lambda * Math.max(0, cashROIpct) / 100));
}

function updateEWMA(prevVar, logReturn, lambda = 0.94) {
  return lambda * prevVar + (1 - lambda) * logReturn * logReturn;
}

function inventorySkew(xShares, yShares, p1, p2) {
  const xVal = xShares * p1, yVal = yShares * p2, total = xVal + yVal;
  if (total < 1e-6) return 0;
  return (xVal - yVal) / total;
}

function computeOptimalRange(rCenter, alpha, skew = 0, sigmaBoost = 0) {
  const alphaAdj = clamp(alpha * (1 + sigmaBoost), 0.03, 0.92);
  const skewMag  = clamp(Math.abs(skew), 0, 0.45);
  let alphaDown, alphaUp;
  if (skew > 0) {
    alphaDown = alphaAdj * (1 + skewMag * 0.6);
    alphaUp   = alphaAdj * (1 - skewMag * 0.4);
  } else {
    alphaDown = alphaAdj * (1 - skewMag * 0.4);
    alphaUp   = alphaAdj * (1 + skewMag * 0.6);
  }
  alphaDown = clamp(alphaDown, 0.03, 0.88);
  alphaUp   = clamp(alphaUp,   0.03, 0.88);
  const rLow  = rCenter * (1 - alphaDown);
  const rHigh = rCenter * (1 + alphaUp);
  return { rLow, rHigh, alphaDown, alphaUp, concentrationFactor: 1 / (1 - Math.sqrt(rLow / rHigh)) };
}

// ─── V3 CORE ──────────────────────────────────────────────────────────────────

function computeL(capital, p1, p2, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r, rLow, rHigh));
  const sra = Math.sqrt(rLow);
  const srb = Math.sqrt(rHigh);
  const denom = (1/sr - 1/srb) * p1 + (sr - sra) * p2;
  return denom > 1e-10 ? capital / denom : 0;
}

function v3Reserves(L, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r, rLow, rHigh));
  const sra = Math.sqrt(rLow);
  const srb = Math.sqrt(rHigh);
  return { x: L * (1/sr - 1/srb), y: L * (sr - sra) };
}

function v3SwapDelta(L, rOld, rNew) {
  return {
    dx: L * (1/Math.sqrt(rNew) - 1/Math.sqrt(rOld)),
    dy: L * (Math.sqrt(rNew)   -   Math.sqrt(rOld)),
  };
}

// ─── ROUNDING RECONCILIATION ─────────────────────────────────────────────────
//
// When we round fractional share counts to integers we create a small ₹ residual.
// We track this explicitly and add it to cashProfit so total portfolio value is
// conserved.  A positive residual means rounding gave us slightly fewer shares
// than the exact fractional amount (we "sold" the fraction for cash).
// A negative residual means rounding gave us slightly more shares (we "bought"
// the fraction from cash).
//
// residual = exactValue - roundedValue
//          = (xFrac * p1 + yFrac * p2) - (xRound * p1 + yRound * p2)

function reconcileRounding(xFrac, yFrac, p1, p2) {
  const xRound = Math.max(1, Math.round(xFrac));
  const yRound = Math.max(1, Math.round(yFrac));
  const residual = (xFrac * p1 + yFrac * p2) - (xRound * p1 + yRound * p2);
  return { xRound, yRound, residual };
}

// ─── PERFORMANCE SUMMARY ──────────────────────────────────────────────────────

export function buildPerformanceSummary(swapRecords, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6);
  const trades        = swapRecords.filter(r => r.type !== 'COMPOUND');
  const grossFees     = trades.reduce((s, r) => s + (r.gross ?? 0), 0);
  const totalFriction = results.totalBrokerage;
  const frictionRatio = grossFees > 0 ? totalFriction / grossFees : 1;
  const successful    = trades.filter(r => (r.net ?? 0) > 0).length;
  const successRate   = trades.length > 0 ? successful / trades.length : 0;

  const alpha = equityCurve.map(p => (p.poolValue ?? 0) - (p.holdValue ?? 0));
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) { if (v > peak) peak = v; if (v - peak < maxDD) maxDD = v - peak; }
  const maxDDPct = equityCurve[0]?.holdValue > 0 ? maxDD / equityCurve[0].holdValue * 100 : 0;

  const aRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mr = aRets.length ? aRets.reduce((s, v) => s + v, 0) / aRets.length : 0;
  let v2 = 0; for (const v of aRets) v2 += (v - mr) ** 2;
  const sd = aRets.length > 1 ? Math.sqrt(v2 / (aRets.length - 1)) : 1e-9;
  const alphaSharpe = sd > 1e-12 ? (mr / sd) * ANNUALISE : 0;

  return {
    grossFees, totalFriction,
    netSwapIncome: grossFees - totalFriction,
    frictionRatio, frictionRatioPct: frictionRatio * 100,
    successfulSwaps: successful, totalSwaps: trades.length,
    successRate, successRatePct: successRate * 100,
    maxDrawdownINR: maxDD, maxDrawdownPct: maxDDPct,
    alphaSharpe,
    concentrationFactor: results.concentrationFactor ?? 1,
    unrealizedIL: results.ilINR,
    netAlphaFinal: results.vsHold,
    reinvestedTotal: results.reinvestedTotal ?? 0,
    compoundEvents:  results.compoundEvents  ?? 0,
    narrative: {
      friction: frictionRatio < 0.10 ? 'GOOD — friction < 10% of gross'
               : frictionRatio < 0.25 ? 'MODERATE — acceptable'
               : 'HIGH — consider wider range or lower brokerage',
      swapQuality: successRate >= 1.0 ? 'PERFECT — every swap profitable'
                  : successRate > 0.85 ? 'EXCELLENT — >85% profitable'
                  : successRate > 0.70 ? 'GOOD — >70% profitable'
                  : 'LOW — check brokerage vs. swap size',
      ilStatus: results.ilPct >= 0 ? 'POSITIVE — pool assets exceed hold value'
               : `NEGATIVE — ₹${Math.abs(results.ilINR).toLocaleString('en-IN', { maximumFractionDigits: 0 })} below hold`,
      concentration: `Avg ${(results.concentrationFactor ?? 1).toFixed(1)}× amplification · calculus-optimal range`,
    },
  };
}

// ─── MAIN SIMULATION ──────────────────────────────────────────────────────────

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const a1 = normalizeRows(df1);
  const a2 = normalizeRows(df2);
  if (!a1.length || !a2.length)
    return { error: 'Both CSV files must have valid date, close, and volume columns.' };

  const hourly = buildHourly(a1, a2);
  if (hourly.length < 2)
    return { error: 'No overlapping timestamps. Confirm both CSVs cover the same period.' };

  // ── Config ────────────────────────────────────────────────────────────────────
  const buyBrok    = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok   = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;
  const reinvestBrok = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;

  const ilBudgetPct    = clamp(+(config.ilBudgetPct ?? 8), 0.5, 40);
  const ilBudgetTheta  = ilBudgetPct / 100;
  const alphaProtectCap    = clamp(+(config.alphaProtectCap ?? 15), 1, 100);
  const alphaProtectLambda = clamp(+(config.alphaProtectLambda ?? 3), 0.5, 10);
  const sigmaMultiplier    = clamp(+(config.sigmaMultiplier ?? 2.0), 0, 10);

  const compoundIntervalHours = clamp(+(config.compoundIntervalHours ?? 24), 1, 168);
  const compoundMinPct        = clamp(+(config.compoundMinPct ?? 0.5), 0.01, 10);

  const ilHardStopPct   = clamp(+(config.ilHardStopPct  ?? 0), 0, 100);
  const ilHardResumePct = clamp(+(config.ilHardResumePct ?? 0), 0, 100);

  // ── Initialise ────────────────────────────────────────────────────────────────
  const h0   = hourly[0];
  const p1_0 = h0.c1, p2_0 = h0.c2;
  let rCenter = p1_0 / p2_0;

  const alpha0 = solveOptimalAlpha(ilBudgetTheta);
  const { rLow: rLow0, rHigh: rHigh0 } = computeOptimalRange(rCenter, alpha0);
  let rLow = rLow0, rHigh = rHigh0;

  let L = computeL(realCapital, p1_0, p2_0, rCenter, rLow, rHigh);
  if (L <= 0) return { error: 'Could not compute liquidity parameter. Check input data.' };

  // Initialise integer share counts; reconcile rounding residual into cash
  const res0 = v3Reserves(L, rCenter, rLow, rHigh);
  const { xRound: xInit0, yRound: yInit0, residual: initResidual } =
    reconcileRounding(res0.x, res0.y, p1_0, p2_0);

  let xShares = xInit0;
  let yShares = yInit0;

  // Hold reference — fixed at integer shares from t=0
  const xInit = xShares;
  const yInit = yShares;
  // initCapital is what we actually deployed (integer shares × price + rounding residual)
  const initCapital = xInit * p1_0 + yInit * p2_0 + initResidual;

  // ── State ─────────────────────────────────────────────────────────────────────
  let rPrev = rCenter;
  let cashProfit      = initResidual;  // seed with rounding residual from initialisation
  let totalBrokerage  = 0;
  let grossSwapFees   = 0;
  let totalSwaps      = 0;
  let successSwaps    = 0;
  let recenterCount   = 0;
  let reinvestedTotal = 0;
  let compoundEvents  = 0;
  let totalReinvestBrokerage = 0;
  let roundingAdjTotal = initResidual;  // diagnostic: total rounding adjustments

  let swapsHalted   = false;
  let haltReason    = null;
  let ilHaltedAt    = null;
  let ilResumedAt   = null;
  let haltCount     = 0;

  let ewmaVar = 0;
  let hoursSinceCompound = 0;

  let currentConcentration = 1 / (1 - Math.sqrt(rLow / rHigh));
  let concentrationSum  = currentConcentration;
  let concentrationCount = 1;

  const swapRecords = [];
  const equityCurve = [];
  const rangeLog    = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initCapital, holdValue: initCapital,
    cashProfit, alphaINR: 0, ilPct: 0,
    rCenter, rLow, rHigh, L,
    halted: false, haltReason: null,
    alpha: alpha0, concentration: currentConcentration,
    compoundEvent: false,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row  = hourly[idx];
    const p1   = row.c1, p2 = row.c2;
    const rNew = p1 / p2;

    const logRet = Math.log(rNew / rPrev);
    ewmaVar = updateEWMA(ewmaVar, logRet);
    const ewmaVol = Math.sqrt(ewmaVar);

    hoursSinceCompound++;

    const pvNow    = xShares * p1 + yShares * p2;
    const hvNow    = xInit   * p1 + yInit   * p2;
    const ilPctNow = hvNow > 0 ? (pvNow / hvNow - 1) * 100 : 0;
    const cashROINow = initCapital > 0 ? cashProfit / initCapital * 100 : 0;

    const thetaEff = adaptiveBudget(ilBudgetTheta, cashROINow, alphaProtectLambda, 0.015);
    const alphaOpt = solveOptimalAlpha(thetaEff);

    const normSigma  = ewmaVol / 0.005;
    const sigmaBoost = sigmaMultiplier * clamp(normSigma - 1, 0, 3) * 0.1;
    const skew       = inventorySkew(xShares, yShares, p1, p2);

    // ── Auto-resume ──────────────────────────────────────────────────────────
    if (swapsHalted && haltReason === 'IL_STOP') {
      if (ilHardResumePct > 0 && ilPctNow >= -ilHardResumePct) {
        swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
      }
    }

    // ── Halt check ───────────────────────────────────────────────────────────
    if (!swapsHalted && ilHardStopPct > 0 && ilPctNow < -ilHardStopPct) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt  = row.date.toISOString(); haltCount++;
    }

    // ── Out of range → recenter ───────────────────────────────────────────────
    if (rNew < rLow || rNew > rHigh) {
      // Total portfolio value before recenter (includes cash)
      const capNow = xShares * p1 + yShares * p2;

      rCenter = rNew;
      const rangeNew = computeOptimalRange(rCenter, alphaOpt, skew, sigmaBoost);
      rLow  = rangeNew.rLow;
      rHigh = rangeNew.rHigh;

      L = computeL(capNow, p1, p2, rCenter, rLow, rHigh);
      if (L > 0) {
        const resNew = v3Reserves(L, rCenter, rLow, rHigh);
        // FIX 3: reconcile rounding residual — add it to cash so value is conserved
        const { xRound, yRound, residual } = reconcileRounding(resNew.x, resNew.y, p1, p2);
        xShares = xRound;
        yShares = yRound;
        cashProfit     += residual;
        roundingAdjTotal += residual;
      }

      rPrev = rCenter;
      recenterCount++;

      currentConcentration = rangeNew.concentrationFactor;
      concentrationSum += currentConcentration;
      concentrationCount++;

      rangeLog.push({ date: row.date.toISOString(), rCenter, rLow, rHigh, alpha: alphaOpt, theta: thetaEff, concentration: currentConcentration });

      const pv2 = xShares * p1 + yShares * p2;
      const hv2 = xInit   * p1 + yInit   * p2;
      equityCurve.push({
        date: row.date.toISOString(),
        poolValue: pv2 + cashProfit, holdValue: hv2,
        cashProfit, alphaINR: pv2 + cashProfit - hv2,
        ilPct: hv2 > 0 ? (pv2/hv2-1)*100 : 0,
        rCenter, rLow, rHigh, L,
        halted: swapsHalted, haltReason,
        alpha: alphaOpt, concentration: currentConcentration,
        compoundEvent: false,
      });
      continue;
    }

    // ── In range → V3 swap ────────────────────────────────────────────────────
    if (!swapsHalted) {
      const { dx, dy } = v3SwapDelta(L, rPrev, rNew);

      if (dx < 0) {
        // Ratio ROSE: sell Asset1, buy Asset2
        // FIX 1+2: sell side rounded down (floor), buy qty derived from proceeds
        const sellQty = Math.min(Math.floor(Math.abs(dx)), xShares - 1);
        if (sellQty >= 1) {
          const revenue = sellQty * p1;                          // exact proceeds
          const cost    = Math.floor(revenue / p2) * p2;         // how many Asset2 shares proceeds buy
          const buyQty  = Math.floor(revenue / p2);              // whole shares funded by proceeds
          if (buyQty >= 1) {
            const brok = buyBrok * cost + sellBrok * revenue;
            const gross = revenue - cost;
            const net   = gross - brok;
            if (net > 0) {
              xShares -= sellQty;
              yShares += buyQty;
              cashProfit     += net;
              totalBrokerage += brok;
              grossSwapFees  += gross;
              totalSwaps++; successSwaps++;

              const pvS = xShares * p1 + yShares * p2;
              const hvS = xInit   * p1 + yInit   * p2;
              swapRecords.push({
                date: row.date.toISOString(), type: 'TRADE',
                action: 'Buy Asset 2 / Sell Asset 1',
                buyAsset: 'Asset 2', buyQty,   cost,
                sellAsset:'Asset 1', sellQty,  revenue,
                gross, brok, net, cashProfit,
                asset1Price: p1, asset2Price: p2,
                poolX: xShares, poolY: yShares,
                ilPct: hvS > 0 ? (pvS/hvS-1)*100 : 0,
                totalValue: pvS + cashProfit,
                haltReason, rLow, rHigh, rCenter, L,
                dx, dy, alpha: alphaOpt, thetaEff,
                concentration: currentConcentration,
              });
            }
          }
        }

      } else if (dx > 0) {
        // Ratio FELL: sell Asset2, buy Asset1
        // FIX 1+2: sell side rounded down (floor), buy qty derived from proceeds
        const sellQty = Math.min(Math.floor(Math.abs(dy)), yShares - 1);
        if (sellQty >= 1) {
          const revenue = sellQty * p2;
          const cost    = Math.floor(revenue / p1) * p1;
          const buyQty  = Math.floor(revenue / p1);
          if (buyQty >= 1) {
            const brok = buyBrok * cost + sellBrok * revenue;
            const gross = revenue - cost;
            const net   = gross - brok;
            if (net > 0) {
              xShares += buyQty;
              yShares -= sellQty;
              cashProfit     += net;
              totalBrokerage += brok;
              grossSwapFees  += gross;
              totalSwaps++; successSwaps++;

              const pvS = xShares * p1 + yShares * p2;
              const hvS = xInit   * p1 + yInit   * p2;
              swapRecords.push({
                date: row.date.toISOString(), type: 'TRADE',
                action: 'Buy Asset 1 / Sell Asset 2',
                buyAsset: 'Asset 1', buyQty,   cost,
                sellAsset:'Asset 2', sellQty,  revenue,
                gross, brok, net, cashProfit,
                asset1Price: p1, asset2Price: p2,
                poolX: xShares, poolY: yShares,
                ilPct: hvS > 0 ? (pvS/hvS-1)*100 : 0,
                totalValue: pvS + cashProfit,
                haltReason, rLow, rHigh, rCenter, L,
                dx, dy, alpha: alphaOpt, thetaEff,
                concentration: currentConcentration,
              });
            }
          }
        }
      }
    }

    // ── Profit compounding ────────────────────────────────────────────────────
    const compoundThreshold = initCapital * compoundMinPct / 100;
    let didCompound = false;
    if (hoursSinceCompound >= compoundIntervalHours && cashProfit >= compoundThreshold) {
      const grossReinvest = cashProfit * 0.80;
      const brokReinvest  = grossReinvest * reinvestBrok;
      const reinvestAmt   = grossReinvest - brokReinvest;
      const dL = computeL(reinvestAmt, p1, p2, rCenter, rLow, rHigh);
      if (dL > 0) {
        const lBefore = L;
        L += dL;
        const resUpd = v3Reserves(L, rNew, rLow, rHigh);
        const xBefore = xShares, yBefore = yShares;
        // FIX 4: reconcile rounding residual from compound share adjustment
        const { xRound, yRound, residual: compResidual } =
          reconcileRounding(resUpd.x, resUpd.y, p1, p2);
        xShares = xRound;
        yShares = yRound;
        roundingAdjTotal += compResidual;

        reinvestedTotal        += reinvestAmt;
        totalReinvestBrokerage += brokReinvest;
        totalBrokerage         += brokReinvest;
        // deduct gross from cash; compound rounding residual reconciled separately
        cashProfit  -= grossReinvest;
        cashProfit  += compResidual;
        compoundEvents++;
        didCompound = true;

        const pvC = xShares * p1 + yShares * p2;
        const hvC = xInit   * p1 + yInit   * p2;
        swapRecords.push({
          date: row.date.toISOString(),
          type: 'COMPOUND',
          action: '♻ Profit Reinvested into Pool',
          grossReinvest, brokReinvest, reinvestAmt,
          lBefore, lAfter: L, dL,
          xBefore, yBefore,
          xAfter: xShares, yAfter: yShares,
          asset1Price: p1, asset2Price: p2,
          cashProfitBefore: cashProfit + grossReinvest - compResidual,
          cashProfitAfter: cashProfit,
          poolValueAfter: pvC + cashProfit,
          ilPct: hvC > 0 ? (pvC / hvC - 1) * 100 : 0,
          concentration: currentConcentration,
          compoundEvent: compoundEvents,
        });
      }
      hoursSinceCompound = 0;
    }

    rPrev = rNew;

    // ── Equity snapshot ───────────────────────────────────────────────────────
    const pv = xShares * p1 + yShares * p2;
    const hv = xInit   * p1 + yInit   * p2;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv + cashProfit, holdValue: hv,
      cashProfit, alphaINR: pv + cashProfit - hv,
      ilPct: hv > 0 ? (pv/hv-1)*100 : 0,
      rCenter, rLow, rHigh, L,
      halted: swapsHalted, haltReason,
      alpha: alphaOpt, concentration: currentConcentration,
      compoundEvent: didCompound,
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

  const avgConcentration = concentrationCount > 0 ? concentrationSum / concentrationCount : currentConcentration;

  const results = {
    realCapital, initCapital, totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossSwapFees,
    vsHold, vsHoldPct,
    roiPct:   initCapital > 0 ? (totalValue  / initCapital - 1) * 100 : 0,
    holdRoi:  initCapital > 0 ? (holdValue   / initCapital - 1) * 100 : 0,
    cashRoi:  initCapital > 0 ?  cashProfit  / initCapital * 100 : 0,
    brokRoi:  initCapital > 0 ?  totalBrokerage / initCapital * 100 : 0,
    ilINR, ilPct,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt, haltCount,
    totalSwaps, successSwaps, recenterCount,
    successRate: totalSwaps > 0 ? successSwaps / totalSwaps : 0,
    initialX: xInit, initialY: yInit, finalX: xShares, finalY: yShares,
    concentrationFactor: avgConcentration,
    rCenter, rLow, rHigh, L,
    reinvestedTotal, compoundEvents, totalReinvestBrokerage,
    reinvestBrokPct: reinvestBrok * 100,
    roundingAdjTotal,   // diagnostic: total ₹ reconciled via rounding adjustments
    ilBudgetPct, alphaProtectCap,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
  };

  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);
  return { swaps: swapRecords, equityCurve, results, performanceSummary, rangeLog };
}
