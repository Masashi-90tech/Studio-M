// 熱の結果の追加表示: 部品ごとの温度の表（余裕の少ない順・色分け・クリックで選択）と、基板の情報。
// ワークベンチ（modules/heat.ts）の ui.loadResultsExtra が遅延 import で読み込み、結果ボックスの下に差し込まれる。
// 流れ＋熱（modules/flow.ts）も、部品ごとの表だけ（基板の情報なし）を flowResultsExtra で使う。
import type { PcbInfo, Raster } from '../../core/types';
import { getMaterial } from '../../core/materials';
import { clear, h } from '../../ui/dom';
import { formatNumber } from '../../ui/format';
import { marginLevel, partRows, type PartRow } from '../verdicts/heat';
import type { PanelFactory } from '../types';
import './heat-results.css';

const REBUILD_INTERVAL_MS = 150;
const COLUMNS = ['部品', '発熱 W', '最高 °C', '上限 °C', '余裕'];

/** 基板の実効熱伝導率の範囲（物体セルの kEff の最小・最大）。なければ null */
export function kEffRange(raster: Raster | null): { min: number; max: number } | null {
  const k = raster?.kEff;
  if (!raster || !k) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let c = 0; c < k.length; c++) {
    if (!raster.solid[c] || !Number.isFinite(k[c])) continue;
    if (k[c] < min) min = k[c];
    if (k[c] > max) max = k[c];
  }
  return max >= min ? { min, max } : null;
}

/** 銅箔の層の説明（例: F.Cu 35 µm / B.Cu 35 µm） */
export function copperText(pcb: PcbInfo): string {
  if (pcb.layers.length === 0) return '銅箔の層はありません';
  return pcb.layers.map((l) => `${l.name} ${formatNumber(l.thicknessUm, 3)} µm`).join(' / ');
}

function substrateName(pcb: PcbInfo): string {
  try {
    return getMaterial(pcb.substrateId).name;
  } catch {
    return pcb.substrateId;
  }
}

/** 結果の追加表示を作る。board が true なら、基板（project.pcb）があるときその情報も出す */
function createResultsExtra(opts: { board: boolean }): PanelFactory {
  return ({ store, runner, container }) => {
    const root = h('div', { class: 'results-extra-body' });
    container.append(root);
    let sig = '';
    let lastAt = 0;

    const row = (r: PartRow): HTMLElement => {
      const level = r.marginC === undefined ? 'none' : marginLevel(r.marginC);
      const select = (): void => store.select(r.shapeId);
      const tr = h(
        'tr',
        { class: `part-row ${level}${store.selectedId === r.shapeId ? ' sel' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${r.label} を選ぶ`, 'aria-pressed': String(store.selectedId === r.shapeId) },
        h('td', { title: r.label }, r.label),
        h('td', null, r.heatW > 0 ? formatNumber(r.heatW, 3) : '—'),
        h('td', null, formatNumber(r.maxC, 3)),
        h('td', null, r.limitC === undefined ? '—' : formatNumber(r.limitC, 3)),
        h('td', null, r.marginC === undefined ? '—' : `${r.marginC >= 0 ? '+' : '−'}${formatNumber(Math.abs(r.marginC), 3)} K`),
      );
      tr.addEventListener('click', select);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      });
      return tr;
    };

    const partsBox = (rows: PartRow[]): HTMLElement =>
      h(
        'div',
        { class: 'parts-box' },
        h('h4', null, '部品ごとの温度（余裕の少ない順）'),
        h(
          'div',
          { class: 'parts-scroll' },
          h('table', { class: 'parts-table' }, h('thead', null, h('tr', null, ...COLUMNS.map((c) => h('th', { scope: 'col' }, c)))), h('tbody', null, ...rows.map(row))),
        ),
        h('span', { class: 'hint' }, '行を押すと、その部品を図の上で選びます。余裕 = 上限温度 − 最高温度'),
      );

    const boardBox = (pcb: PcbInfo, raster: Raster | null): HTMLElement => {
      const range = kEffRange(raster);
      const kText = range ? `${formatNumber(range.min, 3)} 〜 ${formatNumber(range.max, 3)} W/(m·K)（${substrateName(pcb)}のみ ${formatNumber(getMaterial(pcb.substrateId).k, 3)}）` : '計算後に表示します';
      return h(
        'div',
        { class: 'parts-box' },
        h('h4', null, `基板の情報（${pcb.source}）`),
        h('dl', { class: 'board-info' }, h('dt', null, '板厚'), h('dd', null, `${formatNumber(pcb.boardThicknessMm, 3)} mm（${substrateName(pcb)}）`), h('dt', null, '銅箔'), h('dd', null, copperText(pcb)), h('dt', null, '実効熱伝導率'), h('dd', null, kText)),
      );
    };

    function build(): void {
      clear(root);
      const rows = partRows(runner.result);
      if (rows.length > 0) root.append(partsBox(rows));
      const pcb = opts.board ? (runner.resolved ?? store.project).pcb : undefined;
      if (pcb) root.append(boardBox(pcb, runner.raster));
    }

    return {
      update(): void {
        const pcb = opts.board ? store.project.pcb : undefined;
        const next = `${runner.resultVersion}|${store.selectedId}|${pcb ? `${pcb.boardThicknessMm}:${pcb.layers.map((l) => l.thicknessUm).join(',')}` : ''}`;
        if (next === sig) return;
        const now = performance.now();
        // 計算中は結果が毎フレーム変わるので間引く（選択や基板の変更はすぐ反映する）
        const onlyVersion = next.slice(next.indexOf('|')) === sig.slice(sig.indexOf('|'));
        if (onlyVersion && now - lastAt < REBUILD_INTERVAL_MS) return;
        lastAt = now;
        sig = next;
        build();
      },
      dispose(): void {
        root.remove();
      },
    };
  };
}

export const heatResultsExtra = createResultsExtra({ board: true });
export const flowResultsExtra = createResultsExtra({ board: false });
