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

function floorUnits(value) {
  return Math.max(0, Math.floor(value));
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
  return [...map.values()].sort((a, b) => a.date - b.date);
}

function calcRangeBounds(centerPrice, widthPct) {
  return {
    pa: centerPrice * (1 - widthPct),
    pb: centerPrice * (1 + widthPct),
  };
}

function calcRealFromLiquidity(liquidity, price, pa, pb) {
  const sqrtP = Math.sqrt(price);
  const sqrtPa = Math.sqrt(pa);
  const sqrtPb = Math.sqrt(pb);

  if (sqrtP <= sqrtPa) {
    return {
      x: liquidity * ((1 / sqrtPa) - (1 / sqrtPb)),
      y: 0,
    };
  }

  if (sqrtP >= sqrtPb) {
    return {
      x: 0,
      y: liquidity * (sqrtPb - sqrtPa),
    };
  }

  return {
    x: liquidity * ((1 / sqrtP) - (1 / sqrtPb)),
    y: liquidity * (sqrtP - sqrtPa),
  };
}

function calcLiquidityFromReal(x, y, price, pa, pb) {
  const sqrtP = Math.sqrt(price);
  const sqrtPa = Math.sqrt(pa);
  const sqrtPb = Math.sqrt(pb);

  const lx = ((1 / sqrtP) - (1 / sqrtPb)) > 0 ? x / ((1 / sqrtP) - (1 / sqrtPb)) : 0;
  const ly = (sqrtP - sqrtPa) > 0 ? y / (sqrtP - sqrtPa) : 0;

  if (lx > 0 && ly > 0) return Math.min(lx, ly);
  return Math.max(lx, ly, 0);
}

function getMode(hourlyVolume, lookbackVolumes, sigmaThreshold) {
  if (!lookbackVolumes.length) {
    return { mode: 'MID', meanVolume: hourlyVolume, stdVolume: 0 };
  }

  const meanVolume = mean(lookbackVolumes);
  const stdVolume = stdDev(lookbackVolumes, meanVolume);
  const sigmaBand = sigmaThreshold * stdVolume;

  if (hourlyVolume < (meanVolume - sigmaBand)) {
    return { mode: 'LOW', meanVolume, stdVolume };
  }

  if (hourlyVolume > (meanVolume + sigmaBand)) {
    return { mode: 'HIGH', meanVolume, stdVolume };
  }

  return { mode: 'MID', meanVolume, stdVolume };
}

export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);
  if (!asset1.length || !asset2.length) {
    return { error: 'Both CSV files must include valid date, close, and volume columns.' };
  }

  const merged = mergeRows(asset1, asset2);
  if (!merged.length) {
    return { error: 'No overlapping dates were found in the datasets.' };
  }

  const hourly = toHourlyBuckets(merged);
  if (hourly.length < 2) {
    return { error: 'Need at least two hourly buckets after preprocessing.' };
  }

  const lowWidth = (Number(config.lowWidth ?? 0.75) / 100);
  const midWidth = (Number(config.midWidth ?? 2) / 100);
  const highWidth = (Number(config.highWidth ?? 5) / 100);
  const sigmaThreshold = Number(config.sigmaThreshold ?? 1);
  const lookbackHours = Math.max(5, Number(config.lookbackHours ?? 24));
  const pauseHighVol = Boolean(config.pauseHighVol ?? false);
  const fee = 0.003;

  const first = hourly[0];
  const p1Init = first.close1;
  const p2Init = first.close2;
  const priceInit = p1Init / p2Init;

  let rx = floorUnits((realCapital / 2) / p1Init);
  let ry = floorUnits((realCapital / 2) / p2Init);
  const rxInit = rx;
  const ryInit = ry;

  let poolCash = 0;
  let centerPrice = priceInit;
  let mode = 'MID';
  let widthPct = midWidth;

  let { pa, pb } = calcRangeBounds(centerPrice, widthPct);
  let liquidity = calcLiquidityFromReal(rx, ry, centerPrice, pa, pb);

  const modeStats = { LOW: 0, MID: 0, HIGH: 0 };
  const swapRecords = [];

  for (let index = 1; index < hourly.length; index += 1) {
    const row = hourly[index];
    const price = row.close1 / row.close2;
    const lookback = hourly.slice(Math.max(0, index - lookbackHours), index).map((entry) => entry.hourlyVolume);
    const modeInfo = getMode(row.hourlyVolume, lookback, sigmaThreshold);
    mode = modeInfo.mode;
    modeStats[mode] += 1;

    widthPct = mode === 'LOW' ? lowWidth : mode === 'HIGH' ? highWidth : midWidth;

    const driftPct = Math.abs(price / centerPrice - 1);
    const recenterTrigger = driftPct >= (0.75 * widthPct);

    if (recenterTrigger && !(pauseHighVol && mode === 'HIGH')) {
      const held = calcRealFromLiquidity(liquidity, price, pa, pb);
      const currentX = floorUnits(held.x);
      const currentY = floorUnits(held.y);

      const totalValue = (currentX * row.close1) + (currentY * row.close2);
      const targetX = floorUnits((totalValue / 2) / row.close1);
      const targetY = floorUnits((totalValue / 2) / row.close2);

      let dx = 0;
      let dy = 0;
      let action = 'Re-center';
      let tradeFee = 0;
      let netProfit = 0;
      let didTrade = false;

      if (currentX > targetX) {
        dx = currentX - targetX;
        const grossRevenue = dx * row.close1;
        tradeFee = grossRevenue * fee;
        const spendable = grossRevenue - tradeFee;
        dy = floorUnits(spendable / row.close2);
        const cost = dy * row.close2;
        netProfit = grossRevenue - cost - tradeFee;
        if (dy >= 1 && netProfit > 0) {
          rx = currentX - dx;
          ry = currentY + dy;
          action = 'Re-center: Sell Asset 1 / Buy Asset 2';
          didTrade = true;
        }
      } else if (currentY > targetY) {
        dy = currentY - targetY;
        const grossRevenue = dy * row.close2;
        tradeFee = grossRevenue * fee;
        const spendable = grossRevenue - tradeFee;
        dx = floorUnits(spendable / row.close1);
        const cost = dx * row.close1;
        netProfit = grossRevenue - cost - tradeFee;
        if (dx >= 1 && netProfit > 0) {
          rx = currentX + dx;
          ry = currentY - dy;
          action = 'Re-center: Buy Asset 1 / Sell Asset 2';
          didTrade = true;
        }
      } else {
        rx = currentX;
        ry = currentY;
      }

      if (didTrade) {
        poolCash += netProfit;
        swapRecords.push({
          date: row.date.toISOString(),
          mode,
          action,
          asset1Price: row.close1,
          asset2Price: row.close2,
          asset1Swapped: dx,
          asset2Swapped: dy,
          brokeragePaid: tradeFee,
          netProfitInr: netProfit,
          accumulatedCash: poolCash,
          realAsset1Balance: rx,
          realAsset2Balance: ry,
        });
      }

      centerPrice = price;
      ({ pa, pb } = calcRangeBounds(centerPrice, widthPct));
      liquidity = calcLiquidityFromReal(rx, ry, centerPrice, pa, pb);
    }
  }

  const last = hourly[hourly.length - 1];
  const holdValue = (rxInit * last.close1) + (ryInit * last.close2);
  const poolAssetValue = (rx * last.close1) + (ry * last.close2);
  const impermanentLossInr = poolAssetValue - holdValue;
  const impermanentLossPct = holdValue > 0 ? ((poolAssetValue / holdValue) - 1) * 100 : 0;
  const totalFinalValue = poolAssetValue + poolCash;
  const initialCapital = (rxInit * p1Init) + (ryInit * p2Init);
  const totalRoiPct = initialCapital > 0 ? ((totalFinalValue / initialCapital) - 1) * 100 : 0;

  return {
    swaps: swapRecords,
    results: {
      totalSwaps: swapRecords.length,
      poolCash,
      holdValue,
      poolAssetValue,
      totalFinalValue,
      impermanentLossInr,
      impermanentLossPct,
      totalRoiPct,
      initialCapital,
      initialAsset1Units: rxInit,
      initialAsset2Units: ryInit,
      finalAsset1Units: rx,
      finalAsset2Units: ry,
      lowModeHours: modeStats.LOW,
      midModeHours: modeStats.MID,
      highModeHours: modeStats.HIGH,
      lookbackHours,
    },
  };
}
