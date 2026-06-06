import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = { swaps: [], results: null, equity: [], perf: null, rangeLog: [] };
const $     = id => document.getElementById(id);
const inr   = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(v);
const inr2  = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const pct   = (v,d=2) => `${v>=0?'+':''}${(+v).toFixed(d)}%`;
const dec   = (v,d=2) => (+v).toFixed(d);
const qty   = v => Math.round(+v).toLocaleString('en-IN');

// DOM refs
const asset1File   = $('asset1File');
const asset2File   = $('asset2File');
const asset1Name   = $('asset1FileName');
const asset2Name   = $('asset2FileName');
const asset1Label  = $('asset1Label');
const asset2Label  = $('asset2Label');
const runBtn       = $('runSimulation');
const statusEl     = $('statusBanner');
const metricsGrid  = $('metricsGrid');
const perfPanel    = $('perfPanel');
const chartCanvas  = $('equityChart');
const alphaCanvas  = $('alphaChart');
const tableWrap    = $('tableWrap');
const swapCount    = $('swapCount');
const dlBtn        = $('downloadCsv');
const pairHeading  = $('pairHeading');
const haltBanner   = $('haltBanner');

// File upload handlers
asset1File.addEventListener('change', () => {
  asset1Name.textContent = asset1File.files[0]?.name || 'Upload Asset 1 — 1-min CSV';
});
asset2File.addEventListener('change', () => {
  asset2Name.textContent = asset2File.files[0]?.name || 'Upload Asset 2 — 1-min CSV';
});

asset1Label.addEventListener('input', updateHeading);
asset2Label.addEventListener('input', updateHeading);
dlBtn.addEventListener('click', () => downloadCsv(state.swaps));
runBtn.addEventListener('click', handleRun);
updateHeading();

function updateHeading() {
  pairHeading.textContent = `${asset1Label.value || 'Asset 1'}  ↔  ${asset2Label.value || 'Asset 2'}`;
}

function setStatus(type, msg) {
  const icons = { info: '◎', success: '✦', warning: '⚠', error: '✕' };
  statusEl.className = `status-banner status-${type}`;
  statusEl.innerHTML = `<span class="sb-icon">${icons[type]||'◎'}</span><span>${msg}</span>`;
}

function getConfig() {
  return {
    buyBrokeragePct:         +$('buyBrokeragePct').value,
    sellBrokeragePct:        +$('sellBrokeragePct').value,
    ilBudgetPct:             +$('ilBudgetPct').value,
    alphaProtectCap:         +$('alphaProtectCap').value,
    alphaProtectLambda:      +$('alphaProtectLambda').value,
    sigmaMultiplier:         +$('sigmaMultiplier').value,
    compoundIntervalHours:   +$('compoundIntervalHours').value,
    compoundMinPct:          +$('compoundMinPct').value,
    ilHardStopPct:           +$('ilHardStopPct').value,
    ilHardResumePct:         +$('ilHardResumePct').value,
  };
}

async function handleRun() {
  if (!asset1File.files[0] || !asset2File.files[0]) {
    setStatus('error', 'Upload both CSV files before running.'); return;
  }
  runBtn.disabled = true;
  runBtn.querySelector('.btn-label').textContent = 'Computing…';
  haltBanner.classList.add('hidden');
  setStatus('info', 'Solving Lagrangian optimisation for concentration range · running hourly V3 swap engine…');

  try {
    await new Promise(r => setTimeout(r, 20));
    const [t1, t2] = await Promise.all([
      asset1File.files[0].text(),
      asset2File.files[0].text()
    ]);
    const result = runAlmSimulation(parseCsv(t1), parseCsv(t2), +$('realCapital').value, getConfig());

    if (result.error) {
      setStatus('error', result.error); resetPanels();
    } else {
      state.swaps    = result.swaps;
      state.results  = result.results;
      state.equity   = result.equityCurve;
      state.perf     = result.performanceSummary;
      state.rangeLog = result.rangeLog || [];

      renderMetrics();
      renderPerf();
      renderCharts();
      renderTable();
      renderHaltBanner();

      const r = result.results;
      setStatus(
        r.vsHold >= 0 ? 'success' : 'warning',
        `${r.vsHold >= 0 ? 'Alpha positive' : 'Below hold'} ${inr(Math.abs(r.vsHold))} (${dec(r.vsHoldPct,2)}%)  ·  ` +
        `Cash ₹${inr(r.cashProfit)}  ·  IL ${dec(r.ilPct,2)}%  ·  ` +
        `${r.totalSwaps} swaps  ·  ${r.compoundEvents} compound events  ·  avg ${dec(r.concentrationFactor,1)}× concentration`
      );
    }
  } catch(e) {
    setStatus('error', e.message || 'Unexpected error.'); resetPanels();
  }

  runBtn.disabled = false;
  runBtn.querySelector('.btn-label').textContent = 'Run Simulation';
}

function resetPanels() {
  state.swaps = []; state.results = null; state.equity = []; state.perf = null;
  renderMetrics(); renderPerf(); renderTable();
}

// ─── Halt banner ──────────────────────────────────────────────────────────────
function renderHaltBanner() {
  const r = state.results;
  haltBanner.classList.add('hidden');
  if (!r) return;
  if (r.swapsHalted && r.haltReason === 'IL_STOP') {
    haltBanner.innerHTML = `<span class="hb-icon">⛔</span><div class="hb-body"><strong>IL Hard Stop Active</strong><span>Swaps halted — IL exceeded the hard-stop threshold. Resumes when IL recovers above resume level.</span></div>`;
    haltBanner.className = 'halt-banner halted';
    haltBanner.classList.remove('hidden');
  } else if (r.ilResumedAt) {
    haltBanner.innerHTML = `<span class="hb-icon">✅</span><div class="hb-body"><strong>Swaps Resumed</strong><span>Last resumed ${new Date(r.ilResumedAt).toLocaleString('en-IN')}${r.haltCount > 1 ? ` · ${r.haltCount} cycles` : ''}.</span></div>`;
    haltBanner.className = 'halt-banner resumed';
    haltBanner.classList.remove('hidden');
  }
}

// ─── Metrics grid ─────────────────────────────────────────────────────────────
function renderMetrics() {
  if (!state.results) {
    metricsGrid.innerHTML = '<div class="empty-state">Upload CSV files and run simulation</div>';
    dlBtn.classList.add('hidden'); return;
  }
  const r  = state.results;
  const a1 = asset1Label.value || 'Asset 1';
  const a2 = asset2Label.value || 'Asset 2';

  const cards = [
    { label: 'Pool vs Buy-and-Hold', value: inr(r.vsHold),        delta: pct(r.vsHoldPct,2),  pos: r.vsHold >= 0,    hero: true },
    { label: 'AMM Total Value',      value: inr(r.totalValue),     delta: pct(r.roiPct),       pos: r.roiPct >= 0 },
    { label: 'Buy-and-Hold Value',   value: inr(r.holdValue),      delta: pct(r.holdRoi),      pos: r.holdRoi >= 0 },
    { label: 'Cash Profit (swaps)',  value: inr(r.cashProfit),     delta: pct(r.cashRoi,2),    pos: r.cashProfit >= 0 },
    { label: 'Reinvested into Pool', value: inr(r.reinvestedTotal),delta: `${r.compoundEvents} events`, pos: true },
    { label: 'Gross Swap Fees',      value: inr(r.grossSwapFees),  delta: null },
    { label: 'Pool Asset Value',     value: inr(r.poolAssets),     delta: null },
    { label: 'Unrealized IL',        value: inr(r.ilINR),          delta: pct(r.ilPct,2),      pos: r.ilPct >= 0 },
    { label: 'Total Brokerage',      value: inr(r.totalBrokerage), delta: pct(-r.brokRoi,2),   pos: false },
    { label: 'Avg Concentration',    value: `${dec(r.concentrationFactor,1)}×`, delta: 'calculus-optimal', pos: true },
    { label: 'Total Swaps',          value: r.totalSwaps.toLocaleString('en-IN'), delta: null },
    { label: 'Profitable Swaps',     value: `${r.successSwaps} / ${r.totalSwaps}`, delta: `${dec(r.successRate*100,1)}%`, pos: true },
    { label: 'Recenter Events',      value: r.recenterCount.toLocaleString('en-IN'), delta: null },
    { label: 'Halt / Resume Cycles', value: r.haltCount > 0 ? `${r.haltCount}×` : '—', delta: null },
    { label: `${a1} (initial→final)`, value: `${qty(r.initialX)} → ${qty(r.finalX)}`, delta: null },
    { label: `${a2} (initial→final)`, value: `${qty(r.initialY)} → ${qty(r.finalY)}`, delta: null },
  ];

  metricsGrid.innerHTML = cards.map(({ label, value, delta, pos, hero }) => `
    <div class="metric-card${hero ? ' hero' : ''}">
      <span class="mc-label">${label}</span>
      <strong class="mc-value">${value}</strong>
      ${delta != null ? `<em class="mc-delta ${pos ? 'pos' : 'neg'}">${delta}</em>` : ''}
    </div>`).join('');

  dlBtn.classList.remove('hidden');
}

// ─── Performance panel ────────────────────────────────────────────────────────
function renderPerf() {
  if (!state.perf) {
    perfPanel.innerHTML = '<div class="empty-state">Run simulation first</div>'; return;
  }
  const p = state.perf;
  perfPanel.innerHTML = `
    <div class="perf-grid">
      <div class="perf-box">
        <h3><span class="ph-icon">◈</span> Harvest vs Friction</h3>
        <div class="pr"><span>Gross Swap Fees</span><strong class="pos">${inr(p.grossFees)}</strong></div>
        <div class="pr"><span>Total Brokerage</span><strong class="neg">${inr(p.totalFriction)}</strong></div>
        <div class="pr"><span>Net Cash Income</span><strong>${inr(p.netSwapIncome)}</strong></div>
        <div class="pr"><span>Friction Ratio</span><strong>${dec(p.frictionRatioPct,1)}%</strong></div>
        <div class="pbadge ${p.frictionRatio < 0.10 ? 'good' : p.frictionRatio < 0.25 ? 'ok' : 'bad'}">${p.narrative.friction}</div>
      </div>
      <div class="perf-box">
        <h3><span class="ph-icon">◈</span> Risk-Adjusted Return</h3>
        <div class="pr"><span>Alpha Sharpe (ann.)</span><strong>${dec(p.alphaSharpe,3)}</strong></div>
        <div class="pr"><span>Max Alpha Drawdown</span><strong class="neg">${inr(p.maxDrawdownINR)}</strong></div>
        <div class="pr"><span>Max Drawdown %</span><strong class="neg">${dec(p.maxDrawdownPct,2)}%</strong></div>
        <div class="pr"><span>Final Net Alpha</span><strong class="${p.netAlphaFinal >= 0 ? 'pos' : 'neg'}">${inr(p.netAlphaFinal)}</strong></div>
      </div>
      <div class="perf-box">
        <h3><span class="ph-icon">◈</span> Compounding Engine</h3>
        <div class="pr"><span>Total Reinvested</span><strong class="pos">${inr(p.reinvestedTotal)}</strong></div>
        <div class="pr"><span>Compound Events</span><strong>${p.compoundEvents}</strong></div>
        <div class="pr"><span>Swap Success Rate</span><strong>${dec(p.successRatePct,1)}%</strong></div>
        <div class="pbadge ${p.successRate >= 1 ? 'good' : p.successRate > 0.8 ? 'ok' : 'bad'}">${p.narrative.swapQuality}</div>
      </div>
      <div class="perf-box">
        <h3><span class="ph-icon">◈</span> Calculus Range Engine</h3>
        <div class="pr"><span>Avg Concentration</span><strong class="pos">${dec(p.concentrationFactor,1)}×</strong></div>
        <div class="pr"><span>IL Status</span><strong class="${p.unrealizedIL >= 0 ? 'pos' : 'neg'}">${inr(p.unrealizedIL)}</strong></div>
        <div class="pr"><span>Net Alpha</span><strong class="${p.netAlphaFinal >= 0 ? 'pos' : 'neg'}">${inr(p.netAlphaFinal)}</strong></div>
        <div class="pbadge ok">${p.narrative.concentration}</div>
      </div>
    </div>`;
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function renderCharts() {
  if (!state.equity.length) return;
  const step = Math.max(1, Math.floor(state.equity.length / 600));
  const s = state.equity.filter((_, i) => i % step === 0);

  drawChart(chartCanvas, s, [
    { key: 'poolValue', label: 'AMM Total', color: '#00d4ff' },
    { key: 'holdValue', label: 'Buy-and-Hold', color: '#7c6af7' },
    { key: 'cashProfit', label: 'Cash Profit', color: '#00e5a0' },
  ], '₹ Value');

  drawChart(alphaCanvas, s, [
    { key: 'alphaINR', label: 'Net Alpha ₹', color: '#f5c842' },
    { key: 'ilPct', label: 'IL% (×1000)', color: '#ff4e6a', scale: 1000 },
  ], 'Alpha / IL');
}

function drawChart(canvas, data, series, yLabel) {
  if (!canvas || !data.length) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const P = { t: 28, r: 16, b: 44, l: 90 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;
  ctx.clearRect(0, 0, W, H);

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgba(6,12,28,0.98)');
  bg.addColorStop(1, 'rgba(4,8,20,0.98)');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const sc = s.scale ?? 1;
    for (const d of data) {
      const v = (d[s.key] ?? 0) * sc;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  if (!isFinite(yMin)) yMin = 0;
  if (!isFinite(yMax)) yMax = 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yRng = yMax - yMin;

  const toX = i => P.l + (i / (data.length - 1 || 1)) * cW;
  const toY = v => P.t + cH - ((v - yMin) / yRng) * cH;

  // Grid lines
  for (let g = 0; g <= 4; g++) {
    const yv = yMin + (g / 4) * yRng, yp = toY(yv);
    ctx.strokeStyle = 'rgba(100,130,180,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l + cW, yp); ctx.stroke();
    // Y label
    ctx.fillStyle = 'rgba(120,145,180,0.65)'; ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    const lbl = Math.abs(yRng) > 50000 ? `₹${(yv/1e5).toFixed(1)}L`
              : Math.abs(yRng) > 999   ? `₹${(yv/1e3).toFixed(1)}K`
              : yv.toFixed(1);
    ctx.fillText(lbl, P.l - 4, yp + 3);
  }

  // Zero line
  if (yMin < 0 && yMax > 0) {
    const yp = toY(0);
    ctx.strokeStyle = 'rgba(150,170,200,0.20)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l + cW, yp); ctx.stroke();
    ctx.setLineDash([]);
  }

  // X axis labels
  for (let i = 0; i <= 5; i++) {
    const idx = Math.round((i / 5) * (data.length - 1));
    ctx.fillStyle = 'rgba(120,145,180,0.60)'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillText(new Date(data[idx].date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }), toX(idx), H - P.b + 14);
  }

  // Y axis label
  ctx.save(); ctx.translate(12, P.t + cH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(120,145,180,0.50)'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
  ctx.fillText(yLabel, 0, 0); ctx.restore();

  // Halt shading
  let inH = false, hS = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i].halted && !inH) { inH = true; hS = i; }
    if (!data[i].halted && inH) {
      ctx.fillStyle = 'rgba(244,63,94,0.06)';
      ctx.fillRect(toX(hS), P.t, toX(i) - toX(hS), cH);
      inH = false;
    }
  }
  if (inH) { ctx.fillStyle = 'rgba(244,63,94,0.06)'; ctx.fillRect(toX(hS), P.t, toX(data.length-1) - toX(hS), cH); }

  // Compound event markers
  const compoundDates = new Set(
    (state.swaps || [])
      .filter(s => s.compoundEvent)
      .map(s => s.date.substring(0, 13))
  );

  // Swap markers (thin vertical gold lines)
  const swapSet = new Set(state.swaps.map(s => s.date.substring(0, 13)));
  data.forEach((d, i) => {
    if (swapSet.has(d.date.substring(0, 13))) {
      ctx.fillStyle = 'rgba(245,200,66,0.18)';
      ctx.fillRect(toX(i) - 0.5, P.t, 1, cH);
    }
  });

  // Series lines with glow
  for (const s of series) {
    const sc = s.scale ?? 1;
    // Glow pass
    ctx.beginPath();
    ctx.strokeStyle = s.color + '30';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    data.forEach((d, i) => {
      const x = toX(i), y = toY((d[s.key] ?? 0) * sc);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    // Sharp line
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    data.forEach((d, i) => {
      const x = toX(i), y = toY((d[s.key] ?? 0) * sc);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Legend
  let lx = P.l;
  for (const s of series) {
    ctx.fillStyle = s.color + 'cc'; ctx.fillRect(lx, 10, 14, 3);
    ctx.fillStyle = 'rgba(180,200,220,0.80)'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
    ctx.fillText(s.label, lx + 18, 15);
    lx += ctx.measureText(s.label).width + 38;
  }
}

// ─── Trade table ───────────────────────────────────────────────────────────────
function renderTable() {
  if (!state.swaps.length) {
    swapCount.classList.add('hidden');
    tableWrap.innerHTML = '<div class="empty-state">No trades yet — run the simulation</div>';
    return;
  }
  const a1   = asset1Label.value || 'Asset 1';
  const a2   = asset2Label.value || 'Asset 2';
  const rows = state.swaps.slice(-500);
  swapCount.textContent = `${state.swaps.length} swaps`;
  swapCount.classList.remove('hidden');

  const note = state.swaps.length > 500
    ? `<p class="table-note">Showing last 500 of ${state.swaps.length} swaps. Download CSV for full history.</p>`
    : '';

  tableWrap.innerHTML = note + `
    <div class="tscroll"><table>
      <thead><tr>
        <th>Date / Time</th><th>Action</th>
        <th>Bought</th><th class="r">Qty</th><th class="r">Cost ₹</th>
        <th>Sold</th><th class="r">Qty</th><th class="r">Revenue ₹</th>
        <th class="r">Gross ₹</th><th class="r">Brok ₹</th><th class="r">Net ₹</th>
        <th class="r">Cash Accum.</th>
        <th class="r">${a1}</th><th class="r">${a2}</th>
        <th class="r">IL%</th><th class="r">α*</th><th class="r">Conc.</th>
      </tr></thead>
      <tbody>${rows.map(s => `
        <tr>
          <td>${new Date(s.date).toLocaleString('en-IN')}</td>
          <td>${s.action}</td>
          <td>${s.buyAsset}</td><td class="r">${qty(s.buyQty)}</td><td class="r neg">${inr2(s.cost)}</td>
          <td>${s.sellAsset}</td><td class="r">${qty(s.sellQty)}</td><td class="r pos">${inr2(s.revenue)}</td>
          <td class="r ${s.gross >= 0 ? 'pos' : 'neg'}">${inr2(s.gross)}</td>
          <td class="r neg">${inr2(s.brok)}</td>
          <td class="r ${s.net >= 0 ? 'pos' : 'neg'}">${inr2(s.net)}</td>
          <td class="r">${inr(s.cashProfit)}</td>
          <td class="r">${qty(s.poolX)}</td>
          <td class="r">${qty(s.poolY)}</td>
          <td class="r ${s.ilPct >= 0 ? 'pos' : 'neg'}">${dec(s.ilPct, 3)}%</td>
          <td class="r">${dec((s.alpha ?? 0) * 100, 1)}%</td>
          <td class="r">${dec(s.concentration ?? 0, 1)}×</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function downloadCsv(rows) {
  const h = ['Date','Action','BuyAsset','BuyQty','Cost_INR','SellAsset','SellQty','Rev_INR',
             'Gross_INR','Brok_INR','Net_INR','CashAccum_INR','A1Price','A2Price',
             'A1Shares','A2Shares','IL_Pct','Alpha_Opt','Concentration','ThetaEff'];
  const lines = [h.join(',')].concat(rows.map(r => [
    r.date, `"${r.action}"`, r.buyAsset, Math.round(r.buyQty), dec(r.cost,2),
    r.sellAsset, Math.round(r.sellQty), dec(r.revenue,2),
    dec(r.gross,2), dec(r.brok,2), dec(r.net,2), dec(r.cashProfit,2),
    r.asset1Price, r.asset2Price, Math.round(r.poolX), Math.round(r.poolY),
    dec(r.ilPct,4), dec((r.alpha??0)*100,2), dec(r.concentration??0,2), dec(r.thetaEff??0,4),
  ].join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'amm_v4_trades.csv' }).click();
  URL.revokeObjectURL(url);
}
