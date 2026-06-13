import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = { ledger: [], results: null, equity: [] };
const $   = id => document.getElementById(id);
const inr = v  => '₹' + Math.abs(+v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const pct = (v, d=2) => `${+v >= 0 ? '+' : ''}${(+v).toFixed(d)}%`;
const dec = (v, d=2) => (+v).toFixed(d);
const qty = v  => Math.round(+v).toLocaleString('en-IN');
const sgn = v  => +v >= 0 ? '+' : '−';
const fdt = s  => {
  const d = new Date(s);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
};

$('asset1File').addEventListener('change', e => {
  $('asset1FileName').textContent = e.target.files[0]?.name || '';
});
$('asset2File').addEventListener('change', e => {
  $('asset2FileName').textContent = e.target.files[0]?.name || '';
});
$('asset1Label').addEventListener('input', updateHeading);
$('asset2Label').addEventListener('input', updateHeading);
$('runSimulation').addEventListener('click', handleRun);
$('exportBtn').addEventListener('click', () => exportCsv(state.ledger));
updateHeading();

function updateHeading() {
  $('pairHeading').textContent =
    `${$('asset1Label').value || 'Asset 1'}  ↔  ${$('asset2Label').value || 'Asset 2'}`;
}

function setStatus(type, msg) {
  const el = $('statusBar');
  el.className = 'status' + (type ? ' ' + type : '');
  el.textContent = msg;
}

function getConfig() {
  return {
    bandPct:               +$('bandPct').value,
    buyBrokeragePct:       +$('buyBrokeragePct').value,
    sellBrokeragePct:      +$('sellBrokeragePct').value,
    reinvestBrokeragePct:  +$('reinvestBrokeragePct').value,
    minTradeValue:         +$('minTradeValue').value,
    ilHardStopPct:         +$('ilHardStopPct').value,
    ilHardResumePct:       +$('ilHardResumePct').value,
    compoundIntervalHours: +$('compoundIntervalHours').value,
    compoundMinPct:        +$('compoundMinPct').value,
  };
}

async function handleRun() {
  const f1 = $('asset1File').files[0], f2 = $('asset2File').files[0];
  if (!f1 || !f2) { setStatus('err', 'Upload both CSV files first.'); return; }

  const btn = $('runSimulation');
  btn.disabled = true; btn.textContent = 'Running…';
  setStatus('', 'Running backtest…');
  $('emptyState').classList.remove('hidden');
  $('resultsSection').classList.add('hidden');

  try {
    await new Promise(r => setTimeout(r, 16));
    const [t1, t2] = await Promise.all([f1.text(), f2.text()]);
    const res = runAlmSimulation(parseCsv(t1), parseCsv(t2), +$('realCapital').value, getConfig());

    if (res.error) {
      setStatus('err', res.error);
    } else {
      state.ledger  = res.swaps;
      state.results = res.results;
      state.equity  = res.equityCurve;

      const r  = res.results;
      const a1 = $('asset1Label').value || 'Asset 1';
      const a2 = $('asset2Label').value || 'Asset 2';
      $('pairHeading').textContent = `${a1}  ↔  ${a2}`;

      renderHero(r);
      renderStats(r, a1, a2);
      renderPerf(res.performanceSummary);
      renderCharts();
      renderLedger(a1, a2);

      $('resultsSection').classList.remove('hidden');
      $('emptyState').classList.add('hidden');

      const beat = r.vsHold >= 0;
      setStatus(
        beat ? 'ok' : 'warn',
        `${beat ? 'Outperforms' : 'Underperforms'} buy-and-hold by ${inr(Math.abs(r.vsHold))} (${dec(r.vsHoldPct, 2)}%)` +
        `  ·  ${r.totalTrades} rebalances  ·  ${r.compoundEvents} reinvestments` +
        `  ·  Net cash: ${r.cashProfit >= 0 ? '+' : ''}${inr(r.cashProfit)}`
      );
    }
  } catch(e) {
    setStatus('err', e.message || 'Unexpected error.');
  }
  btn.disabled = false; btn.textContent = 'Run Backtest';
}

// ── Hero ───────────────────────────────────────────────────────────────────
function renderHero(r) {
  $('heroRow').innerHTML = `
    <div class="hero-cell">
      <div class="hero-label">Strategy vs Buy &amp; Hold</div>
      <div class="hero-value ${r.vsHold >= 0 ? 'up' : 'down'}">${sgn(r.vsHold)}${inr(Math.abs(r.vsHold))}</div>
      <div class="hero-sub">${pct(r.vsHoldPct, 2)} over the period</div>
    </div>
    <div class="hero-cell">
      <div class="hero-label">Strategy Return</div>
      <div class="hero-value ${r.roiPct >= 0 ? 'up' : 'down'}">${pct(r.roiPct, 2)}</div>
      <div class="hero-sub">on ${inr(r.initCapital)} deployed</div>
    </div>
    <div class="hero-cell">
      <div class="hero-label">Buy &amp; Hold Return</div>
      <div class="hero-value">${pct(r.holdRoi, 2)}</div>
      <div class="hero-sub">if you never rebalanced</div>
    </div>`;
}

// ── Stats ──────────────────────────────────────────────────────────────────
function renderStats(r, a1, a2) {
  const cells = [
    { label: 'Cash profit from rebalancing', value: (r.cashProfit >= 0 ? '+' : '') + inr(r.cashProfit), cls: r.cashProfit >= 0 ? 'up' : 'down' },
    { label: 'Gross trading P&L',            value: (r.grossTotal >= 0 ? '+' : '') + inr(r.grossTotal),  cls: r.grossTotal >= 0 ? 'up' : 'down' },
    { label: 'Total brokerage paid',         value: '−' + inr(r.totalBrokerage),  cls: 'down' },
    { label: 'Reinvestment brokerage',       value: '−' + inr(r.totalReinvestBrokerage ?? 0), cls: 'down' },
    { label: 'Cash reinvested into pool',    value: inr(r.reinvestedTotal ?? 0),  cls: r.reinvestedTotal > 0 ? 'teal' : '' },
    { label: 'Reinvestment events',          value: r.compoundEvents,             cls: r.compoundEvents > 0 ? 'teal' : '' },
    { label: 'Portfolio IL',                 value: pct(r.ilPct, 2),             cls: r.ilPct >= 0 ? 'up' : 'down' },
    { label: 'IL in ₹',                      value: (r.ilINR >= 0 ? '+' : '') + inr(r.ilINR), cls: r.ilINR >= 0 ? 'up' : 'down' },
    { label: 'Pool asset value',             value: inr(r.poolAssets),           cls: '' },
    { label: 'Total portfolio value',        value: inr(r.totalValue),           cls: '' },
    { label: 'Rebalances executed',          value: r.totalTrades,               cls: '' },
    { label: 'Profitable rebalances',        value: `${r.profitableTrades} (${dec(r.successRate*100,0)}%)`, cls: r.successRate >= 0.5 ? 'up' : 'down' },
    { label: 'Unprofitable rebalances',      value: r.unprofitableTrades ?? 0,   cls: (r.unprofitableTrades ?? 0) > 0 ? 'down' : '' },
    { label: 'Skipped (too small / risky)',  value: r.skippedTrades ?? 0,        cls: '' },
    { label: `${a1} shares`,                value: `${qty(r.initialX)} → ${qty(r.finalX)}`, cls: '' },
    { label: `${a2} shares`,                value: `${qty(r.initialY)} → ${qty(r.finalY)}`, cls: '' },
  ];

  $('statGrid').innerHTML = cells.map(c =>
    `<div class="stat-cell">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls || ''}">${c.value}</div>
    </div>`
  ).join('');
  $('exportBtn').classList.remove('hidden');
}

// ── Performance panel ──────────────────────────────────────────────────────
function renderPerf(p) {
  if (!p) return;
  $('perfPanel').innerHTML = `
    <div class="mini-stat-grid">
      <div class="ms-box">
        <div class="ms-title">Trading Edge</div>
        <div class="ms-row"><span>Gross P&amp;L</span><strong class="${p.grossTotal >= 0 ? 'pos' : 'neg'}">${p.grossTotal >= 0 ? '+' : ''}${inr(p.grossTotal)}</strong></div>
        <div class="ms-row"><span>Brokerage friction</span><strong class="neg">−${inr(p.brokTotal)}</strong></div>
        <div class="ms-row"><span>Net cash</span><strong class="${p.netCash >= 0 ? 'pos' : 'neg'}">${p.netCash >= 0 ? '+' : ''}${inr(p.netCash)}</strong></div>
        <div class="ms-row"><span>Friction ratio</span><strong>${dec(p.frictionPct, 1)}% of gross</strong></div>
        <div class="ms-badge ${p.frictionRatio < 0.40 ? 'badge-green' : p.frictionRatio < 0.80 ? 'badge-yellow' : 'badge-red'}">${p.narrative.friction}</div>
      </div>
      <div class="ms-box">
        <div class="ms-title">Rebalance Quality</div>
        <div class="ms-row"><span>Total rebalances</span><strong>${p.totalTrades}</strong></div>
        <div class="ms-row"><span>Profitable</span><strong class="pos">${p.profitable} (${dec(p.successPct, 0)}%)</strong></div>
        <div class="ms-row"><span>Alpha Sharpe</span><strong>${dec(p.alphaSharpe, 2)}</strong></div>
        <div class="ms-badge ${p.successRate > 0.55 ? 'badge-green' : p.successRate > 0.45 ? 'badge-yellow' : 'badge-red'}">${p.narrative.quality}</div>
      </div>
      <div class="ms-box">
        <div class="ms-title">Risk</div>
        <div class="ms-row"><span>Max drawdown</span><strong class="neg">−${inr(Math.abs(p.maxDrawdownINR))}</strong></div>
        <div class="ms-row"><span>Max drawdown %</span><strong class="neg">${dec(p.maxDrawdownPct, 2)}%</strong></div>
        <div class="ms-row"><span>Reinvested</span><strong class="teal">${inr(p.reinvestedTotal)}</strong></div>
        <div class="ms-badge badge-blue">${p.narrative.alpha}</div>
      </div>
    </div>`;
}

// ── Charts ─────────────────────────────────────────────────────────────────
const _obs = [];
function renderCharts() {
  _obs.forEach(o => o.disconnect()); _obs.length = 0;
  if (!state.equity.length) return;

  const step = Math.max(1, Math.floor(state.equity.length / 600));
  const pts  = state.equity.filter((_, i) => i % step === 0);

  $('legend1').innerHTML = `
    <div class="leg"><div class="leg-line" style="background:#60a5fa"></div>Strategy</div>
    <div class="leg"><div class="leg-line" style="background:#555"></div>Buy &amp; Hold</div>
    <div class="leg"><div class="leg-line" style="background:#4ade80"></div>Cash Profit</div>
    <div class="leg"><div class="leg-dash"></div>Reinvestment</div>`;
  $('legend2').innerHTML = `
    <div class="leg"><div class="leg-line" style="background:#fbbf24"></div>Alpha vs Hold</div>
    <div class="leg"><div class="leg-line" style="background:#f87171"></div>IL %×100</div>
    <div class="leg"><div class="leg-dash"></div>Reinvestment</div>`;

  [
    { id: 'chart1', series: [
        { key: 'poolValue',  color: '#60a5fa' },
        { key: 'holdValue',  color: '#555' },
        { key: 'cashProfit', color: '#4ade80' },
      ]},
    { id: 'chart2', series: [
        { key: 'alphaINR', color: '#fbbf24' },
        { key: 'ilPct',    color: '#f87171', scale: 100 },
      ]},
  ].forEach(({ id, series }) => {
    const canvas = $(id); if (!canvas) return;
    requestAnimationFrame(() => drawChart(canvas, pts, series));
    const ro = new ResizeObserver(() => requestAnimationFrame(() => drawChart(canvas, pts, series)));
    ro.observe(canvas.parentElement);
    _obs.push(ro);
  });
}

function drawChart(canvas, data, series) {
  const wrapper = canvas.parentElement;
  const W = wrapper.clientWidth || wrapper.offsetWidth;
  const H = wrapper.clientHeight || wrapper.offsetHeight;
  if (!W || !H) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const P = { t: 12, r: 12, b: 32, l: 72 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;

  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);

  // y range
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const sc = s.scale ?? 1;
    for (const d of data) { const v = (d[s.key] ?? 0) * sc; if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
  }
  if (!isFinite(yMin)) yMin = 0; if (!isFinite(yMax)) yMax = 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.05;
  yMin -= pad; yMax += pad;
  const yRng = yMax - yMin;
  const toX = i => P.l + (i / (data.length - 1 || 1)) * cW;
  const toY = v => P.t + cH - ((v - yMin) / yRng) * cH;

  // grid
  for (let g = 0; g <= 4; g++) {
    const yv = yMin + (g/4) * yRng, yp = toY(yv);
    ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l + cW, yp); ctx.stroke();
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    const abs = Math.abs(yRng);
    const lbl = abs > 5e6 ? `₹${(yv/1e5).toFixed(1)}L` : abs > 1e4 ? `₹${(yv/1e3).toFixed(1)}K` : yv.toFixed(1);
    ctx.fillText(lbl, P.l - 5, yp + 3.5);
  }

  // zero line
  if (yMin < 0 && yMax > 0) {
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(P.l, toY(0)); ctx.lineTo(P.l + cW, toY(0)); ctx.stroke();
    ctx.setLineDash([]);
  }

  // x labels
  for (let i = 0; i <= 4; i++) {
    const idx = Math.round((i/4) * (data.length - 1));
    ctx.fillStyle = '#555'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(new Date(data[idx].date).toLocaleDateString('en-IN',{day:'numeric',month:'short'}), toX(idx), H - P.b + 14);
  }

  // halt shading
  let inH = false, hS = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i].halted && !inH)  { inH = true; hS = i; }
    if (!data[i].halted && inH)  { ctx.fillStyle='rgba(248,113,113,0.06)'; ctx.fillRect(toX(hS), P.t, toX(i)-toX(hS), cH); inH=false; }
  }
  if (inH) { ctx.fillStyle='rgba(248,113,113,0.06)'; ctx.fillRect(toX(hS),P.t,toX(data.length-1)-toX(hS),cH); }

  // rebalance ticks
  const tradeDates = new Set(state.ledger.filter(r=>r.type==='TRADE').map(r=>r.date.substring(0,13)));
  data.forEach((d, i) => {
    if (tradeDates.has(d.date.substring(0,13))) { ctx.fillStyle='rgba(251,191,36,0.12)'; ctx.fillRect(toX(i)-0.5,P.t,1,cH); }
  });

  // reinvestment markers
  data.forEach((d, i) => {
    if (!d.compoundEvent) return;
    const x = toX(i);
    ctx.strokeStyle='rgba(45,212,191,0.6)'; ctx.lineWidth=1; ctx.setLineDash([3,4]);
    ctx.beginPath(); ctx.moveTo(x,P.t); ctx.lineTo(x,P.t+cH); ctx.stroke(); ctx.setLineDash([]);
  });

  // series
  for (const s of series) {
    const sc = s.scale ?? 1;
    ctx.beginPath(); ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    data.forEach((d,i) => { const x=toX(i), y=toY((d[s.key]??0)*sc); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
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

  const trades   = ledger.filter(r => r.type === 'TRADE').length;
  const reinvest = ledger.filter(r => r.type === 'COMPOUND').length;
  $('ledgerCount').textContent = `${trades} rebalances · ${reinvest} reinvestments`;

  const rows = ledger.slice(-500);
  if (ledger.length > 500) {
    $('ledgerNote').textContent = `Showing last 500 of ${ledger.length}. Export CSV for full history.`;
    $('ledgerNote').classList.remove('hidden');
  } else {
    $('ledgerNote').classList.add('hidden');
  }

  const html = rows.map(row => {
    if (row.type === 'COMPOUND') {
      return `<tr class="row-compound">
        <td>${fdt(row.date)}</td>
        <td colspan="5">
          <span class="compound-tag">REINVEST #${row.compoundEvent}</span>
          Gross ₹${inr(row.grossReinvest)} · Brok ₹${inr(row.brokReinvest)} · Net ₹${inr(row.netReinvest)}
          · Bought ${qty(row.buyX)} ${a1} + ${qty(row.buyY)} ${a2}
        </td>
        <td class="r up">+${inr(row.netReinvest)}</td>
        <td class="r down">−${inr(row.brokReinvest)}</td>
        <td class="r">${inr(row.cashProfitAfter)}</td>
        <td class="r">${qty(row.xShares)}</td>
        <td class="r">${qty(row.yShares)}</td>
        <td class="r">—</td>
        <td class="r">—</td>
      </tr>`;
    }
    return `<tr>
      <td>${fdt(row.date)}</td>
      <td>${row.action}</td>
      <td class="r">${qty(row.sellQty)}</td>
      <td class="r down">−${inr(row.sellValue)}</td>
      <td class="r">${qty(row.buyQty)}</td>
      <td class="r up">+${inr(row.buyValue)}</td>
      <td class="r ${row.gross >= 0 ? 'up' : 'down'}">${row.gross >= 0 ? '+' : '−'}${inr(Math.abs(row.gross))}</td>
      <td class="r down">−${inr(row.brok)}</td>
      <td class="r">${inr(row.cashProfit)}</td>
      <td class="r">${qty(row.xShares)}</td>
      <td class="r">${qty(row.yShares)}</td>
      <td class="r ${row.poolIL >= 0 ? 'up' : 'down'}">${dec(row.poolIL, 2)}%</td>
      <td class="r">${dec(row.xDrift, 1)}%</td>
    </tr>`;
  }).join('');

  $('ledgerWrap').innerHTML = `
    <div class="legend-row">
      <span class="leg-item"><span class="leg-dot swap-dot"></span>Rebalance</span>
      <span class="leg-item"><span class="leg-dot comp-dot"></span>Reinvestment</span>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th>Time</th><th>Action</th>
        <th class="r">Sell qty</th><th class="r">Sell value</th>
        <th class="r">Buy qty</th><th class="r">Buy value</th>
        <th class="r">Gross P&amp;L</th><th class="r">Brokerage</th>
        <th class="r">Cash reserve</th>
        <th class="r">${a1}</th><th class="r">${a2}</th>
        <th class="r">IL%</th><th class="r">Drift%</th>
      </tr></thead>
      <tbody>${html}</tbody>
    </table></div>`;
}

// ── Export ─────────────────────────────────────────────────────────────────
function exportCsv(ledger) {
  const h = ['Date','Type','Action','SellQty','SellValue_INR','BuyQty','BuyValue_INR',
             'Gross_INR','Brokerage_INR','Net_INR','CashReserve_INR',
             'ReinvestGross_INR','ReinvestBrok_INR','A1Shares','A2Shares',
             'IL_Pct','Drift_Pct','EWMA_Vol_Pct'];
  const lines = [h.join(',')].concat(ledger.map(r => {
    if (r.type === 'COMPOUND') return [
      r.date,'COMPOUND','"Reinvestment"','','','','','','','',
      dec(r.cashProfitAfter,2), dec(r.grossReinvest,2), dec(r.brokReinvest,2),
      r.xShares, r.yShares, '', '', '',
    ].join(',');
    return [
      r.date, 'TRADE', `"${r.action}"`,
      r.sellQty, dec(r.sellValue,2), r.buyQty, dec(r.buyValue,2),
      dec(r.gross,2), dec(r.brok,2), dec(r.net,2), dec(r.cashProfit,2),
      '','', r.xShares, r.yShares,
      dec(r.poolIL,4), dec(r.xDrift,2), dec(r.ewmaVolPct ?? 0, 4),
    ].join(',');
  }));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: 'strategy_ledger.csv' }).click();
  URL.revokeObjectURL(url);
}
