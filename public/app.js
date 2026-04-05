import { parseCsv, runAlmSimulation } from './simulation-core.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = { swaps: [], results: null, equity: [] };

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const asset1File          = $('asset1File');
const asset2File          = $('asset2File');
const asset1FileName      = $('asset1FileName');
const asset2FileName      = $('asset2FileName');
const asset1Label         = $('asset1Label');
const asset2Label         = $('asset2Label');
const realCapitalInput    = $('realCapital');
const feePctInput         = $('feePct');
const lowWidthInput       = $('lowWidth');
const midWidthInput       = $('midWidth');
const highWidthInput      = $('highWidth');
const sigmaThreshInput    = $('sigmaThreshold');
const lookbackHInput      = $('lookbackHours');
const corrLBInput         = $('corrLookbackHours');
const corrImpactInput     = $('correlationImpact');
const recenterTrigInput   = $('recenterTriggerPct');
const pauseHighInput      = $('pauseHighVol');
const ilStopLossInput     = $('ilStopLossPct');
const runBtn              = $('runSimulation');
const statusBanner        = $('statusBanner');
const metricsGrid         = $('metricsGrid');
const swapTableContainer  = $('swapTableContainer');
const downloadCsvBtn      = $('downloadCsv');
const swapCount           = $('swapCount');
const pairHeading         = $('pairHeading');
const chartCanvas         = $('equityChart');
const corrChartCanvas     = $('corrChart');
const ilBanner            = $('ilBanner');

// ─── Formatters ───────────────────────────────────────────────────────────────
const inr  = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const pct  = (v, d = 2) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
const num  = (d = 2)    => new Intl.NumberFormat('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

// ─── Events ───────────────────────────────────────────────────────────────────
asset1File.addEventListener('change', () => { asset1FileName.textContent = asset1File.files[0]?.name || 'Upload Asset 1 CSV'; });
asset2File.addEventListener('change', () => { asset2FileName.textContent = asset2File.files[0]?.name || 'Upload Asset 2 CSV'; });
asset1Label.addEventListener('input', updatePairHeading);
asset2Label.addEventListener('input', updatePairHeading);
downloadCsvBtn.addEventListener('click', () => downloadCsv(state.swaps));
runBtn.addEventListener('click', handleRun);
updatePairHeading();

function updatePairHeading() {
  pairHeading.textContent = `${asset1Label.value || 'Asset 1'} ↔ ${asset2Label.value || 'Asset 2'}`;
}

function setStatus(type, msg) {
  statusBanner.className = `status-banner ${type}`;
  statusBanner.innerHTML = `<strong>${type.toUpperCase()}:</strong> <span>${msg}</span>`;
}

function getConfig() {
  return {
    feePct:             Number(feePctInput.value),
    lowWidth:           Number(lowWidthInput.value),
    midWidth:           Number(midWidthInput.value),
    highWidth:          Number(highWidthInput.value),
    sigmaThreshold:     Number(sigmaThreshInput.value),
    lookbackHours:      Number(lookbackHInput.value),
    corrLookbackHours:  Number(corrLBInput.value),
    correlationImpact:  Number(corrImpactInput.value),
    recenterTriggerPct: Number(recenterTrigInput.value),
    pauseHighVol:       pauseHighInput.checked,
    ilStopLossPct:      Number(ilStopLossInput.value),
  };
}

// ─── Run ──────────────────────────────────────────────────────────────────────
async function handleRun() {
  if (!asset1File.files[0] || !asset2File.files[0]) {
    setStatus('error', 'Please upload both CSV files first.'); return;
  }
  runBtn.disabled = true;
  runBtn.textContent = 'Running…';
  ilBanner.classList.add('hidden');
  setStatus('info', 'Merging 1-minute data → hourly → AMM simulation…');

  try {
    await new Promise((r) => setTimeout(r, 10));
    const [t1, t2] = await Promise.all([asset1File.files[0].text(), asset2File.files[0].text()]);
    const result = runAlmSimulation(
      parseCsv(t1), parseCsv(t2),
      Number(realCapitalInput.value),
      getConfig(),
    );

    if (result.error) {
      state.swaps = []; state.results = null; state.equity = [];
      renderMetrics(); renderTable(); destroyCharts();
      setStatus('error', result.error);
    } else {
      state.swaps   = result.swaps;
      state.results = result.results;
      state.equity  = result.equityCurve;
      renderMetrics();
      renderTable();
      renderCharts();
      renderIlBanner();

      const r = result.results;
      if (r.totalValue > r.holdValue) {
        setStatus('success',
          `AMM outperformed buy-and-hold by ${inr.format(r.totalValue - r.holdValue)}. ` +
          `Cash profit: ${inr.format(r.cashProfit)} | Brokerage paid: ${inr.format(r.totalBrokerage)} | IL: ${r.ilPct.toFixed(2)}%`
        );
      } else {
        setStatus('warning',
          `Underperformed hold by ${inr.format(r.holdValue - r.totalValue)}. ` +
          `IL (${r.ilPct.toFixed(2)}%) outweighed cash profit (${inr.format(r.cashProfit)}). ` +
          `Try wider ranges or reduce brokerage impact.`
        );
      }
    }
  } catch (err) {
    setStatus('error', err.message || 'Unable to parse CSV files.');
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = '▶ Run Simulation';
  }
}

// ─── IL Banner ────────────────────────────────────────────────────────────────
function renderIlBanner() {
  const r = state.results;
  if (!r) return;
  if (r.ilHalted) {
    ilBanner.className = 'il-banner halted';
    ilBanner.innerHTML = `
      <span class="il-icon">⛔</span>
      <div>
        <strong>IL Stop-Loss Triggered</strong>
        <span>Swapping halted at ${new Date(r.ilHaltedAt).toLocaleString('en-IN')} — 
        impermanent loss exceeded −${Number(ilStopLossInput.value).toFixed(1)}% threshold.</span>
      </div>`;
    ilBanner.classList.remove('hidden');
  } else {
    ilBanner.classList.add('hidden');
  }
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
function renderMetrics() {
  if (!state.results) {
    metricsGrid.innerHTML = `<div class="empty-state"><h3>No results yet</h3><p>Upload two 1-minute CSV files and run the simulation.</p></div>`;
    downloadCsvBtn.classList.add('hidden');
    return;
  }
  const r  = state.results;
  const a1 = asset1Label.value || 'Asset 1';
  const a2 = asset2Label.value || 'Asset 2';

  // ── Explain the P&L breakdown ──────────────────────────────────────────────
  // Total AMM Value  = Pool Asset Value  +  Cash Profit
  // Pool Asset Value = current market value of (poolX, poolY)
  // Cash Profit      = sum of all net profits from buy-low/sell-high swaps
  // IL               = Pool Asset Value  −  Hold Value  (negative = IL loss)
  // Brokerage        = 0.3% on each swap's total notional (cost, not profit)

  const cards = [
    // Capital
    { group: 'capital', label: 'Initial Capital',                value: inr.format(r.initCapital),      delta: null },
    { group: 'capital', label: 'Total AMM Value (Assets + Cash)',value: inr.format(r.totalValue),       delta: pct(r.roiPct),          positive: r.roiPct >= 0 },
    { group: 'capital', label: 'Buy-and-Hold Value',             value: inr.format(r.holdValue),        delta: pct(r.holdRoiPct),      positive: r.holdRoiPct >= 0 },
    // P&L breakdown
    { group: 'pnl',     label: 'Cash Profit from Swaps',         value: inr.format(r.cashProfit),       delta: pct(r.cashRoiPct),      positive: r.cashProfit >= 0 },
    { group: 'pnl',     label: 'Total Brokerage Paid (0.3%)',    value: inr.format(r.totalBrokerage),   delta: pct(-r.brokerageRoiPct),positive: false },
    { group: 'pnl',     label: 'Pool Asset Value (no cash)',      value: inr.format(r.poolAssets),       delta: null },
    { group: 'pnl',     label: 'Impermanent Loss',               value: inr.format(r.ilINR),            delta: pct(r.ilPct),           positive: r.ilPct >= 0 },
    // Trades
    { group: 'trades',  label: 'Total Swaps Executed',           value: num(0).format(r.totalSwaps),    delta: null },
    { group: 'trades',  label: 'Recenter Count',                 value: num(0).format(r.recenterCount), delta: null },
    { group: 'trades',  label: 'IL Stop-Loss Hit',               value: r.ilHalted ? '⛔ Yes' : '✅ No', delta: null },
    // Inventory
    { group: 'inv',     label: `Initial ${a1} Units`,            value: num(4).format(r.initialX),      delta: null },
    { group: 'inv',     label: `Initial ${a2} Units`,            value: num(4).format(r.initialY),      delta: null },
    { group: 'inv',     label: `Final ${a1} Units`,              value: num(4).format(r.finalX),        delta: null },
    { group: 'inv',     label: `Final ${a2} Units`,              value: num(4).format(r.finalY),        delta: null },
    // Modes
    { group: 'mode',    label: 'Mode Hours  LOW / MID / HIGH',   value: `${r.lowModeHours} / ${r.midModeHours} / ${r.highModeHours}`, delta: null },
    { group: 'mode',    label: 'Brokerage Rate',                 value: `${r.feePct.toFixed(2)}%`,      delta: null },
  ];

  metricsGrid.innerHTML = cards.map(({ label, value, delta, positive }) => `
    <div class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      ${delta !== null ? `<em class="${positive ? 'positive' : 'negative'}">${delta}</em>` : ''}
    </div>`).join('');

  downloadCsvBtn.classList.remove('hidden');
}

// ─── Charts ───────────────────────────────────────────────────────────────────
let chartState = [];

function destroyCharts() { chartState = []; }

function renderCharts() {
  destroyCharts();
  if (!state.equity.length) return;

  const data  = state.equity;
  const step  = Math.max(1, Math.floor(data.length / 500));
  const s     = data.filter((_, i) => i % step === 0);

  drawLineChart(chartCanvas, s, [
    { key: 'poolValue',  label: 'AMM Total Value',  color: '#38bdf8' },
    { key: 'holdValue',  label: 'Buy-and-Hold',     color: '#818cf8' },
    { key: 'cashProfit', label: 'Cash Profit',      color: '#22c55e' },
  ], '₹ Value');

  drawLineChart(corrChartCanvas, s, [
    { key: 'correlation',     label: 'Rolling Correlation', color: '#f97316' },
    { key: 'dynamicWidthPct', label: 'Dynamic Width % (÷100)', color: '#a78bfa', scale: 0.01 },
    { key: 'ilPct',           label: 'IL %',                color: '#f43f5e', scale: 0.01 },
  ], 'Ratio (−1 to +1)');
}

function drawLineChart(canvas, data, series, yLabel) {
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const P = { t: 28, r: 16, b: 48, l: 84 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;

  ctx.clearRect(0, 0, W, H);

  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const sc = s.scale ?? 1;
    for (const d of data) {
      const v = d[s.key] * sc;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yRange = yMax - yMin;

  const toX = (i) => P.l + (i / (data.length - 1)) * cW;
  const toY = (v) => P.t + cH - ((v - yMin) / yRange) * cH;

  // Grid
  for (let g = 0; g <= 5; g++) {
    const yv = yMin + (g / 5) * yRange;
    const yp = toY(yv);
    ctx.strokeStyle = 'rgba(148,163,184,0.1)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l + cW, yp); ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,0.65)'; ctx.font = '10px Arial'; ctx.textAlign = 'right';
    const lbl = Math.abs(yRange) > 50000 ? `₹${(yv / 1e5).toFixed(1)}L` : yv.toFixed(3);
    ctx.fillText(lbl, P.l - 5, yp + 3.5);
  }

  // X labels
  const steps = Math.min(6, data.length);
  for (let s = 0; s <= steps; s++) {
    const i  = Math.round((s / steps) * (data.length - 1));
    const xp = toX(i);
    ctx.fillStyle = 'rgba(148,163,184,0.65)'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
    const d = new Date(data[i].date);
    ctx.fillText(d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }), xp, H - P.b + 14);
  }

  // Y label
  ctx.save(); ctx.translate(13, P.t + cH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(148,163,184,0.65)'; ctx.font = '11px Arial'; ctx.textAlign = 'center';
  ctx.fillText(yLabel, 0, 0); ctx.restore();

  // IL halt shading
  const haltStart = data.findIndex((d) => d.halted);
  if (haltStart >= 0) {
    ctx.fillStyle = 'rgba(244,63,94,0.08)';
    ctx.fillRect(toX(haltStart), P.t, toX(data.length - 1) - toX(haltStart), cH);
    ctx.strokeStyle = 'rgba(244,63,94,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(toX(haltStart), P.t); ctx.lineTo(toX(haltStart), P.t + cH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(244,63,94,0.7)'; ctx.font = '10px Arial'; ctx.textAlign = 'left';
    ctx.fillText('IL halt', toX(haltStart) + 4, P.t + 12);
  }

  // Series lines
  for (const s of series) {
    const sc = s.scale ?? 1;
    ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    data.forEach((d, i) => { const x = toX(i), y = toY(d[s.key] * sc); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
  }

  // Legend
  let lx = P.l;
  for (const s of series) {
    ctx.fillStyle = s.color; ctx.fillRect(lx, 8, 16, 3);
    ctx.fillStyle = 'rgba(148,163,184,0.85)'; ctx.font = '10px Arial'; ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 20, 14);
    lx += ctx.measureText(s.label).width + 38;
  }
}

// ─── Swap table ───────────────────────────────────────────────────────────────
function renderTable() {
  if (!state.swaps.length) {
    swapCount.classList.add('hidden');
    swapTableContainer.innerHTML = `<div class="empty-state compact"><h3>No profitable swaps executed</h3><p>Adjust range widths or capital and run again.</p></div>`;
    return;
  }
  const a1 = asset1Label.value || 'Asset 1';
  const a2 = asset2Label.value || 'Asset 2';
  swapCount.textContent = `${state.swaps.length} swaps`;
  swapCount.classList.remove('hidden');

  const rows = state.swaps.slice(-500);
  const note = state.swaps.length > 500
    ? `<p class="table-note">Showing last 500 of ${state.swaps.length} swaps. Download CSV for full history.</p>` : '';

  swapTableContainer.innerHTML = note + `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Date / Time</th>
            <th>Mode</th>
            <th>Corr</th>
            <th>Width%</th>
            <th>Recenter</th>
            <th>Action</th>
            <th>Bought</th>
            <th>Qty Bought</th>
            <th>Cost (₹)</th>
            <th>Sold</th>
            <th>Qty Sold</th>
            <th>Revenue (₹)</th>
            <th>Gross Profit</th>
            <th>Brokerage</th>
            <th>Net Profit</th>
            <th>Cash Accum.</th>
            <th>${a1} Units</th>
            <th>${a2} Units</th>
            <th>IL%</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((s) => `
            <tr class="${s.recentered ? 'recenter-row' : ''}">
              <td>${new Date(s.date).toLocaleString('en-IN')}</td>
              <td><span class="mode-pill mode-${s.mode.toLowerCase()}">${s.mode}</span></td>
              <td>${s.rollingCorrelation.toFixed(3)}</td>
              <td>${s.dynamicWidthPct.toFixed(2)}%</td>
              <td>${s.recentered ? '<span class="pill-sm">↺</span>' : '—'}</td>
              <td>${s.action}</td>
              <td>${s.boughtAsset}</td>
              <td>${num(4).format(s.boughtQty)}</td>
              <td class="negative">${inr.format(s.boughtCost)}</td>
              <td>${s.soldAsset}</td>
              <td>${num(4).format(s.soldQty)}</td>
              <td>${inr.format(s.soldRevenue)}</td>
              <td class="${s.grossProfit >= 0 ? 'positive' : 'negative'}">${inr.format(s.grossProfit)}</td>
              <td class="negative">${inr.format(s.brokerage)}</td>
              <td class="${s.netProfit >= 0 ? 'positive' : 'negative'}">${inr.format(s.netProfit)}</td>
              <td>${inr.format(s.cashProfit)}</td>
              <td>${num(4).format(s.poolX)}</td>
              <td>${num(4).format(s.poolY)}</td>
              <td class="${s.ilPct >= 0 ? 'positive' : 'negative'}">${s.ilPct.toFixed(2)}%</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Download CSV ─────────────────────────────────────────────────────────────
function downloadCsv(rows) {
  const headers = [
    'Date','Mode','Rolling_Correlation','Dynamic_Width_Pct','Recentered','Action',
    'Bought_Asset','Bought_Qty','Bought_Cost_INR',
    'Sold_Asset','Sold_Qty','Sold_Revenue_INR',
    'Gross_Profit_INR','Brokerage_INR','Net_Profit_INR','Cash_Accum_INR',
    'Asset1_Price','Asset2_Price','Price_Ratio','Center_Ratio',
    'Pool_Asset1_Units','Pool_Asset2_Units',
    'Pool_Asset_Value_INR','IL_INR','IL_Pct','Total_Value_INR',
  ];
  const lines = [headers.join(',')].concat(rows.map((r) => [
    r.date, r.mode, r.rollingCorrelation.toFixed(6), r.dynamicWidthPct.toFixed(4), r.recentered,
    `"${r.action}"`, r.boughtAsset, r.boughtQty.toFixed(6), r.boughtCost.toFixed(2),
    r.soldAsset,   r.soldQty.toFixed(6),   r.soldRevenue.toFixed(2),
    r.grossProfit.toFixed(2), r.brokerage.toFixed(2), r.netProfit.toFixed(2), r.cashProfit.toFixed(2),
    r.asset1Price, r.asset2Price, r.priceRatio.toFixed(6), r.centerRatio.toFixed(6),
    r.poolX.toFixed(6), r.poolY.toFixed(6),
    r.poolAssetValue.toFixed(2), r.ilINR.toFixed(2), r.ilPct.toFixed(4), r.totalValue.toFixed(2),
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'amm_swaps.csv'; a.click();
  URL.revokeObjectURL(url);
}
