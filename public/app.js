import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = { ledger: [], results: null, equity: [], perf: null };
const $     = id => document.getElementById(id);
const inr   = v  => '₹' + Math.abs(+v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2  = v  => '₹' + Math.abs(+v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgn   = v  => +v >= 0 ? '+' : '−';
const pct   = (v, d=2) => `${+v >= 0 ? '+' : ''}${(+v).toFixed(d)}%`;
const dec   = (v, d=2) => (+v).toFixed(d);
const qty   = v  => Math.round(+v).toLocaleString('en-IN');
const fmtDt = s  => new Date(s).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' });

const asset1File  = $('asset1File');
const asset2File  = $('asset2File');
const runBtn      = $('runSimulation');
const dlBtn       = $('downloadCsv');
const pairHeading = $('pairHeading');
const haltBanner  = $('haltBanner');

asset1File.addEventListener('change', () => {
  $('asset1FileName').textContent = asset1File.files[0]?.name || 'Asset 1 — 1-min CSV';
});
asset2File.addEventListener('change', () => {
  $('asset2FileName').textContent = asset2File.files[0]?.name || 'Asset 2 — 1-min CSV';
});
$('asset1Label').addEventListener('input', updateHeading);
$('asset2Label').addEventListener('input', updateHeading);
dlBtn.addEventListener('click', () => downloadCsv(state.ledger));
runBtn.addEventListener('click', handleRun);
updateHeading();

function updateHeading() {
  pairHeading.textContent = `${$('asset1Label').value || 'Asset 1'}  ↔  ${$('asset2Label').value || 'Asset 2'}`;
}

function setStatus(type, msg) {
  const icons = { info: '◎', success: '✦', warning: '⚠', error: '✕' };
  const el = $('statusBanner');
  el.className = `status-banner status-${type}`;
  el.innerHTML = `<span class="sb-icon">${icons[type]||'◎'}</span><span>${msg}</span>`;
}

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

async function handleRun() {
  if (!asset1File.files[0] || !asset2File.files[0]) {
    setStatus('error', 'Please upload both CSV files first.'); return;
  }
  runBtn.disabled = true;
  runBtn.querySelector('.btn-label').textContent = 'Computing…';
  haltBanner.classList.add('hidden');
  setStatus('info', 'Solving optimal concentration range and running hourly simulation…');

  try {
    await new Promise(r => setTimeout(r, 20));
    const [t1, t2] = await Promise.all([asset1File.files[0].text(), asset2File.files[0].text()]);
    const result   = runAlmSimulation(parseCsv(t1), parseCsv(t2), +$('realCapital').value, getConfig());

    if (result.error) {
      setStatus('error', result.error); resetPanels();
    } else {
      state.ledger  = result.swaps;
      state.results = result.results;
      state.equity  = result.equityCurve;
      state.perf    = result.performanceSummary;

      renderSummaryCards();
      renderMiniStats();
      renderCharts();
      renderLedger();
      renderHaltBanner();

      const r = result.results;
      setStatus(
        r.vsHold >= 0 ? 'success' : 'warning',
        `Pool ${r.vsHold >= 0 ? 'outperforms' : 'underperforms'} buy-and-hold by ${inr(Math.abs(r.vsHold))} (${dec(r.vsHoldPct,2)}%)  ·  ` +
        `${r.totalSwaps} trades  ·  ${r.compoundEvents} reinvestments  ·  ${dec(r.concentrationFactor,1)}× avg concentration`
      );
    }
  } catch(e) {
    setStatus('error', e.message || 'Unexpected error.'); resetPanels();
  }
  runBtn.disabled = false;
  runBtn.querySelector('.btn-label').textContent = 'Run Simulation';
}

function resetPanels() {
  state.ledger = []; state.results = null; state.equity = []; state.perf = null;
  renderSummaryCards(); renderMiniStats(); renderLedger();
}

// ─── Halt banner ─────────────────────────────────────────────────────────────
function renderHaltBanner() {
  const r = state.results; haltBanner.classList.add('hidden');
  if (!r) return;
  if (r.swapsHalted && r.haltReason === 'IL_STOP') {
    haltBanner.innerHTML = `<span class="hb-icon">⛔</span><div class="hb-body"><strong>Hard Stop Active</strong><span>Swaps paused — unrealised loss exceeded the stop threshold.</span></div>`;
    haltBanner.className = 'halt-banner halted'; haltBanner.classList.remove('hidden');
  } else if (r.ilResumedAt) {
    haltBanner.innerHTML = `<span class="hb-icon">✅</span><div class="hb-body"><strong>Resumed</strong><span>Trading resumed after loss recovery${r.haltCount > 1 ? ` · ${r.haltCount} cycles` : ''}.</span></div>`;
    haltBanner.className = 'halt-banner resumed'; haltBanner.classList.remove('hidden');
  }
}

// ─── Summary hero cards ───────────────────────────────────────────────────────
function renderSummaryCards() {
  const el = $('summaryCards');
  if (!state.results) {
    el.innerHTML = '<div class="empty-state">Upload files and run simulation to see results</div>'; return;
  }
  const r  = state.results;
  const a1 = $('asset1Label').value || 'Asset 1';
  const a2 = $('asset2Label').value || 'Asset 2';

  const vsHoldPos  = r.vsHold >= 0;
  const cashPos    = r.cashProfit >= 0;
  const ilPos      = r.ilPct >= 0;
  const roiPos     = r.roiPct >= 0;

  el.innerHTML = `
    <!-- Row 1: Hero numbers -->
    <div class="hero-row">
      <div class="hero-card ${vsHoldPos ? 'hero-green' : 'hero-orange'}">
        <div class="hc-label">Total Return vs Buy &amp; Hold</div>
        <div class="hc-value">${sgn(r.vsHold)}${inr(r.vsHold)}</div>
        <div class="hc-pct ${vsHoldPos ? 'pos' : 'neg'}">${pct(r.vsHoldPct,2)} over holding period</div>
      </div>
      <div class="hero-card ${roiPos ? 'hero-blue' : 'hero-red'}">
        <div class="hc-label">Portfolio Return (AMM)</div>
        <div class="hc-value">${sgn(r.roiPct)}${dec(r.roiPct,2)}%</div>
        <div class="hc-pct muted">on ${inr(r.initCapital)} invested</div>
      </div>
      <div class="hero-card hero-neutral">
        <div class="hc-label">Buy &amp; Hold Return</div>
        <div class="hc-value">${sgn(r.holdRoi)}${dec(r.holdRoi,2)}%</div>
        <div class="hc-pct muted">if you had just held both stocks</div>
      </div>
    </div>

    <!-- Row 2: Breakdown -->
    <div class="breakdown-grid">
      <div class="bk-card">
        <div class="bk-icon">💰</div>
        <div class="bk-label">Cash Earned from Trading</div>
        <div class="bk-value pos">${inr(r.cashProfit)}</div>
        <div class="bk-sub">${dec(r.cashRoi,2)}% of capital · ${r.totalSwaps} profitable trades</div>
      </div>
      <div class="bk-card">
        <div class="bk-icon">♻</div>
        <div class="bk-label">Profits Reinvested</div>
        <div class="bk-value pos">${inr(r.reinvestedTotal)}</div>
        <div class="bk-sub">${r.compoundEvents} reinvestment events · compounded back into pool</div>
      </div>
      <div class="bk-card">
        <div class="bk-icon">📉</div>
        <div class="bk-label">Unrealised Loss (IL)</div>
        <div class="bk-value ${ilPos ? 'pos' : 'neg'}">${sgn(r.ilINR)}${inr(r.ilINR)}</div>
        <div class="bk-sub">${dec(r.ilPct,2)}% · pool assets vs hold value</div>
      </div>
      <div class="bk-card">
        <div class="bk-icon">💸</div>
        <div class="bk-label">Brokerage Paid</div>
        <div class="bk-value neg">−${inr(r.totalBrokerage)}</div>
        <div class="bk-sub">${dec(r.brokRoi,2)}% of capital</div>
      </div>
      <div class="bk-card">
        <div class="bk-icon">🎯</div>
        <div class="bk-label">AMM Pool Value</div>
        <div class="bk-value">${inr(r.totalValue)}</div>
        <div class="bk-sub">pool assets + cash reserve</div>
      </div>
      <div class="bk-card">
        <div class="bk-icon">📊</div>
        <div class="bk-label">Hold-Only Value</div>
        <div class="bk-value">${inr(r.holdValue)}</div>
        <div class="bk-sub">${a1} + ${a2} at current prices</div>
      </div>
    </div>

    <!-- Row 3: Execution stats (compact) -->
    <div class="stat-row">
      <div class="stat-chip"><span class="sc-label">Trades executed</span><span class="sc-val">${r.totalSwaps}</span></div>
      <div class="stat-chip"><span class="sc-label">Success rate</span><span class="sc-val">${dec(r.successRate*100,0)}%</span></div>
      <div class="stat-chip"><span class="sc-label">Reinvestments</span><span class="sc-val">${r.compoundEvents}</span></div>
      <div class="stat-chip"><span class="sc-label">Avg concentration</span><span class="sc-val">${dec(r.concentrationFactor,1)}×</span></div>
      <div class="stat-chip"><span class="sc-label">Range resets</span><span class="sc-val">${r.recenterCount}</span></div>
      <div class="stat-chip"><span class="sc-label">Gross fees earned</span><span class="sc-val">${inr(r.grossSwapFees)}</span></div>
      <div class="stat-chip"><span class="sc-label">${a1} shares</span><span class="sc-val">${qty(r.initialX)} → ${qty(r.finalX)}</span></div>
      <div class="stat-chip"><span class="sc-label">${a2} shares</span><span class="sc-val">${qty(r.initialY)} → ${qty(r.finalY)}</span></div>
    </div>
  `;
  dlBtn.classList.remove('hidden');
}

// ─── Mini perf stats (below charts) ──────────────────────────────────────────
function renderMiniStats() {
  const el = $('miniStats');
  if (!state.perf) { el.innerHTML = ''; return; }
  const p = state.perf;
  const badge = (ok, mid, bad, val) => val < ok ? 'badge-green' : val < mid ? 'badge-yellow' : 'badge-red';

  el.innerHTML = `
    <div class="mini-stat-grid">
      <div class="ms-box">
        <div class="ms-title">Trade Quality</div>
        <div class="ms-row"><span>Profitable trades</span><strong class="pos">${p.successfulSwaps} / ${p.totalSwaps}</strong></div>
        <div class="ms-row"><span>Success rate</span><strong>${dec(p.successRatePct,1)}%</strong></div>
        <div class="ms-row"><span>Gross fees</span><strong>${inr(p.grossFees)}</strong></div>
        <div class="ms-row"><span>Net after brokerage</span><strong>${inr(p.netSwapIncome)}</strong></div>
        <div class="ms-badge ${p.frictionRatio < 0.10 ? 'badge-green' : p.frictionRatio < 0.25 ? 'badge-yellow' : 'badge-red'}">${p.narrative.friction}</div>
      </div>
      <div class="ms-box">
        <div class="ms-title">Compounding Impact</div>
        <div class="ms-row"><span>Total reinvested</span><strong class="pos">${inr(p.reinvestedTotal)}</strong></div>
        <div class="ms-row"><span>Events fired</span><strong>${p.compoundEvents}</strong></div>
        <div class="ms-row"><span>Net alpha (final)</span><strong class="${p.netAlphaFinal>=0?'pos':'neg'}">${p.netAlphaFinal>=0?'+':''}${inr(p.netAlphaFinal)}</strong></div>
        <div class="ms-row"><span>Alpha Sharpe</span><strong>${dec(p.alphaSharpe,2)}</strong></div>
        <div class="ms-badge badge-blue">Profits reinvested → more L → higher fees</div>
      </div>
      <div class="ms-box">
        <div class="ms-title">Risk &amp; Drawdown</div>
        <div class="ms-row"><span>Max drawdown ₹</span><strong class="neg">−${inr(Math.abs(p.maxDrawdownINR))}</strong></div>
        <div class="ms-row"><span>Max drawdown %</span><strong class="neg">${dec(p.maxDrawdownPct,2)}%</strong></div>
        <div class="ms-row"><span>IL status</span><strong class="${p.unrealizedIL>=0?'pos':'neg'}">${p.narrative.ilStatus}</strong></div>
        <div class="ms-badge ${p.netAlphaFinal>=0?'badge-green':'badge-yellow'}">${p.narrative.concentration}</div>
      </div>
    </div>`;
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function renderCharts() {
  if (!state.equity.length) return;
  const step = Math.max(1, Math.floor(state.equity.length / 700));
  const s    = state.equity.filter((_, i) => i % step === 0);

  drawChart($('equityChart'), s, [
    { key: 'poolValue',  label: 'AMM Pool Value',  color: '#00d4ff' },
    { key: 'holdValue',  label: 'Buy & Hold',      color: '#7c6af7' },
    { key: 'cashProfit', label: 'Cash Earned',      color: '#00e5a0' },
  ], '₹ Value');

  drawChart($('alphaChart'), s, [
    { key: 'alphaINR', label: 'Net Profit vs Hold ₹', color: '#f5c842' },
    { key: 'ilPct',    label: 'Unrealised Loss % (×1000)', color: '#ff4e6a', scale: 1000 },
  ], 'Alpha / IL');
}

function drawChart(canvas, data, series, yLabel) {
  if (!canvas || !data.length) return;
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const P = { t: 32, r: 16, b: 46, l: 94 };
  const cW = W - P.l - P.r, cH = H - P.t - P.b;
  ctx.clearRect(0, 0, W, H);

  // bg
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgba(6,12,28,1)');
  bg.addColorStop(1, 'rgba(3,6,16,1)');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // y range
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const sc = s.scale ?? 1;
    for (const d of data) { const v=(d[s.key]??0)*sc; if(v<yMin)yMin=v; if(v>yMax)yMax=v; }
  }
  if (!isFinite(yMin)) yMin = 0;
  if (!isFinite(yMax)) yMax = 1;
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const pad = (yMax - yMin) * 0.05;
  yMin -= pad; yMax += pad;
  const yRng = yMax - yMin;

  const toX = i => P.l + (i / (data.length - 1 || 1)) * cW;
  const toY = v => P.t + cH - ((v - yMin) / yRng) * cH;

  // grid
  for (let g = 0; g <= 4; g++) {
    const yv = yMin + (g/4)*yRng, yp = toY(yv);
    ctx.strokeStyle='rgba(100,130,180,0.07)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(P.l, yp); ctx.lineTo(P.l+cW, yp); ctx.stroke();
    ctx.fillStyle='rgba(120,145,175,0.60)'; ctx.font='9.5px monospace'; ctx.textAlign='right';
    const abs = Math.abs(yRng);
    const lbl = abs > 5e6 ? `₹${(yv/1e5).toFixed(1)}L`
              : abs > 1e4 ? `₹${(yv/1e3).toFixed(1)}K`
              : yv.toFixed(1);
    ctx.fillText(lbl, P.l-5, yp+3.5);
  }
  // zero line
  if (yMin < 0 && yMax > 0) {
    const yp = toY(0);
    ctx.strokeStyle='rgba(180,200,220,0.18)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(P.l,yp); ctx.lineTo(P.l+cW,yp); ctx.stroke(); ctx.setLineDash([]);
  }
  // x labels
  for (let i=0; i<=5; i++) {
    const idx=Math.round((i/5)*(data.length-1));
    ctx.fillStyle='rgba(120,145,175,0.55)'; ctx.font='9px monospace'; ctx.textAlign='center';
    ctx.fillText(new Date(data[idx].date).toLocaleDateString('en-IN',{month:'short',day:'numeric'}), toX(idx), H-P.b+14);
  }
  // y label
  ctx.save(); ctx.translate(13,P.t+cH/2); ctx.rotate(-Math.PI/2);
  ctx.fillStyle='rgba(120,145,175,0.45)'; ctx.font='9px monospace'; ctx.textAlign='center';
  ctx.fillText(yLabel,0,0); ctx.restore();

  // halt shading
  let inH=false, hS=0;
  for (let i=0; i<data.length; i++) {
    if (data[i].halted&&!inH) { inH=true; hS=i; }
    if (!data[i].halted&&inH) { ctx.fillStyle='rgba(255,78,106,0.06)'; ctx.fillRect(toX(hS),P.t,toX(i)-toX(hS),cH); inH=false; }
  }
  if (inH) { ctx.fillStyle='rgba(255,78,106,0.06)'; ctx.fillRect(toX(hS),P.t,toX(data.length-1)-toX(hS),cH); }

  // SWAP markers (thin gold)
  const swapSet = new Set(state.ledger.filter(r=>r.type!=='COMPOUND').map(r=>r.date.substring(0,13)));
  data.forEach((d,i) => {
    if (swapSet.has(d.date.substring(0,13))) {
      ctx.fillStyle='rgba(245,200,66,0.15)'; ctx.fillRect(toX(i)-0.5,P.t,1,cH);
    }
  });

  // COMPOUND markers — teal vertical band + ♻ label
  data.forEach((d, i) => {
    if (d.compoundEvent) {
      const x = toX(i);
      // teal glow band
      const grad = ctx.createLinearGradient(x-4,0,x+4,0);
      grad.addColorStop(0,'rgba(0,229,160,0)');
      grad.addColorStop(0.5,'rgba(0,229,160,0.30)');
      grad.addColorStop(1,'rgba(0,229,160,0)');
      ctx.fillStyle=grad; ctx.fillRect(x-4,P.t,8,cH);
      // solid line
      ctx.strokeStyle='rgba(0,229,160,0.70)'; ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(x,P.t); ctx.lineTo(x,P.t+cH); ctx.stroke(); ctx.setLineDash([]);
      // ♻ label at top
      ctx.fillStyle='rgba(0,229,160,0.90)'; ctx.font='bold 10px sans-serif'; ctx.textAlign='center';
      ctx.fillText('♻', x, P.t+10);
    }
  });

  // series lines
  for (const s of series) {
    const sc = s.scale ?? 1;
    ctx.beginPath(); ctx.strokeStyle=s.color+'28'; ctx.lineWidth=5; ctx.lineJoin='round';
    data.forEach((d,i)=>{ const x=toX(i),y=toY((d[s.key]??0)*sc); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); }); ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle=s.color; ctx.lineWidth=1.6; ctx.lineJoin='round';
    data.forEach((d,i)=>{ const x=toX(i),y=toY((d[s.key]??0)*sc); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); }); ctx.stroke();
  }

  // legend
  let lx = P.l;
  // regular series
  for (const s of series) {
    ctx.fillStyle=s.color; ctx.fillRect(lx,13,14,3);
    ctx.fillStyle='rgba(180,200,220,0.80)'; ctx.font='9.5px monospace'; ctx.textAlign='left';
    ctx.fillText(s.label, lx+18, 18);
    lx += ctx.measureText(s.label).width + 36;
  }
  // compound legend
  ctx.strokeStyle='rgba(0,229,160,0.70)'; ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
  ctx.beginPath(); ctx.moveTo(lx,15); ctx.lineTo(lx+14,15); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='rgba(180,200,220,0.80)'; ctx.font='9.5px monospace'; ctx.textAlign='left';
  ctx.fillText('♻ Reinvestment', lx+18, 18);
}

// ─── Ledger ──────────────────────────────────────────────────────────────────
function renderLedger() {
  const el  = $('tableWrap');
  const cnt = $('swapCount');
  if (!state.ledger.length) {
    cnt.classList.add('hidden');
    el.innerHTML = '<div class="empty-state">No trades yet — run the simulation</div>'; return;
  }

  const a1    = $('asset1Label').value || 'Asset 1';
  const a2    = $('asset2Label').value || 'Asset 2';
  const total = state.ledger.length;
  const rows  = state.ledger.slice(-500);

  const swaps   = state.ledger.filter(r => r.type !== 'COMPOUND').length;
  const reinvest= state.ledger.filter(r => r.type === 'COMPOUND').length;
  cnt.textContent = `${swaps} trades · ${reinvest} reinvestments`;
  cnt.classList.remove('hidden');

  const note = total > 500
    ? `<p class="table-note">Showing last 500 of ${total} entries. Download CSV for full history.</p>`
    : '';

  const rowsHtml = rows.map(r => {
    if (r.type === 'COMPOUND') {
      return `<tr class="tr-compound">
        <td>${fmtDt(r.date)}</td>
        <td colspan="6">
          <span class="compound-badge">♻ REINVESTMENT #${r.compoundEvent}</span>
          ${inr(r.reinvestAmt)} profit converted to pool liquidity
          · L: ${dec(r.lBefore,0)} → ${dec(r.lAfter,0)}
          · ${a1}: ${qty(r.xBefore)} → ${qty(r.xAfter)}
          · ${a2}: ${qty(r.yBefore)} → ${qty(r.yAfter)}
        </td>
        <td class="r pos">${inr(r.reinvestAmt)}</td>
        <td class="r">—</td>
        <td class="r">—</td>
        <td class="r">${inr(r.cashProfitAfter)}</td>
        <td class="r">${qty(r.xAfter)}</td>
        <td class="r">${qty(r.yAfter)}</td>
        <td class="r ${r.ilPct>=0?'pos':'neg'}">${dec(r.ilPct,2)}%</td>
        <td class="r">${dec(r.concentration??0,1)}×</td>
      </tr>`;
    }
    return `<tr>
      <td>${fmtDt(r.date)}</td>
      <td><span class="action-badge ${r.action.includes('Asset 1')?'act-buy1':'act-buy2'}">${r.action}</span></td>
      <td>${r.buyAsset}</td>
      <td class="r">${qty(r.buyQty)}</td>
      <td class="r neg">−${inr2(r.cost)}</td>
      <td>${r.sellAsset}</td>
      <td class="r">${qty(r.sellQty)}</td>
      <td class="r pos">+${inr2(r.revenue)}</td>
      <td class="r ${r.gross>=0?'pos':'neg'}">${r.gross>=0?'+':'−'}${inr2(r.gross)}</td>
      <td class="r neg">−${inr2(r.brok)}</td>
      <td class="r ${r.net>=0?'pos':'neg'}">${r.net>=0?'+':'−'}${inr2(r.net)}</td>
      <td class="r">${inr(r.cashProfit)}</td>
      <td class="r">${qty(r.poolX)}</td>
      <td class="r">${qty(r.poolY)}</td>
      <td class="r ${r.ilPct>=0?'pos':'neg'}">${dec(r.ilPct,2)}%</td>
      <td class="r">${dec(r.concentration??0,1)}×</td>
    </tr>`;
  }).join('');

  el.innerHTML = note + `
    <div class="legend-row">
      <span class="leg-item"><span class="leg-dot swap-dot"></span>Trade (buy/sell)</span>
      <span class="leg-item"><span class="leg-dot comp-dot"></span>♻ Reinvestment — cash profit converted to pool liquidity</span>
    </div>
    <div class="tscroll"><table>
      <thead><tr>
        <th>Date &amp; Time</th>
        <th>Action</th>
        <th>Bought</th><th class="r">Qty</th><th class="r">Cost</th>
        <th>Sold</th><th class="r">Qty</th><th class="r">Revenue</th>
        <th class="r">Gross P&amp;L</th>
        <th class="r">Brokerage</th>
        <th class="r">Net Profit</th>
        <th class="r">Cash Reserve</th>
        <th class="r">${a1}</th>
        <th class="r">${a2}</th>
        <th class="r">Pool IL%</th>
        <th class="r">Concentration</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`;
}

// ─── Download CSV ─────────────────────────────────────────────────────────────
function downloadCsv(rows) {
  const h = ['Date','Type','Action','BuyAsset','BuyQty','Cost_INR','SellAsset','SellQty',
             'Revenue_INR','Gross_INR','Brokerage_INR','Net_INR','CashReserve_INR',
             'ReinvestAmt_INR','A1Shares','A2Shares','IL_Pct','Concentration','L'];
  const lines = [h.join(',')].concat(rows.map(r => {
    if (r.type === 'COMPOUND') return [
      r.date,'COMPOUND','"♻ Reinvestment"','','','','','','','','','',
      dec(r.cashProfitAfter,2), dec(r.reinvestAmt,2),
      qty(r.xAfter).replace(/,/g,''), qty(r.yAfter).replace(/,/g,''),
      dec(r.ilPct,4), dec(r.concentration??0,2), dec(r.lAfter,2),
    ].join(',');
    return [
      r.date,'TRADE',`"${r.action}"`,r.buyAsset,Math.round(r.buyQty),dec(r.cost,2),
      r.sellAsset,Math.round(r.sellQty),dec(r.revenue,2),
      dec(r.gross,2),dec(r.brok,2),dec(r.net,2),dec(r.cashProfit,2),
      '0', qty(r.poolX).replace(/,/g,''), qty(r.poolY).replace(/,/g,''),
      dec(r.ilPct,4),dec(r.concentration??0,2),dec(r.L??0,2),
    ].join(',');
  }));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href:url, download:'amm_v4_ledger.csv' }).click();
  URL.revokeObjectURL(url);
}
