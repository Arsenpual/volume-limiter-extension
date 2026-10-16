// Service Worker v1.3: จัดการ capture หลายแท็บ พร้อมระบบกู้คืนอัตโนมัติ
// หลักการ: "wanted" = แท็บที่ผู้ใช้ต้องการให้คุม, "captures" = แท็บที่กำลังคุมจริง
// ถ้าสองอย่างนี้ไม่ตรงกัน (สตรีมจบเอง, offscreen หาย) จะพยายามต่อใหม่เอง
const OFFSCREEN_URL = 'offscreen/offscreen.html';
const DEFAULTS = { threshold: -12, preset: 'custom', masterDb: 0 };
const RESTRICTED_URL = /^(chrome|edge|about|chrome-extension|devtools):|^https:\/\/chromewebstore\.google\.com/i;
const RETRY_DELAYS = [400, 1500, 4000, 10000];
const MAX_RECONCILE_FAILS = 3;

const PRESETS = {
  // custom = ไม่บีบเสียงเลย (ratio 1) ให้ limiter แบบ brick-wall ทำหน้าที่คุมเพดานอย่างเดียว
  custom: { ratio: 1, attack: 0.003, release: 0.25, knee: 0, makeupDb: 0 },
  night: { threshold: -26, ratio: 20, attack: 0.002, release: 0.4, knee: 0, makeupDb: 0 },
  speech: { threshold: -18, ratio: 4, attack: 0.01, release: 0.15, knee: 8, makeupDb: 3 }
};

// ---------- serialize ----------
// งาน start/stop ต้องทำทีละงาน ไม่งั้นสร้าง Offscreen Document ซ้อนกันได้
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// สถานะในหน่วยความจำ (หายได้เมื่อ service worker ถูกปิด ส่วนที่สำคัญมีใน storage แล้ว)
const retrying = new Map(); // tabId -> ครั้งที่กำลังลอง
const lastError = new Map(); // tabId -> error ล่าสุด
const reconcileFails = new Map(); // tabId -> จำนวนรอบ reconcile ที่ล้มเหลวติดกัน
const pinState = new Map(); // tabId -> 'ok' | 'fail' สถานะการฝังสคริปต์ล็อกเสียงของเว็บ

// ---------- settings / session state ----------
async function getSettings() {
  const s = await chrome.storage.local.get(['threshold', 'preset', 'masterDb']);
  return {
    threshold: typeof s.threshold === 'number' ? s.threshold : DEFAULTS.threshold,
    preset: PRESETS[s.preset] ? s.preset : DEFAULTS.preset,
    masterDb: typeof s.masterDb === 'number' ? s.masterDb : DEFAULTS.masterDb
  };
}

function buildParams(settings) {
  const p = PRESETS[settings.preset] || PRESETS.custom;
  return {
    threshold: settings.threshold,
    ratio: p.ratio,
    attack: p.attack,
    release: p.release,
    knee: p.knee,
    makeupDb: p.makeupDb,
    masterDb: settings.masterDb
  };
}

// captures: { [tabId]: { label, startedAt } }  กำลังคุมอยู่จริง
// wanted:   { [tabId]: true }                  ผู้ใช้ต้องการให้คุม (ใช้กู้คืนเมื่อหลุด)
// blocked:  { [tabId]: { label, windowId, reason } }  จับให้ไม่ได้
async function getSession() {
  const s = await chrome.storage.session.get(['captures', 'wanted', 'blocked']);
  return { captures: s.captures || {}, wanted: s.wanted || {}, blocked: s.blocked || {} };
}

async function saveSession(patch) {
  await chrome.storage.session.set(patch);
}

async function logEvent(tabId, msg) {
  const { events = [] } = await chrome.storage.session.get('events');
  events.push({ t: Date.now(), tabId, msg });
  while (events.length > 30) events.shift();
  await chrome.storage.session.set({ events });
}

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Process tab audio with the Web Audio API'
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {
      // document ถูกปิดไปแล้ว
    }
  }
}

async function closeOffscreenIfIdle() {
  const { captures } = await getSession();
  if (Object.keys(captures).length === 0) await closeOffscreen();
}

// ---------- badge ----------
async function setBadge(tabId, kind) {
  if (typeof tabId !== 'number') return;
  try {
    if (kind === 'on') {
      await chrome.action.setBadgeText({ tabId, text: 'ON' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1F9D74' });
      await chrome.action.setTitle({ tabId, title: 'Audio Volume Limiter: limiting this tab' });
    } else if (kind === 'error') {
      await chrome.action.setBadgeText({ tabId, text: '!' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#C0392B' });
      await chrome.action.setTitle({ tabId, title: 'Audio Volume Limiter: could not capture this tab; enable it again from the extension icon' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'Audio Volume Limiter' });
    }
  } catch (e) {
    // แท็บอาจถูกปิดไปแล้ว
  }
}

// ---------- error messages ----------
function rawMessage(err) {
  return String((err && err.message) || err || '');
}

function friendlyError(err) {
  const msg = rawMessage(err);
  if (/Extension has not been invoked|activeTab/i.test(msg)) {
    return 'This tab has not granted access yet. Click the extension icon in that tab and turn the limiter on.';
  }
  if (/active stream/i.test(msg)) {
    return 'This tab is already being captured, possibly by another extension. Stop the other capture and try again.';
  }
  if (/cannot be captured/i.test(msg)) {
    return 'Chrome internal pages cannot be captured.';
  }
  if (/NotAllowedError|Permission denied|Permission dismissed/i.test(msg)) {
    return 'Access to the audio stream was denied.';
  }
  if (/NotReadableError|AbortError|Could not start/i.test(msg)) {
    return 'Could not start audio capture. Refresh the tab and try again.';
  }
  return 'An error occurred: ' + msg;
}

function labelFor(tab) {
  if (!tab) return 'Closed tab';
  return tab.title || 'Tab ' + (typeof tab.index === 'number' ? tab.index + 1 : '?');
}

// ---------- ล็อกระดับเสียงของเว็บ ----------
// ฝังสคริปต์เล็ก ๆ (inject/pin-volume.js) เพื่อให้ตัวเลื่อนเสียง/ปุ่มปิดเสียงของเว็บไม่มีผลกับเสียงจริง
// สคริปต์นี้ตั้งค่า volume/muted ของ <video>/<audio> เท่านั้น ไม่อ่านเนื้อหาหน้าเว็บและไม่ใช้เครือข่าย
async function injectPin(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['inject/pin-volume.js']
    });
    if (pinState.get(tabId) !== 'ok') {
      const recovered = pinState.get(tabId) === 'fail';
      pinState.set(tabId, 'ok');
      await logEvent(tabId, recovered ? 'Website volume lock restored' : 'Website volume locked');
    }
    return true;
  } catch (err) {
    if (pinState.get(tabId) !== 'fail') {
      pinState.set(tabId, 'fail');
      await logEvent(tabId, 'Could not lock website volume (website controls may still affect audio): ' + rawMessage(err).slice(0, 100));
    }
    return false;
  }
}

async function releasePin(tabId) {
  pinState.delete(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        try {
          if (window.__avlPin) window.__avlPin.disable();
        } catch (e) {
          // ไม่เป็นไร
        }
      }
    });
  } catch (err) {
    // แท็บปิดไปแล้ว หรือไม่มีสิทธิ์ ไม่ต้องทำอะไร
  }
}

// ฉีดซ้ำเป็นระยะ (ปลอดภัย เพราะสคริปต์ทำงานซ้ำได้) เผื่อมี iframe ใหม่หรือหน้าถูกโหลดใหม่
async function reinforcePins() {
  const { captures } = await getSession();
  for (const id of Object.keys(captures)) await injectPin(Number(id));
}

async function reconcile() {
  await reconcileCapture();
  await reinforcePins();
}

// ---------- offscreen messaging ----------
async function sendToOffscreen(message, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 80));
    }
  }
}

// ---------- core actions (เรียกผ่าน serial เท่านั้น) ----------
async function startTabCapture(tabId) {
  const before = await getSession();
  if (before.captures[tabId]) return;

  const tab = await chrome.tabs.get(tabId);
  // ถ้าไม่มีสิทธิ์อ่าน URL (tab.url ว่าง) ให้ลองจับเลย แล้วให้ Chrome ตัดสิน
  if (tab.url && RESTRICTED_URL.test(tab.url)) {
    throw new Error('Chrome pages cannot be captured');
  }

  // ล็อกเสียงของเว็บก่อนเริ่มจับ เพื่อให้เสียงแรกที่ได้ยินอยู่ใต้การคุมของส่วนขยายทันที
  // (ถ้าล็อกไม่สำเร็จ ไม่ทำให้การจับล้ม แต่จะแจ้งใน popup และบันทึกเหตุการณ์)
  await injectPin(tabId);
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    const params = buildParams(await getSettings());
    const res = await sendToOffscreen({ type: 'START', tabId, streamId, params });
    if (!res || !res.ok) {
      await closeOffscreenIfIdle();
      throw new Error((res && res.error) || 'Could not start audio capture');
    }
  } catch (err) {
    await releasePin(tabId); // จับไม่สำเร็จ คืนการควบคุมเสียงให้เว็บตามเดิม
    throw err;
  }

  const s = await getSession();
  s.captures[tabId] = { label: labelFor(tab), startedAt: Date.now() };
  s.wanted[tabId] = true;
  delete s.blocked[tabId];
  await saveSession({ captures: s.captures, wanted: s.wanted, blocked: s.blocked });
  reconcileFails.delete(tabId);
  retrying.delete(tabId);
  await setBadge(tabId, 'on');
}

// keepWanted = true ใช้ตอนสตรีมหลุดเอง (ยังต้องการให้คุมต่อ) ส่วนผู้ใช้สั่งปิดจะลบ wanted ด้วย
async function stopTabCapture(tabId, { keepWanted = false } = {}) {
  const s = await getSession();
  const was = !!s.captures[tabId];
  if (was) delete s.captures[tabId];
  if (!keepWanted) delete s.wanted[tabId];
  await saveSession({ captures: s.captures, wanted: s.wanted });
  if (was) {
    if (await hasOffscreen()) {
      try {
        await sendToOffscreen({ type: 'STOP_TAB', tabId }, 1);
      } catch (e) {
        // offscreen อาจไม่ตอบ ปิดทิ้งต่อไป
      }
    }
    await setBadge(tabId, 'off');
    if (!keepWanted) await releasePin(tabId);
  }
  if (!keepWanted) {
    retrying.delete(tabId);
    reconcileFails.delete(tabId);
  }
  if (Object.keys(s.captures).length === 0) await closeOffscreen();
}

async function stopAllCapture() {
  const s = await getSession();
  await saveSession({ captures: {}, wanted: {} });
  retrying.clear();
  reconcileFails.clear();
  if (await hasOffscreen()) {
    try {
      await sendToOffscreen({ type: 'STOP_ALL' }, 1);
    } catch (e) {
      // ปิดทิ้งต่อไป
    }
  }
  await closeOffscreen();
  for (const id of Object.keys(s.captures)) {
    await setBadge(Number(id), 'off');
    await releasePin(Number(id));
  }
}

async function markBlocked(tabId, err) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return null; // แท็บปิดไปแล้ว
  }
  const s = await getSession();
  const existed = !!s.blocked[tabId];
  const entry = { label: labelFor(tab), windowId: tab.windowId, reason: friendlyError(err) };
  s.blocked[tabId] = entry;
  await saveSession({ blocked: s.blocked });
  await setBadge(tabId, 'error');
  if (!existed) await logEvent(tabId, 'Capture failed: ' + rawMessage(err).slice(0, 120));
  return { tabId, ...entry };
}

async function giveUp(tabId) {
  const s = await getSession();
  delete s.wanted[tabId];
  await saveSession({ wanted: s.wanted });
  retrying.delete(tabId);
  reconcileFails.delete(tabId);
  await markBlocked(tabId, lastError.get(tabId) || new Error('Could not reconnect'));
  await closeOffscreenIfIdle();
}

// ---------- recovery ----------
function scheduleRetry(tabId, attempt = 0) {
  if (attempt >= RETRY_DELAYS.length) {
    serial(() => giveUp(tabId)).catch(() => {});
    return;
  }
  retrying.set(tabId, attempt);
  setTimeout(() => {
    serial(async () => {
      const s = await getSession();
      if (!s.wanted[tabId] || s.captures[tabId]) {
        retrying.delete(tabId);
        return;
      }
      try {
        await chrome.tabs.get(tabId);
      } catch (e) {
        await stopTabCapture(tabId); // แท็บปิดไปแล้ว
        return;
      }
      try {
        await startTabCapture(tabId);
        await logEvent(tabId, 'Reconnected successfully');
      } catch (err) {
        lastError.set(tabId, err);
        await closeOffscreenIfIdle();
        scheduleRetry(tabId, attempt + 1);
      }
    }).catch(() => {});
  }, RETRY_DELAYS[attempt]);
}

// offscreen แจ้งว่าสตรีมของแท็บจบเอง (นำทาง, ถูกแย่งสตรีม, ฯลฯ ไม่ใช่ผู้ใช้สั่งปิด)
async function handleEnded(tabId) {
  const s = await getSession();
  const wasWanted = !!s.wanted[tabId];
  await stopTabCapture(tabId, { keepWanted: true });
  if (!wasWanted) return;
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    await stopTabCapture(tabId); // แท็บปิดไปแล้ว
    return;
  }
  await logEvent(tabId, 'Audio stream ended unexpectedly; reconnecting');
  if (!retrying.has(tabId)) scheduleRetry(tabId, 0);
}

// ตรวจสอบสถานะจริงเทียบกับที่ต้องการ แล้วซ่อมส่วนที่หลุด (รันทุก 30 วินาทีจาก alarm)
async function reconcileCapture() {
  const s = await getSession();
  if (Object.keys(s.captures).length === 0 && Object.keys(s.wanted).length === 0) return;

  // 1) ตรวจว่าแท็บที่เชื่อว่ากำลังคุม ยังคุมอยู่จริงที่ offscreen
  const capIds = Object.keys(s.captures);
  if (capIds.length > 0) {
    let live = null;
    if (await hasOffscreen()) {
      try {
        const st = await sendToOffscreen({ type: 'STATUS' }, 2);
        if (st && Array.isArray(st.live)) live = new Set(st.live.map(String));
      } catch (e) {
        live = null;
      }
    }
    let changed = false;
    for (const id of capIds) {
      if (!live || !live.has(String(id))) {
        delete s.captures[id];
        await setBadge(Number(id), 'off');
        changed = true;
      }
    }
    if (changed) {
      await saveSession({ captures: s.captures });
      await logEvent(0, 'A limited tab was interrupted; attempting recovery');
      if (Object.keys(s.captures).length === 0) await closeOffscreen();
    }
  }

  // 2) แท็บที่ผู้ใช้ต้องการให้คุมแต่ตอนนี้ไม่ได้คุม ให้ต่อใหม่
  for (const id of Object.keys(s.wanted)) {
    const tabId = Number(id);
    if (s.captures[tabId] || retrying.has(tabId)) continue;
    try {
      await chrome.tabs.get(tabId);
    } catch (e) {
      await stopTabCapture(tabId);
      continue;
    }
    try {
      await startTabCapture(tabId);
      await logEvent(tabId, 'Audio limiting restored');
    } catch (err) {
      lastError.set(tabId, err);
      const n = (reconcileFails.get(tabId) || 0) + 1;
      reconcileFails.set(tabId, n);
      await closeOffscreenIfIdle();
      if (n >= MAX_RECONCILE_FAILS) await giveUp(tabId);
    }
  }
}

// ---------- user actions ----------
async function toggleForTab(tabId) {
  const { captures } = await getSession();
  if (captures[tabId]) {
    await stopTabCapture(tabId);
    return { ok: true, enabled: false };
  }
  try {
    await startTabCapture(tabId);
    return { ok: true, enabled: true };
  } catch (err) {
    await closeOffscreenIfIdle();
    await setBadge(tabId, 'error');
    return { ok: false, error: friendlyError(err) };
  }
}

async function getState() {
  let s = await getSession();
  // ตรวจเร็ว ๆ: ถ้า offscreen หาย ให้ล้างสถานะ capture แล้วสั่งซ่อมรอบถัดไป
  if (Object.keys(s.captures).length > 0 && !(await hasOffscreen())) {
    for (const id of Object.keys(s.captures)) await setBadge(Number(id), 'off');
    await saveSession({ captures: {} });
    s.captures = {};
    serial(reconcile).catch(() => {});
  }
  for (const id of Object.keys(s.captures)) {
    try {
      const tab = await chrome.tabs.get(Number(id));
      if (tab.title && tab.title !== s.captures[id].label) s.captures[id].label = tab.title;
    } catch (e) {
      // แท็บปิดไปแล้ว เดี๋ยว onRemoved จัดการ
    }
  }
  s = await getSession();
  const settings = await getSettings();
  const { events = [] } = await chrome.storage.session.get('events');
  const captures = Object.entries(s.captures).map(([id, c]) => ({ tabId: Number(id), label: c.label }));
  const blocked = Object.entries(s.blocked).map(([id, b]) => ({ tabId: Number(id), ...b }));
  const pending = Object.keys(s.wanted).filter((id) => !s.captures[id]).length;
  return {
    enabled: captures.length > 0,
    pinFailed: [...pinState].filter(([, v]) => v === 'fail').map(([k]) => k),
    captures,
    blocked,
    pending,
    events: events.slice(-8),
    ...settings
  };
}

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;

  serial(async () => {
    switch (msg.type) {
      case 'GET_STATE':
        return getState();
      case 'TOGGLE':
        return toggleForTab(msg.tabId);
      case 'SETTINGS_CHANGED': {
        // popup แก้ค่า (slider/preset) แล้ว ส่งค่าใหม่ไปที่ offscreen ทันที
        const { captures } = await getSession();
        if (Object.keys(captures).length > 0) {
          await sendToOffscreen({ type: 'UPDATE', params: buildParams(await getSettings()) }, 1);
        }
        return { ok: true };
      }
      case 'CAPTURE_ENDED':
        await handleEnded(msg.tabId);
        return { ok: true };
      default:
        return { ok: false };
    }
  })
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false }));

  return true; // ตอบกลับแบบ async
});

// ---------- hotkey ----------
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-limiter') return;
  serial(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && typeof tab.id === 'number') await toggleForTab(tab.id);
  }).catch(() => {});
});

// ---------- lifecycle ----------
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    await stopTabCapture(tabId);
    const s = await getSession();
    if (s.blocked[tabId]) {
      delete s.blocked[tabId];
      await saveSession({ blocked: s.blocked });
    }
  }).catch(() => {});
});

// หมายเหตุ: ไม่หยุดคุมเมื่อแท็บ "loading" อีกต่อไป เพราะหน้า SPA (YouTube, Spotify)
// ยิงสถานะนี้ทุกครั้งที่เปลี่ยนคลิปหรือเพลง ถ้าสตรีมจบจริง offscreen จะแจ้ง CAPTURE_ENDED แล้วต่อใหม่เอง
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const audible = changeInfo.audible === true;
  const complete = changeInfo.status === 'complete';
  if (!audible && !complete) return;

  serial(async () => {
    const { captures } = await getSession();
    // โหลดหน้าใหม่จะล้างสคริปต์ล็อกเสียง และ iframe ใหม่ (เช่น โฆษณา) ยังไม่มีสคริปต์ จึงฉีดซ้ำ (ฉีดซ้ำได้ปลอดภัย)
    if (captures[tabId]) await injectPin(tabId);
  }).catch(() => {});
});

// Alarm เป็นตาข่ายนิรภัย: ปลุก service worker ทุก 30 วินาทีเพื่อตรวจและซ่อม
function ensureAlarm() {
  chrome.alarms.get('reconcile', (a) => {
    if (!a) chrome.alarms.create('reconcile', { periodInMinutes: 0.5 });
  });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconcile') serial(reconcile).catch(() => {});
});
ensureAlarm();

async function freshStart() {
  await saveSession({ captures: {}, wanted: {}, blocked: {} });
  retrying.clear();
  reconcileFails.clear();
  pinState.clear();
  await closeOffscreen();
  ensureAlarm();
}

chrome.runtime.onStartup.addListener(() => serial(freshStart).catch(() => {}));
chrome.runtime.onInstalled.addListener(() => serial(freshStart).catch(() => {}));
