// simulation-core.js  —  Static Concentrated Liquidity Pool
// ─────────────────────────────────────────────────────────────────────────────
//
//  POOL MODEL
//  ──────────
//  Constant-product invariant:  x · y = k
//  x = integer shares of Asset 1,  y = integer shares of Asset 2
//  k is re-derived from actual holdings after every trade.
//
//  CONCENTRATION BAND
//  ──────────────────
//  The pool is "active" only while the external price ratio stays within a
//  symmetric band around the center:
//
//    active range = [center × (1 − w),  center × (1 + w)]
//    w = concentrationPct / 100  (e.g. 2% → w = 0.02)
//
//  Inside band  → execute constant-product arbitrage swap (earn the spread).
//  Outside band → RECENTER: sell overweight asset, buy underweight, reset k.
//                 Brokerage is charged on both legs. P&L can be negative.
//
//  SWAP MECHANIC (two simultaneous NSE market orders)
//  ───────────────────────────────────────────────────
//  1. Compute continuous equilibrium:  x_target = sqrt(k × p2/p1)
//  2. delta = x_target − x  → round to nearest integer (not floor)
//  3. BUY  Δ shares of input asset from NSE market
//  4. Pool releases output via x·y=k  (floor-guarded: never sell last share)
//  5. SELL output shares to NSE market
//  6. Net profit = revenue − cost − buy_brok − sell_brok
//  7. Execute only if net > 0  AND both quantities ≥ 1 share
//
//  IL STOP-LOSS  (editable)
//  ────────────────────────
//  Halt all swaps when:
//    IL% = (pool_assets / hold_value − 1) × 100  <  − ilStopPct
//
//  AUTO-RESUME
//  ───────────
//  Resume swaps automatically when IL% recovers above − ilResumePct.
//  (ilResumePct must be ≤ ilStopPct, i.e. a shallower threshold.)
//  Set ilResumePct = 0 to disable auto-resume (stay halted permanently).
//
//  ALPHA-PROTECTION MODE
//  ──────────────────────
//  Once accumulated cash profit crosses alphaProtectThresholdPct % of capital:
//    IF  |IL%|  ≥  cash_roi_pct   →  halt swaps (IL would erase the alpha)
//    IF  |IL%|  <  cash_roi_pct   →  resume (alpha is safe again)
//  This guarantees total_value ≥ hold_value once alpha has been captured.
//  Set alphaProtectThresholdPct = 0 to enable from the very first hour.
// ─────────────────────────────────────────────────────────────────────────────

// ─── CSV parsing ─────────────────────────────────────────────────────────────

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
      b.c1 = a1[i].close; b.c2 = a2[j].close;  // keep last minute of each hour
      i++; j++;
    } else if (t1 < t2) i++; else j++;
  }
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// ─── Core constant-product swap ────────────────────────────────────────────────
//
// Returns null if:
//   • Price move < 0.5 shares worth (nothing to trade)
//   • Any rounded quantity is 0
//   • Net profit ≤ 0 (trade costs more than it earns)

function computeSwap(x, y, p1, p2, buyBrok, sellBrok) {
  const k = x * y;
  if (k === 0 || x < 2 || y < 2) return null;

  const xTarget = Math.sqrt(k * p2 / p1);
  const delta   = xTarget - x;

  if (delta >= 0.5) {
    // Buy Asset1, pool releases Asset2
    const buyQty  = Math.round(delta);
    if (buyQty < 1) return null;
    const xAfter  = x + buyQty;
    let   sellQty = Math.round(y - k / xAfter);
    sellQty = Math.min(sellQty, y - 1);      // never drain pool to zero
    if (sellQty < 1) return null;
    const cost    = buyQty  * p1;
    const revenue = sellQty * p2;
    const brok    = buyBrok * cost + sellBrok * revenue;
    const net     = revenue - cost - brok;
    if (net <= 0) return null;
    return { dir: 'BUY1', buyQty, sellQty, xAfter, yAfter: y - sellQty,
             cost, revenue, brok, net };

  } else if (delta <= -0.5) {
    // Buy Asset2, pool releases Asset1
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
    return { dir: 'BUY2', buyQty, sellQty, xAfter: x - sellQty, yAfter,
             cost, revenue, brok, net };
  }

  return null; // move too small for integer trade
}

// ─── Recenter rebalance ────────────────────────────────────────────────────────
//
// Resets pool to 50/50 value split at the new center price.
// Brokerage is always charged on both legs.
// Returns noTrade=true when pool is already balanced.

function computeRecenter(x, y, p1, p2, buyBrok, sellBrok) {
  const total = x * p1 + y * p2;
  const xNew  = Math.max(1, Math.round(total / 2 / p1));
  const yNew  = Math.max(1, Math.round(total / 2 / p2));
  const dx = xNew - x, dy = yNew - y;

  if (Math.abs(dx) < 1 && Math.abs(dy) < 1)
    return { xNew: x, yNew: y, cost: 0, revenue: 0, brok: 0, net: 0, noTrade: true };

  let buyAsset, sellAsset, buyQty, sellQty, cost, revenue;
  if (dx > 0 && dy < 0) {
    buyAsset = 'Asset 1'; sellAsset = 'Asset 2';
    buyQty   = Math.abs(dx); sellQty = Math.min(Math.abs(dy), y - 1);
    cost = buyQty * p1; revenue = sellQty * p2;
  } else if (dx < 0 && dy > 0) {
    buyAsset = 'Asset 2'; sellAsset = 'Asset 1';
    buyQty   = Math.abs(dy); sellQty = Math.min(Math.abs(dx), x - 1);
    cost = buyQty * p2; revenue = sellQty * p1;
  } else {
    return { xNew: x, yNew: y, cost: 0, revenue: 0, brok: 0, net: 0, noTrade: true };
  }

  if (buyQty < 1 || sellQty < 1)
    return { xNew: x, yNew: y, cost: 0, revenue: 0, brok: 0, net: 0, noTrade: true };

  const brok = buyBrok * cost + sellBrok * revenue;
  const net  = revenue - cost - brok;
  return { xNew, yNew, buyAsset, sellAsset, buyQty, sellQty, cost, revenue, brok, net, noTrade: false };
}

// ─── Performance summary ───────────────────────────────────────────────────────

export function buildPerformanceSummary(swapRecords, equityCurve, results) {
  const ANNUALISE = Math.sqrt(252 * 6); // NSE ~6 trading hours/day

  const regularSwaps  = swapRecords.filter(s => !s.isRecenter);
  const recenterTrades= swapRecords.filter(s =>  s.isRecenter);

  const grossFees     = regularSwaps.reduce((s, r) => s + (r.gross  ?? 0), 0);
  const swapBrok      = regularSwaps.reduce((s, r) => s + (r.brok   ?? 0), 0);
  const recenterBrok  = recenterTrades.reduce((s,r) => s + (r.brok  ?? 0), 0);
  const frictionRatio = grossFees > 0 ? results.totalBrokerage / grossFees : 1;

  const successful    = regularSwaps.filter(r => (r.net ?? 0) > 0).length;
  const successRate   = regularSwaps.length > 0 ? successful / regularSwaps.length : 0;

  // Max drawdown of alpha curve
  const alpha = equityCurve.map(p => (p.poolValue ?? 0) - (p.holdValue ?? 0));
  let peak = alpha[0] ?? 0, maxDD = 0;
  for (const v of alpha) { if (v > peak) peak = v; if (v - peak < maxDD) maxDD = v - peak; }
  const initHV = equityCurve[0]?.holdValue ?? 1;
  const maxDDPct = (maxDD / initHV) * 100;

  // Alpha Sharpe
  const alphaRets  = alpha.slice(1).map((v, i) => v - alpha[i]);
  const mrA = alphaRets.length ? alphaRets.reduce((s, v) => s + v, 0) / alphaRets.length : 0;
  let v2A = 0; for (const v of alphaRets) v2A += (v - mrA) ** 2;
  const sdA = alphaRets.length > 1 ? Math.sqrt(v2A / (alphaRets.length - 1)) : 1e-9;
  const alphaSharpe = sdA > 1e-12 ? (mrA / sdA) * ANNUALISE : 0;

  return {
    grossFees, swapBrok, recenterBrok,
    totalFriction: results.totalBrokerage,
    frictionRatio, frictionRatioPct: frictionRatio * 100,
    successfulSwaps: successful, totalSwaps: regularSwaps.length,
    successRate, successRatePct: successRate * 100,
    maxDrawdownINR: maxDD, maxDrawdownPct: maxDDPct,
    alphaSharpe,
    unrealizedIL: results.ilINR,
    netAlphaFinal: results.vsHold,
    narrative: {
      friction: frictionRatio < 0.10 ? 'GOOD — friction < 10% of gross'
                : frictionRatio < 0.25 ? 'MODERATE — reduce brokerage or widen band'
                : 'HIGH — recentering too frequently; widen band or raise cooldown',
      swapQuality: successRate >= 1.0 ? 'PERFECT — all swaps profitable'
                   : successRate > 0.85 ? 'EXCELLENT — >85% profitable'
                   : successRate > 0.70 ? 'GOOD — >70% profitable'
                   : 'LOW — lower brokerage or widen concentration band',
      ilStatus: results.ilPct >= 0 ? 'POSITIVE — pool assets exceed hold value'
                : `NEGATIVE — pool ${Math.abs(results.ilINR).toLocaleString('en-IN', { maximumFractionDigits: 0 })} below hold`,
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
  const concentrationPct  = clamp(+(config.concentrationPct  ?? 2.0), 0.1, 50);   // band half-width %
  const recenterCooldown  = Math.max(1, +(config.recenterCooldownHrs ?? 24));       // hours between recenters
  const buyBrok           = clamp(+(config.buyBrokeragePct   ?? 0.15), 0, 5) / 100;
  const sellBrok          = clamp(+(config.sellBrokeragePct  ?? 0.15), 0, 5) / 100;

  // IL stop-loss + auto-resume
  const ilStopPct         = clamp(+(config.ilStopLossPct     ?? 3.0), 0, 100);  // 0 = disabled
  const ilResumePct       = clamp(+(config.ilResumePct       ?? 1.0), 0, 100);  // 0 = no auto-resume

  // Alpha protection
  const alphaProtectThresh= clamp(+(config.alphaProtectThresholdPct ?? 0.3), 0, 100); // cash ROI% threshold
  const alphaProtectOn    = config.alphaProtectEnabled !== false;  // on by default

  const recenterOn        = config.recenterEnabled !== false;

  const w = concentrationPct / 100;  // band half-width as fraction

  // ── Pool init ───────────────────────────────────────────────────────────────
  const h0   = hourly[0];
  const xInit = Math.max(1, Math.round(realCapital / 2 / h0.c1));
  const yInit = Math.max(1, Math.round(realCapital / 2 / h0.c2));
  if (xInit < 1 || yInit < 1)
    return { error: 'Capital too low to purchase at least 1 share of each asset.' };

  let x = xInit, y = yInit, k = x * y;
  let center = h0.c1 / h0.c2;  // price ratio center

  const initCapital  = xInit * h0.c1 + yInit * h0.c2;

  // ── Running state ────────────────────────────────────────────────────────────
  let cashProfit       = 0;
  let totalBrokerage   = 0;
  let grossSwapFees    = 0;
  let totalSwaps       = 0;
  let successfulSwaps  = 0;
  let recenterCount    = 0;
  let lastRecenterIdx  = -(recenterCooldown + 1);

  // Stop-loss / alpha-protect state
  let swapsHalted      = false;
  let haltReason       = null;       // 'IL_STOP' | 'ALPHA_PROTECT' | null
  let ilHaltedAt       = null;
  let ilResumedAt      = null;
  let haltCount        = 0;
  let alphaProtected   = false;      // true once alpha-protect has ever fired

  const swapRecords = [];
  const equityCurve = [];

  equityCurve.push({
    date: h0.date.toISOString(),
    poolValue: initCapital, holdValue: initCapital,
    cashProfit: 0, alphaINR: 0, ilPct: 0,
    halted: false, haltReason: null,
    bandLow:  (center * (1 - w) * h0.c2),   // for chart
    bandHigh: (center * (1 + w) * h0.c2),
    ratio: center,
  });

  // ── Hour loop ─────────────────────────────────────────────────────────────────
  for (let idx = 1; idx < hourly.length; idx++) {
    const row  = hourly[idx];
    const p1   = row.c1, p2 = row.c2;
    const ext  = p1 / p2;

    // Current pool + hold snapshots (used for all halt/resume logic)
    const pvNow = x * p1 + y * p2;
    const hvNow = xInit * p1 + yInit * p2;
    const ilPctNow    = hvNow > 0 ? (pvNow / hvNow - 1) * 100 : 0;
    const cashRoiNow  = initCapital > 0 ? cashProfit / initCapital * 100 : 0;

    // ── AUTO-RESUME ────────────────────────────────────────────────────────────
    if (swapsHalted) {
      if (haltReason === 'IL_STOP' && ilResumePct > 0 && ilPctNow >= -ilResumePct) {
        swapsHalted  = false;
        haltReason   = null;
        ilResumedAt  = row.date.toISOString();
      } else if (haltReason === 'ALPHA_PROTECT' && cashRoiNow > 0 && Math.abs(ilPctNow) < cashRoiNow) {
        swapsHalted  = false;
        haltReason   = null;
        ilResumedAt  = row.date.toISOString();
      }
    }

    // ── HALT CHECKS ────────────────────────────────────────────────────────────
    if (!swapsHalted) {
      // 1. IL stop-loss
      if (ilStopPct > 0 && ilPctNow < -ilStopPct) {
        swapsHalted = true;
        haltReason  = 'IL_STOP';
        ilHaltedAt  = row.date.toISOString();
        haltCount++;
      }
      // 2. Alpha protection: cash alpha exists AND IL is threatening to erase it
      if (!swapsHalted && alphaProtectOn
          && cashRoiNow >= alphaProtectThresh
          && ilPctNow < 0
          && Math.abs(ilPctNow) >= cashRoiNow) {
        swapsHalted    = true;
        haltReason     = 'ALPHA_PROTECT';
        alphaProtected = true;
        ilHaltedAt     = row.date.toISOString();
        haltCount++;
      }
    }

    // ── BAND CHECK ─────────────────────────────────────────────────────────────
    const drift  = Math.abs(ext / center - 1);
    const inBand = drift <= w;

    // ── RECENTER (price exited band) ────────────────────────────────────────────
    if (!inBand && recenterOn && !swapsHalted) {
      const hrsSince = idx - lastRecenterIdx;
      if (hrsSince >= recenterCooldown) {
        const rec = computeRecenter(x, y, p1, p2, buyBrok, sellBrok);
        if (!rec.noTrade) {
          cashProfit     += rec.net;
          totalBrokerage += rec.brok;
          if (rec.buyAsset === 'Asset 1') {
            x = Math.max(1, x + rec.buyQty);
            y = Math.max(1, y - rec.sellQty);
          } else {
            y = Math.max(1, y + rec.buyQty);
            x = Math.max(1, x - rec.sellQty);
          }
          k = x * y;
          recenterCount++;
        }
        center = ext;
        lastRecenterIdx = idx;

        if (!rec.noTrade) {
          const pvR = x*p1+y*p2, hvR = xInit*p1+yInit*p2;
          swapRecords.push({
            date: row.date.toISOString(), isRecenter: true,
            action: `RECENTER — Buy ${rec.buyAsset} / Sell ${rec.sellAsset}`,
            buyAsset: rec.buyAsset, buyQty: rec.buyQty, cost: rec.cost,
            sellAsset: rec.sellAsset, sellQty: rec.sellQty, revenue: rec.revenue,
            gross: rec.revenue - rec.cost, brok: rec.brok, net: rec.net,
            cashProfit, asset1Price: p1, asset2Price: p2,
            poolX: x, poolY: y, poolValue: pvR,
            ilPct: hvR > 0 ? (pvR/hvR-1)*100 : 0,
            totalValue: pvR + cashProfit, haltReason,
          });
        }
      }
    }

    // ── SWAP (price inside band) ────────────────────────────────────────────────
    if (inBand && !swapsHalted) {
      const sw = computeSwap(x, y, p1, p2, buyBrok, sellBrok);
      if (sw) {
        grossSwapFees  += sw.revenue - sw.cost;  // gross before brok
        cashProfit     += sw.net;
        totalBrokerage += sw.brok;
        x = sw.xAfter; y = sw.yAfter; k = x * y;
        totalSwaps++;
        if (sw.net > 0) successfulSwaps++;

        const bA = sw.dir === 'BUY1' ? 'Asset 1' : 'Asset 2';
        const sA = sw.dir === 'BUY1' ? 'Asset 2' : 'Asset 1';
        const pvS = x*p1+y*p2, hvS = xInit*p1+yInit*p2;
        swapRecords.push({
          date: row.date.toISOString(), isRecenter: false,
          action: `Buy ${bA} / Sell ${sA}`,
          buyAsset: bA, buyQty: sw.buyQty, cost: sw.cost,
          sellAsset: sA, sellQty: sw.sellQty, revenue: sw.revenue,
          gross: sw.revenue - sw.cost, brok: sw.brok, net: sw.net,
          cashProfit, asset1Price: p1, asset2Price: p2,
          poolX: x, poolY: y, poolValue: pvS,
          ilPct: hvS > 0 ? (pvS/hvS-1)*100 : 0,
          totalValue: pvS + cashProfit, haltReason,
        });
      }
    }

    // ── Equity snapshot ─────────────────────────────────────────────────────────
    const pv = x*p1+y*p2, hv = xInit*p1+yInit*p2;
    equityCurve.push({
      date: row.date.toISOString(),
      poolValue: pv + cashProfit,
      holdValue: hv,
      cashProfit,
      alphaINR: pv + cashProfit - hv,
      ilPct: hv > 0 ? (pv/hv-1)*100 : 0,
      halted: swapsHalted,
      haltReason,
      bandLow:  center * (1 - w) * p2,   // ratio band expressed in p1 price terms
      bandHigh: center * (1 + w) * p2,
      ratio: ext,
    });
  }

  // ── Final metrics ────────────────────────────────────────────────────────────
  const last      = hourly[hourly.length - 1];
  const holdValue = xInit * last.c1 + yInit * last.c2;
  const poolAssets= x     * last.c1 + y     * last.c2;
  const totalValue= poolAssets + cashProfit;
  const ilINR     = poolAssets - holdValue;
  const ilPct     = holdValue > 0 ? (poolAssets / holdValue - 1) * 100 : 0;
  const vsHold    = totalValue - holdValue;
  const vsHoldPct = holdValue  > 0 ? (totalValue / holdValue - 1) * 100 : 0;

  const results = {
    initCapital, totalValue, poolAssets, holdValue,
    cashProfit, totalBrokerage, grossSwapFees,
    vsHold, vsHoldPct,
    roiPct:   initCapital > 0 ? (totalValue  / initCapital - 1) * 100 : 0,
    holdRoi:  initCapital > 0 ? (holdValue   / initCapital - 1) * 100 : 0,
    cashRoi:  initCapital > 0 ?  cashProfit   / initCapital * 100 : 0,
    brokRoi:  initCapital > 0 ?  totalBrokerage / initCapital * 100 : 0,
    ilINR, ilPct,
    swapsHalted, haltReason, ilHaltedAt, ilResumedAt,
    haltCount, alphaProtected,
    totalSwaps, successfulSwaps, recenterCount,
    successRate: totalSwaps > 0 ? successfulSwaps / totalSwaps : 0,
    initialX: xInit, initialY: yInit, finalX: x, finalY: y,
    concentrationPct, recenterCooldown,
    buyBrokeragePct: buyBrok * 100, sellBrokeragePct: sellBrok * 100,
  };

  const performanceSummary = buildPerformanceSummary(swapRecords, equityCurve, results);

  return { swaps: swapRecords, equityCurve, results, performanceSummary };
}
