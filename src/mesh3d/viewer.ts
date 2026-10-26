// 自前の小さな WebGL ビューア（three.js などは使わない。単一 HTML を軽く保つため）。
// 面ごとの法線で陰影をつけ、ドラッグで回転、ホイール / ピンチで拡大縮小、切る平面を半透明で重ねる。
// 法線は頂点に持たず、フラグメントシェーダーで画面上の微分（dFdx / dFdy）から求める。
// そのため、頂点を共有したままのメッシュ（数十万三角形）をそのまま GPU に渡せて、固まらない。
// 取り込みダイアログ（import-dialog.ts）から使う画面側のファイル。
import { DEFAULT_ORBIT, type Mat4, type OrbitState, multiply, orbitBy, orbitMatrices, ortho, rotationOnly, wheelFactor, zoomBy, project } from './camera';
import type { Axis, Box3, TriMesh } from './types';

export interface ViewerColors {
  /** 切る平面と断面の線の色（#rrggbb） */
  accent: string;
  /** 背景（#rrggbb） */
  background: string;
}

export interface Viewer {
  /** 表示するメッシュ。bounds はその外接箱 */
  setMesh(mesh: TriMesh, bounds: Box3): void;
  /** 切る平面（モデルの単位での位置）。null で非表示 */
  setPlane(plane: { axis: Axis; position: number } | null): void;
  /** 断面の線（x1 y1 z1 x2 y2 z2 … の並び、モデルの単位）。null で非表示 */
  setSection(lines: Float32Array | null): void;
  /** 切る平面より上（軸の正の側）を隠して、中を見えるようにする */
  setClipAbove(on: boolean): void;
  resetView(): void;
  /** 親の大きさが変わったとき */
  resize(): void;
  dispose(): void;
}

export type ViewerResult = { viewer: Viewer } | { error: string };

type GL = WebGLRenderingContext | WebGL2RenderingContext;

function rgb(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const PRECISION = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

/** WebGL 1 / 2 の両方で使えるよう、シェーダーの書き方の違いを前置きの定義で吸収する */
function shaderSource(gl2: boolean, stage: 'vs' | 'fs', body: string): string {
  if (gl2) {
    const pre = stage === 'vs' ? '#define attribute in\n#define varying out\n' : '#define varying in\nout vec4 fragColor;\n#define gl_FragColor fragColor\n';
    return `#version 300 es\n${stage === 'fs' ? PRECISION : ''}${pre}${body}`;
  }
  return `${stage === 'fs' ? `#extension GL_OES_standard_derivatives : enable\n${PRECISION}` : ''}${body}`;
}

const MESH_VS = `
attribute vec3 aPos;
uniform mat4 uView;
uniform mat4 uProj;
varying vec3 vView;
varying vec3 vModel;
void main() {
  vec4 v = uView * vec4(aPos, 1.0);
  vView = v.xyz;
  vModel = aPos;
  gl_Position = uProj * v;
}`;

const MESH_FS = `
uniform vec3 uBase;
uniform vec3 uAxisMask;
uniform float uClipPos;
uniform float uClipOn;
varying vec3 vView;
varying vec3 vModel;
void main() {
  if (uClipOn > 0.5 && dot(vModel, uAxisMask) > uClipPos) discard;
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  if (n.z < 0.0) n = -n;
  vec3 l = normalize(vec3(0.35, 0.55, 0.75));
  float d = max(dot(n, l), 0.0);
  float rim = 0.12 * (1.0 - n.z);
  gl_FragColor = vec4(uBase * (0.32 + 0.62 * d) + rim, 1.0);
}`;

const FLAT_VS = `
attribute vec3 aPos;
uniform mat4 uView;
uniform mat4 uProj;
void main() { gl_Position = uProj * uView * vec4(aPos, 1.0); }`;

const FLAT_FS = `
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

export function createViewer(host: HTMLElement, colors: ViewerColors): ViewerResult {
  const canvas = document.createElement('canvas');
  canvas.className = 'm3d-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '取り込む 3D モデル。ドラッグで回転、ホイールで拡大縮小、矢印キーでも回せます');
  const attrs: WebGLContextAttributes = { antialias: true, alpha: false, powerPreference: 'high-performance' };
  let gl: GL | null = null;
  try {
    gl = canvas.getContext('webgl2', attrs) ?? canvas.getContext('webgl', attrs) ?? (canvas.getContext('experimental-webgl', attrs) as GL | null);
  } catch {
    gl = null;
  }
  if (!gl) return { error: 'このブラウザでは 3D 表示（WebGL）が使えません。断面の位置は、右の数値と 2D の図で指定できます。ブラウザを最新にするか、ハードウェアアクセラレーションを有効にしてください。' };
  const isGl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (!isGl2) {
    const g1 = gl as WebGLRenderingContext;
    if (!g1.getExtension('OES_standard_derivatives') || !g1.getExtension('OES_element_index_uint')) {
      return { error: 'このブラウザの 3D 表示（WebGL）は機能が足りず、モデルを表示できません。断面の位置は、右の数値と 2D の図で指定できます。' };
    }
  }
  const g: GL = gl;

  const compile = (type: number, src: string): WebGLShader => {
    const s = g.createShader(type)!;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'シェーダーのコンパイルに失敗しました');
    return s;
  };
  const link = (vs: string, fs: string): WebGLProgram => {
    const p = g.createProgram()!;
    g.attachShader(p, compile(g.VERTEX_SHADER, shaderSource(isGl2, 'vs', vs)));
    g.attachShader(p, compile(g.FRAGMENT_SHADER, shaderSource(isGl2, 'fs', fs)));
    g.bindAttribLocation(p, 0, 'aPos');
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? 'シェーダーのリンクに失敗しました');
    return p;
  };
  let meshProg: WebGLProgram;
  let flatProg: WebGLProgram;
  try {
    meshProg = link(MESH_VS, MESH_FS);
    flatProg = link(FLAT_VS, FLAT_FS);
  } catch (e) {
    console.error(e);
    return { error: '3D 表示の準備に失敗しました。ブラウザを最新にするか、ページを開き直してください。断面の位置は、右の数値と 2D の図で指定できます。' };
  }
  const uni = (p: WebGLProgram, name: string): WebGLUniformLocation | null => g.getUniformLocation(p, name);
  const U = {
    mView: uni(meshProg, 'uView'),
    mProj: uni(meshProg, 'uProj'),
    mBase: uni(meshProg, 'uBase'),
    mMask: uni(meshProg, 'uAxisMask'),
    mClipPos: uni(meshProg, 'uClipPos'),
    mClipOn: uni(meshProg, 'uClipOn'),
    fView: uni(flatProg, 'uView'),
    fProj: uni(flatProg, 'uProj'),
    fColor: uni(flatProg, 'uColor'),
  };

  // ---------- 状態 ----------
  const accent = rgb(colors.accent, [0.91, 0.35, 0.05]);
  const bg = rgb(colors.background, [0.97, 0.96, 0.94]);
  let orbit: OrbitState = { ...DEFAULT_ORBIT };
  let center: [number, number, number] = [0, 0, 0];
  let scale = 1; // モデルの単位 → 正規化した座標（半径 1）
  let bounds: Box3 | null = null;
  let plane: { axis: Axis; position: number } | null = null;
  let clipAbove = false;
  let indexCount = 0;
  let disposed = false;
  let lost = false;
  let raf = 0;

  const posBuf = g.createBuffer()!;
  const idxBuf = g.createBuffer()!;
  const quadBuf = g.createBuffer()!;
  const outlineBuf = g.createBuffer()!;
  const sectionBuf = g.createBuffer()!;
  const gizmoBuf = g.createBuffer()!;
  let sectionCount = 0;
  g.bindBuffer(g.ARRAY_BUFFER, gizmoBuf);
  // x 軸（赤）・y 軸（緑）・z 軸（青）の線分
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]), g.STATIC_DRAW);

  // 画面の隅の軸の図の文字（X・Y・Z）
  const gizmoLabels = (['X', 'Y', 'Z'] as const).map((t, i) => {
    const el = document.createElement('span');
    el.className = `m3d-axis m3d-axis-${t.toLowerCase()}`;
    el.textContent = t;
    el.style.color = ['#d9302c', '#2a9d3f', '#2563eb'][i];
    return el;
  });
  const gizmoBox = document.createElement('div');
  gizmoBox.className = 'm3d-gizmo';
  gizmoBox.setAttribute('aria-hidden', 'true');
  gizmoBox.append(...gizmoLabels);
  const message = document.createElement('div');
  message.className = 'm3d-message';
  message.hidden = true;
  message.setAttribute('role', 'status');
  host.append(canvas, gizmoBox, message);

  const GIZMO_PX = 72;

  // ---------- 描画 ----------
  function draw(): void {
    raf = 0;
    if (disposed || lost) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    g.viewport(0, 0, w, h);
    g.clearColor(bg[0], bg[1], bg[2], 1);
    g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    if (!bounds || indexCount === 0) return;
    const { view, proj } = orbitMatrices(orbit, w / h);

    g.enable(g.DEPTH_TEST);
    g.disable(g.BLEND);
    g.useProgram(meshProg);
    g.uniformMatrix4fv(U.mView, false, view);
    g.uniformMatrix4fv(U.mProj, false, proj);
    g.uniform3f(U.mBase, 0.66, 0.72, 0.8);
    const planePos = plane ? (plane.position - center[plane.axis]) * scale : 0;
    g.uniform3f(U.mMask, plane?.axis === 0 ? 1 : 0, plane?.axis === 1 ? 1 : 0, plane?.axis === 2 ? 1 : 0);
    g.uniform1f(U.mClipPos, planePos);
    g.uniform1f(U.mClipOn, clipAbove && plane ? 1 : 0);
    g.bindBuffer(g.ARRAY_BUFFER, posBuf);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 3, g.FLOAT, false, 0, 0);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, idxBuf);
    g.drawElements(g.TRIANGLES, indexCount, g.UNSIGNED_INT, 0);

    // 切る平面（半透明）と、断面の線。メッシュの中に隠れないよう、深さの判定を切って重ねる
    g.useProgram(flatProg);
    g.uniformMatrix4fv(U.fView, false, view);
    g.uniformMatrix4fv(U.fProj, false, proj);
    g.disable(g.DEPTH_TEST);
    g.enable(g.BLEND);
    g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA);
    g.enableVertexAttribArray(0);
    if (plane) {
      g.uniform4f(U.fColor, accent[0], accent[1], accent[2], 0.2);
      g.bindBuffer(g.ARRAY_BUFFER, quadBuf);
      g.vertexAttribPointer(0, 3, g.FLOAT, false, 0, 0);
      g.drawArrays(g.TRIANGLE_FAN, 0, 4);
      g.uniform4f(U.fColor, accent[0], accent[1], accent[2], 0.9);
      g.bindBuffer(g.ARRAY_BUFFER, outlineBuf);
      g.vertexAttribPointer(0, 3, g.FLOAT, false, 0, 0);
      g.drawArrays(g.LINE_LOOP, 0, 4);
    }
    if (sectionCount > 0) {
      g.uniform4f(U.fColor, 0.1, 0.1, 0.1, 1);
      g.bindBuffer(g.ARRAY_BUFFER, sectionBuf);
      g.vertexAttribPointer(0, 3, g.FLOAT, false, 0, 0);
      g.drawArrays(g.LINES, 0, sectionCount);
    }

    // 画面の左下に、軸の向きを示す小さな図（回転だけを反映する）
    const px = Math.round(GIZMO_PX * dpr);
    g.viewport(Math.round(6 * dpr), Math.round(6 * dpr), px, px);
    const gv: Mat4 = rotationOnly(view);
    const gp: Mat4 = ortho(-1.25, 1.25, -1.25, 1.25, -3, 3);
    g.uniformMatrix4fv(U.fView, false, gv);
    g.uniformMatrix4fv(U.fProj, false, gp);
    g.bindBuffer(g.ARRAY_BUFFER, gizmoBuf);
    g.vertexAttribPointer(0, 3, g.FLOAT, false, 0, 0);
    const axisColor = [
      [0.85, 0.19, 0.17],
      [0.16, 0.62, 0.25],
      [0.15, 0.39, 0.92],
    ];
    for (let a = 0; a < 3; a++) {
      g.uniform4f(U.fColor, axisColor[a][0], axisColor[a][1], axisColor[a][2], 1);
      g.drawArrays(g.LINES, a * 2, 2);
    }
    g.viewport(0, 0, w, h);
    // 文字は DOM で重ねる（軸の先の画面位置）
    const gm = multiply(gp, gv);
    gizmoLabels.forEach((el, a) => {
      const tip: [number, number, number] = [a === 0 ? 1.12 : 0, a === 1 ? 1.12 : 0, a === 2 ? 1.12 : 0];
      const [sx, sy] = project(gm, tip);
      el.style.left = `${((sx + 1) / 2) * GIZMO_PX}px`;
      el.style.top = `${((1 - sy) / 2) * GIZMO_PX}px`;
    });
  }

  function schedule(): void {
    if (!raf && !disposed) raf = requestAnimationFrame(draw);
  }

  // ---------- 入力 ----------
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const onDown = (e: PointerEvent): void => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onMove = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 1) {
      orbit = orbitBy(orbit, dx, dy);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) orbit = zoomBy(orbit, pinchDist / d);
      pinchDist = d;
    }
    schedule();
  };
  const onUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    orbit = zoomBy(orbit, wheelFactor(dy));
    schedule();
  };
  const onKey = (e: KeyboardEvent): void => {
    const step = 18;
    if (e.key === 'ArrowLeft') orbit = orbitBy(orbit, -step, 0);
    else if (e.key === 'ArrowRight') orbit = orbitBy(orbit, step, 0);
    else if (e.key === 'ArrowUp') orbit = orbitBy(orbit, 0, step);
    else if (e.key === 'ArrowDown') orbit = orbitBy(orbit, 0, -step);
    else if (e.key === '+' || e.key === '=') orbit = zoomBy(orbit, 0.85);
    else if (e.key === '-') orbit = zoomBy(orbit, 1 / 0.85);
    else if (e.key === 'Home') orbit = { ...DEFAULT_ORBIT };
    else return;
    e.preventDefault();
    schedule();
  };
  const onDouble = (): void => {
    orbit = { ...DEFAULT_ORBIT };
    schedule();
  };
  const onLost = (e: Event): void => {
    e.preventDefault();
    lost = true;
    message.hidden = false;
    message.textContent = 'ブラウザが 3D 表示を止めました（グラフィックの資源が足りなくなった可能性があります）。ダイアログを閉じて開き直してください。';
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('dblclick', onDouble);
  canvas.addEventListener('webglcontextlost', onLost);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null;
  ro?.observe(host);

  // ---------- 外から使う操作 ----------
  /** モデルの単位の座標 → 正規化した座標 */
  const norm = (p: [number, number, number]): [number, number, number] => [(p[0] - center[0]) * scale, (p[1] - center[1]) * scale, (p[2] - center[2]) * scale];

  function updatePlane(): void {
    if (!bounds || !plane) return;
    const { min, max } = bounds;
    const pad = 0.06;
    const ext = (a: number): [number, number] => [min[a] - (max[a] - min[a]) * pad, max[a] + (max[a] - min[a]) * pad];
    const a = plane.axis;
    const u = ((a + 1) % 3) as Axis;
    const v = ((a + 2) % 3) as Axis;
    const [u0, u1] = ext(u);
    const [v0, v1] = ext(v);
    const corner = (cu: number, cv: number): [number, number, number] => {
      const c: [number, number, number] = [0, 0, 0];
      c[a] = plane!.position;
      c[u] = cu;
      c[v] = cv;
      return norm(c);
    };
    const quad = new Float32Array([...corner(u0, v0), ...corner(u1, v0), ...corner(u1, v1), ...corner(u0, v1)]);
    g.bindBuffer(g.ARRAY_BUFFER, quadBuf);
    g.bufferData(g.ARRAY_BUFFER, quad, g.DYNAMIC_DRAW);
    g.bindBuffer(g.ARRAY_BUFFER, outlineBuf);
    g.bufferData(g.ARRAY_BUFFER, quad, g.DYNAMIC_DRAW);
  }

  const viewer: Viewer = {
    setMesh(mesh, b) {
      bounds = b;
      center = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const radius = Math.max(Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2, 1e-12);
      scale = 1 / radius;
      const src = mesh.positions;
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        out[i] = (src[i] - center[0]) * scale;
        out[i + 1] = (src[i + 1] - center[1]) * scale;
        out[i + 2] = (src[i + 2] - center[2]) * scale;
      }
      g.bindBuffer(g.ARRAY_BUFFER, posBuf);
      g.bufferData(g.ARRAY_BUFFER, out, g.STATIC_DRAW);
      g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, idxBuf);
      g.bufferData(g.ELEMENT_ARRAY_BUFFER, mesh.indices, g.STATIC_DRAW);
      indexCount = mesh.indices.length;
      updatePlane();
      schedule();
    },
    setPlane(p) {
      plane = p;
      updatePlane();
      schedule();
    },
    setSection(lines) {
      if (!lines || lines.length === 0) {
        sectionCount = 0;
      } else {
        const out = new Float32Array(lines.length);
        for (let i = 0; i < lines.length; i += 3) {
          const n = norm([lines[i], lines[i + 1], lines[i + 2]]);
          out[i] = n[0];
          out[i + 1] = n[1];
          out[i + 2] = n[2];
        }
        g.bindBuffer(g.ARRAY_BUFFER, sectionBuf);
        g.bufferData(g.ARRAY_BUFFER, out, g.DYNAMIC_DRAW);
        sectionCount = lines.length / 3;
      }
      schedule();
    },
    setClipAbove(on) {
      clipAbove = on;
      schedule();
    },
    resetView() {
      orbit = { ...DEFAULT_ORBIT };
      schedule();
    },
    resize: schedule,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKey);
      canvas.removeEventListener('dblclick', onDouble);
      canvas.removeEventListener('webglcontextlost', onLost);
      for (const b of [posBuf, idxBuf, quadBuf, outlineBuf, sectionBuf, gizmoBuf]) g.deleteBuffer(b);
      g.deleteProgram(meshProg);
      g.deleteProgram(flatProg);
      g.getExtension('WEBGL_lose_context')?.loseContext();
      canvas.remove();
      gizmoBox.remove();
      message.remove();
    },
  };
  return { viewer };
}
