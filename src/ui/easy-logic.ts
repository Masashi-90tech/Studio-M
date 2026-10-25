// かんたんモードの「質問の答え」を Project に反映する純粋関数と、選択肢のデータ。
import { MATERIALS } from '../core/materials';
import type { Project, Shape, ShapeGeom } from '../core/types';
import { geomBBox } from './geometry';
import { GRAVITY, kgToNewton, newtonToKg } from '../core/units';

export { GRAVITY, kgToNewton, newtonToKg };

// ---------- 選択肢 ----------

/** かんたんモードで見せる材料のやさしい名前（順番もこの通り） */
export const EASY_MATERIALS: { id: string; label: string }[] = [
  { id: 'pla', label: 'PLA（3Dプリント）' },
  { id: 'petg', label: 'PETG（3Dプリント・粘る）' },
  { id: 'abs', label: 'ABS（3Dプリント・耐熱）' },
  { id: 'al6061', label: 'アルミ' },
  { id: 'ss400', label: '鉄' },
  { id: 'sus304', label: 'ステンレス' },
  { id: 'c1100', label: '銅' },
  { id: 'wood', label: '木材' },
  { id: 'glass', label: 'ガラス' },
  { id: 'concrete', label: 'コンクリート' },
  { id: 'fr4', label: '基板（FR-4）' },
];

export function easyMaterialLabel(id: string): string {
  return EASY_MATERIALS.find((m) => m.id === id)?.label ?? MATERIALS.find((m) => m.id === id)?.name ?? id;
}

export const HEAT_PRESETS: { label: string; watt: number }[] = [
  { label: 'LED 1W', watt: 1 },
  { label: 'スマホ充電器 5W', watt: 5 },
  { label: 'ラズパイ 7W', watt: 7 },
  { label: 'ノートPC 30W', watt: 30 },
];

export const FLOW_SPEEDS: { label: string; speed: number }[] = [
  { label: 'そよ風 1 m/s', speed: 1 },
  { label: '扇風機 3 m/s', speed: 3 },
  { label: '自転車 6 m/s', speed: 6 },
  { label: '車 28 m/s', speed: 28 },
];

export const EM_SENSORS: { label: string; ghz: number; hint: string }[] = [
  { label: '24GHz 人感センサー', ghz: 24, hint: '人の動きを見るセンサー' },
  { label: '60GHz レーダー', ghz: 60, hint: '近くの人の呼吸や動きを見るレーダー' },
  { label: '77GHz 車載レーダー', ghz: 77, hint: '車の前方を見るレーダー' },
  { label: '2.4GHz Wi-Fi', ghz: 2.4, hint: '家庭用の Wi-Fi' },
  { label: '5GHz Wi-Fi', ghz: 5, hint: '速い Wi-Fi' },
];

// ---------- 物体 ----------

export const isBody = (s: Shape): boolean => s.role === 'solid' || s.role === 'heatSource';

type BodyRole = 'solid' | 'heatSource';
const ALL_BODIES: BodyRole[] = ['solid', 'heatSource'];

/** 物体を同じ材料にする（roles で対象の役割を絞れる。熱では発熱体の材料は変えない） */
export function setBodyMaterial(p: Project, materialId: string, roles: BodyRole[] = ALL_BODIES): void {
  for (const s of p.shapes) if (roles.includes(s.role as BodyRole)) s.materialId = materialId;
}

/** 物体の材料。物体がなければ null、材料がバラバラなら mixed */
export function bodyMaterial(p: Project, roles: BodyRole[] = ALL_BODIES): { id: string | null; mixed: boolean } {
  const ids = new Set(p.shapes.filter((s) => roles.includes(s.role as BodyRole)).map((s) => s.materialId));
  if (ids.size === 0) return { id: null, mixed: false };
  if (ids.size === 1) return { id: [...ids][0], mixed: false };
  return { id: [...ids][0], mixed: true };
}

// ---------- 荷重 ----------

/** 選んでいる図形が荷重ならそれ、そうでなければ最初の荷重 */
export function findLoadShape(p: Project, selectedId: string | null): Shape | undefined {
  const sel = selectedId ? p.shapes.find((s) => s.id === selectedId) : undefined;
  if (sel && sel.role === 'load') return sel;
  return p.shapes.find((s) => s.role === 'load');
}

/** 荷重の大きさを重さ [kg] で表す */
export function loadKg(s: Shape): number {
  const f = s.force ?? { fx: 0, fy: 0 };
  return newtonToKg(Math.hypot(f.fx, f.fy));
}

/** 重さ [kg] を力に直して荷重に入れる。向きは今のまま（力が 0 なら下向き） */
export function setLoadKg(s: Shape, kg: number): void {
  const N = kgToNewton(Math.max(0, kg));
  const f = s.force ?? { fx: 0, fy: 0 };
  const m = Math.hypot(f.fx, f.fy);
  s.force = m > 1e-12 ? { fx: (f.fx / m) * N, fy: (f.fy / m) * N } : { fx: 0, fy: -N };
  s.name = `荷重 ${Number(kg.toPrecision(3))} kg`;
}

/** 最初の物体の左端に「固定面」、右端に「荷重」を置く場所の提案。物体がなければ null */
export function suggestEdgeRects(p: Project, cellM: number): { support: ShapeGeom; load: ShapeGeom } | null {
  const body = p.shapes.find(isBody);
  if (!body) return null;
  const b = geomBBox(body.geom);
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const t = Math.min(bw * 0.4, Math.max(2 * cellM, bw * 0.02));
  const y = b.y0;
  return {
    support: { kind: 'rect', x: Math.max(0, b.x0 - t / 2), y, w: t, h: bh },
    load: { kind: 'rect', x: Math.max(0, Math.min(p.domain.width - t, b.x1 - t / 2)), y, w: t, h: bh },
  };
}

// ---------- 発熱 ----------

export function totalHeatW(p: Project): number {
  return p.shapes.filter((s) => s.role === 'heatSource').reduce((a, s) => a + (s.heatW ?? 0), 0);
}

/** 発熱体が複数あるときは、今の割合のまま合計が watt になるようにする */
export function setTotalHeatW(p: Project, watt: number): void {
  const srcs = p.shapes.filter((s) => s.role === 'heatSource');
  if (srcs.length === 0) return;
  const sum = totalHeatW(p);
  for (const s of srcs) s.heatW = sum > 0 ? ((s.heatW ?? 0) / sum) * watt : watt / srcs.length;
}

/** 最初の物体の中央に置く小さな発熱体の提案 */
export function suggestHeatRect(p: Project): ShapeGeom | null {
  const body = p.shapes.find((s) => s.role === 'solid');
  if (!body) return null;
  const b = geomBBox(body.geom);
  const side = Math.min(b.x1 - b.x0, b.y1 - b.y0) * 0.3;
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  return { kind: 'rect', x: cx - side / 2, y: cy - side / 2, w: side, h: side };
}

/** 熱伝達率に最も近い冷やし方の段階（20% 以内でなければ -1 = カスタム） */
export function coolingIndex(h: number, levels: { h: number }[]): number {
  let best = -1;
  let err = Infinity;
  levels.forEach((l, i) => {
    const e = Math.abs(l.h - h) / l.h;
    if (e < err) {
      err = e;
      best = i;
    }
  });
  return err <= 0.2 ? best : -1;
}

// ---------- 電磁波 ----------

/** 平板の厚み [mm] を、中心の位置を保ったまま変える */
export function setSlabThicknessMm(shape: Shape, mm: number): void {
  if (shape.geom.kind !== 'rect') return;
  const cx = shape.geom.x + shape.geom.w / 2;
  const w = Math.max(1e-5, mm / 1000);
  shape.geom = { ...shape.geom, x: cx - w / 2, w };
}

/** 点波源の位置が領域の外にあるときは、領域の左 1/4・中央の高さに置き直す */
export function clampEmPoint(p: Project): { x: number; y: number } {
  const { width, height } = p.domain;
  const { pointX, pointY } = p.em;
  const inside = pointX > 0 && pointX < width && pointY > 0 && pointY < height;
  return inside ? { x: pointX, y: pointY } : { x: width * 0.25, y: height * 0.5 };
}
