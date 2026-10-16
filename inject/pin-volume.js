// ล็อกระดับเสียงของ <video>/<audio> ในหน้าเว็บ (รันใน MAIN world ของหน้าเว็บ)
//
// เป้าหมาย: ตัวเลื่อนเสียงและปุ่มปิดเสียงของเว็บ "ไม่มีผลกับเสียงจริง" ให้ส่วนขยายเป็นตัวคุมเดียว
// วิธีการ: เสียงจริงของ element ถูกล็อกไว้ที่ volume = 1 และ muted = false เสมอ
// ส่วนหน้าเว็บยังเห็นค่าที่ตัวเองตั้ง (getter คืนค่าเดิมของเว็บ) เพื่อให้ UI ของเว็บไม่เพี้ยน
// เรียกซ้ำได้อย่างปลอดภัย (idempotent) ปิดการล็อกด้วย window.__avlPin.disable()
(() => {
  if (window.__avlPin) {
    window.__avlPin.enable();
    return;
  }

  const proto = HTMLMediaElement.prototype;
  const volDesc = Object.getOwnPropertyDescriptor(proto, 'volume');
  const mutDesc = Object.getOwnPropertyDescriptor(proto, 'muted');
  if (!volDesc || !mutDesc || !volDesc.get || !volDesc.set || !mutDesc.get || !mutDesc.set) return;

  const origVolGet = volDesc.get;
  const origVolSet = volDesc.set;
  const origMutGet = mutDesc.get;
  const origMutSet = mutDesc.set;

  let enabled = true;
  const states = new WeakMap(); // element -> { vol, muted } ค่าที่ "หน้าเว็บคิดว่าตัวเองตั้งไว้"
  const swallow = new WeakMap(); // element -> จำนวน volumechange จริงที่เกิดจากการล็อกของเรา
  const tracked = new Set(); // WeakRef ของ element ที่เคยเจอ ใช้ตอนปล่อยล็อก

  function track(el) {
    let st = states.get(el);
    if (!st) {
      // เจอครั้งแรก: เอาค่าจริงตอนนี้เป็นค่าที่เว็บตั้งไว้
      st = { vol: origVolGet.call(el), muted: origMutGet.call(el) };
      states.set(el, st);
      tracked.add(new WeakRef(el));
    }
    return st;
  }

  function userActivated() {
    try {
      return !navigator.userActivation || navigator.userActivation.hasBeenActive;
    } catch (e) {
      return true;
    }
  }

  // บังคับค่าจริงให้เป็น 1 / ไม่ปิดเสียง และกลืน volumechange ที่เกิดจากการบังคับนี้ ไม่ให้เว็บเห็น
  function enforce(el) {
    if (!enabled) return;
    let n = 0;
    if (origVolGet.call(el) !== 1) {
      origVolSet.call(el, 1);
      n++;
    }
    // ปลดปิดเสียงเฉพาะเมื่อผู้ใช้เคยโต้ตอบกับหน้าแล้ว ไม่งั้น autoplay ที่เว็บตั้ง muted ไว้จะถูก Chrome บล็อก
    if (origMutGet.call(el) && userActivated()) {
      origMutSet.call(el, false);
      n++;
    }
    if (n > 0) swallow.set(el, (swallow.get(el) || 0) + n);
  }

  function fakeEvent(el) {
    try {
      el.dispatchEvent(new Event('volumechange'));
    } catch (e) {
      /* ignore */
    }
  }

  Object.defineProperty(proto, 'volume', {
    configurable: true,
    enumerable: volDesc.enumerable,
    get: function () {
      if (!enabled) return origVolGet.call(this);
      return track(this).vol;
    },
    set: function (v) {
      if (!enabled) return origVolSet.call(this, v);
      const x = Number(v);
      // ค่าไม่ถูกต้อง: ให้ของเดิมโยน error แบบเดียวกับ Chrome (มันโยนก่อนเปลี่ยนค่าใด ๆ)
      if (!(x >= 0 && x <= 1)) return origVolSet.call(this, v);
      const st = track(this);
      const changed = st.vol !== x;
      st.vol = x;
      enforce(this);
      if (changed) fakeEvent(this); // ให้ UI ของเว็บอัปเดตตามที่มันตั้ง
    }
  });

  Object.defineProperty(proto, 'muted', {
    configurable: true,
    enumerable: mutDesc.enumerable,
    get: function () {
      if (!enabled) return origMutGet.call(this);
      return track(this).muted;
    },
    set: function (v) {
      if (!enabled) return origMutSet.call(this, v);
      const st = track(this);
      const m = !!v;
      const changed = st.muted !== m;
      st.muted = m;
      enforce(this);
      if (changed) fakeEvent(this);
    }
  });

  // volumechange จริงที่เกิดจากการล็อกของเรา: กลืน (เฉพาะ trusted ส่วนที่เราสร้างเองไม่โดน)
  function onVolumeChange(e) {
    const el = e.target;
    if (!e.isTrusted || !(el instanceof HTMLMediaElement)) return;
    const n = swallow.get(el);
    if (n > 0) {
      swallow.set(el, n - 1);
      e.stopImmediatePropagation();
      return;
    }
    // เปลี่ยนจากทางอื่น (เช่น ผู้ใช้กดปุ่มควบคุมของเบราว์เซอร์เอง) ก็ดึงกลับมาล็อก
    track(el);
    enforce(el);
  }

  function onMediaEvent(e) {
    const el = e.target;
    if (el instanceof HTMLMediaElement) {
      track(el);
      enforce(el);
    }
  }

  function enforceAll() {
    try {
      document.querySelectorAll('video,audio').forEach((el) => {
        track(el);
        enforce(el);
      });
    } catch (e) {
      /* ignore */
    }
    tracked.forEach((ref) => {
      const el = ref.deref();
      if (!el) tracked.delete(ref);
      else enforce(el);
    });
  }

  const opts = { capture: true };
  window.addEventListener('volumechange', onVolumeChange, opts);
  ['loadstart', 'loadedmetadata', 'play', 'playing'].forEach((t) => window.addEventListener(t, onMediaEvent, opts));
  // ผู้ใช้โต้ตอบครั้งแรก = ปลดปิดเสียงที่ค้างไว้เพื่อกัน autoplay ได้แล้ว
  const onActivation = () => enforceAll();
  ['pointerdown', 'keydown', 'touchstart'].forEach((t) => window.addEventListener(t, onActivation, opts));
  // ตาข่ายนิรภัย: เผื่อ element ที่เราไม่เห็น event
  const timer = setInterval(enforceAll, 2000);

  function disable() {
    if (!enabled) return;
    enabled = false;
    clearInterval(timer);
    window.removeEventListener('volumechange', onVolumeChange, opts);
    ['loadstart', 'loadedmetadata', 'play', 'playing'].forEach((t) => window.removeEventListener(t, onMediaEvent, opts));
    ['pointerdown', 'keydown', 'touchstart'].forEach((t) => window.removeEventListener(t, onActivation, opts));
    // คืน property เดิมของเบราว์เซอร์ แล้วคืนค่าจริงตามที่เว็บตั้งไว้
    Object.defineProperty(proto, 'volume', volDesc);
    Object.defineProperty(proto, 'muted', mutDesc);
    tracked.forEach((ref) => {
      const el = ref.deref();
      const st = el && states.get(el);
      if (!st) return;
      try {
        origVolSet.call(el, st.vol);
        origMutSet.call(el, st.muted);
      } catch (e) {
        /* ignore */
      }
    });
    delete window.__avlPin; // เรียกสคริปต์นี้ใหม่ภายหลังจะติดตั้งใหม่ได้สะอาด ๆ
  }

  function enable() {
    enforceAll();
  }

  window.__avlPin = { enable, disable };
  enforceAll();
})();
