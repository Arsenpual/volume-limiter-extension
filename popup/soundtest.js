// Test audio: plays at the same maximum sample peak the extension sends to speakers.
// This lets users set the ceiling by listening.
//
// Speaker level = ceiling + master volume (dBFS); the limiter holds the peak at the ceiling.
// Master volume then applies further attenuation.
// Hearing safety: starts at -60 dBFS and rises slowly (at most RAMP_DB_PER_S per second); it falls immediately.
(function (root) {
  const RAMP_DB_PER_S = 12;
  const START_DB = -60;
  const MUTE_DB = -40; // Master volume considered muted (matches offscreen.js).

  function dbToLin(db) {
    return db === -Infinity ? 0 : Math.pow(10, db / 20);
  }

  // Maximum speaker output level (dBFS); muted master volume produces -Infinity.
  function outputPeakDb(thresholdDb, masterDb) {
    if (masterDb <= MUTE_DB) return -Infinity;
    return Math.min(0, thresholdDb + masterDb);
  }

  // Next test tone level: decrease immediately, increase gradually.
  function nextLevelDb(curDb, targetDb, dtSec) {
    if (!(targetDb > -Infinity)) return -Infinity;
    const base = Math.max(curDb, START_DB);
    if (targetDb <= base) return targetDb;
    return Math.min(targetDb, base + RAMP_DB_PER_S * Math.max(0, dtSec));
  }

  // Seeded random generator for repeatable test audio.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // pink noise (Paul Kellet, refined)
  function pinkNoise(length, rand) {
    const out = new Float32Array(length);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = rand() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
    }
    return out;
  }

  // Normalize sample peak to 1.0 and return RMS relative to peak for the audible segment.
  function normalize(data, activeEnd) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak;
    const n = Math.min(activeEnd || data.length, data.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += data[i] * data[i];
    return 20 * Math.log10(Math.sqrt(sum / n) || 1e-9);
  }

  const TYPES = {
    burst: 'Sudden loud sound (short noise burst)',
    noise: 'Continuous noise (similar to ads or music)',
    tone: 'Continuous 1 kHz tone',
    music: 'Short musical loop'
  };

  // Build a test signal with peak = 1.0; gain later sets the output level.
  // Returns { output, start(), stop(), rmsDb }, with RMS relative to peak (negative).
  function buildSignal(ctx, type) {
    const sr = ctx.sampleRate;
    if (type === 'tone') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1000;
      return {
        output: osc,
        start: () => osc.start(),
        stop: () => {
          try { osc.stop(); } catch (e) { /* ignore */ }
        },
        rmsDb: -3.01
      };
    }

    let data;
    let activeEnd;
    if (type === 'music') {
      // A compact, synthesized major-key melody. Normalize it so its sample peak is exactly 1.0.
      const beat = Math.round(sr * 0.28);
      const notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63, 293.66, 349.23];
      data = new Float32Array(beat * notes.length);
      for (let n = 0; n < notes.length; n++) {
        const start = n * beat;
        for (let i = 0; i < beat; i++) {
          const t = i / sr;
          const progress = i / beat;
          const envelope = Math.sin(Math.PI * progress) ** 0.7;
          const fundamental = Math.sin(2 * Math.PI * notes[n] * t);
          const harmonic = 0.28 * Math.sin(2 * Math.PI * notes[n] * 2 * t);
          data[start + i] = (fundamental + harmonic) * envelope;
        }
      }
      activeEnd = data.length;
    } else if (type === 'noise') {
      data = pinkNoise(Math.round(sr * 4), mulberry32(7));
      activeEnd = data.length;
    } else {
      // Burst: 0.5 seconds of loud audio with 8 ms fades to prevent clicks, then 1.0 second of silence.
      const total = Math.round(sr * 1.5);
      const on = Math.round(sr * 0.5);
      const fade = Math.round(sr * 0.008);
      data = new Float32Array(total);
      data.set(pinkNoise(on, mulberry32(11)));
      for (let i = 0; i < fade; i++) {
        const g = i / fade;
        data[i] *= g;
        data[on - 1 - i] *= g;
      }
      activeEnd = on;
    }
    const rmsDb = normalize(data, activeEnd);
    const buffer = ctx.createBuffer(1, data.length, sr);
    buffer.copyToChannel(data, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return {
      output: src,
      start: () => src.start(),
      stop: () => {
        try { src.stop(); } catch (e) { /* ignore */ }
      },
      rmsDb
    };
  }

  root.AVLSoundTest = {
    RAMP_DB_PER_S, START_DB, MUTE_DB, TYPES,
    dbToLin, outputPeakDb, nextLevelDb, buildSignal
  };
})(typeof window !== 'undefined' ? window : globalThis);
