import {
  parseCsv, runAlmSimulation, runBatchOptimization,
  buildHourly, buildRatioATR, normalizeRows,
} from './simulation-core.js';

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  swaps: [], results: null, equity: [], optimizerLog: [],
  perfSummary: null, batchReport: null,
  hourly: null, atrArr: null,
};

const $ = id => document.getElementById(id);

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const asset1File      = $('asset1File'),    asset2File      = $('asset2File');
const asset1FN        = $('asset1FileName'),asset2FN        = $('asset2FileName');
const asset1Label     = $('asset1Label'),   asset2Label     = $('asset2Label');
const realCapInput    = $('realCapital');
const buyBrokInput    = $('buyBrokeragePct'), sellBrokInput = $('sellBrokeragePct');
const trainDaysInput  = $('trainDays'),     testDaysInput   = $('testDays');
const wfToggle        = $('walkForward');
const midWInput       = $('midWidth');
const cooldownInput   = $('cooldownHours'), profBufInput    = $('profitBuffer');
const atrMultInput    = $('atrMultiplier'), atrPeriodInput  = $('atrPeriod');
const corrLBInput     = $('corrLookbackHours'), corrImpInput = $('correlationImpact');
const extremeInput    = $('extremeMult');
const sigmaInput      = $('sigmaThreshold'), lookbackInput  = $('lookbackHours');
const pauseHighInput  = $('pauseHighVol'),  recenterOnInput = $('recenterEnabled');
const ilStopInput     = $('ilStopLossPct');
const runBtn          = $('runSimulation'),  batchBtn       = $('runBatch');
const statusBanner    = $('statusBanner'),   ilBanner       = $('ilBanner');
const metricsGrid     = $('metricsGrid');
const perfPanel       = $('perfSummaryPanel');
const batchPanel      = $('batchPanel');
const swapContainer   = $('swapTableContainer');
const downloadBtn     = $('downloadCsv'),   swapCount       = $('swapCount');
const pairHeading     = $('pairHeading');
const chartCanvas     = $('equityChart'),   corrCanvas      = $('corrChart');
const alphaCanvas     = $('alphaChart');
const optimizerPanel  = $('optimizerPanel');
const progressBar     = $('progressBar'),   progressWrap    = $('progressWrap');

// ─── Formatters ───────────────────────────────────────────────────────────────
const inr  = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(v);
const inr2 = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const pct  = (v,d=2) => `${v>=0?'+':''}${(+v).toFixed(d)}%`;
const dec  = (v,d=2) => (+v).toFixed(d);
const qty  = v => new Intl.NumberFormat('en-IN',{maximumFractionDigits:0}).format(Math.round(+v));

// ─── Events ───────────────────────────────────────────────────────────────────
asset1File.addEventListener('change',()=>{ asset1FN.textContent=asset1File.files[0]?.name||'Upload Asset 1 CSV'; });
asset2File.addEventListener('change',()=>{ asset2FN.textContent=asset2File.files[0]?.name||'Upload Asset 2 CSV'; });
asset1Label.addEventListener('input',updateHeading);
asset2Label.addEventListener('input',updateHeading);
downloadBtn.addEventListener('click',()=>downloadCsv(state.swaps));
runBtn.addEventListener('click',handleRun);
batchBtn.addEventListener('click',handleBatch);
wfToggle.addEventListener('change',()=>{
  document.querySelectorAll('.wf-only').forEach(el=>{
    el.style.display=wfToggle.checked?'flex':'none';
  });
});
updateHeading();

function updateHeading(){
  pairHeading.textContent=`${asset1Label.value||'Asset 1'} ↔ ${asset2Label.value||'Asset 2'}`;
}
function setStatus(type,msg){
  statusBanner.className=`status-banner ${type}`;
  statusBanner.innerHTML=`<strong>${type.toUpperCase()}:</strong> <span>${msg}</span>`;
}
function getConfig(){
  return {
    buyBrokeragePct:   +buyBrokInput.value, sellBrokeragePct: +sellBrokInput.value,
    walkForward:       wfToggle.checked,
    trainDays:         +trainDaysInput.value, testDays: +testDaysInput.value,
    midWidth:          +midWInput.value, cooldownHours: +cooldownInput.value,
    profitBuffer:      +profBufInput.value, atrMultiplier: +atrMultInput.value,
    atrPeriod:         +atrPeriodInput.value, corrLookbackHours: +corrLBInput.value,
    correlationImpact: +corrImpInput.value, extremeMult: +extremeInput.value,
    sigmaThreshold:    +sigmaInput.value, lookbackHours: +lookbackInput.value,
    pauseHighVol:      pauseHighInput.checked, recenterEnabled: recenterOnInput.checked,
    ilStopLossPct:     +ilStopInput.value,
  };
}

// ─── Load CSV data (shared for batch and main run) ────────────────────────────
async function loadData() {
  if (!asset1File.files[0]||!asset2File.files[0]) return null;
  const [t1,t2] = await Promise.all([asset1File.files[0].text(),asset2File.files[0].text()]);
  const a1 = normalizeRows(parseCsv(t1));
  const a2 = normalizeRows(parseCsv(t2));
  const h  = buildHourly(a1, a2);
  const atr= buildRatioATR(h, +atrPeriodInput.value||14);
  return { hourly: h, atrArr: atr };
}

// ─── MAIN SIMULATION ─────────────────────────────────────────────────────────
async function handleRun(){
  if (!asset1File.files[0]||!asset2File.files[0]){setStatus('error','Upload both CSV files first.');return;}
  runBtn.disabled=true; runBtn.textContent='Running…';
  ilBanner.classList.add('hidden');
  const cfg = getConfig();
  setStatus('info', cfg.walkForward
    ? `Walk-forward: training ${cfg.trainDays}d → testing ${cfg.testDays}d. Net-Alpha objective active.`
    : 'Running with static parameters. Net-Alpha Guardian active.');
  try {
    await new Promise(r=>setTimeout(r,10));
    const [t1,t2]=await Promise.all([asset1File.files[0].text(),asset2File.files[0].text()]);
    const result=runAlmSimulation(parseCsv(t1),parseCsv(t2),+realCapInput.value,cfg);
    if (result.error){
      state.swaps=[];state.results=null;state.equity=[];
      state.optimizerLog=[];state.perfSummary=null;
      renderMetrics();renderPerfSummary();renderTable();
      setStatus('error',result.error);
    } else {
      state.swaps=result.swaps; state.results=result.results;
      state.equity=result.equityCurve; state.optimizerLog=result.optimizerLog||[];
      state.perfSummary=result.performanceSummary;
      renderMetrics(); renderPerfSummary(); renderTable();
      renderCharts(); renderOptimizerLog(); renderIlBanner();
      const r=result.results, p=result.performanceSummary;
      const msg = r.vsHold>=0
        ? `✅ Net Alpha: ${inr(r.vsHold)} (+${dec(r.vsHoldPct,3)}%) | ` +
          `Friction ratio: ${dec(p.frictionRatioPct,1)}% | ` +
          `Swap success: ${dec(p.successRatePct,1)}% | ` +
          `Alpha Sharpe: ${dec(p.alphaSharpe,3)}`
        : `⚠️ Net Alpha: ${inr(r.vsHold)} (${dec(r.vsHoldPct,3)}%) | ` +
          `IL drag: ${inr(p.totalILDrag)} | ` +
          `Cash: ${inr(r.cashProfit)} — IL eroded the harvest. Try wider range or more correlated pair.`;
      setStatus(r.vsHold>=0?'success':'warning', msg);
    }
  } catch(err){setStatus('error',err.message||'Parse error.');}
  finally{runBtn.disabled=false;runBtn.textContent='▶ Run Simulation';}
}

// ─── BATCH OPTIMIZER ─────────────────────────────────────────────────────────
async function handleBatch(){
  if (!asset1File.files[0]||!asset2File.files[0]){setStatus('error','Upload both CSV files first.');return;}
  batchBtn.disabled=true; batchBtn.textContent='Optimizing…';
  progressWrap.classList.remove('hidden');
  progressBar.style.width='0%';
  setStatus('info','Running 240-candidate 4D grid across all walk-forward windows…');
  try {
    await new Promise(r=>setTimeout(r,10));
    const data = await loadData();
    if (!data){setStatus('error','Failed to parse CSV files.');return;}
    const {hourly,atrArr}=data;
    const cap = +realCapInput.value;
    const xI  = Math.max(1,Math.round(cap/2/hourly[0].c1));
    const yI  = Math.max(1,Math.round(cap/2/hourly[0].c2));
    const buyBrok  = clamp(+buyBrokInput.value, 0,5)/100;
    const sellBrok = clamp(+sellBrokInput.value,0,5)/100;

    // Run batch in chunks so UI can update
    const report = await new Promise(resolve => {
      setTimeout(() => {
        const r = runBatchOptimization(
          hourly, atrArr,
          +trainDaysInput.value||10, +testDaysInput.value||3,
          xI, yI, buyBrok, sellBrok,
          (pct, wi, tot) => {
            progressBar.style.width = `${pct}%`;
          }
        );
        resolve(r);
      }, 20);
    });

    if (report.error){setStatus('error',report.error);return;}
    state.batchReport=report;
    renderBatchReport(report);
    setStatus('success',
      `Batch complete: ${report.summary.totalWindows} windows, ` +
      `${report.summary.positiveWindows}/${report.summary.totalTestWindows} positive. ` +
      `Best param: width=${dec(report.robustBestParams.width*100,1)}% ` +
      `cd=${report.robustBestParams.cooldown}h ` +
      `buf=${dec(report.robustBestParams.profitBuffer,1)}×`);
  } catch(err){setStatus('error',err.message||'Batch error.');}
  finally{
    batchBtn.disabled=false;batchBtn.textContent='🔬 Run Batch Optimizer';
    progressWrap.classList.add('hidden');
  }
}

function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}

// ─── Render: Main Metrics ─────────────────────────────────────────────────────
function renderMetrics(){
  if (!state.results){
    metricsGrid.innerHTML='<div class="empty-state"><h3>No results yet</h3><p>Upload CSVs and run.</p></div>';
    downloadBtn.classList.add('hidden');return;
  }
  const r=state.results;
  const a1=asset1Label.value||'Asset 1', a2=asset2Label.value||'Asset 2';
  const cards=[
    {label:'Net Alpha (vs Hold)',       value:inr(r.vsHold),              delta:pct(r.vsHoldPct,3), positive:r.vsHold>=0, highlight:true},
    {label:'Cash Deployed',             value:inr(r.initCashDeployed),    delta:null},
    {label:'Total AMM Value',           value:inr(r.totalValue),          delta:pct(r.roiPct),   positive:r.roiPct>=0},
    {label:'Buy-and-Hold Value',        value:inr(r.holdValue),           delta:pct(r.holdRoi),  positive:r.holdRoi>=0},
    {label:'Cash Profit (all trades)',  value:inr(r.cashProfit),          delta:pct(r.cashRoi),  positive:r.cashProfit>=0},
    {label:'Gross Swap Fees',           value:inr(r.grossSwapFees),       delta:null},
    {label:'Total Brokerage (Friction)',value:inr(r.totalBrokerage),      delta:pct(-r.brokRoi), positive:false},
    {label:'Pool Asset Value',          value:inr(r.poolAssets),          delta:null},
    {label:'Unrealized IL',             value:inr(r.unrealizedIL),        delta:pct(r.ilPct,3),  positive:r.ilPct>=0},
    {label:'Crystallized IL (recenters)',value:inr(r.crystallizedILTotal),delta:null,            positive:r.crystallizedILTotal>=0},
    {label:'Swap Success Rate',         value:`${dec(r.successRate*100,1)}%`, delta:null},
    {label:'Profitable Swaps',          value:r.successfulSwaps.toLocaleString('en-IN'),delta:null},
    {label:'Recenter Events',           value:r.recenterCount.toLocaleString('en-IN'),  delta:null},
    {label:'Harvest / Recenter',        value:inr(r.harvestPerRecenter),  delta:null},
    {label:'Alpha Efficiency (P/B)',    value:`${dec(r.alphaEfficiency,2)}×`,delta:null},
    {label:'Optimizer Windows',         value:r.optimizerWindows.toLocaleString('en-IN'),delta:null},
    {label:`Initial ${a1}`,            value:qty(r.initialX),            delta:null},
    {label:`Final ${a1}`,              value:qty(r.finalX),              delta:null},
    {label:`Initial ${a2}`,            value:qty(r.initialY),            delta:null},
    {label:`Final ${a2}`,              value:qty(r.finalY),              delta:null},
    {label:'Trending/Ranging Hours',    value:`${r.trendingHours}/${r.rangingHours}`,delta:null},
    {label:'IL Stop-Loss Hit',          value:r.ilHalted?'⛔ Yes':'✅ No',delta:null},
  ];
  metricsGrid.innerHTML=cards.map(({label,value,delta,positive,highlight})=>`
    <div class="metric-card${highlight?' metric-highlight':''}">
      <span class="mc-label">${label}</span>
      <strong class="mc-value">${value}</strong>
      ${delta!=null?`<em class="mc-delta ${positive?'positive':'negative'}">${delta}</em>`:''}
    </div>`).join('');
  downloadBtn.classList.remove('hidden');
}

// ─── Render: Performance Summary Panel ───────────────────────────────────────
function renderPerfSummary(){
  const p=state.perfSummary;
  if (!p){perfPanel.innerHTML='<div class="empty-state compact"><h3>Run simulation first</h3></div>';return;}
  perfPanel.innerHTML=`
    <div class="perf-grid">
      <div class="perf-section">
        <h3>💰 Harvest vs Friction</h3>
        <div class="perf-row"><span>Gross Swap Fees</span><strong class="positive">${inr(p.grossFees)}</strong></div>
        <div class="perf-row"><span>Total Friction (Brokerage)</span><strong class="negative">${inr(p.totalFriction)}</strong></div>
        <div class="perf-row"><span>Net Swap Income</span><strong>${inr(p.netSwapIncome)}</strong></div>
        <div class="perf-row"><span>Friction Ratio</span><strong>${dec(p.frictionRatioPct,2)}%</strong></div>
        <div class="perf-badge ${p.frictionRatio<0.10?'badge-good':p.frictionRatio<0.25?'badge-ok':'badge-bad'}">${p.narrative.frictionEfficiency}</div>
      </div>
      <div class="perf-section">
        <h3>📉 Alpha Drawdown &amp; Risk</h3>
        <div class="perf-row"><span>Max Alpha Drawdown (₹)</span><strong class="negative">${inr(p.maxDrawdownINR)}</strong></div>
        <div class="perf-row"><span>Max Alpha Drawdown (%)</span><strong class="negative">${dec(p.maxDrawdownPct,3)}%</strong></div>
        <div class="perf-row"><span>Alpha Sharpe Ratio</span><strong>${dec(p.alphaSharpe,4)}</strong></div>
        <div class="perf-row"><span>Final Net Alpha</span><strong class="${p.netAlphaFinal>=0?'positive':'negative'}">${inr(p.netAlphaFinal)}</strong></div>
      </div>
      <div class="perf-section">
        <h3>✅ Swap Quality</h3>
        <div class="perf-row"><span>Total Swaps Attempted</span><strong>${p.totalAttempted.toLocaleString('en-IN')}</strong></div>
        <div class="perf-row"><span>Successful (net &gt; 0)</span><strong class="positive">${p.successfulSwaps.toLocaleString('en-IN')}</strong></div>
        <div class="perf-row"><span>Success Rate</span><strong>${dec(p.successRatePct,1)}%</strong></div>
        <div class="perf-badge ${p.successRate>0.80?'badge-good':p.successRate>0.60?'badge-ok':'badge-bad'}">${p.narrative.swapQuality}</div>
      </div>
      <div class="perf-section">
        <h3>🌊 IL Decomposition</h3>
        <div class="perf-row"><span>Crystallized IL (recenters)</span><strong class="${p.crystallizedIL>=0?'positive':'negative'}">${inr(p.crystallizedIL)}</strong></div>
        <div class="perf-row"><span>Unrealized IL (end of period)</span><strong class="${p.unrealizedIL>=0?'positive':'negative'}">${inr(p.unrealizedIL)}</strong></div>
        <div class="perf-row"><span>Total IL Drag</span><strong class="${p.totalILDrag>=0?'positive':'negative'}">${inr(p.totalILDrag)}</strong></div>
        <div class="perf-badge ${p.unrealizedIL>=0?'badge-good':'badge-bad'}">${p.narrative.ilStatus}</div>
      </div>
    </div>`;
}

// ─── Render: Batch Report ─────────────────────────────────────────────────────
function renderBatchReport(report){
  if (!report||!report.paramStats){batchPanel.innerHTML='<div class="empty-state compact"><h3>No batch data</h3></div>';return;}
  const top=report.paramStats.slice(0,20);
  const s=report.summary;
  batchPanel.innerHTML=`
    <div class="batch-summary">
      <span>${s.totalWindows} windows</span>
      <span class="positive">${s.positiveWindows}/${s.totalTestWindows} positive</span>
      <span>Mean test NetAlpha: ${inr(s.meanTestNetAlpha)}</span>
      <span>Mean test Sharpe: ${dec(s.meanTestSharpe,3)}</span>
    </div>
    <p class="hint" style="margin:8px 0">
      <strong>Robust Best:</strong> width=${dec(report.robustBestParams.width*100,1)}%
      cooldown=${report.robustBestParams.cooldown}h
      buffer=${dec(report.robustBestParams.profitBuffer,1)}×
      IL-stop=${dec(report.robustBestParams.ilStopPct,1)}%
    </p>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Rank</th><th class="col-num">Width%</th><th class="col-num">CD hrs</th>
        <th class="col-num">Buf×</th><th class="col-num">IL Stop%</th>
        <th class="col-num">Mean Train Alpha</th><th class="col-num">Median Test Alpha</th>
        <th class="col-num">Mean Test Sharpe</th><th class="col-num">Test Windows</th>
      </tr></thead>
      <tbody>${top.map((ps,i)=>`
        <tr class="${i===0?'top-row':''}">
          <td>${i+1}</td>
          <td class="col-num">${dec(ps.params.width*100,1)}%</td>
          <td class="col-num">${ps.params.cooldown}h</td>
          <td class="col-num">${dec(ps.params.profitBuffer,1)}×</td>
          <td class="col-num">${dec(ps.params.ilStopPct,1)}%</td>
          <td class="col-num ${ps.meanTrainAlpha>=0?'positive':'negative'}">${inr(ps.meanTrainAlpha)}</td>
          <td class="col-num ${ps.medianTestAlpha>=0?'positive':'negative'}">${inr(ps.medianTestAlpha)}</td>
          <td class="col-num">${dec(ps.meanTestSharpe,3)}</td>
          <td class="col-num">${ps.nTestWindows}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

// ─── Render: Optimizer Log ────────────────────────────────────────────────────
function renderOptimizerLog(){
  if (!state.optimizerLog.length){
    optimizerPanel.innerHTML='<div class="empty-state compact"><h3>Walk-forward disabled</h3></div>';return;
  }
  optimizerPanel.innerHTML=`
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date</th><th class="col-num">Hour</th>
        <th class="col-num">Width%</th><th class="col-num">CD</th>
        <th class="col-num">Buf</th><th class="col-num">ATR Mult</th>
        <th class="col-num">Train Score</th><th class="col-num">Test NetAlpha</th><th class="col-num">Test Sharpe</th>
      </tr></thead>
      <tbody>${state.optimizerLog.map(w=>`
        <tr>
          <td>${new Date(w.date).toLocaleDateString('en-IN')}</td>
          <td class="col-num">${w.atHour}</td>
          <td class="col-num">${dec(w.params.width*100,2)}%</td>
          <td class="col-num">${w.params.cooldown}h</td>
          <td class="col-num">${dec(w.params.profitBuffer,1)}×</td>
          <td class="col-num">${dec(w.params.atrMult,1)}×</td>
          <td class="col-num">${inr(w.trainScore)}</td>
          <td class="col-num ${(w.testNetAlpha??0)>=0?'positive':'negative'}">${inr(w.testNetAlpha??0)}</td>
          <td class="col-num">${dec(w.testSharpe??0,3)}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

function renderIlBanner(){
  const r=state.results;
  if (!r||!r.ilHalted){ilBanner.classList.add('hidden');return;}
  ilBanner.className='il-banner halted';
  ilBanner.innerHTML=`<span class="il-icon">⛔</span><div><strong>IL Stop-Loss Triggered</strong><span>Halted at ${new Date(r.ilHaltedAt).toLocaleString('en-IN')} — IL exceeded −${(+ilStopInput.value).toFixed(1)}%.</span></div>`;
  ilBanner.classList.remove('hidden');
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function renderCharts(){
  if (!state.equity.length) return;
  const step=Math.max(1,Math.floor(state.equity.length/500));
  const s=state.equity.filter((_,i)=>i%step===0);
  drawChart(chartCanvas,s,[
    {key:'poolValue',  label:'AMM Total Value', color:'#38bdf8'},
    {key:'holdValue',  label:'Buy-and-Hold',    color:'#818cf8'},
    {key:'cashProfit', label:'Cash Profit',     color:'#22c55e'},
  ],'₹ Value');
  drawChart(alphaCanvas,s,[
    {key:'alphaINR',   label:'Net Alpha (₹)', color:'#facc15'},
  ],'Net Alpha ₹');
  drawChart(corrCanvas,s,[
    {key:'correlation',    label:'Correlation', color:'#f97316'},
    {key:'activeWidthPct', label:'Width÷100',  color:'#a78bfa',scale:0.01},
    {key:'ilPct',          label:'IL÷100',     color:'#f43f5e',scale:0.01},
  ],'−1 → +1');
}

function drawChart(canvas,data,series,yLabel){
  if (!canvas) return;
  const dpr=window.devicePixelRatio||1, rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const W=rect.width, H=rect.height, P={t:26,r:14,b:44,l:90};
  const cW=W-P.l-P.r, cH=H-P.t-P.b;
  ctx.clearRect(0,0,W,H);
  let yMin=Infinity, yMax=-Infinity;
  for(const s of series){const sc=s.scale??1;for(const d of data){const v=d[s.key]*sc;if(v<yMin)yMin=v;if(v>yMax)yMax=v;}}
  if(!isFinite(yMin))yMin=0;if(!isFinite(yMax))yMax=1;if(yMin===yMax){yMin-=1;yMax+=1;}
  const yRng=yMax-yMin;
  const toX=i=>P.l+(i/(data.length-1||1))*cW;
  const toY=v=>P.t+cH-((v-yMin)/yRng)*cH;
  // Optimizer event marks
  for(const w of state.optimizerLog){
    const ei=data.findIndex(d=>d.date>=w.date);
    if(ei>=0){ctx.strokeStyle='rgba(250,204,21,0.25)';ctx.lineWidth=1;ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(toX(ei),P.t);ctx.lineTo(toX(ei),P.t+cH);ctx.stroke();ctx.setLineDash([]);}
  }
  for(let g=0;g<=5;g++){
    const yv=yMin+(g/5)*yRng, yp=toY(yv);
    ctx.strokeStyle='rgba(148,163,184,0.08)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(P.l,yp);ctx.lineTo(P.l+cW,yp);ctx.stroke();
    ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='10px Arial';ctx.textAlign='right';
    const lbl=Math.abs(yRng)>50000?`₹${(yv/1e5).toFixed(1)}L`:Math.abs(yRng)>1000?`₹${(yv/1e3).toFixed(1)}K`:yv.toFixed(3);
    ctx.fillText(lbl,P.l-3,yp+3.5);
  }
  for(let s=0;s<=5;s++){
    const i=Math.round((s/5)*(data.length-1));
    ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='10px Arial';ctx.textAlign='center';
    ctx.fillText(new Date(data[i].date).toLocaleDateString('en-IN',{month:'short',day:'numeric'}),toX(i),H-P.b+13);
  }
  ctx.save();ctx.translate(12,P.t+cH/2);ctx.rotate(-Math.PI/2);ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='10px Arial';ctx.textAlign='center';ctx.fillText(yLabel,0,0);ctx.restore();
  const hi=data.findIndex(d=>d.halted);
  if(hi>=0){ctx.fillStyle='rgba(244,63,94,0.06)';ctx.fillRect(toX(hi),P.t,toX(data.length-1)-toX(hi),cH);}
  for(const s of series){
    const sc=s.scale??1;ctx.beginPath();ctx.strokeStyle=s.color;ctx.lineWidth=1.5;ctx.lineJoin='round';
    data.forEach((d,i)=>{const x=toX(i),y=toY(d[s.key]*sc);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.stroke();
  }
  let lx=P.l;
  for(const s of series){
    ctx.fillStyle=s.color;ctx.fillRect(lx,8,13,3);
    ctx.fillStyle='rgba(148,163,184,0.85)';ctx.font='10px Arial';ctx.textAlign='left';ctx.fillText(s.label,lx+17,13);
    lx+=ctx.measureText(s.label).width+34;
  }
}

// ─── Trade table ──────────────────────────────────────────────────────────────
function renderTable(){
  if (!state.swaps.length){
    swapCount.classList.add('hidden');
    swapContainer.innerHTML='<div class="empty-state compact"><h3>No trades</h3><p>Adjust parameters and run.</p></div>';return;
  }
  const a1=asset1Label.value||'Asset 1', a2=asset2Label.value||'Asset 2';
  swapCount.textContent=`${state.swaps.length} records`;swapCount.classList.remove('hidden');
  const rows=state.swaps.slice(-500);
  const note=state.swaps.length>500?`<p class="table-note">Last 500 of ${state.swaps.length}. Download for full history.</p>`:'';
  swapContainer.innerHTML=note+`
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date/Time</th><th>Type</th><th>Regime</th><th>Mode</th>
        <th>Corr</th><th>Width%</th><th>ATR%</th><th>CD</th>
        <th>Action</th>
        <th>Bought</th><th class="col-num">Qty</th><th class="col-num">Cost ₹</th>
        <th>Sold</th><th class="col-num">Qty</th><th class="col-num">Rev ₹</th>
        <th class="col-num">Gross</th><th class="col-num">Brok</th><th class="col-num">Net ₹</th>
        <th class="col-num">Cash Accum.</th>
        <th class="col-num">${a1}</th><th class="col-num">${a2}</th><th class="col-num">IL%</th>
      </tr></thead>
      <tbody>${rows.map(s=>`
        <tr class="${s.isRecenter?'recenter-trade-row':''} ${s.extreme?'extreme-row':''} ${s.justOptimized?'optim-row':''}">
          <td>${new Date(s.date).toLocaleString('en-IN')}</td>
          <td>${s.isRecenter?'<span class="type-pill recenter">RECENTER</span>':'<span class="type-pill swap">SWAP</span>'}</td>
          <td><span class="regime-pill regime-${s.regime.toLowerCase().substring(0,4)}">${s.regime.substring(0,5)}</span></td>
          <td><span class="mode-pill mode-${s.mode.toLowerCase()}">${s.mode}</span></td>
          <td>${dec(s.rollingCorrelation,3)}</td>
          <td>${dec(s.activeWidthPct,2)}%</td>
          <td>${dec(s.atrPct,3)}%</td>
          <td>${s.activeCooldown}h</td>
          <td class="action-cell">${s.action}</td>
          <td>${s.boughtAsset}</td><td class="col-num">${qty(s.boughtQty)}</td>
          <td class="col-num negative">${inr2(s.boughtCost)}</td>
          <td>${s.soldAsset}</td><td class="col-num">${qty(s.soldQty)}</td>
          <td class="col-num positive">${inr2(s.soldRevenue)}</td>
          <td class="col-num ${s.grossProfit>=0?'positive':'negative'}">${inr2(s.grossProfit)}</td>
          <td class="col-num negative">${inr2(s.totalBrokerageRow)}</td>
          <td class="col-num ${s.netProfit>=0?'positive':'negative'}">${inr2(s.netProfit)}</td>
          <td class="col-num">${inr(s.cashProfit)}</td>
          <td class="col-num">${qty(s.poolX)}</td>
          <td class="col-num">${qty(s.poolY)}</td>
          <td class="col-num ${s.ilPct>=0?'positive':'negative'}">${dec(s.ilPct,3)}%</td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

function downloadCsv(rows){
  const h=['Date','Type','Regime','Mode','Correlation','Width%','ATR%','Cooldown','Action',
    'BoughtAsset','Qty','BuyCost_INR','SoldAsset','Qty','SellRev_INR',
    'GrossProfit_INR','TotalBrok_INR','NetProfit_INR','CashAccum_INR',
    'CrystallizedIL_INR','Asset1Price','Asset2Price',
    'Asset1Shares','Asset2Shares','PoolAssetVal_INR','IL_Pct','TotalValue_INR'];
  const lines=[h.join(',')].concat(rows.map(r=>[
    r.date,r.isRecenter?'RECENTER':'SWAP',r.regime,r.mode,
    dec(r.rollingCorrelation,6),dec(r.activeWidthPct,4),dec(r.atrPct,4),r.activeCooldown,
    `"${r.action}"`,
    r.boughtAsset,Math.round(r.boughtQty),dec(r.boughtCost,2),
    r.soldAsset,Math.round(r.soldQty),dec(r.soldRevenue,2),
    dec(r.grossProfit,2),dec(r.totalBrokerageRow,2),dec(r.netProfit,2),dec(r.cashProfit,2),
    dec(r.crystallizedILAtRecenter??0,2),r.asset1Price,r.asset2Price,
    Math.round(r.poolX),Math.round(r.poolY),
    dec(r.poolAssetValue,2),dec(r.ilPct,4),dec(r.totalValue,2),
  ].join(',')));
  const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  Object.assign(document.createElement('a'),{href:url,download:'amm_v8.csv'}).click();
  URL.revokeObjectURL(url);
}
