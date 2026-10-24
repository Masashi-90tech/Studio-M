// プロモードの「詳細設定」カード: 解析ごとの advanced 項目を「自動 ⇄ 手動」で切り替えて編集する。
// 自動のときは、いま実際に使われている値（結果のスカラー）と理由を見せる。
import type { AnalysisKind } from '../core/types';
import { h, section } from './dom';
import { formatNumber } from './format';
import { plainNumber, type PanelCtx } from './panel-kit';

interface NumSpec {
  type: 'num';
  key: string;
  label: string;
  unit?: string;
  hint: string;
  min: number;
  max: number;
  /** 手動に切り替えたとき、使われている値が分からない場合の初期値 */
  initial: number;
  /** 自動で使われた値が入っている結果スカラーの key（先に見つかったもの） */
  scalarKeys?: string[];
  /** 自動のときの説明（省略時の値など） */
  autoNote: string;
}

interface EnumSpec {
  type: 'enum';
  key: string;
  label: string;
  hint: string;
  options: { value: string; label: string }[];
  initial: string;
  autoNote: string;
}

type Spec = NumSpec | EnumSpec;

const ITERATIVE: Spec[] = [
  {
    type: 'num',
    key: 'tolerance',
    label: '収束判定（相対残差）',
    hint: '小さいほど厳密ですが、反復が増えます',
    min: 1e-12,
    max: 0.1,
    initial: 1e-6,
    scalarKeys: ['tolerance'],
    autoNote: '解析に合わせた値',
  },
  {
    type: 'num',
    key: 'maxIterations',
    label: '最大反復回数',
    unit: '回',
    hint: '収束しなくてもここで打ち切ります',
    min: 10,
    max: 1e7,
    initial: 20000,
    scalarKeys: ['maxIterations'],
    autoNote: '解析に合わせた値',
  },
];

const SPECS: Record<AnalysisKind, Spec[]> = {
  flow: [
    {
      type: 'num',
      key: 'smagorinskyCs',
      label: 'Smagorinsky 定数 Cs',
      hint: '乱流の渦粘性モデル。0 で無効。大きいほど安定しますが、細かい渦がなまります',
      min: 0,
      max: 1,
      initial: 0.1,
      scalarKeys: ['smagorinskyCs'],
      autoNote: 'レイノルズ数に合わせて自動',
    },
    {
      type: 'num',
      key: 'latticeU',
      label: '格子単位の流入速度',
      hint: '0.02〜0.15。小さいほど正確ですが、同じ時間を進めるのに多くのステップが要ります',
      min: 0.005,
      max: 0.2,
      initial: 0.05,
      scalarKeys: ['latticeU'],
      autoNote: '安定に動く範囲で自動',
    },
    {
      type: 'num',
      key: 'perturbation',
      label: '初期の揺らぎ',
      hint: '渦の発生を促す、最初のわずかな乱れの強さ。0 で無し',
      min: 0,
      max: 1,
      initial: 0.01,
      autoNote: '自動（左右対称が崩れるよう小さく付与）',
    },
  ],
  heat: ITERATIVE,
  stress: ITERATIVE,
  scalar: [
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
    ...ITERATIVE,
  ],
  em: [
    {
      type: 'num',
      key: 'cellsPerWavelength',
      label: '1波長あたりのセル数',
      unit: 'セル',
      hint: '媒質中の最短波長に対する分割数。大きいほど正確ですが、重くなります',
      min: 4,
      max: 200,
      initial: 20,
      scalarKeys: ['cellsPerWavelength'],
      autoNote: '既定 20',
    },
    {
      type: 'num',
      key: 'pmlCells',
      label: '吸収境界（PML）の厚さ',
      unit: 'セル',
      hint: '外周で電波を吸い込む層。薄いと端で反射が戻ります',
      min: 4,
      max: 60,
      initial: 12,
      scalarKeys: ['pmlCells'],
      autoNote: '既定 12',
    },
    {
      type: 'num',
      key: 'courant',
      label: 'クーラン数',
      hint: '時間刻みの大きさ。2D の安定限界は 0.707。小さいほど安全で遅くなります',
      min: 0.05,
      max: 0.7071,
      initial: 0.5,
      scalarKeys: ['courant'],
      autoNote: '既定 0.5',
    },
    {
      type: 'enum',
      key: 'waveform',
      label: '波形',
      hint: '連続波は定常状態の分布、パルスは過渡的な伝わり方を見ます',
      options: [
        { value: 'cw', label: '連続波（cw）' },
        { value: 'pulse', label: 'ガウスパルス' },
      ],
      initial: 'cw',
      autoNote: '連続波',
    },
  ],
};

const KIND_TITLE: Record<AnalysisKind, string> = {
  flow: '流れ',
  heat: '熱',
  stress: '強度',
  scalar: '対流拡散',
  em: '電磁波',
};

type Adv = Record<string, number | string | undefined>;

/** project[kind].advanced を読む／書く（空になったら advanced ごと消す） */
function advOf(ctx: PanelCtx, kind: AnalysisKind): Adv | undefined {
  return (ctx.store.project[kind] as { advanced?: Adv }).advanced;
}

function setAdv(ctx: PanelCtx, kind: AnalysisKind, key: string, value: number | string | undefined): void {
  ctx.change(`adv:${kind}:${key}`, () => {
    const holder = ctx.store.project[kind] as { advanced?: Adv };
    const adv: Adv = { ...(holder.advanced ?? {}) };
    if (value === undefined) delete adv[key];
    else adv[key] = value;
    if (Object.values(adv).some((v) => v !== undefined)) holder.advanced = adv;
    else delete holder.advanced;
  });
}

/** 結果のスカラーから、自動で選ばれた値を探す */
function usedValue(ctx: PanelCtx, keys: string[] | undefined): number | undefined {
  if (!keys) return undefined;
  const r = ctx.runner.result;
  for (const k of keys) {
    const s = r?.scalars.find((x) => x.key === k);
    if (s && Number.isFinite(s.value)) return s.value;
  }
  return undefined;
}

/** 1 項目: 自動 ⇄ 手動のスイッチと、手動のときだけ使える入力 */
function autoManualRow(ctx: PanelCtx, kind: AnalysisKind, spec: Spec): HTMLElement {
  const name = `adv-${kind}-${spec.key}`;
  const mk = (value: string, label: string): HTMLInputElement => {
    const input = h('input', { type: 'radio', name, value });
    return Object.assign(input, { title: label });
  };
  const autoRadio = mk('auto', '自動');
  const manualRadio = mk('manual', '手動');
  const note = h('span', { class: 'hint auto-note' });
  const slot = h('div', { class: 'manual-slot' });

  let numeric: ReturnType<typeof plainNumber> | null = null;
  let select: HTMLSelectElement | null = null;
  if (spec.type === 'num') {
    numeric = plainNumber({
      label: '値',
      unit: spec.unit,
      value: spec.initial,
      min: spec.min,
      max: spec.max,
      onChange: (v) => setAdv(ctx, kind, spec.key, v),
    });
    slot.append(numeric.root);
  } else {
    select = h('select', { 'aria-label': spec.label }, ...spec.options.map((o) => h('option', { value: o.value }, o.label)));
    select.addEventListener('change', () => setAdv(ctx, kind, spec.key, select!.value));
    slot.append(select);
  }

  const apply = (manual: boolean): void => {
    if (!manual) {
      setAdv(ctx, kind, spec.key, undefined);
      return;
    }
    // 手動にしたら、いま使われている値から始める
    if (spec.type === 'num') {
      const used = usedValue(ctx, spec.scalarKeys);
      const v = Math.min(spec.max, Math.max(spec.min, used ?? spec.initial));
      numeric!.input.value = String(Number(v.toPrecision(6)));
      setAdv(ctx, kind, spec.key, Number(v.toPrecision(6)));
    } else {
      setAdv(ctx, kind, spec.key, spec.initial);
    }
  };
  autoRadio.addEventListener('change', () => autoRadio.checked && apply(false));
  manualRadio.addEventListener('change', () => manualRadio.checked && apply(true));

  const refresh = (): void => {
    const cur = advOf(ctx, kind)?.[spec.key];
    const manual = cur !== undefined;
    autoRadio.checked = !manual;
    manualRadio.checked = manual;
    slot.hidden = !manual;
    if (manual) {
      if (numeric && typeof cur === 'number') numeric.set(cur);
      if (select && typeof cur === 'string') select.value = cur;
      note.textContent = '手動で指定しています';
    } else {
      const used = spec.type === 'num' ? usedValue(ctx, spec.scalarKeys) : undefined;
      note.textContent = used !== undefined ? `自動: ${formatNumber(used, 3)}（${spec.autoNote}）` : `自動: ${spec.autoNote}`;
    }
  };
  ctx.onRefresh(refresh);
  refresh();

  const seg = h(
    'div',
    { class: 'seg mini', role: 'radiogroup', 'aria-label': `${spec.label}の自動・手動` },
    h('label', null, autoRadio, h('span', null, '自動')),
    h('label', null, manualRadio, h('span', null, '手動')),
  );
  return h(
    'div',
    { class: 'pro-row' },
    h('div', { class: 'pro-head' }, h('span', { class: 'field-label' }, spec.label), seg),
    note,
    slot,
    h('span', { class: 'hint' }, spec.hint),
  );
}

/** 現在の解析の詳細設定カード */
export function proCard(ctx: PanelCtx): HTMLElement {
  const kind = ctx.store.analysis;
  const reset = h('button', { class: 'btn small', type: 'button', onclick: () => {
    ctx.change(`adv:${kind}:reset`, () => delete (ctx.store.project[kind] as { advanced?: Adv }).advanced);
  } }, 'すべて自動に戻す');
  return section(
    `詳細設定（${KIND_TITLE[kind]}・プロ）`,
    h('p', { class: 'hint' }, '「自動」のままなら、ソルバーが条件に合わせて決めます。手動にした項目だけが固定されます。'),
    ...SPECS[kind].map((s) => autoManualRow(ctx, kind, s)),
    reset,
  );
}
