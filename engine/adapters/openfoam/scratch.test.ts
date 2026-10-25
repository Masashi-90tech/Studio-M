import { it } from 'vitest';
import { defaultProject } from '../../../src/core/project';
import { nacaAirfoil } from '../../../src/ui/airfoil';
import { openfoamAdapter } from './index';
import { createTestContext } from './test-context';

it('scratch', async () => {
  const p = defaultProject();
  p.domain = { width: 0.8, height: 0.4, nx: 200, autoGrid: false };
  p.thickness = 0.01;
  p.flow = { fluidId: 'air', inletVelocity: 5, walls: 'slip' };
  p.shapes = [{ id: 'a', name: 'NACA0012', role: 'solid', materialId: 'abs', geom: { kind: 'polygon', points: nacaAirfoil('0012', 0.2, 8, 0.2, 0.215, 40) } }];
  const { ctx, logs } = await createTestContext({ workDir: process.env.SCRATCH_DIR });
  const t0 = Date.now();
  const out = await openfoamAdapter.solve({ analysis: 'flow', engine: 'openfoam', project: p, quality: 'draft', options: { model: 'rans' } }, ctx);
  console.log('sec', (Date.now() - t0) / 1000);
  console.log(logs.filter((l) => !l.startsWith('Time')));
  console.log(out.result.scalars.map((s) => `${s.key}=${s.value}`).join(' '));
  console.log(out.result.warnings);
  const lift = out.result.history[1];
  console.log(lift.values.length, lift.values.filter((_, i) => i % 10 === 0).map((v) => v.toExponential(2)).join(' '));
}, 900000);
