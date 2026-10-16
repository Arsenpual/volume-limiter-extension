// Brick-wall look-ahead limiter (AudioWorklet)
// รับประกันว่าสัญญาณขาออกไม่เกิน "ceiling" (ค่า sample peak แบบ linear)
//
// หลักการ: คำนวณเกนที่ต้องใช้ต่อ sample -> sliding-window minimum (L sample)
// -> moving average (L sample) แล้วหน่วงเสียงไว้ L-1 sample ทำให้เกนลดลงถึงค่าที่ต้องการ
// ก่อนที่ sample ที่ดังจะมาถึงเสมอ จากนั้นเพิ่ม release แบบนุ่มนวล
// และปิดท้ายด้วย hard clip เป็นด่านสุดท้ายเผื่อกรณีที่เพดานถูกลดลงกะทันหัน
class BrickwallLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ceiling', defaultValue: 0.25, minValue: 0.0005, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.L = Math.max(2, Math.round(sr * 0.005)); // look-ahead ~5 ms
    this.cap = this.L + 2;
    this.dqVal = new Float64Array(this.cap);
    this.dqIdx = new Float64Array(this.cap);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
    this.mBuf = new Float64Array(this.L).fill(1);
    this.mSum = this.L;
    this.delay = [];
    this.n = 0;
    this.rs = 1;
    this.relCoef = 1 - Math.exp(-1 / (sr * 0.15)); // release ~150 ms
    this.minGain = 1;
    this.reportCount = 0;
    this.sv = new Float32Array(32); // ค่า sample ที่ผ่านการกรองแล้วของแต่ละช่อง
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!input || input.length === 0) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
      return true;
    }

    const L = this.L;
    const cap = this.cap;
    const ceiling = parameters.ceiling[0];
    const chIn = input.length;
    while (this.delay.length < chIn) this.delay.push(new Float32Array(L));
    const len = input[0].length;

    for (let i = 0; i < len; i++) {
      const n = this.n;

      // 1) เกนที่ต้องการของ sample นี้
      // กรองค่าผิดปกติ (NaN, Infinity) ไม่ให้เข้าไปปนเปื้อนตัวแปรสะสม ซึ่งจะทำให้เสียงเงียบค้างถาวร
      let peak = 0;
      for (let c = 0; c < chIn && c < 32; c++) {
        let x = input[c][i];
        if (!(x > -1e6 && x < 1e6)) x = 0;
        this.sv[c] = x;
        const v = x < 0 ? -x : x;
        if (v > peak) peak = v;
      }
      const req = peak > ceiling ? ceiling / peak : 1;

      // 2) sliding-window minimum (monotonic deque)
      while (this.size > 0 && this.dqVal[(this.tail - 1 + cap) % cap] >= req) {
        this.tail = (this.tail - 1 + cap) % cap;
        this.size--;
      }
      this.dqVal[this.tail] = req;
      this.dqIdx[this.tail] = n;
      this.tail = (this.tail + 1) % cap;
      this.size++;
      while (this.dqIdx[this.head] <= n - L) {
        this.head = (this.head + 1) % cap;
        this.size--;
      }
      const m = this.dqVal[this.head];

      // 3) moving average ของ minimum
      const pos = n % L;
      this.mSum += m - this.mBuf[pos];
      this.mBuf[pos] = m;
      if (n % 8192 === 0 || !(this.mSum === this.mSum)) {
        let s = 0;
        for (let k = 0; k < L; k++) s += this.mBuf[k];
        this.mSum = s; // กัน floating point drift
      }
      let gBox = this.mSum / L;
      if (gBox > 1) gBox = 1;
      else if (gBox < 0) gBox = 0;

      // 4) release นุ่ม ๆ (ไม่เคยสูงกว่า gBox จึงไม่ทำให้เกินเพดาน)
      if (gBox < this.rs) this.rs = gBox;
      else this.rs += (gBox - this.rs) * this.relCoef;
      const g = this.rs;
      if (g < this.minGain) this.minGain = g;

      // 5) หน่วงเสียง L-1 sample แล้วคูณเกน + hard clip
      const rd = (n + 1) % L;
      const wr = pos;
      for (let c = 0; c < output.length; c++) {
        const src = c < chIn ? c : chIn - 1;
        const d = this.delay[src];
        let y = d[rd] * g;
        if (c < chIn) d[wr] = this.sv[c];
        else if (c === chIn) { /* ช่องเกินให้ใช้ค่าเดียวกับช่องสุดท้าย */ }
        if (y > ceiling) y = ceiling;
        else if (y < -ceiling) y = -ceiling;
        output[c][i] = y;
      }
      // ช่องที่ขาออกมากกว่าขาเข้า: เขียน delay ของช่องสุดท้ายไปแล้วข้างบน
      this.n = n + 1;
    }

    this.reportCount += len;
    if (this.reportCount >= 1024) {
      this.port.postMessage({ gr: this.minGain > 0 ? 20 * Math.log10(this.minGain) : -100 });
      this.minGain = this.rs;
      this.reportCount = 0;
    }
    return true;
  }
}

registerProcessor('brickwall-limiter', BrickwallLimiter);
