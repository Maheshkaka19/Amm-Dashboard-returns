import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = { swaps: [], results: null, equity: [] };
const $ = id => document.getElementById(id);

// DOM refs
const asset1File        = $('asset1File');
const asset2File        = $('asset2File');
const asset1FileName    = $('asset1FileName');
const asset2FileName    = $('asset2FileName');
const asset1Label       = $('asset1Label');
const asset2Label       = $('asset2Label');
const realCapitalInput  = $('realCapital');
const buyBrokerInput    = $('buyBrokeragePct');
const sellBrokerInput   = $('sellBrokeragePct');
const lowWidthInput     = $('lowWidth');
const midWidthInput     = $('midWidth');
const highWidthInput    = $('highWidth');
const sigmaInput        = $('sigmaThreshold');
const lookbackInput     = $('lookbackHours');
const corrLBInput       = $('corrLookbackHours');
const corrImpactInput   = $('correlationImpact');
const recTrigInput      = $('recenterTriggerPct');
const pauseHighInput    = $('pauseHighVol');
const ilStopInput       = $('ilStopLossPct');
const runBtn            = $('runSimulation');
const statusBanner      = $('statusBanner');
const metricsGrid       = $('metricsGrid');
const swapContainer     = $('swapTableContainer');
const downloadBtn       = $('downloadCsv');
const swapCount         = $('swapCount');
const pairHeading       = $('pairHeading');
const chartCanvas       = $('equityChart');
const corrCanvas        = $('corrChart');
const ilBanner          = $('ilBanner');

// Formatters
const inr  = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct  = (v, d = 2) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
const qty  = v => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(v));

// Events
asset1File.addEventListener('change', () => { asset1FileName.textContent = asset1File.files[0]?.name || 'Upload Asset 1 CSV'; });
asset2File.addEventListener('change', () => { asset2FileName.textContent = asset2File.files[0]?.name || 'Upload Asset 2 CSV'; });
asset1Label.addEventListener('input', updateHeading);
asset2Label.addEventListener('input', updateHeading);
downloadBtn.addEventListener('click', () => downloadCsv(state.swaps));
runBtn.addEventListener('click', handleRun);
updateHeading();

function updateHeading() {
  pairHeading.textContent = `${asset1Label.value || 'Asset 1'} ↔ ${asset2Label.value || 'Asset 2'}`;
}

function setStatus(type, msg) {
  statusBanner.className = `status-banner ${type}`;
  statusBanner.innerHTML = `<strong>${type.toUpperCase()}:</strong> <span>${msg}</span>`;
}

function getConfig() {
  return {
    buyBrokeragePct:    Number(buyBrokerInput.value),
    sellBrokeragePct:   Number(sellBrokerInput.value),
    lowWidth:           Number(lowWidthInput.value),
    midWidth:           Number(midWidthInput.value),
    highWidth:          Number(highWidthInput.value),
    sigmaThreshold:     Number(sigmaInput.value),
    lookbackHours:      Number(lookbackInput.value),
    corrLookbackHours:  Number(corrLBInput.value),
    correlationImpact:  Number(corrImpactInput.value),
    recenterTriggerPct: Number(recTrigInput.value),
    pauseHighVol:       pauseHighInput.checked,
    ilStopLossPct:      Number(ilStopInput.value),
  };
}

// ─── Run simulation ───────────────────────────────────────────────────────────
async function handleRun() {
  if (!asset1File.files[0] || !asset2File.files[0]) {
    setStatus('error', 'Upload both CSV files first.'); return;
  }
  runBtn.disabled = true;
  runBtn.textContent = 'Running…';
  ilBanner.classList.add('hidden');
  setStatus('info', 'Merging 1-min data → hourly buckets → running AMM simulation…');

  try {
    await new Promise(r => setTimeout(r, 10));
    const [t1, t2] = await Promise.all([asset1File.files[0].text(), asset2File.files[0].text()]);
    const result = runAlmSimulation(parseCsv(t1), parseCsv(t2), Number(realCapitalInput.value), getConfig());

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
      const vs = r.totalValue - r.holdValue;
      if (vs > 0) {
        setStatus('success',
          `AMM outperformed hold by ${inr.format(vs)} | ` +
          `Cash profit: ${inr.format(r.cashProfit)} | ` +
          `Brokerage: ${inr.format(r.totalBrokerage)} | ` +
          `IL: ${r.ilPct.toFixed(2)}%`);
      } else {
        setStatus('warning',
          `Underperformed hold by ${inr.format(-vs)} — ` +
          `IL (${r.ilPct.toFixed(2)}%) exceeded cash profit (${inr.format(r.cashProfit)}). ` +
          `Try wider ranges or higher capital.`);
      }
    }
  } catch (err) {
    setStatus('error', err.message || 'Parse error.');
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = '▶ Run Simulation';
  }
}

// ─── IL Banner ────────────────────────────────────────────────────────────────
function renderIlBanner() {
  const r = state.results;
  if (!r || !r.ilHalted) { ilBanner.classList.add('hidden'); return; }
  ilBanner.className = 'il-banner halted';
  ilBanner.innerHTML = `
    <span class="il-icon">⛔</span>
    <div>
      <strong>IL Stop-Loss Triggered</strong>
      <span>All swapping halted at ${new Date(r.ilHaltedAt).toLocaleString('en-IN')} — 
      impermanent loss exceeded −${Number(ilStopInput.value).toFixed(1)}% threshold.</span>
    </div>`;
  ilBanner.classList.remove('hidden');
}

// ─── Metrics grid ─────────────────────────────────────────────────────────────
function renderMetrics() {
  if (!state.results) {
    metricsGrid.innerHTML = `<div class="empty-state"><h3>No results yet</h3><p>Upload two 1-minute CSV files and run.</p></div>`;
    downloadBtn.classList.add('hidden');
    return;
  }
  const r  = state.results;
  const a1 = asset1Label.value || 'Asset 1';
  const a2 = asset2Label.value || 'Asset 2';

  const cards = [
    // --- Capital ---
    { section: 'Capital',   label: 'Cash Deployed',           value: inr.format(r.initCashDeployed), delta: null },
    { section: 'Capital',   label: 'Total AMM Value',         value: inr.format(r.totalValue),       delta: pct(r.roiPct),          positive: r.roiPct >= 0 },
    { section: 'Capital',   label: 'Buy-and-Hold Value',      value: inr.format(r.holdValue),        delta: pct(r.holdRoiPct),      positive: r.holdRoiPct >= 0 },
    { section: 'Capital',   label: 'Pool Asset Value',        value: inr.format(r.poolAssets),       delta: null },
    // --- P&L ---
    { section: 'P&L',       label: 'Cash Profit (Swaps)',     value: inr.format(r.cashProfit),       delta: pct(r.cashRoiPct),      positive: r.cashProfit >= 0 },
    { section: 'P&L',       label: 'Brokerage Paid (total)',  value: inr.format(r.totalBrokerage),   delta: pct(-r.brokerageRoiPct),positive: false },
    { section: 'P&L',       label: 'Impermanent Loss',        value: inr.format(r.ilINR),            delta: pct(r.ilPct),           positive: r.ilPct >= 0 },
    { section: 'P&L',       label: 'AMM vs Hold',             value: inr.format(r.totalValue - r.holdValue), delta: pct(r.roiPct - r.holdRoiPct), positive: r.totalValue >= r.holdValue },
    // --- Trades ---
    { section: 'Trades',    label: 'Regular Swaps',           value: r.totalSwaps.toLocaleString('en-IN'), delta: null },
    { section: 'Trades',    label: 'Recenter Trades',         value: r.recenterTrades.toLocaleString('en-IN'), delta: null },
    { section: 'Trades',    label: 'Recenter Events',         value: r.recenterCount.toLocaleString('en-IN'), delta: null },
    { section: 'Trades',    label: 'IL Stop-Loss Hit',        value: r.ilHalted ? '⛔ Yes' : '✅ No', delta: null },
    // --- Inventory ---
    { section: 'Inventory', label: `Initial ${a1} (shares)`,  value: qty(r.initialX),                delta: null },
    { section: 'Inventory', label: `Initial ${a2} (shares)`,  value: qty(r.initialY),                delta: null },
    { section: 'Inventory', label: `Final ${a1} (shares)`,    value: qty(r.finalX),                  delta: null },
    { section: 'Inventory', label: `Final ${a2} (shares)`,    value: qty(r.finalY),                  delta: null },
    // --- Regime ---
    { section: 'Regime',    label: 'LOW / MID / HIGH hours',  value: `${r.lowModeHours} / ${r.midModeHours} / ${r.highModeHours}`, delta: null },
    { section: 'Regime',    label: 'Buy Brokerage',           value: `${r.buyBrokeragePct.toFixed(2)}%`, delta: null },
    { section: 'Regime',    label: 'Sell Brokerage',          value: `${r.sellBrokeragePct.toFixed(2)}%`, delta: null },
  ];

  metricsGrid.innerHTML = cards.map(({ label, value, delta, positive }) => `
    <div class="metric-card">
      <span class="mc-label">${label}</span>
      <strong class="mc-value">${value}</strong>
      ${delta != null ? `<em class="mc-delta ${positive ? 'positive' : 'negative'}">${delta}</em>` : ''}
    </div>`).join('');

  downloadBtn.classList.remove('hidden');
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function destroyCharts() { /* canvas redraws clear themselves */ }

function renderCharts() {
  if (!state.equity.length) return;
  const step = Math.max(1, Math.floor(state.equity.length / 500));
  const s = state.equity.filter((_, i) => i % step === 0);

  drawChart(chartCanvas, s, [
    { key: 'poolValue',  label: 'AMM Total Value',  color: '#38bdf8' },
    { key: 'holdValue',  label: 'Buy-and-Hold',     color: '#818cf8' },
    { key: 'cashProfit', label: 'Cash Profit',      color: '#22c55e' },
  ], '₹ Value');

  drawChart(corrCanvas, s, [
    { key: 'correlation',     label: 'Correlation',    color: '#f97316' },
    { key: 'dynamicWidthPct', label: 'Width % (÷100)', color: '#a78bfa', scale: 0.01 },
    { key: 'ilPct',           label: 'IL % (÷100)',    color: '#f43f5e', scale: 0.01 },
  ], '−1 → +1');
}

function drawChart(canvas, data, series, yLabel) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const P = { t: 28, r: 16, b: 46, l: 88 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;
  ctx.clearRect(0, 0, W, H);

  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const sc = s.scale ?? 1;
    for (const d of data) { const v = d[s.key] * sc; if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
  }
  if (!isFinite(yMin)) yMin = 0;
  if (!isFinite(yMax)) yMax = 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yRng = yMax - yMin;

  const toX = i => P.l + (i / (data.length - 1)) * cW;
  const toY = v => P.t + cH - ((v - yMin) / yRng) * cH;

  // Grid
  for (let g = 0; g <= 5; g++) {
    const yv = yMin + (g / 5) * yRng, yp = toY(yv);
    ctx.strokeStyle = 'rgba(148,163,184,0.09)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l + cW, yp); ctx.stroke();
    ctx.fillStyle = 'rgba(148,163,184,0.6)'; ctx.font = '10px Arial'; ctx.textAlign = 'right';
    const lbl = Math.abs(yRng) > 50000
      ? `₹${(yv / 1e5).toFixed(1)}L`
      : Math.abs(yRng) > 1000 ? `₹${(yv/1000).toFixed(1)}K` : yv.toFixed(3);
    ctx.fillText(lbl, P.l - 4, yp + 3.5);
  }

  // X labels
  for (let s = 0; s <= 5; s++) {
    const i = Math.round((s / 5) * (data.length - 1));
    ctx.fillStyle = 'rgba(148,163,184,0.6)'; ctx.font = '10px Arial'; ctx.textAlign = 'center';
    ctx.fillText(new Date(data[i].date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }), toX(i), H - P.b + 13);
  }

  // Y label
  ctx.save(); ctx.translate(13, P.t + cH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(148,163,184,0.6)'; ctx.font = '11px Arial'; ctx.textAlign = 'center';
  ctx.fillText(yLabel, 0, 0); ctx.restore();

  // IL halt shading
  const hi = data.findIndex(d => d.halted);
  if (hi >= 0) {
    ctx.fillStyle = 'rgba(244,63,94,0.07)';
    ctx.fillRect(toX(hi), P.t, toX(data.length - 1) - toX(hi), cH);
    ctx.strokeStyle = 'rgba(244,63,94,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(toX(hi), P.t); ctx.lineTo(toX(hi), P.t + cH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(244,63,94,0.65)'; ctx.font = '10px Arial'; ctx.textAlign = 'left';
    ctx.fillText('IL halt', toX(hi) + 3, P.t + 11);
  }

  // Lines
  for (const s of series) {
    const sc = s.scale ?? 1;
    ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    data.forEach((d, i) => { const x = toX(i), y = toY(d[s.key] * sc); i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y); });
    ctx.stroke();
  }

  // Legend
  let lx = P.l;
  for (const s of series) {
    ctx.fillStyle = s.color; ctx.fillRect(lx, 9, 14, 3);
    ctx.fillStyle = 'rgba(148,163,184,0.85)'; ctx.font = '10px Arial'; ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 18, 14);
    lx += ctx.measureText(s.label).width + 36;
  }
}

// ─── Swap table ───────────────────────────────────────────────────────────────
function renderTable() {
  if (!state.swaps.length) {
    swapCount.classList.add('hidden');
    swapContainer.innerHTML = `<div class="empty-state compact"><h3>No profitable swaps executed</h3><p>Adjust range widths or increase capital and try again.</p></div>`;
    return;
  }
  const a1 = asset1Label.value || 'Asset 1';
  const a2 = asset2Label.value || 'Asset 2';

  swapCount.textContent = `${state.swaps.length} records`;
  swapCount.classList.remove('hidden');

  const rows = state.swaps.slice(-500);
  const note = state.swaps.length > 500
    ? `<p class="table-note">Showing last 500 of ${state.swaps.length} records. Download CSV for full history.</p>` : '';

  swapContainer.innerHTML = note + `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Date / Time</th>
            <th>Type</th>
            <th>Mode</th>
            <th>Corr</th>
            <th>Width%</th>
            <th>Action</th>
            <th>Bought</th>
            <th class="col-num">Shares Bought</th>
            <th class="col-num">Buy Cost (₹)</th>
            <th class="col-num">Broker Buy</th>
            <th>Sold</th>
            <th class="col-num">Shares Sold</th>
            <th class="col-num">Sell Rev (₹)</th>
            <th class="col-num">Broker Sell</th>
            <th class="col-num">Gross Profit</th>
            <th class="col-num">Net Profit</th>
            <th class="col-num">Cash Accum.</th>
            <th class="col-num">${a1} Shares</th>
            <th class="col-num">${a2} Shares</th>
            <th class="col-num">IL%</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(s => {
            const typeLabel = s.isRecenterTrade
              ? '<span class="type-pill recenter">RECENTER</span>'
              : '<span class="type-pill swap">SWAP</span>';
            return `
            <tr class="${s.recentered && !s.isRecenterTrade ? 'recenter-row' : ''} ${s.isRecenterTrade ? 'recenter-trade-row' : ''}">
              <td>${new Date(s.date).toLocaleString('en-IN')}</td>
              <td>${typeLabel}</td>
              <td><span class="mode-pill mode-${s.mode.toLowerCase()}">${s.mode}</span></td>
              <td>${s.rollingCorrelation.toFixed(3)}</td>
              <td>${s.dynamicWidthPct.toFixed(2)}%</td>
              <td class="action-cell">${s.action}</td>
              <td>${s.boughtAsset}</td>
              <td class="col-num">${qty(s.boughtQty)}</td>
              <td class="col-num negative">${inr2.format(s.boughtCost)}</td>
              <td class="col-num negative">${inr2.format(s.brokerageOnBuy)}</td>
              <td>${s.soldAsset}</td>
              <td class="col-num">${qty(s.soldQty)}</td>
              <td class="col-num positive">${inr2.format(s.soldRevenue)}</td>
              <td class="col-num negative">${inr2.format(s.brokerageOnSell)}</td>
              <td class="col-num ${s.grossProfit >= 0 ? 'positive' : 'negative'}">${inr2.format(s.grossProfit)}</td>
              <td class="col-num ${s.netProfit >= 0 ? 'positive' : 'negative'}">${inr2.format(s.netProfit)}</td>
              <td class="col-num">${inr.format(s.cashProfit)}</td>
              <td class="col-num">${qty(s.poolX)}</td>
              <td class="col-num">${qty(s.poolY)}</td>
              <td class="col-num ${s.ilPct >= 0 ? 'positive' : 'negative'}">${s.ilPct.toFixed(2)}%</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ─── Download CSV ─────────────────────────────────────────────────────────────
function downloadCsv(rows) {
  const headers = [
    'Date','Type','Mode','Correlation','DynamicWidth%','Recentered','Action',
    'BoughtAsset','SharesBought','BuyCost_INR','BrokerOnBuy_INR',
    'SoldAsset','SharesSold','SellRevenue_INR','BrokerOnSell_INR',
    'GrossProfit_INR','TotalBrokerage_INR','NetProfit_INR','CashAccum_INR',
    'Asset1Price','Asset2Price','PriceRatio','CenterRatio',
    'Asset1Shares','Asset2Shares',
    'PoolAssetValue_INR','IL_INR','IL_Pct','TotalValue_INR',
  ];
  const lines = [headers.join(',')].concat(rows.map(r => [
    r.date,
    r.isRecenterTrade ? 'RECENTER' : 'SWAP',
    r.mode, r.rollingCorrelation.toFixed(6), r.dynamicWidthPct.toFixed(4), r.recentered,
    `"${r.action}"`,
    r.boughtAsset, Math.round(r.boughtQty), r.boughtCost.toFixed(2), r.brokerageOnBuy.toFixed(2),
    r.soldAsset, Math.round(r.soldQty), r.soldRevenue.toFixed(2), r.brokerageOnSell.toFixed(2),
    r.grossProfit.toFixed(2), r.totalBrokerage.toFixed(2), r.netProfit.toFixed(2), r.cashProfit.toFixed(2),
    r.asset1Price, r.asset2Price, r.priceRatio.toFixed(6), r.centerRatio.toFixed(6),
    Math.round(r.poolX), Math.round(r.poolY),
    r.poolAssetValue.toFixed(2), r.ilINR.toFixed(2), r.ilPct.toFixed(4), r.totalValue.toFixed(2),
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'amm_swaps.csv' }).click();
  URL.revokeObjectURL(url);
}
