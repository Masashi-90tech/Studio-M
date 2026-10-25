import { defaultProject } from '../../../src/core/project';
import { calculixAdapter } from './index';
import { createTestContext } from './test-context';
import { readFileSync } from 'node:fs';

const rect = (x: number, y: number, w: number, h: number) => ({ kind: 'rect' as const, x, y, w, h });
const proj = (P: number, sw = false) => {
  const p = defaultProject();
  p.domain = { width: 1, height: 0.1, nx: 100, autoGrid: false };
  p.thickness = 0.01;
  p.stress = { selfWeight: sw };
  p.shapes = [
    { id: 'a', name: 's', role: 'solid', materialId: 'ss400', geom: rect(0, 0, 1, 0.1) },
    { id: 'b', name: 's', role: 'support', materialId: 'ss400', geom: rect(0, 0, 0.01, 0.1) },
    { id: 'c', name: 's', role: 'load', materialId: 'ss400', geom: rect(0.99, 0, 0.01, 0.1), force: { fx: 0, fy: -P } },
  ];
  return p;
};
async function go(name: string, P: number, options: any, sw = false) {
  const ctx = await createTestContext({ keepDir: true });
  const t0 = Date.now();
  try {
    const out = await calculixAdapter.solve({ analysis: 'stress', engine: 'calculix', project: proj(P, sw), quality: 'draft', options }, ctx);
    console.log(name, ctx.workDir, Date.now() - t0, 'ms', out.result.scalars.map((s) => `${s.key}=${s.value.toPrecision(5)}`).join(' '));
    console.log(out.result.warnings.slice(0, 5));
  } catch (e: any) {
    console.log(name, ctx.workDir, 'ERR', Date.now() - t0, e.message);
  }
}
it('scratch', async () => {
  await go('pl7000 CPS8R', 7000, { elementType: 'CPS8R', plasticity: true });
}, 300000);
