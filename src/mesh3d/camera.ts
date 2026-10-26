// 3D ビューアの軌道カメラと行列の計算。DOM・WebGL に依存しない（テストできるよう viewer.ts から分けてある）。
//
// 行列は WebGL に渡せる列優先の 16 要素。モデルは Z が上。カメラは注視点のまわりを回る（方位角 yaw・仰角 pitch・距離 dist）。

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export interface OrbitState {
  /** 方位角 [rad]。Z 軸まわりの回転 */
  yaw: number;
  /** 仰角 [rad]。-π/2 ～ π/2（真上・真下の手前まで） */
  pitch: number;
  /** 注視点からの距離（モデルの半径を 1 としたとき） */
  dist: number;
}

export const DEFAULT_ORBIT: OrbitState = { yaw: -0.6, pitch: 0.45, dist: 3.2 };

const PITCH_LIMIT = Math.PI / 2 - 0.02;
export const DIST_MIN = 1.3;
export const DIST_MAX = 12;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** ドラッグ（画面のピクセル dx, dy）でカメラを回す。右へ引くとモデルが右へ回って見える */
export function orbitBy(s: OrbitState, dx: number, dy: number, rad = 0.008): OrbitState {
  return { ...s, yaw: s.yaw - dx * rad, pitch: clamp(s.pitch + dy * rad, -PITCH_LIMIT, PITCH_LIMIT) };
}

/** 拡大・縮小。factor > 1 で遠ざかる */
export function zoomBy(s: OrbitState, factor: number): OrbitState {
  return { ...s, dist: clamp(s.dist * factor, DIST_MIN, DIST_MAX) };
}

/** ホイールの deltaY（ピクセル相当）から、拡大縮小の倍率を求める */
export function wheelFactor(deltaY: number): number {
  return Math.exp(clamp(deltaY, -400, 400) * 0.0015);
}

export function cameraPosition(s: OrbitState): Vec3 {
  const cp = Math.cos(s.pitch);
  return [s.dist * cp * Math.cos(s.yaw), s.dist * cp * Math.sin(s.yaw), s.dist * Math.sin(s.pitch)];
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** eye から target を見る視点行列（up は Z） */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 0, 1]): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

/** a × b（列優先） */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export interface CameraMatrices {
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
}

export const FOV_Y = (40 * Math.PI) / 180;

/** 原点（正規化したモデルの中心）を見る軌道カメラの行列 */
export function orbitMatrices(s: OrbitState, aspect: number): CameraMatrices {
  const view = lookAt(cameraPosition(s), [0, 0, 0]);
  const proj = perspective(FOV_Y, aspect, Math.max(0.05, s.dist - 2), s.dist + 2);
  return { view, proj, viewProj: multiply(proj, view) };
}

/** 点を行列で変換して、-1～1 の画面の座標（w で割ったもの）にする */
export function project(m: Mat4, p: Vec3): [number, number, number] {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w];
}

/** 平行投影（軸の向きを示す小さな図に使う） */
export function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = -2 / (f - n);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = -(f + n) / (f - n);
  m[15] = 1;
  return m;
}

/** 視点行列の回転の部分だけ（移動を消す） */
export function rotationOnly(view: Mat4): Mat4 {
  const m = new Float32Array(view);
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  return m;
}
