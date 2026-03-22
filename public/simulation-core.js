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
    .map((row) => ({ date: new Date(row.date), close: Number(row.close) }))
    .filter((row) => !Number.isNaN(row.date.getTime()) && Number.isFinite(row.close))
    .sort((a, b) => a.date - b.date);
}

function floorUnits(value) {
  return Math.max(0, Math.floor(value));
}

export function runAlmSimulation(df1, df2, virtualCapital, realCapital, fee) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);
  if (!asset1.length || !asset2.length) return { error: 'Both CSV files must include valid date and close columns.' };

  const merged = [];
  let i = 0;
  let j = 0;
  while (i < asset1.length && j < asset2.length) {
    const t1 = asset1[i].date.getTime();
    const t2 = asset2[j].date.getTime();
    if (t1 === t2) {
      merged.push({ date: asset1[i].date, close1: asset1[i].close, close2: asset2[j].close });
      i += 1;
      j += 1;
    } else if (t1 < t2) {
      i += 1;
    } else {
      j += 1;
    }
  }

  if (!merged.length) return { error: 'No overlapping dates were found in the datasets.' };

  const p1Init = merged[0].close1;
  const p2Init = merged[0].close2;
  
  // Virtual Pool Initialization
  let x = virtualCapital / p1Init;
  let y = virtualCapital / p2Init;

  // Real Pool Initialization
  const rxInit = floorUnits(realCapital / p1Init);
  const ryInit = floorUnits(realCapital / p2Init);
  let rx = rxInit;
  let ry = ryInit;
  let poolCash = 0;
  const swapRecords = [];

  for (let index = 1; index < merged.length; index += 1) {
    const row = merged[index];
    const marketRatio = row.close1 / row.close2;
    const invariant = x * y;
    
    // Target Virtual State
    const xPrime = Math.sqrt(invariant / marketRatio);
    const yPrime = Math.sqrt(invariant * marketRatio);
    const rawDx = x - xPrime;
    const rawDy = yPrime - y;

    let dx = 0;
    let dy = 0;
    let tradeExecuted = false;
    let netProfit = 0;
    let tradeFee = 0;
    let action = '';

    if (rawDx > 0 && rawDy > 0) {
      // Intent: Sell Asset 1, Buy Asset 2
      // Determine what fraction of the ideal trade we can actually afford with real inventory
      const executionRatio = Math.min(1.0, rx / rawDx);
      
      // Apply the same ratio to both sides to maintain the mathematical AMM curve
      dx = floorUnits(rawDx * executionRatio);
      dy = floorUnits(rawDy * executionRatio);

      if (dx >= 1 && dy >= 1) {
        const revenue = dx * row.close1;
        const cost = dy * row.close2;
        const grossProfit = revenue - cost;
        tradeFee = revenue * fee;
        netProfit = grossProfit - tradeFee;

        if (netProfit > 0) {
          rx -= dx;
          ry += dy;
          // Update virtual curves by exact amount traded, locking them to real operations
          x -= dx; 
          y += dy;
          action = 'Sell Asset 1 / Buy Asset 2';
          tradeExecuted = true;
        }
      }
    } else if (rawDx < 0 && rawDy < 0) {
      // Intent: Buy Asset 1, Sell Asset 2
      const absRawDx = Math.abs(rawDx);
      const absRawDy = Math.abs(rawDy);
      
      // We are selling Asset 2, so cap by available ry
      const executionRatio = Math.min(1.0, ry / absRawDy);
      
      dx = floorUnits(absRawDx * executionRatio);
      dy = floorUnits(absRawDy * executionRatio);

      if (dx >= 1 && dy >= 1) {
        const revenue = dy * row.close2;
        const cost = dx * row.close1;
        const grossProfit = revenue - cost;
        tradeFee = revenue * fee;
        netProfit = grossProfit - tradeFee;

        if (netProfit > 0) {
          rx += dx;
          ry -= dy;
          // Update virtual curves by exact amount traded
          x += dx; 
          y -= dy;
          action = 'Buy Asset 1 / Sell Asset 2';
          tradeExecuted = true;
        }
      }
    }

    if (tradeExecuted) {
      poolCash += netProfit;
      swapRecords.push({
        date: row.date.toISOString(),
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
  }

  const finalP1 = merged[merged.length - 1].close1;
  const finalP2 = merged[merged.length - 1].close2;
  const holdValue = (rxInit * finalP1) + (ryInit * finalP2);
  const poolAssetValue = (rx * finalP1) + (ry * finalP2);
  const impermanentLossInr = poolAssetValue - holdValue;
  const impermanentLossPct = holdValue > 0 ? (poolAssetValue / holdValue - 1) * 100 : 0;
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
    }
  };
}
