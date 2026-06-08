import { parseCsv, runAlmSimulation } from './simulation-core.js';

// ── State ──────────────────────────────────────────────────────────────────
const state = { ledger: [], results: null, equity: [] };

// ── Helpers ────────────────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const inr = v  => '₹' + Math.abs(+v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const pct = (v, d=2) => `${+v >= 0 ? '+' : ''}${(+v).toFixed(d)}%`;
const dec = (v, d=2) => (+v).toFixed(d);
const qty = v  => Math.round(+v).toLocaleString('en-IN');
const mono= v  => v;
const fdt = s  => {
  const d = new Date(s);
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12: false });
};

// ── DOM wiring ─────────────────────────────────────────────────────────────
$('asset1File').addEventListener('change', e => {
  const n = e.target.files[0]?.name || '';
  $('asset1FileName').textContent = n;
});
$('asset2File').addEventListener('change', e => {
  const n = e.target.files[0]?.name || '';
  $('asset2FileName').textContent = n;
});
$('runSimulation').addEventListener('click', handleRun);
$('exportBtn').addEventListener('click', () => exportCsv(state.ledger));

function getConfig() {
  return {
    buyBrokeragePct:       +$('buyBrokeragePct').value,
    sellBrokeragePct:      +$('sellBrokeragePct').value,
    ilBudgetPct:           +$('ilBudgetPct').value,
    alphaProtectCap:       +$('alphaProtectCap').value,
    alphaProtectLambda:    +$('alphaProtectLambda').value,
    sigmaMultiplier:       +$('sigmaMultiplier').value,
    compoundIntervalHours: +$('compoundIntervalHours').value,
    compoundMinPct:        +$('compoundMinPct').value,
    ilHardStopPct:         +$('ilHardStopPct').value,
    ilHardResumePct:       +$('ilHardResumePct').value,
  };
}

function setStatus(type, msg) {
  const el = $('statusBar');
  el.className = 'status' + (type === 'ok' ? ' ok' : type === 'warn' ? ' warn' : type === 'err' ? ' err' : '');
  el.textContent = msg;
}

// ── Run ────────────────────────────────────────────────────────────────────
async function handleRun() {
  const f1 = $('asset1File').files[0], f2 = $('asset2File').files[0];
  if (!f1 || !f2) { setStatus('err', 'Upload both CSV files first.'); return; }

  const btn = $('runSimulation');
  btn.disabled = true; btn.textContent = 'Running…';
  setStatus('', 'Computing…');
  $('emptyState').classList.add('hidden');

  try {
    await new Promise(r => setTimeout(r, 16));
    const [t1, t2] = await Promise.all([f1.text(), f2.text()]);
    const res = runAlmSimulation(parseCsv(t1), parseCsv(t2), +$('realCapital').value, getConfig());

    if (res.error) {
      setStatus('err', res.error);
      $('resultsSection').classList.add('hidden');
      $('emptyState').classList.remove('hidden');
    } else {
      state.ledger  = res.swaps;
      state.results = res.results;
      state.equity  = res.equityCurve;

      const r = res.results;
      const a1 = $('asset1Label').value || 'Asset 1';
      const a2 = $('asset2Label').value || 'Asset 2';
      $('pairHeading').textContent = `${a1} ↔ ${a2}`;

      renderHero(r);
      renderStats(r, a1, a2);
      renderCharts();
      renderLedger(a1, a2);

      $('resultsSection').classList.remove('hidden');
      $('emptyState').classList.add('hidden');

      const beat = r.vsHold >= 0;
      setStatus(
        beat ? 'ok' : 'warn',
        `${beat ? 'Pool outperforms' : 'Pool underperforms'} buy-and-hold by ${inr(Math.abs(r.vsHold))} (${dec(r.vsHoldPct, 2)}%)  ·  ${r.totalSwaps} trades  ·  ${r.compoundEvents} reinvestments`
      );
    }
  } catch(e) {
    setStatus('err', e.message || 'Error running simulation.');
  }

  btn.disabled = false; btn.textContent = 'Run Simulation';
}

// ── Hero ───────────────────────────────────────────────────────────────────
function renderHero(r) {
  const beat = r.vsHold >= 0;
  $('heroRow').innerHTML = `
    <div class="hero-cell">
      <div class="hero-label">Pool vs Buy &amp; Hold</div>
      <div class="hero-value ${beat ? 'up' : 'down'}">${beat ? '+' : '−'}${inr(Math.abs(r.vsHold))}</div>
      <div class="hero-sub">${pct(r.vsHoldPct, 2)} over the period</div>
    </div>
    <div class="hero-cell">
      <div class="hero-label">AMM Portfolio Return</div>
      <div class="hero-value ${r.roiPct >= 0 ? 'up' : 'down'}">${pct(r.roiPct, 2)}</div>
      <div class="hero-sub">on ${inr(r.initCapital)} invested</div>
    </div>
    <div class="hero-cell">
      <div class="hero-label">Buy &amp; Hold Return</div>
      <div class="hero-value">${pct(r.holdRoi, 2)}</div>
      <div class="hero-sub">if you held both stocks</div>
    </div>`;
}

// ── Stats ──────────────────────────────────────────────────────────────────
function renderStats(r, a1, a2) {
  const cells = [
    { label: 'Cash earned from trades',  value: inr(r.cashProfit),      cls: r.cashProfit >= 0 ? 'up' : 'down' },
    { label: 'Profits reinvested',        value: inr(r.reinvestedTotal), cls: 'teal' },
    { label: 'Reinvestment events',       value: r.compoundEvents,       cls: r.compoundEvents > 0 ? 'teal' : '' },
    { label: 'Unrealised loss (IL)',      value: pct(r.ilPct, 2),        cls: r.ilPct >= 0 ? 'up' : 'down' },
    { label: 'Gross fees earned',         value: inr(r.grossSwapFees),   cls: '' },
    { label: 'Brokerage paid',            value: inr(r.totalBrokerage),  cls: 'down' },
    { label: 'Pool asset value',          value: inr(r.poolAssets),      cls: '' },
    { label: 'AMM total value',           value: inr(r.totalValue),      cls: '' },
    { label: 'Trades executed',           value: r.totalSwaps,           cls: '' },
    { label: 'Trade success rate',        value: dec(r.successRate * 100, 0) + '%', cls: r.successRate > 0.9 ? 'up' : '' },
    { label: 'Range resets',              value: r.recenterCount,        cls: '' },
    { label: `${a1} shares`,             value: `${qty(r.initialX)} → ${qty(r.finalX)}`, cls: '' },
    { label: `${a2} shares`,             value: `${qty(r.initialY)} → ${qty(r.finalY)}`, cls: '' },
    { label: 'Avg concentration',         value: dec(r.concentrationFactor, 1) + '×', cls: 'blue' },
  ];

  $('statGrid').innerHTML = cells.map(c =>
    `<div class="stat-cell">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls}">${c.value}</div>
    </div>`
  ).join('');
}

// ── Charts ─────────────────────────────────────────────────────────────────
const _chartObservers = [];

function renderCharts() {
  const equity = state.equity;
  if (!equity.length) return;

  _chartObservers.forEach(o => o.disconnect());
  _chartObservers.length = 0;

  const step = Math.max(1, Math.floor(equity.length / 600));
  const pts   = equity.filter((_, i) => i % step === 0);

  $('legend1').innerHTML = `
    <div class="leg"><div class="leg-line" style="background:#60a5fa"></div>AMM Pool</div>
    <div class="leg"><div class="leg-line" style="background:#666"></div>Buy &amp; Hold</div>
    <div class="leg"><div class="leg-line" style="background:#4ade80"></div>Cash Earned</div>
    <div class="leg"><div class="leg-dash"></div>Reinvestment</div>`;

  $('legend2').innerHTML = `
    <div class="leg"><div class="leg-line" style="background:#fbbf24"></div>Net Profit vs Hold</div>
    <div class="leg"><div class="leg-line" style="background:#f87171"></div>Unrealised Loss x1000</div>
    <div class="leg"><div class="leg-dash"></div>Reinvestment</div>`;

  const charts = [
    { id: 'chart1', series: [
        { key: 'poolValue',  color: '#60a5fa' },
        { key: 'holdValue',  color: '#555' },
        { key: 'cashProfit', color: '#4ade80' },
      ]},
    { id: 'chart2', series: [
        { key: 'alphaINR', color: '#fbbf24' },
        { key: 'ilPct',    color: '#f87171', scale: 1000 },
      ]},
  ];

  for (const { id, series } of charts) {
    const canvas = $(id);
    if (!canvas) continue;
    // draw after layout flush
    requestAnimationFrame(() => drawChart(canvas, pts, series));
    // redraw on resize (orientation change, etc.)
    const ro = new ResizeObserver(() => requestAnimationFrame(() => drawChart(canvas, pts, series)));
    ro.observe(canvas.parentElement);
    _chartObservers.push(ro);
  }
}

function drawChart(canvas, data, series) {
  if (!canvas || !data.length) return;
  const wrapper = canvas.parentElement;
  const W = wrapper.clientWidth  || wrapper.offsetWidth;
  const H = wrapper.clientHeight || wrapper.offsetHeight;
  if (!W || !H) return;  // layout not ready yet — ResizeObserver will retry

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const P = { t: 12, r: 12, b: 32, l: 72 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;

  // background
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);

  // y range
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
  const pad = (yMax - yMin) * 0.06;
  yMin -= pad; yMax += pad;
  const yRng = yMax - yMin;

  const toX = i => P.l + (i / (data.length - 1 || 1)) * cW;
  const toY = v => P.t + cH - ((v - yMin) / yRng) * cH;

  // grid lines + y labels
  const steps = 4;
  for (let g = 0; g <= steps; g++) {
    const yv = yMin + (g / steps) * yRng;
    const yp = toY(yv);
    ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l + cW, yp); ctx.stroke();
    ctx.fillStyle = '#555'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'right';
    const abs = Math.abs(yRng);
    const lbl = abs > 5e6 ? `₹${(yv/1e5).toFixed(1)}L`
              : abs > 1e4  ? `₹${(yv/1e3).toFixed(1)}K`
              : yv.toFixed(1);
    ctx.fillText(lbl, P.l - 5, yp + 3.5);
  }

  // zero line
  if (yMin < 0 && yMax > 0) {
    const yp = toY(0);
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l + cW, yp); ctx.stroke();
    ctx.setLineDash([]);
  }

  // x labels
  const xSteps = 4;
  for (let i = 0; i <= xSteps; i++) {
    const idx = Math.round((i / xSteps) * (data.length - 1));
    ctx.fillStyle = '#555'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'center';
    const d = new Date(data[idx].date);
    ctx.fillText(d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), toX(idx), H - P.b + 14);
  }

  // halt shading
  let inH = false, hS = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i].halted && !inH)  { inH = true; hS = i; }
    if (!data[i].halted && inH)  { ctx.fillStyle = 'rgba(248,113,113,0.05)'; ctx.fillRect(toX(hS), P.t, toX(i) - toX(hS), cH); inH = false; }
  }
  if (inH) { ctx.fillStyle = 'rgba(248,113,113,0.05)'; ctx.fillRect(toX(hS), P.t, toX(data.length-1)-toX(hS), cH); }

  // trade ticks
  const tradeDates = new Set(
    state.ledger.filter(r => r.type !== 'COMPOUND').map(r => r.date.substring(0, 13))
  );
  data.forEach((d, i) => {
    if (tradeDates.has(d.date.substring(0, 13))) {
      ctx.fillStyle = 'rgba(251,191,36,0.14)';
      ctx.fillRect(toX(i) - 0.5, P.t, 1, cH);
    }
  });

  // reinvestment markers
  data.forEach((d, i) => {
    if (!d.compoundEvent) return;
    const x = toX(i);
    ctx.strokeStyle = 'rgba(45,212,191,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(x, P.t); ctx.lineTo(x, P.t + cH); ctx.stroke();
    ctx.setLineDash([]);
  });

  // series lines
  for (const s of series) {
    const sc = s.scale ?? 1;
    ctx.beginPath();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    data.forEach((d, i) => {
      const x = toX(i), y = toY((d[s.key] ?? 0) * sc);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// ── Ledger ─────────────────────────────────────────────────────────────────
function renderLedger(a1, a2) {
  const ledger = state.ledger;
  if (!ledger.length) {
    $('ledgerWrap').innerHTML = '<div class="empty">No activity.</div>';
    $('ledgerCount').textContent = '';
    return;
  }

  const trades   = ledger.filter(r => r.type !== 'COMPOUND').length;
  const reinvest = ledger.filter(r => r.type === 'COMPOUND').length;
  $('ledgerCount').textContent = `${trades} trades · ${reinvest} reinvestments`;

  const rows = ledger.slice(-500);
  if (ledger.length > 500) {
    $('ledgerNote').textContent = `Showing last 500 of ${ledger.length} entries. Export CSV for full history.`;
    $('ledgerNote').classList.remove('hidden');
  } else {
    $('ledgerNote').classList.add('hidden');
  }

  const rowsHtml = rows.map(row => {
    if (row.type === 'COMPOUND') {
      return `<tr class="row-compound">
        <td>${fdt(row.date)}</td>
        <td colspan="5">
          <span class="compound-tag">REINVEST #${row.compoundEvent}</span>
          ${inr(row.reinvestAmt)} → pool · L: ${dec(row.lBefore,0)} → ${dec(row.lAfter,0)} · ${a1}: ${qty(row.xBefore)}→${qty(row.xAfter)} · ${a2}: ${qty(row.yBefore)}→${qty(row.yAfter)}
        </td>
        <td class="r up">+${inr(row.reinvestAmt)}</td>
        <td class="r">—</td>
        <td class="r">${inr(row.cashProfitAfter)}</td>
        <td class="r">${qty(row.xAfter)}</td>
        <td class="r">${qty(row.yAfter)}</td>
        <td class="r ${row.ilPct >= 0 ? 'up' : 'down'}">${dec(row.ilPct,2)}%</td>
      </tr>`;
    }
    return `<tr>
      <td>${fdt(row.date)}</td>
      <td>${row.action}</td>
      <td class="r">${qty(row.buyQty)}</td>
      <td class="r down">−${inr(row.cost)}</td>
      <td class="r">${qty(row.sellQty)}</td>
      <td class="r up">+${inr(row.revenue)}</td>
      <td class="r ${row.net >= 0 ? 'up' : 'down'}">${row.net >= 0 ? '+' : '−'}${inr(Math.abs(row.net))}</td>
      <td class="r down">−${inr(row.brok)}</td>
      <td class="r">${inr(row.cashProfit)}</td>
      <td class="r">${qty(row.poolX)}</td>
      <td class="r">${qty(row.poolY)}</td>
      <td class="r ${row.ilPct >= 0 ? 'up' : 'down'}">${dec(row.ilPct,2)}%</td>
    </tr>`;
  }).join('');

  $('ledgerWrap').innerHTML = `<table>
    <thead><tr>
      <th>Time</th><th>Action</th>
      <th class="r">Buy qty</th><th class="r">Cost</th>
      <th class="r">Sell qty</th><th class="r">Revenue</th>
      <th class="r">Net P&L</th><th class="r">Brokerage</th>
      <th class="r">Cash reserve</th>
      <th class="r">${a1}</th><th class="r">${a2}</th>
      <th class="r">Pool IL%</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

// ── Export ─────────────────────────────────────────────────────────────────
function exportCsv(ledger) {
  const h = ['Date','Type','Action','BuyQty','Cost_INR','SellQty','Revenue_INR',
             'Net_INR','Brokerage_INR','CashReserve_INR','ReinvestAmt_INR',
             'A1Shares','A2Shares','IL_Pct','Concentration','L'];
  const lines = [h.join(',')].concat(ledger.map(r => {
    if (r.type === 'COMPOUND') return [
      r.date, 'COMPOUND', '"Reinvestment"', '', '', '', '',
      '', '', dec(r.cashProfitAfter,2), dec(r.reinvestAmt,2),
      qty(r.xAfter).replace(/,/g,''), qty(r.yAfter).replace(/,/g,''),
      dec(r.ilPct,4), dec(r.concentration??0,2), dec(r.lAfter,2),
    ].join(',');
    return [
      r.date, 'TRADE', `"${r.action}"`,
      Math.round(r.buyQty), dec(r.cost,2),
      Math.round(r.sellQty), dec(r.revenue,2),
      dec(r.net,2), dec(r.brok,2), dec(r.cashProfit,2), '0',
      qty(r.poolX).replace(/,/g,''), qty(r.poolY).replace(/,/g,''),
      dec(r.ilPct,4), dec(r.concentration??0,2), dec(r.L??0,2),
    ].join(',');
  }));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'amm_ledger.csv' }).click();
  URL.revokeObjectURL(url);
}
