import { describe, expect, it } from 'vitest';
import { defaultProject } from '../../core/project';
import type { Field, PcbInfo, Raster, ResultSet, SolverStatus } from '../../core/types';
import { kgToNewton } from '../../core/units';
import { DEFAULT_PREFS } from '../../ui/modes';
import { getWorkbench } from '../index';
import type { SlabFn, Verdict, VerdictInput } from '../types';
import { emVerdict, findSlab, recommendSlab } from './em';
import { flowVerdict, reynoldsWords } from './flow';
import { heatVerdict, marginLevel, materialTempLimits, nextCooling, partRows, partsVerdict } from './heat';
import { stressVerdict } from './stress';

/** 登録表のワークベンチ経由で判定を作る（画面と同じ入口） */
const computeVerdict = (inp: VerdictInput): Verdict | null => getWorkbench(inp.kind)?.verdict?.(inp) ?? null;

/** 空気中の無損失の平板（垂直入射）の解析解。em.ts が使えない環境でも検証できるようにする */
const mockSlab: SlabFn = (epsR, _tanD, d, f) => {
  const n = Math.sqrt(epsR);
  const delta = (2 * Math.PI * n * d * f) / 299792458;
  const q = (n * n - 1) / (2 * n);
  const T = 1 / (1 + q * q * Math.sin(delta) ** 2); // 損失（tanD）は無視した解析解
  return { transmission: T, reflection: 1 - T };
};

describe('kgToNewton', () => {
  it('1 kg = 9.81 N', () => {
    expect(kgToNewton(1)).toBeCloseTo(9.81, 6);
    expect(kgToNewton(10.2)).toBeCloseTo(100.062, 3);
    expect(kgToNewton(0)).toBe(0);
  });
});

describe('stressVerdict', () => {
  it('目標以上は OK', () => {
    const v = stressVerdict(2.7, 0.0047, 2, 'safe');
    expect(v.level).toBe('ok');
    expect(v.headline).toBe('余裕があります（安全率 2.7）');
    expect(v.lines.join('')).toContain('4.7 mm');
  });
  it('1 以上〜目標未満は注意、1 未満は NG', () => {
    expect(stressVerdict(1.4, 0.001, 2, 'safe').level).toBe('warn');
    expect(stressVerdict(1, 0.001, 2, 'safe').level).toBe('warn');
    const ng = stressVerdict(0.6, 0.001, 2, 'safe');
    expect(ng.level).toBe('ng');
    expect(ng.headline).toContain('壊れる可能性が高い');
  });
  it('目標が変わると同じ安全率でも判定が変わる', () => {
    expect(stressVerdict(2.2, 0.001, 2, 'safe').level).toBe('ok');
    expect(stressVerdict(2.2, 0.001, 3, 'safe').level).toBe('warn');
  });
  it('「どれだけ曲がる？」は変位を見出しにする', () => {
    const v = stressVerdict(5, 0.0123, 2, 'bend');
    expect(v.headline).toContain('12.3 mm');
    expect(v.level).toBe('ok');
  });
  it('力がかかっていなければ目安表示', () => {
    expect(stressVerdict(Infinity, 0, 2, 'safe', false).level).toBe('info');
  });
});

describe('heatVerdict / materialTempLimits', () => {
  const lim = (maxC: number) => [{ materialId: 'pla', name: 'PLA', maxC, limitC: 55 }];
  it('上限−10 以下は OK、上限以下は注意、超えたら NG', () => {
    expect(heatVerdict(40, 25, lim(45)).level).toBe('ok');
    expect(heatVerdict(50, 25, lim(50)).level).toBe('warn');
    expect(heatVerdict(55, 25, lim(55)).level).toBe('warn');
    const ng = heatVerdict(80, 25, lim(80));
    expect(ng.level).toBe('ng');
    expect(ng.headline).toContain('PLAが軟化する温度を超えます');
  });
  it('上限のない材料だけなら中立の目安', () => {
    const v = heatVerdict(78, 25, []);
    expect(v.level).toBe('info');
    expect(v.headline).toContain('78');
  });
  it('材料ごとの最高温度を拾い、余裕の少ない順に並べる', () => {
    const raster = {
      solid: new Uint8Array([1, 1, 1, 0]),
      materialId: ['pla', 'al6061', 'abs', null],
    } as unknown as Raster;
    const temp: Field = { key: 'temperature', label: '温度', unit: '°C', data: new Float32Array([50, 120, 60, 25]) };
    const out = materialTempLimits(temp, raster);
    expect(out.map((o) => o.materialId)).toEqual(['pla', 'abs']);
    expect(out[0]).toMatchObject({ maxC: 50, limitC: 55 });
  });
  it('冷やし方の次の段階', () => {
    expect(nextCooling(7)?.h).toBe(25);
    expect(nextCooling(25)?.h).toBe(60);
    expect(nextCooling(60)).toBeUndefined();
  });
});

/** 部品ごとの結果つきの熱の結果を作る */
function partsResult(parts: { id: string; name: string; maxC: number; limitC?: number; heatW?: number }[]): ResultSet {
  return {
    analysis: 'heat',
    nx: 2,
    ny: 2,
    h: 0.001,
    fields: [],
    scalars: [{ key: 'maxTemp', label: '最高温度', unit: '°C', value: Math.max(...parts.map((p) => p.maxC)) }],
    history: [],
    warnings: [],
    perShape: parts.map((p) => ({
      shapeId: p.id,
      label: p.name,
      values: [
        { key: 'maxTemp', label: '最高温度', unit: '°C', value: p.maxC },
        { key: 'avgTemp', label: '平均温度', unit: '°C', value: p.maxC - 3 },
        { key: 'heatW', label: '発熱', unit: 'W', value: p.heatW ?? 1 },
        ...(p.limitC === undefined
          ? []
          : [
              { key: 'limitC', label: '上限温度', unit: '°C', value: p.limitC },
              { key: 'marginC', label: '余裕', unit: 'K', value: p.limitC - p.maxC },
            ]),
      ],
    })),
  };
}

const PCB: PcbInfo = { source: 't.kicad_pcb', boardThicknessMm: 1.6, substrateId: 'fr4', layers: [{ name: 'F.Cu', thicknessUm: 35, polygons: [] }] };
const DONE: SolverStatus = { done: true, progress: 1, iteration: 10 };

describe('熱の判定: 部品ごとの上限（基板）', () => {
  it('余裕 10 K 以上は OK、0〜10 K は注意、負は NG', () => {
    expect(marginLevel(10)).toBe('ok');
    expect(marginLevel(9.9)).toBe('warn');
    expect(marginLevel(0)).toBe('warn');
    expect(marginLevel(-0.1)).toBe('ng');
  });
  it('部品の行は余裕の少ない順で、上限のない部品は最後に並ぶ', () => {
    const rows = partRows(
      partsResult([
        { id: 'a', name: 'R1', maxC: 60 },
        { id: 'b', name: 'U1', maxC: 100, limitC: 125 },
        { id: 'c', name: 'U2', maxC: 130, limitC: 125 },
      ]),
    );
    expect(rows.map((r) => r.shapeId)).toEqual(['c', 'b', 'a']);
    expect(rows[0].marginC).toBe(-5);
    expect(rows[2].limitC).toBeUndefined();
  });
  it('NG: 超える部品の名前・温度・上限を見出しに出す', () => {
    const v = partsVerdict(partRows(partsResult([{ id: 'u2', name: 'U2 L298N', maxC: 132, limitC: 125 }])), 25);
    expect(v.level).toBe('ng');
    expect(v.headline).toBe('U2 L298N が 132°C で、上限 125°C を超えます');
  });
  it('注意・OK と、ほかに余裕の少ない部品の案内', () => {
    const rows = partRows(
      partsResult([
        { id: 'a', name: 'U1', maxC: 120, limitC: 125 },
        { id: 'b', name: 'U3', maxC: 100, limitC: 105 },
        { id: 'c', name: 'U4', maxC: 50, limitC: 125 },
      ]),
    );
    const warn = partsVerdict(rows, 25);
    expect(warn.level).toBe('warn');
    expect(warn.headline).toContain('U1');
    expect(warn.lines.join('\n')).toContain('U3');
    expect(warn.lines.join('\n')).not.toContain('U4');
    const ok = partsVerdict(partRows(partsResult([{ id: 'c', name: 'U4', maxC: 50, limitC: 125 }])), 25);
    expect(ok.level).toBe('ok');
    expect(ok.headline).toContain('U4');
  });
  it('ワークベンチの判定: 基板なら 2oz 銅箔・ファン・発熱の見直しを次の一手に出す', () => {
    const p = defaultProject();
    p.pcb = structuredClone(PCB);
    p.heat.surfaceH = 7;
    const result = partsResult([{ id: 'u2', name: 'U2 L298N', maxC: 132, limitC: 125 }]);
    const v = computeVerdict({ kind: 'heat', project: p, result, status: DONE, raster: null, prefs: DEFAULT_PREFS })!;
    expect(v.level).toBe('ng');
    expect(v.headline).toContain('U2 L298N');
    expect(v.actions.map((a) => a.kind)).toEqual(['cooling', 'copper', 'review']);
    expect(v.lines.join('')).toContain('銅ベタ');
    // 材料をアルミにする、は基板では出さない
    expect(v.actions.some((a) => a.kind === 'material')).toBe(false);
  });
  it('すでに 2oz なら銅箔の次の一手は出さず、強いファンなら冷やし方も出さない', () => {
    const p = defaultProject();
    p.pcb = structuredClone(PCB);
    p.pcb.layers[0].thicknessUm = 70;
    p.heat.surfaceH = 60;
    const result = partsResult([{ id: 'u2', name: 'U2', maxC: 130, limitC: 125 }]);
    const v = computeVerdict({ kind: 'heat', project: p, result, status: DONE, raster: null, prefs: DEFAULT_PREFS })!;
    expect(v.actions.map((a) => a.kind)).toEqual(['review']);
  });
  it('OK のときは次の一手を出さない。計算中は計算中の判定', () => {
    const p = defaultProject();
    p.pcb = structuredClone(PCB);
    const ok = computeVerdict({ kind: 'heat', project: p, result: partsResult([{ id: 'u', name: 'U', maxC: 60, limitC: 125 }]), status: DONE, raster: null, prefs: DEFAULT_PREFS })!;
    expect(ok.level).toBe('ok');
    expect(ok.actions).toHaveLength(0);
    const pending = computeVerdict({ kind: 'heat', project: p, result: null, status: null, raster: null, prefs: DEFAULT_PREFS })!;
    expect(pending.level).toBe('pending');
  });
  it('上限つきの部品がなければ、これまでどおり材料の耐熱で判定する（基板でない場合も同じ）', () => {
    const p = defaultProject();
    const result = partsResult([{ id: 'a', name: '発熱体', maxC: 60 }]);
    const v = computeVerdict({ kind: 'heat', project: p, result, status: DONE, raster: null, prefs: DEFAULT_PREFS })!;
    expect(v.level).toBe('info');
    expect(v.headline).toContain('60');
  });
  it('部品に上限がある基板でないプロジェクトでは、冷やし方と材料の次の一手を出す', () => {
    const p = defaultProject();
    p.shapes = [{ id: 'a', name: 'チップ', role: 'heatSource', materialId: 'pla', geom: { kind: 'rect', x: 0, y: 0, w: 0.01, h: 0.01 } }];
    p.heat.surfaceH = 7;
    const v = computeVerdict({ kind: 'heat', project: p, result: partsResult([{ id: 'a', name: 'チップ', maxC: 90, limitC: 85 }]), status: DONE, raster: null, prefs: DEFAULT_PREFS })!;
    expect(v.level).toBe('ng');
    expect(v.actions.map((a) => a.kind)).toEqual(['cooling', 'material']);
  });
});

describe('emVerdict', () => {
  it('透過 90% 以上 OK、70〜90 注意、70 未満 NG', () => {
    expect(emVerdict(97, 2, 'cover', false, null, null).level).toBe('ok');
    expect(emVerdict(97, 2, 'cover', false, null, null).headline).toContain('素通り');
    expect(emVerdict(90, 8, 'cover', false, null, null).level).toBe('ok');
    expect(emVerdict(78, 20, 'cover', false, null, null).level).toBe('warn');
    expect(emVerdict(40, 55, 'cover', false, null, null).level).toBe('ng');
  });
  it('NG のときおすすめの厚みを案内し、ボタンを出す', () => {
    const v = emVerdict(40, 55, 'cover', false, { thicknessMm: 3.7, transmissionPct: 98 }, 1.9);
    expect(v.lines.join('\n')).toContain('おすすめの厚み: 3.7 mm（透過 98%）');
    expect(v.actions).toEqual([{ kind: 'slab', thicknessMm: 3.7, label: '厚みを 3.7 mm にする' }]);
  });
  it('すでにおすすめの厚みなら、ボタンは出さない', () => {
    const v = emVerdict(75, 20, 'cover', false, { thicknessMm: 3.7, transmissionPct: 98 }, 3.7);
    expect(v.actions).toHaveLength(0);
  });
  it('透過率が 100% を超えたら表示は 100% に丸め、理由を添える', () => {
    const v = emVerdict(115, 0.2, 'cover', false, null, null);
    expect(v.headline).toBe('電波はほとんど素通りします（透過 100%）');
    expect(v.lines.join('')).toContain('100% を超えて見える');
  });
  it('OK のときもおすすめの厚みを案内する（ボタンは出さない）', () => {
    const v = emVerdict(96, 1, 'cover', false, { thicknessMm: 3.6, transmissionPct: 96.3 }, 3.7);
    expect(v.lines.join('')).toContain('おすすめの厚み: 3.6 mm');
    expect(v.actions).toHaveLength(0);
  });
  it('金属は反射する旨を添える', () => {
    expect(emVerdict(0.5, 99, 'cover', true, null, null).lines.join('')).toContain('金属');
  });
  it('「どこに反射する？」は反射と通過を並べる', () => {
    const v = emVerdict(10, 85, 'reflect', false, null, null);
    expect(v.level).toBe('info');
    expect(v.headline).toContain('反射 85%');
  });
});

describe('recommendSlab', () => {
  it('PLA 24GHz のおすすめは半波長の約 3.7 mm', () => {
    const rec = recommendSlab(2.8, 0.01, 24e9, mockSlab)!;
    expect(rec.thicknessMm).toBeGreaterThan(3.6);
    expect(rec.thicknessMm).toBeLessThan(3.9);
    expect(rec.transmissionPct).toBeGreaterThan(99);
  });
  it('1 mm 未満は選ばない（0.5 mm が最大でも）', () => {
    // 周波数が低くて 0.5 mm が最大透過の素材でも、1 mm 以上の中から選ぶ
    const rec = recommendSlab(2.8, 0, 1e9, mockSlab)!;
    expect(rec.thicknessMm).toBeGreaterThanOrEqual(1);
  });
  it('同じ透過率なら薄い方（1 周期後の厚みは選ばない）', () => {
    const rec = recommendSlab(2.8, 0, 24e9, mockSlab)!;
    expect(rec.thicknessMm).toBeLessThan(5);
  });
  it('関数が NaN を返し続けるときは null', () => {
    expect(recommendSlab(2.8, 0, 24e9, () => ({ transmission: NaN, reflection: NaN }))).toBeNull();
  });
});

describe('flowVerdict / reynoldsWords', () => {
  it('Re を言葉にする', () => {
    expect(reynoldsWords(10)).toBe('なめらかな流れ');
    expect(reynoldsWords(150)).toBe('渦ができる流れ');
    expect(reynoldsWords(5e4)).toBe('乱れた流れ');
  });
  it('抗力と揚力を並べる', () => {
    const v = flowVerdict(150, 0.012, -0.001);
    expect(v.level).toBe('info');
    expect(v.headline).toContain('渦ができる流れ');
    expect(v.lines.join('')).toContain('抗力');
    expect(v.lines.join('')).toContain('揚力');
  });
});

describe('findSlab / computeVerdict', () => {
  const mk = (): ReturnType<typeof defaultProject> => {
    const p = defaultProject();
    p.domain = { width: 0.12, height: 0.08, nx: 300, autoGrid: true };
    p.shapes = [{ id: 'a', name: 'カバー', role: 'solid', materialId: 'pla', geom: { kind: 'rect', x: 0.05, y: 0.006, w: 0.0037, h: 0.068 } }];
    return p;
  };
  const rs = (analysis: ResultSet['analysis'], scalars: Record<string, number>): ResultSet => ({
    analysis,
    nx: 1,
    ny: 1,
    h: 1,
    fields: [],
    history: [],
    warnings: [],
    scalars: Object.entries(scalars).map(([key, value]) => ({ key, label: key, unit: '', value })),
  });
  const done: SolverStatus = { done: true, progress: 1, iteration: 100 };
  const running: SolverStatus = { done: false, progress: 0.4, iteration: 10 };

  it('縦長の長方形 1 枚は平板、金属や複数の物体は平板ではない', () => {
    expect(findSlab(mk())?.thicknessM).toBeCloseTo(0.0037, 9);
    const metal = mk();
    metal.shapes[0].materialId = 'al6061';
    expect(findSlab(metal)).toBeNull();
    const two = mk();
    two.shapes.push({ ...two.shapes[0], id: 'b' });
    expect(findSlab(two)).toBeNull();
  });
  it('収束前は「計算中…」', () => {
    const v = computeVerdict({ kind: 'stress', project: mk(), result: rs('stress', { minSafety: 3 }), status: running, raster: null, prefs: DEFAULT_PREFS })!;
    expect(v.level).toBe('pending');
    expect(v.headline).toBe('計算中…');
  });
  it('強度: NG のとき次の一手（厚み・材料）を出す', () => {
    const p = mk();
    const v = computeVerdict({ kind: 'stress', project: p, result: rs('stress', { minSafety: 0.5, maxDisplacement: 0.002, maxVonMises: 9e7 }), status: done, raster: null, prefs: DEFAULT_PREFS })!;
    expect(v.level).toBe('ng');
    expect(v.actions.map((a) => a.kind)).toEqual(['thicker', 'material', 'material']);
    expect(v.actions.some((a) => a.kind === 'material' && a.materialId === 'petg')).toBe(true);
  });
  it('電磁波: 平板があれば slab 関数で推薦する', () => {
    const v = computeVerdict({
      kind: 'em',
      project: { ...mk(), em: { ...mk().em, frequencyGHz: 24 } },
      result: rs('em', { transmission: 55, reflection: 40 }),
      status: done,
      raster: null,
      prefs: DEFAULT_PREFS,
      slab: mockSlab,
    })!;
    expect(v.level).toBe('ng');
    expect(v.lines.join('\n')).toContain('おすすめの厚み');
  });
  it('流れは途中経過でも数字を見せる', () => {
    const v = computeVerdict({ kind: 'flow', project: mk(), result: rs('flow', { Re: 150, drag: 0.1, lift: 0 }), status: running, raster: null, prefs: DEFAULT_PREFS })!;
    expect(v.level).toBe('info');
  });
  it('対流拡散には判定を出さない', () => {
    expect(computeVerdict({ kind: 'scalar', project: mk(), result: null, status: null, raster: null, prefs: DEFAULT_PREFS })).toBeNull();
  });
});

describe('applyAction（次の一手の反映）', () => {
  const body = (id: string, role: 'solid' | 'heatSource', materialId: string) =>
    ({ id, name: id, role, materialId, geom: { kind: 'rect', x: 0, y: 0, w: 0.01, h: 0.01 } }) as const;
  it('熱: 材料の変更は発熱体を変えず、まわりの部品だけを替える。冷やし方は熱伝達率に入る', () => {
    const wb = getWorkbench('heat')!;
    const p = defaultProject();
    p.shapes = [body('a', 'solid', 'pla'), body('b', 'heatSource', 'c1100')];
    wb.applyAction!({ project: p, action: { kind: 'material', materialId: 'al6061', label: '' } });
    expect(p.shapes.map((s) => s.materialId)).toEqual(['al6061', 'c1100']);
    wb.applyAction!({ project: p, action: { kind: 'cooling', h: 25, label: '' } });
    expect(p.heat.surfaceH).toBe(25);
  });
  it('熱（基板）: 銅箔の厚さを倍にする。部品を選ぶ操作は selectShape に渡す', () => {
    const wb = getWorkbench('heat')!;
    const p = defaultProject();
    p.pcb = structuredClone(PCB);
    wb.applyAction!({ project: p, action: { kind: 'copper', factor: 2, label: '' } });
    expect(p.pcb.layers[0].thicknessUm).toBe(70);
    const picked: (string | null)[] = [];
    wb.applyAction!({ project: p, action: { kind: 'review', shapeId: 'u2', label: '' }, selectShape: (id) => picked.push(id) });
    expect(picked).toEqual(['u2']);
    // pcb がなくても、選択の関数がなくても壊れない
    const q = defaultProject();
    expect(() => wb.applyAction!({ project: q, action: { kind: 'copper', factor: 2, label: '' } })).not.toThrow();
    expect(() => wb.applyAction!({ project: q, action: { kind: 'review', shapeId: 'x', label: '' } })).not.toThrow();
  });
  it('強度: 厚みを増やす・材料を全物体に反映する', () => {
    const wb = getWorkbench('stress')!;
    const p = defaultProject();
    p.shapes = [body('a', 'solid', 'pla'), body('b', 'solid', 'pla')];
    const t = p.thickness;
    wb.applyAction!({ project: p, action: { kind: 'thicker', factor: 1.5, label: '' } });
    expect(p.thickness).toBeCloseTo(t * 1.5, 12);
    wb.applyAction!({ project: p, action: { kind: 'material', materialId: 'petg', label: '' } });
    expect(p.shapes.map((s) => s.materialId)).toEqual(['petg', 'petg']);
  });
  it('電磁波: 平板の厚みを中心を保って変える', () => {
    const wb = getWorkbench('em')!;
    const p = defaultProject();
    p.domain = { width: 0.12, height: 0.08, nx: 300, autoGrid: true };
    p.shapes = [{ id: 'a', name: 'カバー', role: 'solid', materialId: 'pla', geom: { kind: 'rect', x: 0.05, y: 0.006, w: 0.0037, h: 0.068 } }];
    wb.applyAction!({ project: p, action: { kind: 'slab', thicknessMm: 2, label: '' } });
    const g = p.shapes[0].geom;
    expect(g.kind === 'rect' && g.w).toBeCloseTo(0.002, 9);
    expect(g.kind === 'rect' && g.x + g.w / 2).toBeCloseTo(0.05 + 0.0037 / 2, 9);
  });
});
