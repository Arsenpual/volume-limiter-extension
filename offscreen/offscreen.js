// Offscreen Document: ประมวลผลเสียงด้วย Web Audio API รองรับหลายแท็บพร้อมกัน
// ต่อแท็บ:  source -> compressor -> makeup gain -> [bus]
// ส่วนรวม:  [bus] -> brick-wall limiter -> master volume -> destination
// limiter อยู่หลังการรวมทุกแท็บ จึงจำกัดเสียงรวมไม่ให้เกินเพดานแม้เปิดหลายแท็บพร้อมกัน
let audioCtx = null;
let shared = null;
let sharedPromise = null;
let limiterGr = 0; // dB (ติดลบ = limiter กำลังลดเสียง)
let meterTimer = null;
const entries = new Map(); // tabId -> { stream, source, compressor, makeup }
const meterPorts = new Set();

const MIN_DB = -100;
const toDb = (v) => (v > 0 ? Math.max(MIN_DB, 20 * Math.log10(v)) : MIN_DB);
const dbToLin = (db) => Math.pow(10, db / 20);

// ---------- limiter ----------
function clipCurve(ceiling) {
  const N = 4096;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = -1 + (2 * i) / (N - 1);
    curve[i] = Math.max(-ceiling, Math.min(ceiling, x));
  }
  return curve;
}

async function buildLimiter(ctx) {
  try {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('offscreen/limiter-processor.js'));
    const node = new AudioWorkletNode(ctx, 'brickwall-limiter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCounts: [2],
      channelCount: 2,
      channelCountMode: 'explicit'
    });
    node.port.onmessage = (e) => {
      if (e.data && typeof e.data.gr === 'number') limiterGr = e.data.gr;
    };
    const param = node.parameters.get('ceiling');
    return {
      node,
      setCeiling(db, immediate) {
        const lin = dbToLin(db);
        if (immediate) param.setValueAtTime(lin, ctx.currentTime);
        else param.setTargetAtTime(lin, ctx.currentTime, 0.01);
      }
    };
  } catch (e) {
    // สำรอง: ถ้าโหลด AudioWorklet ไม่ได้ ใช้ hard clip (ยังไม่เกินเพดานแต่เสียงอาจแตกกว่า)
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '4x';
    return {
      node: shaper,
      setCeiling(db) {
        shaper.curve = clipCurve(dbToLin(db));
      }
    };
  }
}

async function ensureShared() {
  if (!sharedPromise) {
    sharedPromise = (async () => {
      // 'balanced' ลดโอกาสเสียงสะดุดเมื่อเครื่องโหลดหนัก โดย latency ยังไม่มากพอให้ภาพกับเสียงเหลื่อมกัน
      const ctx = new AudioContext({ latencyHint: 'balanced' });
      audioCtx = ctx;
      // ถ้า Chrome พัก AudioContext (suspended/interrupted) ขณะยังมีแท็บที่คุมอยู่ ให้สั่งเล่นต่อทันที
      ctx.addEventListener('statechange', () => {
        if (ctx === audioCtx && ctx.state !== 'running' && ctx.state !== 'closed' && entries.size > 0) {
          ctx.resume().catch(() => {});
        }
      });
      try {
        const bus = ctx.createGain();
        const limiter = await buildLimiter(ctx);
        const master = ctx.createGain();
        const splitter = ctx.createChannelSplitter(2);
        const anL = ctx.createAnalyser();
        const anR = ctx.createAnalyser();
        anL.fftSize = 2048;
        anR.fftSize = 2048;

        bus.connect(limiter.node);
        limiter.node.connect(master);
        master.connect(ctx.destination); // ส่งเสียงกลับออกลำโพง (ไม่ให้แท็บเงียบ)
        limiter.node.connect(splitter); // จุดวัดระดับ: วัดหลัง limiter
        splitter.connect(anL, 0);
        splitter.connect(anR, 1);

        shared = {
          ctx, bus, limiter, master, anL, anR,
          bufL: new Float32Array(anL.fftSize),
          bufR: new Float32Array(anR.fftSize)
        };
        return shared;
      } catch (e) {
        try { await ctx.close(); } catch (err) { /* ignore */ }
        audioCtx = null;
        throw e;
      }
    })();
  }
  try {
    await sharedPromise;
  } catch (e) {
    sharedPromise = null;
    throw e;
  }
  if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
  return shared;
}

function applyShared(params, immediate) {
  if (!shared) return;
  shared.limiter.setCeiling(params.threshold, immediate);
  const master = params.masterDb <= -40 ? 0 : dbToLin(params.masterDb || 0);
  shared.master.gain.setTargetAtTime(master, shared.ctx.currentTime, 0.02);
}

function applyEntry(entry, params, immediate) {
  const t = shared.ctx.currentTime;
  const tc = immediate ? 0.001 : 0.02; // time constant สั้น ๆ ให้ slider ลื่น ไม่มี zipper noise
  const c = entry.compressor;
  c.threshold.setTargetAtTime(params.threshold, t, tc);
  c.ratio.setTargetAtTime(params.ratio, t, tc);
  c.attack.setTargetAtTime(params.attack, t, tc);
  c.release.setTargetAtTime(params.release, t, tc);
  c.knee.setTargetAtTime(params.knee, t, tc);
  entry.makeup.gain.setTargetAtTime(dbToLin(params.makeupDb || 0), t, 0.02);
}

// ---------- tabs ----------
async function startTab(tabId, streamId, params) {
  await stopTab(tabId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  let sh;
  try {
    sh = await ensureShared();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    await closeContextIfIdle();
    throw e;
  }

  const source = sh.ctx.createMediaStreamSource(stream);
  const compressor = sh.ctx.createDynamicsCompressor();
  const makeup = sh.ctx.createGain();
  const entry = { stream, source, compressor, makeup };

  // ตั้งค่าทั้งหมดก่อนปล่อยเสียงเข้า bus เพื่อไม่ให้มีช่วงที่ยังไม่ถูกจำกัด
  applyShared(params, true);
  applyEntry(entry, params, true);
  source.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(sh.bus);
  entries.set(tabId, entry);

  // ถ้าแท็บถูกปิดหรือสตรีมสิ้นสุด ให้แจ้ง background เก็บกวาด
  stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (entries.get(tabId) === entry) {
        chrome.runtime.sendMessage({ target: 'background', type: 'CAPTURE_ENDED', tabId }).catch(() => {});
      }
    });
  });
}

function disposeEntry(entry) {
  ['source', 'compressor', 'makeup'].forEach((k) => {
    try { entry[k].disconnect(); } catch (e) { /* ignore */ }
  });
  entry.stream.getTracks().forEach((t) => t.stop());
}

async function closeContextIfIdle() {
  if (entries.size > 0) return;
  stopMeterLoop();
  const ctx = audioCtx;
  audioCtx = null;
  shared = null;
  sharedPromise = null;
  limiterGr = 0;
  if (ctx) {
    try { await ctx.close(); } catch (e) { /* ignore */ }
  }
}

async function stopTab(tabId) {
  const entry = entries.get(tabId);
  if (!entry) return;
  entries.delete(tabId);
  disposeEntry(entry);
  await closeContextIfIdle();
}

async function stopAll() {
  for (const entry of entries.values()) disposeEntry(entry);
  entries.clear();
  await closeContextIfIdle();
}

// ---------- level meter (วัดหลัง limiter = ระดับที่ออกลำโพงจริงก่อนปรับระดับรวม) ----------
function peakRms(buf) {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
    sum += buf[i] * buf[i];
  }
  return { peak, rms: Math.sqrt(sum / buf.length) };
}

function readLevel() {
  if (!shared || entries.size === 0) return null;
  shared.anL.getFloatTimeDomainData(shared.bufL);
  shared.anR.getFloatTimeDomainData(shared.bufR);
  const l = peakRms(shared.bufL);
  const r = peakRms(shared.bufR);
  let comp = 0;
  entries.forEach((e) => {
    if (e.compressor.reduction < comp) comp = e.compressor.reduction;
  });
  return {
    type: 'LEVEL',
    peak: toDb(Math.max(l.peak, r.peak)),
    rms: toDb(Math.max(l.rms, r.rms)),
    reduction: comp + limiterGr, // dB รวมของ compressor + limiter (ค่าติดลบ = กำลังลดเสียง)
    tabs: entries.size
  };
}

function startMeterLoop() {
  if (meterTimer || entries.size === 0) return;
  meterTimer = setInterval(() => {
    const level = readLevel();
    if (!level) return;
    meterPorts.forEach((port) => {
      try { port.postMessage(level); } catch (e) { meterPorts.delete(port); }
    });
  }, 50);
}

function stopMeterLoop() {
  if (meterTimer) {
    clearInterval(meterTimer);
    meterTimer = null;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'meter') return;
  meterPorts.add(port);
  startMeterLoop();
  port.onDisconnect.addListener(() => {
    meterPorts.delete(port);
    if (meterPorts.size === 0) stopMeterLoop();
  });
});

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  (async () => {
    try {
      if (msg.type === 'START') {
        await startTab(msg.tabId, msg.streamId, msg.params);
        if (meterPorts.size > 0) startMeterLoop();
        sendResponse({ ok: true });
      } else if (msg.type === 'UPDATE') {
        if (shared) {
          applyShared(msg.params, false);
          entries.forEach((entry) => applyEntry(entry, msg.params, false));
        }
        sendResponse({ ok: true });
      } else if (msg.type === 'STATUS') {
        // รายงานแท็บที่สตรีมยัง live จริง ๆ ให้ background ใช้ตรวจว่ามีอะไรหลุดหรือไม่
        if (audioCtx && audioCtx.state === 'suspended' && entries.size > 0) {
          audioCtx.resume().catch(() => {});
        }
        const live = [];
        entries.forEach((entry, id) => {
          if (entry.stream.getAudioTracks().some((t) => t.readyState === 'live')) live.push(id);
        });
        sendResponse({ ok: true, live, state: audioCtx ? audioCtx.state : 'none' });
      } else if (msg.type === 'STOP_TAB') {
        await stopTab(msg.tabId);
        sendResponse({ ok: true });
      } else if (msg.type === 'STOP_ALL') {
        await stopAll();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false });
      }
    } catch (err) {
      if (msg.type === 'START') await stopTab(msg.tabId);
      sendResponse({ ok: false, error: (err && (err.name + ': ' + err.message)) || 'unknown' });
    }
  })();

  return true;
});
