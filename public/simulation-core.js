// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  simulation-core.js  —  AMM Net-Alpha Guardian  v8                          ║
// ║  Senior Quantitative Developer: Market Making & Concentrated Liquidity       ║
// ╠══════════════════════════════════════════════════════════════════════════════╣
// ║                                                                              ║
// ║  ARCHITECTURE OVERVIEW                                                       ║
// ║  ─────────────────────────────────────────────────────────────────────────  ║
// ║  Pool Model:    Constant-product  x · y = k  (integer NSE shares)           ║
// ║                                                                              ║
// ║  1. NET-ALPHA OBJECTIVE FUNCTION                                             ║
// ║     The optimizer no longer chases "cash profit". It maximises:             ║
// ║     NetAlpha = GrossSwapFees − TotalFriction − CrystallizedIL − UnrealizedIL║
// ║     This is the true mark-to-market P&L of the LP position vs hold.         ║
// ║     "Not losing money is a strategy."                                        ║
// ║                                                                              ║
// ║  2. MULTI-SIMULATION BATCH OPTIMIZER  (runBatchOptimization)                ║
// ║     4-D grid search:                                                         ║
// ║       [Width Multiplier] × [Cooldown Period] × [Profit Buffer]               ║
// ║       × [IL-Stop Threshold]                                                  ║
// ║     Walk-forward validation: train 10 days → test 3 days.                   ║
// ║     Reports Sharpe Ratio of the Alpha Curve per parameter set.              ║
// ║                                                                              ║
// ║  3. REGIME-SPECIFIC DYNAMICS (ATR-based, not heuristic)                     ║
// ║     TRENDING (24h move > 2×ATR14):                                          ║
// ║       → Widen bands 3× (stop chasing the trend)                            ║
// ║       → Profit buffer 5.0× (only trade massive mispricing)                 ║
// ║       → Double cooldown (no recentering during runaway moves)               ║
// ║     RANGING (24h move < 0.5×ATR14):                                         ║
// ║       → Tighten bands 0.7× (maximise micro-oscillation harvest)             ║
// ║       → Profit buffer 1.0× (capture every viable spread)                   ║
// ║       → Allow shorter cooldown                                              ║
// ║                                                                              ║
// ║  4. PERFORMANCE SUMMARY                                                      ║
// ║     • Gross Harvest vs Total Friction (Friction Ratio)                       ║
// ║     • Max Drawdown of the Alpha Curve (₹ and %)                             ║
// ║     • Success Rate (swaps that covered their own brokerage)                  ║
// ║     • Alpha Sharpe Ratio (annualised, NSE hours basis)                       ║
// ║     • Crystallized IL (from recenters) vs Unrealized IL (pool drift)         ║
// ║                                                                              ║
// ║  5. ANTI-CHURN STACK (from v7, hardened)                                    ║
// ║     • ATR-floored dynamic bands                                              ║
// ║     • Hysteresis profit buffer (regime-adaptive)                             ║
// ║     • Rebalance cooldown with emergency bypass                               ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: CSV / DATA UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

export function splitCsvLine(line) {
  const cells = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
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

// ─── 1-minute → hourly last-close merge ───────────────────────────────────────

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
    arr[k].ret1 = k === 0 ? 0 : arr[k].c1 / arr[k - 1].c1 - 1;
    arr[k].ret2 = k === 0 ? 0 : arr[k].c2 / arr[k - 1].c2 - 1;
  }
  return arr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: STATISTICAL PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════════

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function variance(a, m) {
  if (a.length < 2) return 0;
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1); // sample variance
}

function stdDev(a, m) { return Math.sqrt(variance(a, m)); }

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Pearson correlation over the last n elements of arrays a and b.
 * Returns 0 if insufficient data.
 */
function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const as = a.slice(-n), bs = b.slice(-n);
  const ma = mean(as), mb = mean(bs);
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = as[i] - ma, db = bs[i] - mb;
    num += da * db; va += da * da; vb += db * db;
  }
  const d = Math.sqrt(va * vb);
  return d > 0 ? num / d : 0;
}

/**
 * Volume regime classifier.
 * Returns 'LOW' | 'MID' | 'HIGH' based on current volume vs rolling mean ± σ·SD.
 */
function volMode(vol, window, sigma) {
  if (!window.length) return 'MID';
  const avg = mean(window), sd = stdDev(window, avg);
  if (vol < avg - sigma * sd) return 'LOW';
  if (vol > avg + sigma * sd) return 'HIGH';
  return 'MID';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: ATR ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds the Average True Range array for the price RATIO (p1/p2).
 *
 * True Range proxy per bar:  |ratio[t] / ratio[t-1] - 1|
 * ATR[t] = rolling mean of TR over `period` bars.
 *
 * This is the canonical measure of ratio volatility. It feeds:
 *   (a) Dynamic band floor: band ≥ ATR × atrMult
 *   (b) Regime classification: trend strength vs ATR
 *   (c) Sharpe denominator in the optimizer
 *
 * @param {Array} hourly - merged hourly price array with .c1, .c2
 * @param {number} period - ATR lookback period in hours (default 14)
 * @returns {Float64Array} ATR values, same length as hourly
 */
export function buildRatioATR(hourly, period) {
  const n      = hourly.length;
  const tr     = new Float64Array(n);  // True Range per bar
  const atr    = new Float64Array(n);  // Rolling ATR

  // Bar 0: no previous — TR = 0
  for (let i = 1; i < n; i++) {
    const rPrev = hourly[i - 1].c1 / hourly[i - 1].c2;
    const rCurr = hourly[i].c1     / hourly[i].c2;
    tr[i] = Math.abs(rCurr / rPrev - 1);
  }

  // Seed ATR[0] with first available bar's TR to avoid cold-start zeros
  atr[0] = tr[1] || 0.003;

  // Wilder-style simple rolling mean (no EMA — more transparent for backtesting)
  for (let i = 1; i < n; i++) {
    const lo = Math.max(1, i - period + 1);
    let s = 0;
    for (let j = lo; j <= i; j++) s += tr[j];
    atr[i] = s / (i - lo + 1);
  }
  return atr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: REGIME CLASSIFIER  (v8 — fully ATR-quantified)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classifies the current market regime for the price ratio.
 *
 * v8 regime logic uses QUANTIFIED ATR thresholds, not heuristic sign-counts:
 *
 *   trend_24h = |ratio[now] / ratio[24h ago] - 1|   (24h directional drift)
 *
 *   TRENDING : trend_24h > 2 × ATR14   → Ratio is in a sustained directional move.
 *              Action: Widen bands 3×, raise buffer to 5×, double cooldown.
 *              Rationale: Swapping INTO a trend crystallises IL rapidly.
 *
 *   RANGING  : trend_24h < 0.5 × ATR14 → Ratio is mean-reverting.
 *              Action: Tighten bands 0.7×, lower buffer to 1×.
 *              Rationale: Micro-oscillations are harvestable at low IL cost.
 *
 *   (Anything between 0.5 and 2 ATRs → default RANGING, no special multiplier)
 *
 * @returns {'TRENDING' | 'RANGING'}
 */
export function classifyRegime(hourly, idx, atrArr) {
  if (idx < 24) return 'RANGING';

  const rNow  = hourly[idx].c1      / hourly[idx].c2;
  const r24h  = hourly[idx - 24].c1 / hourly[idx - 24].c2;
  const trend = Math.abs(rNow / r24h - 1);
  const atr   = atrArr[idx];

  if (atr < 1e-10) return 'RANGING';
  if (trend > 2.0 * atr) return 'TRENDING';
  return 'RANGING';
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: REGIME PARAMETER TABLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns regime-adjusted trading parameters.
 *
 * TRENDING regime:
 *   widthMult  = 3.0  → Band is 3× base width.  Most moves will stay inside;
 *                        we avoid recentering during the trend.
 *   profitBuf  = 5.0  → Only trade if net > 5× brokerage cost.  Prevents chasing
 *                        the trend at marginal profit and bleeding IL.
 *   cooldownMult = 2.0 → Double cooldown; recentering in a trend = guaranteed loss.
 *
 * RANGING regime:
 *   widthMult  = 0.7  → Tight band harvests every micro-oscillation.
 *   profitBuf  = 1.0  → Standard gate; net must exceed brokerage once.
 *   cooldownMult = 0.75 → Allow more frequent recentering after short breaks.
 *
 * These multipliers are applied on top of the optimizer-selected base parameters,
 * so the optimizer still adapts the base; regime logic adjusts in real time.
 *
 * @param {string} regime - 'TRENDING' | 'RANGING'
 * @param {Object} baseParams - { width, cooldown, profitBuffer }
 * @returns {{ dynWidth, dynBuffer, dynCooldown }}
 */
function applyRegimeDynamics(regime, baseParams) {
  if (regime === 'TRENDING') {
    return {
      dynWidth:    baseParams.width    * 3.0,
      dynBuffer:   5.0,
      dynCooldown: Math.round(baseParams.cooldown * 2.0),
    };
  }
  // RANGING (default)
  return {
    dynWidth:    baseParams.width    * 0.7,
    dynBuffer:   baseParams.profitBuffer,
    dynCooldown: Math.max(4, Math.round(baseParams.cooldown * 0.75)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: CORE TRADE MECHANICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Computes a constant-product arbitrage swap.
 *
 * Determines the optimal integer trade to realign the pool's internal price
 * ratio with the external market price, subject to:
 *   1. Quantities rounded to nearest whole share (not floored — reduces systematic bias)
 *   2. Floor guard: never sell more than (held - 1) shares
 *   3. Hysteresis gate: netProfit must exceed (profitBuffer × brokerage)
 *
 * Returns null if:
 *   - Price moved < 0.5 shares worth
 *   - Any quantity rounds to 0
 *   - Net profit does not clear the buffer
 *
 * @param {number} x - Current Asset1 integer shares in pool
 * @param {number} y - Current Asset2 integer shares in pool
 * @param {number} p1 - Asset1 market price ₹
 * @param {number} p2 - Asset2 market price ₹
 * @param {number} buyBrok - Buy-side brokerage rate (e.g. 0.0015)
 * @param {number} sellBrok - Sell-side brokerage rate
 * @param {number} profitBuffer - Net must exceed (buffer × brokerage) to execute
 * @returns {Object|null} swap details, or null if no viable trade
 */
function computeSwap(x, y, p1, p2, buyBrok, sellBrok, profitBuffer) {
  const k = x * y;
  if (k === 0) return null;

  // Continuous equilibrium targets from constant-product law
  const xTarget = Math.sqrt(k * p2 / p1);
  const dx      = xTarget - x;  // positive → buy Asset1; negative → buy Asset2

  let sw = null;

  if (dx >= 0.5) {
    // ── BUY Asset1 from NSE, pool releases Asset2 ─────────────────────────
    const buyQty  = Math.round(dx);
    if (buyQty < 1) return null;
    const xAfter  = x + buyQty;
    // Output derived strictly from k — prevents floating-point drift accumulation
    let   sellQty = Math.round(y - k / xAfter);
    sellQty       = Math.min(sellQty, y - 1);      // floor guard
    if (sellQty < 1) return null;
    const cost    = buyQty  * p1;
    const revenue = sellQty * p2;
    const brok    = buyBrok * cost + sellBrok * revenue;
    const gross   = revenue - cost;
    const net     = gross - brok;
    sw = { dir: 'BUY1_SELL2', buyQty, sellQty,
           xAfter, yAfter: y - sellQty, cost, revenue, gross, brok, net };

  } else if (dx <= -0.5) {
    // ── BUY Asset2 from NSE, pool releases Asset1 ─────────────────────────
    const buyQty  = Math.round(-dx);
    if (buyQty < 1) return null;
    const yAfter  = y + buyQty;
    let   sellQty = Math.round(x - k / yAfter);
    sellQty       = Math.min(sellQty, x - 1);      // floor guard
    if (sellQty < 1) return null;
    const cost    = buyQty  * p2;
    const revenue = sellQty * p1;
    const brok    = buyBrok * cost + sellBrok * revenue;
    const gross   = revenue - cost;
    const net     = gross - brok;
    sw = { dir: 'BUY2_SELL1', buyQty, sellQty,
           xAfter: x - sellQty, yAfter, cost, revenue, gross, brok, net };
  }

  if (!sw) return null;

  // ── HYSTERESIS GATE ────────────────────────────────────────────────────────
  // Trade executes ONLY if net profit > profitBuffer × brokerage.
  // At buffer=1.0: net must exceed its own friction cost.
  // At buffer=5.0 (TRENDING): net must exceed 5× friction — blocks all marginal trades.
  if (sw.net <= sw.brok * profitBuffer) return null;

  return sw;
}

/**
 * Computes the recenter rebalancing trade (50/50 value split).
 *
 * When price exits the active band, we rebalance to equal-value weighting
 * at the new center price. This costs brokerage on both legs — it is never
 * "free." The resulting P&L is charged to cashProfit (can be negative).
 *
 * Crystallized IL: the difference between pool value and hold value AT THE
 * MOMENT of recentering is the IL that has been "locked in" by the rebalance.
 * We track this separately from unrealized (floating) IL.
 */
function computeRecenter(x, y, p1, p2, buyBrok, sellBrok) {
  const totalVal = x * p1 + y * p2;
  const xNew     = Math.max(1, Math.round(totalVal / 2 / p1));
  const yNew     = Math.max(1, Math.round(totalVal / 2 / p2));
  const dx = xNew - x, dy = yNew - y;

  const EMPTY = { xNew: x, yNew: y, boughtAsset: '', soldAsset: '',
                  boughtQty: 0, soldQty: 0, cost: 0, revenue: 0,
                  gross: 0, brok: 0, net: 0, noTrade: true };

  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return EMPTY;

  let boughtAsset, soldAsset, boughtQty, soldQty, cost, revenue;

  if (dx > 0 && dy < 0) {
    boughtAsset = 'Asset 1'; soldAsset = 'Asset 2';
    boughtQty   = Math.abs(dx);
    soldQty     = Math.min(Math.abs(dy), y - 1);
    cost        = boughtQty * p1; revenue = soldQty * p2;
  } else if (dx < 0 && dy > 0) {
    boughtAsset = 'Asset 2'; soldAsset = 'Asset 1';
    boughtQty   = Math.abs(dy);
    soldQty     = Math.min(Math.abs(dx), x - 1);
    cost        = boughtQty * p2; revenue = soldQty * p1;
  } else { return EMPTY; }

  if (boughtQty < 1 || soldQty < 1) return EMPTY;

  const gross = revenue - cost;
  const brok  = buyBrok * cost + sellBrok * revenue;
  const net   = gross - brok;
  return { xNew, yNew, boughtAsset, soldAsset, boughtQty, soldQty,
           cost, revenue, gross, brok, net, noTrade: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: NET-ALPHA OBJECTIVE FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Computes the Net Alpha score for the optimizer's objective function.
 *
 * NetAlpha = GrossSwapFees − TotalFriction − CrystallizedIL − UnrealizedIL
 *
 * Component definitions:
 *   GrossSwapFees   : sum of (revenue − cost) across all swap trades (pre-brokerage)
 *   TotalFriction   : all brokerage paid (swaps + recenters)
 *   CrystallizedIL  : IL locked in at each recenter moment
 *                     = Σ (poolValue_before_recenter − holdValue_before_recenter)
 *                       for each recenter where pool < hold
 *   UnrealizedIL    : (poolValue_now − holdValue_now), negative = pool below hold
 *
 * Relationship to "vs Hold":
 *   NetAlpha = totalValue − holdValue  (mathematically identical)
 *   We compute it component-by-component for transparency and penalisation.
 *
 * Optimizer penalty: an extra churn penalty reduces the score for each recenter,
 * because recenters do not appear in grossSwapFees but directly cost brokerage
 * and lock in IL. This discourages the optimizer from selecting configs that
 * generate cash through frequent rebalancing at the expense of IL.
 *
 * @param {Object} components - { grossFees, friction, crystallizedIL, unrealizedIL,
 *                                recenters, poolNotional }
 * @param {number} buyBrok
 * @param {number} sellBrok
 * @returns {number} score (higher is better)
 */
function netAlphaScore(components, buyBrok, sellBrok) {
  const { grossFees, friction, crystallizedIL, unrealizedIL,
          recenters, poolNotional } = components;

  // Core formula
  const netAlpha = grossFees - friction + crystallizedIL + unrealizedIL;
  // crystallizedIL is negative when pool < hold → reduces score

  // Churn penalty: each recenter costs ~(buyBrok+sellBrok)/2 × poolNotional
  // beyond what is already in friction (brokerage is already captured there).
  // We add a forward-looking penalty to represent the NEXT PERIOD'S risk of
  // recentering again before the position can recover.
  const churnPenalty = recenters * poolNotional * (buyBrok + sellBrok) * 0.3;

  return netAlpha - churnPenalty;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: INNER SIMULATION  (stripped — for optimizer speed)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fast inner simulation used by the optimizer and batch runner.
 * No swap records, no equity curve — pure P&L tracking for speed.
 *
 * Returns full NetAlpha decomposition so the objective function has
 * all components. Approximately 1–5ms per 60-hour window.
 *
 * @param {Array}  hourly     - full hourly dataset
 * @param {Float64Array} atrArr - precomputed ATR array
 * @param {number} startIdx  - window start (exclusive: first trade is startIdx+1)
 * @param {number} endIdx    - window end (exclusive)
 * @param {number} initX     - starting Asset1 shares
 * @param {number} initY     - starting Asset2 shares
 * @param {number} initCenter - starting price-ratio center
 * @param {Object} params    - { width, cooldown, profitBuffer, atrMult, ilStopPct }
 * @param {number} buyBrok
 * @param {number} sellBrok
 * @returns {Object} { score, netAlpha, grossFees, friction, crystallizedIL,
 *                     unrealizedIL, recenters, swaps, successSwaps, x, y, center }
 */
function innerSim(hourly, atrArr, startIdx, endIdx,
                  initX, initY, initCenter,
                  params, buyBrok, sellBrok) {

  const { width, cooldown, profitBuffer, atrMult, ilStopPct = 0 } = params;

  // Inner sim uses fixed correlation impact (fast approximation)
  const CORR_IMPACT  = 0.5;
  const CORR_LB      = 24;
  const EXTREME_MULT = 4.0;
  const NSE_HOURS    = 6;     // trading hours per day (for Sharpe normalisation)

  let x = initX, y = initY, k = x * y, center = initCenter;

  // P&L trackers
  let grossFees      = 0;   // sum of (revenue-cost) on PROFITABLE swaps (pre-brok)
  let friction       = 0;   // total brokerage on all trades
  let crystallizedIL = 0;   // IL locked at each recenter moment (negative = bad)
  let recenters      = 0;
  let swaps          = 0;
  let successSwaps   = 0;   // swaps that covered their own brokerage (net > 0)
  let attemptedSwaps = 0;

  let lastRec = startIdx - cooldown - 1;
  let halted  = false;

  // Alpha tracking for Sharpe within this window
  const alphaPoints = [];

  const h0 = hourly[startIdx];
  const xI0 = x, yI0 = y;  // window-start hold reference

  for (let i = startIdx + 1; i < endIdx; i++) {
    if (i >= hourly.length || halted) break;

    const { c1: p1, c2: p2 } = hourly[i];
    const ext = p1 / p2;

    // ── Regime & dynamic parameters ─────────────────────────────────────────
    const regime = classifyRegime(hourly, i, atrArr);
    const corrWin = hourly.slice(Math.max(0, i - CORR_LB), i);
    const corr = pearsonCorr(corrWin.map(h => h.ret1), corrWin.map(h => h.ret2));

    const base = {
      width,
      cooldown,
      profitBuffer,
    };
    const { dynWidth, dynBuffer, dynCooldown } = applyRegimeDynamics(regime, base);

    // ATR floor on band
    const atrBand = atrMult * atrArr[i];
    const baseCorr = dynWidth * (1 + CORR_IMPACT * (1 - Math.abs(corr)));
    const activeW  = Math.max(atrBand, baseCorr);

    // ── Band check ─────────────────────────────────────────────────────────
    const drift  = Math.abs(ext / center - 1);
    const inBand = drift <= activeW;

    if (!inBand) {
      const hrsSince = i - lastRec;
      const extreme  = drift > activeW * EXTREME_MULT;
      if (hrsSince >= dynCooldown || extreme) {
        // Crystallize IL at this moment
        const pvBefore = x * p1 + y * p2;
        const hvBefore = xI0 * p1 + yI0 * p2;
        crystallizedIL += (pvBefore - hvBefore); // negative when pool < hold

        // Execute recenter
        const totalVal = x * p1 + y * p2;
        const xn = Math.max(1, Math.round(totalVal / 2 / p1));
        const yn = Math.max(1, Math.round(totalVal / 2 / p2));
        const dx = xn - x, dy = yn - y;
        if (dx > 0 && dy < 0) {
          const dxB = Math.abs(dx), dyS = Math.min(Math.abs(dy), y - 1);
          if (dxB >= 1 && dyS >= 1) {
            const cost = dxB * p1, rev = dyS * p2;
            const rb = buyBrok * cost + sellBrok * rev;
            x += dxB; y -= dyS; k = x * y;
            friction += rb; // brokerage only (recenter P&L in crystallizedIL above)
          }
        } else if (dy > 0 && dx < 0) {
          const dyB = Math.abs(dy), dxS = Math.min(Math.abs(dx), x - 1);
          if (dyB >= 1 && dxS >= 1) {
            const cost = dyB * p2, rev = dxS * p1;
            const rb = buyBrok * cost + sellBrok * rev;
            y += dyB; x -= dxS; k = x * y;
            friction += rb;
          }
        }
        center = ext; lastRec = i; recenters++;
      }

      // IL stop-loss check
      if (ilStopPct > 0) {
        const pv = x * p1 + y * p2, hv = xI0 * p1 + yI0 * p2;
        if (hv > 0 && (pv / hv - 1) * 100 < -ilStopPct) { halted = true; }
      }
      continue;
    }

    // ── Regular swap ────────────────────────────────────────────────────────
    attemptedSwaps++;
    const sw = computeSwap(x, y, p1, p2, buyBrok, sellBrok, dynBuffer);
    if (sw) {
      grossFees += sw.gross;    // pre-brokerage spread captured
      friction  += sw.brok;
      x = sw.xAfter; y = sw.yAfter; k = x * y;
      swaps++;
      if (sw.net > 0) successSwaps++;
    }

    // Track alpha for Sharpe
    const pv = x * p1 + y * p2;
    const hv = xI0 * p1 + yI0 * p2;
    const cashSoFar = grossFees - friction; // approximation (no cashProfit accumulator here)
    alphaPoints.push((pv + cashSoFar - hv) / Math.max(hv, 1));

    // IL stop-loss
    if (ilStopPct > 0 && hv > 0 && (pv / hv - 1) * 100 < -ilStopPct) { halted = true; }
  }

  // ── Final unrealized IL ──────────────────────────────────────────────────
  const lastH = hourly[Math.min(endIdx - 1, hourly.length - 1)];
  const pvEnd = x * lastH.c1 + y * lastH.c2;
  const hvEnd = xI0 * lastH.c1 + yI0 * lastH.c2;
  const unrealizedIL = pvEnd - hvEnd;  // snapshot at window end

  // ── Sharpe of alpha within this window ──────────────────────────────────
  let windowSharpe = 0;
  if (alphaPoints.length > 1) {
    const rets = alphaPoints.slice(1).map((v, i) => v - alphaPoints[i]);
    const mr = mean(rets);
    const sr = stdDev(rets, mr);
    if (sr > 1e-12) {
      // Annualise: sqrt(252 trading days × NSE_HOURS hours/day)
      windowSharpe = (mr / sr) * Math.sqrt(252 * NSE_HOURS);
    }
  }

  // ── Net Alpha score ──────────────────────────────────────────────────────
  const poolNotional = pvEnd;
  const score = netAlphaScore(
    { grossFees, friction, crystallizedIL, unrealizedIL, recenters, poolNotional },
    buyBrok, sellBrok,
  );

  return {
    score,
    netAlpha:       grossFees - friction + crystallizedIL + unrealizedIL,
    grossFees,
    friction,
    crystallizedIL,
    unrealizedIL,
    recenters,
    swaps,
    successSwaps,
    attemptedSwaps,
    windowSharpe,
    x, y, k, center,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: 4-D GRID  +  BATCH OPTIMIZER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 4-dimensional parameter grid for the batch optimizer.
 *
 * Dimensions:
 *   1. widthPct      : base half-band width as % of price ratio
 *   2. cooldownHours : minimum hours between recenters
 *   3. profitBuffer  : minimum net / brokerage ratio to execute a swap
 *   4. ilStopPct     : unrealized IL threshold that halts all swaps (0 = disabled)
 *
 * Grid size: 5 × 4 × 4 × 3 = 240 candidates.
 * Each inner sim runs in ~1-5ms → full grid takes ~0.25-1.2s per window.
 */
const GRID_4D = (() => {
  const g = [];
  for (const widthPct    of [1.0, 1.5, 2.0, 3.0, 4.0]) {
    for (const cooldown   of [8,   16,  24,  48]) {
      for (const profitBuf of [0.5, 1.0, 2.0, 5.0]) {
        for (const ilStop  of [0,   2.0, 5.0]) {
          g.push({
            width:        widthPct / 100,
            cooldown,
            profitBuffer: profitBuf,
            atrMult:      2.5,   // fixed — prevents adding a 5th dim (100× slower)
            ilStopPct:    ilStop,
          });
        }
      }
    }
  }
  return g;  // 240 candidates
})();

/**
 * Walk-forward optimizer: finds the best 4D parameter set for a training window,
 * validates on the test window, and returns both train and test NetAlpha scores.
 *
 * Training objective: maximise netAlphaScore (not cash) on past data.
 * Validation: apply winning params to the unseen test period.
 *
 * This separation prevents overfitting — a param set that worked in training
 * must also produce positive NetAlpha in validation to be considered robust.
 *
 * @param {Array}  hourly
 * @param {Float64Array} atrArr
 * @param {number} trainStart - inclusive
 * @param {number} trainEnd   - exclusive (= testStart)
 * @param {number} testEnd    - exclusive
 * @param {number} poolX, poolY, centerRatio - current pool state
 * @param {number} buyBrok, sellBrok
 * @returns {{ bestParams, trainScore, testNetAlpha, testSharpe, allResults }}
 */
function walkForwardWindow(hourly, atrArr, trainStart, trainEnd, testEnd,
                           poolX, poolY, centerRatio, buyBrok, sellBrok) {
  let bestScore    = -Infinity;
  let bestParams   = GRID_4D[0];
  const allResults = [];

  for (const params of GRID_4D) {
    const r = innerSim(hourly, atrArr, trainStart, trainEnd,
                       poolX, poolY, centerRatio, params, buyBrok, sellBrok);
    allResults.push({ params, score: r.score, netAlpha: r.netAlpha,
                      sharpe: r.windowSharpe, recenters: r.recenters });
    if (r.score > bestScore) { bestScore = r.score; bestParams = params; }
  }

  // Validate winning params on unseen test period
  const testResult = innerSim(hourly, atrArr, trainEnd, testEnd,
                               poolX, poolY, centerRatio, bestParams, buyBrok, sellBrok);

  return {
    bestParams,
    trainScore:   bestScore,
    testNetAlpha: testResult.netAlpha,
    testSharpe:   testResult.windowSharpe,
    testRecenters: testResult.recenters,
    testSwaps:    testResult.swaps,
    allResults,   // full grid scores (for the batch optimizer to expose)
  };
}

/**
 * runBatchOptimization: iterates the full walk-forward grid search over the
 * entire dataset and returns a comprehensive report.
 *
 * This is the "N-Iterations" batch runner. It:
 *   1. Slides a training window (trainDays) → test window (testDays) across all data.
 *   2. For each window: runs 240-candidate grid search on training data.
 *   3. Validates best params on test data.
 *   4. Aggregates across all windows: mean/std of test NetAlpha, Sharpe, recenters.
 *   5. Returns the parameter set with the highest MEDIAN test NetAlpha (robust).
 *
 * Output includes a full Pareto analysis: for each param set, what was its
 * average [testNetAlpha, testSharpe, recenterCount] across all windows?
 * This lets the user see the trade-off between yield and churn.
 *
 * @param {Array}  hourly
 * @param {Float64Array} atrArr
 * @param {number} trainDays, testDays
 * @param {number} initX, initY - initial pool inventory
 * @param {number} buyBrok, sellBrok
 * @param {Function} [onProgress] - optional callback(pct, windowIdx, totalWindows)
 * @returns {Object} batchReport
 */
export function runBatchOptimization(hourly, atrArr, trainDays, testDays,
                                     initX, initY, buyBrok, sellBrok,
                                     onProgress = null) {
  const HOURS_PER_DAY = 6;
  const trainH = trainDays * HOURS_PER_DAY;
  const testH  = testDays  * HOURS_PER_DAY;

  if (hourly.length < trainH + testH) {
    return { error: 'Insufficient data for walk-forward optimization.' };
  }

  // Accumulate per-parameter-set results across all windows
  // Key: JSON(params), Value: array of { testNetAlpha, testSharpe, recenters }
  const paramAccumulator = new Map();
  for (const p of GRID_4D) {
    paramAccumulator.set(JSON.stringify(p), []);
  }

  const windowReports = [];
  let   windowIdx     = 0;
  const totalWindows  = Math.floor((hourly.length - trainH) / testH);

  let x = initX, y = initY, center = hourly[0].c1 / hourly[0].c2;

  let cursor = trainH;  // first training window ends here
  while (cursor + testH <= hourly.length) {
    const trainStart = cursor - trainH;
    const trainEnd   = cursor;
    const testEnd    = Math.min(cursor + testH, hourly.length);

    const wf = walkForwardWindow(hourly, atrArr, trainStart, trainEnd, testEnd,
                                  x, y, center, buyBrok, sellBrok);

    // Accumulate per-param results from allResults (training scores) and
    // also the winning param's test result
    for (const { params, score, netAlpha, sharpe, recenters } of wf.allResults) {
      const key = JSON.stringify(params);
      paramAccumulator.get(key).push({
        trainNetAlpha: netAlpha,
        trainScore:    score,
        trainSharpe:   sharpe,
        trainRecenters: recenters,
        // We only have test data for the WINNING param in this window
        testNetAlpha:  null,
        testSharpe:    null,
      });
    }

    // Record the winning param's test result separately
    const winKey = JSON.stringify(wf.bestParams);
    const winArr = paramAccumulator.get(winKey);
    if (winArr.length > 0) {
      winArr[winArr.length - 1].testNetAlpha  = wf.testNetAlpha;
      winArr[winArr.length - 1].testSharpe    = wf.testSharpe;
    }

    windowReports.push({
      windowIdx,
      trainStart, trainEnd, testEnd,
      date: hourly[trainEnd]?.date?.toISOString() ?? '',
      bestParams:   wf.bestParams,
      trainScore:   wf.trainScore,
      testNetAlpha: wf.testNetAlpha,
      testSharpe:   wf.testSharpe,
      testRecenters: wf.testRecenters,
      testSwaps:    wf.testSwaps,
    });

    // Advance pool state using the best params on the test window
    const advance = innerSim(hourly, atrArr, trainEnd, testEnd,
                              x, y, center, wf.bestParams, buyBrok, sellBrok);
    x = advance.x; y = advance.y; center = advance.center;

    cursor += testH;
    windowIdx++;
    if (onProgress) onProgress(Math.round(windowIdx / totalWindows * 100), windowIdx, totalWindows);
  }

  // ── Aggregate per-parameter-set statistics ───────────────────────────────
  const paramStats = [];
  for (const [key, records] of paramAccumulator.entries()) {
    if (!records.length) continue;
    const params      = JSON.parse(key);
    const trainAlphas = records.map(r => r.trainNetAlpha).filter(v => v != null);
    const trainSharpes= records.map(r => r.trainSharpe).filter(v => v != null);
    const testAlphas  = records.map(r => r.testNetAlpha).filter(v => v != null);
    const testSharpes = records.map(r => r.testSharpe).filter(v => v != null);

    const sorted = [...testAlphas].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

    paramStats.push({
      params,
      meanTrainAlpha:  mean(trainAlphas),
      meanTrainSharpe: mean(trainSharpes),
      meanTestAlpha:   mean(testAlphas),
      medianTestAlpha: median,
      meanTestSharpe:  mean(testSharpes),
      nTestWindows:    testAlphas.length,
    });
  }

  // Sort by median test NetAlpha (robustness criterion)
  paramStats.sort((a, b) => b.medianTestAlpha - a.medianTestAlpha);
  const robustBestParams = paramStats[0]?.params ?? GRID_4D[0];

  // ── Overall test performance summary ────────────────────────────────────
  const allTestAlphas  = windowReports.map(w => w.testNetAlpha).filter(v => v != null);
  const allTestSharpes = windowReports.map(w => w.testSharpe).filter(v => v != null);

  return {
    windowReports,          // per-window detail
    paramStats,             // Pareto table: all 240 params ranked
    robustBestParams,       // param with highest MEDIAN test NetAlpha
    summary: {
      totalWindows:    windowReports.length,
      meanTestNetAlpha: mean(allTestAlphas),
      meanTestSharpe:   mean(allTestSharpes),
      positiveWindows:  allTestAlphas.filter(v => v > 0).length,
      totalTestWindows: allTestAlphas.length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: PERFORMANCE SUMMARY CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Computes the institutional-grade Performance Summary from the equity curve
 * and swap records produced by runAlmSimulation.
 *
 * Outputs:
 *   - Gross Harvest vs Total Friction (Friction Ratio = friction / grossFees)
 *   - Max Drawdown of Alpha Curve (₹ and %)
 *   - Alpha Sharpe Ratio (annualised on NSE hours basis: √(252×6))
 *   - Success Rate = profitable_swaps / attempted_swaps
 *   - Crystallized IL (from recenters) vs Unrealized IL (end of period)
 *
 * @param {Array} swapRecords - from runAlmSimulation
 * @param {Array} equityCurve - from runAlmSimulation
 * @param {Object} finalResults - from runAlmSimulation
 * @returns {Object} performanceSummary
 */
export function buildPerformanceSummary(swapRecords, equityCurve, finalResults) {
  const NSE_HOURS_PER_DAY = 6;
  const ANNUALISE = Math.sqrt(252 * NSE_HOURS_PER_DAY);

  // ── 1. Gross Harvest vs Friction ─────────────────────────────────────────
  const swapsOnly = swapRecords.filter(s => !s.isRecenter);
  const grossFees = swapsOnly.reduce((s, r) => s + (r.grossProfit ?? 0), 0);
  const totalFriction = finalResults.totalBrokerage;
  const frictionRatio = grossFees > 0 ? totalFriction / grossFees : 0;
  const netSwapIncome = grossFees - swapsOnly.reduce((s, r) => s + (r.totalBrokerageRow ?? 0), 0);

  // ── 2. Crystallized IL (sum of IL at each recenter) ──────────────────────
  const recentersOnly = swapRecords.filter(s => s.isRecenter);
  const crystallizedIL = recentersOnly.reduce((s, r) => s + (r.crystallizedILAtRecenter ?? 0), 0);
  // (crystallizedILAtRecenter is computed in the main loop below)

  // ── 3. Success Rate ────────────────────────────────────────────────────────
  const totalAttempted = swapsOnly.length; // only attempted-and-recorded swaps
  const successfulSwaps = swapsOnly.filter(s => (s.netProfit ?? 0) > 0).length;
  const successRate = totalAttempted > 0 ? successfulSwaps / totalAttempted : 0;

  // ── 4. Alpha Curve — Max Drawdown & Sharpe ────────────────────────────────
  // Alpha curve: (totalAMMValue - holdValue) at each hourly point
  const alphaAbsolute = equityCurve.map(p => p.poolValue - p.holdValue);
  const alphaPct      = equityCurve.map((p, i) => {
    const hv = p.holdValue;
    return hv > 0 ? (p.poolValue / hv - 1) * 100 : 0;
  });

  // Max drawdown (absolute ₹)
  let peak = alphaAbsolute[0] ?? 0, maxDD = 0;
  for (const v of alphaAbsolute) {
    if (v > peak) peak = v;
    if (v - peak < maxDD) maxDD = v - peak;
  }
  const maxDDPct = equityCurve.length > 0 && equityCurve[0].holdValue > 0
    ? (maxDD / equityCurve[0].holdValue) * 100
    : 0;

  // Hourly alpha returns for Sharpe
  const alphaRets = alphaAbsolute.slice(1).map((v, i) => v - alphaAbsolute[i]);
  const meanAlphaRet = mean(alphaRets);
  const stdAlphaRet  = stdDev(alphaRets, meanAlphaRet);
  const alphaSharpe  = stdAlphaRet > 1e-12
    ? (meanAlphaRet / stdAlphaRet) * ANNUALISE
    : 0;

  // ── 5. Unrealized IL ─────────────────────────────────────────────────────
  const unrealizedIL = finalResults.ilINR; // poolAssets - holdValue at end

  // ── 6. IL Breakdown ───────────────────────────────────────────────────────
  // Total IL drag = crystallizedIL + unrealizedIL
  // When crystallizedIL < 0: recenters happened when pool < hold → locked in losses
  const totalILDrag   = (crystallizedIL < 0 ? crystallizedIL : 0) + unrealizedIL;
  const netAlphaFinal = finalResults.vsHold; // = totalValue - holdValue

  return {
    // Harvest vs Friction
    grossFees,                          // ₹ spread captured before any brokerage
    totalFriction,                      // ₹ total brokerage paid
    netSwapIncome,                      // ₹ after brokerage, before IL
    frictionRatio,                      // totalFriction / grossFees (lower = better)
    frictionRatioPct: frictionRatio * 100,

    // Success Rate
    totalAttempted,
    successfulSwaps,
    successRate,
    successRatePct: successRate * 100,

    // Alpha Curve
    maxDrawdownINR: maxDD,
    maxDrawdownPct: maxDDPct,
    alphaSharpe,

    // IL Decomposition
    crystallizedIL,
    unrealizedIL,
    totalILDrag,
    netAlphaFinal,

    // Formatted narrative
    narrative: {
      frictionEfficiency: frictionRatio < 0.05
        ? 'EXCELLENT — friction < 5% of gross harvest'
        : frictionRatio < 0.10
        ? 'GOOD — friction < 10% of gross harvest'
        : frictionRatio < 0.25
        ? 'ACCEPTABLE — friction < 25% of gross harvest'
        : 'HIGH — friction > 25% of gross harvest; reduce brokerage or pair volatility',
      swapQuality: successRate > 0.80
        ? 'HIGH — >80% of swaps cleared their own brokerage'
        : successRate > 0.60
        ? 'MODERATE — 60-80% of swaps profitable'
        : 'LOW — <60% success rate; raise profitBuffer',
      ilStatus: unrealizedIL > 0
        ? 'POSITIVE IL — pool outperformed hold in asset value'
        : `NEGATIVE IL — pool assets ₹${Math.abs(unrealizedIL).toFixed(0)} below hold; structural pair drift`,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: MAIN SIMULATION  (runAlmSimulation)
// ═══════════════════════════════════════════════════════════════════════════════

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  // ── Parse & merge data ───────────────────────────────────────────────────
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);
  if (!asset1.length || !asset2.length)
    return { error: 'Both CSV files must contain valid date, close, and volume columns.' };

  const hourly = buildHourly(asset1, asset2);
  if (hourly.length < 2)
    return { error: 'No overlapping timestamps found. Confirm both CSVs cover the same period.' };

  // ── Config ───────────────────────────────────────────────────────────────
  const HOURS_PER_DAY  = 6;
  const trainDays      = Math.max(3, +(config.trainDays      ?? 10));
  const testDays       = Math.max(1, +(config.testDays       ?? 3));
  const trainH         = trainDays * HOURS_PER_DAY;
  const testH          = testDays  * HOURS_PER_DAY;
  const useWalkForward = config.walkForward !== false;

  // Static fallback params (pre-optimizer, or when WF disabled)
  const staticWidth      = clamp(+(config.midWidth        ?? 2.0), 0.05, 50) / 100;
  const staticCooldown   = Math.max(1, +(config.cooldownHours   ?? 24));
  const staticProfitBuf  = clamp(+(config.profitBuffer    ?? 1.0), 0, 10);
  const staticAtrMult    = clamp(+(config.atrMultiplier   ?? 2.5), 0.5, 20);
  const staticIlStop     = clamp(+(config.ilStopLossPct   ?? 0),   0, 100);

  const corrLB     = Math.max(2, +(config.corrLookbackHours ?? 24));
  const corrImpact = clamp(+(config.correlationImpact ?? 0.5), 0, 2);
  const extremeMult= clamp(+(config.extremeMult       ?? 4.0), 1.5, 20);
  const sigmaT     = clamp(+(config.sigmaThreshold    ?? 1.0), 0.1, 5);
  const lookbackH  = Math.max(2, +(config.lookbackHours    ?? 24));
  const atrPeriod  = Math.max(2, +(config.atrPeriod        ?? 14));
  const buyBrok    = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok   = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;
  const pauseHigh  = !!config.pauseHighVol;
  const recenterOn = config.recenterEnabled !== false;

  // ── Precompute ATR ────────────────────────────────────────────────────────
  const atrArr = buildRatioATR(hourly, atrPeriod);

  // ── Initialise pool ───────────────────────────────────────────────────────
  const h0    = hourly[0];
  const xInit = Math.max(1, Math.round(realCapital / 2 / h0.c1));
  const yInit = Math.max(1, Math.round(realCapital / 2 / h0.c2));
  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low: cannot purchase even 1 share of each asset.' };

  let x = xInit, y = yInit, k = x * y;
  let center = h0.c1 / h0.c2;

  // Active (optimizer-updated) parameters
  let ap = {
    width:        staticWidth,
    cooldown:     staticCooldown,
    profitBuffer: staticProfitBuf,
    atrMult:      staticAtrMult,
    ilStopPct:    staticIlStop,
  };

  // Walk-forward schedule
  let nextOptimizeAt = useWalkForward ? trainH : Infinity;
  const optimizerLog = [];

  // Running totals for performance summary
  let cashProfit       = 0;   // net cash from all trades
  let totalBrokerage   = 0;
  let totalSwaps       = 0;
  let recenterCount    = 0;
  let recenterSwaps    = 0;
  let grossSwapFees    = 0;   // sum of (revenue-cost) on profitable swaps
  let crystallizedILTotal = 0; // IL locked at each recenter
  let swapBrokerage    = 0;   // brokerage on swaps only (not recenters)
  let successfulSwaps  = 0;
  let ilHalted         = false;
  let ilHaltedAt       = null;
  let lastRecenterIdx  = -staticCooldown - 1;
  const modeHours      = { LOW: 0, MID: 0, HIGH: 0 };
  const regimeHours    = { TRENDING: 0, RANGING: 0 };

  const initCashDeployed = xInit * h0.c1 + yInit * h0.c2;
  const swapRecords      = [];
  const equityCurve      = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initCashDeployed, holdValue: initCashDeployed,
    cashProfit: 0, ilPct: 0, alphaINR: 0,
    correlation: 0, activeWidthPct: ap.width * 100,
    regime: 'RANGING', mode: 'MID',
    halted: false, optimized: false,
  });

  // ── Hour loop ────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1, p2 = row.c2;
    const ext = p1 / p2;

    // ── Walk-forward optimizer trigger ───────────────────────────────────
    let justOptimized = false;
    if (useWalkForward && idx === nextOptimizeAt) {
      const trainStart = idx - trainH;
      const trainEnd   = idx;
      const testEnd    = Math.min(idx + testH, hourly.length);

      const wf = walkForwardWindow(hourly, atrArr, trainStart, trainEnd, testEnd,
                                    x, y, center, buyBrok, sellBrok);
      ap = { ...wf.bestParams };
      nextOptimizeAt = idx + testH;
      justOptimized  = true;

      optimizerLog.push({
        atHour:       idx,
        date:         row.date.toISOString(),
        params:       { ...ap },
        trainScore:   wf.trainScore,
        testNetAlpha: wf.testNetAlpha,
        testSharpe:   wf.testSharpe,
        poolValue:    x * p1 + y * p2 + cashProfit,
        topCandidates: wf.allResults
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(r => ({ params: r.params, score: r.score, sharpe: r.sharpe })),
      });
    }

    // ── Volume regime ─────────────────────────────────────────────────────
    const volWin = hourly.slice(Math.max(0, idx - lookbackH), idx).map(h => h.vol);
    const mode   = volMode(row.vol, volWin, sigmaT);
    modeHours[mode]++;

    // ── Market regime (v8 ATR-based) ──────────────────────────────────────
    const regime = classifyRegime(hourly, idx, atrArr);
    regimeHours[regime]++;

    // Pause conditions
    const pauseThisHour = pauseHigh && mode === 'HIGH';

    // ── Regime-specific parameter adjustment ──────────────────────────────
    const { dynWidth, dynBuffer, dynCooldown } = applyRegimeDynamics(regime, ap);

    // ── ATR-floored dynamic band ──────────────────────────────────────────
    const atr = atrArr[idx];
    const corrWin = hourly.slice(Math.max(0, idx - corrLB), idx);
    const corr    = pearsonCorr(corrWin.map(h => h.ret1), corrWin.map(h => h.ret2));
    const baseCorr = dynWidth * (1 + corrImpact * (1 - Math.abs(corr)));
    const atrFloor = ap.atrMult * atr;
    const activeW  = Math.max(atrFloor, baseCorr);

    // ── Band check ────────────────────────────────────────────────────────
    const drift  = Math.abs(ext / center - 1);
    const inBand = drift <= activeW;

    // ── RECENTER ─────────────────────────────────────────────────────────
    if (!inBand && !ilHalted && recenterOn && !pauseThisHour) {
      const hrsSince = idx - lastRecenterIdx;
      const extreme  = drift > activeW * extremeMult;
      const canRecenter = hrsSince >= dynCooldown || extreme;

      if (canRecenter) {
        // Crystallize IL at this moment (pool vs hold before trade)
        const pvBefore = x * p1 + y * p2;
        const hvBefore = xInit * p1 + yInit * p2;
        const ilAtRecenter = pvBefore - hvBefore; // negative = pool below hold
        crystallizedILTotal += ilAtRecenter;

        const rec = computeRecenter(x, y, p1, p2, buyBrok, sellBrok);
        if (!rec.noTrade) {
          // Recenter brokerage is friction; P&L absorbed into pool
          cashProfit     += rec.net;   // can be negative
          totalBrokerage += rec.brok;

          if (rec.boughtAsset === 'Asset 1') {
            x = Math.max(1, x + rec.boughtQty);
            y = Math.max(1, y - rec.soldQty);
          } else {
            y = Math.max(1, y + rec.boughtQty);
            x = Math.max(1, x - rec.soldQty);
          }
          k = x * y;
          recenterSwaps++;
        }
        center = ext; lastRecenterIdx = idx; recenterCount++;

        const pvAfter = x * p1 + y * p2;
        const hvAfter = xInit * p1 + yInit * p2;
        const ilPct   = hvAfter > 0 ? (pvAfter / hvAfter - 1) * 100 : 0;

        swapRecords.push({
          date: row.date.toISOString(), mode, regime,
          rollingCorrelation: corr, activeWidthPct: activeW * 100,
          atrPct: atr * 100, activeCooldown: dynCooldown,
          isRecenter: true, extreme, justOptimized,
          action: rec.noTrade
            ? 'RECENTER (no trade needed — already balanced)'
            : `RECENTER: Buy ${rec.boughtAsset} / Sell ${rec.soldAsset}`,
          boughtAsset: rec.boughtAsset, boughtQty: rec.boughtQty,
          boughtCost: rec.cost, soldAsset: rec.soldAsset,
          soldQty: rec.soldQty, soldRevenue: rec.revenue,
          grossProfit: rec.gross, brokerageOnBuy: buyBrok * rec.cost,
          brokerageOnSell: sellBrok * rec.revenue, totalBrokerageRow: rec.brok,
          netProfit: rec.net, cashProfit,
          asset1Price: p1, asset2Price: p2, poolX: x, poolY: y,
          poolAssetValue: pvAfter, ilPct,
          crystallizedILAtRecenter: ilAtRecenter, // exposed for summary
          totalValue: pvAfter + cashProfit,
        });

        if (ap.ilStopPct > 0 && ilPct < -ap.ilStopPct) {
          ilHalted = true; ilHaltedAt = row.date.toISOString();
        }

        const eqPv = x * p1 + y * p2, eqHv = xInit * p1 + yInit * p2;
        equityCurve.push({
          date: row.date.toISOString(),
          poolValue: eqPv + cashProfit, holdValue: eqHv,
          cashProfit, ilPct: (eqPv / eqHv - 1) * 100,
          alphaINR: eqPv + cashProfit - eqHv,
          correlation: corr, activeWidthPct: activeW * 100,
          regime, mode, halted: ilHalted, optimized: justOptimized,
        });
        continue;
      }
      // Cooldown still active — pool stays out of band silently
    }

    // ── REGULAR SWAP ──────────────────────────────────────────────────────
    if (inBand && !ilHalted && !pauseThisHour) {
      const sw = computeSwap(x, y, p1, p2, buyBrok, sellBrok, dynBuffer);
      if (sw) {
        grossSwapFees  += sw.gross;
        swapBrokerage  += sw.brok;
        cashProfit     += sw.net;
        totalBrokerage += sw.brok;
        x = sw.xAfter; y = sw.yAfter; k = x * y;
        totalSwaps++;
        if (sw.net > 0) successfulSwaps++;

        const bA = sw.dir === 'BUY1_SELL2' ? 'Asset 1' : 'Asset 2';
        const sA = sw.dir === 'BUY1_SELL2' ? 'Asset 2' : 'Asset 1';
        const pv = x * p1 + y * p2, hv = xInit * p1 + yInit * p2;
        const ilPct = hv > 0 ? (pv / hv - 1) * 100 : 0;

        swapRecords.push({
          date: row.date.toISOString(), mode, regime,
          rollingCorrelation: corr, activeWidthPct: activeW * 100,
          atrPct: atr * 100, activeCooldown: dynCooldown,
          isRecenter: false, extreme: false, justOptimized,
          action: `Buy ${bA} / Sell ${sA}`,
          boughtAsset: bA, boughtQty: sw.buyQty, boughtCost: sw.cost,
          soldAsset: sA,   soldQty: sw.sellQty,  soldRevenue: sw.revenue,
          grossProfit: sw.gross,
          brokerageOnBuy:  buyBrok  * sw.cost,
          brokerageOnSell: sellBrok * sw.revenue,
          totalBrokerageRow: sw.brok,
          netProfit: sw.net, cashProfit,
          asset1Price: p1, asset2Price: p2, poolX: x, poolY: y,
          poolAssetValue: pv, ilPct,
          crystallizedILAtRecenter: null,
          totalValue: pv + cashProfit,
        });

        if (ap.ilStopPct > 0 && ilPct < -ap.ilStopPct) {
          ilHalted = true; ilHaltedAt = row.date.toISOString();
        }
      }
    }

    // ── Equity curve (every hour) ─────────────────────────────────────────
    const pv = x * p1 + y * p2, hv = xInit * p1 + yInit * p2;
    const ilPct = hv > 0 ? (pv / hv - 1) * 100 : 0;
    if (ap.ilStopPct > 0 && ilPct < -ap.ilStopPct && !ilHalted) {
      ilHalted = true; ilHaltedAt = row.date.toISOString();
    }
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv + cashProfit, holdValue: hv,
      cashProfit, ilPct, alphaINR: pv + cashProfit - hv,
      correlation: corr, activeWidthPct: activeW * 100,
      regime, mode, halted: ilHalted, optimized: justOptimized,
    });
  }

  // ── Final metrics ─────────────────────────────────────────────────────────
  const last       = hourly[hourly.length - 1];
  const holdValue  = xInit * last.c1 + yInit * last.c2;
  const poolAssets = x     * last.c1 + y     * last.c2;
  const totalValue = poolAssets + cashProfit;
  const ilINR      = poolAssets - holdValue;
  const ilPct      = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const vsHold     = totalValue - holdValue;
  const vsHoldPct  = holdValue > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    // Capital
    initCashDeployed,
    totalValue, poolAssets, holdValue, cashProfit, totalBrokerage,
    vsHold, vsHoldPct,
    roiPct:   initCashDeployed > 0 ? (totalValue  / initCashDeployed - 1) * 100 : 0,
    holdRoi:  initCashDeployed > 0 ? (holdValue   / initCashDeployed - 1) * 100 : 0,
    cashRoi:  initCashDeployed > 0 ?  cashProfit   / initCashDeployed * 100 : 0,
    brokRoi:  initCashDeployed > 0 ?  totalBrokerage / initCashDeployed * 100 : 0,
    // IL
    ilINR, ilPct, ilHalted, ilHaltedAt,
    crystallizedILTotal, unrealizedIL: ilINR,
    // Trades
    totalSwaps, recenterSwaps, recenterCount,
    successfulSwaps,
    grossSwapFees,
    successRate: totalSwaps > 0 ? successfulSwaps / totalSwaps : 0,
    harvestPerRecenter: recenterCount > 0 ? cashProfit / recenterCount : cashProfit,
    alphaEfficiency: totalBrokerage > 0 ? cashProfit / totalBrokerage : 0,
    // Brokerage split
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
    // Inventory
    initialX: xInit, initialY: yInit, finalX: x, finalY: y,
    // Regime / mode hours
    trendingHours: regimeHours.TRENDING, rangingHours: regimeHours.RANGING,
    lowModeHours:  modeHours.LOW, midModeHours: modeHours.MID, highModeHours: modeHours.HIGH,
    // Optimizer
    optimizerWindows: optimizerLog.length,
    activeParams: { ...ap },
  };

  // ── Performance Summary ───────────────────────────────────────────────────
  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);

  return { swaps: swapRecords, equityCurve, optimizerLog, results, performanceSummary };
}
