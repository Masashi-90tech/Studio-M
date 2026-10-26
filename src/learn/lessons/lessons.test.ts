import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../ui/presets';
import { getMathProvider } from '../providers';
import { runCheck } from '../lesson-logic';
import { levelRank } from '../topics';
import type { LearnContext, Lesson } from '../types';
import { LEARNING_ORDER, LEARNING_PATH, LESSONS, lessonForPreset } from './index';

const preset = (id: string) => PRESETS.find((p) => p.id === id)!;
const ctxOf = (id: string, edit?: (p: ReturnType<ReturnType<typeof preset>['build']>) => void): LearnContext => {
  const project = preset(id).build();
  edit?.(project);
  return { project, result: null };
};
const stepOf = (lesson: Lesson, kind: 'try' | 'practice', n = 0) => lesson.steps.filter((s) => s.kind === kind)[n];

describe('レッスンの構成', () => {
  it('全プリセットに 1 つずつある', () => {
    expect(LESSONS).toHaveLength(PRESETS.length);
    expect(new Set(LESSONS.map((l) => l.presetId))).toEqual(new Set(PRESETS.map((p) => p.id)));
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
    for (const p of PRESETS) expect(lessonForPreset(p.id)?.id).toBe(p.id);
  });

  for (const lesson of LESSONS) {
    describe(lesson.title, () => {
      it('4〜7 ステップで 5〜15 分。理論・やってみる・確認問題・実践がそろう', () => {
        expect(lesson.steps.length).toBeGreaterThanOrEqual(4);
        expect(lesson.steps.length).toBeLessThanOrEqual(7);
        expect(lesson.minutes).toBeGreaterThanOrEqual(5);
        expect(lesson.minutes).toBeLessThanOrEqual(15);
        const kinds = new Set(lesson.steps.map((s) => s.kind));
        expect(kinds.has('theory')).toBe(true);
        expect(kinds.has('quiz')).toBe(true);
        expect(kinds.has('try') || kinds.has('practice')).toBe(true);
        expect(lesson.topics.length).toBeGreaterThan(0);
        expect(lesson.summary.length).toBeGreaterThan(10);
      });
      it('クイズの答えの番号が選択肢の中にあり、選択肢が重ならない', () => {
        for (const s of lesson.steps) {
          if (s.kind !== 'quiz') continue;
          expect(s.choices.length).toBeGreaterThanOrEqual(2);
          expect(s.answer).toBeGreaterThanOrEqual(0);
          expect(s.answer).toBeLessThan(s.choices.length);
          expect(new Set(s.choices).size).toBe(s.choices.length);
          expect(s.explanation.length).toBeGreaterThan(10);
        }
      });
      it('formulaId が、そのプリセットの解析の式として実在する', () => {
        const kind = preset(lesson.presetId).analysis;
        const ids = getMathProvider(kind).formulas({ project: preset(lesson.presetId).build(), result: null }).map((f) => f.id);
        for (const s of lesson.steps) if (s.kind === 'theory' && s.formulaId) expect(ids, s.formulaId).toContain(s.formulaId);
      });
      it('最初の状態で達成済みになっている確認はない（開いた瞬間に ✓ にならない）', () => {
        const ctx = ctxOf(lesson.presetId);
        lesson.steps.forEach((s, i) => {
          if (s.kind === 'try' || s.kind === 'practice') expect(runCheck(s, ctx), `step ${i + 1}`).toBe(false);
        });
      });
    });
  }

  it('学ぶ順は全レッスンを 1 回ずつ含み、段階は中学 → 高校 → 大学', () => {
    expect([...LEARNING_ORDER].sort()).toEqual(LESSONS.map((l) => l.id).sort());
    expect(LEARNING_PATH.map((s) => s.level)).toEqual(['中学', '高校', '大学']);
    for (const stage of LEARNING_PATH) {
      for (const id of stage.lessonIds) expect(LESSONS.find((l) => l.id === id)!.level).toBe(stage.level);
    }
    const ranks = LEARNING_ORDER.map((id) => levelRank(LESSONS.find((l) => l.id === id)!.level));
    expect([...ranks].sort()).toEqual(ranks);
  });
});

describe('確認（check）が、アプリの状態で ✓ になる', () => {
  const L = (id: string) => LESSONS.find((l) => l.id === id)!;
  it('ヒートシンク: 熱伝達率を上げる / 温度上昇が小さい結果', () => {
    expect(runCheck(stepOf(L('heatsink'), 'try', 1), ctxOf('heatsink', (p) => (p.heat.surfaceH = 25)))).toBe(true);
    const ctx = ctxOf('heatsink');
    const res = { analysis: 'heat' as const, nx: 1, ny: 1, h: 1, fields: [], history: [], warnings: [], scalars: [{ key: 'avgTemp', label: '', unit: '°C', value: 39 }] };
    expect(runCheck(stepOf(L('heatsink'), 'practice'), { ...ctx, result: res })).toBe(true);
    expect(runCheck(stepOf(L('heatsink'), 'practice'), { ...ctx, result: { ...res, scalars: [{ key: 'avgTemp', label: '', unit: '°C', value: 61 }] } })).toBe(false);
  });
  it('ファン冷却: 風を 1.2 m/s 以上にする / 温度が落ち着いて 75°C 以下になった結果', () => {
    expect(runCheck(stepOf(L('fan-heatsink'), 'try'), ctxOf('fan-heatsink', (p) => (p.flow.inletVelocity = 1.2)))).toBe(true);
    const ctx = ctxOf('fan-heatsink');
    const res = (maxTemp: number, heatOut: number) => ({
      analysis: 'flow' as const,
      nx: 1,
      ny: 1,
      h: 1,
      fields: [],
      history: [],
      warnings: [],
      scalars: [
        { key: 'maxTemp', label: '', unit: '°C', value: maxTemp },
        { key: 'heatIn', label: '', unit: 'W', value: 8 },
        { key: 'heatOut', label: '', unit: 'W', value: heatOut },
      ],
    });
    const practice = stepOf(L('fan-heatsink'), 'practice');
    expect(runCheck(practice, { ...ctx, result: res(71, 7.8) })).toBe(true);
    expect(runCheck(practice, { ...ctx, result: res(83, 7.8) })).toBe(false); // まだ熱い
    expect(runCheck(practice, { ...ctx, result: res(40, 2) })).toBe(false); // 計算の直後で、温度が上がりきっていない
  });
  it('基板: 銅の面積が 900 mm² 以上', () => {
    const grow = ctxOf('board', (p) => {
      p.shapes.push({ id: 'x', name: '銅パッド追加', role: 'solid', materialId: 'c1100', geom: { kind: 'rect', x: 0.02, y: 0.045, w: 0.02, h: 0.012 } });
    });
    expect(runCheck(stepOf(L('board'), 'practice'), grow)).toBe(true);
  });
  it('基板: ファン（熱伝達率 25 以上）で ✓。LDO・銅ベタ・接合部温度の式を開く', () => {
    expect(runCheck(stepOf(L('board'), 'try'), ctxOf('board', (p) => (p.heat.surfaceH = 25)))).toBe(true);
    const ids = L('board').steps.flatMap((s) => (s.kind === 'theory' && s.formulaId ? [s.formulaId] : []));
    expect(ids).toEqual(['heat-ldo-loss', 'heat-junction', 'heat-copper-mix']);
  });
  it('L 字ブラケット: 荷重 100 N / 安全率 3 以上', () => {
    const load = ctxOf('l-bracket', (p) => {
      const s = p.shapes.find((x) => x.role === 'load')!;
      s.force = { fx: 0, fy: -100 };
    });
    expect(runCheck(stepOf(L('l-bracket'), 'try'), load)).toBe(true);
    const res = { analysis: 'stress' as const, nx: 1, ny: 1, h: 1, fields: [], history: [], warnings: [], scalars: [{ key: 'minSafety', label: '', unit: '', value: 3.4 }] };
    expect(runCheck(stepOf(L('l-bracket'), 'practice'), { ...load, result: res })).toBe(true);
  });
  it('片持ち梁: 梁の高さを 15 mm にするとたわみ 2 mm 以下', () => {
    const ctx = ctxOf('cantilever', (p) => {
      const beam = p.shapes.find((s) => s.role === 'solid')!;
      if (beam.geom.kind === 'rect') {
        beam.geom = { ...beam.geom, h: 0.015 };
      }
    });
    expect(runCheck(stepOf(L('cantilever'), 'practice'), ctx)).toBe(true);
    const res = { analysis: 'stress' as const, nx: 1, ny: 1, h: 1, fields: [], history: [], warnings: [], scalars: [{ key: 'maxDisplacement', label: '', unit: 'm', value: 0.00454 }] };
    expect(runCheck(stepOf(L('cantilever'), 'try', 1), { project: preset('cantilever').build(), result: res })).toBe(true);
  });
  it('レーダーカバー: 1.9 mm / 半波長の 2 倍で 90% 以上', () => {
    const set = (mm: number) => ctxOf('radar-cover', (p) => {
      const g = p.shapes[0].geom;
      if (g.kind === 'rect') g.w = mm / 1000;
    });
    expect(runCheck(stepOf(L('radar-cover'), 'try'), set(1.9))).toBe(true);
    expect(runCheck(stepOf(L('radar-cover'), 'try'), set(3.7))).toBe(false);
    expect(runCheck(stepOf(L('radar-cover'), 'practice'), set(7.47))).toBe(true);
    expect(runCheck(stepOf(L('radar-cover'), 'practice'), set(5.6))).toBe(false);
  });
  it('Wi-Fi: 木のドアを消す', () => {
    const ctx = ctxOf('wifi-room', (p) => (p.shapes = p.shapes.filter((s) => s.materialId !== 'wood')));
    expect(runCheck(stepOf(L('wifi-room'), 'practice'), ctx)).toBe(true);
  });
  it('金属板: 周波数を下げる / 板を大きくする', () => {
    expect(runCheck(stepOf(L('metal-shadow'), 'try'), ctxOf('metal-shadow', (p) => (p.em.frequencyGHz = 3)))).toBe(true);
    const big = ctxOf('metal-shadow', (p) => {
      const g = p.shapes[0].geom;
      if (g.kind === 'rect') g.h = 0.14;
    });
    expect(runCheck(stepOf(L('metal-shadow'), 'practice'), big)).toBe(true);
  });
  it('流れ: 流速を上げる', () => {
    expect(runCheck(stepOf(L('karman'), 'try'), ctxOf('karman', (p) => (p.flow.inletVelocity = 0.15)))).toBe(true);
    expect(runCheck(stepOf(L('naca0012'), 'practice'), ctxOf('naca0012', (p) => (p.flow.inletVelocity = 0.4)))).toBe(true);
  });
  it('対流拡散: 流速 u を 10 以上', () => {
    expect(runCheck(stepOf(L('square-column'), 'practice'), ctxOf('square-column', (p) => (p.scalar.u = 12)))).toBe(true);
  });
});
