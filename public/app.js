import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = { swaps: [], results: null, equity: [], perf: null };
const $     = id => document.getElementById(id);
const inr   = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(v);
const inr2  = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const pct   = (v,d=2) => `${v>=0?'+':''}${(+v).toFixed(d)}%`;
const dec   = (v,d=2) => (+v).toFixed(d);
const qty   = v => Math.round(+v).toLocaleString('en-IN');

// DOM
const asset1File  = $('asset1File'),    asset2File  = $('asset2File');
const asset1Name  = $('asset1FileName'),asset2Name  = $('asset2FileName');
const asset1Label = $('asset1Label'),   asset2Label = $('asset2Label');
const runBtn      = $('runSimulation');
const statusBanner= $('statusBanner'),  haltBanner  = $('haltBanner');
const metricsGrid = $('metricsGrid'),   perfPanel   = $('perfPanel');
const chartCanvas = $('equityChart'),   alphaCanvas = $('alphaChart');
const tableWrap   = $('tableWrap'),     swapCount   = $('swapCount');
const dlBtn       = $('downloadCsv'),   pairHeading = $('pairHeading');
const bandLabel   = $('bandLabel');

asset1File.addEventListener('change',()=>{ asset1Name.textContent=asset1File.files[0]?.name||'Upload Asset 1 CSV'; });
asset2File.addEventListener('change',()=>{ asset2Name.textContent=asset2File.files[0]?.name||'Upload Asset 2 CSV'; });
asset1Label.addEventListener('input',updateHeading);
asset2Label.addEventListener('input',updateHeading);
dlBtn.addEventListener('click',()=>downloadCsv(state.swaps));
runBtn.addEventListener('click',handleRun);
$('bandPct')?.addEventListener('input', updateBandLabel);
updateHeading(); updateBandLabel();

function updateHeading(){
  pairHeading.textContent=`${asset1Label.value||'Asset 1'}  ↔  ${asset2Label.value||'Asset 2'}`;
}
function updateBandLabel(){
  const b = +($('bandPct')?.value||20);
  if (!bandLabel) return;
  const cf = 1/(1-Math.sqrt((1-b/100)/(1+b/100)));
  bandLabel.textContent = `±${b}% range  ·  ${cf.toFixed(1)}× concentration vs full-range`;
}
function setStatus(type,msg){
  statusBanner.className=`status-banner status-${type}`;
  statusBanner.innerHTML=`<strong>${type.toUpperCase()}:</strong> <span>${msg}</span>`;
}
function getConfig(){
  return {
    bandPct:                  +$('bandPct').value,
    buyBrokeragePct:          +$('buyBrokeragePct').value,
    sellBrokeragePct:         +$('sellBrokeragePct').value,
    ilStopLossPct:            +$('ilStopLossPct').value,
    ilResumePct:              +$('ilResumePct').value,
    alphaProtectEnabled:       $('alphaProtectEnabled').checked,
    alphaProtectThresholdPct: +$('alphaProtectThresholdPct').value,
  };
}

async function handleRun(){
  if (!asset1File.files[0]||!asset2File.files[0]){setStatus('error','Upload both CSV files before running.');return;}
  runBtn.disabled=true; runBtn.textContent='Running…';
  haltBanner.classList.add('hidden');
  setStatus('info','Computing V3 liquidity parameter L and running hourly swap simulation…');
  try {
    await new Promise(r=>setTimeout(r,10));
    const [t1,t2]=await Promise.all([asset1File.files[0].text(),asset2File.files[0].text()]);
    const result=runAlmSimulation(parseCsv(t1),parseCsv(t2),+$('realCapital').value,getConfig());
    if (result.error){
      setStatus('error',result.error); resetPanels();
    } else {
      state.swaps=result.swaps; state.results=result.results;
      state.equity=result.equityCurve; state.perf=result.performanceSummary;
      renderMetrics(); renderPerf(); renderCharts(); renderTable(); renderHaltBanner();
      const r=result.results;
      setStatus(r.vsHold>=0?'success':'warning',
        `${r.vsHold>=0?'Pool beats hold':'Pool behind hold'} by ${inr(Math.abs(r.vsHold))} (${dec(r.vsHoldPct,3)}%)  ·  `+
        `Cash: ${inr(r.cashProfit)}  ·  IL: ${dec(r.ilPct,3)}%  ·  `+
        `Swaps: ${r.totalSwaps}  ·  L=${dec(r.L,0)}  ·  ${dec(r.concentrationFactor,1)}× concentration`);
    }
  } catch(e){setStatus('error',e.message||'Error.');resetPanels();}
  runBtn.disabled=false; runBtn.textContent='▶ Run Simulation';
}
function resetPanels(){
  state.swaps=[];state.results=null;state.equity=[];state.perf=null;
  renderMetrics();renderPerf();renderTable();
}

// ─── Halt banner ──────────────────────────────────────────────────────────────
function renderHaltBanner(){
  const r=state.results; haltBanner.classList.add('hidden');
  if (!r) return;
  const lines=[];
  if (r.swapsHalted){
    if (r.haltReason==='IL_STOP'){
      lines.push(`<strong>⛔ IL Stop-Loss Active</strong>`);
      lines.push(`Halted at ${new Date(r.ilHaltedAt).toLocaleString('en-IN')} — IL exceeded −${dec($('ilStopLossPct').value,1)}%. Resumes when IL recovers above −${dec($('ilResumePct').value,1)}%.`);
    } else if (r.haltReason==='ALPHA_PROTECT'){
      lines.push(`<strong>🛡️ Alpha-Protection Active</strong>`);
      lines.push(`Paused — IL has reached the accumulated cash alpha level. Net-zero preserved. Resumes when IL retreats below cash ROI.`);
    }
    haltBanner.className='halt-banner halted';
  } else if (r.ilResumedAt){
    lines.push(`<strong>✅ Swaps Resumed</strong>`);
    lines.push(`Last resumed: ${new Date(r.ilResumedAt).toLocaleString('en-IN')}.${r.haltCount>1?` (${r.haltCount} cycles)`:`'`}`);
    haltBanner.className='halt-banner resumed';
  } else if (r.alphaProtected){
    lines.push(`<strong>🛡️ Alpha-Protection fired ${r.haltCount}× — net-alpha preserved.</strong>`);
    haltBanner.className='halt-banner protect';
  }
  if (!lines.length) return;
  haltBanner.innerHTML=`<span class="hb-icon">${r.swapsHalted?(r.haltReason==='ALPHA_PROTECT'?'🛡️':'⛔'):'✅'}</span><div class="hb-lines">${lines.map(l=>`<span>${l}</span>`).join('')}</div>`;
  haltBanner.classList.remove('hidden');
}

// ─── Metrics ──────────────────────────────────────────────────────────────────
function renderMetrics(){
  if (!state.results){
    metricsGrid.innerHTML='<div class="empty-state"><p>Upload CSV files and run the simulation.</p></div>';
    dlBtn.classList.add('hidden');return;
  }
  const r=state.results;
  const a1=asset1Label.value||'Asset 1',a2=asset2Label.value||'Asset 2';
  const cards=[
    {label:'Pool vs Buy-and-Hold',      value:inr(r.vsHold),          delta:pct(r.vsHoldPct,3),  pos:r.vsHold>=0,  hl:true},
    {label:'Total AMM Value',           value:inr(r.totalValue),      delta:pct(r.roiPct),        pos:r.roiPct>=0},
    {label:'Buy-and-Hold Value',        value:inr(r.holdValue),       delta:pct(r.holdRoi),       pos:r.holdRoi>=0},
    {label:'Cash Profit (swaps)',       value:inr(r.cashProfit),      delta:pct(r.cashRoi,3),     pos:r.cashProfit>=0},
    {label:'Gross Swap Fees',           value:inr(r.grossSwapFees),   delta:null},
    {label:'Pool Asset Value',          value:inr(r.poolAssets),      delta:null},
    {label:'Unrealized IL',             value:inr(r.ilINR),           delta:pct(r.ilPct,3),       pos:r.ilPct>=0},
    {label:'Total Brokerage Paid',      value:inr(r.totalBrokerage),  delta:pct(-r.brokRoi,3),    pos:false},
    {label:'Liquidity Parameter L',     value:dec(r.L,2),             delta:null},
    {label:'Concentration Factor',      value:`${dec(r.concentrationFactor,1)}×`,delta:null},
    {label:'Band Width (±)',            value:`±${dec(r.bandPct,0)}%`, delta:null},
    {label:'Profitable Swaps',          value:`${r.successSwaps} / ${r.totalSwaps}`,delta:null},
    {label:'Swap Success Rate',         value:`${dec(r.successRate*100,1)}%`,delta:null},
    {label:'Recenter Events',           value:r.recenterCount.toLocaleString('en-IN'),delta:null},
    {label:'Halt / Resume Cycles',      value:r.haltCount>0?`${r.haltCount}×`:'0',delta:null},
    {label:'Alpha-Protection Fired',    value:r.alphaProtected?'🛡️ Yes':'—',delta:null},
    {label:`Initial ${a1} shares`,     value:qty(r.initialX),delta:null},
    {label:`Final ${a1} shares`,       value:qty(r.finalX),  delta:null},
    {label:`Initial ${a2} shares`,     value:qty(r.initialY),delta:null},
    {label:`Final ${a2} shares`,       value:qty(r.finalY),  delta:null},
  ];
  metricsGrid.innerHTML=cards.map(({label,value,delta,pos,hl})=>`
    <div class="metric-card${hl?' hl':''}">
      <span class="mc-label">${label}</span>
      <strong class="mc-value">${value}</strong>
      ${delta!=null?`<em class="mc-delta ${pos?'pos':'neg'}">${delta}</em>`:''}
    </div>`).join('');
  dlBtn.classList.remove('hidden');
}

// ─── Performance panel ────────────────────────────────────────────────────────
function renderPerf(){
  if (!state.perf){perfPanel.innerHTML='<div class="empty-state"><p>Run simulation first.</p></div>';return;}
  const p=state.perf;
  perfPanel.innerHTML=`
    <div class="perf-grid">
      <div class="perf-box">
        <h3>💰 Harvest vs Friction</h3>
        <div class="pr"><span>Gross Swap Fees</span><strong class="pos">${inr(p.grossFees)}</strong></div>
        <div class="pr"><span>Total Brokerage</span><strong class="neg">${inr(p.totalFriction)}</strong></div>
        <div class="pr"><span>Net Cash Income</span><strong>${inr(p.netSwapIncome)}</strong></div>
        <div class="pr"><span>Friction Ratio</span><strong>${dec(p.frictionRatioPct,1)}%</strong></div>
        <div class="pbadge ${p.frictionRatio<0.10?'good':p.frictionRatio<0.25?'ok':'bad'}">${p.narrative.friction}</div>
      </div>
      <div class="perf-box">
        <h3>📈 Risk-Adjusted Return</h3>
        <div class="pr"><span>Alpha Sharpe (ann.)</span><strong>${dec(p.alphaSharpe,3)}</strong></div>
        <div class="pr"><span>Max Alpha Drawdown ₹</span><strong class="neg">${inr(p.maxDrawdownINR)}</strong></div>
        <div class="pr"><span>Max Drawdown %</span><strong class="neg">${dec(p.maxDrawdownPct,3)}%</strong></div>
        <div class="pr"><span>Final Net Alpha</span><strong class="${p.netAlphaFinal>=0?'pos':'neg'}">${inr(p.netAlphaFinal)}</strong></div>
      </div>
      <div class="perf-box">
        <h3>✅ Swap Quality</h3>
        <div class="pr"><span>Total Swaps</span><strong>${p.totalSwaps}</strong></div>
        <div class="pr"><span>Profitable Swaps</span><strong class="pos">${p.successfulSwaps}</strong></div>
        <div class="pr"><span>Success Rate</span><strong>${dec(p.successRatePct,1)}%</strong></div>
        <div class="pbadge ${p.successRate>=1?'good':p.successRate>0.8?'ok':'bad'}">${p.narrative.swapQuality}</div>
      </div>
      <div class="perf-box">
        <h3>🔬 V3 Concentration</h3>
        <div class="pr"><span>Amplification</span><strong class="pos">${dec(p.concentrationFactor,1)}×</strong></div>
        <div class="pr"><span>IL Status</span><strong class="${p.unrealizedIL>=0?'pos':'neg'}">${inr(p.unrealizedIL)}</strong></div>
        <div class="pr"><span>Net Alpha</span><strong class="${p.netAlphaFinal>=0?'pos':'neg'}">${inr(p.netAlphaFinal)}</strong></div>
        <div class="pbadge ok">${p.narrative.concentration}</div>
      </div>
    </div>`;
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function renderCharts(){
  if (!state.equity.length) return;
  const step=Math.max(1,Math.floor(state.equity.length/600));
  const s=state.equity.filter((_,i)=>i%step===0);
  drawChart(chartCanvas,s,[
    {key:'poolValue', label:'AMM Total Value',color:'#38bdf8'},
    {key:'holdValue', label:'Buy-and-Hold',  color:'#818cf8'},
    {key:'cashProfit',label:'Cash Profit',   color:'#22c55e'},
  ],'₹ Value');
  drawChart(alphaCanvas,s,[
    {key:'alphaINR',label:'Net Alpha ₹',  color:'#facc15'},
    {key:'ilPct',   label:'IL% (×1000)', color:'#f43f5e',scale:1000},
  ],'Alpha / IL');
}

function drawChart(canvas,data,series,yLabel){
  if (!canvas||!data.length) return;
  const dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height,P={t:24,r:14,b:40,l:86};
  const cW=W-P.l-P.r,cH=H-P.t-P.b;
  ctx.clearRect(0,0,W,H);
  let yMin=Infinity,yMax=-Infinity;
  for(const s of series){const sc=s.scale??1;for(const d of data){const v=(d[s.key]??0)*sc;if(v<yMin)yMin=v;if(v>yMax)yMax=v;}}
  if(!isFinite(yMin))yMin=0;if(!isFinite(yMax))yMax=1;if(yMin===yMax){yMin-=1;yMax+=1;}
  const yRng=yMax-yMin;
  const toX=i=>P.l+(i/(data.length-1||1))*cW;
  const toY=v=>P.t+cH-((v-yMin)/yRng)*cH;
  if(yMin<0&&yMax>0){const yp=toY(0);ctx.strokeStyle='rgba(148,163,184,.22)';ctx.lineWidth=1;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(P.l,yp);ctx.lineTo(P.l+cW,yp);ctx.stroke();ctx.setLineDash([]);}
  for(let g=0;g<=4;g++){
    const yv=yMin+(g/4)*yRng,yp=toY(yv);
    ctx.strokeStyle='rgba(148,163,184,.07)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(P.l,yp);ctx.lineTo(P.l+cW,yp);ctx.stroke();
    ctx.fillStyle='rgba(148,163,184,.6)';ctx.font='9px Arial';ctx.textAlign='right';
    const lbl=Math.abs(yRng)>50000?`₹${(yv/1e5).toFixed(1)}L`:Math.abs(yRng)>999?`₹${(yv/1e3).toFixed(1)}K`:yv.toFixed(1);
    ctx.fillText(lbl,P.l-3,yp+3);
  }
  for(let i=0;i<=4;i++){const idx=Math.round((i/4)*(data.length-1));ctx.fillStyle='rgba(148,163,184,.6)';ctx.font='9px Arial';ctx.textAlign='center';ctx.fillText(new Date(data[idx].date).toLocaleDateString('en-IN',{month:'short',day:'numeric'}),toX(idx),H-P.b+12);}
  ctx.save();ctx.translate(11,P.t+cH/2);ctx.rotate(-Math.PI/2);ctx.fillStyle='rgba(148,163,184,.6)';ctx.font='9px Arial';ctx.textAlign='center';ctx.fillText(yLabel,0,0);ctx.restore();
  // Halt shading
  let inH=false,hS=0;
  for(let i=0;i<data.length;i++){
    if(data[i].halted&&!inH){inH=true;hS=i;}
    if(!data[i].halted&&inH){ctx.fillStyle='rgba(244,63,94,.07)';ctx.fillRect(toX(hS),P.t,toX(i)-toX(hS),cH);inH=false;}
  }
  if(inH){ctx.fillStyle='rgba(244,63,94,.07)';ctx.fillRect(toX(hS),P.t,toX(data.length-1)-toX(hS),cH);}
  // Swap markers
  const swapSet=new Set(state.swaps.map(s=>s.date.substring(0,13)));
  data.forEach((d,i)=>{if(swapSet.has(d.date.substring(0,13))){ctx.fillStyle='rgba(250,204,21,.35)';ctx.fillRect(toX(i)-.5,P.t,1,cH);}});
  for(const s of series){const sc=s.scale??1;ctx.beginPath();ctx.strokeStyle=s.color;ctx.lineWidth=1.5;ctx.lineJoin='round';data.forEach((d,i)=>{const x=toX(i),y=toY((d[s.key]??0)*sc);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});ctx.stroke();}
  let lx=P.l;for(const s of series){ctx.fillStyle=s.color;ctx.fillRect(lx,7,12,3);ctx.fillStyle='rgba(148,163,184,.85)';ctx.font='9px Arial';ctx.textAlign='left';ctx.fillText(s.label,lx+15,12);lx+=ctx.measureText(s.label).width+30;}
}

// ─── Trade table ───────────────────────────────────────────────────────────────
function renderTable(){
  if (!state.swaps.length){
    swapCount.classList.add('hidden');
    tableWrap.innerHTML='<div class="empty-state"><p>No trades yet. Run the simulation.</p></div>';return;
  }
  const a1=asset1Label.value||'Asset 1',a2=asset2Label.value||'Asset 2';
  const rows=state.swaps.slice(-500);
  swapCount.textContent=`${state.swaps.length} swaps`;swapCount.classList.remove('hidden');
  const note=state.swaps.length>500?`<p class="table-note">Showing last 500 of ${state.swaps.length}. Download CSV for full history.</p>`:'';
  tableWrap.innerHTML=note+`
    <div class="tscroll"><table>
      <thead><tr>
        <th>Date / Time</th><th>Action</th>
        <th>Bought</th><th class="r">Qty</th><th class="r">Cost ₹</th>
        <th>Sold</th><th class="r">Qty</th><th class="r">Revenue ₹</th>
        <th class="r">Gross ₹</th><th class="r">Brok ₹</th><th class="r">Net ₹</th>
        <th class="r">Cash Accum.</th>
        <th class="r">${a1}</th><th class="r">${a2}</th>
        <th class="r">IL%</th><th class="r">L</th><th>Status</th>
      </tr></thead>
      <tbody>${rows.map(s=>`
        <tr class="${s.haltReason?'tr-halted':''}">
          <td>${new Date(s.date).toLocaleString('en-IN')}</td>
          <td>${s.action}</td>
          <td>${s.buyAsset}</td><td class="r">${qty(s.buyQty)}</td><td class="r neg">${inr2(s.cost)}</td>
          <td>${s.sellAsset}</td><td class="r">${qty(s.sellQty)}</td><td class="r pos">${inr2(s.revenue)}</td>
          <td class="r ${s.gross>=0?'pos':'neg'}">${inr2(s.gross)}</td>
          <td class="r neg">${inr2(s.brok)}</td>
          <td class="r ${s.net>=0?'pos':'neg'}">${inr2(s.net)}</td>
          <td class="r">${inr(s.cashProfit)}</td>
          <td class="r">${qty(s.poolX)}</td>
          <td class="r">${qty(s.poolY)}</td>
          <td class="r ${s.ilPct>=0?'pos':'neg'}">${dec(s.ilPct,3)}%</td>
          <td class="r">${dec(s.L??0,0)}</td>
          <td>${s.haltReason?`<span class="pill halt">${s.haltReason==='ALPHA_PROTECT'?'🛡️':'⛔'}</span>`:''}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

function downloadCsv(rows){
  const h=['Date','Action','BuyAsset','BuyQty','Cost_INR','SellAsset','SellQty','Rev_INR','Gross_INR','Brok_INR','Net_INR','CashAccum_INR','A1Price','A2Price','A1Shares','A2Shares','IL_Pct','L','rLow','rHigh','TotalVal','HaltReason'];
  const lines=[h.join(',')].concat(rows.map(r=>[
    r.date,`"${r.action}"`,r.buyAsset,Math.round(r.buyQty),dec(r.cost,2),
    r.sellAsset,Math.round(r.sellQty),dec(r.revenue,2),
    dec(r.gross,2),dec(r.brok,2),dec(r.net,2),dec(r.cashProfit,2),
    r.asset1Price,r.asset2Price,Math.round(r.poolX),Math.round(r.poolY),
    dec(r.ilPct,4),dec(r.L??0,2),dec(r.rLow??0,6),dec(r.rHigh??0,6),
    dec(r.totalValue,2),r.haltReason||'',
  ].join(',')));
  const blob=new Blob([lines.join('\n')],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  Object.assign(document.createElement('a'),{href:url,download:'v3_pool_trades.csv'}).click();
  URL.revokeObjectURL(url);
}
