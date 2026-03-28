import { parseCsv, runAlmSimulation } from './simulation-core.js';

const state = {
  swaps: [],
  results: null,
};

const asset1File = document.getElementById('asset1File');
const asset2File = document.getElementById('asset2File');
const asset1FileName = document.getElementById('asset1FileName');
const asset2FileName = document.getElementById('asset2FileName');
const asset1Label = document.getElementById('asset1Label');
const asset2Label = document.getElementById('asset2Label');

const realCapitalInput = document.getElementById('realCapital');
const virtualCapitalInput = document.getElementById('virtualCapital');
const feePctInput = document.getElementById('feePct');
const lowWidthInput = document.getElementById('lowWidth');
const midWidthInput = document.getElementById('midWidth');
const highWidthInput = document.getElementById('highWidth');
const sigmaThresholdInput = document.getElementById('sigmaThreshold');
const lookbackHoursInput = document.getElementById('lookbackHours');
const corrLookbackHoursInput = document.getElementById('corrLookbackHours');
const correlationImpactInput = document.getElementById('correlationImpact');
const recenterTriggerPctInput = document.getElementById('recenterTriggerPct');
const pauseHighVolInput = document.getElementById('pauseHighVol');

const runSimulationButton = document.getElementById('runSimulation');
const statusBanner = document.getElementById('statusBanner');
const metricsGrid = document.getElementById('metricsGrid');
const swapTableContainer = document.getElementById('swapTableContainer');
const downloadCsvButton = document.getElementById('downloadCsv');
const swapCount = document.getElementById('swapCount');
const pairHeading = document.getElementById('pairHeading');

const currencyFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const numberFormatter = (digits = 2) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

asset1File.addEventListener('change', () => { asset1FileName.textContent = asset1File.files[0]?.name || 'Upload Asset 1 CSV (e.g., Reliance)'; });
asset2File.addEventListener('change', () => { asset2FileName.textContent = asset2File.files[0]?.name || 'Upload Asset 2 CSV (e.g., Kotak)'; });
asset1Label.addEventListener('input', updatePairHeading);
asset2Label.addEventListener('input', updatePairHeading);
downloadCsvButton.addEventListener('click', () => downloadCsv(state.swaps));
runSimulationButton.addEventListener('click', handleRunSimulation);

updatePairHeading();

function updatePairHeading() {
  pairHeading.textContent = `${asset1Label.value || 'Asset 1'} vs ${asset2Label.value || 'Asset 2'}`;
}

function setStatus(type, message) {
  statusBanner.className = `status-banner ${type}`;
  statusBanner.innerHTML = `<strong>${type.toUpperCase()}:</strong> <span>${message}</span>`;
}

function getConfig() {
  return {
    virtualCapital: Number(virtualCapitalInput.value),
    feePct: Number(feePctInput.value),
    lowWidth: Number(lowWidthInput.value),
    midWidth: Number(midWidthInput.value),
    highWidth: Number(highWidthInput.value),
    sigmaThreshold: Number(sigmaThresholdInput.value),
    lookbackHours: Number(lookbackHoursInput.value),
    corrLookbackHours: Number(corrLookbackHoursInput.value),
    correlationImpact: Number(correlationImpactInput.value),
    recenterTriggerPct: Number(recenterTriggerPctInput.value),
    pauseHighVol: pauseHighVolInput.checked,
  };
}

async function handleRunSimulation() {
  if (!asset1File.files[0] || !asset2File.files[0]) {
    setStatus('error', 'Please upload both CSV files before running the simulation.');
    return;
  }

  runSimulationButton.disabled = true;
  runSimulationButton.textContent = 'Running Simulation...';
  setStatus('info', 'Processing hourly ALM with dynamic correlation, concentration, and recentering...');

  try {
    const [text1, text2] = await Promise.all([asset1File.files[0].text(), asset2File.files[0].text()]);
    const result = runAlmSimulation(
      parseCsv(text1),
      parseCsv(text2),
      Number(realCapitalInput.value),
      getConfig(),
    );

    if (result.error) {
      state.swaps = [];
      state.results = null;
      renderMetrics();
      renderTable();
      setStatus('error', result.error);
    } else {
      state.swaps = result.swaps;
      state.results = result.results;
      renderMetrics();
      renderTable();
      if (result.results.totalFinalValue > result.results.holdValue) {
        setStatus('success', 'Profitable against holding: dynamic ALM outperformed passive holding.');
      } else {
        setStatus('warning', 'Underperformed holding. Try wider widths, lower recenter sensitivity, or lower fee.');
      }
    }
  } catch (error) {
    setStatus('error', error.message || 'Unable to parse one of the uploaded CSV files.');
  } finally {
    runSimulationButton.disabled = false;
    runSimulationButton.textContent = 'Run Simulation';
  }
}

function renderMetrics() {
  if (!state.results) {
    metricsGrid.innerHTML = `
      <div class="empty-state">
        <h3>No simulation results yet</h3>
        <p>Upload two CSV files and run the model to see ROI, risk modes, recentering, and swap history.</p>
      </div>`;
    downloadCsvButton.classList.add('hidden');
    return;
  }

  const cards = [
    ['Initial Real Capital', currencyFormatter.format(state.results.initialCapital)],
    ['Total Swaps Executed', numberFormatter(0).format(state.results.totalSwaps)],
    ['Recenter Count', numberFormatter(0).format(state.results.recenterCount)],
    ['Fee Applied', `${numberFormatter(2).format(state.results.feePct)}%`],
    ['Accumulated Swap Cash', currencyFormatter.format(state.results.poolCash)],
    ['Total Final Value', currencyFormatter.format(state.results.totalFinalValue), `${numberFormatter(2).format(state.results.totalRoiPct)}% ROI`, state.results.totalRoiPct >= 0],
    ['Hold Value (Do Nothing)', currencyFormatter.format(state.results.holdValue)],
    ['Pool Asset Value (w/o cash)', currencyFormatter.format(state.results.poolAssetValue)],
    ['Impermanent Loss (IL)', currencyFormatter.format(state.results.impermanentLossInr), `${numberFormatter(2).format(state.results.impermanentLossPct)}% IL`, state.results.impermanentLossPct >= 0],
    ['Mode Hours (L / M / H)', `${numberFormatter(0).format(state.results.lowModeHours)} / ${numberFormatter(0).format(state.results.midModeHours)} / ${numberFormatter(0).format(state.results.highModeHours)}`],
    ['Initial Whole Units', `${numberFormatter(0).format(state.results.initialAsset1Units)} / ${numberFormatter(0).format(state.results.initialAsset2Units)}`],
    ['Final Whole Units', `${numberFormatter(0).format(state.results.finalAsset1Units)} / ${numberFormatter(0).format(state.results.finalAsset2Units)}`],
  ];

  metricsGrid.innerHTML = cards.map(([label, value, delta, positive]) => `
    <div class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
      ${delta ? `<em class="${positive ? 'positive' : 'negative'}">${delta}</em>` : ''}
    </div>`).join('');

  downloadCsvButton.classList.remove('hidden');
}

function renderTable() {
  if (!state.swaps.length) {
    swapCount.classList.add('hidden');
    swapTableContainer.innerHTML = `
      <div class="empty-state compact">
        <h3>No profitable swaps found</h3>
        <p>Adjust risk settings and run again.</p>
      </div>`;
    return;
  }

  const label1 = asset1Label.value || 'Asset 1';
  const label2 = asset2Label.value || 'Asset 2';
  swapCount.textContent = `${state.swaps.length} swaps`;
  swapCount.classList.remove('hidden');
  swapTableContainer.innerHTML = `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Risk Mode</th>
            <th>Correlation</th>
            <th>Dynamic Width</th>
            <th>Recentered</th>
            <th>Action</th>
            <th>${label1} Price</th>
            <th>${label2} Price</th>
            <th>${label1} Swapped</th>
            <th>${label2} Swapped</th>
            <th>Fee Paid</th>
            <th>Net Profit</th>
            <th>Accumulated Cash</th>
            <th>${label1} Balance</th>
            <th>${label2} Balance</th>
          </tr>
        </thead>
        <tbody>
          ${state.swaps.map((swap) => `
            <tr>
              <td>${new Date(swap.date).toLocaleString('en-IN')}</td>
              <td>${swap.mode}</td>
              <td>${numberFormatter(3).format(swap.rollingCorrelation)}</td>
              <td>${numberFormatter(2).format(swap.dynamicWidthPct)}%</td>
              <td>${swap.recentered ? 'Yes' : 'No'}</td>
              <td>${swap.action}</td>
              <td>${currencyFormatter.format(swap.asset1Price)}</td>
              <td>${currencyFormatter.format(swap.asset2Price)}</td>
              <td>${numberFormatter(0).format(swap.asset1Swapped)}</td>
              <td>${numberFormatter(0).format(swap.asset2Swapped)}</td>
              <td>${currencyFormatter.format(swap.brokeragePaid)}</td>
              <td>${currencyFormatter.format(swap.netProfitInr)}</td>
              <td>${currencyFormatter.format(swap.accumulatedCash)}</td>
              <td>${numberFormatter(0).format(swap.realAsset1Balance)}</td>
              <td>${numberFormatter(0).format(swap.realAsset2Balance)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function downloadCsv(rows) {
  const headers = ['Date','Mode','Rolling_Correlation','Dynamic_Width_Pct','Recentered','Action','Asset_1_Price','Asset_2_Price','Asset_1_Swapped','Asset_2_Swapped','Fee_Paid','Net_Profit_INR','Accumulated_Cash','Real_Asset_1_Balance','Real_Asset_2_Balance'];
  const csvLines = [headers.join(',')].concat(rows.map((row) => [row.date,row.mode,row.rollingCorrelation,row.dynamicWidthPct,row.recentered,row.action,row.asset1Price,row.asset2Price,row.asset1Swapped,row.asset2Swapped,row.brokeragePaid,row.netProfitInr,row.accumulatedCash,row.realAsset1Balance,row.realAsset2Balance].join(',')));
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'alm_pool_swaps.csv';
  link.click();
  URL.revokeObjectURL(url);
}
