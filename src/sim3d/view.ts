// 3D ビュー（左側）。mesh3d のビューアに、面の選択・条件の色・結果の色・断面をつなぐ。
// 状態（Sim3DModel）が変わるたびに必要な分だけ描き直す。
import type { Study3D } from '../core/types';
import { sliceMesh, sectionSegments3D } from '../mesh3d/slice';
import type { Box3, TriMesh } from '../mesh3d/types';
import { createViewer, type Viewer, type ViewerHighlight } from '../mesh3d/viewer';
import { buildFaceGraph, raycastMesh, selectConnectedFaces, updateSelection, type FaceGraph } from './faces';
import type { ModelEvent, Sim3DModel } from './model';
import { refineForDisplay, type RefinedMesh } from './refine';
import { fieldRange3D, hasValues, resultField, sectionImage, vertexColors } from './result-view';
import { ROLE_INFO, SELECTION_COLOR } from './regions';
import { mesh3DBounds } from '../core/grid3d';

export interface SceneView {
  /** モデルの状態が変わったとき */
  refresh(e: ModelEvent): void;
  resetView(): void;
  resize(): void;
  dispose(): void;
}

export type SceneViewResult = { view: SceneView } | { error: string };

/** 表示用に三角形を割るときの辺の長さの上限（外接箱の対角線に対する割合） */
const REFINE_EDGE_RATIO = 1 / 100;

export function createSceneView(opts: { host: HTMLElement; model: Sim3DModel; accent: string; background: string }): SceneViewResult {
  const { host, model } = opts;
  const r = createViewer(host, { accent: opts.accent, background: opts.background, label: '3D モデル。面をクリックで選択、ドラッグで回転、ホイールで拡大縮小' });
  if ('error' in r) return { error: r.error.replace('断面の位置は、右の数値と 2D の図で指定できます。', '') };
  const viewer: Viewer = r.viewer;

  const mesh = model.study.mesh;
  const b = mesh3DBounds(mesh);
  if (!b) {
    viewer.dispose();
    return { error: '3D モデルに三角形がありません。STL / OBJ を読み込み直してください。' };
  }
  const box: Box3 = { min: b.min, max: b.max };
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const refined: RefinedMesh = refineForDisplay(mesh, { maxEdge: diag * REFINE_EDGE_RATIO });
  const shown: TriMesh = refined.mesh;
  viewer.setMesh(shown, box);

  let graph: FaceGraph | null = null;
  let raf = 0;
  let disposed = false;
  // 結果の色は、結果ごとに 1 回だけ作る
  let colorsFor: unknown = null;
  let colorsOn = false;
  let outlineKey = '';

  // ---------- 面の強調 ----------
  function updateHighlights(): void {
    const study: Study3D = model.study;
    const nOrig = Math.floor(mesh.indices.length / 3);
    const owner = new Int16Array(nOrig).fill(-1);
    const groups: ViewerHighlight[] = [];
    // 結果の色が出ているときは、色が読み取れるよう条件の面の色を薄くする
    const resultOn = !!model.result && model.view.showResult;
    const lists: number[][] = [];
    const add = (faces: Iterable<number>, color: [number, number, number], alpha: number): void => {
      const gi = lists.length;
      lists.push([]);
      groups.push({ triangles: [], color, alpha });
      for (const t of faces) if (t >= 0 && t < nOrig) owner[t] = gi;
    };
    for (const reg of study.regions) {
      const active = reg.id === model.activeRegionId;
      if (!model.view.showRegions && !active) continue;
      const c = ROLE_INFO[reg.role].color;
      add(reg.faces, active ? ([Math.min(1, c[0] + 0.25), Math.min(1, c[1] + 0.25), Math.min(1, c[2] + 0.25)] as [number, number, number]) : c, resultOn ? (active ? 0.55 : 0.3) : active ? 0.88 : 0.55);
    }
    if (model.selection.size > 0) add(model.selection, SELECTION_COLOR, 0.8);
    if (lists.length === 0) {
      viewer.setHighlights([]);
      return;
    }
    for (let t = 0; t < refined.origin.length; t++) {
      const gi = owner[refined.origin[t]];
      if (gi >= 0) lists[gi].push(t);
    }
    viewer.setHighlights(groups.map((g, i) => ({ ...g, triangles: lists[i] })));
  }

  // ---------- 結果の色と断面 ----------
  function updateResult(): void {
    const res = model.result;
    const on = !!res && model.view.showResult;
    if (!on) {
      if (colorsOn) viewer.setVertexColors(null);
      colorsOn = false;
      colorsFor = null;
      viewer.setSectionImage(null);
      return;
    }
    const field = resultField(res.data);
    if (!field || !hasValues(field)) {
      viewer.setVertexColors(null);
      colorsOn = false;
      colorsFor = null;
      viewer.setSectionImage(null);
      return;
    }
    const range = fieldRange3D(field);
    if (colorsFor !== res) {
      viewer.setVertexColors(vertexColors({ mesh: shown, grid: res.data.grid, field, range }));
      colorsFor = res;
      colorsOn = true;
    }
    const s = model.section;
    if (s.on) {
      viewer.setSectionImage(sectionImage({ grid: res.data.grid, field, range, axis: s.axis, position: s.position }));
    } else {
      viewer.setSectionImage(null);
    }
  }

  function updateSection(): void {
    const s = model.section;
    if (!s.on) {
      viewer.setClip(null);
      viewer.setPlane(null);
      viewer.setSection(null);
      outlineKey = '';
      viewer.setSectionImage(null);
      return;
    }
    viewer.setClip({ axis: s.axis, position: s.position, hide: s.flip ? -1 : 1 });
    viewer.setPlane({ axis: s.axis, position: s.position });
    // 切り口の輪郭線
    const key = `${s.axis}:${s.position}`;
    if (key !== outlineKey) {
      outlineKey = key;
      try {
        const slice = sliceMesh(mesh, { axis: s.axis, position: s.position });
        viewer.setSection(slice.loops.length > 0 ? sectionSegments3D(slice) : null);
      } catch {
        viewer.setSection(null);
      }
    }
    updateResult();
  }

  // ---------- クリックで面を選ぶ ----------
  viewer.setPickHandler(({ ray, additive }) => {
    if (disposed) return;
    const s = model.section;
    const hide = s.flip ? -1 : 1;
    // 断面で隠れている側の面は選ばない
    const accept = s.on ? (hit: { point: [number, number, number] }) => hide * (hit.point[s.axis] - s.position) <= 0 : undefined;
    const hit = raycastMesh(mesh, ray, accept);
    if (!hit) {
      if (!additive) model.clearSelection();
      return;
    }
    graph ??= buildFaceGraph(mesh);
    const picked = selectConnectedFaces(graph, hit.tri);
    model.setSelection(updateSelection(model.selection, picked, additive));
  });

  // ---------- 外から ----------
  let pending: Set<ModelEvent> = new Set();
  function refresh(e: ModelEvent): void {
    // 描き直しは 1 フレームに 1 回にまとめる（スライダーを動かしても固まらない）
    pending.add(e);
    if (raf) return;
    raf = requestAnimationFrame(() => {
      const ev = pending;
      pending = new Set();
      raf = 0;
      if (disposed) return;
      if (ev.has('selection') || ev.has('study') || ev.has('view') || ev.has('result')) updateHighlights();
      if (ev.has('section')) updateSection();
      if (!ev.has('section') && (ev.has('result') || ev.has('view'))) updateResult();
    });
  }

  updateHighlights();
  updateSection();
  updateResult();
  return {
    view: {
      refresh,
      resetView: () => viewer.resetView(),
      resize: () => viewer.resize(),
      dispose() {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        viewer.setPickHandler(null);
        viewer.dispose();
      },
    },
  };
}
