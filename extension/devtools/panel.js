/**
 * Impeccable DevTools Extension - Panel
 *
 * Displays findings, provides controls for scanning and overlay toggling,
 * and allows clicking findings to inspect elements.
 */

// Match the DevTools theme (light or dark)
if (chrome.devtools.panels.themeName === 'dark') {
  document.documentElement.classList.add('theme-dark');
}

const tabId = chrome.devtools.inspectedWindow.tabId;

// Auto-reconnecting port. Service workers in MV3 can be terminated after ~30s of
// inactivity (especially when the browser window is unfocused). When they restart,
// the existing port becomes invalid. We recreate it lazily on the next use.
let port = null;
function getPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: `impeccable-panel-${tabId}` });
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => { port = null; });
  return port;
}
function postToPort(msg) {
  try {
    getPort().postMessage(msg);
  } catch {
    // Port died mid-call. Drop it and try once more with a fresh port.
    port = null;
    try { getPort().postMessage(msg); } catch { /* give up silently */ }
  }
}

const badge = document.getElementById('badge');
const container = document.getElementById('findings-container');
const emptyState = document.getElementById('empty-state');
const btnRescan = document.getElementById('btn-rescan');
const btnToggle = document.getElementById('btn-toggle');
const btnCopyAll = document.getElementById('btn-copy-all');
const settingsContainer = document.getElementById('settings-container');
const settingsList = document.getElementById('settings-list');
const btnSettings = document.getElementById('btn-settings');

let overlaysVisible = true;
let allAntipatterns = [];
let disabledRules = [];
let currentFindings = [];
// Scan lifecycle, as the service worker reports it. scannedAt stays null until
// a scan has finished, so "not scanned" and "scanned, clean" never look alike.
let scannedAt = null;
let scanning = false;

const scanErrorBox = document.getElementById('scan-error');
const scanErrorText = document.getElementById('scan-error-text');
const emptyTitle = document.getElementById('empty-title');
const emptyHint = document.getElementById('empty-hint');
const btnScanNow = document.getElementById('btn-scan-now');
const btnRetry = document.getElementById('btn-retry');

function showScanError(message) {
  scanErrorText.textContent = message || '';
  scanErrorBox.hidden = !message;
}

// Load antipatterns list and disabled rules
async function initSettings() {
  try {
    const resp = await fetch(chrome.runtime.getURL('detector/antipatterns.json'));
    allAntipatterns = await resp.json();
  } catch { allAntipatterns = []; }

  const stored = await chrome.storage.sync.get({
    disabledRules: [],
    lineLengthMode: 'strict',
    spotlightBlur: true,
    autoScan: 'panel',
  });
  disabledRules = stored.disabledRules;
  renderSettings();
  initLineLengthControl(stored.lineLengthMode);
  initSpotlightBlurToggle(stored.spotlightBlur);
  initAutoScanControl(stored.autoScan);
}

// A segmented control is a row of toggle buttons: the lit cap is also exposed
// to assistive tech as the pressed one.
function setSegmentActive(btn, active) {
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', String(active));
}

function initAutoScanControl(currentMode) {
  const group = document.getElementById('auto-scan-mode');
  if (!group) return;
  for (const btn of group.querySelectorAll('button')) {
    setSegmentActive(btn, btn.dataset.value === currentMode);
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.value;
      for (const b of group.querySelectorAll('button')) setSegmentActive(b, b === btn);
      await chrome.storage.sync.set({ autoScan: mode });
    });
  }
}

function initLineLengthControl(currentMode) {
  const group = document.getElementById('line-length-mode');
  if (!group) return;
  for (const btn of group.querySelectorAll('button')) {
    setSegmentActive(btn, btn.dataset.value === currentMode);
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.value;
      for (const b of group.querySelectorAll('button')) setSegmentActive(b, b === btn);
      await chrome.storage.sync.set({ lineLengthMode: mode });
      chrome.runtime.sendMessage({ action: 'disabled-rules-changed' });
    });
  }
}

function initSpotlightBlurToggle(currentValue) {
  const cb = document.getElementById('spotlight-blur-toggle');
  if (!cb) return;
  cb.checked = currentValue;
  cb.addEventListener('change', async () => {
    await chrome.storage.sync.set({ spotlightBlur: cb.checked });
    chrome.runtime.sendMessage({ action: 'disabled-rules-changed' });
  });
}

const ruleSearch = document.getElementById('rule-search');
const rulesSummary = document.getElementById('rules-summary');
const rulesReset = document.getElementById('rules-reset');
let ruleQuery = '';

function renderRulesSummary() {
  const total = allAntipatterns.length;
  if (!total) {
    rulesSummary.textContent = '';
    rulesReset.hidden = true;
    return;
  }
  const muted = disabledRules.length;
  rulesSummary.textContent = muted
    ? `${total - muted} of ${total} rules on, ${muted} muted`
    : `All ${total} rules on`;
  rulesReset.hidden = muted === 0;
}

function renderSettings() {
  settingsList.innerHTML = '';
  renderRulesSummary();

  const categories = {
    slop: { label: 'AI tells', items: [] },
    quality: { label: 'Quality', items: [] },
  };
  const query = ruleQuery.trim().toLowerCase();
  let shown = 0;
  for (const ap of allAntipatterns) {
    if (query && !`${ap.name} ${ap.id} ${ap.description || ''}`.toLowerCase().includes(query)) continue;
    const cat = ap.category || 'quality';
    (categories[cat] || categories.quality).items.push(ap);
    shown++;
  }

  if (query && !shown) {
    const none = document.createElement('p');
    none.className = 'rules-none';
    none.textContent = `No rule matches \u201c${ruleQuery.trim()}\u201d.`;
    settingsList.appendChild(none);
    return;
  }

  for (const [, group] of Object.entries(categories)) {
    if (!group.items.length) continue;

    const header = document.createElement('div');
    header.className = 'settings-header';
    header.textContent = `${group.label} (${group.items.length})`;
    settingsList.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'settings-grid';

    for (const ap of group.items) {
      const label = document.createElement('label');
      label.className = 'setting-rule';
      if (ap.description) label.title = ap.description;

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !disabledRules.includes(ap.id);
      checkbox.addEventListener('change', () => {
        toggleRule(ap.id, checkbox.checked);
        if (!checkbox.checked) offerUndo(ap);
      });

      const text = document.createElement('span');
      text.textContent = ap.name;

      label.appendChild(checkbox);
      label.appendChild(text);
      grid.appendChild(label);
    }
    settingsList.appendChild(grid);
  }
}

async function toggleRule(ruleId, enabled) {
  if (enabled) {
    disabledRules = disabledRules.filter(id => id !== ruleId);
  } else {
    if (!disabledRules.includes(ruleId)) disabledRules.push(ruleId);
  }
  renderRulesSummary();
  await chrome.storage.sync.set({ disabledRules });
  chrome.runtime.sendMessage({ action: 'disabled-rules-changed' });
}

// Muting a rule is cheap to do and cheap to take back: every mute says so, with
// an Undo that stays up long enough to reach for.
const toast = document.getElementById('toast');
const toastText = document.getElementById('toast-text');
const toastUndo = document.getElementById('toast-undo');
let toastTimer = null;
let toastAction = null;

function showToast(message, onUndo) {
  clearTimeout(toastTimer);
  toastText.textContent = message;
  toastAction = onUndo;
  toast.hidden = false;
  toastTimer = setTimeout(hideToast, 8000);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastAction = null;
  toast.hidden = true;
}

toastUndo.addEventListener('click', () => {
  const action = toastAction;
  hideToast();
  if (action) action();
});

function offerUndo(rule) {
  showToast(`Muted \u201c${rule.name}\u201d.`, () => {
    toggleRule(rule.id, true);
    renderSettings();
  });
}

function muteRule(ruleId, name) {
  toggleRule(ruleId, false);
  renderSettings();
  offerUndo({ id: ruleId, name });
}

ruleSearch.addEventListener('input', () => {
  ruleQuery = ruleSearch.value;
  renderSettings();
});

rulesReset.addEventListener('click', async () => {
  disabledRules = [];
  hideToast();
  renderSettings();
  await chrome.storage.sync.set({ disabledRules });
  chrome.runtime.sendMessage({ action: 'disabled-rules-changed' });
});

// Listen for messages from the service worker (called by getPort() on each new connection)
function handlePortMessage(msg) {
  if (msg.action === 'state') {
    scannedAt = msg.scannedAt || null;
    scanning = Boolean(msg.scanning);
    showScanError(scanning ? null : msg.scanError);
  }
  if (msg.action === 'findings') {
    scannedAt = Date.now();
    scanning = false;
    showScanError(null);
  }
  if (msg.action === 'scanning') {
    scanning = true;
    showScanError(null);
    if (!currentFindings.length) showScanning();
  }
  if (msg.action === 'scan-failed') {
    scanning = false;
    showScanError(msg.message || 'Couldn\u2019t scan this page.');
    if (!currentFindings.length) renderFindings([]);
    return;
  }
  if (msg.action === 'page-pointer-active') {
    // Cursor is active on the page → user has left the panel
    setHoveredItem(null);
    return;
  }
  if (msg.action === 'findings' || msg.action === 'state') {
    renderFindings(msg.findings || []);
    if (msg.overlaysVisible !== undefined) {
      overlaysVisible = msg.overlaysVisible;
      updateToggleButton();
    }
  }
  if (msg.action === 'overlays-toggled') {
    overlaysVisible = msg.visible;
    updateToggleButton();
  }
  if (msg.action === 'navigated') {
    scannedAt = null;
    scanning = Boolean(msg.rescanning);
    showScanError(null);
    currentFindings = [];
    badge.classList.remove('visible');
    renderFindings([]);
  }
}

// Initial connection
getPort();

// Heartbeat to keep the MV3 service worker alive while the panel is open.
// SWs can be terminated after ~30s of inactivity, especially when the browser is unfocused.
setInterval(() => postToPort({ action: 'ping' }), 20000);

// Controls
function requestScan() {
  scanning = true;
  showScanError(null);
  showScanning();
  postToPort({ action: 'scan' });
}
btnRescan.addEventListener('click', requestScan);
btnScanNow.addEventListener('click', requestScan);
btnRetry.addEventListener('click', requestScan);

btnToggle.addEventListener('click', () => {
  postToPort({ action: 'toggle-overlays' });
});

btnSettings.addEventListener('click', () => {
  const isVisible = settingsContainer.style.display !== 'none';
  settingsContainer.style.display = isVisible ? 'none' : '';
  btnSettings.classList.toggle('active', !isVisible);
  btnSettings.setAttribute('aria-expanded', String(!isVisible));
});

function updateToggleButton() {
  btnToggle.title = overlaysVisible ? 'Hide overlays' : 'Show overlays';
  btnToggle.setAttribute('aria-pressed', String(overlaysVisible));
  btnToggle.classList.toggle('inactive', !overlaysVisible);
}

function showScanning() {
  container.innerHTML = `
    <div class="scanning-indicator" role="status">
      <div class="scanning-dot"></div>
      Scanning page...
    </div>`;
}

// Maps each anti-pattern to the Impeccable commands that fix it, run as
// `/impeccable <command>`. Suggestions only; the user decides what to apply.
// Every rule id in the registry has an entry. A rule added without one falls
// back to its category's default, so the brief never names a command that
// does not exist.
const FIX_COMMANDS = {
  // AI slop
  'side-tab':                    ['distill', 'polish'],
  'border-accent-on-rounded':    ['distill', 'polish'],
  'overused-font':               ['typeset'],
  'flat-type-hierarchy':         ['typeset'],
  'gradient-text':               ['typeset', 'distill'],
  'ai-color-palette':            ['colorize', 'distill'],
  'cream-palette':               ['colorize'],
  'nested-cards':                ['distill', 'layout'],
  'monotonous-spacing':          ['layout'],
  'bounce-easing':               ['animate'],
  'pulsing-dot':                 ['quieter', 'distill'],
  'blinking-cursor':             ['quieter'],
  'shape-assembled-illustration':['distill'],
  'dark-glow':                   ['quieter', 'distill'],
  'radial-halo':                 ['quieter'],
  'radial-spotlight-glow':       ['quieter'],
  'marquee':                     ['distill', 'quieter'],
  'icon-tile-stack':             ['distill', 'layout'],
  'italic-serif-display':        ['typeset'],
  'hero-eyebrow-chip':           ['distill'],
  'kicker-above-heading':        ['distill'],
  'numbered-section-labels':     ['distill'],
  'em-dash-overuse':             ['clarify'],
  'marketing-buzzword':          ['clarify'],
  'aphoristic-cadence':          ['clarify'],
  'oversized-h1':                ['typeset'],
  'extreme-negative-tracking':   ['typeset'],
  'gpt-thin-border-wide-shadow': ['quieter', 'polish'],
  'repeating-stripes-gradient':  ['distill'],
  'codex-grid-background':       ['distill'],
  'theater-slop-phrase':         ['clarify'],
  // Quality
  'organic-clip-path':           ['polish'],
  'buried-raster':               ['polish'],
  'broken-image':                ['harden'],
  'script-error':                ['harden'],
  'content-hidden-at-rest':      ['harden'],
  'edge-flush-cards':            ['layout'],
  'text-occlusion':              ['layout', 'adapt'],
  'first-viewport-column-overflow': ['adapt', 'layout'],
  'gray-on-color':               ['colorize'],
  'low-contrast':                ['colorize', 'audit'],
  'line-length':                 ['layout', 'typeset'],
  'cramped-padding':             ['layout', 'polish'],
  'body-text-viewport-edge':     ['layout', 'adapt'],
  'tight-leading':               ['typeset'],
  'skipped-heading':             ['audit', 'harden'],
  'heading-rhythm':              ['typeset', 'layout'],
  'justified-text':              ['typeset'],
  'straggler':                   ['typeset'],
  'unbalanced-heading':          ['typeset'],
  'tiny-text':                   ['typeset'],
  'undersized-ui-text':          ['typeset', 'adapt'],
  'all-caps-body':               ['typeset'],
  'wide-tracking':               ['typeset'],
  'text-overflow':               ['harden', 'adapt'],
  'repeated-container-text':     ['clarify', 'distill'],
  'clipped-overflow-container':  ['harden', 'adapt'],
  'design-system-font':          ['typeset'],
  'design-system-color':         ['colorize'],
  'design-system-radius':        ['polish'],
  'design-system-font-size':     ['typeset'],
};
const FIX_FALLBACK = { slop: ['distill'], quality: ['polish'] };

function fixCommandsFor(finding) {
  return FIX_COMMANDS[finding.type] || FIX_FALLBACK[finding.category] || FIX_FALLBACK.quality;
}

// Commands for one finding, as the user would type them.
function fixCommandLine(finding) {
  return fixCommandsFor(finding).map(c => '/impeccable ' + c).join(', ');
}

// Returns the unique commands referenced by the given findings, most-frequent
// first, each as a full `/impeccable <command>` string.
function uniqueCommandsForFindings(findings) {
  const counts = new Map();
  for (const item of findings) {
    for (const f of item.findings) {
      for (const c of fixCommandsFor(f)) {
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => '/impeccable ' + c);
}

function getInspectedUrl() {
  return new Promise((resolve) => {
    // Strip the URL fragment — anchors are noise for "what page is this from"
    chrome.devtools.inspectedWindow.eval(
      '(function(){var u=new URL(location.href);u.hash="";return u.toString();})()',
      (result) => resolve(typeof result === 'string' ? result : '')
    );
  });
}

async function formatFindingsForCopy(findings) {
  if (!findings.length) return 'Impeccable found no anti-patterns on this page.';
  const url = await getInspectedUrl();
  const lines = ['# Impeccable findings'];
  if (url) lines.push(`URL: ${url}`);
  lines.push('');

  const groups = { slop: [], quality: [] };
  for (const item of findings) {
    for (const f of item.findings) {
      const cat = f.category || 'quality';
      groups[cat].push({ ...f, selector: item.selector, isPageLevel: item.isPageLevel });
    }
  }

  if (groups.slop.length) {
    lines.push(`## AI tells (${groups.slop.length})`);
    for (const f of groups.slop) {
      const where = f.isPageLevel ? '_(page-level)_' : `\`${f.selector}\``;
      lines.push(`- **${f.name}** at ${where}: ${f.detail}`);
    }
    lines.push('');
  }

  if (groups.quality.length) {
    lines.push(`## Quality issues (${groups.quality.length})`);
    for (const f of groups.quality) {
      const where = f.isPageLevel ? '_(page-level)_' : `\`${f.selector}\``;
      lines.push(`- **${f.name}** at ${where}: ${f.detail}`);
    }
    lines.push('');
  }

  // Roll up suggested commands across all findings (most-frequent first)
  const commands = uniqueCommandsForFindings(findings);
  if (commands.length) {
    lines.push(`Suggested Impeccable commands to fix: ${commands.join(', ')}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('Detected by [Impeccable](https://impeccable.style). Commands are suggestions, not required.');
  return lines.join('\n');
}

async function formatSingleFindingForCopy(item, finding) {
  const url = await getInspectedUrl();
  const where = item.isPageLevel ? '_(page-level)_' : `\`${item.selector}\``;
  const lines = [`# Impeccable: ${finding.name}`];
  if (url) lines.push(`URL: ${url}`);
  lines.push(`Element: ${where}`);
  lines.push(`Detail: ${finding.detail}`);
  lines.push('');
  lines.push(finding.description);
  lines.push('');
  lines.push(`Suggested Impeccable command(s) to fix: ${fixCommandLine(finding)}`);
  return lines.join('\n');
}

async function copyToClipboard(text, btn) {
  if (text instanceof Promise) text = await text;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.title;
      btn.title = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.title = orig;
        btn.classList.remove('copied');
      }, 1200);
    }
  } catch (err) {
    console.warn('Copy failed', err);
  }
}

btnCopyAll.addEventListener('click', () => {
  copyToClipboard(formatFindingsForCopy(currentFindings), btnCopyAll);
});

// Delegated hover tracking on the findings container.
// Reliably handles cursor moving between items, into children, or out of the panel.
let currentHoverSelector = null;
function setHoveredItem(selector) {
  if (selector === currentHoverSelector) return;
  currentHoverSelector = selector;
  if (selector) {
    postToPort({ action: 'highlight', selector });
  } else {
    postToPort({ action: 'unhighlight' });
  }
}

container.addEventListener('pointermove', (e) => {
  const item = e.target.closest('.finding-item');
  const selector = item && !item.classList.contains('is-hidden') ? item.dataset.selector || null : null;
  setHoveredItem(selector);
});

// Slow-cursor fallbacks (these fire reliably for slow movements)
container.addEventListener('pointerleave', () => setHoveredItem(null));

// Keyboard focus highlights the page element the way the pointer does, so a
// keyboard user sees what they are about to inspect.
container.addEventListener('focusin', (e) => {
  const item = e.target.closest('.finding-item');
  setHoveredItem(item && item.dataset.selector ? item.dataset.selector : null);
});
container.addEventListener('focusout', (e) => {
  if (!e.relatedTarget || !container.contains(e.relatedTarget)) setHoveredItem(null);
});
window.addEventListener('blur', () => setHoveredItem(null));


// Two empty states that must read differently: a tab nobody has scanned, and a
// scan that finished with nothing to report.
function renderEmptyState() {
  if (!scannedAt) {
    emptyTitle.textContent = 'Not scanned yet';
    emptyHint.textContent = 'Scan this page to check it against the rules.';
    // The failure banner carries its own retry; one scan action is enough.
    btnScanNow.hidden = !scanErrorBox.hidden;
    return;
  }
  const active = allAntipatterns.length ? allAntipatterns.length - disabledRules.length : 0;
  const time = new Date(scannedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  emptyTitle.textContent = 'Clean.';
  emptyHint.textContent = active > 0
    ? `Nothing found by ${active} rules at ${time}.`
    : `Nothing found at ${time}.`;
  btnScanNow.hidden = true;
}

let findingSeq = 0;

function renderFindings(findings) {
  currentFindings = findings;
  if (!findings.length) {
    badge.classList.remove('visible');
    badge.textContent = '0';
    if (scanning) {
      showScanning();
      return;
    }
    container.innerHTML = '';
    container.appendChild(emptyState);
    emptyState.style.display = '';
    renderEmptyState();
    return;
  }

  emptyState.style.display = 'none';

  // Count total element-level findings
  const totalCount = findings.reduce((sum, f) => sum + f.findings.length, 0);
  badge.textContent = String(totalCount);
  badge.classList.add('visible');

  // Group findings by category, then by anti-pattern type
  const categories = { slop: new Map(), quality: new Map() };
  for (const item of findings) {
    for (const f of item.findings) {
      const cat = f.category || 'quality';
      const groups = categories[cat] || categories.quality;
      if (!groups.has(f.type)) {
        groups.set(f.type, { name: f.name, description: f.description, items: [] });
      }
      groups.get(f.type).items.push({
        selector: item.selector,
        tagName: item.tagName,
        isPageLevel: item.isPageLevel,
        isHidden: item.isHidden,
        detail: f.detail,
      });
    }
  }

  container.innerHTML = '';

  const CATEGORY_LABELS = { slop: 'AI tells', quality: 'Quality issues' };
  for (const [catKey, groups] of Object.entries(categories)) {
    if (groups.size === 0) continue;

    const catCount = [...groups.values()].reduce((sum, g) => sum + g.items.length, 0);
    const section = document.createElement('div');
    section.className = 'category-section category-' + catKey;

    const catHeader = document.createElement('div');
    catHeader.className = 'category-header';
    catHeader.innerHTML = `
      <span class="category-dot category-dot-${catKey}"></span>
      <span class="category-name">${CATEGORY_LABELS[catKey]}</span>
      <span class="category-count">${catCount}</span>`;
    section.appendChild(catHeader);

    // Busiest rule first: the worst offender is the first thing in the section.
    const ordered = [...groups].sort((x, y) => y[1].items.length - x[1].items.length);
    for (const [type, group] of ordered) {
      const groupEl = document.createElement('div');
      groupEl.className = 'finding-group';

      const header = document.createElement('div');
      header.className = 'group-header';
      header.innerHTML = `
        <button type="button" class="group-toggle" aria-expanded="true">
          <span class="group-chevron" aria-hidden="true">&#9660;</span>
          <span class="group-name">${escapeHtml(group.name)}</span>
          <span class="group-count" aria-label="${group.items.length} ${group.items.length === 1 ? 'finding' : 'findings'}">${group.items.length}</span>
        </button>
        <button type="button" class="group-mute" title="Stop checking for this rule" aria-label="Mute rule: ${escapeHtml(group.name)}">Mute</button>`;
      const toggle = header.querySelector('.group-toggle');
      toggle.addEventListener('click', () => {
        const collapsed = header.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
      });
      header.querySelector('.group-mute').addEventListener('click', () => muteRule(type, group.name));
      groupEl.appendChild(header);

      const itemsEl = document.createElement('div');
      itemsEl.className = 'group-items';

      for (const item of group.items) {
        const inspectable = !item.isPageLevel && !item.isHidden;
        const descId = `finding-desc-${++findingSeq}`;
        const itemEl = document.createElement('div');
        itemEl.className = 'finding-item' + (item.isHidden ? ' is-hidden' : '');
        itemEl.setAttribute('role', 'group');
        itemEl.setAttribute('aria-label', `${group.name}${item.isPageLevel ? ', page-level' : ', ' + item.selector}`);
        const tag = item.isPageLevel
          ? '<span class="finding-tag tag-page">page</span>'
          : item.isHidden ? '<span class="finding-tag tag-hidden" title="Element is currently hidden on the page">hidden</span>' : '';
        const selector = inspectable
          ? `<button type="button" class="finding-selector finding-inspect" title="${escapeHtml(item.selector)}" aria-describedby="${descId}">${escapeHtml(item.selector)}</button>`
          : `<span class="finding-selector" title="${escapeHtml(item.selector)}">${escapeHtml(item.selector)}</span>`;
        itemEl.innerHTML = `
          ${tag}
          <div class="finding-row">
            ${selector}
            <button type="button" class="finding-copy" title="Copy this finding" aria-label="Copy finding: ${escapeHtml(group.name)}${item.isPageLevel ? ' (page-level)' : ' at ' + escapeHtml(item.selector)}" aria-describedby="${descId}">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11 1H3a2 2 0 0 0-2 2v10h2V3h8V1zm3 3H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 11H7V6h7v9z" fill="currentColor"/></svg>
            </button>
          </div>
          <span class="finding-detail">${escapeHtml(item.detail)}</span>
          <span class="finding-description" id="${descId}">${escapeHtml(group.description)}</span>`;

        const copyBtn = itemEl.querySelector('.finding-copy');
        const finding = { type, name: group.name, description: group.description, detail: item.detail };
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          copyToClipboard(formatSingleFindingForCopy(item, finding), copyBtn);
        });

        if (inspectable) {
          itemEl.dataset.selector = item.selector;
          itemEl.addEventListener('click', () => inspectElement(item.selector));
        }

        itemsEl.appendChild(itemEl);
      }

      groupEl.appendChild(itemsEl);
      section.appendChild(groupEl);
    }

    container.appendChild(section);
  }
}

function inspectElement(selector) {
  const json = JSON.stringify(selector);
  chrome.devtools.inspectedWindow.eval(
    `(function() {
      var el = document.querySelector(${json});
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); inspect(el); }
    })()`
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

initSettings();
