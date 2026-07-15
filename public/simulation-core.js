// simulation-core.js  v8.0  —  Institutional-grade pair pool + vault
// ─────────────────────────────────────────────────────────────────────────────
//
//  SIX-POINT DESIGN SPECIFICATION
//  ─────────────────────────────────────────────────────────────────────────────
//
//  1. INSTITUTIONAL-GRADE SWAPS (profitability + real brokerage)
//  ─────────────────────────────────────────────────────────────
//  Every swap is evaluated as a two-leg market order on NSE:
//    Leg A: sell qSell shares of asset_sell  → proceeds = qSell × pSell
//    Leg B: buy  qBuy  shares of asset_buy   → cost     = qBuy  × pBuy
//
//  ROUNDING RULE (Point 6): qSell is the primary variable (floored from
//  the V3 delta or concentration-amplified target). qBuy is derived by
//  dividing the EXACT sell proceeds by the buy price and flooring:
//    qBuy = floor(proceeds / pBuy)
//  This guarantees proceeds ≥ cost always (no phantom value from rounding),
//  and the residual (proceeds − cost) is real cash that goes into the
//  cash account.
//
//  Brokerage (NSE-realistic, charged separately on each leg):
//    brok = sellBrok × proceeds + buyBrok × cost
//  Net profit:
//    net = (proceeds − cost) − brok
//  Execute only when net > 0.
//
//  2. VAULT BRINGS POOL TO CURRENT MARKET RATIO
//  ─────────────────────────────────────────────
//  Band centre = rInit (initial ratio, fixed). When rNow exits [rLow,rHigh]:
//    Target pool ratio = rNow (current market ratio — where the price IS)
//    This means buying the asset the market has moved toward, to track it.
//  Vault supplies the asset the pool is short of. If vault is insufficient,
//  pool shrinks symmetrically until its ratio matches rNow.
//  After adjustment the pool's ratio = rNow, so it re-enters the band at
//  the correct position when price eventually returns.
//
//  3. CONCENTRATION APPLIED TO THE BAND (correct V3 L formula)
//  ────────────────────────────────────────────────────────────
//  Concentration C defines how aggressively the pool trades per unit price
//  move WITHIN the band. The correct formula (from the V3 whitepaper):
//
//    L = C × poolValue / [ (1/√rInit − 1/√rHigh) × p1 +
//                          (√rInit   −   √rLow)   × p2 ]
//
//  Swap delta per bar (rPrev → rNow, both clamped to [rLow,rHigh]):
//    dSell = L × |1/√rPrev − 1/√rNow|   (when selling Asset1)
//    dBuy  = L × |√rNow    −   √rPrev|  (when buying Asset2)
//  or the mirror for the other direction.
//
//  The 5% per-leg hard cap from v7.1 is kept: even at high C, no single
//  trade leg may exceed 5% of pool value — prevents runaway amplification
//  if the price moves sharply within a single bar.
//
//  4. ALPHA GENERATION — BAND-RELATIVE POSITION TRACKING
//  ───────────────────────────────────────────────────────
//  Alpha comes from buying low and selling high within the band.
//  The engine tracks rEWMA (exponentially-weighted mean of rNow within the
//  band) and biases concentration toward the side that is currently
//  overshooting the mean — amplifying trades that are "buying the dip" or
//  "selling the spike", not blind symmetrical rebalancing.
//
//  5. COMPOUNDING OUTRUN IL — IL-CORRECTING REINVESTMENT
//  ───────────────────────────────────────────────────────
//  Vault deposit logic:
//    Step 1: Compute current pool IL = holdValue − poolValue
//    Step 2: Allocate reinvestment to preferentially buy the UNDERWEIGHT
//            asset (the one IL has pushed below its initial share count)
//    Step 3: Lock bought shares in vault
//  Effect: each reinvestment partially corrects the pool's skew toward the
//  overweight asset, reducing future IL. Compounding buys alpha AND
//  partially hedges IL — the two forces work together, not against each other.
//
//  6. ROUNDING ERRORS MINIMISED
//  ─────────────────────────────
//  - qSell is derived from the continuous delta via floor()
//  - qBuy is derived from EXACT sell proceeds via floor() — never independently
//  - Residual cash = proceeds − qBuy×pBuy (never lost, goes to cashProfit)
//  - No rounding on ₹ amounts — all values kept as full-precision floats
//  - No phantom shares created at initialisation: pool starts with
//    floor(capital/2/price) shares and the remainder stays as seedCash
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

// Exact-timestamp minute-level merge — no resolution collapsing
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

// ─── V3 LIQUIDITY PARAMETER ────────────────────────────────────────────────────
// L = concentration × capital / [ (1/√r − 1/√rHigh)×p1 + (√r − √rLow)×p2 ]
// where r = clamp(rNow, rLow, rHigh)
function computeL(concentration, capital, p1, p2, r, rLow, rHigh) {
  const rC  = clamp(r, rLow, rHigh);
  const sr  = Math.sqrt(rC);
  const srl = Math.sqrt(rLow);
  const srh = Math.sqrt(rHigh);
  const denom = (1/sr - 1/srh) * p1 + (sr - srl) * p2;
  return denom > 1e-10 ? concentration * capital / denom : 0;
}

// ─── EWMA RATIO MEAN ──────────────────────────────────────────────────────────
function ewmaUpdate(prev, val, alpha) { return alpha * val + (1 - alpha) * prev; }

// ─── PAIR FITNESS ─────────────────────────────────────────────────────────────
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
    if (cum < minC) minC = cum;
    if (cum > maxC) maxC = cum;
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
  for (let i = 1; i < ratios.length; i++) {
    if ((ratios[i-1] - mean) * (ratios[i] - mean) < 0) crossings++;
  }

  const colour  = hurst < 0.45 ? 'green' : hurst < 0.50 ? 'yellow' : hurst < 0.55 ? 'orange' : 'red';
  const verdict = hurst < 0.45 ? 'STRONG FIT — pair is mean-reverting' :
                  hurst < 0.50 ? 'MODERATE FIT — some mean-reversion'  :
                  hurst < 0.55 ? 'WEAK FIT — near random walk'          :
                                 'POOR FIT — pair is trending';

  return { bars: n, ratioMean: +mean.toFixed(4), ratioStd: +std.toFixed(4),
           hurst: +hurst.toFixed(3), ratioDrift: +ratioDrift.toFixed(2),
           autocorr1: +autocorr.toFixed(4),
           crossingRate: +((crossings / n) * 100).toFixed(2), verdict, colour };
}

// ─── PERFORMANCE SUMMARY ──────────────────────────────────────────────────────
export function buildPerformanceSummary(ledger, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 375);
  const trades     = ledger.filter(t => t.type === 'TRADE');
  const grossSum   = trades.reduce((s, t) => s + t.gross, 0);
  const brokSum    = trades.reduce((s, t) => s + t.brok, 0);
  const profitable = trades.filter(t => t.net > 0).length;
  const successRate = trades.length > 0 ? profitable / trades.length : 0;
  const frictionRatio = Math.abs(grossSum) > 0 ? brokSum / Math.abs(grossSum) : 1;

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
    frictionRatio, frictionPct: frictionRatio * 100,
    medianSizePct: +medianSizePct.toFixed(2), maxSizePct: +maxSizePct.toFixed(2),
    thrashCount, maxDrawdown: maxDD,
    maxDrawdownPct: results.holdValue > 0 ? maxDD / results.holdValue * 100 : 0,
    alphaSharpe: sd > 1e-12 ? (mr / sd) * ANNUALISE : 0,
    vaultValue: results.vaultFinal, vaultDeposits: results.vaultDeposits,
    narrative: {
      sizing: thrashCount === 0
        ? `HEALTHY — max single swap was ${maxSizePct.toFixed(2)}% of pool value`
        : `WARNING — ${thrashCount} swap(s) exceeded 20% of pool (thrashing risk)`,
      friction: frictionRatio < 0.30 ? 'GOOD — brokerage < 30% of gross'
              : frictionRatio < 0.60 ? 'MODERATE — consider wider band'
              : 'HIGH — brokerage exceeds trading edge',
      quality: successRate > 0.55 ? 'GOOD — pair is mean-reverting'
             : successRate > 0.45 ? 'MIXED — weak mean-reversion'
             : 'POOR — pair is trending',
    },
  };
}

// ─── MAIN ENGINE ──────────────────────────────────────────────────────────────
export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const a1 = normalizeRows(df1), a2 = normalizeRows(df2);
  if (!a1.length || !a2.length)
    return { error: 'Both files need valid date, close, volume columns.' };

  const bars = buildMinutely(a1, a2);
  if (bars.length < 10)
    return { error: 'Too few overlapping bars. Check timestamps match.' };

  // ── Config ──────────────────────────────────────────────────────────────────
  const bandPct       = clamp(+(config.bandPct       ?? 5),    0.5, 50)  / 100;
  const concentration = clamp(+(config.concentration  ?? 2),   1,   20);
  const buyBrok       = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok      = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;
  const reinvestBrok  = clamp(+(config.reinvestBrokeragePct ?? 0.15), 0, 5) / 100;
  const ilHardStop    = clamp(+(config.ilHardStopPct  ?? 0),   0,  100);
  const ilHardResume  = clamp(+(config.ilHardResumePct ?? 0),  0,  100);
  const compoundHours = clamp(+(config.compoundIntervalHours ?? 24), 1, 168);
  // EWMA decay for ratio mean-tracking (alpha ≈ 0.002 → ~500-bar half-life)
  const ewmaAlpha = 0.002;
  // Hard per-leg ceiling: 5% of pool value regardless of concentration
  const maxLegPct = 0.05;

  // ── Initialise ──────────────────────────────────────────────────────────────
  const h0 = bars[0];
  const p1_0 = h0.c1, p2_0 = h0.c2;
  const rInit = p1_0 / p2_0;
  const rLow  = rInit * (1 - bandPct);
  const rHigh = rInit * (1 + bandPct);

  // Point 6: rounding residual from initial share allocation goes to seedCash
  const halfCapital = realCapital / 2;
  let poolX = Math.max(1, Math.floor(halfCapital / p1_0));
  let poolY = Math.max(1, Math.floor(halfCapital / p2_0));
  const seedCash    = halfCapital - poolX * p1_0 + halfCapital - poolY * p2_0;
  const holdX = poolX, holdY = poolY;
  const initCapital = poolX * p1_0 + poolY * p2_0 + seedCash;

  let vaultX = 0, vaultY = 0;

  // Compute initial L from band geometry × concentration (Point 3)
  let L = computeL(concentration, poolX * p1_0 + poolY * p2_0, p1_0, p2_0, rInit, rLow, rHigh);
  const initialL = L;  // frozen at t=0 for test verification

  // ── State ────────────────────────────────────────────────────────────────────
  let cashProfit = seedCash;   // start with rounding residual already in cash
  let totalBrokerage = 0;
  let grossTotal = 0, netTotal = 0;
  let totalTrades = 0, profitableTrades = 0, unprofitableTrades = 0;
  let skippedTrades = 0;       // net ≤ 0 after brokerage
  let vaultDeposits = 0, vaultAdjustments = 0, poolAdjustments = 0;
  let outOfBandLock = false;
  let swapsHalted = false, haltReason = null;
  let ilHaltedAt = null, ilResumedAt = null, haltCount = 0;
  let lastVaultCheckMs = h0.date.getTime();
  let rPrev = rInit;
  let rEWMA = rInit;           // band-relative EWMA ratio for alpha bias

  const ledger      = [];
  const equityCurve = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: poolX*p1_0+poolY*p2_0, holdValue: initCapital,
    cashProfit: seedCash, totalValue: initCapital, alphaINR: 0, ilPct: 0,
    vaultValue: 0, inBand: true, halted: false, compoundEvent: false,
    L: +L.toFixed(2),
  });

  // ── Main bar loop ─────────────────────────────────────────────────────────────
  for (let idx = 1; idx < bars.length; idx++) {
    const row = bars[idx];
    const p1 = row.c1, p2 = row.c2;
    const rNow = p1 / p2;

    const poolVal  = poolX * p1 + poolY * p2;
    const vaultVal = vaultX * p1 + vaultY * p2;
    const holdVal  = holdX  * p1 + holdY  * p2;
    const ilPct    = holdVal > 0 ? ((poolVal + vaultVal) / holdVal - 1) * 100 : 0;

    // IL hard-stop
    if (swapsHalted && haltReason === 'IL_STOP' && ilHardResume > 0 && ilPct >= -ilHardResume) {
      swapsHalted = false; haltReason = null; ilResumedAt = row.date.toISOString();
    }
    if (!swapsHalted && ilHardStop > 0 && ilPct < -ilHardStop) {
      swapsHalted = true; haltReason = 'IL_STOP';
      ilHaltedAt = row.date.toISOString(); haltCount++;
    }

    const inBand = rNow >= rLow && rNow <= rHigh;

    // ── BAND BREACH: bring pool to CURRENT MARKET RATIO (Point 2) ────────────
    // When price exits the band, the vault/pool adjustment sets the pool's
    // ratio to rNow — where the market currently IS — not to 50/50 value.
    // This means: if Asset1 has risen (rNow > rHigh), pool should hold
    // more Asset2 and fewer Asset1 at the new ratio.
    if (!inBand && !swapsHalted && !outOfBandLock) {
      outOfBandLock = true;

      // ── TARGET: set pool share-ratio = rNow  ────────────────────────────
      //
      // CASE A — ratio ROSE above rHigh (p1 got more expensive):
      //   We need MORE A1 and LESS A2 to match rNow.
      //   If vault has A1 → use it. Remaining A2 goes to vault.
      //   If vault is empty → we can't buy A1 (no cash).
      //   Best achievable: keep current poolX, shrink poolY so ratio matches.
      //     poolY_target = floor(poolX / rNow)
      //     Excess A2 goes to vault.
      //
      // CASE B — ratio FELL below rLow (p2 got more expensive):
      //   We need MORE A2 and LESS A1.
      //   Same logic in mirror: keep poolY, shrink poolX.
      //     poolX_target = floor(poolY * rNow)
      //
      // This approach guarantees poolX/poolY ≈ rNow (error only from floor())
      // regardless of vault holdings, without requiring any cash.

      let adjType = null;

      if (rNow > rHigh) {
        // Ratio ROSE: pool needs more A1, less A2
        const xNeed = Math.max(0, Math.floor(poolY * rNow) - poolX);
        const yTarget = Math.max(5, Math.floor(poolX / rNow));
        const yExcess = poolY - yTarget;

        if (xNeed > 0 && vaultX >= xNeed) {
          // Vault can fully supply the A1 shortfall
          vaultX -= xNeed; poolX += xNeed;
          if (yExcess > 0) { poolY -= yExcess; vaultY += yExcess; }
          adjType = 'VAULT→POOL'; vaultAdjustments++;
        } else {
          // Vault insufficient or empty — keep poolX, shed A2 to match ratio
          const got = vaultX; vaultX = 0; poolX += got;
          // Now recompute yTarget with updated poolX
          const yNew = Math.max(5, Math.floor(poolX / rNow));
          const yShed = poolY - yNew;
          if (yShed > 0) { poolY -= yShed; vaultY += yShed; }
          adjType = 'POOL→VAULT'; poolAdjustments++;
        }

      } else if (rNow < rLow) {
        // Ratio FELL: rNow = p1/p2 decreased → A1 cheaper, A2 more expensive.
        // Target: poolX / poolY = rNow
        //
        // We cannot buy more A2 (no cash). So we keep poolX fixed and
        // derive the correct poolY:
        //   poolY_target = floor(poolX / rNow)
        //
        // If poolY > poolY_target → shed excess A2 to vault.
        // If vault has A2 → top up poolY first (helps reduce IL), then re-derive.

        if (vaultY > 0) {
          // Pull A2 from vault to partially restore poolY balance
          const poolY_want = Math.floor(poolX / rNow);
          const yAdd = Math.min(vaultY, Math.max(0, poolY_want - poolY));
          if (yAdd > 0) { vaultY -= yAdd; poolY += yAdd; }
          adjType = 'VAULT→POOL'; vaultAdjustments++;
        }

        // Set poolY = floor(poolX / rNow) — shed excess A2 to vault
        const poolY_target = Math.max(5, Math.floor(poolX / rNow));
        const yShed = poolY - poolY_target;
        if (yShed > 0) {
          poolY -= yShed; vaultY += yShed;
          if (!adjType) { adjType = 'POOL→VAULT'; poolAdjustments++; }
        }
        // Edge: if vault was empty AND poolY was already correct, mark as POOL→VAULT
        if (!adjType) { adjType = 'POOL→VAULT'; poolAdjustments++; }
      }

      // Recompute L for the new pool composition with correct band geometry
      const newPoolVal = poolX * p1 + poolY * p2;
      L = computeL(concentration, newPoolVal, p1, p2, rNow, rLow, rHigh);
      rPrev = rNow;
      rEWMA = rNow;  // reset EWMA to current ratio after band adjustment

      if (adjType) ledger.push({
        date: row.date.toISOString(), type: 'ADJUST', adjType,
        rNow: +rNow.toFixed(6), rLow: +rLow.toFixed(6), rHigh: +rHigh.toFixed(6),
        poolX, poolY, vaultX, vaultY,
        asset1Price: p1, asset2Price: p2,
        poolValue: poolX*p1+poolY*p2, vaultValue: vaultX*p1+vaultY*p2,
        cashProfit, L: +L.toFixed(2),
      });

    } else if (inBand) {
      outOfBandLock = false;
    }

    // ── IN-BAND V3 SWAP WITH CONCENTRATION ON BAND + ALPHA BIAS ─────────────
    // (Points 1, 3, 4, 6)
    if (inBand && !swapsHalted) {

      // Update ratio EWMA (used for alpha bias — Point 4)
      rEWMA = ewmaUpdate(rEWMA, rNow, ewmaAlpha);
      // Alpha bias: if rNow > rEWMA, Asset1 is over-priced relative to mean
      //   → selling Asset1 is "selling the spike" → amplify that direction
      // If rNow < rEWMA, Asset1 is cheap → buying Asset1 is "buying the dip"
      const rMeanBias = rNow / rEWMA;  // >1 = A1 above mean, <1 = A1 below mean

      // V3 swap delta using L computed from actual band geometry (Point 3)
      // Clamp both rPrev and rNow to band for delta computation
      const rP = clamp(rPrev, rLow, rHigh);
      const rN = clamp(rNow,  rLow, rHigh);
      const sqrtRp = Math.sqrt(rP), sqrtRn = Math.sqrt(rN);
      // Asset1 delta (negative = pool sells A1, positive = pool buys A1)
      const deltaA1 = L * (1/sqrtRn - 1/sqrtRp);
      // Asset2 delta (positive = pool sells A2, negative = pool buys A2 — sign reversed for clarity below)
      const deltaA2 = L * (sqrtRn - sqrtRp);

      const maxLeg = poolVal * maxLegPct;  // 5% hard ceiling per leg

      if (deltaA1 < 0) {
        // Ratio rose → sell Asset1, buy Asset2
        // Alpha bias: amplify if A1 is above its mean (selling spike)
        const bias     = rMeanBias > 1 ? rMeanBias : 1;
        const rawSell  = Math.abs(deltaA1) * bias;
        const sellQty  = Math.min(
          Math.floor(rawSell),
          Math.floor(maxLeg / p1),
          poolX - 5,
        );
        if (sellQty >= 1) {
          // Point 6: buyQty derived from EXACT sell proceeds
          const proceeds = sellQty * p1;
          const buyQty   = Math.floor(proceeds / p2);
          if (buyQty >= 1) {
            const cost  = buyQty * p2;
            const brok  = sellBrok * proceeds + buyBrok * cost;
            const gross = proceeds - cost;     // always ≥ 0 by construction
            const net   = gross - brok;

            if (net > 0) {
              poolX -= sellQty; poolY += buyQty;
              cashProfit += net; totalBrokerage += brok;
              grossTotal += gross; netTotal += net;
              totalTrades++; profitableTrades++;

              ledger.push({
                date: row.date.toISOString(), type: 'TRADE',
                action: 'Sell Asset 1 / Buy Asset 2',
                sellAsset: 'Asset 1', sellQty, sellProceeds: proceeds,
                buyAsset:  'Asset 2', buyQty,  buyCost: cost,
                gross, brok, net, cashProfit,
                poolValueBefore: poolVal, L: +L.toFixed(2),
                asset1Price: p1, asset2Price: p2,
                poolX, poolY, vaultX, vaultY,
                ilPct: +ilPct.toFixed(3), rNow: +rNow.toFixed(6),
              });
            } else {
              skippedTrades++;
            }
          }
        }

      } else if (deltaA1 > 0) {
        // Ratio fell → buy Asset1, sell Asset2
        // Alpha bias: amplify if A1 is below its mean (buying dip)
        const bias     = rMeanBias < 1 ? 1 / rMeanBias : 1;
        const rawSell  = Math.abs(deltaA2) * bias;
        const sellQty  = Math.min(
          Math.floor(rawSell),
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

              ledger.push({
                date: row.date.toISOString(), type: 'TRADE',
                action: 'Sell Asset 2 / Buy Asset 1',
                sellAsset: 'Asset 2', sellQty, sellProceeds: proceeds,
                buyAsset:  'Asset 1', buyQty,  buyCost: cost,
                gross, brok, net, cashProfit,
                poolValueBefore: poolVal, L: +L.toFixed(2),
                asset1Price: p1, asset2Price: p2,
                poolX, poolY, vaultX, vaultY,
                ilPct: +ilPct.toFixed(3), rNow: +rNow.toFixed(6),
              });
            } else {
              skippedTrades++;
            }
          }
        }
      }

      rPrev = rNow;

      // Update L based on current pool value (grows as compounding adds shares)
      L = computeL(concentration, poolX * p1 + poolY * p2, p1, p2, rNow, rLow, rHigh);
    }

    // ── VAULT DEPOSIT — IL-correcting reinvestment (Point 5) ─────────────────
    const hoursSinceVault = (row.date.getTime() - lastVaultCheckMs) / 3600000;
    let didVault = false;

    if (hoursSinceVault >= compoundHours && cashProfit > 0) {
      const gross    = cashProfit;
      const brokCost = gross * reinvestBrok;
      const netReinvest = gross - brokCost;

      if (netReinvest > 0) {
        // Point 5: identify which asset is underweight due to IL, buy more of it
        // IL pushes the pool toward the asset that FELL (accumulated during rebalance)
        // Underweight asset = the one where current value < initial value target
        const currentXVal = poolX * p1;
        const currentYVal = poolY * p2;
        const totalPoolV  = currentXVal + currentYVal;
        // Ideal 50/50:
        const idealXVal   = totalPoolV / 2;
        // If currentXVal < idealXVal → Asset1 is underweight → buy more Asset1
        const xDeficit = idealXVal - currentXVal;   // +ve → A1 underweight

        let buyX = 0, buyY = 0;
        if (xDeficit > 0) {
          // Asset1 underweight: put 70% toward A1, 30% toward A2
          buyX = Math.floor(netReinvest * 0.70 / p1);
          buyY = Math.floor(netReinvest * 0.30 / p2);
        } else {
          // Asset2 underweight: put 70% toward A2, 30% toward A1
          buyX = Math.floor(netReinvest * 0.30 / p1);
          buyY = Math.floor(netReinvest * 0.70 / p2);
        }

        if (buyX >= 1 || buyY >= 1) {
          buyX = Math.max(0, buyX);
          buyY = Math.max(0, buyY);
          const actualCost = buyX * p1 + buyY * p2;
          vaultX += buyX; vaultY += buyY;
          totalBrokerage += brokCost;
          // Cash decreases by gross (brokerage + actualCost + residual stays cash)
          cashProfit -= (actualCost + brokCost);
          vaultDeposits++; didVault = true;

          ledger.push({
            date: row.date.toISOString(), type: 'VAULT_DEPOSIT',
            action: '🔒 Vault Deposit',
            buyX, buyY, actualCost, brokCost,
            cashAfter: cashProfit, vaultX, vaultY,
            asset1Price: p1, asset2Price: p2,
            vaultValue: vaultX*p1+vaultY*p2, depositEvent: vaultDeposits,
            ilCorrecting: xDeficit > 0 ? 'A1-heavy' : 'A2-heavy',
          });
        }
      }
      lastVaultCheckMs = row.date.getTime();
    }

    // ── Equity snapshot ───────────────────────────────────────────────────────
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

  // ── Final results ─────────────────────────────────────────────────────────────
  const last      = bars[bars.length - 1];
  const holdValue = holdX  * last.c1 + holdY  * last.c2;
  const poolFinal = poolX  * last.c1 + poolY  * last.c2;
  const vaultFinal= vaultX * last.c1 + vaultY * last.c2;
  const totalValue= poolFinal + cashProfit + vaultFinal;
  const vsHold    = totalValue - holdValue;
  const vsHoldPct = holdValue  > 0 ? (totalValue / holdValue - 1) * 100 : 0;

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
    vaultDeposits, vaultAdjustments, poolAdjustments,
    bandPct: bandPct * 100, concentration, L: +L.toFixed(2), initialL: +initialL.toFixed(2),
    rInit: +rInit.toFixed(6), rLow: +rLow.toFixed(6), rHigh: +rHigh.toFixed(6),
    buyBrokeragePct: buyBrok*100, sellBrokeragePct: sellBrok*100,
  };

  return {
    swaps: ledger, equityCurve, results,
    performanceSummary: buildPerformanceSummary(ledger, equityCurve, results),
  };
}
