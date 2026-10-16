// Popup UI: per-tab switch, volume ceiling, master volume, and meter.
const METER_MIN = -60;
const POLL_MS = 2000;

const $ = (id) => document.getElementById(id);
const els = {
  toggle: $('toggle'),
  pinHint: $('pinHint'),
  logList: $('logList'),
  status: $('status'),
  error: $('error'),
  blockedBox: $('blockedBox'),
  blockedList: $('blockedList'),
  threshold: $('threshold'),
  thresholdVal: $('thresholdVal'),
  master: $('master'),
  masterVal: $('masterVal'),
  soundTest: $('soundTest'),
  soundTestLevel: $('soundTestLevel'),
  fill: $('meterFill'),
  peak: $('meterPeak'),
  limit: $('meterLimit'),
  peakVal: $('peakVal'),
  rmsVal: $('rmsVal'),
  grVal: $('grVal')
};

let currentTabId = null;
let state = { enabled: false, pinFailed: [], pending: 0, events: [], captures: [], blocked: [] };
let port = null;
let busy = false;
let peakHold = METER_MIN;
let peakHoldAt = 0;
let testActive = false;

const pct = (db) => Math.min(100, Math.max(0, ((db - METER_MIN) / -METER_MIN) * 100));
const fmt = (db) => (db <= -99 ? '-∞' : db.toFixed(1));
const capturedHere = () => state.captures.some((c) => c.tabId === currentTabId);

function send(message) {
  return chrome.runtime.sendMessage({ target: 'background', ...message });
}

// ---------- rendering ----------
function showError(text) {
  els.error.hidden = !text;
  els.error.textContent = text || '';
}

function renderStatus() {
  const n = state.captures.length;
  const here = capturedHere();
  if (state.pending > 0 && n === 0) {
    els.status.textContent = 'Audio stream interrupted. Reconnecting ' + state.pending + ' tab(s)…';
    return;
  }
  if (n === 0) {
    els.status.textContent = 'Off. Turn on the switch to limit this tab’s audio.';
  } else if (here && n === 1) {
    els.status.textContent = 'Limiting audio in this tab.';
  } else if (here) {
    els.status.textContent = 'Limiting this tab and ' + (n - 1) + ' other tab(s).';
  } else {
    els.status.textContent = 'Limiting ' + n + ' tab(s), not including this tab.';
  }
}

function renderBlocked() {
  els.blockedList.textContent = '';
  const items = state.blocked.filter((b) => b.tabId !== currentTabId || !capturedHere());
  els.blockedBox.hidden = items.length === 0;
  items.slice(0, 6).forEach((b) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = b.label; // Use textContent only; tab titles are untrusted.
    name.title = b.label;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Go to tab';
    btn.addEventListener('click', async () => {
      try {
        await chrome.tabs.update(b.tabId, { active: true });
        if (typeof b.windowId === 'number') await chrome.windows.update(b.windowId, { focused: true });
      } catch (e) {
        showError('This tab has already been closed.');
      }
    });
    li.append(name, btn);
    els.blockedList.append(li);
  });
}

function renderLog() {
  els.logList.textContent = '';
  const items = (state.events || []).slice().reverse();
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No events yet.';
    els.logList.append(li);
    return;
  }
  items.forEach((e) => {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = new Date(e.t).toLocaleTimeString(undefined, { hour12: false });
    li.append(time, document.createTextNode((e.tabId ? '[Tab ' + e.tabId + '] ' : '') + e.msg));
    els.logList.append(li);
  });
}

function renderMaster() {
  const v = Number(els.master.value);
  els.masterVal.textContent = v <= -40 ? 'Muted' : v + ' dB';
}

function currentTestPeakDb() {
  return AVLSoundTest.outputPeakDb(Number(els.threshold.value), Number(els.master.value));
}

function renderSoundTest() {
  const peakDb = currentTestPeakDb();
  const muted = peakDb === -Infinity;
  els.soundTest.disabled = muted;
  els.soundTestLevel.textContent = muted ? 'Master volume is muted' : 'Peak: ' + peakDb + ' dBFS';
  if (!testActive) els.soundTest.textContent = 'Play';
}

function stopSoundTest() {
  if (!testActive) return;
  testActive = false;
  send({ type: 'TEST_STOP' }).catch(() => {});
  els.soundTest.textContent = 'Play';
  if (!state.enabled) disconnectMeter();
  renderSoundTest();
}

async function toggleSoundTest() {
  if (testActive) {
    stopSoundTest();
    return;
  }
  if (currentTestPeakDb() === -Infinity) return;
  try {
    const result = await send({ type: 'TEST_START' });
    if (!result || !result.ok) throw new Error('test start failed');
    testActive = true;
    connectMeter();
    els.soundTest.textContent = 'Stop';
  } catch (e) {
    stopSoundTest();
    showError('Could not start the peak test.');
  }
}

function renderMarker() {
  els.limit.style.left = pct(Number(els.threshold.value)) + '%';
}

function resetMeter() {
  els.fill.style.width = '0';
  els.peak.style.left = '0';
  els.peakVal.textContent = '--';
  els.rmsVal.textContent = '--';
  els.grVal.textContent = '--';
  peakHold = METER_MIN;
}

function render() {
  els.toggle.checked = capturedHere();
  els.pinHint.hidden = !(capturedHere() && (state.pinFailed || []).includes(currentTabId));
  renderStatus();
  renderBlocked();
  renderLog();
  renderMarker();
  renderSoundTest();
  if (!state.enabled && !testActive) resetMeter();
}

// ---------- meter ----------
function connectMeter() {
  if (port || (!state.enabled && !testActive)) return;
  try {
    port = chrome.runtime.connect({ name: 'meter' });
  } catch (e) {
    port = null;
    return;
  }
  port.onMessage.addListener(onLevel);
  port.onDisconnect.addListener(() => {
    port = null;
    void chrome.runtime.lastError; // Read it to avoid an unchecked error.
    poll(); // Refresh state when the offscreen document closes.
  });
}

function disconnectMeter() {
  if (port) {
    port.disconnect();
    port = null;
  }
}

function onLevel(m) {
  if (m.type !== 'LEVEL') return;
  const now = Date.now();
  const threshold = Number(els.threshold.value);

  els.fill.style.width = pct(m.rms) + '%';
  els.fill.style.background =
    m.peak > threshold + 1 ? 'var(--hot)' : m.peak >= threshold - 3 ? 'var(--warn)' : 'var(--ok)';

  if (m.peak >= peakHold || now - peakHoldAt > 1200) {
    peakHold = m.peak;
    peakHoldAt = now;
  }
  els.peak.style.left = 'calc(' + pct(peakHold) + '% - 2px)';

  els.peakVal.textContent = fmt(m.peak);
  els.rmsVal.textContent = fmt(m.rms);
  els.grVal.textContent = m.reduction < -0.5 ? m.reduction.toFixed(1) + ' dB' : '0 dB';

  renderStatus();
}

// ---------- state sync ----------
async function loadState(applySettings) {
  const s = await send({ type: 'GET_STATE' });
  if (!s) return;
  state = s;
  if (applySettings) {
    els.threshold.value = s.threshold;
    els.thresholdVal.textContent = s.threshold + ' dB';
    els.master.value = s.masterDb;
    renderMaster();
  }
  render();
  if (state.enabled) connectMeter();
  else disconnectMeter();
}

async function poll() {
  if (busy) return;
  try {
    await loadState(false);
  } catch (e) {
    // The service worker may be waking up; try again on the next poll.
  }
}

// ---------- actions ----------
async function runBusy(fn) {
  busy = true;
  els.toggle.disabled = true;
  showError('');
  try {
    await fn();
  } catch (e) {
    showError('Could not reach the audio processor. Close and reopen the popup, then try again.');
  }
  await loadState(false);
  busy = false;
  els.toggle.disabled = currentTabId === null;
}

function onToggle() {
  return runBusy(async () => {
    const res = await send({ type: 'TOGGLE', tabId: currentTabId });
    if (!res || !res.ok) showError((res && res.error) || 'The action could not be completed.');
  });
}

async function onThreshold() {
  const value = Number(els.threshold.value);
  els.thresholdVal.textContent = value + ' dB';
  renderMarker();
  renderSoundTest();
  await chrome.storage.local.set({ threshold: value });
  if (state.enabled || testActive) send({ type: 'SETTINGS_CHANGED' }).catch(() => {});
}

async function onMaster() {
  renderMaster();
  renderSoundTest();
  if (currentTestPeakDb() === -Infinity) stopSoundTest();
  await chrome.storage.local.set({ masterDb: Number(els.master.value) });
  if (state.enabled || testActive) send({ type: 'SETTINGS_CHANGED' }).catch(() => {});
}

// ---------- init ----------
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab ? tab.id : null;
  if (currentTabId === null) {
    els.toggle.disabled = true;
    showError('No active tab found.');
  }
  await loadState(true);
  setInterval(poll, POLL_MS);
}

els.toggle.addEventListener('change', onToggle);
els.threshold.addEventListener('input', onThreshold);
els.master.addEventListener('input', onMaster);
els.soundTest.addEventListener('click', toggleSoundTest);
window.addEventListener('pagehide', () => { disconnectMeter(); stopSoundTest(); });

init();
