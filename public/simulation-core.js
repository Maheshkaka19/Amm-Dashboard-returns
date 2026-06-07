// simulation-core.js  —  Uniswap V3 with Calculus-Optimal Range Engine
// ─────────────────────────────────────────────────────────────────────
//
//  CORE CALCULUS: Optimal Range via Lagrangian Maximisation
//  ─────────────────────────────────────────────────────────
//  We maximise fee-yield F(rLow, rHigh) subject to IL constraint IL ≤ θ.
//
//  Fee yield per unit L is proportional to:
//    F ∝ concentration factor C(a,b) = 1 / (1 − √(a/b))
//  where a = rLow/rCenter, b = rHigh/rCenter (normalised).
//
//  Impermanent Loss for a V3 position (exact, Adams et al.):
//    IL(r, a, b) = 2√(r/rCenter)/(1 + r/rCenter) − 1   [in-range IL formula]
//  Evaluated at the range boundaries this gives the "worst-case IL":
//    IL_worst = 2√a/(1+a) − 1   (at lower boundary, symmetric worst case)
//
//  Optimal half-width α* via dL/dα = 0 (Lagrangian):
//    Objective: maximise  C(α) = 1/(1 − 1/√(1+α)) − 1/(1 − √(1−α))
//    Subject to: IL_worst(α) ≤ θ
//
//  Closed-form approximation (2nd-order Taylor + Lagrange multiplier):
//    C(α) ≈ 2/α  (dominant term for small α)
//    IL(α) ≈ α²/8  →  θ = α²/8  →  α* = √(8θ)
//
//  We refine this numerically using Newton-Raphson on the exact formula.
//
//  ADAPTIVE RANGE: Each recenter recomputes α* from:
//    1. Price divergence: σ_r (rolling std of log-ratio returns)
//    2. Inventory imbalance: δ = |xVal − yVal| / (xVal + yVal)
//    3. IL budget θ: starts at ilBudget, shrinks as cashROI builds
//       (alpha protection: θ_eff = max(ilBudget × (1 − cashROI/protectCap), θ_min))
//
//  Dynamic IL budget:
//    θ_eff = ilBudget × exp(−λ × cashROI / initCapital)
//    λ controls how quickly the budget shrinks as alpha accumulates.
//
//  Range asymmetry (inventory skew):
//    When pool is Asset1-heavy (xVal > yVal):
//      rLow  = rCenter × (1 − α* × (1 + δ_skew))   [wider downside]
//      rHigh = rCenter × (1 + α* × (1 − δ_skew))   [tighter upside]
//    Rationale: wider downside absorbs more Asset1 → more rebalancing swaps.
//
//  PROFIT COMPOUNDING:
//    Cash profits are periodically reinvested as additional liquidity (L boost).
//    Every compoundIntervalHours, if cashProfit > compoundThreshold:
//      ΔL = computeL(cashProfitToReinvest, p1, p2, rCenter, rLow, rHigh)
//      L  += ΔL    (and shares updated to reflect new L)
//      reinvestedTotal += cashProfitToReinvest
//      cashProfit -= cashProfitToReinvest   (moved into pool)
//
//  VOLATILITY-ADAPTIVE σ:
//    σ_r = exponentially weighted std of hourly log(r_t / r_{t-1})
//    EWMA with λ=0.94 (RiskMetrics standard).
//    α*(σ) = α_calculus × (1 + σ_multiplier × σ_normalised)
//    Wider range in volatile regimes reduces recenter frequency.
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
      const b = map.get(key);
      b.c1 = a1[i].close; b.c2 = a2[j].close;
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── CALCULUS ENGINE: Optimal Half-Width ──────────────────────────────────────
//
// Exact IL at lower boundary for a V3 range:
//   IL(α) = 2√(1−α)/(2−α) − 1   [where α = 1 − rLow/rCenter]
//
// Fee concentration:
//   C(α_low, α_high) = 1 / (1 − √((1−α_low)/(1+α_high)))
//
// We solve for α such that IL(α) = −θ (IL budget θ > 0)
// using Newton-Raphson on f(α) = IL(α) + θ = 0.
//
// Returns optimal half-width α ∈ (0, 0.95)

function exactIL(alpha) {
  // alpha = fractional downside distance from center (0 < alpha < 1)
  const rRatio = 1 - alpha;  // rLow/rCenter
  if (rRatio <= 0) return -1;
  return 2 * Math.sqrt(rRatio) / (1 + rRatio) - 1;
}

function exactILDeriv(alpha) {
  const rRatio = 1 - alpha;
  if (rRatio <= 0) return 0;
  const sr = Math.sqrt(rRatio);
  // d/d(alpha) [2√(1-α)/(2-α)] = d/d(rR) [2√rR/(1+rR)] × (-1)
  // = −(1 − rR) / (sr × (1+rR)²)
  return -(1 - rRatio) / (sr * (1 + rRatio) ** 2);
}

function solveOptimalAlpha(theta, maxIter = 20) {
  // theta = IL budget (0 < theta < 1), e.g. 0.05 = 5% max IL
  // Initial guess from Taylor: alpha ≈ sqrt(8*theta)
  if (theta <= 0) return 0.05;
  if (theta >= 0.5) return 0.85;  // very wide

  let alpha = Math.sqrt(8 * theta);
  alpha = clamp(alpha, 0.01, 0.90);

  // Newton-Raphson: f(alpha) = exactIL(alpha) + theta = 0
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

// ─── Adaptive IL budget ───────────────────────────────────────────────────────
//
// θ_eff(t) = θ_base × exp(−λ × cashROI/100)
// λ = 3 means budget halves after ~23% cashROI is accumulated.

function adaptiveBudget(thetaBase, cashROIpct, lambda = 3.0, thetaMin = 0.01) {
  const theta = thetaBase * Math.exp(-lambda * Math.max(0, cashROIpct) / 100);
  return Math.max(thetaMin, theta);
}

// ─── EWMA Volatility ──────────────────────────────────────────────────────────

function updateEWMA(prevVar, logReturn, lambda = 0.94) {
  return lambda * prevVar + (1 - lambda) * logReturn * logReturn;
}

// ─── Inventory skew factor ────────────────────────────────────────────────────
//
// Returns delta ∈ [−1, 1]:
//   δ > 0: pool is Asset1-heavy → widen downside
//   δ < 0: pool is Asset2-heavy → widen upside

function inventorySkew(xShares, yShares, p1, p2) {
  const xVal = xShares * p1;
  const yVal = yShares * p2;
  const total = xVal + yVal;
  if (total < 1e-6) return 0;
  return (xVal - yVal) / total;  // +1 = all Asset1, -1 = all Asset2
}

// ─── Compute range from calculus ─────────────────────────────────────────────
//
// Returns { rLow, rHigh, alpha, concentrationFactor }

function computeOptimalRange(rCenter, alpha, skew = 0, sigmaBoost = 0) {
  // Volatility-adjusted alpha
  const alphaAdj = clamp(alpha * (1 + sigmaBoost), 0.03, 0.92);

  // Asymmetric range based on inventory skew
  const skewMag = clamp(Math.abs(skew), 0, 0.45);
  let alphaDown, alphaUp;

  if (skew > 0) {
    // Asset1 heavy: widen downside, tighten upside
    alphaDown = alphaAdj * (1 + skewMag * 0.6);
    alphaUp   = alphaAdj * (1 - skewMag * 0.4);
  } else {
    // Asset2 heavy: widen upside, tighten downside
    alphaDown = alphaAdj * (1 - skewMag * 0.4);
    alphaUp   = alphaAdj * (1 + skewMag * 0.6);
  }

  alphaDown = clamp(alphaDown, 0.03, 0.88);
  alphaUp   = clamp(alphaUp,   0.03, 0.88);

  const rLow  = rCenter * (1 - alphaDown);
  const rHigh = rCenter * (1 + alphaUp);

  const concentrationFactor = 1 / (1 - Math.sqrt(rLow / rHigh));

  return { rLow, rHigh, alphaDown, alphaUp, concentrationFactor };
}

// ─── V3 Core ──────────────────────────────────────────────────────────────────

function computeL(capital, p1, p2, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r,    rLow, rHigh));
  const sra = Math.sqrt(rLow);
  const srb = Math.sqrt(rHigh);
  const denom = (1/sr - 1/srb) * p1 + (sr - sra) * p2;
  return denom > 1e-10 ? capital / denom : 0;
}

function v3Reserves(L, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r, rLow, rHigh));
  const sra = Math.sqrt(rLow);
  const srb = Math.sqrt(rHigh);
  return {
    x: L * (1/sr - 1/srb),
    y: L * (sr   - sra),
  };
}

function v3SwapDelta(L, rOld, rNew) {
  const srOld = Math.sqrt(rOld);
  const srNew = Math.sqrt(rNew);
  const dx = L * (1/srNew - 1/srOld);
  const dy = L * (srNew   -   srOld);
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

  const concentrationFactor = results.concentrationFactor ?? 1;

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
      concentration: `Avg ${concentrationFactor.toFixed(1)}× amplification · calculus-optimal range`,
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

  // ── Config ───────────────────────────────────────────────────────────────────
  const buyBrok  = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;

  // IL budget: base theta for optimal range calculation (e.g. 0.08 = 8% max IL)
  const ilBudgetPct    = clamp(+(config.ilBudgetPct ?? 8), 0.5, 40);
  const ilBudgetTheta  = ilBudgetPct / 100;

  // Alpha protection: shrink IL budget as alpha grows
  const alphaProtectCap   = clamp(+(config.alphaProtectCap ?? 15), 1, 100); // % cashROI at which budget → min
  const alphaProtectLambda = clamp(+(config.alphaProtectLambda ?? 3), 0.5, 10);

  // Volatility: sigma multiplier for range widening
  const sigmaMultiplier = clamp(+(config.sigmaMultiplier ?? 2.0), 0, 10);

  // Compounding
  const compoundIntervalHours = clamp(+(config.compoundIntervalHours ?? 24), 1, 168);
  const compoundMinPct        = clamp(+(config.compoundMinPct ?? 0.5), 0.01, 10); // min % of capital to trigger

  // IL hard stop (optional, 0 = disabled)
  const ilHardStopPct  = clamp(+(config.ilHardStopPct ?? 0), 0, 100);
  const ilHardResumePct = clamp(+(config.ilHardResumePct ?? 0), 0, 100);

  // ── Initialise ───────────────────────────────────────────────────────────────
  const h0    = hourly[0];
  const p1_0  = h0.c1, p2_0 = h0.c2;
  let rCenter = p1_0 / p2_0;

  // Initial optimal range (no volatility data yet, use base theta)
  const alpha0 = solveOptimalAlpha(ilBudgetTheta);
  const { rLow: rLow0, rHigh: rHigh0 } = computeOptimalRange(rCenter, alpha0);
  let rLow  = rLow0;
  let rHigh = rHigh0;

  let L = computeL(realCapital, p1_0, p2_0, rCenter, rLow, rHigh);
  if (L <= 0) return { error: 'Could not compute liquidity parameter. Check input data.' };

  const res0 = v3Reserves(L, rCenter, rLow, rHigh);
  let xShares = Math.max(1, Math.round(res0.x));
  let yShares = Math.max(1, Math.round(res0.y));

  const xInit     = xShares;
  const yInit     = yShares;
  const initCapital = xInit * p1_0 + yInit * p2_0;

  // ── State ────────────────────────────────────────────────────────────────────
  let rPrev           = rCenter;
  let cashProfit      = 0;
  let totalBrokerage  = 0;
  let grossSwapFees   = 0;
  let totalSwaps      = 0;
  let successSwaps    = 0;
  let recenterCount   = 0;
  let reinvestedTotal = 0;
  let compoundEvents  = 0;

  let swapsHalted   = false;
  let haltReason    = null;
  let ilHaltedAt    = null;
  let ilResumedAt   = null;
  let haltCount     = 0;

  // EWMA variance of log ratio returns
  let ewmaVar = 0;
  let hoursSinceCompound = 0;

  // Track current concentration factor for metrics
  let currentConcentration = 1 / (1 - Math.sqrt(rLow / rHigh));
  let concentrationSum = currentConcentration;
  let concentrationCount = 1;

  const swapRecords = [];
  const equityCurve = [];
  const rangeLog    = [];  // record of range changes for visualisation

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initCapital, holdValue: initCapital,
    cashProfit: 0, alphaINR: 0, ilPct: 0,
    rCenter, rLow, rHigh, L,
    halted: false, haltReason: null,
    alpha: alpha0, concentration: currentConcentration,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row  = hourly[idx];
    const p1   = row.c1, p2 = row.c2;
    const rNew = p1 / p2;

    // Update EWMA volatility
    const logRet = Math.log(rNew / rPrev);
    ewmaVar = updateEWMA(ewmaVar, logRet);
    const ewmaVol = Math.sqrt(ewmaVar);  // hourly vol of ratio

    hoursSinceCompound++;

    // Current portfolio values
    const pvNow     = xShares * p1 + yShares * p2;
    const hvNow     = xInit   * p1 + yInit   * p2;
    const ilPctNow  = hvNow > 0 ? (pvNow / hvNow - 1) * 100 : 0;
    const cashROINow = initCapital > 0 ? cashProfit / initCapital * 100 : 0;

    // ── Calculus: recompute optimal theta and alpha ───────────────────────────
    const thetaEff = adaptiveBudget(ilBudgetTheta, cashROINow, alphaProtectLambda, 0.015);
    const alphaOpt = solveOptimalAlpha(thetaEff);

    // Volatility boost: wider range in volatile periods
    // Normalise ewmaVol to a typical hourly vol (assume 0.5% typical)
    const normSigma   = ewmaVol / 0.005;
    const sigmaBoost  = sigmaMultiplier * clamp(normSigma - 1, 0, 3) * 0.1;

    // Inventory skew
    const skew = inventorySkew(xShares, yShares, p1, p2);

    // ── AUTO-RESUME ───────────────────────────────────────────────────────────
    if (swapsHalted && haltReason === 'IL_STOP') {
      if (ilHardResumePct > 0 && ilPctNow >= -ilHardResumePct) {
        swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
      }
    }

    // ── HALT CHECK ────────────────────────────────────────────────────────────
    if (!swapsHalted && ilHardStopPct > 0 && ilPctNow < -ilHardStopPct) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt  = row.date.toISOString(); haltCount++;
    }

    // ── OUT OF RANGE → RECENTER with new calculus range ──────────────────────
    if (rNew < rLow || rNew > rHigh) {
      const capNow = xShares * p1 + yShares * p2;
      rCenter = rNew;

      const rangeNew = computeOptimalRange(rCenter, alphaOpt, skew, sigmaBoost);
      rLow  = rangeNew.rLow;
      rHigh = rangeNew.rHigh;

      L = computeL(capNow, p1, p2, rCenter, rLow, rHigh);
      if (L > 0) {
        const resNew = v3Reserves(L, rCenter, rLow, rHigh);
        xShares = Math.max(1, Math.round(resNew.x));
        yShares = Math.max(1, Math.round(resNew.y));
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
      });
      continue;
    }

    // ── IN RANGE → V3 SWAP ───────────────────────────────────────────────────
    if (!swapsHalted) {
      const { dx, dy } = v3SwapDelta(L, rPrev, rNew);

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const dxInt = absDx >= 0.5 ? Math.round(absDx) : 0;
      const dyInt = absDy >= 0.5 ? Math.round(absDy) : 0;

      if (dxInt >= 1 && dyInt >= 1) {
        if (dx < 0) {
          // Ratio ROSE: pool releases Asset1, absorbs Asset2
          // NSE: BUY dyInt Asset2, SELL dxInt Asset1
          const sellQty = Math.min(dxInt, xShares - 1);
          if (sellQty >= 1) {
            const cost    = dyInt   * p2;
            const revenue = sellQty * p1;
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
                dx, dy, alpha: alphaOpt, thetaEff,
                concentration: currentConcentration,
              });
            }
          }
        } else if (dx > 0) {
          // Ratio FELL: pool releases Asset2, absorbs Asset1
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
                dx, dy, alpha: alphaOpt, thetaEff,
                concentration: currentConcentration,
              });
            }
          }
        }
      }
    }

    // ── PROFIT COMPOUNDING ────────────────────────────────────────────────────
    // Reinvest accumulated cash back into pool as additional L
    const compoundThreshold = initCapital * compoundMinPct / 100;
    let didCompound = false;
    let compoundRecord = null;
    if (hoursSinceCompound >= compoundIntervalHours && cashProfit >= compoundThreshold) {
      const reinvestAmt = cashProfit * 0.80;  // reinvest 80%, keep 20% as reserve
      const dL = computeL(reinvestAmt, p1, p2, rCenter, rLow, rHigh);
      if (dL > 0) {
        const lBefore = L;
        L += dL;
        const resUpd = v3Reserves(L, rNew, rLow, rHigh);
        const xBefore = xShares, yBefore = yShares;
        xShares = Math.max(1, Math.round(resUpd.x));
        yShares = Math.max(1, Math.round(resUpd.y));
        reinvestedTotal += reinvestAmt;
        cashProfit      -= reinvestAmt;
        compoundEvents++;
        didCompound = true;

        const pvC = xShares * p1 + yShares * p2;
        const hvC = xInit   * p1 + yInit   * p2;
        compoundRecord = {
          date: row.date.toISOString(),
          type: 'COMPOUND',
          action: '♻ Profit Reinvested into Pool',
          reinvestAmt,
          lBefore, lAfter: L, dL,
          xBefore, yBefore,
          xAfter: xShares, yAfter: yShares,
          asset1Price: p1, asset2Price: p2,
          cashProfitBefore: cashProfit + reinvestAmt,
          cashProfitAfter: cashProfit,
          poolValueAfter: pvC + cashProfit,
          ilPct: hvC > 0 ? (pvC / hvC - 1) * 100 : 0,
          concentration: currentConcentration,
          compoundEvent: compoundEvents,
        };
        swapRecords.push(compoundRecord);
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
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt,
    haltCount,
    totalSwaps, successSwaps, recenterCount,
    successRate: totalSwaps > 0 ? successSwaps / totalSwaps : 0,
    initialX: xInit, initialY: yInit, finalX: xShares, finalY: yShares,
    concentrationFactor: avgConcentration,
    rCenter, rLow, rHigh, L,
    reinvestedTotal, compoundEvents,
    ilBudgetPct, alphaProtectCap,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
  };

  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);
  return { swaps: swapRecords, equityCurve, results, performanceSummary, rangeLog };
}
