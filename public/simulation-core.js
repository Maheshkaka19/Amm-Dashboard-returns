// --- UTILITY FUNCTIONS ---
export function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'; i += 1;
      } else { quoted = !quoted; }
    } else if (char === ',' && !quoted) {
      cells.push(current); current = '';
    } else { current += char; }
  }
  cells.push(current);
  return cells;
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((v) => v.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = (cells[index] || '').trim();
      return row;
    }, {});
  });
}

export function normalizeRows(rows) {
  return rows.map((row) => ({
    date: new Date(row.date),
    close: Number(String(row.close).replace(/,/g, '')),
    volume: Number(String(row.volume).replace(/,/g, '')),
  })).filter((row) => !Number.isNaN(row.date.getTime()) && row.close > 0)
     .sort((a, b) => a.date - b.date);
}

// --- QUANT MATH ---
const safeSqrt = (val) => Math.sqrt(Math.max(0, val));

function calculateLiquidity(x, y, P, Pa, Pb) {
  if (P <= Pa) return x * (safeSqrt(P) * safeSqrt(Pb)) / (safeSqrt(Pb) - safeSqrt(P));
  if (P >= Pb) return y / (safeSqrt(P) - safeSqrt(Pa));
  
  const Lx = x * (safeSqrt(P) * safeSqrt(Pb)) / (safeSqrt(Pb) - safeSqrt(P));
  const Ly = y / (safeSqrt(P) - safeSqrt(Pa));
  return Math.min(Lx, Ly);
}

// --- SIMULATION ENGINE ---
export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  const asset1 = normalizeRows(df1);
  const asset2 = normalizeRows(df2);
  if (!asset1.length || !asset2.length) return { error: 'Invalid CSV Data.' };

  const merged = [];
  let i = 0, j = 0;
  while (i < asset1.length && j < asset2.length) {
    if (asset1[i].date.getTime() === asset2[j].date.getTime()) {
      merged.push({ date: asset1[i].date, c1: asset1[i].close, c2: asset2[j].close, v: asset1[i].volume + asset2[j].volume });
      i++; j++;
    } else if (asset1[i].date < asset2[j].date) { i++; } else { j++; }
  }

  // Settings
  const width = (Number(config.midWidth ?? 2.0) / 100);
  const feeRate = 0.003; // 0.3% flat
  const recenterThreshold = 0.80; // Recenter when 80% through range

  // Init State (50:50 Split)
  let rx = (realCapital * 0.5) / merged[0].c1;
  let ry = (realCapital * 0.5) / merged[0].c2;
  const rxInit = rx, ryInit = ry;

  let poolCash = 0;
  let recenterCount = 0;
  const swapRecords = [];

  // Range setup (Geometric Mean Anchoring)
  let Pc = merged[0].c1 / merged[0].c2;
  let Pa = Pc * (1 - width);
  let Pb = Pc / (1 - width); // Ensures Pc = sqrt(Pa * Pb)
  let L = calculateLiquidity(rx, ry, Pc, Pa, Pb);

  for (let idx = 1; idx < merged.length; idx++) {
    const row = merged[idx];
    const P = row.c1 / row.c2;

    // Check for Range Exit (Recenter)
    const drift = P > Pc ? (P - Pc) / (Pb - Pc) : (Pc - P) / (Pc - Pa);
    
    if (drift >= recenterThreshold || P <= Pa || P >= Pb) {
      const currentVal = (rx * row.c1) + (ry * row.c2);
      const rebalCost = currentVal * feeRate;
      
      poolCash -= rebalCost;
      rx = (currentVal * 0.5) / row.c1;
      ry = (currentVal * 0.5) / row.c2;
      
      Pc = P;
      Pa = Pc * (1 - width);
      Pb = Pc / (1 - width);
      L = calculateLiquidity(rx, ry, Pc, Pa, Pb);
      recenterCount++;
      continue;
    }

    // Standard V3 Harvesting
    const targetRx = L * (safeSqrt(Pb) - safeSqrt(P)) / (safeSqrt(P) * safeSqrt(Pb));
    const targetRy = L * (safeSqrt(P) - safeSqrt(Pa));

    const dx = rx - targetRx;
    const dy = targetRy - ry;

    if (Math.abs(dx) > 1 && Math.abs(dy) > 1) {
      const revenue = dx > 0 ? dx * row.c1 : dy * row.c2;
      const cost = dx > 0 ? dy * row.c2 : Math.abs(dx) * row.c1;
      const tradeFee = revenue * feeRate;
      const profit = revenue - cost - tradeFee;

      if (profit > 0) {
        rx = targetRx; ry = targetRy; poolCash += profit;
        swapRecords.push({ date: row.date.toISOString(), profit, cash: poolCash });
      }
    }
  }

  const last = merged[merged.length - 1];
  const finalAssetVal = (rx * last.c1) + (ry * last.c2);
  const holdVal = (rxInit * last.c1) + (ryInit * last.c2);
  
  return {
    results: {
      totalSwaps: swapRecords.length,
      recenterCount,
      initialCapital: realCapital,
      finalValue: finalAssetVal + poolCash,
      holdValue: holdVal,
      netAlpha: (finalAssetVal + poolCash) - holdVal,
      ilInr: finalAssetVal - holdVal,
      roi: (((finalAssetVal + poolCash) / realCapital) - 1) * 100
    },
    swaps: swapRecords
  };
}
