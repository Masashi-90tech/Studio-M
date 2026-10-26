// gmsh アダプター（検出）と、gmsh の実行（runGmsh / generateShapedMesh）の試験。
// 実際の gmsh は、STUDIO_M_ENGINE_TESTS=1 のときだけ使う（それ以外は ctx.run を模擬する）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createTestContext, createDetectContext, hasGmsh } from '../calculix/test-context';
import { makeProject, rect, shape } from '../calculix/test-projects';
import type { AdapterContext } from '../../types';
import { gmshAdapter } from './index';
import { firstGmshError, generateShapedMesh, GEO_FILE, GMSH_INSTALL_NOTE, isCommandNotFound, MSH_FILE, runGmsh } from './mesh2d';
import { stripMesh, toMsh2 } from './test-meshes';

/** ctx.run を差し替えた AdapterContext（作業フォルダは本物の一時フォルダ） */
async function fakeContext(run: AdapterContext['run']) {
  const ctx = await createTestContext();
  return { ...ctx, run, cleanup: ctx.cleanup, workDir: ctx.workDir };
}

describe('gmsh アダプター', () => {
  it('単独の解析は持たない（capabilities は空）。solve は日本語のエラー', async () => {
    expect(gmshAdapter.id).toBe('gmsh');
    expect(gmshAdapter.capabilities).toEqual([]);
    const ctx = await createTestContext();
    try {
      await expect(gmshAdapter.solve({ analysis: 'stress', engine: 'gmsh', project: makeProject({ width: 1, height: 1, nx: 10, thickness: 0.01, shapes: [] }) }, ctx)).rejects.toThrow(
        '単独では解析しません',
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it('gmsh --version の出力から版を読む', async () => {
    const info = await gmshAdapter.detect({
      dockerAvailable: false,
      probe: async (command, args) => {
        expect([command, args]).toEqual(['gmsh', ['--version']]);
        return { ok: true, output: '4.15.2\n' };
      },
    });
    expect(info).toMatchObject({ id: 'gmsh', name: 'gmsh', available: true, version: '4.15.2', via: 'native', license: 'GPL-2.0-or-later' });
  });

  it('見つからないときは、入れ方（pip・apt・公式サイト）を案内する', async () => {
    const info = await gmshAdapter.detect({ dockerAvailable: false, probe: async () => ({ ok: false, output: '' }) });
    expect(info).toMatchObject({ available: false, via: 'none' });
    expect(info.note).toContain('pip install gmsh');
    expect(info.note).toContain('sudo apt install gmsh');
    expect(info.note).toContain('gmsh.info');
    // probe が例外を投げても、見つからない扱い
    const thrown = await gmshAdapter.detect({
      dockerAvailable: false,
      probe: async () => {
        throw new Error('boom');
      },
    });
    expect(thrown.available).toBe(false);
  });

  it.skipIf(!hasGmsh)('入っている gmsh を実際に見つける', async () => {
    const info = await gmshAdapter.detect(createDetectContext());
    expect(info.available).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+/);
  });
});

describe('runGmsh（ctx.run を模擬）', () => {
  const geo = 'SetFactory("OpenCASCADE");\n';

  it('gmsh が見つからない（ctx.run が not-found で失敗）: 入れ方を書いた日本語のエラー', async () => {
    const ctx = await fakeContext(async () => {
      throw Object.assign(new Error('「gmsh」が見つかりません。インストールするか、docs/ENGINE.md の手順で Docker を使ってください'), { reason: 'not-found' });
    });
    try {
      await expect(runGmsh(ctx, geo)).rejects.toThrow(GMSH_INSTALL_NOTE);
      await expect(runGmsh(ctx, geo)).rejects.toThrow('pip install gmsh');
      await expect(runGmsh(ctx, geo)).rejects.toThrow('「格子」に戻す');
    } finally {
      await ctx.cleanup();
    }
  });

  it('spawn の ENOENT も、見つからない扱い', async () => {
    const ctx = await fakeContext(async () => {
      throw Object.assign(new Error('spawn gmsh ENOENT'), { code: 'ENOENT' });
    });
    try {
      await expect(runGmsh(ctx, geo)).rejects.toThrow('gmsh が見つかりません');
    } finally {
      await ctx.cleanup();
    }
  });

  it('時間切れや中止は、そのまま投げ直す（見つからないとは言わない）', async () => {
    const ctx = await fakeContext(async () => {
      throw Object.assign(new Error('「gmsh」が時間内に終わらなかったので止めました'), { reason: 'timeout' });
    });
    try {
      await expect(runGmsh(ctx, geo)).rejects.toThrow('時間内');
    } finally {
      await ctx.cleanup();
    }
  });

  it('メッシュが作れなかった（終了コード 1、Error: の行つき）: 理由と直し方を書いた日本語のエラー', async () => {
    const ctx = await fakeContext(async () => ({ code: 1, stdout: '', stderr: 'Info : x\nError   : Self intersecting surface mesh\n' }));
    try {
      await expect(runGmsh(ctx, geo)).rejects.toThrow(/Self intersecting surface mesh.*形を単純にする/s);
    } finally {
      await ctx.cleanup();
    }
  });

  it('gmsh は終了コード 0 でも、メッシュファイルが書かれていなければエラー', async () => {
    const ctx = await fakeContext(async () => ({ code: 0, stdout: '', stderr: '' }));
    try {
      await expect(runGmsh(ctx, geo)).rejects.toThrow('メッシュを作れませんでした');
    } finally {
      await ctx.cleanup();
    }
  });

  it('成功: .geo を作業フォルダに書き、決まった引数で gmsh を呼び、msh を読む', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const ctx = await fakeContext(async (command, args) => {
      calls.push({ command, args });
      await fs.writeFile(path.join(ctx.workDir, MSH_FILE), toMsh2(stripMesh({ w: 1, h: 1, nx: 1, ny: 1 })));
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      const mesh = await runGmsh(ctx, geo);
      expect(mesh.triangleCount).toBe(2);
      expect(calls).toEqual([{ command: 'gmsh', args: [GEO_FILE, '-2', '-format', 'msh2', '-o', MSH_FILE, '-v', '3'] }]);
      expect(await fs.readFile(path.join(ctx.workDir, GEO_FILE), 'utf8')).toBe(geo);
    } finally {
      await ctx.cleanup();
    }
  });

  it('物体がなければ gmsh を呼ぶ前に日本語のエラー', async () => {
    const ctx = await fakeContext(async () => {
      throw new Error('呼ばれないはず');
    });
    try {
      const p = makeProject({ width: 1, height: 1, nx: 10, thickness: 0.01, shapes: [shape('support', rect(0, 0, 0.1, 0.1))] });
      await expect(generateShapedMesh(ctx, { project: p, size: 0.1 })).rejects.toThrow('物体がありません');
    } finally {
      await ctx.cleanup();
    }
  });

  it('要素数の見積もりが上限を超えるときは、寸法を大きくして減らす', async () => {
    let geoText = '';
    const ctx = await fakeContext(async () => {
      geoText = await fs.readFile(path.join(ctx.workDir, GEO_FILE), 'utf8');
      await fs.writeFile(path.join(ctx.workDir, MSH_FILE), toMsh2(stripMesh({ w: 1, h: 1, nx: 1, ny: 1 })));
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      const p = makeProject({ width: 1, height: 1, nx: 100, thickness: 0.01, shapes: [shape('solid', rect(0, 0, 1, 1))] });
      const r = await generateShapedMesh(ctx, { project: p, size: 0.001, maxElements: 1000 });
      expect(r.coarsened).toBe(true);
      expect(r.size).toBeGreaterThan(0.001);
      // 面積 1 m² を 1000 要素で割る寸法（正三角形）
      expect(r.size).toBeCloseTo(Math.sqrt(1 / ((Math.sqrt(3) / 4) * 1000)), 9);
      expect(geoText).toContain(`Mesh.MeshSizeMax = ${Number(r.size.toPrecision(15))};`);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('補助', () => {
  it('見つからないエラーの見分け方と、gmsh の出力からのエラーの行', () => {
    expect(isCommandNotFound(Object.assign(new Error('x'), { reason: 'not-found' }))).toBe(true);
    expect(isCommandNotFound(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true);
    expect(isCommandNotFound(new Error('timeout'))).toBe(false);
    expect(isCommandNotFound('x')).toBe(false);
    expect(firstGmshError('Info : a\nError   : first\nError   : second')).toBe('first');
    expect(firstGmshError('Info : a')).toBeUndefined();
  });
});

describe.skipIf(!hasGmsh)('gmsh の実行（実機）', { timeout: 60_000 }, () => {
  it('穴のある板を 2 次の三角形のメッシュにできる（面積は正確、穴の中にも三角形ができる）', async () => {
    const p = makeProject({
      width: 0.3,
      height: 0.1,
      nx: 120,
      thickness: 0.01,
      shapes: [shape('solid', rect(0, 0, 0.3, 0.1)), shape('hole', { kind: 'circle', cx: 0.15, cy: 0.05, r: 0.01 }), shape('support', rect(0, 0, 0.0025, 0.1))],
    });
    const ctx = await createTestContext();
    try {
      const { mesh, plan } = await generateShapedMesh(ctx, { project: p, size: 0.0025 });
      expect(plan.shapeIndexes).toEqual([0, 1, 2]);
      expect(mesh.triangleCount).toBeGreaterThan(5000);
      expect(mesh.nodeCount).toBeGreaterThan(mesh.triangleCount); // 2 次要素
      // 板全体（穴も含む）の面積 0.03 m² に等しい（三角形の角で数える。穴の縁は曲線なので少し足りない）
      let area = 0;
      for (let e = 0; e < mesh.triangleCount; e++) {
        const [a, b, c] = [mesh.triangles[6 * e], mesh.triangles[6 * e + 1], mesh.triangles[6 * e + 2]];
        area += Math.abs((mesh.coords[2 * b] - mesh.coords[2 * a]) * (mesh.coords[2 * c + 1] - mesh.coords[2 * a + 1]) - (mesh.coords[2 * c] - mesh.coords[2 * a]) * (mesh.coords[2 * b + 1] - mesh.coords[2 * a + 1])) / 2;
      }
      expect(area).toBeGreaterThan(0.0299);
      expect(area).toBeLessThan(0.03 + 1e-9);
      expect(await fs.readdir(ctx.workDir)).toEqual(expect.arrayContaining([GEO_FILE, MSH_FILE]));
    } finally {
      await ctx.cleanup();
    }
  });

  it('自分自身と交差する多角形は、日本語のエラーになる（または gmsh が直して解ける）', async () => {
    const p = makeProject({
      width: 1,
      height: 1,
      nx: 20,
      thickness: 0.01,
      shapes: [shape('solid', { kind: 'polygon', points: [[0, 0], [1, 0], [1, 1], [0.5, -0.5], [0, 1]] })],
    });
    const ctx = await createTestContext();
    try {
      const r = await generateShapedMesh(ctx, { project: p, size: 0.1 }).then(
        () => 'ok',
        (e: Error) => e.message,
      );
      if (r !== 'ok') expect(r).toContain('メッシュを作れませんでした');
    } finally {
      await ctx.cleanup();
    }
  });
});
