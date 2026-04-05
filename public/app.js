import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = { swaps: [], results: null, equity: [] };
const $ = id => document.getElementById(id);

// DOM
const asset1File      = $('asset1File'),   asset2File      = $('asset2File');
const asset1FileName  = $('asset1FileName'),asset2FileName  = $('asset2FileName');
const asset1Label     = $('asset1Label'),  asset2Label     = $('asset2Label');
const realCapInput    = $('realCapital');
const buyBrokInput    = $('buyBrokeragePct'), sellBrokInput = $('sellBrokeragePct');
const lowWInput       = $('lowWidth'),  midWInput   = $('midWidth'),  highWInput  = $('highWidth');
const sigmaInput      = $('sigmaThreshold'), lookbackInput = $('lookbackHours');
const corrLBInput     = $('corrLookbackHours'), corrImpInput = $('correlationImpact');
const recTrigInput    = $('recenterTriggerPct');
const pauseHighInput  = $('pauseHighVol'), recenterOnInput = $('recenterEnabled');
const ilStopInput     = $('ilStopLossPct');
const runBtn          = $('runSimulation');
const statusBanner    = $('statusBanner'), ilBanner = $('ilBanner');
const metricsGrid     = $('metricsGrid');
const swapContainer   = $('swapTableContainer');
const downloadBtn     = $('downloadCsv'), swapCount = $('swapCount');
const pairHeading     = $('pairHeading');
const chartCanvas     = $('equityChart'), corrCanvas = $('corrChart');

// Formatters
const inr  = new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0});
const inr2 = new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:2,maximumFractionDigits:2});
const pct  = (v,d=2) => `${v>=0?'+':''}${(+v).toFixed(d)}%`;
const qty  = v => new Intl.NumberFormat('en-IN',{maximumFractionDigits:0}).format(Math.round(+v));

// Events
asset1File.addEventListener('change',()=>{asset1FileName.textContent=asset1File.files[0]?.name||'Upload Asset 1 CSV';});
asset2File.addEventListener('change',()=>{asset2FileName.textContent=asset2File.files[0]?.name||'Upload Asset 2 CSV';});
asset1Label.addEventListener('input',updateHeading);
asset2Label.addEventListener('input',updateHeading);
downloadBtn.addEventListener('click',()=>downloadCsv(state.swaps));
runBtn.addEventListener('click',handleRun);
updateHeading();

function updateHeading(){pairHeading.textContent=`${asset1Label.value||'Asset 1'} ↔ ${asset2Label.value||'Asset 2'}`;}

function setStatus(type,msg){
  statusBanner.className=`status-banner ${type}`;
  statusBanner.innerHTML=`<strong>${type.toUpperCase()}:</strong> <span>${msg}</span>`;
}

function getConfig(){
  return {
    buyBrokeragePct:   +buyBrokInput.value,
    sellBrokeragePct:  +sellBrokInput.value,
    lowWidth:          +lowWInput.value,
    midWidth:          +midWInput.value,
    highWidth:         +highWInput.value,
    sigmaThreshold:    +sigmaInput.value,
    lookbackHours:     +lookbackInput.value,
    corrLookbackHours: +corrLBInput.value,
    correlationImpact: +corrImpInput.value,
    recenterTriggerPct:+recTrigInput.value,
    pauseHighVol:      pauseHighInput.checked,
    recenterEnabled:   recenterOnInput.checked,
    ilStopLossPct:     +ilStopInput.value,
  };
}

async function handleRun(){
  if (!asset1File.files[0]||!asset2File.files[0]){setStatus('error','Upload both CSV files first.');return;}
  runBtn.disabled=true; runBtn.textContent='Running…';
  ilBanner.classList.add('hidden');
  setStatus('info','Merging 1-min data → hourly → running x·y=k AMM simulation…');
  try {
    await new Promise(r=>setTimeout(r,10));
    const [t1,t2] = await Promise.all([asset1File.files[0].text(),asset2File.files[0].text()]);
    const result = runAlmSimulation(parseCsv(t1),parseCsv(t2),+realCapInput.value,getConfig());
    if (result.error){
      state.swaps=[];state.results=null;state.equity=[];
      renderMetrics();renderTable();
      setStatus('error',result.error);
    } else {
      state.swaps=result.swaps; state.results=result.results; state.equity=result.equityCurve;
      renderMetrics(); renderTable(); renderCharts(); renderIlBanner();
      const r=result.results;
      const vs=r.totalValue-r.holdValue;
      if (vs>=0){
        setStatus('success',`AMM outperformed hold by ${inr.format(vs)} | Cash profit: ${inr.format(r.cashProfit)} | Brokerage: ${inr.format(r.totalBrokerage)} | IL: ${r.ilPct.toFixed(2)}%`);
      } else {
        setStatus('warning',`Underperformed hold by ${inr.format(-vs)} — IL (${r.ilPct.toFixed(2)}%) exceeded swaps profit (${inr.format(r.cashProfit)}). Try wider ranges.`);
      }
    }
  } catch(err){setStatus('error',err.message||'Parse error.');}
  finally{runBtn.disabled=false;runBtn.textContent='▶ Run Simulation';}
}

function renderIlBanner(){
  const r=state.results;
  if (!r||!r.ilHalted){ilBanner.classList.add('hidden');return;}
  ilBanner.className='il-banner halted';
  ilBanner.innerHTML=`<span class="il-icon">⛔</span><div><strong>IL Stop-Loss Triggered</strong><span>All swapping halted at ${new Date(r.ilHaltedAt).toLocaleString('en-IN')} — IL exceeded −${(+ilStopInput.value).toFixed(1)}%.</span></div>`;
  ilBanner.classList.remove('hidden');
}

function renderMetrics(){
  if (!state.results){
    metricsGrid.innerHTML='<div class="empty-state"><h3>No results yet</h3><p>Upload two 1-minute CSV files and run.</p></div>';
    downloadBtn.classList.add('hidden'); return;
  }
  const r=state.results;
  const a1=asset1Label.value||'Asset 1', a2=asset2Label.value||'Asset 2';
  const cards=[
    {label:'Cash Deployed',              value:inr.format(r.initCashDeployed),     delta:null},
    {label:'Total AMM Value',            value:inr.format(r.totalValue),           delta:pct(r.roiPct),  positive:r.roiPct>=0},
    {label:'Buy-and-Hold Value',         value:inr.format(r.holdValue),            delta:pct(r.holdRoi), positive:r.holdRoi>=0},
    {label:'AMM vs Hold',                value:inr.format(r.totalValue-r.holdValue),delta:pct(r.roiPct-r.holdRoi),positive:r.totalValue>=r.holdValue},
    {label:'Cash Profit (all swaps)',    value:inr.format(r.cashProfit),           delta:pct(r.cashRoi), positive:r.cashProfit>=0},
    {label:'Total Brokerage Paid',       value:inr.format(r.totalBrokerage),       delta:pct(-r.brokRoi),positive:false},
    {label:'Pool Asset Value',           value:inr.format(r.poolAssets),           delta:null},
    {label:'Impermanent Loss (IL)',      value:inr.format(r.ilINR),               delta:pct(r.ilPct),   positive:r.ilPct>=0},
    {label:'Regular Swaps',             value:r.totalSwaps.toLocaleString('en-IN'),delta:null},
    {label:'Recenter Trades',            value:r.recenterSwaps.toLocaleString('en-IN'),delta:null},
    {label:'Recenter Events',            value:r.recenterCount.toLocaleString('en-IN'),delta:null},
    {label:'IL Stop-Loss Hit',           value:r.ilHalted?'⛔ Yes':'✅ No',         delta:null},
    {label:`Initial ${a1} (shares)`,    value:qty(r.initialX),                    delta:null},
    {label:`Initial ${a2} (shares)`,    value:qty(r.initialY),                    delta:null},
    {label:`Final ${a1} (shares)`,      value:qty(r.finalX),                      delta:null},
    {label:`Final ${a2} (shares)`,      value:qty(r.finalY),                      delta:null},
    {label:'Mode Hours L/M/H',           value:`${r.lowModeHours}/${r.midModeHours}/${r.highModeHours}`,delta:null},
    {label:'Buy / Sell Brokerage',       value:`${r.buyBrokeragePct.toFixed(2)}% / ${r.sellBrokeragePct.toFixed(2)}%`,delta:null},
  ];
  metricsGrid.innerHTML=cards.map(({label,value,delta,positive})=>`
    <div class="metric-card">
      <span class="mc-label">${label}</span>
      <strong class="mc-value">${value}</strong>
      ${delta!=null?`<em class="mc-delta ${positive?'positive':'negative'}">${delta}</em>`:''}
    </div>`).join('');
  downloadBtn.classList.remove('hidden');
}

function renderCharts(){
  if (!state.equity.length) return;
  const step=Math.max(1,Math.floor(state.equity.length/500));
  const s=state.equity.filter((_,i)=>i%step===0);
  drawChart(chartCanvas,s,[
    {key:'poolValue', label:'AMM Total Value', color:'#38bdf8'},
    {key:'holdValue', label:'Buy-and-Hold',    color:'#818cf8'},
    {key:'cashProfit',label:'Cash Profit',     color:'#22c55e'},
  ],'₹ Value');
  drawChart(corrCanvas,s,[
    {key:'correlation',     label:'Correlation',    color:'#f97316'},
    {key:'dynamicWidthPct', label:'Width% (÷100)',  color:'#a78bfa',scale:0.01},
    {key:'ilPct',           label:'IL% (÷100)',     color:'#f43f5e',scale:0.01},
  ],'−1 → +1');
}

function drawChart(canvas,data,series,yLabel){
  const dpr=window.devicePixelRatio||1, rect=canvas.getBoundingClientRect();
  canvas.width=rect.width*dpr; canvas.height=rect.height*dpr;
  const ctx=canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const W=rect.width,H=rect.height,P={t:28,r:16,b:46,l:90};
  const cW=W-P.l-P.r,cH=H-P.t-P.b;
  ctx.clearRect(0,0,W,H);
  let yMin=Infinity,yMax=-Infinity;
  for (const s of series){const sc=s.scale??1;for (const d of data){const v=d[s.key]*sc;if(v<yMin)yMin=v;if(v>yMax)yMax=v;}}
  if(!isFinite(yMin))yMin=0;if(!isFinite(yMax))yMax=1;if(yMin===yMax){yMin-=1;yMax+=1;}
  const yRng=yMax-yMin;
  const toX=i=>P.l+(i/(data.length-1))*cW;
  const toY=v=>P.t+cH-((v-yMin)/yRng)*cH;
  for(let g=0;g<=5;g++){
    const yv=yMin+(g/5)*yRng,yp=toY(yv);
    ctx.strokeStyle='rgba(148,163,184,0.09)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(P.l,yp);ctx.lineTo(P.l+cW,yp);ctx.stroke();
    ctx.fillStyle='rgba(148,163,184,0.6)';ctx.font='10px Arial';ctx.textAlign='right';
    const lbl=Math.abs(yRng)>50000?`₹${(yv/1e5).toFixed(1)}L`:Math.abs(yRng)>1000?`₹${(yv/1000).toFixed(1)}K`:yv.toFixed(3);
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

function renderTable(){
  if(!state.swaps.length){
    swapCount.classList.add('hidden');
    swapContainer.innerHTML='<div class="empty-state compact"><h3>No swaps executed</h3><p>Try wider ranges or larger capital.</p></div>';
    return;
  }
  const a1=asset1Label.value||'Asset 1', a2=asset2Label.value||'Asset 2';
  swapCount.textContent=`${state.swaps.length} records`;swapCount.classList.remove('hidden');
  const rows=state.swaps.slice(-500);
  const note=state.swaps.length>500?`<p class="table-note">Showing last 500 of ${state.swaps.length}. Download CSV for full history.</p>`:'';
  swapContainer.innerHTML=note+`
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date/Time</th><th>Type</th><th>Mode</th><th>Corr</th><th>Width%</th>
        <th>Action</th>
        <th>Bought</th><th class="col-num">Shares↑</th><th class="col-num">Cost ₹</th><th class="col-num">Brok↑</th>
        <th>Sold</th><th class="col-num">Shares↓</th><th class="col-num">Revenue ₹</th><th class="col-num">Brok↓</th>
        <th class="col-num">Gross ₹</th><th class="col-num">Net ₹</th><th class="col-num">Cash Accum.</th>
        <th class="col-num">${a1} Shares</th><th class="col-num">${a2} Shares</th><th class="col-num">IL%</th>
      </tr></thead>
      <tbody>${rows.map(s=>`
        <tr class="${s.isRecenter?'recenter-trade-row':''}">
          <td>${new Date(s.date).toLocaleString('en-IN')}</td>
          <td>${s.isRecenter?'<span class="type-pill recenter">RECENTER</span>':'<span class="type-pill swap">SWAP</span>'}</td>
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
          <td class="col-num ${s.grossProfit>=0?'positive':'negative'}">${inr2.format(s.grossProfit)}</td>
          <td class="col-num ${s.netProfit>=0?'positive':'negative'}">${inr2.format(s.netProfit)}</td>
          <td class="col-num">${inr.format(s.cashProfit)}</td>
          <td class="col-num">${qty(s.poolX)}</td>
          <td class="col-num">${qty(s.poolY)}</td>
          <td class="col-num ${s.ilPct>=0?'positive':'negative'}">${s.ilPct.toFixed(2)}%</td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

function downloadCsv(rows){
  const h=['Date','Type','Mode','Correlation','DynWidth%','Action',
    'BoughtAsset','SharesBought','BuyCost_INR','BrokerBuy_INR',
    'SoldAsset','SharesSold','SellRev_INR','BrokerSell_INR',
    'GrossProfit_INR','TotalBrok_INR','NetProfit_INR','CashAccum_INR',
    'Asset1Price','Asset2Price','Asset1Shares','Asset2Shares',
    'PoolAssetVal_INR','IL_INR','IL_Pct','TotalValue_INR'];
  const lines=[h.join(',')].concat(rows.map(r=>[
    r.date,r.isRecenter?'RECENTER':'SWAP',r.mode,
    r.rollingCorrelation.toFixed(6),r.dynamicWidthPct.toFixed(4),
    `"${r.action}"`,
    r.boughtAsset,Math.round(r.boughtQty),r.boughtCost.toFixed(2),r.brokerageOnBuy.toFixed(2),
    r.soldAsset,Math.round(r.soldQty),r.soldRevenue.toFixed(2),r.brokerageOnSell.toFixed(2),
    r.grossProfit.toFixed(2),r.totalBrokerage.toFixed(2),r.netProfit.toFixed(2),r.cashProfit.toFixed(2),
    r.asset1Price,r.asset2Price,Math.round(r.poolX),Math.round(r.poolY),
    r.poolAssetValue.toFixed(2),(r.poolAssetValue-(state.results?.holdValue||0)).toFixed(2),
    r.ilPct.toFixed(4),r.totalValue.toFixed(2),
  ].join(',')));
  const blob=new Blob([lines.join('\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  Object.assign(document.createElement('a'),{href:url,download:'amm_swaps.csv'}).click();
  URL.revokeObjectURL(url);
}
