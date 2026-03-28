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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function widthByMode(mode, lowWidth, midWidth, highWidth) {
  if (mode === 'LOW') return lowWidth;
  if (mode === 'HIGH') return highWidth;
  return midWidth;
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

  const lowWidth = Number(config.lowWidth ?? 0.75) / 100;
  const midWidth = Number(config.midWidth ?? 2) / 100;
  const highWidth = Number(config.highWidth ?? 5) / 100;
  const sigmaThreshold = Number(config.sigmaThreshold ?? 1);
  const lookbackHours = Math.max(5, Number(config.lookbackHours ?? 24));
  const corrLookback = Math.max(5, Number(config.corrLookbackHours ?? 24));
  const correlationImpact = clamp(Number(config.correlationImpact ?? 0.6), 0, 1);
  const recenterTrigger = clamp(Number(config.recenterTriggerPct ?? 75) / 100, 0.1, 1.5);
  const feeRate = Number(config.feePct ?? 0.3) / 100;
  const pauseHighVol = Boolean(config.pauseHighVol ?? false);

  const p1Init = hourly[0].close1;
  const p2Init = hourly[0].close2;
  const virtualCapital = Number(config.virtualCapital ?? (realCapital * 5));

  const xInit = virtualCapital / p1Init;
  const yInit = virtualCapital / p2Init;
  const invariant = xInit * yInit;

  let rx = floorUnits((realCapital / 2) / p1Init);
  let ry = floorUnits((realCapital / 2) / p2Init);
  const rxInit = rx;
  const ryInit = ry;

  const xOff = xInit - rxInit;
  const yOff = yInit - ryInit;

  let poolCash = 0;
  let centerRatio = p1Init / p2Init;
  let currentMode = 'MID';
  let recenterCount = 0;

  const modeHours = { LOW: 0, MID: 0, HIGH: 0 };
  const swapRecords = [];

  for (let index = 1; index < hourly.length; index += 1) {
    const row = hourly[index];
    const ratio = row.close1 / row.close2;

    const volLookback = hourly.slice(Math.max(0, index - lookbackHours), index).map((entry) => entry.hourlyVolume);
    currentMode = getMode(row.hourlyVolume, volLookback, sigmaThreshold);
    modeHours[currentMode] += 1;

    const corrWindow = hourly.slice(Math.max(0, index - corrLookback), index);
    const rollingCorr = correlation(
      corrWindow.map((entry) => entry.ret1),
      corrWindow.map((entry) => entry.ret2),
    );

    const baseWidth = widthByMode(currentMode, lowWidth, midWidth, highWidth);
    const dynamicWidth = clamp(
      baseWidth * (1 + (1 - Math.abs(rollingCorr)) * correlationImpact),
      lowWidth * 0.5,
      highWidth * 2,
    );

    const drift = Math.abs(ratio / centerRatio - 1);
    const needsRecenter = drift >= (dynamicWidth * recenterTrigger);

    if (needsRecenter && !(pauseHighVol && currentMode === 'HIGH')) {
      centerRatio = ratio;
      recenterCount += 1;
    }

    const xPrime = Math.sqrt(invariant / ratio);
    const yPrime = Math.sqrt(invariant * ratio);
    const targetRx = Math.max(0, xPrime - xOff);
    const targetRy = Math.max(0, yPrime - yOff);

    let dx = 0;
    let dy = 0;
    let tradeFee = 0;
    let netProfit = 0;
    let tradeExecuted = false;
    let action = '';

    if (rx > targetRx && targetRy > ry) {
      dx = Math.min(floorUnits(rx - targetRx), rx);
      dy = floorUnits(targetRy - ry);

      if (dx >= 1 && dy >= 1) {
        const revenue = dx * row.close1;
        const cost = dy * row.close2;
        tradeFee = revenue * feeRate;
        netProfit = revenue - cost - tradeFee;
        if (netProfit > 0) {
          rx -= dx;
          ry += dy;
          action = 'Sell Asset 1 / Buy Asset 2';
          tradeExecuted = true;
        }
      }
    } else if (rx < targetRx && targetRy < ry) {
      dx = floorUnits(targetRx - rx);
      dy = Math.min(floorUnits(ry - targetRy), ry);

      if (dx >= 1 && dy >= 1) {
        const revenue = dy * row.close2;
        const cost = dx * row.close1;
        tradeFee = revenue * feeRate;
        netProfit = revenue - cost - tradeFee;
        if (netProfit > 0) {
          rx += dx;
          ry -= dy;
          action = 'Buy Asset 1 / Sell Asset 2';
          tradeExecuted = true;
        }
      }
    }

    if (tradeExecuted) {
      poolCash += netProfit;
      swapRecords.push({
        date: row.date.toISOString(),
        mode: currentMode,
        rollingCorrelation: rollingCorr,
        dynamicWidthPct: dynamicWidth * 100,
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
        recentered: needsRecenter,
      });
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
      lowModeHours: modeHours.LOW,
      midModeHours: modeHours.MID,
      highModeHours: modeHours.HIGH,
      recenterCount,
      feePct: feeRate * 100,
      corrLookbackHours: corrLookback,
      lookbackHours,
    },
  };
}
