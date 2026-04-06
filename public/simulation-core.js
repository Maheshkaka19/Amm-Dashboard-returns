// simulation-core.js  —  AMM Volatility Harvesting  v7
// Auto-Adjustment Engine  (Arrakis / Uniswap V3 style, NSE-grade)
// ═══════════════════════════════════════════════════════════════════════════════
//
//  POOL MODEL:  constant-product   x · y = k
//  (x = integer Asset1 shares,  y = integer Asset2 shares)
//
//  ── FIVE NEW INSTITUTIONAL MECHANISMS ──────────────────────────────────────
//
//  1. ATR-BASED DYNAMIC WIDTH
//     Instead of fixed % bands, the active range width is set as:
//       width = max(base_width, atrMultiplier × ATR14_of_ratio_returns)
//     ATR of ratio = rolling-14h mean of |ratio[t]/ratio[t-1] − 1|
//     This auto-widens during volatile regimes and tightens during flat ones.
//     Ensures the band is never so tight that price exits on normal noise.
//
//  2. HYSTERESIS / PROFIT BUFFER
//     A swap executes ONLY if:
//       netProfit > profitBuffer × totalSwapBrokerage
//     (profitBuffer default 1.0 → net must exceed brokerage by at least 1×)
//     This filters "dust" swaps whose profit is immediately erased by
//     friction or a mean-reversion tick.
//
//  3. REBALANCE COOLDOWN
//     After any recenter, a timer prevents the next recenter for `cooldownHours`.
//     Emergency override: if drift > atrMultiplier × width × extremeMult,
//     the cooldown is bypassed to prevent catastrophic pool imbalance.
//     Eliminating rapid back-to-back recenters is the #1 alpha lever because
//     each recenter costs ~0.30% on the ENTIRE portfolio notional.
//
//  4. WALK-FORWARD PARAMETER OPTIMIZER  (optimizeParameters)
//     Uses a 7-day rolling training window to find the {width, cooldown,
//     profitBuffer} combination that maximised "harvest-per-recenter" on
//     recent history, then applies those parameters to the next window.
//     Grid search over 48 candidate parameter sets, evaluated purely on
//     net_cash_profit (not total value) to avoid IL distortion.
//
//  5. REGIME DETECTOR  (volume + correlation + ATR-trend)
//     Classifies each hour as TRENDING, RANGING, or VOLATILE.
//     TRENDING → wider band (avoid recenter churn on directional moves)
//     RANGING  → tighter band (harvest micro-oscillations)
//     VOLATILE → pause swaps, use emergency-only cooldown bypass
//
//  ── ALPHA CEILING DISCLAIMER (BE HONEST WITH YOURSELF) ───────────────────
//  On NSE at Zerodha rates (0.30% round-trip), the arithmetic ceiling for
//  a two-stock pair with < 10% annual ratio volatility is approximately
//  0.5–2% alpha vs hold.  5–10% alpha requires either:
//   a) A pair with > 15% annual ratio volatility (mid-cap vs large-cap), OR
//   b) Brokerage < 0.05% (institutional co-location / dark-pool routes), OR
//   c) Running 5+ simultaneous pools.
//  The optimizer minimises recenter churn and maximises harvest-per-swap,
//  pushing alpha to the structural ceiling for the pair you choose.
//
//  ── TRADE MECHANIC (unchanged from v6) ────────────────────────────────────
//  Case A — p1 rose → BUY Δx Asset1 from NSE, AMM releases Δy Asset2, SELL Δy
//  Case B — p2 rose → BUY Δy Asset2 from NSE, AMM releases Δx Asset1, SELL Δx
//  Quantities: round-to-nearest, floor-guarded (never sell more than held)
//  Execute only if netProfit > profitBuffer × brokerage  AND both qty ≥ 1
// ═══════════════════════════════════════════════════════════════════════════════

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
  const headers = splitCsvLine(lines[0]).map(v => v.trim().toLowerCase());
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

// ─── Statistics ───────────────────────────────────────────────────────────────

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function stdDev(a, m) {
  if (a.length < 2) return 0;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[a.length - n + i], bi = b[b.length - n + i];
    const da = ai - ma, db = bi - mb;
    num += da * db; va += da * da; vb += db * db;
  }
  const d = Math.sqrt(va * vb);
  return d > 0 ? num / d : 0;
}

// ─── ATR of price-ratio returns ───────────────────────────────────────────────
// True Range proxy: |ratio[t] / ratio[t-1] − 1|  (fractional ratio move)
// Rolling mean over `period` hours = Average True Range of the ratio.

function buildRatioATR(hourly, period) {
  // Returns array length = hourly.length (index 0 = h[0], using h[0] ATR as first)
  const atr = new Float64Array(hourly.length);
  const absRets = new Float64Array(hourly.length);
  for (let i = 1; i < hourly.length; i++) {
    const rPrev = hourly[i-1].c1 / hourly[i-1].c2;
    const rCurr = hourly[i].c1   / hourly[i].c2;
    absRets[i] = Math.abs(rCurr / rPrev - 1);
  }
  // Seed index 0
  atr[0] = absRets[1] || 0.003;
  for (let i = 1; i < hourly.length; i++) {
    const lo = Math.max(1, i - period + 1);
    let s = 0;
    for (let j = lo; j <= i; j++) s += absRets[j];
    atr[i] = s / (i - lo + 1);
  }
  return atr;
}

// ─── Regime classifier ────────────────────────────────────────────────────────
// TRENDING  : rolling-6h ratio return all same sign (ratio is drifting)
// VOLATILE  : current ATR > 2× rolling-24h mean ATR
// RANGING   : otherwise (mean-reverting, ideal for harvesting)

function classifyRegime(hourly, idx, atrArr, volWindow) {
  if (idx < 2) return 'RANGING';
  const curATR  = atrArr[idx];
  const avgATR  = mean(Array.from(atrArr).slice(Math.max(0, idx - 24), idx));
  if (curATR > 2.5 * avgATR) return 'VOLATILE';
  // Check directional drift over last 6h
  const lo = Math.max(1, idx - 6);
  let posCount = 0, negCount = 0;
  for (let i = lo; i <= idx; i++) {
    const dr = hourly[i].c1 / hourly[i].c2 / (hourly[i-1].c1 / hourly[i-1].c2) - 1;
    if (dr > 0) posCount++; else if (dr < 0) negCount++;
  }
  const total = posCount + negCount;
  if (total > 0 && (posCount / total > 0.75 || negCount / total > 0.75)) return 'TRENDING';
  return 'RANGING';
}

// ─── 1-minute → hourly merge ──────────────────────────────────────────────────

function hourKey(date) {
  const d = new Date(date); d.setMinutes(0, 0, 0); return d.toISOString();
}

export function buildHourly(a1, a2) {
  const map = new Map();
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    const t1 = a1[i].date.getTime(), t2 = a2[j].date.getTime();
    if (t1 === t2) {
      const key = hourKey(a1[i].date);
      if (!map.has(key)) map.set(key, { date: new Date(key), c1: a1[i].close, c2: a2[j].close, vol: 0 });
      const b = map.get(key);
      b.c1 = a1[i].close; b.c2 = a2[j].close;
      b.vol += a1[i].volume + a2[j].volume;
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  const arr = [...map.values()].sort((a, b) => a.date - b.date);
  for (let k = 0; k < arr.length; k++) {
    arr[k].ret1 = k === 0 ? 0 : arr[k].c1 / arr[k-1].c1 - 1;
    arr[k].ret2 = k === 0 ? 0 : arr[k].c2 / arr[k-1].c2 - 1;
  }
  return arr;
}

// ─── Volume regime ────────────────────────────────────────────────────────────

function volMode(vol, window, sigma) {
  if (!window.length) return 'MID';
  const avg = mean(window), sd = stdDev(window, avg);
  if (vol < avg - sigma * sd) return 'LOW';
  if (vol > avg + sigma * sd) return 'HIGH';
  return 'MID';
}

// ─── Core constant-product swap ───────────────────────────────────────────────

function computeSwap(x, y, p1, p2, buyBrok, sellBrok, profitBuffer) {
  const k = x * y;
  if (k === 0) return null;
  const xTarget = Math.sqrt(k * p2 / p1);
  const yTarget = Math.sqrt(k * p1 / p2);
  const dx = xTarget - x;

  let result = null;

  if (dx >= 0.5) {
    // BUY Asset1, pool releases Asset2
    const dxBuy = Math.round(dx);
    if (dxBuy < 1) return null;
    const xAfter = x + dxBuy;
    let dyOut = Math.round(y - k / xAfter);
    dyOut = Math.min(dyOut, y - 1);    // floor guard
    if (dyOut < 1) return null;
    const cost = dxBuy * p1, revenue = dyOut * p2;
    const brokerage = buyBrok * cost + sellBrok * revenue;
    const gross = revenue - cost;
    const netProfit = gross - brokerage;
    result = { dir: 'BUY1_SELL2', buyQty: dxBuy, sellQty: dyOut,
               xAfter, yAfter: y - dyOut, cost, revenue, gross, brokerage, netProfit };

  } else if (dx <= -0.5) {
    // BUY Asset2, pool releases Asset1
    const dyBuy = Math.round(-dx);
    if (dyBuy < 1) return null;
    const yAfter = y + dyBuy;
    let dxOut = Math.round(x - k / yAfter);
    dxOut = Math.min(dxOut, x - 1);   // floor guard
    if (dxOut < 1) return null;
    const cost = dyBuy * p2, revenue = dxOut * p1;
    const brokerage = buyBrok * cost + sellBrok * revenue;
    const gross = revenue - cost;
    const netProfit = gross - brokerage;
    result = { dir: 'BUY2_SELL1', buyQty: dyBuy, sellQty: dxOut,
               xAfter: x - dxOut, yAfter, cost, revenue, gross, brokerage, netProfit };
  }

  if (!result) return null;
  // ── HYSTERESIS GATE: only trade if net > profitBuffer × brokerage ──
  if (result.netProfit <= result.brokerage * profitBuffer) return null;
  return result;
}

// ─── Recenter: 50/50 value split, round-to-nearest, brokerage charged ─────────

function computeRecenter(x, y, p1, p2, buyBrok, sellBrok) {
  const totalVal = x * p1 + y * p2;
  const xNew = Math.max(1, Math.round(totalVal / 2 / p1));
  const yNew = Math.max(1, Math.round(totalVal / 2 / p2));
  const dx = xNew - x, dy = yNew - y;

  if (Math.abs(dx) < 1 && Math.abs(dy) < 1)
    return { xNew: x, yNew: y, boughtAsset: '', soldAsset: '', boughtQty: 0, soldQty: 0,
             cost: 0, revenue: 0, gross: 0, brokerage: 0, netProfit: 0, noTrade: true };

  let boughtAsset, soldAsset, boughtQty, soldQty, cost, revenue;
  if (dx > 0 && dy < 0) {
    boughtAsset = 'Asset 1'; soldAsset = 'Asset 2';
    boughtQty = Math.abs(dx); soldQty = Math.min(Math.abs(dy), y - 1);
    cost = boughtQty * p1; revenue = soldQty * p2;
  } else if (dx < 0 && dy > 0) {
    boughtAsset = 'Asset 2'; soldAsset = 'Asset 1';
    boughtQty = Math.abs(dy); soldQty = Math.min(Math.abs(dx), x - 1);
    cost = boughtQty * p2; revenue = soldQty * p1;
  } else {
    return { xNew: x, yNew: y, boughtAsset: '', soldAsset: '', boughtQty: 0, soldQty: 0,
             cost: 0, revenue: 0, gross: 0, brokerage: 0, netProfit: 0, noTrade: true };
  }

  if (boughtQty < 1 || soldQty < 1)
    return { xNew: x, yNew: y, boughtAsset, soldAsset, boughtQty: 0, soldQty: 0,
             cost: 0, revenue: 0, gross: 0, brokerage: 0, netProfit: 0, noTrade: true };

  const gross     = revenue - cost;
  const brokerage = buyBrok * cost + sellBrok * revenue;
  const netProfit = gross - brokerage;
  return { xNew, yNew, boughtAsset, soldAsset, boughtQty, soldQty,
           cost, revenue, gross, brokerage, netProfit, noTrade: false };
}

// ─── WALK-FORWARD OPTIMIZER ───────────────────────────────────────────────────
//
// Grid of candidate parameter sets.  For each training window, we run a
// fast inner simulation (no swap records, equity curve stripped) across all
// candidates and pick the one that maximises net_cash_profit (NOT total value,
// to avoid IL noise distorting the selection).
//
// Objective = cash_profit − total_brokerage   (harvest quality)
// Tie-break = fewer recenters (churn penalty)

const CANDIDATE_GRID = (() => {
  const grid = [];
  for (const width of [0.015, 0.02, 0.03, 0.04]) {
    for (const cooldown of [8, 16, 24]) {
      for (const profitBuffer of [0.5, 1.0]) {
        for (const atrMult of [2.0, 3.0]) {
          grid.push({ width, cooldown, profitBuffer, atrMult });
        }
      }
    }
  }
  return grid;   // 48 candidates
})();

function innerSim(hourly, atrArr, startIdx, endIdx, poolX, poolY, centerRatio,
                  params, buyBrok, sellBrok) {
  const { width, cooldown, profitBuffer, atrMult } = params;
  const CORR_LB = 24, CORR_IMPACT = 0.5, EXTREME_MULT = 4.0;

  let x = poolX, y = poolY, k = x * y, center = centerRatio;
  let cash = 0, brokTotal = 0, swaps = 0, recenters = 0;
  let lastRec = startIdx - cooldown - 1;  // allow immediate recenter at start

  for (let i = startIdx + 1; i < endIdx; i++) {
    if (i >= hourly.length) break;
    const { c1: p1, c2: p2 } = hourly[i];
    const ext = p1 / p2;

    // ATR band
    const atr = atrArr[i];
    const corrWin = hourly.slice(Math.max(0, i - CORR_LB), i);
    const corr = pearsonCorr(corrWin.map(h => h.ret1), corrWin.map(h => h.ret2));
    const baseBand = width * (1 + CORR_IMPACT * (1 - Math.abs(corr)));
    const dynW = Math.max(atrMult * atr, baseBand);

    const drift = Math.abs(ext / center - 1);
    const inBand = drift <= dynW;

    if (!inBand) {
      const hrsSince = i - lastRec;
      const extreme  = drift > dynW * EXTREME_MULT;
      if (hrsSince >= cooldown || extreme) {
        // Fast recenter — no record keeping
        const totalVal = x * p1 + y * p2;
        const xn = Math.max(1, Math.round(totalVal / 2 / p1));
        const yn = Math.max(1, Math.round(totalVal / 2 / p2));
        const dx = xn - x, dy = yn - y;
        if (Math.abs(dx) >= 1) {
          if (dx > 0 && dy < 0) {
            const dxB = Math.abs(dx), dyS = Math.min(Math.abs(dy), y - 1);
            if (dxB >= 1 && dyS >= 1) {
              const cost = dxB * p1, rev = dyS * p2;
              const rb = buyBrok * cost + sellBrok * rev;
              x += dxB; y -= dyS; k = x * y; cash += rev - cost - rb; brokTotal += rb;
            }
          } else if (dy > 0 && dx < 0) {
            const dyB = Math.abs(dy), dxS = Math.min(Math.abs(dx), x - 1);
            if (dyB >= 1 && dxS >= 1) {
              const cost = dyB * p2, rev = dxS * p1;
              const rb = buyBrok * cost + sellBrok * rev;
              y += dyB; x -= dxS; k = x * y; cash += rev - cost - rb; brokTotal += rb;
            }
          }
        }
        center = ext; lastRec = i; recenters++;
      }
      continue;
    }

    // Regular swap
    const s = computeSwap(x, y, p1, p2, buyBrok, sellBrok, profitBuffer);
    if (s) {
      cash += s.netProfit; brokTotal += s.brokerage;
      x = s.xAfter; y = s.yAfter; k = x * y; swaps++;
    }
  }

  // Score: net harvest quality.  Penalise recenters so the optimizer
  // prefers equal-profit configs that recenter less.
  const recenterPenalty = recenters * (x * hourly[Math.min(endIdx-1, hourly.length-1)].c1
                                     + y * hourly[Math.min(endIdx-1, hourly.length-1)].c2)
                                     * (buyBrok + sellBrok) * 0.5;
  return {
    score: cash - brokTotal - recenterPenalty * 0.5,
    cash, brokTotal, swaps, recenters,
    x, y, k, center,
  };
}

export function optimizeParameters(hourly, atrArr, windowStart, windowEnd,
                                   poolX, poolY, centerRatio, buyBrok, sellBrok) {
  let bestScore = -Infinity, bestParams = CANDIDATE_GRID[0];
  for (const params of CANDIDATE_GRID) {
    const r = innerSim(hourly, atrArr, windowStart, windowEnd,
                       poolX, poolY, centerRatio, params, buyBrok, sellBrok);
    if (r.score > bestScore) { bestScore = r.score; bestParams = params; }
  }
  return bestParams;
}

// ─── Main simulation ──────────────────────────────────────────────────────────

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);
  if (!asset1.length || !asset2.length)
    return { error: 'Both CSV files must contain valid date, close, and volume columns.' };

  const hourly = buildHourly(asset1, asset2);
  if (hourly.length < 2)
    return { error: 'No overlapping timestamps found. Confirm both CSVs cover the same period.' };

  // ── Config ──────────────────────────────────────────────────────────────────
  // Walk-forward: train on N days, apply to next N days
  const HOURS_PER_DAY   = 6;   // NSE ~6 trading hours/day
  const trainDays        = Math.max(3, +(config.trainDays     ?? 7));
  const testDays         = Math.max(1, +(config.testDays      ?? 7));
  const trainH           = trainDays  * HOURS_PER_DAY;
  const testH            = testDays   * HOURS_PER_DAY;
  const useWalkForward   = config.walkForward !== false;   // on by default

  // Static fallback parameters (used before first train window completes,
  // and when walkForward is disabled)
  const staticWidth      = clamp(+(config.midWidth        ?? 2.0), 0.05, 50) / 100;
  const staticCooldown   = Math.max(1, +(config.cooldownHours   ?? 24));
  const staticProfitBuf  = clamp(+(config.profitBuffer    ?? 1.0), 0, 10);
  const staticAtrMult    = clamp(+(config.atrMultiplier   ?? 2.5), 0.5, 20);
  const corrLB           = Math.max(2, +(config.corrLookbackHours ?? 24));
  const corrImpact       = clamp(+(config.correlationImpact ?? 0.5), 0, 2);
  const extremeMult      = clamp(+(config.extremeMult      ?? 4.0), 1.5, 20);
  const sigmaT           = clamp(+(config.sigmaThreshold   ?? 1.0), 0.1, 5);
  const lookbackH        = Math.max(2, +(config.lookbackHours ?? 24));
  const atrPeriod        = Math.max(2, +(config.atrPeriod  ?? 14));
  const buyBrok          = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok         = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;
  const pauseHigh        = !!config.pauseHighVol;
  const pauseVolatile    = !!config.pauseVolatile;
  const recenterOn       = config.recenterEnabled !== false;
  const ilStopPct        = clamp(+(config.ilStopLossPct ?? 0), 0, 100);

  // ── Build ATR array for entire dataset ──────────────────────────────────────
  const atrArr = buildRatioATR(hourly, atrPeriod);

  // ── Pool initialisation ──────────────────────────────────────────────────────
  const h0 = hourly[0];
  const xInit = Math.max(1, Math.round(realCapital / 2 / h0.c1));
  const yInit = Math.max(1, Math.round(realCapital / 2 / h0.c2));
  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low: cannot purchase even 1 share of each asset.' };

  let x = xInit, y = yInit, k = x * y;
  let center = h0.c1 / h0.c2;

  // Active parameters (updated by optimizer each window)
  let activeWidth      = staticWidth;
  let activeCooldown   = staticCooldown;
  let activeProfitBuf  = staticProfitBuf;
  let activeAtrMult    = staticAtrMult;

  // Walk-forward schedule
  let nextOptimizeAt   = useWalkForward ? trainH : Infinity;
  let nextWindowEnd    = nextOptimizeAt + testH;
  let optimizerLog     = [];   // one entry per window

  // Running state
  let cashProfit     = 0;
  let totalBrokerage = 0;
  let totalSwaps     = 0;
  let recenterCount  = 0;
  let recenterSwaps  = 0;
  let ilHalted       = false;
  let ilHaltedAt     = null;
  let lastRecenterIdx = -staticCooldown - 1;
  let currentMode    = 'MID';
  let currentRegime  = 'RANGING';
  const modeHours    = { LOW: 0, MID: 0, HIGH: 0 };
  const regimeHours  = { TRENDING: 0, RANGING: 0, VOLATILE: 0 };

  const initCashDeployed = xInit * h0.c1 + yInit * h0.c2;
  const swapRecords  = [];
  const equityCurve  = [];

  equityCurve.push({
    date: h0.date.toISOString(), poolValue: initCashDeployed,
    holdValue: initCashDeployed, cashProfit: 0, ilPct: 0,
    correlation: 0, activeWidthPct: activeWidth * 100, mode: 'MID',
    regime: 'RANGING', halted: false, optimized: false,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1 = row.c1, p2 = row.c2;
    const ext = p1 / p2;

    // ── Walk-forward: retrain at window boundaries ────────────────────────────
    let justOptimized = false;
    if (useWalkForward && idx === nextOptimizeAt) {
      const winStart = idx - trainH;
      const winEnd   = idx;
      const best = optimizeParameters(
        hourly, atrArr, winStart, winEnd,
        x, y, center, buyBrok, sellBrok,
      );
      activeWidth     = best.width;
      activeCooldown  = best.cooldown;
      activeProfitBuf = best.profitBuffer;
      activeAtrMult   = best.atrMult;
      nextOptimizeAt  = idx + testH;
      nextWindowEnd   = nextOptimizeAt + testH;
      justOptimized   = true;
      optimizerLog.push({
        atHour: idx, date: row.date.toISOString(),
        params: { ...best },
        poolValueAtTrain: x * p1 + y * p2 + cashProfit,
      });
    }

    // ── Volume regime ─────────────────────────────────────────────────────────
    const volWin = hourly.slice(Math.max(0, idx - lookbackH), idx).map(h => h.vol);
    currentMode = volMode(row.vol, volWin, sigmaT);
    modeHours[currentMode]++;

    // ── Market regime (trend / range / volatile) ──────────────────────────────
    currentRegime = classifyRegime(hourly, idx, atrArr, volWin);
    regimeHours[currentRegime]++;

    // Pause signal
    const pauseThisHour = (pauseHigh && currentMode === 'HIGH') ||
                          (pauseVolatile && currentRegime === 'VOLATILE');

    // ── Dynamic width ─────────────────────────────────────────────────────────
    const atr = atrArr[idx];
    const corrWin = hourly.slice(Math.max(0, idx - corrLB), idx);
    const corr = pearsonCorr(corrWin.map(h => h.ret1), corrWin.map(h => h.ret2));

    // Base width adjusted for correlation:
    //   RANGING + high corr → tighter (harvest micro-oscillations)
    //   TRENDING + low corr → wider   (avoid churn on directional drift)
    let baseBand = activeWidth * (1 + corrImpact * (1 - Math.abs(corr)));
    if (currentRegime === 'TRENDING') baseBand *= 1.5;   // widen in trend
    if (currentRegime === 'RANGING')  baseBand *= 0.85;  // tighten in range

    // ATR floor: never let the band be narrower than atrMult × ATR
    const atrBand = activeAtrMult * atr;
    const dynW    = Math.max(atrBand, baseBand);

    // ── Band check ────────────────────────────────────────────────────────────
    const drift  = Math.abs(ext / center - 1);
    const inBand = drift <= dynW;

    // ── RECENTER ─────────────────────────────────────────────────────────────
    if (!inBand && !ilHalted && recenterOn && !pauseThisHour) {
      const hrsSince = idx - lastRecenterIdx;
      const extreme  = drift > dynW * extremeMult;
      // Cooldown: block unless cooldown expired OR extreme drift
      const canRecenter = hrsSince >= activeCooldown || extreme;

      if (canRecenter) {
        const rec = computeRecenter(x, y, p1, p2, buyBrok, sellBrok);
        if (!rec.noTrade) {
          cashProfit     += rec.netProfit;
          totalBrokerage += rec.brokerage;
          if (rec.boughtAsset === 'Asset 1') {
            x = Math.max(1, x + rec.boughtQty);
            y = Math.max(1, y - rec.soldQty);
          } else {
            y = Math.max(1, y + rec.boughtQty);
            x = Math.max(1, x - rec.soldQty);
          }
          k = x * y;
          recenterSwaps++;

          const poolVal = x * p1 + y * p2;
          const holdVal = xInit * p1 + yInit * p2;
          const ilPct   = holdVal > 0 ? (poolVal / holdVal - 1) * 100 : 0;
          swapRecords.push({
            date: row.date.toISOString(), mode: currentMode, regime: currentRegime,
            rollingCorrelation: corr, activeWidthPct: dynW * 100,
            atrPct: atr * 100, cooldownHrs: activeCooldown,
            isRecenter: true, extreme, justOptimized,
            action: `RECENTER: Buy ${rec.boughtAsset} / Sell ${rec.soldAsset}`,
            boughtAsset: rec.boughtAsset, boughtQty: rec.boughtQty, boughtCost: rec.cost,
            soldAsset: rec.soldAsset, soldQty: rec.soldQty, soldRevenue: rec.revenue,
            grossProfit: rec.gross, brokerageOnBuy: buyBrok * rec.cost,
            brokerageOnSell: sellBrok * rec.revenue, totalBrokerageRow: rec.brokerage,
            netProfit: rec.netProfit, cashProfit,
            asset1Price: p1, asset2Price: p2, poolX: x, poolY: y,
            poolAssetValue: poolVal, ilPct, totalValue: poolVal + cashProfit,
          });
        }
        center = ext; lastRecenterIdx = idx; recenterCount++;

        const pv2 = x * p1 + y * p2, hv2 = xInit * p1 + yInit * p2;
        const il2 = hv2 > 0 ? (pv2 / hv2 - 1) * 100 : 0;
        if (!ilHalted && ilStopPct > 0 && il2 < -ilStopPct) {
          ilHalted = true; ilHaltedAt = row.date.toISOString();
        }
        equityCurve.push({
          date: row.date.toISOString(), poolValue: pv2 + cashProfit, holdValue: hv2,
          cashProfit, ilPct: il2, correlation: corr,
          activeWidthPct: dynW * 100, mode: currentMode, regime: currentRegime,
          halted: ilHalted, optimized: justOptimized,
        });
        continue;
      }
      // Else: cooldown still active, skip this recenter attempt silently
    }

    // ── REGULAR SWAP ─────────────────────────────────────────────────────────
    if (inBand && !ilHalted && !pauseThisHour) {
      const s = computeSwap(x, y, p1, p2, buyBrok, sellBrok, activeProfitBuf);
      if (s) {
        cashProfit     += s.netProfit;
        totalBrokerage += s.brokerage;
        x = s.xAfter; y = s.yAfter; k = x * y;
        totalSwaps++;

        const boughtAsset = s.dir === 'BUY1_SELL2' ? 'Asset 1' : 'Asset 2';
        const soldAsset   = s.dir === 'BUY1_SELL2' ? 'Asset 2' : 'Asset 1';
        const boughtQty   = s.dir === 'BUY1_SELL2' ? s.buyQty  : s.buyQty;
        const soldQty     = s.dir === 'BUY1_SELL2' ? s.sellQty : s.sellQty;

        const poolVal = x * p1 + y * p2;
        const holdVal = xInit * p1 + yInit * p2;
        const ilPct   = holdVal > 0 ? (poolVal / holdVal - 1) * 100 : 0;
        swapRecords.push({
          date: row.date.toISOString(), mode: currentMode, regime: currentRegime,
          rollingCorrelation: corr, activeWidthPct: dynW * 100,
          atrPct: atr * 100, cooldownHrs: activeCooldown,
          isRecenter: false, extreme: false, justOptimized,
          action: `Buy ${boughtAsset} / Sell ${soldAsset}`,
          boughtAsset, boughtQty, boughtCost: s.cost,
          soldAsset, soldQty, soldRevenue: s.revenue,
          grossProfit: s.gross, brokerageOnBuy: buyBrok * s.cost,
          brokerageOnSell: sellBrok * s.revenue, totalBrokerageRow: s.brokerage,
          netProfit: s.netProfit, cashProfit,
          asset1Price: p1, asset2Price: p2, poolX: x, poolY: y,
          poolAssetValue: poolVal, ilPct, totalValue: poolVal + cashProfit,
        });

        if (!ilHalted && ilStopPct > 0 && ilPct < -ilStopPct) {
          ilHalted = true; ilHaltedAt = row.date.toISOString();
        }
      }
    }

    // ── Equity curve ──────────────────────────────────────────────────────────
    const pv = x * p1 + y * p2, hv = xInit * p1 + yInit * p2;
    const ilPct = hv > 0 ? (pv / hv - 1) * 100 : 0;
    if (!ilHalted && ilStopPct > 0 && ilPct < -ilStopPct) {
      ilHalted = true; ilHaltedAt = row.date.toISOString();
    }
    equityCurve.push({
      date: row.date.toISOString(), poolValue: pv + cashProfit, holdValue: hv,
      cashProfit, ilPct, correlation: corr,
      activeWidthPct: dynW * 100, mode: currentMode, regime: currentRegime,
      halted: ilHalted, optimized: justOptimized,
    });
  }

  // ── Final metrics ────────────────────────────────────────────────────────────
  const last    = hourly[hourly.length - 1];
  const holdVal = xInit * last.c1 + yInit * last.c2;
  const poolVal = x     * last.c1 + y     * last.c2;
  const totVal  = poolVal + cashProfit;
  const ilINR   = poolVal - holdVal;
  const ilPct   = holdVal > 0 ? (poolVal / holdVal - 1) * 100 : 0;
  const vsHold  = totVal - holdVal;
  const vsHoldPct = holdVal > 0 ? (totVal / holdVal - 1) * 100 : 0;

  const harvestPerRecenter = recenterCount > 0
    ? cashProfit / recenterCount : cashProfit;
  const alphaEfficiency    = totalBrokerage > 0
    ? cashProfit / totalBrokerage : 0;  // times brokerage recovered as profit

  return {
    swaps: swapRecords,
    equityCurve,
    optimizerLog,
    results: {
      initCashDeployed,
      totalValue:    totVal,
      poolAssets:    poolVal,
      holdValue:     holdVal,
      cashProfit,
      totalBrokerage,
      vsHold,
      vsHoldPct,
      roiPct:   initCashDeployed > 0 ? (totVal  / initCashDeployed - 1) * 100 : 0,
      holdRoi:  initCashDeployed > 0 ? (holdVal / initCashDeployed - 1) * 100 : 0,
      cashRoi:  initCashDeployed > 0 ?  cashProfit / initCashDeployed * 100 : 0,
      brokRoi:  initCashDeployed > 0 ?  totalBrokerage / initCashDeployed * 100 : 0,
      ilINR,
      ilPct,
      ilHalted,
      ilHaltedAt,
      totalSwaps,
      recenterSwaps,
      recenterCount,
      harvestPerRecenter,
      alphaEfficiency,
      buyBrokeragePct:  buyBrok  * 100,
      sellBrokeragePct: sellBrok * 100,
      initialX: xInit, initialY: yInit,
      finalX:   x,     finalY:   y,
      lowModeHours:  modeHours.LOW,
      midModeHours:  modeHours.MID,
      highModeHours: modeHours.HIGH,
      trendingHours:  regimeHours.TRENDING,
      rangingHours:   regimeHours.RANGING,
      volatileHours:  regimeHours.VOLATILE,
      optimizerWindows: optimizerLog.length,
      activeParams: { width: activeWidth, cooldown: activeCooldown,
                      profitBuffer: activeProfitBuf, atrMult: activeAtrMult },
    },
  };
}
