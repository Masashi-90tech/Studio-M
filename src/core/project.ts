import type { Project } from './types';

/** 新規プロジェクトの初期値。動画（@CFDbyHand）と同じ「四角柱まわりの流れ」 */
export function defaultProject(): Project {
  return {
    version: 1,
    name: '四角柱まわりの流れ',
    domain: { width: 2.0, height: 1.0, nx: 200 },
    thickness: 0.01,
    shapes: [
      { id: 's1', name: '四角柱', role: 'solid', materialId: 'al6061', geom: { kind: 'rect', x: 0.45, y: 0.4, w: 0.2, h: 0.2 } },
    ],
    flow: { fluidId: 'air', inletVelocity: 0.01, walls: 'slip' },
    heat: {
      ambientC: 25,
      surfaceH: 10,
      faceCooling: true,
      edges: {
        left: { type: 'adiabatic' },
        right: { type: 'adiabatic' },
        top: { type: 'adiabatic' },
        bottom: { type: 'adiabatic' },
      },
    },
    stress: { selfWeight: false },
    scalar: { u: 1, gamma: 0.1, rho: 1, phiInlet: 1, phiBody: 0 },
  };
}

let counter = 0;
export function newShapeId(): string {
  counter += 1;
  return `s${Date.now().toString(36)}${counter}`;
}
