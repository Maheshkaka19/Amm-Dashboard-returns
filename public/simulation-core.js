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

  // 1. Initial State Math
  const p1Init = merged[0].close1;
  const p2Init = merged[0].close2;
  
  // Create the absolute mathematical anchor
  const xInit = virtualCapital / p1Init;
  const yInit = virtualCapital / p2Init;
  const invariant = xInit * yInit; 
  
  const rxInit = floorUnits(realCapital / p1Init);
  const ryInit = floorUnits(realCapital / p2Init);
  
  // 2. Concentrated Liquidity Offsets (Crucial Fix)
  // These offsets forever bind the real inventory to the virtual curve.
  const xOff = xInit - rxInit;
  const yOff = yInit - ryInit;
  
  let rx = rxInit;
  let ry = ryInit;
  let poolCash = 0;
  const swapRecords = [];

  for (let index = 1; index < merged.length; index += 1) {
    const row = merged[index];
    const marketRatio = row.close1 / row.close2;
    
    // 3. Absolute Anchored Target Virtual State
    const xPrime = Math.sqrt(invariant / marketRatio);
    const yPrime = Math.sqrt(invariant * marketRatio);
    
    // 4. Target Real State (What the pool SHOULD hold right now)
    const targetRx = xPrime - xOff;
    const targetRy = yPrime - yOff;

    let dx = 0;
    let dy = 0;
    let tradeExecuted = false;
    let netProfit = 0;
    let tradeFee = 0;
    let action = '';

    if (rx > targetRx && targetRy > ry) {
      // We have excess Asset 1 compared to the curve: Sell Asset 1, Buy Asset 2
      const idealDx = rx - targetRx;
      const idealDy = targetRy - ry;

      dx = floorUnits(idealDx);
      dy = floorUnits(idealDy);
      
      // Inventory protection constraint
      dx = Math.min(dx, rx);

      if (dx >= 1 && dy >= 1) {
        const revenue = dx * row.close1;
        const cost = dy * row.close2;
        tradeFee = revenue * fee;
        netProfit = revenue - cost - tradeFee;

        // Only trade if the arbitrage covers the slippage and fee
        if (netProfit > 0) {
          rx -= dx;
          ry += dy;
          action = 'Sell Asset 1 / Buy Asset 2';
          tradeExecuted = true;
          // Notice: We NO LONGER update the virtual curve. It stays perfectly anchored.
        }
      }
    } else if (rx < targetRx && targetRy < ry) {
      // We have excess Asset 2 compared to the curve: Buy Asset 1, Sell Asset 2
      const idealDx = targetRx - rx;
      const idealDy = ry - targetRy;

      dx = floorUnits(idealDx);
      dy = floorUnits(idealDy);
      
      // Inventory protection constraint
      dy = Math.min(dy, ry);

      if (dx >= 1 && dy >= 1) {
        const revenue = dy * row.close2;
        const cost = dx * row.close1;
        tradeFee = revenue * fee;
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
  
  // Total value now accurately reflects the sum of remaining stocks AND accumulated arbitrage cash
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
