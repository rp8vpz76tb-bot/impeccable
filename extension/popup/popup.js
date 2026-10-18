/**
 * Impeccable DevTools Extension - Popup
 *
 * Quick controls: scan, toggle overlays, and see finding count.
 */

const countNumber = document.getElementById('count-number');
const countLabel = document.getElementById('count-label');
const btnScan = document.getElementById('btn-scan');
const btnToggle = document.getElementById('btn-toggle');
const scanError = document.getElementById('scan-error');

let overlaysVisible = true;
// The popup only ever reflects the active tab. Broadcasts from the service
// worker carry a tabId, so we cache the active one and ignore updates meant
// for other tabs (e.g. a DevTools-driven rescan failing on a background tab).
let activeTabId = null;

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function totalFindings(findings) {
  return findings?.reduce((sum, f) => sum + f.findings.length, 0) || 0;
}

// The numeral has three meanings, and they must not look alike: a dash for a
// tab that was never scanned, 0 for a finished scan that found nothing, and
// the count otherwise.
function renderCount({ findings, scanned, scanning }) {
  const count = totalFindings(findings);
  countNumber.classList.toggle('has-findings', count > 0);
  countNumber.classList.toggle('is-unscanned', !scanned && count === 0);
  countNumber.classList.toggle('is-clean', scanned && count === 0);
  if (count > 0) {
    countNumber.textContent = String(count);
    countLabel.textContent = count === 1 ? 'anti-pattern' : 'anti-patterns';
  } else if (scanned) {
    countNumber.textContent = '0';
    countLabel.textContent = 'Clean. Nothing found.';
  } else {
    countNumber.textContent = '\u2013';
    countLabel.textContent = scanning ? 'Scanning page...' : 'Not scanned yet';
  }
}

function showScanError(message) {
  scanError.textContent = message || '';
  scanError.hidden = !message;
}

function setScanning(scanning) {
  btnScan.textContent = scanning ? 'Scanning page...' : 'Scan page';
  btnScan.disabled = scanning;
}

function updateFromState(state) {
  if (!state) return;
  renderCount({ findings: state.findings, scanned: Boolean(state.scannedAt), scanning: state.scanning });
  setScanning(Boolean(state.scanning));
  showScanError(state.scanning ? null : state.scanError);
  overlaysVisible = state.overlaysVisible !== false;
  btnToggle.textContent = overlaysVisible ? 'Hide overlays' : 'Show overlays';
}

async function loadState() {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  activeTabId = tabId;
  chrome.runtime.sendMessage({ action: 'get-state', tabId }, updateFromState);
}

// Listen for real-time updates from service worker
chrome.runtime.onMessage.addListener((msg) => {
  // Ignore broadcasts for a tab other than the one this popup is showing.
  if (msg.tabId != null && activeTabId != null && msg.tabId !== activeTabId) return;
  if (msg.action === 'findings-updated') {
    renderCount({ findings: msg.findings, scanned: true, scanning: false });
    setScanning(false);
    showScanError(null);
  }
  if (msg.action === 'scan-failed') {
    // A failed scan leaves whatever the numeral said before; only the dash of
    // a never-scanned tab stays a dash.
    if (countNumber.classList.contains('is-unscanned')) countLabel.textContent = 'Not scanned yet';
    setScanning(false);
    showScanError(msg.message || 'Couldn\u2019t scan this page.');
  }
  if (msg.action === 'overlays-toggled-broadcast') {
    overlaysVisible = msg.visible;
    btnToggle.textContent = overlaysVisible ? 'Hide overlays' : 'Show overlays';
  }
});

btnScan.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  activeTabId = tabId;
  showScanError(null);
  setScanning(true);
  if (countNumber.classList.contains('is-unscanned')) countLabel.textContent = 'Scanning page...';
  chrome.runtime.sendMessage({ action: 'scan', tabId });
});

btnToggle.addEventListener('click', async () => {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  chrome.runtime.sendMessage({ action: 'toggle-overlays', tabId });
  overlaysVisible = !overlaysVisible;
  btnToggle.textContent = overlaysVisible ? 'Hide overlays' : 'Show overlays';
});

loadState();
