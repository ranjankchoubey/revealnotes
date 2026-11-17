// Port of XNotes core/stroke/StrokeEngine.kt (ribbon math). Keep constants and order identical.

export const ALPHA = 0.5;
const MIN_TANGENT_LEN = 1e-6;
const MIN_STEP = 1e-9;
const MIN_DIRECTION = 0.1;
const PRESSURE_CURVE_K = 8.0;
const REFERENCE_SPACING = 1.5;
export const SMOOTH_LEN = (REFERENCE_SPACING * (1.0 - ALPHA)) / ALPHA;
const HEAD_LEN = 8.0;
const OPEN_LEN = 8.0;
const CLOSE_LEN = 8.0;
const NIB_RATE_WIDTH = 6.0;
const REVERSAL_FROM_DEG = 120.0;
const REVERSAL_FULL_DEG = 160.0;
const REVERSAL_WAIT = 0.5;
const REVERSAL_MIN_WAIT = 3.0;
const REVERSAL_FROM_COS = Math.cos((REVERSAL_FROM_DEG * Math.PI) / 180);
const DOT_DIR_Y = 1.5;
export const SPEED_HI = 0.6;
const SPEED_WINDOW_MS = 25.0;
const SPEED_FLOOR = 0.1;
export const DEFAULT_SPEED_SMOOTHING = 0.25;
const SPEED_BLUR_REACH = 3.0;
const TAPER_MIN_LEN = 8.0;
const CAP_HOLD_SAMPLES = 4;
const TAPER_TAIL = 0.01;
const TAPER_CURVE_K = 2.0 * Math.log((1.0 - TAPER_TAIL) / TAPER_TAIL);

const headLen = (s: number) => HEAD_LEN * Math.max(s, 0);
const openLen = (s: number, bw: number) => Math.max(OPEN_LEN * Math.max(s, 0), (OPEN_LEN / NIB_RATE_WIDTH) * bw);
const closeLen = (s: number, bw: number) => Math.max(CLOSE_LEN * Math.max(s, 0), (CLOSE_LEN / NIB_RATE_WIDTH) * bw);
const reversalWait = (s: number, bw: number) => Math.max(REVERSAL_MIN_WAIT * Math.max(s, 0), REVERSAL_WAIT * bw);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function holdEndPressure(p: Float64Array) {
  const n = p.length;
  const w = Math.min(CAP_HOLD_SAMPLES, Math.floor((n - 1) / 2));
  if (w < 1) return;
  const headFloor = p[w];
  for (let i = 0; i < w; i++) if (p[i] < headFloor) p[i] = headFloor;
  const tailFloor = p[n - 1 - w];
  for (let i = n - w; i < n; i++) if (p[i] < tailFloor) p[i] = tailFloor;
}

function emaStep(prevOut: number, prevIn: number, curIn: number, d: number, lambda: number): number {
  if (lambda <= 0) return curIn;
  if (d <= MIN_STEP) return prevOut;
  const decay = Math.exp(-d / lambda);
  const slope = ((curIn - prevIn) * lambda * (1.0 - decay)) / d;
  return decay * prevOut + curIn - decay * prevIn - slope;
}

export function emaByArc(values: Float64Array, steps: Float64Array, lambda: number): Float64Array {
  if (values.length === 0) return values;
  if (lambda <= 0) return values.slice();
  const out = new Float64Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = emaStep(out[i - 1], values[i - 1], values[i], steps[i], lambda);
  return out;
}

export function logisticEase(x: number, k: number): number {
  if (k <= 0) return x;
  const lo = 1.0 / (1.0 + Math.exp(k * 0.5));
  const hi = 1.0 / (1.0 + Math.exp(-k * 0.5));
  const raw = 1.0 / (1.0 + Math.exp(-k * (x - 0.5)));
  return (raw - lo) / (hi - lo);
}

export function halfWidth(baseWidth: number, pressureEnabled: boolean, m: number, ds: number, pressure: number, ty: number): number {
  const pEff = pressureEnabled ? logisticEase(pressure, PRESSURE_CURVE_K) : 1.0;
  const wBase = baseWidth * (m + (1 - m) * pEff);
  const direction = Math.max(1 + ds * ty, MIN_DIRECTION);
  return (wBase * direction) / 2.0;
}

function smoothstep(lo: number, hi: number, x: number): number {
  if (hi <= lo) return x >= hi ? 1.0 : 0.0;
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---- speed pen ----

const floorSpeed = (top: number, speedScale: number) => (speedScale > 0 ? (SPEED_FLOOR * top) / speedScale : 0);

function movingStep(dt: number, step: number, floor: number): number {
  const t = Math.max(dt, 0);
  return floor > 0 ? Math.min(t, step / floor) : t;
}

function arcAt(tau: Float64Array, cum: Float64Array, n: number, x: number, cursor: Int32Array, end: number): number {
  let k = cursor[end];
  while (k < n - 1 && tau[k] < x) k++;
  cursor[end] = k;
  if (k === 0 || tau[k] < x) return cum[k];
  const t0 = tau[k - 1];
  const span = tau[k] - t0;
  return span > 0 ? cum[k - 1] + ((cum[k] - cum[k - 1]) * (x - t0)) / span : cum[k];
}

function windowSpeed(tau: Float64Array, cum: Float64Array, n: number, i: number, cursor: Int32Array): number {
  const total = tau[n - 1];
  if (total <= 0) return 0;
  let a = tau[i] - SPEED_WINDOW_MS;
  let b = tau[i] + SPEED_WINDOW_MS;
  if (a < 0) { b -= a; a = 0; }
  if (b > total) { a = Math.max(a - (b - total), 0); b = total; }
  if (b <= a) return 0;
  return (arcAt(tau, cum, n, b, cursor, 1) - arcAt(tau, cum, n, a, cursor, 0)) / (b - a);
}

const speedFactor = (v: number, strength: number, top: number, speedScale: number) =>
  1.0 - strength * smoothstep(0, top, v * speedScale);

function blurAt(f: Float64Array, path: Float64Array, n: number, i: number, sigma: number, cursor: Int32Array): number {
  if (sigma <= 0) return f[i];
  const reach = SPEED_BLUR_REACH * sigma;
  const at = path[i];
  let lo = cursor[0];
  while (lo < i && path[lo] < at - reach) lo++;
  cursor[0] = lo;
  const inv = 1.0 / reach;
  let num = 0;
  let den = 0;
  for (let j = lo; j < n; j++) {
    const d = path[j] - at;
    if (d > reach) break;
    const own = (j > 0 ? path[j] - path[j - 1] : 0) + (j < n - 1 ? path[j + 1] - path[j] : 0);
    const u = d * inv;
    const q = 1.0 - u * u;
    const w = q * q * q * own;
    num += w * f[j];
    den += w;
  }
  return den > 0 ? num / den : f[i];
}

function speedFactorsOver(
  times: Float64Array | null, steps: Float64Array, path: Float64Array, n: number,
  strength: number, top: number, sigma: number, speedScale: number,
): Float64Array {
  const out = new Float64Array(n).fill(1.0);
  if (strength <= 0 || n < 2) return out;
  const floor = floorSpeed(top, speedScale);
  const tau = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    tau[i] = tau[i - 1] + movingStep(times === null ? 0 : times[i] - times[i - 1], steps[i], floor);
    cum[i] = cum[i - 1] + steps[i];
  }
  const f = new Float64Array(n);
  const win = new Int32Array(2);
  for (let i = 0; i < n; i++) f[i] = speedFactor(windowSpeed(tau, cum, n, i, win), strength, top, speedScale);
  const blur = new Int32Array(1);
  for (let i = 0; i < n; i++) out[i] = blurAt(f, path, n, i, sigma, blur);
  return out;
}

// ---- taper pen ----

function taperFactors(cum: Float64Array, taperMinFactor: number, smoothScale: number): Float64Array {
  const n = cum.length;
  const out = new Float64Array(n).fill(1.0);
  if (n < 2) return out;
  const total = cum[n - 1];
  if (total < TAPER_MIN_LEN * Math.max(smoothScale, 0)) return out;
  for (let i = 0; i < n; i++) {
    const edge = (total - cum[i]) / total;
    out[i] = taperMinFactor + (1.0 - taperMinFactor) * logisticEase(edge, TAPER_CURVE_K);
  }
  return out;
}

// ---- calligraphy nib ----

function headDirection(sx: Float64Array, sy: Float64Array, cum: Float64Array, hl: number, finished: boolean): [number, number] {
  const k = cum.findIndex((c) => c >= hl);
  if (k < 0) return [finished ? DOT_DIR_Y : -1.0, cum.length - 1];
  const dx = sx[k] - sx[0];
  const dy = sy[k] - sy[0];
  const len = Math.hypot(dx, dy);
  return [len < MIN_TANGENT_LEN ? -1.0 : dy / len, k];
}

function capTail(dir: Float64Array, cum: Float64Array, window: number) {
  const n = dir.length;
  const start = cum[n - 1] - window;
  let i = 1;
  while (i < n - 1 && cum[i] < start) i++;
  let ceiling = dir[i - 1];
  const span = cum[i] - cum[i - 1];
  if (start > cum[i - 1] && span > MIN_STEP) ceiling += ((dir[i] - dir[i - 1]) * (start - cum[i - 1])) / span;
  for (let j = i; j < n; j++) {
    if (dir[j] > ceiling) dir[j] = ceiling;
    else ceiling = dir[j];
  }
}

function nibStep(d: number, target: number, step: number, oLen: number, cLen: number): number {
  const rate = target > d ? oLen : cLen;
  const limit = rate > 0 ? (step * 2.0) / rate : Number.MAX_VALUE;
  return d + clamp(target - d, -limit, limit);
}

function pointAt(x: Float64Array, y: Float64Array, cum: Float64Array, n: number, s: number, out: Float64Array, at: number) {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) {
    out[at] = x[0];
    out[at + 1] = y[0];
    return;
  }
  const span = cum[lo] - cum[lo - 1];
  const f = span > 0 ? (s - cum[lo - 1]) / span : 1.0;
  out[at] = x[lo - 1] + (x[lo] - x[lo - 1]) * f;
  out[at + 1] = y[lo - 1] + (y[lo] - y[lo - 1]) * f;
}

function turnCos(rx: Float64Array, ry: Float64Array, rcum: Float64Array, n: number, j: number, wait: number, scratch: Float64Array): number {
  if (j <= 0 || j >= n - 1 || rcum[j] - wait < 0 || rcum[j] + wait > rcum[n - 1]) return 1.0;
  pointAt(rx, ry, rcum, n, rcum[j] - wait, scratch, 0);
  pointAt(rx, ry, rcum, n, rcum[j] + wait, scratch, 2);
  const ix = rx[j] - scratch[0];
  const iy = ry[j] - scratch[1];
  const ox = scratch[2] - rx[j];
  const oy = scratch[3] - ry[j];
  const li = Math.hypot(ix, iy);
  const lo = Math.hypot(ox, oy);
  if (li < MIN_TANGENT_LEN || lo < MIN_TANGENT_LEN) return 1.0;
  return (ix * ox + iy * oy) / (li * lo);
}

function reversalAt(rx: Float64Array, ry: Float64Array, rcum: Float64Array, n: number, i: number, wait: number, scratch: Float64Array): boolean {
  if (i < 1 || i + 1 >= n || wait <= 0 || rcum[n - 1] <= rcum[i + 1] + wait) return false;
  const c = turnCos(rx, ry, rcum, n, i, wait, scratch);
  if (c > REVERSAL_FROM_COS) return false;
  const inX = rx[i] - scratch[0];
  const inY = ry[i] - scratch[1];
  const outX = scratch[2] - rx[i];
  const outY = scratch[3] - ry[i];
  if (c > turnCos(rx, ry, rcum, n, i - 1, wait, scratch) || c >= turnCos(rx, ry, rcum, n, i + 1, wait, scratch)) return false;
  let k = i + 1;
  while (k < n && rcum[k] <= rcum[i] + wait) {
    if ((rx[k] - rx[k - 1]) * inX + (ry[k] - ry[k - 1]) * inY > 0) return false;
    k++;
  }
  scratch[4] = smoothstep(REVERSAL_FROM_DEG, REVERSAL_FULL_DEG, (Math.acos(clamp(c, -1, 1)) * 180) / Math.PI);
  scratch[5] = clamp(outY / Math.hypot(outX, outY), -1, 1);
  return scratch[4] > 0;
}

function backfill(d: number, rx: Float64Array, ry: Float64Array, rcum: Float64Array, n: number, i: number, wait: number, scratch: Float64Array): number {
  if (!reversalAt(rx, ry, rcum, n, i, wait, scratch)) return d;
  const target = scratch[5];
  return target > d ? d + scratch[4] * (target - d) : d;
}

function nibDirection(
  rx: Float64Array, ry: Float64Array, rcum: Float64Array, ty: Float64Array, steps: Float64Array,
  oLen: number, cLen: number, wait: number, seed: number, holdUntil: number,
): Float64Array {
  const n = ty.length;
  const out = new Float64Array(n);
  const scratch = new Float64Array(6);
  let d = seed;
  for (let i = 0; i < n; i++) {
    if (i <= holdUntil) {
      out[i] = seed;
      continue;
    }
    d = nibStep(d, ty[i], i === 0 ? 0 : steps[i], oLen, cLen);
    d = backfill(d, rx, ry, rcum, n, i, wait, scratch);
    out[i] = d;
  }
  return out;
}

// ---- build ----

export interface BuildParams {
  x: Float64Array;
  y: Float64Array;
  p: Float64Array;
  t: Float64Array | null;
  widthFactor: Float64Array | null;
  baseWidth: number;
  pressureEnabled: boolean;
  m: number;
  ds: number;
  speedStrength: number;
  taperEnabled: boolean;
  taperMinFactor: number;
  speedScale: number;
  smooth: boolean;
  holdEnds: boolean;
  smoothScale: number;
  speedTop: number;
  speedSmoothing: number;
}

export interface RibbonGeometry {
  /** Smoothed centre points, interleaved x,y. */
  centers: Float64Array;
  halfWidths: Float64Array;
}

/** StrokeEngine.build for a finished stroke. */
export function buildRibbon(a: BuildParams): RibbonGeometry {
  const n = a.x.length;
  if (n === 0) return { centers: new Float64Array(0), halfWidths: new Float64Array(0) };
  const finished = true;
  const steps = new Float64Array(n);
  for (let i = 1; i < n; i++) steps[i] = Math.hypot(a.x[i] - a.x[i - 1], a.y[i] - a.y[i - 1]);
  const smoothLen = SMOOTH_LEN * Math.max(a.smoothScale, 0);
  const sx = a.smooth ? emaByArc(a.x, steps, smoothLen) : a.x;
  const sy = a.smooth ? emaByArc(a.y, steps, smoothLen) : a.y;
  const sp = emaByArc(a.p, steps, smoothLen);
  if (a.holdEnds && a.pressureEnabled) holdEndPressure(sp);
  const hw = (i: number, ty: number) => halfWidth(a.baseWidth, a.pressureEnabled, a.m, a.ds, sp[i], ty);

  if (n === 1) {
    const h = hw(0, finished && a.ds > 0 ? DOT_DIR_Y : 0);
    return { centers: Float64Array.of(sx[0], sy[0]), halfWidths: Float64Array.of(h) };
  }

  let lastTx = 1.0;
  let lastTy = 0.0;
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let dx: number, dy: number;
    if (i === 0) { dx = sx[1] - sx[0]; dy = sy[1] - sy[0]; }
    else if (i === n - 1) { dx = sx[i] - sx[i - 1]; dy = sy[i] - sy[i - 1]; }
    else { dx = sx[i + 1] - sx[i - 1]; dy = sy[i + 1] - sy[i - 1]; }
    const len = Math.hypot(dx, dy);
    if (len < MIN_TANGENT_LEN) {
      tx[i] = lastTx;
      ty[i] = lastTy;
    } else {
      tx[i] = dx / len;
      ty[i] = dy / len;
      lastTx = tx[i];
      lastTy = ty[i];
    }
  }

  const speedOn = a.speedStrength > 0 && (a.widthFactor !== null || a.t !== null);
  const needArc = a.ds > 0 || a.taperEnabled || (speedOn && a.widthFactor === null);
  const dirSteps = new Float64Array(needArc ? n : 0);
  const cum = new Float64Array(dirSteps.length);
  if (needArc) {
    for (let i = 1; i < n; i++) {
      dirSteps[i] = Math.hypot(sx[i] - sx[i - 1], sy[i] - sy[i - 1]);
      cum[i] = cum[i - 1] + dirSteps[i];
    }
  }

  const sf = !speedOn
    ? null
    : a.widthFactor !== null
      ? a.widthFactor
      : speedFactorsOver(a.t, steps, cum, n, a.speedStrength, a.speedTop, a.speedSmoothing * a.baseWidth, a.speedScale);
  const tf = a.taperEnabled ? taperFactors(cum, a.taperMinFactor, a.smoothScale) : null;

  let dirY: Float64Array | null = null;
  if (a.ds > 0) {
    const window = headLen(a.smoothScale);
    const [head, holdUntil] = headDirection(sx, sy, cum, window, finished);
    const rcum = new Float64Array(n);
    for (let i = 1; i < n; i++) rcum[i] = rcum[i - 1] + steps[i];
    dirY = nibDirection(
      a.x, a.y, rcum, ty, dirSteps, openLen(a.smoothScale, a.baseWidth), closeLen(a.smoothScale, a.baseWidth),
      reversalWait(a.smoothScale, a.baseWidth), head, holdUntil,
    );
    capTail(dirY, cum, window);
  }

  const centers = new Float64Array(2 * n);
  const halfWidths = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dir = dirY !== null ? clamp(dirY[i], -1, DOT_DIR_Y) : ty[i];
    let h = hw(i, dir);
    if (sf !== null) h *= sf[i];
    if (tf !== null) h *= tf[i];
    centers[2 * i] = sx[i];
    centers[2 * i + 1] = sy[i];
    halfWidths[i] = h;
  }
  return { centers, halfWidths };
}

/** StrokeEngine.speedWidths: the kept width factors a speed stroke saved without them works out on load. */
export function speedWidths(a: BuildParams): Float64Array {
  const n = a.x.length;
  const steps = new Float64Array(n);
  for (let i = 1; i < n; i++) steps[i] = Math.hypot(a.x[i] - a.x[i - 1], a.y[i] - a.y[i - 1]);
  const smoothLen = SMOOTH_LEN * Math.max(a.smoothScale, 0);
  const sx = a.smooth ? emaByArc(a.x, steps, smoothLen) : a.x;
  const sy = a.smooth ? emaByArc(a.y, steps, smoothLen) : a.y;
  const path = new Float64Array(n);
  for (let i = 1; i < n; i++) path[i] = path[i - 1] + Math.hypot(sx[i] - sx[i - 1], sy[i] - sy[i - 1]);
  return speedFactorsOver(a.t, steps, path, n, a.speedStrength, a.speedTop, a.speedSmoothing * a.baseWidth, a.speedScale);
}
