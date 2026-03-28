/** * ESSENCE AMM ENGINE v3.2 - PRODUCTION GRADE
 * Focus: Uniswap v3 Math, Dynamic Concentration, & Friction
 */

// --- 1. ROBUST DATA SANITIZATION ---
const cleanNum = (val) => {
  if (val === null || val === undefined) return 0;
  // Removes commas, currency symbols, and spaces, then forces to Number
  const n = parseFloat(String(val).replace(/[^0-9.-]+/g, ""));
  return isNaN(n) ? 0 : n;
};

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    return headers.reduce((row, header, i) => {
      row[header] = cells[i] ? cells[i].trim() : "";
      return row;
    }, {});
  });
}

// --- 2. QUANT MATH HELPERS ---
const safeSqrt = (n) => Math.sqrt(Math.max(0, n));

// Calculates Liquidity (L) for a given capital split
function getLiquidity(x, y, P, Pa, Pb) {
  const sp = safeSqrt(P), sa = safeSqrt(Pa), sb = safeSqrt(Pb);
  if (P <= Pa) return x * (sa * sb) / (sb - sa);
  if (P >= Pb) return y / (sb - sa);
  const Lx = x * (sp * sb) / (sb - sp);
  const Ly = y / (sp - sa);
  return Math.min(Lx, Ly);
}

// --- 3. THE CORE SIMULATOR ---
export function runAlmSimulation(df1, df2, realCapital, config = {}) {
  // A. Data Normalization & Alignment
  const a1 = df1.map(r => ({ d: new Date(r.date).getTime(), c: cleanNum(r.close), v: cleanNum(r.volume) })).filter(r => r.c > 0);
  const a2 = df2.map(r => ({ d: new Date(r.date).getTime(), c: cleanNum(r.close), v: cleanNum(r.volume) })).filter(r => r.c > 0);

  const merged = [];
  let i = 0, j = 0;
  while (i < a1.length && j < a2.length) {
    if (a1[i].d === a2[j].d) {
      merged.push({ date: new Date(a1[i].d), c1: a1[i].c, c2: a2[j].c, vol: a1[i].v + a2[j].v });
      i++; j++;
    } else if (a1[i].d < a2[j].d) { i++; } else { j++; }
  }

  if (merged.length < 5) return { error: "Insufficient overlapping data found in CSVs." };

  // B. Config & Parameters
  const capital = cleanNum(realCapital) || 100000;
  const rangeWidth = (cleanNum(config.midWidth) || 2.0) / 100;
  const feeRate = 0.003; // 0.3% flat STT + Brokerage
  const recenterThreshold = 0.75; // Recenter when 75% through the range

  // C. Initial State (50:50 Value Split)
  let rx = (capital * 0.5) / merged[0].c1;
  let ry = (capital * 0.5) / merged[0].c2;
  const rxInit = rx, ryInit = ry;

  let poolCash = 0;
  let recenterCount = 0;
  const swapRecords = [];

  // Initial Range Setup
  let Pc = merged[0].c1 / merged[0].c2;
  let Pa = Pc * (1 - rangeWidth);
  let Pb = Pc / (1 - rangeWidth);
  let L = getLiquidity(rx, ry, Pc, Pa, Pb);

  // D. Hourly Simulation Loop
  for (let idx = 1; idx < merged.length; idx++) {
    const row = merged[idx];
    const P = row.c1 / row.c2;

    // 1. Check for Range Exit / Recenter Trigger
    const drift = P > Pc ? (P - Pc) / (Pb - Pc) : (Pc - P) / (Pc - Pa);

    if (drift >= recenterThreshold || P <= Pa || P >= Pb) {
      const currentVal = (rx * row.c1) + (ry * row.c2);
      const rebalCost = currentVal * feeRate;
      
      poolCash -= rebalCost; // Cost of the swap to re-center
      rx = (currentVal * 0.5) / row.c1;
      ry = (currentVal * 0.5) / row.c2;
      
      Pc = P;
      Pa = Pc * (1 - rangeWidth);
      Pb = Pc / (1 - rangeWidth);
      L = getLiquidity(rx, ry, Pc, Pa, Pb);
      
      recenterCount++;
      continue;
    }

    // 2. Harvesting (Uniswap v3 Virtual Inventory Check)
    const sp = safeSqrt(P), sa = safeSqrt(Pa), sb = safeSqrt(Pb);
    const targetRx = L * (sb - sp) / (sp * sb);
    const targetRy = L * (sp - sa);

    const dx = rx - targetRx;
    const dy = targetRy - ry;

    // Execute if trade is large enough to cover the 1-unit minimum
    if (Math.abs(dx) > 0.1 && Math.abs(dy) > 0.1) {
      const revenue = dx > 0 ? dx * row.c1 : dy * row.c2;
      const cost = dx > 0 ? dy * row.c2 : Math.abs(dx) * row.c1;
      const netProfit = (revenue - cost) - (revenue * feeRate);

      if (netProfit > 0) {
        rx = targetRx;
        ry = targetRy;
        poolCash += netProfit;
        swapRecords.push({ t: row.date.toLocaleTimeString(), p: netProfit });
      }
    }
  }

  // E. Final Results
  const last = merged[merged.length - 1];
  const finalAssetVal = (rx * last.c1) + (ry * last.c2);
  const holdVal = (rxInit * last.c1) + (ryInit * last.c2);
  const totalFinal = finalAssetVal + poolCash;

  return {
    results: {
      totalSwaps: swapRecords.length,
      recenters: recenterCount,
      initialCapital: capital,
      finalValue: totalFinal.toFixed(2),
      holdValue: holdVal.toFixed(2),
      netAlpha: (totalFinal - holdVal).toFixed(2),
      roi: (((totalFinal / capital) - 1) * 100).toFixed(2)
    },
    swaps: swapRecords.slice(-50) // Last 50 for the table
  };
}
