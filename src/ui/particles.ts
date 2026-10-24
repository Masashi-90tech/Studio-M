// 流れの「見せ場」: ux, uy の場に乗って流れる流線（細い尾を引く粒子）。
// 描画は専用のオフスクリーンキャンバスに軌跡を残し、毎フレーム少しずつ薄めて尾を作る。

export interface VelocityField {
  ux: Float32Array;
  uy: Float32Array;
  mask?: Uint8Array;
  nx: number;
  ny: number;
  /** セル幅 [m] */
  h: number;
}

const COUNT = 900;
const MIN_AGE = 90;
const MAX_AGE = 220;

export class ParticleLayer {
  private xs = new Float32Array(COUNT);
  private ys = new Float32Array(COUNT);
  private ages = new Int16Array(COUNT);
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private speedMax = 1e-9;
  private frame = 0;
  private seeded = false;

  /** 軌跡キャンバスの大きさ（デバイスピクセル）を合わせる。大きさが変われば軌跡は消える */
  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.seeded = false;
  }

  private cellOf(v: VelocityField, x: number, y: number): number {
    const i = Math.min(v.nx - 1, Math.max(0, Math.floor(x / v.h)));
    const j = Math.min(v.ny - 1, Math.max(0, Math.floor(y / v.h)));
    return j * v.nx + i;
  }

  private spawn(k: number, v: VelocityField, inlet: boolean): void {
    const W = v.nx * v.h;
    const H = v.ny * v.h;
    for (let tries = 0; tries < 6; tries++) {
      const x = inlet ? Math.random() * W * 0.02 : Math.random() * W;
      const y = Math.random() * H;
      this.xs[k] = x;
      this.ys[k] = y;
      if (!v.mask || v.mask[this.cellOf(v, x, y)] !== 0) break;
    }
    this.ages[k] = MIN_AGE + Math.floor(Math.random() * (MAX_AGE - MIN_AGE));
  }

  /**
   * 粒子を 1 フレーム進めて軌跡を描き足す。
   * canvasW, canvasH: 描画先キャンバスの大きさ（デバイスピクセル）。場の全体がこの大きさに引き伸ばされる
   */
  update(v: VelocityField, canvasW: number, canvasH: number, advance: boolean): void {
    const W = v.nx * v.h;
    const H = v.ny * v.h;
    const sx = canvasW / W;
    const sy = canvasH / H;
    if (!this.seeded) {
      for (let k = 0; k < COUNT; k++) {
        this.spawn(k, v, false);
        this.ages[k] = Math.floor(Math.random() * MAX_AGE);
      }
      this.seeded = true;
    }
    if (!advance) return;

    // 最大速さは時々だけ測り直す（全セル走査を毎フレームしない）
    if (this.frame++ % 20 === 0) {
      let m = 1e-12;
      for (let c = 0; c < v.ux.length; c++) {
        if (v.mask && v.mask[c] === 0) continue;
        const s = Math.hypot(v.ux[c], v.uy[c]);
        if (s > m) m = s;
      }
      this.speedMax = m;
    }
    // 最も速い所で 1 フレームに領域幅の約 0.5% 動く速さにそろえる
    const dt = (0.005 * W) / this.speedMax;

    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = Math.max(1, canvasH / 400);
    ctx.lineCap = 'round';
    ctx.beginPath();

    for (let k = 0; k < COUNT; k++) {
      const x0 = this.xs[k];
      const y0 = this.ys[k];
      const c = this.cellOf(v, x0, y0);
      const x1 = x0 + v.ux[c] * dt;
      const y1 = y0 + v.uy[c] * dt;
      this.ages[k]--;
      if (x1 < 0 || x1 >= W || y1 < 0 || y1 >= H || this.ages[k] <= 0) {
        this.spawn(k, v, x1 >= W);
        continue;
      }
      if (v.mask && v.mask[this.cellOf(v, x1, y1)] === 0) {
        this.spawn(k, v, false);
        continue;
      }
      ctx.moveTo(x0 * sx, canvasH - y0 * sy);
      ctx.lineTo(x1 * sx, canvasH - y1 * sy);
      this.xs[k] = x1;
      this.ys[k] = y1;
    }
    ctx.stroke();
  }

  draw(target: CanvasRenderingContext2D): void {
    target.drawImage(this.canvas, 0, 0);
  }
}
