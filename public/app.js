import { parseCsv, runAlmSimulation, buildPerformanceSummary } from './simulation-core.js';

const state = { swaps:[], results:null, equity:[], perfSummary:null };
const $  = id => document.getElementById(id);
const inr  = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(v);
const inr2 = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const pct  = (v,d=2) => `${v>=0?'+':''}${(+v).toFixed(d)}%`;
const dec  = (v,d=2) => (+v).toFixed(d);
const qty  = v => new Intl.NumberFormat('en-IN',{maximumFractionDigits:0}).format(Math.round(+v));

// DOM
const asset1File=$('asset1File'), asset2File=$('asset2File');
const asset1FN=$('asset1FileName'), asset2FN=$('asset2FileName');
const asset1Label=$('asset1Label'), asset2Label=$('asset2Label');
const realCapInput=$('realCapital');
const buyBrokInput=$('buyBrokeragePct'), sellBrokInput=$('sellBrokeragePct');
const zThreshInput=$('zThreshold'), zLBInput=$('zLookback');
const rsiPeriodInput=$('rsiPeriod'), rsiOBInput=$('rsiOverbought'), rsiOSInput=$('rsiOversold');
const ouLBInput=$('ouLookback');
const baseWInput=$('baseWidth'), atrMultInput=$('atrMultiplier'), atrPeriodInput=$('atrPeriod');
const profBufInput=$('profitBuffer'), cooldownInput=$('cooldownHours'), extremeInput=$('extremeMult');
const sigmaInput=$('sigmaThreshold'), volLBInput=$('lookbackHours');
const pauseHighInput=$('pauseHighVol'), recenterOnInput=$('recenterEnabled');
const ilStopInput=$('ilStopLossPct');
const runBtn=$('runSimulation'), statusBanner=$('statusBanner'), ilBanner=$('ilBanner');
const metricsGrid=$('metricsGrid'), perfPanel=$('perfSummaryPanel');
const swapContainer=$('swapTableContainer');
const downloadBtn=$('downloadCsv'), swapCount=$('swapCount');
const pairHeading=$('pairHeading');
const chartCanvas=$('equityChart'), alphaCanvas=$('alphaChart'), sigCanvas=$('signalChart');

asset1File.addEventListener('change',()=>{asset1FN.textContent=asset1File.files[0]?.name||'Upload Asset 1 CSV';});
asset2File.addEventListener('change',()=>{asset2FN.textContent=asset2File.files[0]?.name||'Upload Asset 2 CSV';});
asset1Label.addEventListener('input',updateHeading);
asset2Label.addEventListener('input',updateHeading);
downloadBtn.addEventListener('click',()=>downloadCsv(state.swaps));
runBtn.addEventListener('click',handleRun);
updateHeading();

function updateHeading(){pairHeading.textContent=`${asset1Label.value||'Asset 1'} ↔ ${asset2Label.value||'Asset 2'}`;}
function setStatus(type,msg){statusBanner.className=`status-banner ${type}`;statusBanner.innerHTML=`<strong>${type.toUpperCase()}:</strong> <span>${msg}</span>`;}

function getConfig(){
  return {
    buyBrokeragePct:+buyBrokInput.value, sellBrokeragePct:+sellBrokInput.value,
    zThreshold:     +zThreshInput.value, zLookback:+zLBInput.value,
    rsiPeriod:      +rsiPeriodInput.value, rsiOverbought:+rsiOBInput.value, rsiOversold:+rsiOSInput.value,
    ouLookback:     +ouLBInput.value,
    baseWidth:      +baseWInput.value, atrMult:+atrMultInput.value, atrPeriod:+atrPeriodInput.value,
    profitBuffer:   +profBufInput.value, cooldownHours:+cooldownInput.value, extremeMult:+extremeInput.value,
    sigmaThreshold: +sigmaInput.value, lookbackHours:+volLBInput.value,
    pauseHighVol:   pauseHighInput.checked, recenterEnabled:recenterOnInput.checked,
    ilStopLossPct:  +ilStopInput.value,
    ilResumePct:    +($('ilResumePct')?.value ?? 0),
    alphaProtectThresholdPct: +($('alphaProtectPct')?.value ?? 0),
    alphaProtectEnabled: !!($('alphaProtectEnabled')?.checked),
  };
}

async function handleRun(){
  if (!asset1File.files[0]||!asset2File.files[0]){setStatus('error','Upload both CSV files first.');return;}
  runBtn.disabled=true; runBtn.textContent='Running…';
  ilBanner.classList.add('hidden');
  setStatus('info','Computing Z-Score · RSI · OU Half-Life · ATR regime per hour…');
  try {
    await new Promise(r=>setTimeout(r,10));
    const [t1,t2]=await Promise.all([asset1File.files[0].text(),asset2File.files[0].text()]);
    const result=runAlmSimulation(parseCsv(t1),parseCsv(t2),+realCapInput.value,getConfig());
    if(result.error){
      state.swaps=[];state.results=null;state.equity=[];state.perfSummary=null;
      renderMetrics();renderPerfSummary();renderTable();
      setStatus('error',result.error);
    } else {
      state.swaps=result.swaps; state.results=result.results;
      state.equity=result.equityCurve; state.perfSummary=result.performanceSummary;
      renderMetrics(); renderPerfSummary(); renderTable(); renderCharts(); renderIlBanner();
      const r=result.results, p=result.performanceSummary;
      const tag = r.vsHold>=0
        ? `✅ Alpha: ${inr(r.vsHold)} (+${dec(r.vsHoldPct,3)}%) | ` +
          `Sharpe: ${dec(p.alphaSharpe,3)} | Swap success: ${dec(p.successRatePct,1)}% | ` +
          `Swaps: ${r.totalSwaps} | Recenters: ${r.recenterCount}`
        : `⚠️ Net Alpha: ${inr(r.vsHold)} — IL (${dec(r.ilPct,2)}%) > cash (${inr(r.cashProfit)}). ` +
          `This pair's ratio vol may be too low for 0.30% brokerage. Try mid/small cap pairs.`;
      setStatus(r.vsHold>=0?'success':'warning',tag);
    }
  } catch(err){setStatus('error',err.message||'Parse error.');}
  finally{runBtn.disabled=false;runBtn.textContent='▶ Run Simulation';}
}

function renderIlBanner(){
  const r=state.results;
  ilBanner.classList.add('hidden');
  if (!r) return;

  // Build banner content based on current halt state
  const halted   = r.ilHalted;
  const reason   = r.haltReason;
  const resumed  = r.ilResumedAt;
  const protected_ = r.alphaProtected;
  const cycles   = r.haltCount || 0;

  // Build a combined status message
  const lines = [];
  if (halted) {
    if (reason === 'IL_STOP') {
      lines.push(`<strong>⛔ IL Stop-Loss Active</strong>`);
      lines.push(`Swaps halted at ${new Date(r.ilHaltedAt).toLocaleString('en-IN')} — IL exceeded −${(+ilStopInput.value).toFixed(1)}%. Will auto-resume when IL recovers above −${(+($('ilResumePct')?.value??0)).toFixed(1)}%.`);
    } else if (reason === 'ALPHA_PROTECT') {
      lines.push(`<strong>🛡️ Alpha Protection Active</strong>`);
      lines.push(`Swaps halted — unrealized IL has reached the accumulated alpha level. Net-zero position protected. Resumes when IL reduces below current cash ROI.`);
    }
  }
  if (!halted && resumed) {
    lines.push(`<strong>✅ Swaps Resumed</strong>`);
    lines.push(`Last resumed at ${new Date(resumed).toLocaleString('en-IN')}.${cycles > 1 ? ` (${cycles} halt/resume cycles — pool is dynamically self-protecting)` : ''}`);
  }
  if (protected_ && !halted) {
    lines.push(`<strong>🛡️ Alpha Protection has fired ${cycles}× this run.</strong> Net-alpha preserved.`);
  }

  if (!lines.length) return;

  ilBanner.className = `il-banner ${halted ? 'halted' : 'resumed'}`;
  ilBanner.innerHTML = `<span class="il-icon">${halted ? (reason==='ALPHA_PROTECT'?'🛡️':'⛔') : '✅'}</span><div>${lines.map(l=>`<span class="il-line">${l}</span>`).join('')}</div>`;
  ilBanner.classList.remove('hidden');
}

function renderMetrics(){
  if(!state.results){metricsGrid.innerHTML='<div class="empty-state"><h3>No results yet</h3><p>Upload CSVs and run.</p></div>';downloadBtn.classList.add('hidden');return;}
  const r=state.results;
  const a1=asset1Label.value||'Asset 1', a2=asset2Label.value||'Asset 2';
  const rg=r.regimeHours||{};
  const cards=[
    {label:'Net Alpha (vs Hold)',       value:inr(r.vsHold),              delta:pct(r.vsHoldPct,3),  positive:r.vsHold>=0,     hl:true},
    {label:'Cash Deployed',             value:inr(r.initCashDeployed),    delta:null},
    {label:'Total AMM Value',           value:inr(r.totalValue),          delta:pct(r.roiPct),       positive:r.roiPct>=0},
    {label:'Buy-and-Hold Value',        value:inr(r.holdValue),           delta:pct(r.holdRoi),      positive:r.holdRoi>=0},
    {label:'Cash Profit',               value:inr(r.cashProfit),          delta:pct(r.cashRoi),      positive:r.cashProfit>=0},
    {label:'Gross Swap Fees',           value:inr(r.grossSwapFees),       delta:null},
    {label:'Total Brokerage',           value:inr(r.totalBrokerage),      delta:pct(-r.brokRoi),     positive:false},
    {label:'Pool Asset Value',          value:inr(r.poolAssets),          delta:null},
    {label:'Unrealized IL',             value:inr(r.unrealizedIL),        delta:pct(r.ilPct,3),      positive:r.ilPct>=0},
    {label:'Crystallized IL',           value:inr(r.crystallizedIL),      delta:null,                positive:r.crystallizedIL>=0},
    {label:'Swap Success Rate',         value:`${dec(r.successRate*100,1)}%`,delta:null},
    {label:'Profitable Swaps',          value:r.successfulSwaps.toLocaleString('en-IN'),delta:null},
    {label:'Total Swaps',               value:r.totalSwaps.toLocaleString('en-IN'),    delta:null},
    {label:'Recenter Events',           value:r.recenterCount.toLocaleString('en-IN'),  delta:null},
    {label:'Harvest / Recenter',        value:inr(r.harvestPerRecenter),  delta:null},
    {label:'Alpha Efficiency (P/B)',    value:`${dec(r.alphaEfficiency,2)}×`,delta:null},
    {label:`Initial ${a1}`,            value:qty(r.initialX),            delta:null},
    {label:`Final ${a1}`,              value:qty(r.finalX),              delta:null},
    {label:`Initial ${a2}`,            value:qty(r.initialY),            delta:null},
    {label:`Final ${a2}`,              value:qty(r.finalY),              delta:null},
    {label:'Ratio Realised Vol (ann)',  value:`${dec((r.realizedVolOfRatio||0)*100,1)}%`,delta:null},
    {label:'Regime hrs F/R/S/T',       value:`${rg.FAST_REVERT||0}/${rg.RANGING||0}/${rg.SLOW_REVERT||0}/${rg.TRENDING||0}`,delta:null},
    {label:'IL Stop-Loss Hit',         value:r.ilHalted ? `⛔ Active (${r.haltCount} cycle${r.haltCount!==1?'s':''})` : r.haltCount>0 ? `✅ Resumed (${r.haltCount}×)` : '✅ Never fired', delta:null},
    {label:'Alpha Protection Fired',   value:r.alphaProtected ? `🛡️ Yes (${r.haltCount}×)` : '—', delta:null},
  ];
  metricsGrid.innerHTML=cards.map(({label,value,delta,positive,hl})=>`
    <div class="metric-card${hl?' metric-highlight':''}">
      <span class="mc-label">${label}</span>
      <strong class="mc-value">${value}</strong>
      ${delta!=null?`<em class="mc-delta ${positive?'positive':'negative'}">${delta}</em>`:''}
    </div>`).join('');
  downloadBtn.classList.remove('hidden');
}

function renderPerfSummary(){
  const p=state.perfSummary;
  if(!p){perfPanel.innerHTML='<div class="empty-state compact"><h3>Run simulation first</h3></div>';return;}
  perfPanel.innerHTML=`
    <div class="perf-grid">
      <div class="perf-section">
        <h3>💰 Harvest vs Friction</h3>
        <div class="perf-row"><span>Gross Swap Fees</span><strong class="positive">${inr(p.grossFees)}</strong></div>
        <div class="perf-row"><span>Total Friction</span><strong class="negative">${inr(p.totalFriction)}</strong></div>
        <div class="perf-row"><span>Net Swap Income</span><strong>${inr(p.netSwapIncome)}</strong></div>
        <div class="perf-row"><span>Friction Ratio</span><strong>${dec(p.frictionRatioPct,2)}%</strong></div>
        <div class="perf-badge ${p.frictionRatio<0.10?'badge-good':p.frictionRatio<0.25?'badge-ok':'badge-bad'}">${p.narrative.frictionEfficiency}</div>
      </div>
      <div class="perf-section">
        <h3>📈 Risk-Adjusted Return</h3>
        <div class="perf-row"><span>Alpha Sharpe (ann.)</span><strong>${dec(p.alphaSharpe,4)}</strong></div>
        <div class="perf-row"><span>Max Alpha Drawdown ₹</span><strong class="negative">${inr(p.maxDrawdownINR)}</strong></div>
        <div class="perf-row"><span>Max Alpha Drawdown %</span><strong class="negative">${dec(p.maxDrawdownPct,3)}%</strong></div>
        <div class="perf-row"><span>Net Alpha Final</span><strong class="${p.netAlphaFinal>=0?'positive':'negative'}">${inr(p.netAlphaFinal)}</strong></div>
        <div class="perf-badge ${p.alphaSharpe>2?'badge-good':p.alphaSharpe>1?'badge-ok':'badge-bad'}">${p.narrative.sharpeRating}</div>
      </div>
      <div class="perf-section">
        <h3>✅ Swap Quality</h3>
        <div class="perf-row"><span>Total Swaps</span><strong>${p.totalSwaps}</strong></div>
        <div class="perf-row"><span>Successful</span><strong class="positive">${p.successfulSwaps}</strong></div>
        <div class="perf-row"><span>Success Rate</span><strong>${dec(p.successRatePct,1)}%</strong></div>
        <div class="perf-row"><span>Gamma Efficiency</span><strong>${dec(p.gammaBudgetPct,1)}%</strong></div>
        <div class="perf-badge ${p.successRate===1?'badge-good':p.successRate>0.8?'badge-ok':'badge-bad'}">${p.narrative.swapQuality}</div>
      </div>
      <div class="perf-section">
        <h3>🌊 IL Decomposition</h3>
        <div class="perf-row"><span>Crystallized IL (recenters)</span><strong class="${p.crystallizedIL>=0?'positive':'negative'}">${inr(p.crystallizedIL)}</strong></div>
        <div class="perf-row"><span>Unrealized IL (end)</span><strong class="${p.unrealizedIL>=0?'positive':'negative'}">${inr(p.unrealizedIL)}</strong></div>
        <div class="perf-row"><span>Total IL Drag</span><strong class="${p.totalILDrag>=0?'positive':'negative'}">${inr(p.totalILDrag)}</strong></div>
        <div class="perf-badge ${p.unrealizedIL>=0?'badge-good':'badge-ok'}">${p.narrative.ilStatus}</div>
      </div>
    </div>`;
}

// Charts
function renderCharts(){
  if(!state.equity.length) return;
  const step=Math.max(1,Math.floor(state.equity.length/500));
  const s=state.equity.filter((_,i)=>i%step===0);
  drawChart(chartCanvas,s,[
    {key:'poolValue', label:'AMM Total Value',color:'#38bdf8'},
    {key:'holdValue', label:'Buy-and-Hold',  color:'#818cf8'},
    {key:'cashProfit',label:'Cash Profit',   color:'#22c55e'},
  ],'₹ Value');
  drawChart(alphaCanvas,s,[
    {key:'alphaINR',  label:'Net Alpha ₹',  color:'#facc15'},
  ],'Net Alpha ₹');
  drawChart(sigCanvas,s,[
    {key:'zScore',   label:'Z-Score',      color:'#38bdf8',   scale:0.5},
    {key:'rsi',      label:'RSI (÷100)',   color:'#f97316',   scale:0.01},
    {key:'activeWidthPct',label:'Width÷100',color:'#a78bfa',  scale:0.01},
    {key:'ilPct',    label:'IL÷100',       color:'#f43f5e',   scale:0.01},
  ],'Signals (scaled)');
}

function drawChart(canvas,data,series,yLabel){
  if(!canvas) return;
  const dpr=window.devicePixelRatio||1, rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const W=rect.width, H=rect.height, P={t:26,r:14,b:42,l:88};
  const cW=W-P.l-P.r, cH=H-P.t-P.b;
  ctx.clearRect(0,0,W,H);
  let yMin=Infinity,yMax=-Infinity;
  for(const s of series){const sc=s.scale??1;for(const d of data){const v=d[s.key]*sc;if(v<yMin)yMin=v;if(v>yMax)yMax=v;}}
  if(!isFinite(yMin))yMin=0;if(!isFinite(yMax))yMax=1;if(yMin===yMax){yMin-=1;yMax+=1;}
  const yRng=yMax-yMin;
  const toX=i=>P.l+(i/(data.length-1||1))*cW;
  const toY=v=>P.t+cH-((v-yMin)/yRng)*cH;
  // Zero line
  if(yMin<0&&yMax>0){const yp=toY(0);ctx.strokeStyle='rgba(148,163,184,0.20)';ctx.lineWidth=1;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(P.l,yp);ctx.lineTo(P.l+cW,yp);ctx.stroke();ctx.setLineDash([]);}
  for(let g=0;g<=5;g++){
    const yv=yMin+(g/5)*yRng,yp=toY(yv);
    ctx.strokeStyle='rgba(148,163,184,0.07)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(P.l,yp);ctx.lineTo(P.l+cW,yp);ctx.stroke();
    ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='9px Arial';ctx.textAlign='right';
    const lbl=Math.abs(yRng)>50000?`₹${(yv/1e5).toFixed(1)}L`:Math.abs(yRng)>1000?`₹${(yv/1e3).toFixed(1)}K`:yv.toFixed(2);
    ctx.fillText(lbl,P.l-3,yp+3);
  }
  for(let s=0;s<=5;s++){
    const i=Math.round((s/5)*(data.length-1));
    ctx.fillStyle='rgba(148,163,184,0.55)';ctx.font='9px Arial';ctx.textAlign='center';
    ctx.fillText(new Date(data[i].date).toLocaleDateString('en-IN',{month:'short',day:'numeric'}),toX(i),H-P.b+12);
  }
  ctx.save();ctx.translate(11,P.t+cH/2);ctx.rotate(-Math.PI/2);ctx.fillStyle='rgba(148,163,184,0.55)';ctx.font='9px Arial';ctx.textAlign='center';ctx.fillText(yLabel,0,0);ctx.restore();
  const hi=data.findIndex(d=>d.halted);
  if(hi>=0){ctx.fillStyle='rgba(244,63,94,0.06)';ctx.fillRect(toX(hi),P.t,toX(data.length-1)-toX(hi),cH);}
  // Mark swap points
  const swapDates=new Set(state.swaps.filter(s=>!s.isRecenter).map(s=>s.date.substring(0,13)));
  data.forEach((d,i)=>{
    if(swapDates.has(d.date.substring(0,13))){
      ctx.fillStyle='rgba(250,204,21,0.4)';
      ctx.fillRect(toX(i)-0.5,P.t,1,cH);
    }
  });
  for(const s of series){
    const sc=s.scale??1;ctx.beginPath();ctx.strokeStyle=s.color;ctx.lineWidth=1.4;ctx.lineJoin='round';
    data.forEach((d,i)=>{const x=toX(i),y=toY(d[s.key]*sc);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.stroke();
  }
  let lx=P.l;
  for(const s of series){
    ctx.fillStyle=s.color;ctx.fillRect(lx,8,12,3);
    ctx.fillStyle='rgba(148,163,184,0.85)';ctx.font='9px Arial';ctx.textAlign='left';ctx.fillText(s.label,lx+15,12);
    lx+=ctx.measureText(s.label).width+32;
  }
}

function renderTable(){
  if(!state.swaps.length){swapCount.classList.add('hidden');swapContainer.innerHTML='<div class="empty-state compact"><h3>No trades</h3><p>Adjust Z-threshold or RSI levels.</p></div>';return;}
  const a1=asset1Label.value||'Asset 1',a2=asset2Label.value||'Asset 2';
  swapCount.textContent=`${state.swaps.length} records`;swapCount.classList.remove('hidden');
  const rows=state.swaps.slice(-500);
  const note=state.swaps.length>500?`<p class="table-note">Last 500 of ${state.swaps.length}. Download for full.</p>`:'';
  swapContainer.innerHTML=note+`
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date/Time</th><th>Type</th><th>Regime</th><th class="col-num">Z-Score</th>
        <th class="col-num">RSI</th><th class="col-num">½-Life hr</th>
        <th class="col-num">Width%</th><th class="col-num">ATR%</th>
        <th>Action</th>
        <th>Bought</th><th class="col-num">Qty</th><th class="col-num">Cost ₹</th>
        <th>Sold</th><th class="col-num">Qty</th><th class="col-num">Rev ₹</th>
        <th class="col-num">Gross</th><th class="col-num">Brok</th><th class="col-num">Net ₹</th>
        <th class="col-num">Cash</th>
        <th class="col-num">${a1}</th><th class="col-num">${a2}</th><th class="col-num">IL%</th>
      </tr></thead>
      <tbody>${rows.map(s=>`
        <tr class="${s.isRecenter?'recenter-trade-row':''} ${s.extreme?'extreme-row':''}">
          <td>${new Date(s.date).toLocaleString('en-IN')}</td>
          <td>${s.isRecenter?'<span class="type-pill recenter">RECENTER</span>':'<span class="type-pill swap">SWAP</span>'}</td>
          <td><span class="regime-pill r-${(s.regime||'').toLowerCase().replace('_','-').substring(0,4)}">${(s.regime||'').substring(0,8)}</span></td>
          <td class="col-num ${Math.abs(s.zScore||0)>1.5?'highlight-z':''}">${dec(s.zScore||0,3)}</td>
          <td class="col-num">${dec(s.rsi||50,1)}</td>
          <td class="col-num">${isFinite(s.halfLife)&&s.halfLife<999?dec(s.halfLife,0):'∞'}</td>
          <td class="col-num">${dec(s.activeWidthPct||0,2)}%</td>
          <td class="col-num">${dec(s.atrPct||0,3)}%</td>
          <td class="action-cell">${s.action}</td>
          <td>${s.boughtAsset}</td><td class="col-num">${qty(s.boughtQty)}</td>
          <td class="col-num negative">${inr2(s.boughtCost)}</td>
          <td>${s.soldAsset}</td><td class="col-num">${qty(s.soldQty)}</td>
          <td class="col-num positive">${inr2(s.soldRevenue)}</td>
          <td class="col-num ${(s.grossProfit||0)>=0?'positive':'negative'}">${inr2(s.grossProfit||0)}</td>
          <td class="col-num negative">${inr2(s.totalBrokerageRow||0)}</td>
          <td class="col-num ${(s.netProfit||0)>=0?'positive':'negative'}">${inr2(s.netProfit||0)}</td>
          <td class="col-num">${inr(s.cashProfit||0)}</td>
          <td class="col-num">${qty(s.poolX)}</td>
          <td class="col-num">${qty(s.poolY)}</td>
          <td class="col-num ${(s.ilPct||0)>=0?'positive':'negative'}">${dec(s.ilPct||0,3)}%</td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

function downloadCsv(rows){
  const h=['Date','Type','Regime','ZScore','RSI','HalfLife_hrs','Width%','ATR%','Action',
    'BoughtAsset','Qty','BuyCost_INR','SoldAsset','Qty','SellRev_INR',
    'Gross_INR','Brok_INR','Net_INR','Cash_INR',
    'Asset1Px','Asset2Px','A1Shares','A2Shares','PoolAssetVal','IL_Pct','TotalVal'];
  const lines=[h.join(',')].concat(rows.map(r=>[
    r.date,r.isRecenter?'RECENTER':'SWAP',r.regime||'',
    dec(r.zScore||0,6),dec(r.rsi||50,2),isFinite(r.halfLife)&&r.halfLife<999?dec(r.halfLife,0):'inf',
    dec(r.activeWidthPct||0,4),dec(r.atrPct||0,4),`"${r.action}"`,
    r.boughtAsset,Math.round(r.boughtQty||0),dec(r.boughtCost||0,2),
    r.soldAsset,Math.round(r.soldQty||0),dec(r.soldRevenue||0,2),
    dec(r.grossProfit||0,2),dec(r.totalBrokerageRow||0,2),dec(r.netProfit||0,2),dec(r.cashProfit||0,2),
    r.asset1Price,r.asset2Price,Math.round(r.poolX||0),Math.round(r.poolY||0),
    dec(r.poolAssetValue||0,2),dec(r.ilPct||0,4),dec(r.totalValue||0,2),
  ].join(',')));
  const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  Object.assign(document.createElement('a'),{href:url,download:'amm_v9.csv'}).click();
  URL.revokeObjectURL(url);
}
