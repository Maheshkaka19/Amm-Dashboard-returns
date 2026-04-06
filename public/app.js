import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = { swaps: [], results: null, equity: [], optimizerLog: [] };
const $ = id => document.getElementById(id);

// DOM
const asset1File     = $('asset1File'),    asset2File     = $('asset2File');
const asset1FN       = $('asset1FileName'),asset2FN       = $('asset2FileName');
const asset1Label    = $('asset1Label'),   asset2Label    = $('asset2Label');
const realCapInput   = $('realCapital');
const buyBrokInput   = $('buyBrokeragePct'),  sellBrokInput = $('sellBrokeragePct');
const trainDaysInput = $('trainDays'),    testDaysInput  = $('testDays');
const wfToggle       = $('walkForward');
const midWInput      = $('midWidth');
const cooldownInput  = $('cooldownHours');
const profBufInput   = $('profitBuffer');
const atrMultInput   = $('atrMultiplier');
const atrPeriodInput = $('atrPeriod');
const corrLBInput    = $('corrLookbackHours');
const corrImpInput   = $('correlationImpact');
const extremeInput   = $('extremeMult');
const sigmaInput     = $('sigmaThreshold');
const lookbackInput  = $('lookbackHours');
const pauseHighInput = $('pauseHighVol');
const pauseVolInput  = $('pauseVolatile');
const recenterOnInput= $('recenterEnabled');
const ilStopInput    = $('ilStopLossPct');
const runBtn         = $('runSimulation');
const statusBanner   = $('statusBanner'),  ilBanner = $('ilBanner');
const metricsGrid    = $('metricsGrid');
const swapContainer  = $('swapTableContainer');
const downloadBtn    = $('downloadCsv'),   swapCount = $('swapCount');
const pairHeading    = $('pairHeading');
const chartCanvas    = $('equityChart'),   corrCanvas = $('corrChart');
const optimizerPanel = $('optimizerPanel');

// Formatters
const inr  = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(v);
const inr2 = v => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const pct  = (v,d=2) => `${v>=0?'+':''}${(+v).toFixed(d)}%`;
const qty  = v => new Intl.NumberFormat('en-IN',{maximumFractionDigits:0}).format(Math.round(+v));
const dec  = (v,d=2) => (+v).toFixed(d);

asset1File.addEventListener('change',()=>{ asset1FN.textContent=asset1File.files[0]?.name||'Upload Asset 1 CSV'; });
asset2File.addEventListener('change',()=>{ asset2FN.textContent=asset2File.files[0]?.name||'Upload Asset 2 CSV'; });
asset1Label.addEventListener('input',updateHeading);
asset2Label.addEventListener('input',updateHeading);
downloadBtn.addEventListener('click',()=>downloadCsv(state.swaps));
runBtn.addEventListener('click',handleRun);
wfToggle.addEventListener('change',()=>{
  document.querySelectorAll('.wf-only').forEach(el=>el.style.display=wfToggle.checked?'':'none');
});
updateHeading();

function updateHeading(){pairHeading.textContent=`${asset1Label.value||'Asset 1'} ↔ ${asset2Label.value||'Asset 2'}`;}
function setStatus(type,msg){
  statusBanner.className=`status-banner ${type}`;
  statusBanner.innerHTML=`<strong>${type.toUpperCase()}:</strong> <span>${msg}</span>`;
}

function getConfig(){
  return {
    buyBrokeragePct:    +buyBrokInput.value,
    sellBrokeragePct:   +sellBrokInput.value,
    walkForward:        wfToggle.checked,
    trainDays:          +trainDaysInput.value,
    testDays:           +testDaysInput.value,
    midWidth:           +midWInput.value,
    cooldownHours:      +cooldownInput.value,
    profitBuffer:       +profBufInput.value,
    atrMultiplier:      +atrMultInput.value,
    atrPeriod:          +atrPeriodInput.value,
    corrLookbackHours:  +corrLBInput.value,
    correlationImpact:  +corrImpInput.value,
    extremeMult:        +extremeInput.value,
    sigmaThreshold:     +sigmaInput.value,
    lookbackHours:      +lookbackInput.value,
    pauseHighVol:       pauseHighInput.checked,
    pauseVolatile:      pauseVolInput.checked,
    recenterEnabled:    recenterOnInput.checked,
    ilStopLossPct:      +ilStopInput.value,
  };
}

async function handleRun(){
  if (!asset1File.files[0]||!asset2File.files[0]){setStatus('error','Upload both CSV files first.');return;}
  runBtn.disabled=true; runBtn.textContent='Running…';
  ilBanner.classList.add('hidden');
  const wf = wfToggle.checked;
  setStatus('info', wf
    ? `Walk-forward optimizer: training ${trainDaysInput.value}d → applying ${testDaysInput.value}d windows...`
    : 'Running with static parameters...');
  try {
    await new Promise(r=>setTimeout(r,10));
    const [t1,t2]=await Promise.all([asset1File.files[0].text(),asset2File.files[0].text()]);
    const result=runAlmSimulation(parseCsv(t1),parseCsv(t2),+realCapInput.value,getConfig());
    if (result.error){
      state.swaps=[];state.results=null;state.equity=[];state.optimizerLog=[];
      renderMetrics();renderTable();renderOptimizerLog();
      setStatus('error',result.error);
    } else {
      state.swaps=result.swaps; state.results=result.results;
      state.equity=result.equityCurve; state.optimizerLog=result.optimizerLog||[];
      renderMetrics(); renderTable(); renderCharts(); renderOptimizerLog(); renderIlBanner();
      const r=result.results;
      const vs=r.vsHold; const vsp=r.vsHoldPct;
      if (vs>=0){
        setStatus('success',
          `AMM beat hold by ${inr(vs)} (+${dec(vsp,3)}%) | ` +
          `Cash: ${inr(r.cashProfit)} | Brokerage: ${inr(r.totalBrokerage)} | ` +
          `Recenters: ${r.recenterCount} | IL: ${dec(r.ilPct,3)}% | ` +
          `Harvest/Recenter: ${inr(r.harvestPerRecenter)}`);
      } else {
        setStatus('warning',
          `Underperformed hold by ${inr(-vs)} (${dec(vsp,3)}%) | ` +
          `Cash: ${inr(r.cashProfit)} | IL: ${dec(r.ilPct,3)}% | ` +
          `${r.recenterCount} recenters cost ${inr(r.totalBrokerage)} — ` +
          `reduce recenters or pick a more volatile pair.`);
      }
    }
  } catch(err){setStatus('error',err.message||'Parse error.');}
  finally{runBtn.disabled=false;runBtn.textContent='▶ Run Simulation';}
}

function renderIlBanner(){
  const r=state.results;
  if(!r||!r.ilHalted){ilBanner.classList.add('hidden');return;}
  ilBanner.className='il-banner halted';
  ilBanner.innerHTML=`<span class="il-icon">⛔</span><div><strong>IL Stop-Loss Triggered</strong><span>Halted at ${new Date(r.ilHaltedAt).toLocaleString('en-IN')} — IL exceeded −${(+ilStopInput.value).toFixed(1)}%.</span></div>`;
  ilBanner.classList.remove('hidden');
}

function renderMetrics(){
  if(!state.results){
    metricsGrid.innerHTML='<div class="empty-state"><h3>No results yet</h3><p>Upload CSV files and run.</p></div>';
    downloadBtn.classList.add('hidden');return;
  }
  const r=state.results;
  const a1=asset1Label.value||'Asset 1',a2=asset2Label.value||'Asset 2';
  const cards=[
    // Headline
    {label:'AMM vs Buy-and-Hold',      value:inr(r.vsHold),            delta:pct(r.vsHoldPct,3),  positive:r.vsHold>=0,      highlight:true},
    // Capital
    {label:'Cash Deployed',            value:inr(r.initCashDeployed),  delta:null},
    {label:'Total AMM Value',          value:inr(r.totalValue),        delta:pct(r.roiPct),        positive:r.roiPct>=0},
    {label:'Buy-and-Hold Value',       value:inr(r.holdValue),         delta:pct(r.holdRoi),       positive:r.holdRoi>=0},
    {label:'Pool Asset Value',         value:inr(r.poolAssets),        delta:null},
    // P&L
    {label:'Cash Profit (swaps+rec)',  value:inr(r.cashProfit),        delta:pct(r.cashRoi),       positive:r.cashProfit>=0},
    {label:'Total Brokerage Paid',     value:inr(r.totalBrokerage),    delta:pct(-r.brokRoi),      positive:false},
    {label:'Impermanent Loss',         value:inr(r.ilINR),             delta:pct(r.ilPct,3),       positive:r.ilPct>=0},
    {label:'Alpha Efficiency (P/B)',   value:`${dec(r.alphaEfficiency,2)}×`, delta:null},
    // Trades
    {label:'Profitable Swaps',         value:r.totalSwaps.toLocaleString('en-IN'),  delta:null},
    {label:'Recenter Trades',          value:r.recenterSwaps.toLocaleString('en-IN'),delta:null},
    {label:'Recenter Events',          value:r.recenterCount.toLocaleString('en-IN'),delta:null},
    {label:'Harvest per Recenter',     value:inr(r.harvestPerRecenter),delta:null},
    {label:'IL Stop-Loss Hit',         value:r.ilHalted?'⛔ Yes':'✅ No',delta:null},
    // Optimizer
    {label:'Optimizer Windows',        value:r.optimizerWindows.toLocaleString('en-IN'),delta:null},
    {label:'Active Width',             value:`${dec(r.activeParams.width*100,2)}%`,delta:null},
    {label:'Active Cooldown',          value:`${r.activeParams.cooldown}h`,delta:null},
    {label:'Active Profit Buffer',     value:`${dec(r.activeParams.profitBuffer,1)}×`,delta:null},
    // Inventory
    {label:`Initial ${a1}`,           value:qty(r.initialX),          delta:null},
    {label:`Initial ${a2}`,           value:qty(r.initialY),          delta:null},
    {label:`Final ${a1}`,             value:qty(r.finalX),            delta:null},
    {label:`Final ${a2}`,             value:qty(r.finalY),            delta:null},
    // Regimes
    {label:'Hours Trending/Ranging/Vol',value:`${r.trendingHours}/${r.rangingHours}/${r.volatileHours}`,delta:null},
    {label:'Hours Low/Mid/High vol',   value:`${r.lowModeHours}/${r.midModeHours}/${r.highModeHours}`,delta:null},
  ];
  metricsGrid.innerHTML=cards.map(({label,value,delta,positive,highlight})=>`
    <div class="metric-card${highlight?' metric-highlight':''}">
      <span class="mc-label">${label}</span>
      <strong class="mc-value">${value}</strong>
      ${delta!=null?`<em class="mc-delta ${positive?'positive':'negative'}">${delta}</em>`:''}
    </div>`).join('');
  downloadBtn.classList.remove('hidden');
}

// ─── Optimizer Log Panel ──────────────────────────────────────────────────────
function renderOptimizerLog(){
  if(!state.optimizerLog.length){
    optimizerPanel.innerHTML='<div class="empty-state compact"><h3>Walk-forward disabled or no windows yet</h3></div>';
    return;
  }
  optimizerPanel.innerHTML=`
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date</th><th>Hour</th><th class="col-num">Width%</th>
        <th class="col-num">Cooldown</th><th class="col-num">Profit Buf</th>
        <th class="col-num">ATR Mult</th><th class="col-num">Pool Value at Train</th>
      </tr></thead>
      <tbody>${state.optimizerLog.map(w=>`
        <tr>
          <td>${new Date(w.date).toLocaleDateString('en-IN')}</td>
          <td class="col-num">${w.atHour}</td>
          <td class="col-num">${dec(w.params.width*100,2)}%</td>
          <td class="col-num">${w.params.cooldown}h</td>
          <td class="col-num">${dec(w.params.profitBuffer,1)}×</td>
          <td class="col-num">${dec(w.params.atrMult,1)}×</td>
          <td class="col-num">${inr(w.poolValueAtTrain)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function renderCharts(){
  if(!state.equity.length) return;
  const step=Math.max(1,Math.floor(state.equity.length/500));
  const s=state.equity.filter((_,i)=>i%step===0);
  drawChart(chartCanvas,s,[
    {key:'poolValue', label:'AMM Total Value',  color:'#38bdf8'},
    {key:'holdValue', label:'Buy-and-Hold',     color:'#818cf8'},
    {key:'cashProfit',label:'Cash Profit',      color:'#22c55e'},
  ],'₹ Value');
  drawChart(corrCanvas,s,[
    {key:'correlation',     label:'Correlation',    color:'#f97316'},
    {key:'activeWidthPct',  label:'Width% (÷100)',  color:'#a78bfa',scale:0.01},
    {key:'ilPct',           label:'IL% (÷100)',     color:'#f43f5e',scale:0.01},
  ],'−1 → +1');
}

function drawChart(canvas,data,series,yLabel){
  const dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height,P={t:28,r:16,b:46,l:90};
  const cW=W-P.l-P.r,cH=H-P.t-P.b;
  ctx.clearRect(0,0,W,H);
  let yMin=Infinity,yMax=-Infinity;
  for(const s of series){const sc=s.scale??1;for(const d of data){const v=d[s.key]*sc;if(v<yMin)yMin=v;if(v>yMax)yMax=v;}}
  if(!isFinite(yMin))yMin=0;if(!isFinite(yMax))yMax=1;if(yMin===yMax){yMin-=1;yMax+=1;}
  const yRng=yMax-yMin;
  const toX=i=>P.l+(i/(data.length-1||1))*cW;
  const toY=v=>P.t+cH-((v-yMin)/yRng)*cH;
  // Optimizer event lines
  for(const w of state.optimizerLog){
    const ei=data.findIndex(d=>d.date>=w.date);
    if(ei>=0){
      ctx.strokeStyle='rgba(250,204,21,0.30)';ctx.lineWidth=1;ctx.setLineDash([3,4]);
      ctx.beginPath();ctx.moveTo(toX(ei),P.t);ctx.lineTo(toX(ei),P.t+cH);ctx.stroke();ctx.setLineDash([]);
    }
  }
  for(let g=0;g<=5;g++){
    const yv=yMin+(g/5)*yRng,yp=toY(yv);
    ctx.strokeStyle='rgba(148,163,184,0.09)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(P.l,yp);ctx.lineTo(P.l+cW,yp);ctx.stroke();
    ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='10px Arial';ctx.textAlign='right';
    const lbl=Math.abs(yRng)>50000?`₹${(yv/1e5).toFixed(1)}L`:Math.abs(yRng)>1000?`₹${(yv/1e3).toFixed(1)}K`:yv.toFixed(3);
    ctx.fillText(lbl,P.l-4,yp+3.5);
  }
  for(let s=0;s<=5;s++){
    const i=Math.round((s/5)*(data.length-1));
    ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='10px Arial';ctx.textAlign='center';
    ctx.fillText(new Date(data[i].date).toLocaleDateString('en-IN',{month:'short',day:'numeric'}),toX(i),H-P.b+13);
  }
  ctx.save();ctx.translate(13,P.t+cH/2);ctx.rotate(-Math.PI/2);
  ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='11px Arial';ctx.textAlign='center';
  ctx.fillText(yLabel,0,0);ctx.restore();
  const hi=data.findIndex(d=>d.halted);
  if(hi>=0){
    ctx.fillStyle='rgba(244,63,94,0.07)';ctx.fillRect(toX(hi),P.t,toX(data.length-1)-toX(hi),cH);
    ctx.strokeStyle='rgba(244,63,94,0.35)';ctx.lineWidth=1;ctx.setLineDash([4,4]);
    ctx.beginPath();ctx.moveTo(toX(hi),P.t);ctx.lineTo(toX(hi),P.t+cH);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='rgba(244,63,94,0.65)';ctx.font='10px Arial';ctx.textAlign='left';ctx.fillText('IL halt',toX(hi)+3,P.t+11);
  }
  for(const s of series){
    const sc=s.scale??1;ctx.beginPath();ctx.strokeStyle=s.color;ctx.lineWidth=1.5;ctx.lineJoin='round';
    data.forEach((d,i)=>{const x=toX(i),y=toY(d[s.key]*sc);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);});
    ctx.stroke();
  }
  let lx=P.l;
  for(const s of series){
    ctx.fillStyle=s.color;ctx.fillRect(lx,9,14,3);
    ctx.fillStyle='rgba(148,163,184,0.85)';ctx.font='10px Arial';ctx.textAlign='left';ctx.fillText(s.label,lx+18,14);
    lx+=ctx.measureText(s.label).width+36;
  }
}

// ─── Trade table ──────────────────────────────────────────────────────────────
function renderTable(){
  if(!state.swaps.length){
    swapCount.classList.add('hidden');
    swapContainer.innerHTML='<div class="empty-state compact"><h3>No trades</h3><p>Try tighter width (1–2%) or larger capital.</p></div>';
    return;
  }
  const a1=asset1Label.value||'Asset 1',a2=asset2Label.value||'Asset 2';
  swapCount.textContent=`${state.swaps.length} records`;swapCount.classList.remove('hidden');
  const rows=state.swaps.slice(-500);
  const note=state.swaps.length>500?`<p class="table-note">Showing last 500 of ${state.swaps.length}. Download CSV for full history.</p>`:'';
  swapContainer.innerHTML=note+`
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date/Time</th><th>Type</th><th>Mode</th><th>Regime</th>
        <th>Corr</th><th>Width%</th><th>ATR%</th><th>Optim</th>
        <th>Action</th>
        <th>Bought</th><th class="col-num">Shares</th><th class="col-num">Cost ₹</th><th class="col-num">Brok↑</th>
        <th>Sold</th><th class="col-num">Shares</th><th class="col-num">Rev ₹</th><th class="col-num">Brok↓</th>
        <th class="col-num">Gross</th><th class="col-num">Net ₹</th><th class="col-num">Cash Accum.</th>
        <th class="col-num">${a1}</th><th class="col-num">${a2}</th><th class="col-num">IL%</th>
      </tr></thead>
      <tbody>${rows.map(s=>`
        <tr class="${s.isRecenter?'recenter-trade-row':''} ${s.extreme?'extreme-row':''} ${s.justOptimized?'optim-row':''}">
          <td>${new Date(s.date).toLocaleString('en-IN')}</td>
          <td>${s.isRecenter?'<span class="type-pill recenter">RECENTER</span>':'<span class="type-pill swap">SWAP</span>'}</td>
          <td><span class="mode-pill mode-${s.mode.toLowerCase()}">${s.mode}</span></td>
          <td><span class="regime-pill regime-${s.regime.toLowerCase()}">${s.regime.substring(0,4)}</span></td>
          <td>${dec(s.rollingCorrelation,3)}</td>
          <td>${dec(s.activeWidthPct,2)}%</td>
          <td>${dec(s.atrPct,3)}%</td>
          <td>${s.justOptimized?'🔄':''}</td>
          <td class="action-cell">${s.action}</td>
          <td>${s.boughtAsset}</td>
          <td class="col-num">${qty(s.boughtQty)}</td>
          <td class="col-num negative">${inr2(s.boughtCost)}</td>
          <td class="col-num negative">${inr2(s.brokerageOnBuy)}</td>
          <td>${s.soldAsset}</td>
          <td class="col-num">${qty(s.soldQty)}</td>
          <td class="col-num positive">${inr2(s.soldRevenue)}</td>
          <td class="col-num negative">${inr2(s.brokerageOnSell)}</td>
          <td class="col-num ${s.grossProfit>=0?'positive':'negative'}">${inr2(s.grossProfit)}</td>
          <td class="col-num ${s.netProfit>=0?'positive':'negative'}">${inr2(s.netProfit)}</td>
          <td class="col-num">${inr(s.cashProfit)}</td>
          <td class="col-num">${qty(s.poolX)}</td>
          <td class="col-num">${qty(s.poolY)}</td>
          <td class="col-num ${s.ilPct>=0?'positive':'negative'}">${dec(s.ilPct,3)}%</td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

// ─── CSV download ──────────────────────────────────────────────────────────────
function downloadCsv(rows){
  const h=['Date','Type','Mode','Regime','Correlation','Width%','ATR%','Optimized','Action',
    'BoughtAsset','SharesBought','BuyCost_INR','BrokerBuy_INR',
    'SoldAsset','SharesSold','SellRev_INR','BrokerSell_INR',
    'GrossProfit_INR','TotalBrok_INR','NetProfit_INR','CashAccum_INR',
    'Asset1Price','Asset2Price','Asset1Shares','Asset2Shares',
    'PoolAssetVal_INR','IL_Pct','TotalValue_INR'];
  const lines=[h.join(',')].concat(rows.map(r=>[
    r.date,r.isRecenter?'RECENTER':'SWAP',r.mode,r.regime,
    dec(r.rollingCorrelation,6),dec(r.activeWidthPct,4),dec(r.atrPct,4),r.justOptimized?1:0,
    `"${r.action}"`,
    r.boughtAsset,Math.round(r.boughtQty),dec(r.boughtCost,2),dec(r.brokerageOnBuy,2),
    r.soldAsset,Math.round(r.soldQty),dec(r.soldRevenue,2),dec(r.brokerageOnSell,2),
    dec(r.grossProfit,2),dec(r.totalBrokerageRow,2),dec(r.netProfit,2),dec(r.cashProfit,2),
    r.asset1Price,r.asset2Price,Math.round(r.poolX),Math.round(r.poolY),
    dec(r.poolAssetValue,2),dec(r.ilPct,4),dec(r.totalValue,2),
  ].join(',')));
  const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  Object.assign(document.createElement('a'),{href:url,download:'amm_swaps_v7.csv'}).click();
  URL.revokeObjectURL(url);
}
