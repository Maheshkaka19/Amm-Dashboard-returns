import { parseCsv, runAlmSimulation, pairFitness } from './simulation-core.js';

const state = { ledger: [], results: null, equity: [] };
const $   = id => document.getElementById(id);
const inr = v  => '₹' + Math.abs(+v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const pct = (v, d=2) => `${+v >= 0 ? '+' : ''}${(+v).toFixed(d)}%`;
const dec = (v, d=2) => (+v).toFixed(d);
const qty = v  => Math.round(+v).toLocaleString('en-IN');
const sgn = v  => +v >= 0 ? '+' : '−';
const fdt = s  => {
  const d = new Date(s);
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' }) + ' ' +
         d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:false });
};

$('asset1File').addEventListener('change', e => {
  $('asset1FileName').textContent = e.target.files[0]?.name || ''; maybeRunFitness();
});
$('asset2File').addEventListener('change', e => {
  $('asset2FileName').textContent = e.target.files[0]?.name || ''; maybeRunFitness();
});
$('asset1Label').addEventListener('input', updateHeading);
$('asset2Label').addEventListener('input', updateHeading);
$('runSimulation').addEventListener('click', handleRun);
$('exportBtn').addEventListener('click', () => exportCsv(state.ledger));
function updateHeading() {
  $('pairHeading').textContent = `${$('asset1Label').value||'Asset 1'} ↔ ${$('asset2Label').value||'Asset 2'}`;
}

async function maybeRunFitness() {
  const f1 = $('asset1File').files[0], f2 = $('asset2File').files[0];
  if (!f1 || !f2) return;
  try {
    const [t1, t2] = await Promise.all([f1.text(), f2.text()]);
    renderFitness(pairFitness(parseCsv(t1), parseCsv(t2)));
  } catch(e) {}
}

function renderFitness(fit) {
  const el = $('fitnessPanel'); if (!el || fit?.error) return;
  const col = { green:'#4ade80', yellow:'#fbbf24', orange:'#fb923c', red:'#f87171' }[fit.colour] || '#888';
  el.innerHTML = `<div class="fitness-bar">
    <div class="fitness-verdict" style="color:${col}">${fit.verdict}</div>
    <div class="fitness-stats">
      <span>Hurst: <strong style="color:${col}">${fit.hurst}</strong></span>
      <span>Ratio drift: <strong>${fit.ratioDrift}%</strong></span>
      <span>Mean crossings: <strong>${fit.crossingRate}%/bar</strong></span>
      <span>Lag-1 autocorr: <strong>${fit.autocorr1}</strong></span>
      <span>Bars: <strong>${fit.bars.toLocaleString('en-IN')}</strong></span>
    </div>
    <div class="fitness-explain">
      ${fit.hurst < 0.45 ? '✓ Hurst below 0.45 — pair is mean-reverting, strategy should profit.'
        : fit.hurst < 0.50 ? '~ Hurst near 0.5 — weak mean-reversion, expect modest returns.'
        : '✗ Hurst above 0.5 — pair is trending. Expect underperformance vs hold.'}
    </div>
  </div>`;
  el.classList.remove('hidden');
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
    compoundIntervalHours: +$('compoundIntervalHours').value,
    ilHardStopPct:         +$('ilHardStopPct').value,
    ilHardResumePct:       +$('ilHardResumePct').value,
  };
}

async function handleRun() {
  const f1 = $('asset1File').files[0], f2 = $('asset2File').files[0];
  if (!f1 || !f2) { setStatus('err', 'Upload both CSV files first.'); return; }
  const btn = $('runSimulation');
  btn.disabled = true; btn.textContent = 'Running…';
  setStatus('', 'Running…');
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
      $('pairHeading').textContent = `${a1} ↔ ${a2}`;

      renderHero(r);
      renderDiagnostics(res.performanceSummary, r);
      renderStats(r, a1, a2);
      renderCharts();
      renderLedger(a1, a2);

      $('resultsSection').classList.remove('hidden');
      $('emptyState').classList.add('hidden');

      setStatus(r.vsHold >= 0 ? 'ok' : 'warn',
        `${r.vsHold >= 0 ? 'Outperforms' : 'Underperforms'} hold by ${inr(Math.abs(r.vsHold))} (${dec(r.vsHoldPct,2)}%)` +
        `  ·  ${r.totalTrades} trades  ·  ${r.vaultDeposits} vault deposits` +
        `  ·  max swap ${res.performanceSummary.maxSizePct}% of pool`);
    }
  } catch(e) { setStatus('err', e.message || 'Error.'); }
  btn.disabled = false; btn.textContent = 'Run Backtest';
}

function renderHero(r) {
  $('heroRow').innerHTML = `
    <div class="hero-cell">
      <div class="hero-label">Total Return vs Buy &amp; Hold</div>
      <div class="hero-value ${r.vsHold>=0?'up':'down'}">${sgn(r.vsHold)}${inr(Math.abs(r.vsHold))}</div>
      <div class="hero-sub">${pct(r.vsHoldPct,2)} over the period</div>
    </div>
    <div class="hero-cell">
      <div class="hero-label">Strategy Total Return</div>
      <div class="hero-value ${r.roiPct>=0?'up':'down'}">${pct(r.roiPct,2)}</div>
      <div class="hero-sub">on ${inr(r.initCapital)} deployed</div>
    </div>
    <div class="hero-cell">
      <div class="hero-label">Buy &amp; Hold Return</div>
      <div class="hero-value">${pct(r.holdRoi,2)}</div>
      <div class="hero-sub">if you never traded</div>
    </div>`;
}

// ── Diagnostics panel — the core deliverable for this request ────────────────
function renderDiagnostics(p, r) {
  const thrashOK = p.thrashCount === 0;
  $('diagnosticsPanel').innerHTML = `
    <div class="diag-grid">
      <div class="diag-box ${thrashOK ? 'diag-good' : 'diag-bad'}">
        <div class="diag-title">Swap Sizing Health</div>
        <div class="diag-row"><span>Median swap size</span><strong>${p.medianSizePct}% of pool</strong></div>
        <div class="diag-row"><span>Max swap size</span><strong>${p.maxSizePct}% of pool</strong></div>
        <div class="diag-row"><span>Thrashing events (&gt;20%)</span><strong class="${thrashOK?'pos':'neg'}">${p.thrashCount}</strong></div>
        <div class="diag-note">${p.narrative.sizing}</div>
      </div>
      <div class="diag-box">
        <div class="diag-title">Trading Edge</div>
        <div class="diag-row"><span>Gross P&amp;L</span><strong class="${p.grossTotal>=0?'pos':'neg'}">${p.grossTotal>=0?'+':''}${inr(p.grossTotal)}</strong></div>
        <div class="diag-row"><span>Brokerage</span><strong class="neg">−${inr(p.brokTotal)}</strong></div>
        <div class="diag-row"><span>Net</span><strong class="${p.netTotal>=0?'pos':'neg'}">${p.netTotal>=0?'+':''}${inr(p.netTotal)}</strong></div>
        <div class="diag-row"><span>Friction ratio</span><strong>${dec(p.frictionPct,1)}%</strong></div>
        <div class="diag-note">${p.narrative.friction}</div>
      </div>
      <div class="diag-box">
        <div class="diag-title">Vault (Realised Profit)</div>
        <div class="diag-row"><span>Vault value</span><strong class="teal">${inr(p.vaultValue)}</strong></div>
        <div class="diag-row"><span>Deposits made</span><strong>${p.vaultDeposits}</strong></div>
        <div class="diag-row"><span>IL (pool+vault vs hold)</span><strong class="${r.ilPct>=0?'pos':'neg'}">${pct(r.ilPct,2)}</strong></div>
        <div class="diag-note">Vault profit is locked — never re-exposed to IL.</div>
      </div>
      <div class="diag-box">
        <div class="diag-title">Trade Quality</div>
        <div class="diag-row"><span>Total trades</span><strong>${p.totalTrades}</strong></div>
        <div class="diag-row"><span>Profitable</span><strong class="pos">${p.profitable} (${dec(p.successPct,0)}%)</strong></div>
        <div class="diag-row"><span>Alpha Sharpe</span><strong>${dec(p.alphaSharpe,2)}</strong></div>
        <div class="diag-note">${p.narrative.quality}</div>
      </div>
    </div>`;
}

function renderStats(r, a1, a2) {
  const cells = [
    { label:'Total value (pool+vault+cash)', value: inr(r.totalValue), cls:'' },
    { label:'Pool asset value',               value: inr(r.poolFinal), cls:'' },
    { label:'Vault value (locked)',           value: inr(r.vaultFinal), cls:'teal' },
    { label:'Cash reserve',                   value: inr(r.cashProfit), cls: r.cashProfit>=0?'up':'down' },
    { label:'Total brokerage paid',           value: '−'+inr(r.totalBrokerage), cls:'down' },
    { label:'Trades executed',                value: r.totalTrades, cls:'' },
    { label:'Vault deposits',                 value: r.vaultDeposits, cls:'teal' },
    { label:'Band adjustments (vault→pool)',  value: r.vaultAdjustments, cls:'' },
    { label:'Band adjustments (pool→vault)',  value: r.poolAdjustments, cls:'' },
    { label:`Pool ${a1} shares`,             value: qty(r.poolX), cls:'' },
    { label:`Pool ${a2} shares`,             value: qty(r.poolY), cls:'' },
    { label:`Vault ${a1} shares`,            value: qty(r.vaultX), cls:'teal' },
    { label:`Vault ${a2} shares`,            value: qty(r.vaultY), cls:'teal' },
  ];
  $('statGrid').innerHTML = cells.map(c =>
    `<div class="stat-cell"><div class="stat-label">${c.label}</div><div class="stat-value ${c.cls}">${c.value}</div></div>`
  ).join('');
  $('exportBtn').classList.remove('hidden');
}

// ── Charts ─────────────────────────────────────────────────────────────────
const _obs = [];
function renderCharts() {
  _obs.forEach(o => o.disconnect()); _obs.length = 0;
  if (!state.equity.length) return;
  const step = Math.max(1, Math.floor(state.equity.length / 800));
  const pts  = state.equity.filter((_,i) => i % step === 0);

  $('legend1').innerHTML = `
    <div class="leg"><div class="leg-line" style="background:#60a5fa"></div>Total Value</div>
    <div class="leg"><div class="leg-line" style="background:#555"></div>Buy &amp; Hold</div>
    <div class="leg"><div class="leg-line" style="background:#2dd4bf"></div>Vault</div>
    <div class="leg"><div class="leg-line" style="background:#4ade80"></div>Cash</div>`;
  $('legend2').innerHTML = `
    <div class="leg"><div class="leg-line" style="background:#fbbf24"></div>Alpha vs Hold</div>
    <div class="leg"><div class="leg-line" style="background:#f87171"></div>IL %×100</div>`;

  [{id:'chart1', series:[
      {key:'totalValue', color:'#60a5fa'},
      {key:'holdValue',  color:'#444'},
      {key:'vaultValue', color:'#2dd4bf'},
      {key:'cashProfit', color:'#4ade80'},
    ]},
   {id:'chart2', series:[
      {key:'alphaINR', color:'#fbbf24'},
      {key:'ilPct',    color:'#f87171', scale:100},
    ]},
  ].forEach(({id, series}) => {
    const c = $(id); if (!c) return;
    requestAnimationFrame(() => drawChart(c, pts, series));
    const ro = new ResizeObserver(() => requestAnimationFrame(() => drawChart(c, pts, series)));
    ro.observe(c.parentElement); _obs.push(ro);
  });
}

function drawChart(canvas, data, series) {
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth || wrap.offsetWidth;
  const H = wrap.clientHeight || wrap.offsetHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W*dpr; canvas.height = H*dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const P = {t:12,r:12,b:32,l:78};
  const cW = W-P.l-P.r, cH = H-P.t-P.b;
  ctx.fillStyle='#111'; ctx.fillRect(0,0,W,H);

  let yMin=Infinity, yMax=-Infinity;
  for (const s of series) {
    const sc = s.scale??1;
    for (const d of data) { const v=(d[s.key]??0)*sc; if(v<yMin)yMin=v; if(v>yMax)yMax=v; }
  }
  if(!isFinite(yMin))yMin=0; if(!isFinite(yMax))yMax=1;
  if(yMin===yMax){yMin-=1;yMax+=1;}
  const pad=(yMax-yMin)*0.05; yMin-=pad; yMax+=pad;
  const yRng=yMax-yMin;
  const toX=i=>P.l+(i/(data.length-1||1))*cW;
  const toY=v=>P.t+cH-((v-yMin)/yRng)*cH;

  for(let g=0;g<=4;g++){
    const yv=yMin+(g/4)*yRng, yp=toY(yv);
    ctx.strokeStyle='#1e1e1e'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(P.l,yp); ctx.lineTo(P.l+cW,yp); ctx.stroke();
    ctx.fillStyle='#555'; ctx.font='10px monospace'; ctx.textAlign='right';
    const abs=Math.abs(yRng);
    ctx.fillText(abs>5e6?`₹${(yv/1e5).toFixed(1)}L`:abs>1e4?`₹${(yv/1e3).toFixed(1)}K`:yv.toFixed(1), P.l-5, yp+3.5);
  }
  if(yMin<0&&yMax>0){
    ctx.strokeStyle='#333'; ctx.lineWidth=1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(P.l,toY(0)); ctx.lineTo(P.l+cW,toY(0)); ctx.stroke(); ctx.setLineDash([]);
  }
  for(let i=0;i<=4;i++){
    const idx=Math.round((i/4)*(data.length-1));
    ctx.fillStyle='#555'; ctx.font='10px monospace'; ctx.textAlign='center';
    ctx.fillText(new Date(data[idx].date).toLocaleDateString('en-IN',{day:'numeric',month:'short'}),toX(idx),H-P.b+14);
  }
  data.forEach((d,i)=>{
    if(!d.inBand&&i<data.length-1){ ctx.fillStyle='rgba(100,100,120,0.10)'; ctx.fillRect(toX(i),P.t,toX(i+1)-toX(i),cH); }
  });
  let inH=false,hS=0;
  data.forEach((d,i)=>{
    if(d.halted&&!inH){inH=true;hS=i;}
    if(!d.halted&&inH){ctx.fillStyle='rgba(248,113,113,0.06)';ctx.fillRect(toX(hS),P.t,toX(i)-toX(hS),cH);inH=false;}
  });
  if(inH){ctx.fillStyle='rgba(248,113,113,0.06)';ctx.fillRect(toX(hS),P.t,toX(data.length-1)-toX(hS),cH);}

  for(const s of series){
    const sc=s.scale??1;
    ctx.beginPath(); ctx.strokeStyle=s.color; ctx.lineWidth=1.5; ctx.lineJoin='round';
    data.forEach((d,i)=>{const x=toX(i),y=toY((d[s.key]??0)*sc);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.stroke();
  }
}

// ── Ledger ─────────────────────────────────────────────────────────────────
function renderLedger(a1, a2) {
  const ledger = state.ledger;
  if (!ledger.length) {
    $('ledgerWrap').innerHTML='<div class="empty">No activity.</div>';
    $('ledgerCount').textContent=''; return;
  }
  const trades = ledger.filter(r=>r.type==='TRADE').length;
  const vaults = ledger.filter(r=>r.type==='VAULT_DEPOSIT').length;
  const adjs   = ledger.filter(r=>r.type==='ADJUST').length;
  $('ledgerCount').textContent = `${trades} trades · ${vaults} vault deposits · ${adjs} adjustments`;

  const rows = ledger.slice(-600);
  if (ledger.length > 600) {
    $('ledgerNote').textContent = `Showing last 600 of ${ledger.length}. Export CSV for full history.`;
    $('ledgerNote').classList.remove('hidden');
  } else { $('ledgerNote').classList.add('hidden'); }

  const html = rows.map(row => {
    if (row.type === 'VAULT_DEPOSIT') return `
      <tr class="row-vault">
        <td>${fdt(row.date)}</td>
        <td><span class="tag-vault">🔒 VAULT #${row.depositEvent}</span></td>
        <td colspan="3">Bought ${qty(row.buyX)} ${a1} + ${qty(row.buyY)} ${a2} · Cost ${inr(row.actualCost)} · Brok ${inr(row.brokCost)}</td>
        <td class="r teal">+${inr(row.actualCost)}</td>
        <td class="r">${inr(row.cashAfter)}</td>
        <td class="r teal">${qty(row.vaultX)}</td>
        <td class="r teal">${qty(row.vaultY)}</td>
        <td class="r">—</td>
      </tr>`;
    if (row.type === 'ADJUST') return `
      <tr class="row-adjust">
        <td>${fdt(row.date)}</td>
        <td><span class="tag-adjust">${row.adjType}</span></td>
        <td colspan="3">Ratio ${dec(row.rNow,4)} outside [${dec(row.rLow,4)}, ${dec(row.rHigh,4)}]</td>
        <td class="r">—</td>
        <td class="r">${inr(row.cashProfit)}</td>
        <td class="r">${qty(row.poolX)}</td><td class="r">${qty(row.poolY)}</td>
        <td class="r">—</td>
      </tr>`;
    return `<tr>
      <td>${fdt(row.date)}</td>
      <td>${row.action}</td>
      <td class="r">${qty(row.sellQty)}</td>
      <td class="r down">−${inr(row.sellVal)}</td>
      <td class="r">${qty(row.buyQty)}</td>
      <td class="r ${row.gross>=0?'up':'down'}">${row.gross>=0?'+':'−'}${inr(Math.abs(row.gross))}</td>
      <td class="r">${inr(row.cashProfit)}</td>
      <td class="r">${qty(row.poolX)}</td>
      <td class="r ${row.ilPct>=0?'up':'down'}">${dec(row.ilPct,2)}%</td>
    </tr>`;
  }).join('');

  $('ledgerWrap').innerHTML = `
    <div class="tbl-wrap"><table>
      <thead><tr>
        <th>Time</th><th>Action</th>
        <th class="r">Sell qty</th><th class="r">Sell value</th>
        <th class="r">Buy qty</th><th class="r">Gross P&amp;L</th>
        <th class="r">Cash</th><th class="r">Pool ${a1}</th>
        <th class="r">IL%</th>
      </tr></thead>
      <tbody>${html}</tbody>
    </table></div>`;
}

function exportCsv(ledger) {
  const h = ['Date','Type','Action','SellQty','SellValue','BuyQty','BuyValue',
             'Gross','Brokerage','Net','Cash','PoolA1','PoolA2','VaultA1','VaultA2','IL_Pct'];
  const lines = [h.join(',')].concat(ledger.map(r => [
    r.date, r.type, `"${r.action||''}"`,
    r.sellQty??'', r.sellVal??'', r.buyQty??'', r.buyVal??'',
    r.gross??'', r.brok??'', r.net??'', r.cashProfit??r.cashAfter??'',
    r.poolX??'', r.poolY??'', r.vaultX??'', r.vaultY??'', r.ilPct??'',
  ].join(',')));
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'),{href:url,download:'institutional_ledger.csv'}).click();
  URL.revokeObjectURL(url);
}
