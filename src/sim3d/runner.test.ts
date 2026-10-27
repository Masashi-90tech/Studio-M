import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Analysis3DKind, ResultSet3D, Solver3D, Solver3DFactory, Study3D } from '../core/types';
import { buildStudy3D } from '../mesh3d/build3d';
import { analyzeMesh } from '../mesh3d/mesh';
import { boxMesh } from '../mesh3d/primitives';
import { Sim3DModel } from './model';
import { FLOW_PUBLISH_MS, Sim3DRunner, isContinuous, snapshotStudy } from './runner';

// タイマーは手で進める（window.setTimeout を溜めておき、tick() で 1 つずつ実行する）。時計は step() が進める
let clock = 0;
let queue: (() => void)[] = [];
const tick = (n = 1): void => {
  for (let i = 0; i < n; i++) queue.shift()?.();
};
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0)); // 遅延読み込み（Promise）が終わるのを待つ

beforeEach(() => {
  clock = 0;
  queue = [];
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void): number => queue.push(fn),
    clearTimeout: (): void => {
      queue = [];
    },
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const makeStudy = (): Study3D => buildStudy3D({ mesh: analyzeMesh(boxMesh(80, 50, 8)).mesh, fileName: 'plate.stl' });

/** 1 回の step で 14 ms・10 ステップ進む、止まらない流れのソルバー（仮） */
function fakeFlowFactory(created: { n: number }): Solver3DFactory {
  return (study) => {
    created.n++;
    let it = 0;
    const solver: Solver3D = {
      analysis: 'flow',
      step: () => {
        clock += 14;
        it += 10;
        return { done: false, progress: it / 100, iteration: it };
      },
      result: (): ResultSet3D => ({
        analysis: 'flow',
        grid: { nx: 1, ny: 1, nz: 1, h: 1, origin: [0, 0, 0] },
        fields: [],
        scalars: [{ key: 'time', label: '経過時間', unit: 's', value: it * 0.001 }],
        history: [],
        warnings: [study.flow ? `v=${study.flow.inletVelocity}` : ''],
      }),
    };
    return solver;
  };
}

describe('流れ（止めるまで進み続ける計算）', () => {
  it('done にならず、0.5 秒ごとに結果を届ける。経過時間とステップ/秒が run に入る', async () => {
    const m = new Sim3DModel(makeStudy());
    m.setAnalysis('flow');
    const created = { n: 0 };
    const runner = new Sim3DRunner(m, async () => fakeFlowFactory(created));
    runner.start();
    expect(m.run.kind).toBe('loading');
    await flush();
    expect(m.run.kind).toBe('running');
    expect(m.result).toBeNull();
    // 14 ms ずつ進めて、0.5 秒に届くまで（読み込みのあと、最初の 1 回はすでに進んでいる）
    const steps = Math.ceil(FLOW_PUBLISH_MS / 14);
    tick(steps - 3);
    expect(m.result).toBeNull();
    tick(3);
    expect(m.result).not.toBeNull();
    expect(m.result!.signature).toBe(m.signature);
    expect(m.result!.flow).toEqual(m.study.flow);
    expect(m.run.kind).toBe('running');
    if (m.run.kind === 'running') {
      expect(m.run.physTime).toBeGreaterThan(0);
      expect(m.run.stepsPerSec).toBeGreaterThan(0);
      expect(m.run.stepsPerSec!).toBeCloseTo(10 / 0.014, -1); // 14 ms で 10 ステップ
    }
    // どれだけ進めても止まらない
    tick(200);
    expect(m.run.kind).toBe('running');
    expect(queue.length).toBe(1);
    expect(runner.live).toBe(true);
  });

  it('一時停止すると、その時点の結果が届き、計算は進まない。再開すると続きから進む（最初からではない）', async () => {
    const m = new Sim3DModel(makeStudy());
    m.setAnalysis('flow');
    const runner = new Sim3DRunner(m, async () => fakeFlowFactory({ n: 0 }));
    runner.start();
    await flush();
    tick(10); // 最初の 1 回と合わせて 11 回・154 ms（まだ結果は届かない）
    expect(m.result).toBeNull();
    runner.pause();
    expect(m.run.kind).toBe('paused');
    expect(m.result).not.toBeNull();
    const pausedIter = m.run.kind === 'paused' ? m.run.iteration : -1;
    expect(pausedIter).toBe(110);
    expect(runner.paused).toBe(true);
    expect(queue.length).toBe(0);
    tick(5);
    expect(m.run.kind).toBe('paused');
    runner.resume();
    expect(m.run.kind).toBe('running');
    tick(Math.ceil(FLOW_PUBLISH_MS / 14) + 1); // 0.5 秒たつと、表示が更新される
    expect(m.run.kind).toBe('running');
    // 続きから進んでいる（最初からなら、ここまでで 400 ステップに届かない）
    if (m.run.kind === 'running') expect(m.run.iteration).toBeGreaterThan(pausedIter + 300);
    expect(runner.paused).toBe(false);
  });

  it('start() は、一時停止中なら再開になる。最初から（restart）は新しいソルバーで、前の結果は新しい結果が届くまで残る', async () => {
    const m = new Sim3DModel(makeStudy());
    m.setAnalysis('flow');
    const created = { n: 0 };
    const runner = new Sim3DRunner(m, async () => fakeFlowFactory(created));
    runner.start();
    await flush();
    tick(40);
    runner.pause();
    const first = m.result!;
    runner.start();
    expect(m.run.kind).toBe('running');
    expect(created.n).toBe(1);
    // 条件を変えてから最初から
    m.setFlow({ inletVelocity: 3 });
    expect(m.stale).toBe(true);
    runner.restart();
    expect(m.run.kind).toBe('loading');
    expect(m.result).toBe(first); // 古い結果は残る
    await flush();
    expect(created.n).toBe(2);
    tick(Math.ceil(FLOW_PUBLISH_MS / 14) + 1);
    expect(m.result).not.toBe(first);
    expect(m.result!.data.warnings).toEqual(['v=3']); // 新しい設定で計算している
    expect(m.stale).toBe(false);
  });

  it('計算を始めたあとに設定を変えても、続いている計算は始めた時点の設定のまま。届いた結果は古い扱い', async () => {
    const m = new Sim3DModel(makeStudy());
    m.setAnalysis('flow');
    const runner = new Sim3DRunner(m, async () => fakeFlowFactory({ n: 0 }));
    runner.start();
    await flush();
    m.setFlow({ direction: '+y' });
    tick(Math.ceil(FLOW_PUBLISH_MS / 14) + 1);
    expect(m.result!.flow?.direction).toBe('+x');
    expect(m.stale).toBe(true);
  });

  it('reset() は、画面に何も出さずに進行中の計算を捨てる（解析の切り替え）', async () => {
    const m = new Sim3DModel(makeStudy());
    m.setAnalysis('flow');
    const runner = new Sim3DRunner(m, async () => fakeFlowFactory({ n: 0 }));
    runner.start();
    await flush();
    tick(3);
    runner.reset();
    expect(runner.live).toBe(false);
    tick(10);
    expect(m.result).toBeNull();
  });
});

describe('熱（定常）', () => {
  it('done になったら結果を 1 回だけ届けて止まる。中止すると cancelled', async () => {
    const m = new Sim3DModel(makeStudy());
    let steps = 0;
    const factory: Solver3DFactory = () => ({
      analysis: 'heat',
      step: () => {
        steps++;
        return { done: steps >= 3, progress: steps / 3, iteration: steps };
      },
      result: () => ({ analysis: 'heat', grid: { nx: 1, ny: 1, nz: 1, h: 1, origin: [0, 0, 0] }, fields: [], scalars: [], history: [], warnings: [] }),
    });
    const asked: Analysis3DKind[] = [];
    const runner = new Sim3DRunner(m, async (a) => {
      asked.push(a);
      return factory;
    });
    runner.start();
    await flush();
    expect(asked).toEqual(['heat']);
    tick(5);
    expect(m.result).not.toBeNull();
    expect(m.run.kind).toBe('idle');
    expect(queue.length).toBe(0);

    steps = -100;
    runner.start();
    await flush();
    tick(2);
    expect(m.run.kind).toBe('running');
    runner.cancel();
    expect(m.run.kind).toBe('cancelled');
  });

  it('ソルバーを読み込めない（null）ときは日本語のエラーを出す', async () => {
    const m = new Sim3DModel(makeStudy());
    const runner = new Sim3DRunner(m, async () => null);
    runner.start();
    await flush();
    expect(m.run.kind).toBe('error');
    if (m.run.kind === 'error') expect(m.run.message).toContain('読み込めませんでした');
  });
});

describe('補助', () => {
  it('止めるまで進み続けるのは流れだけ', () => {
    expect(isContinuous('flow')).toBe(true);
    expect(isContinuous('heat')).toBe(false);
  });

  it('計算を始めたときのコピーは、流れの設定も複製する（あとで画面で変えても影響しない）', () => {
    const m = new Sim3DModel(makeStudy());
    m.setAnalysis('flow');
    m.setFlow({ domain: { upstream: 2 }, thermal: { enabled: false } });
    const snap = snapshotStudy(m.study);
    expect(snap.flow).toEqual(m.study.flow);
    expect(snap.flow).not.toBe(m.study.flow);
    expect(snap.flow!.domain).not.toBe(m.study.flow!.domain);
  });
});
