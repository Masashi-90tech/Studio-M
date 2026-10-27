import { describe, expect, it } from 'vitest';
import type { ResultSet3D } from '../core/types';
import { SETTLED_FLOW_THROUGHS, flowRunText, flowScalar, flowVerdict3D, liftScalar, reynoldsWords3D } from './flow-verdict';

const result = (scalars: Record<string, number>): ResultSet3D => ({
  analysis: 'flow',
  grid: { nx: 1, ny: 1, nz: 1, h: 1, origin: [0, 0, 0] },
  fields: [],
  scalars: Object.entries(scalars).map(([key, value]) => ({ key, label: key === 'liftZ' ? '揚力 Z' : key, unit: '', value })),
  history: [],
  warnings: [],
});

describe('3D の流れの判定', () => {
  it('レイノルズ数の言葉は 2D と同じ境界（40 と 1000）', () => {
    expect(reynoldsWords3D(10)).toBe('なめらかな流れ');
    expect(reynoldsWords3D(39.9)).toBe('なめらかな流れ');
    expect(reynoldsWords3D(40)).toBe('渦ができる流れ');
    expect(reynoldsWords3D(999)).toBe('渦ができる流れ');
    expect(reynoldsWords3D(1000)).toBe('乱れた流れ');
    expect(reynoldsWords3D(NaN)).toContain('不明');
    expect(reynoldsWords3D(-1)).toContain('不明');
  });

  it('見出しはレイノルズ数、本文は抗力・Cd・揚力。レベルは目安（info）', () => {
    const v = flowVerdict3D({ result: result({ Re: 250, drag: 0.0123, Cd: 1.18, liftZ: 0.002 }), flowThroughs: 10 });
    expect(v.level).toBe('info');
    expect(v.title).toContain('渦ができる流れ');
    expect(v.title).toContain('250');
    expect(v.lines.join('\n')).toContain('抗力');
    expect(v.lines.join('\n')).toContain('1.18');
    expect(v.lines.join('\n')).toContain('揚力 Z');
    expect(v.lines.join('\n')).toContain('ゆらぎます');
  });

  it('レイノルズ数がなければ「流れを計算しました」。揚力の key は lift で始まる最初のもの', () => {
    expect(flowVerdict3D({ result: result({}) }).title).toBe('流れを計算しました');
    expect(liftScalar(result({ Re: 1, liftZ: 3 }))).toEqual({ label: '揚力 Z', value: 3 });
    expect(liftScalar(result({ Re: 1 }))).toBeUndefined();
    expect(flowScalar(result({ Re: NaN }), 'Re')).toBeUndefined();
  });

  it('まだ通り抜けた回数が少ないときは、値が落ち着いていないと知らせる。落ち着いたら計算が続いていることだけ', () => {
    const early = flowVerdict3D({ result: result({ Re: 10, drag: 1 }), flowThroughs: SETTLED_FLOW_THROUGHS - 1, running: true });
    expect(early.lines.join('\n')).toContain('通り抜けていません');
    const later = flowVerdict3D({ result: result({ Re: 10, drag: 1 }), flowThroughs: SETTLED_FLOW_THROUGHS + 2, running: true });
    expect(later.lines.join('\n')).not.toContain('通り抜けていません');
    expect(later.lines.join('\n')).toContain('計算は続いています');
    const done = flowVerdict3D({ result: result({ Re: 10, drag: 1 }), flowThroughs: 9, running: false });
    expect(done.lines.join('\n')).not.toContain('計算は続いています');
  });

  it('乱れた流れ（Re ≥ 1000）では、平均で見るよう案内する', () => {
    const v = flowVerdict3D({ result: result({ Re: 5000, drag: 1 }), flowThroughs: 20 });
    expect(v.title).toContain('乱れた流れ');
    expect(v.lines.join('\n')).toContain('平均');
  });
});

describe('流れの進み具合の表示', () => {
  it('動いているときは経過時間・ステップ/秒・通り抜けた回数、一時停止中はその旨（ステップ/秒は出さない）', () => {
    const run = flowRunText({ kind: 'running', iteration: 12345, progress: 2.5, physTime: 0.0123, stepsPerSec: 480 });
    expect(run).toContain('経過時間 0.0123 s');
    expect(run).toContain('480 ステップ/秒');
    expect(run).toContain('2.5 回');
    expect(run).toContain('12,345');
    const paused = flowRunText({ kind: 'paused', iteration: 10, progress: 0.1, physTime: 1, stepsPerSec: 99 });
    expect(paused.startsWith('一時停止中')).toBe(true);
    expect(paused).not.toContain('ステップ/秒');
    expect(flowRunText({ kind: 'running', iteration: 0, progress: 0 })).toBe('風が 0 回通り抜けました（0 ステップ）');
  });
});
