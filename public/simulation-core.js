export function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((value) => value.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = (cells[index] || '').trim();
      return row;
    }, {});
  });
}

export function normalizeRows(rows) {
  return rows
    .map((row) => ({
      date: new Date(row.date),
      close: Number(row.close),
      volume: Number(row.volume),
    }))
    .filter((row) => !Number.isNaN(row.date.getTime()) && Number.isFinite(row.close) && Number.isFinite(row.volume))
    .sort((a, b) => a.date - b.date);
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values, avg) {
  if (!values.length) return 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function correlation(valuesA, valuesB) {
  if (!valuesA.length || valuesA.length !== valuesB.length) return 0;
  const meanA = mean(valuesA);
  const meanB = mean(valuesB);
  let numerator = 0;
  let varA = 0;
  let varB = 0;
  for (let index = 0; index < valuesA.length; index += 1) {
    const da = valuesA[index] - meanA;
    const db = valuesB[index] - meanB;
    numerator += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denominator = Math.sqrt(varA * varB);
  return denominator > 0 ? numerator / denominator : 0;
}

function getHourBucket(date) {
  const bucket = new Date(date);
  bucket.setMinutes(0, 0, 0);
  return bucket.toISOString();
}

function mergeRows(asset1, asset2) {
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < asset1.length && j < asset2.length) {
    const t1 = asset1[i].date.getTime();
    const t2 = asset2[j].date.getTime();
    if (t1 === t2) {
      merged.push({
        date: asset1[i].date,
        close1: asset1[i].close,
        close2: asset2[j].close,
        volume1: asset1[i].volume,
        volume2: asset2[j].volume,
      });
      i += 1;
      j += 1;
    } else if (t1 < t2) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return merged;
}

function toHourlyBuckets(mergedRows) {
  const map = new Map();
  for (const row of mergedRows) {
    const key = getHourBucket(row.date);
    if (!map.has(key)) {
      map.set(key, {
        date: new Date(key),
        close1: row.close1,
        close2: row.close2,
        hourlyVolume: 0,
      });
    }
    const bucket = map.get(key);
    bucket.close1 = row.close1;
    bucket.close2 = row.close2;
    bucket.hourlyVolume += row.volume1 + row.volume2;
  }

  const hourly = [...map.values()].sort((a, b) => a.date - b.date);
  for (let i = 0; i < hourly.length; i += 1) {
    if (i === 0) {
      hourly[i].ret1 = 0;
      hourly[i].ret2 = 0;
    } else {
      hourly[i].ret1 = (hourly[i].close1 / hourly[i - 1].close1) - 1;
      hourly[i].ret2 = (hourly[i].close2 / hourly[i - 1].close2) - 1;
    }
  }
  return hourly;
}

function getMode(hourlyVolume, lookbackVolumes, sigmaThreshold) {
  if (!lookbackVolumes.length) return 'MID';
  const avg = mean(lookbackVolumes);
  const sigma = stdDev(lookbackVolumes, avg);
  const band = sigmaThreshold * sigma;
  if (hourlyVolume < (avg - band)) return 'LOW';
  if (hourlyVolume > (avg + band)) return 'HIGH';
  return 'MID';
}

function widthByMode(mode, lowWidth, midWidth, highWidth) {
  if (mode === 'LOW') return lowWidth;
  if (mode === 'HIGH') return highWidth;
  return midWidth;
}

// True Uniswap V3 Math Helpers
function calculateLiquidity(x, y, P, Pa, Pb) {
  const Lx = x / ((1 / Math.sqrt(P)) - (1 / Math.sqrt(Pb)));
  const Ly = y / (Math.sqrt(P) - Math.sqrt(Pa));
  return Math.min(Lx, Ly); // Deploy max safe balanced liquidity
}

function getTargetX(L, P, Pa, Pb) {
  if (P <= Pa) return L * ((1 / Math.sqrt(Pa)) - (1 / Math.sqrt(Pb)));
  if (P >= Pb) return 0;
  return L * ((1 / Math.sqrt(P)) - (1 / Math.sqrt(Pb)));
}

function getTargetY(L, P, Pa, Pb) {
  if (P <= Pa) return 0;
  if (P >= Pb) return L * (Math.sqrt(Pb) - Math.sqrt(Pa));
  return L * (Math.sqrt(P) - Math.sqrt(Pa));
}

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);
  if (!asset1.length || !asset2.length) return { error: 'Invalid CSV data.' };

  const merged = mergeRows(asset1, asset2);
  const hourly = toHourlyBuckets(merged);
  if (hourly.length < 2) return { error: 'Insufficient data after grouping.' };

  // System Configuration (No more virtual capital inputs!)
  const lowWidth = Number(config.lowWidth ?? 0.75) / 100;
  const midWidth = Number(config.midWidth ?? 2.0) / 100;
  const highWidth = Number(config.highWidth ?? 5.0) / 100;
  const sigmaThreshold = Number(config.sigmaThreshold ?? 1.0);
  const lookbackHours = Math.max(5, Number(config.lookbackHours ?? 24));
  const recenterTrigger = Number(config.recenterTriggerPct ?? 75) / 100;
  const feeRate = Number(config.feePct ?? 0.3) / 100;

  // 1. Initial State Deployment
  const p1Init = hourly[0].close1;
  const p2Init = hourly[0].close2;
  
  // 50:50 Value Split
  let rx = (realCapital / 2) / p1Init;
  let ry = (realCapital / 2) / p2Init;
  const rxInit = rx;
  const ryInit = ry;

  let poolCash = 0;
  let currentMode = 'MID';
  let recenterCount = 0;
  const swapRecords = [];

  // Anchor Setup
  let Pc = p1Init / p2Init;
  let activeWidth = midWidth;
  let Pa = Pc * (1 - activeWidth / 2);
  let Pb = Pc * (1 + activeWidth / 2);
  let L = calculateLiquidity(rx, ry, Pc, Pa, Pb);

  for (let index = 1; index < hourly.length; index += 1) {
    const row = hourly[index];
    const P_current = row.close1 / row.close2;

    // A. Mode & Volatility Check
    const volLookback = hourly.slice(Math.max(0, index - lookbackHours), index).map((e) => e.hourlyVolume);
    currentMode = getMode(row.hourlyVolume, volLookback, sigmaThreshold);
    activeWidth = widthByMode(currentMode, lowWidth, midWidth, highWidth);

    // B. Calculate Drift & Check Recenter
    let driftPct = 0;
    if (P_current > Pc) {
      driftPct = (P_current - Pc) / (Pb - Pc);
    } else if (P_current < Pc) {
      driftPct = (Pc - P_current) / (Pc - Pa);
    }

    if (driftPct >= recenterTrigger) {
      // DYNAMIC RE-CENTER EXECUTION
      const currentPortfolioValue = (rx * row.close1) + (ry * row.close2);
      
      // Target perfectly balanced 50:50 inventory at the new price
      const targetRx = (currentPortfolioValue / 2) / row.close1;
      const targetRy = (currentPortfolioValue / 2) / row.close2;

      // Calculate the rebalancing swap cost
      const valueTraded = Math.abs(rx - targetRx) * row.close1;
      const rebalanceFee = valueTraded * feeRate;
      
      poolCash -= rebalanceFee; // The cost of shifting the anchor
      rx = targetRx;
      ry = targetRy;

      // Deploy New Anchors
      Pc = P_current;
      Pa = Pc * (1 - activeWidth / 2);
      Pb = Pc * (1 + activeWidth / 2);
      L = calculateLiquidity(rx, ry, Pc, Pa, Pb);
      
      recenterCount += 1;
      
      swapRecords.push({
        date: row.date.toISOString(),
        action: 'DYNAMIC RE-CENTER',
        mode: currentMode,
        netProfitInr: -rebalanceFee,
        accumulatedCash: poolCash,
        asset1Price: row.close1,
        asset2Price: row.close2
      });
      continue; // Skip normal harvesting this hour since we just rebuilt the pool
    }

    // C. Standard Harvesting (Within Range)
    const targetRx = getTargetX(L, P_current, Pa, Pb);
    const targetRy = getTargetY(L, P_current, Pa, Pb);

    const dx = rx - targetRx;
    const dy = targetRy - ry;

    // If there is a meaningful discrepancy, arbitrageurs trade with our pool
    if (Math.abs(dx) > 0.001 && Math.abs(dy) > 0.001) {
      let revenue = 0;
      let cost = 0;
      let actionStr = '';

      if (dx > 0) { // Pool sells Asset 1, buys Asset 2
        revenue = dx * row.close1;
        cost = dy * row.close2;
        actionStr = 'Harvest: Sell 1 / Buy 2';
      } else {      // Pool buys Asset 1, sells Asset 2
        revenue = dy * row.close2;
        cost = Math.abs(dx) * row.close1;
        actionStr = 'Harvest: Buy 1 / Sell 2';
      }

      const tradeFee = revenue * feeRate;
      const netProfit = revenue - cost - tradeFee;

      // STT / Friction Guard: Only process if the micro-trend generated real Alpha
      if (netProfit > 0) {
        rx = targetRx;
        ry = targetRy;
        poolCash += netProfit;

        swapRecords.push({
          date: row.date.toISOString(),
          mode: currentMode,
          action: actionStr,
          netProfitInr: netProfit,
          accumulatedCash: poolCash,
          asset1Price: row.close1,
          asset2Price: row.close2
        });
      }
    }
  }

  // 4. Final Performance Calculation
  const last = hourly[hourly.length - 1];
  const holdValue = (rxInit * last.close1) + (ryInit * last.close2);
  const poolAssetValue = (rx * last.close1) + (ry * last.close2);
  
  const impermanentLossInr = poolAssetValue - holdValue;
  const impermanentLossPct = holdValue > 0 ? ((poolAssetValue / holdValue) - 1) * 100 : 0;
  
  const totalFinalValue = poolAssetValue + poolCash; // Current Assets + Harvested Alpha
  const totalRoiPct = realCapital > 0 ? ((totalFinalValue / realCapital) - 1) * 100 : 0;

  return {
    swaps: swapRecords,
    results: {
      totalSwaps: swapRecords.length,
      recenterCount,
      poolCash,
      holdValue,
      poolAssetValue,
      totalFinalValue,
      impermanentLossInr,
      impermanentLossPct,
      totalRoiPct,
      initialCapital: realCapital,
      feePct: feeRate * 100,
    },
  };
}
