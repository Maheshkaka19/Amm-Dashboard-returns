// simulation-core.js  —  Uniswap V3 Concentrated Liquidity Pool
//                        + Alpha-Driven Position Reinvestment
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
//  SWAP DELTA (price ratio moves r_old → r_new within [r_a, r_b]):
//    Δx = L × (1/√r_new − 1/√r_old)
//    Δy = L × (√r_new   −   √r_old)
//
//  ALPHA REINVESTMENT MECHANIC:
//  ────────────────────────────
//  Lot definition: lotX = 1 share of Asset1,
//                  lotY = max(1, round(yShares / xShares)) shares of Asset2
//  This preserves the current pool ratio on each reinvestment.
//
//  Trigger: cashProfit ≥ (lotX × p1 + lotY × p2) × (1 + reinvestBrok)
//  Action:
//    nLots = floor(cashProfit / lotCost)
//    addX  = nLots × lotX
//    addY  = nLots × lotY
//    xShares += addX;  yShares += addY   → pool grows
//    xHold   += addX;  yHold   += addY   → hold benchmark grows symmetrically
//    cashProfit -= (rawCost + brokerage)
//    L = computeL(xShares×p1 + yShares×p2, p1, p2, rCur, rLow, rHigh)
//
//  Invariant after reinvestment:
//    IL% is unchanged at the instant of reinvestment (symmetric delta cancels).
//    Going forward, future swaps continue to generate IL relative to the
//    expanded hold benchmark.
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

function computeL(capital, p1, p2, r, rLow, rHigh) {
  const sr  = Math.sqrt(clamp(r, rLow, rHigh));
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
    x: L * (1/sr - 1/srb),
    y: L * (sr   - sra),
  };
}

// ─── V3 Core: Swap delta ───────────────────────────────────────────────────────

function v3SwapDelta(L, rOld, rNew) {
  const srOld = Math.sqrt(rOld);
  const srNew = Math.sqrt(rNew);
  return {
    dx: L * (1/srNew - 1/srOld),
    dy: L * (srNew   -   srOld),
  };
}

// ─── Performance summary ───────────────────────────────────────────────────────

export function buildPerformanceSummary(swapRecords, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6);

  const grossFees     = swapRecords.reduce((s, r) => s + (r.gross ?? 0), 0);
  const totalFriction = results.totalBrokerage;
  const frictionRatio = grossFees > 0 ? totalFriction / grossFees : 1;
  const successful    = swapRecords.filter(r => (r.net ?? 0) > 0).length;
  const successRate   = swapRecords.length > 0 ? successful / swapRecords.length : 0;

  // Alpha drawdown on equity curve
  const alpha = equityCurve.map(p => (p.poolValue ?? 0) - (p.holdValue ?? 0));
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) { if (v > peak) peak = v; if (v - peak < maxDD) maxDD = v - peak; }
  const maxDDPct = equityCurve[0]?.holdValue > 0 ? maxDD / equityCurve[0].holdValue * 100 : 0;

  // Alpha Sharpe
  const aRets = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mr = aRets.length ? aRets.reduce((s, v) => s + v, 0) / aRets.length : 0;
  let v2 = 0; for (const v of aRets) v2 += (v - mr) ** 2;
  const sd = aRets.length > 1 ? Math.sqrt(v2 / (aRets.length - 1)) : 1e-9;
  const alphaSharpe = sd > 1e-12 ? (mr / sd) * ANNUALISE : 0;

  const rCenter = results.rCenter ?? 1;
  const rLow    = results.rLow    ?? rCenter * 0.8;
  const rHigh   = results.rHigh   ?? rCenter * 1.2;
  const concentrationFactor = rLow > 0 ? 1 / (1 - Math.sqrt(rLow / rHigh)) : 1;

  // Reinvest narrative
  const rc = results.reinvestCount ?? 0;
  const rv = results.totalReinvestedRaw ?? 0;
  const lg = results.LGrowthFactor ?? 1;
  const reinvestNarrative = rc > 0
    ? `${rc} lots reinvested · ₹${(rv/1e5).toFixed(2)}L deployed · L grew ${lg.toFixed(2)}× · compounding active`
    : 'No reinvestments yet — accumulate alpha to trigger';

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
    reinvestCount: rc,
    totalReinvestedRaw: rv,
    totalReinvestBrok: results.totalReinvestBrok ?? 0,
    LInitial: results.LInitial ?? results.L,
    LFinal:   results.L,
    LGrowthFactor: lg,
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
      reinvest: reinvestNarrative,
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
  const bandPct    = clamp(+(config.bandPct          ?? 20.0), 0.5, 99) / 100;
  const buyBrok    = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5)   / 100;
  const sellBrok   = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5)   / 100;

  const ilStopPct   = clamp(+(config.ilStopLossPct ?? 0), 0, 100);
  const ilResumePct = clamp(+(config.ilResumePct   ?? 0), 0, 100);

  const alphaProtectThresh = clamp(+(config.alphaProtectThresholdPct ?? 0.3), 0, 100);
  const alphaProtectOn     = config.alphaProtectEnabled !== false;

  // Reinvestment config
  const reinvestEnabled = config.reinvestEnabled !== false;
  const reinvestBrokPct = clamp(+(config.reinvestBrokeragePct ?? config.buyBrokeragePct ?? 0.15), 0, 5) / 100;

  // ── Initialise pool ──────────────────────────────────────────────────────────
  const h0    = hourly[0];
  const p1_0  = h0.c1, p2_0 = h0.c2;
  let rCenter = p1_0 / p2_0;
  let rLow    = rCenter * (1 - bandPct);
  let rHigh   = rCenter * (1 + bandPct);

  let L = computeL(realCapital, p1_0, p2_0, rCenter, rLow, rHigh);
  if (L <= 0) return { error: 'Band width too small or capital too low — L is zero.' };

  const res0 = v3Reserves(L, rCenter, rLow, rHigh);
  let xShares = Math.max(1, Math.round(res0.x));
  let yShares = Math.max(1, Math.round(res0.y));

  // Fixed initial reference (never changes — used for initial capital display)
  const xInit0     = xShares;
  const yInit0     = yShares;
  const initCapital = xInit0 * p1_0 + yInit0 * p2_0;
  const LInitial   = L;

  // Mutable hold benchmark — grows when reinvested shares are purchased
  // Invariant: xShares - xHold reflects only AMM-induced drift, never reinvestment
  let xHold = xShares;
  let yHold = yShares;

  // ── State ────────────────────────────────────────────────────────────────────
  let rPrev          = rCenter;
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

  // Reinvestment state
  const reinvestRecords  = [];
  let reinvestCount      = 0;
  let totalReinvestedRaw = 0;   // gross capital deployed via reinvestment
  let totalReinvestBrok  = 0;   // brokerage paid on reinvestment
  let totalCapDeployed   = initCapital;

  const swapRecords = [];
  const equityCurve = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initCapital, holdValue: initCapital,
    cashProfit: 0, alphaINR: 0, ilPct: 0,
    rCenter, rLow, rHigh, L, LInitial,
    halted: false, haltReason: null, reinvested: false,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1, p2 = row.c2;
    const rNew = p1 / p2;

    // ── Portfolio values for guard checks ────────────────────────────────────
    const pvNow      = xShares * p1 + yShares * p2;
    const hvNow      = xHold   * p1 + yHold   * p2;
    const ilPctNow   = hvNow > 0 ? (pvNow / hvNow - 1) * 100 : 0;
    // cashRoi uses initCapital so alpha-protection threshold is stable
    const cashRoiNow = initCapital > 0 ? cashProfit / initCapital * 100 : 0;

    // ── AUTO-RESUME ──────────────────────────────────────────────────────────
    if (swapsHalted) {
      if (haltReason === 'IL_STOP' && ilResumePct > 0 && ilPctNow >= -ilResumePct) {
        swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
      } else if (haltReason === 'ALPHA_PROTECT' && cashRoiNow > 0 && Math.abs(ilPctNow) < cashRoiNow) {
        swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
      }
    }

    // ── HALT CHECKS ──────────────────────────────────────────────────────────
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

    // ── OUT OF RANGE → RECENTER ───────────────────────────────────────────────
    let didRecenter = false;
    if (rNew < rLow || rNew > rHigh) {
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
      didRecenter = true;
    }

    // ── IN RANGE → V3 SWAP ───────────────────────────────────────────────────
    if (!didRecenter && !swapsHalted) {
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
              const hvS = xHold   * p1 + yHold   * p2;
              swapRecords.push({
                type: 'swap',
                date: row.date.toISOString(),
                action: 'Buy Asset 2 / Sell Asset 1',
                buyAsset: 'Asset 2', buyQty: dyInt,   cost,
                sellAsset:'Asset 1', sellQty,          revenue,
                gross, brok, net, cashProfit,
                asset1Price: p1, asset2Price: p2,
                poolX: xShares, poolY: yShares,
                ilPct: hvS > 0 ? (pvS/hvS-1)*100 : 0,
                totalValue: pvS + cashProfit,
                haltReason, rLow, rHigh, rCenter, L, dx, dy,
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
              const hvS = xHold   * p1 + yHold   * p2;
              swapRecords.push({
                type: 'swap',
                date: row.date.toISOString(),
                action: 'Buy Asset 1 / Sell Asset 2',
                buyAsset: 'Asset 1', buyQty: dxInt,   cost,
                sellAsset:'Asset 2', sellQty,          revenue,
                gross, brok, net, cashProfit,
                asset1Price: p1, asset2Price: p2,
                poolX: xShares, poolY: yShares,
                ilPct: hvS > 0 ? (pvS/hvS-1)*100 : 0,
                totalValue: pvS + cashProfit,
                haltReason, rLow, rHigh, rCenter, L, dx, dy,
              });
            }
          }
        }
      }
    }

    if (!didRecenter) rPrev = rNew;

    // ── ALPHA REINVESTMENT ────────────────────────────────────────────────────
    //
    // Lot = 1 share Asset1 + round(yShares/xShares) shares Asset2
    // This mirrors the current V3 pool composition ratio.
    //
    // We buy N = floor(cashProfit / lotCost) lots so that ALL available
    // alpha is deployed in one atomic step, minimising idle cash.
    //
    // Both xHold and yHold expand by the same addX/addY, preserving the
    // IL accounting invariant at the instant of reinvestment.
    // ──────────────────────────────────────────────────────────────────────────
    let didReinvest = false;
    if (reinvestEnabled && cashProfit > 0 && xShares > 0 && yShares > 0) {
      // Current-ratio lot (minimum 1:1 floor on Asset2 side)
      const lotX    = 1;
      const lotY    = Math.max(1, Math.round(yShares / xShares));
      const lotRaw  = lotX * p1 + lotY * p2;
      const lotBrok = reinvestBrokPct * lotRaw;
      const lotCost = lotRaw + lotBrok;           // total cost per lot inc. brok

      if (lotCost > 1e-6 && cashProfit >= lotCost) {
        const nLots   = Math.floor(cashProfit / lotCost);
        const addX    = nLots * lotX;             // integer Asset1 shares to add
        const addY    = nLots * lotY;             // integer Asset2 shares to add
        const rawCost = addX * p1 + addY * p2;   // market value of new shares
        const brok    = reinvestBrokPct * rawCost;
        const spent   = rawCost + brok;

        // Final guard: ensure we have enough cash (floating-point safety)
        if (spent > 0 && cashProfit >= spent && addX >= 1 && addY >= 1) {

          // 1) Add shares to live pool
          xShares += addX;
          yShares += addY;

          // 2) Expand hold benchmark by the same amounts so that IL at this
          //    instant is unchanged (symmetric delta: new shares cancel in IL
          //    numerator and denominator). Future swap drift will again
          //    diverge xShares from xHold, generating meaningful IL signal.
          xHold += addX;
          yHold += addY;

          // 3) Cash accounting
          cashProfit         -= spent;
          totalBrokerage     += brok;
          totalReinvestBrok  += brok;
          totalReinvestedRaw += rawCost;
          totalCapDeployed   += rawCost;
          reinvestCount++;
          didReinvest = true;

          // 4) Recompute L from new pool capital
          //    Clamp rCur to [rLow, rHigh] to handle edge timing
          const rCur    = clamp(rNew, rLow, rHigh);
          const capAfter = xShares * p1 + yShares * p2;
          L = computeL(capAfter, p1, p2, rCur, rLow, rHigh);

          reinvestRecords.push({
            type: 'reinvest',
            date:  row.date.toISOString(),
            lotX, lotY, nLots,
            addX,  addY,
            rawCost, brok, spent,
            cashProfitAfter: cashProfit,
            xShares, yShares,
            xHold, yHold,
            L,
            asset1Price: p1,
            asset2Price: p2,
            rCenter, rLow, rHigh,
            poolValue:   xShares * p1 + yShares * p2,
            reinvestCount,
            totalReinvestedRaw,
            LGrowthFactor: LInitial > 0 ? L / LInitial : 1,
          });
        }
      }
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
      ilPct:      hv > 0 ? (pv/hv-1)*100 : 0,
      rCenter, rLow, rHigh, L, LInitial,
      halted:     swapsHalted,
      haltReason,
      reinvested: didReinvest,
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
  const concentrationFactor = rLow > 0 ? 1 / (1 - Math.sqrt(rLow / rHigh)) : 1;

  // Total swap income ever generated (before spending on reinvestment)
  const totalSwapIncome = cashProfit + totalReinvestedRaw + totalReinvestBrok;

  const results = {
    realCapital, initCapital, totalCapDeployed,
    totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossSwapFees,
    totalSwapIncome,
    totalSwapRoi: initCapital > 0 ? totalSwapIncome / initCapital * 100 : 0,
    vsHold, vsHoldPct,
    roiPct:   initCapital > 0 ? (totalValue  / initCapital - 1) * 100 : 0,
    holdRoi:  totalCapDeployed > 0 ? (holdValue   / totalCapDeployed - 1) * 100 : 0,
    cashRoi:  initCapital > 0 ?  cashProfit  / initCapital * 100 : 0,
    brokRoi:  initCapital > 0 ?  totalBrokerage / initCapital * 100 : 0,
    ilINR, ilPct,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt,
    haltCount, alphaProtected,
    totalSwaps, successSwaps, recenterCount,
    successRate: totalSwaps > 0 ? successSwaps / totalSwaps : 0,
    initialX: xInit0, initialY: yInit0,
    finalX: xShares, finalY: yShares,
    xHold, yHold,
    bandPct: bandPct * 100, concentrationFactor,
    rCenter, rLow, rHigh, L, LInitial,
    LGrowthFactor: LInitial > 0 ? L / LInitial : 1,
    buyBrokeragePct:  buyBrok  * 100,
    sellBrokeragePct: sellBrok * 100,
    // Reinvestment
    reinvestEnabled,
    reinvestCount,
    totalReinvestedRaw,
    totalReinvestBrok,
  };

  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);
  return { swaps: swapRecords, equityCurve, results, performanceSummary, reinvests: reinvestRecords };
}
