// 対流拡散のパネル: 標準モードの設定カード、かんたんモードの案内、プロモードの詳細設定。
// ワークベンチ（modules/scalar.ts）が遅延 import で読み込む。
import { h, numField, section } from '../../ui/dom';
import { formatNumber } from '../../ui/format';
import { cardPanel } from '../../ui/panel-kit';
import { ITERATIVE_SPECS, proPanel, type Spec } from '../../ui/pro-panel';

/** 標準モード: 対流拡散の設定（動画と同じ式の係数） */
export const scalarSettings = cardPanel((ctx) => {
  const { store, runner, change } = ctx;
  const s = store.project.scalar;
  const pe = h('div', { class: 'readout' });
  const updatePe = (): void => {
    const p = store.project;
    const cell = runner.grid?.h ?? p.domain.width / p.domain.nx;
    const Pe = (p.scalar.rho * Math.abs(p.scalar.u) * cell) / p.scalar.gamma;
    pe.textContent = `セルペクレ数 Pe = ρ·u·h/Γ ≈ ${formatNumber(Pe, 2)}。2 を超えると上流差分の数値拡散が目立ちます`;
  };
  ctx.onRefresh(updatePe);
  updatePe();
  const num = (label: string, unit: string, hint: string, key: 'u' | 'gamma' | 'rho' | 'phiInlet' | 'phiBody', min?: number) =>
    numField({
      label,
      unit,
      hint,
      value: s[key],
      min,
      digits: 4,
      onChange: (v) => change(`sc:${key}`, () => (store.project.scalar[key] = v)),
    }).root;
  return section(
    '対流拡散の設定（動画と同じ）',
    num('流速 u', 'm/s', 'x方向の一様な流れ。大きいほど下流へ運ばれます', 'u'),
    num('拡散係数 Γ', 'kg/(m·s)', '大きいほどじわっと広がります（0 にはできません）', 'gamma', 1e-9),
    num('密度 ρ', 'kg/m³', '動画では 1', 'rho', 1e-9),
    num('流入側の φ', '', '左から入ってくる量（濃度・温度など）', 'phiInlet'),
    num('物体表面の φ', '', '物体の表面で固定する値', 'phiBody'),
    pe,
  );
});

/** かんたんモード: 質問はなく、使い方の案内だけ */
export const scalarEasy = cardPanel(() =>
  section(
    '対流拡散（動画の再現）',
    h('p', { class: 'hint' }, '動画と同じ「流れに運ばれて広がる量」の計算です。結果を Excel の数式ブックにして、セルの計算を自分の目で追えます。'),
    h('p', { class: 'hint' }, '流速・拡散係数を変えたいときは「標準」モードに切り替えてください。'),
  ),
);

const SCALAR_SPECS: Spec[] = [
  {
    type: 'enum',
    key: 'scheme',
    label: '対流項の離散化',
    hint: 'hybrid = 動画と同じ。upwind は安定、central は精度が高いが振動しやすい',
    options: [
      { value: 'hybrid', label: 'hybrid（動画と同じ）' },
      { value: 'upwind', label: 'upwind（風上差分）' },
      { value: 'central', label: 'central（中心差分）' },
    ],
    initial: 'hybrid',
    autoNote: 'hybrid',
  },
  {
    type: 'num',
    key: 'relaxation',
    label: 'SOR の緩和係数',
    hint: '1〜1.95。大きいほど速く収束しますが、発散しやすくなります',
    min: 1,
    max: 1.95,
    initial: 1.5,
    scalarKeys: ['relaxation', 'omega'],
    autoNote: 'セルペクレ数から自動',
  },
  ...ITERATIVE_SPECS,
];

/** プロモード: 詳細設定 */
export const scalarPro = proPanel({ kind: 'scalar', specs: SCALAR_SPECS });
