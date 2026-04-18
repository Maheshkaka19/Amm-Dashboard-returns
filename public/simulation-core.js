// simulation-core.js  —  Concentrated Liquidity Pool with Virtual Depth
// ─────────────────────────────────────────────────────────────────────────────
//
//  VIRTUAL LIQUIDITY — THE CORRECT MODEL
//  ───────────────────────────────────────
//  Based on Uniswap V3 concentrated liquidity mathematics.
//
//  Real capital  = your actual NSE portfolio (e.g. ₹20 L).
//                  Determines integer share counts and actual order sizes.
//
//  Virtual capital = the notional depth of the concentrated pool (e.g. ₹2 Cr).
//                  Sets the profit AMPLIFICATION factor:
//                    amplification = virtualCapital / realCapital
//
//  HOW AMPLIFICATION WORKS
//  ─────────────────────────
//  In a concentrated pool, liquidity is provided only within a price band.
//  For the same price move, a concentrated pool earns MORE fees than a full-
//  range pool because the same capital absorbs a larger fraction of the trade.
//  The amplification factor captures this: every ₹1 of gross swap profit
//  becomes ₹(amplification) of reported profit.
//
//  Example:
//    Real pool (₹20 L) does a swap, earns ₹100 gross.
//    Virtual depth 10× (₹2 Cr) → amplified profit = ₹1,000.
//    IL is also amplified (the other side of concentration).
//    Brokerage is on real order sizes (not amplified) — NSE charges real brok.
//
//  POOL MECHANICS
//  ───────────────
//  Swap signal:  x_target = sqrt(k_real × p2/p1)   ← standard constant-product
//  Trade qty:    delta = x_target − x_real          ← real integer shares
//  NSE orders:   BUY delta shares, SELL output shares (real quantities)
//  Brokerage:    charged on real prices × real quantities
//  Net profit:   (revenue − cost − brok) × amplification
//  IL:           (poolAssets − holdValue) × amplification   (reported)
//
//  IL STOP-LOSS + AUTO-RESUME
//  ───────────────────────────
//  Halt when: amplified IL% < −ilStopPct
//  Resume when: amplified IL% recovers above −ilResumePct (0 = stay halted)
//
//  ALPHA-PROTECTION
//  ─────────────────
//  After cash profit (amplified) crosses alphaProtectThresholdPct % of capital:
//    Halt if |amplifiedIL%| ≥ cashROI%  →  net alpha would be erased
//    Resume if |amplifiedIL%| < cashROI% → alpha is safe again
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

// ─── Merge 1-minute bars → hourly last-close ──────────────────────────────────

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

// ─── Constant-product swap (standard x·y=k) ───────────────────────────────────
//
// Uses the REAL pool invariant for trade signals and quantities.
// Returns the raw (un-amplified) P&L components so the caller can apply
// the virtual multiplier.
//
// Returns null when:
//   • price delta < 0.5 shares (too small to trade)
//   • any rounded quantity = 0
//   • raw net profit ≤ 0 (not profitable even before amplification)

function computeSwap(x, y, k, p1, p2, buyBrok, sellBrok) {
  if (k === 0 || x < 2 || y < 2) return null;

  const xTarget = Math.sqrt(k * p2 / p1);  // continuous equilibrium
  const delta   = xTarget - x;

  if (delta >= 0.5) {
    // ── Buy Asset1, pool releases Asset2 ──────────────────────────────────────
    const buyQty  = Math.round(delta);
    if (buyQty < 1) return null;
    const xAfter  = x + buyQty;
    let   sellQty = Math.round(y - k / xAfter);
    sellQty = Math.min(sellQty, y - 1);     // floor guard — never empty pool
    if (sellQty < 1) return null;
    const cost    = buyQty  * p1;
    const revenue = sellQty * p2;
    const brok    = buyBrok * cost + sellBrok * revenue;
    const net     = revenue - cost - brok;
    if (net <= 0) return null;
    return { dir: 'BUY1', buyQty, sellQty,
             xAfter, yAfter: y - sellQty,
             cost, revenue, gross: revenue - cost, brok, net };

  } else if (delta <= -0.5) {
    // ── Buy Asset2, pool releases Asset1 ──────────────────────────────────────
    const buyQty  = Math.round(-delta);
    if (buyQty < 1) return null;
    const yAfter  = y + buyQty;
    let   sellQty = Math.round(x - k / yAfter);
    sellQty = Math.min(sellQty, x - 1);
    if (sellQty < 1) return null;
    const cost    = buyQty  * p2;
    const revenue = sellQty * p1;
    const brok    = buyBrok * cost + sellBrok * revenue;
    const net     = revenue - cost - brok;
    if (net <= 0) return null;
    return { dir: 'BUY2', buyQty, sellQty,
             xAfter: x - sellQty, yAfter,
             cost, revenue, gross: revenue - cost, brok, net };
  }

  return null;
}

// ─── Performance summary ───────────────────────────────────────────────────────

export function buildPerformanceSummary(swapRecords, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6);  // NSE ~6 trading hours/day

  const grossFees     = swapRecords.reduce((s, r) => s + (r.ampGross ?? 0), 0);
  const totalFriction = results.totalBrokerage;
  const netIncome     = grossFees - totalFriction;
  const frictionRatio = grossFees > 0 ? totalFriction / grossFees : 1;
  const successful    = swapRecords.filter(r => (r.ampNet ?? 0) > 0).length;
  const successRate   = swapRecords.length > 0 ? successful / swapRecords.length : 0;

  // Max drawdown of amplified alpha curve
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

  const mult = results.virtMultiple;

  return {
    grossFees, totalFriction, netSwapIncome: netIncome,
    frictionRatio, frictionRatioPct: frictionRatio * 100,
    successfulSwaps: successful, totalSwaps: swapRecords.length,
    successRate, successRatePct: successRate * 100,
    maxDrawdownINR: maxDD, maxDrawdownPct: maxDDPct,
    alphaSharpe,
    unrealizedIL: results.ilINR,
    netAlphaFinal: results.vsHold,
    narrative: {
      friction: frictionRatio < 0.10 ? 'GOOD — friction < 10% of gross harvest'
                : frictionRatio < 0.25 ? 'MODERATE — consider lower brokerage'
                : 'HIGH — virtual multiplier too large for brokerage rate',
      swapQuality: successRate >= 1.0 ? 'PERFECT — all swaps profitable'
                   : successRate > 0.85 ? 'EXCELLENT — >85% profitable'
                   : successRate > 0.70 ? 'GOOD — >70% profitable'
                   : 'LOW — too many unprofitable swaps',
      ilStatus: results.ilPct >= 0
        ? 'POSITIVE — amplified pool value exceeds hold'
        : `NEGATIVE IL — ${mult.toFixed(1)}× amplification cuts both ways`,
      depth: `${mult.toFixed(1)}× depth (₹${(results.virtualCapital/1e5).toFixed(0)} L virtual on ₹${(results.realCapital/1e5).toFixed(0)} L real)`,
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
    return { error: 'No overlapping timestamps found. Check both CSVs cover the same period.' };

  // ── Config ──────────────────────────────────────────────────────────────────
  const virtualCapital = Math.max(realCapital, +(config.virtualCapital ?? realCapital));
  const amp            = virtualCapital / realCapital;   // profit amplification factor

  const buyBrok  = clamp(+(config.buyBrokeragePct  ?? 0.15), 0, 5) / 100;
  const sellBrok = clamp(+(config.sellBrokeragePct ?? 0.15), 0, 5) / 100;

  const ilStopPct   = clamp(+(config.ilStopLossPct ?? 3.0), 0, 100);  // 0 = disabled
  const ilResumePct = clamp(+(config.ilResumePct   ?? 1.0), 0, 100);  // 0 = stay halted

  const alphaProtectThresh = clamp(+(config.alphaProtectThresholdPct ?? 0.3), 0, 100);
  const alphaProtectOn     = config.alphaProtectEnabled !== false;

  // ── Pool init ───────────────────────────────────────────────────────────────
  const h0    = hourly[0];
  const xInit = Math.max(1, Math.round(realCapital / 2 / h0.c1));
  const yInit = Math.max(1, Math.round(realCapital / 2 / h0.c2));
  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low to purchase at least 1 share of each asset.' };

  let x = xInit, y = yInit, k = x * y;

  const realInitCap = xInit * h0.c1 + yInit * h0.c2;

  // Reported capital = virtualCapital (what the pool "represents")
  // Actual P&L is in real ₹, amplified by the multiplier
  const reportedCap = virtualCapital;

  // ── State ────────────────────────────────────────────────────────────────────
  let cashProfit      = 0;   // amplified cash
  let totalBrokerage  = 0;   // amplified brokerage
  let grossSwapFees   = 0;   // amplified gross
  let totalSwaps      = 0;
  let successfulSwaps = 0;

  let swapsHalted    = false;
  let haltReason     = null;
  let ilHaltedAt     = null;
  let ilResumedAt    = null;
  let haltCount      = 0;
  let alphaProtected = false;

  const swapRecords = [];
  const equityCurve = [];

  // Initial equity point — pool value reported as virtual-equivalent
  const initHoldVal = xInit * h0.c1 + yInit * h0.c2;
  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initHoldVal * amp,   // virtual-equivalent pool value
    holdValue: initHoldVal * amp,   // virtual-equivalent hold value
    cashProfit: 0, alphaINR: 0, ilPct: 0,
    halted: false, haltReason: null,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row = hourly[idx];
    const p1  = row.c1, p2 = row.c2;

    // Real pool vs hold (for IL metrics)
    const realPV     = x * p1 + y * p2;
    const realHV     = xInit * p1 + yInit * p2;

    // Amplified values (what the virtual pool "shows")
    const ampPV      = realPV * amp;
    const ampHV      = realHV * amp;
    const ilPctNow   = ampHV > 0 ? (ampPV / ampHV - 1) * 100 : 0;   // same as real IL%
    const cashRoiNow = reportedCap > 0 ? cashProfit / reportedCap * 100 : 0;

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

    // ── SWAP ────────────────────────────────────────────────────────────────────
    if (!swapsHalted) {
      const sw = computeSwap(x, y, k, p1, p2, buyBrok, sellBrok);
      if (sw) {
        // Amplify P&L by virtual multiplier
        const ampGross = sw.gross * amp;
        const ampBrok  = sw.brok  * amp;
        const ampNet   = sw.net   * amp;

        grossSwapFees  += ampGross;
        cashProfit     += ampNet;
        totalBrokerage += ampBrok;

        // Real pool positions update (actual NSE holdings)
        x = sw.xAfter; y = sw.yAfter; k = x * y;
        totalSwaps++;
        if (sw.net > 0) successfulSwaps++;

        const bA  = sw.dir === 'BUY1' ? 'Asset 1' : 'Asset 2';
        const sA  = sw.dir === 'BUY1' ? 'Asset 2' : 'Asset 1';
        const pvS = x * p1 + y * p2;
        const hvS = xInit * p1 + yInit * p2;
        swapRecords.push({
          date: row.date.toISOString(),
          action: `Buy ${bA} / Sell ${sA}`,
          buyAsset: bA, buyQty: sw.buyQty, sellAsset: sA, sellQty: sw.sellQty,
          // Show real trade costs, amplified profit
          cost: sw.cost, revenue: sw.revenue,
          realGross: sw.gross, realBrok: sw.brok, realNet: sw.net,
          ampGross, ampBrok, ampNet,
          cashProfit,
          asset1Price: p1, asset2Price: p2,
          poolX: x, poolY: y,
          poolValue: pvS * amp,
          ilPct: hvS > 0 ? (pvS / hvS - 1) * 100 : 0,
          totalValue: pvS * amp + cashProfit,
          haltReason, amp,
        });
      }
    }

    // ── Equity snapshot ─────────────────────────────────────────────────────────
    const pv = x * p1 + y * p2;
    const hv = xInit * p1 + yInit * p2;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv * amp + cashProfit,
      holdValue: hv * amp,
      cashProfit,
      alphaINR: pv * amp + cashProfit - hv * amp,
      ilPct: hv > 0 ? (pv / hv - 1) * 100 : 0,
      halted: swapsHalted,
      haltReason,
    });
  }

  // ── Final metrics ────────────────────────────────────────────────────────────
  const last       = hourly[hourly.length - 1];
  const realHVEnd  = xInit * last.c1 + yInit * last.c2;
  const realPVEnd  = x     * last.c1 + y     * last.c2;
  const holdValue  = realHVEnd * amp;
  const poolAssets = realPVEnd * amp;
  const totalValue = poolAssets + cashProfit;
  const ilINR      = poolAssets - holdValue;
  const ilPct      = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const vsHold     = totalValue - holdValue;
  const vsHoldPct  = holdValue  > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    realCapital, virtualCapital, virtMultiple: amp,
    realInitCap, reportedCap,
    totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossSwapFees,
    vsHold, vsHoldPct,
    roiPct:   reportedCap > 0 ? (totalValue  / reportedCap - 1) * 100 : 0,
    holdRoi:  reportedCap > 0 ? (holdValue   / reportedCap - 1) * 100 : 0,
    cashRoi:  reportedCap > 0 ?  cashProfit   / reportedCap * 100 : 0,
    brokRoi:  reportedCap > 0 ?  totalBrokerage / reportedCap * 100 : 0,
    ilINR, ilPct,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt,
    haltCount, alphaProtected,
    totalSwaps, successfulSwaps,
    successRate: totalSwaps > 0 ? successfulSwaps / totalSwaps : 0,
    initialX: xInit, initialY: yInit, finalX: x, finalY: y,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
  };

  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);
  return { swaps: swapRecords, equityCurve, results, performanceSummary };
}
