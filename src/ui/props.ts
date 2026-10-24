// 選択した図形のプロパティパネル（名前・役割・材料・数値・寸法）。寸法は mm で表示し、内部ではメートルで持つ。
import type { Shape, ShapeGeom, ShapeRole } from '../core/types';
import { clear, fieldRow, h, numField, selectField, type NumField } from './dom';
import { geomBBox, translateGeom } from './geometry';
import { ensureRoleDefaults, ROLE_HINTS, ROLE_LABELS, ROLES, roleUsesMaterial, solidMaterials } from './project-utils';
import type { Store } from './state';

const MM = 1000;

export function initProps(store: Store, host: HTMLElement): void {
  let geomFields: { field: NumField; get: (g: ShapeGeom) => number }[] = [];

  const edit = (s: Shape, key: string, apply: () => void): void => {
    store.checkpoint(`props:${s.id}:${key}`, 800);
    apply();
    // 名前は計算に関係しないので再計算しない
    store.touch(key === 'name' ? 'label' : 'props');
  };

  function build(): void {
    clear(host);
    geomFields = [];
    const s = store.getShape(store.selectedId);
    if (!s) {
      host.append(
        h(
          'section',
          { class: 'card empty' },
          h('h3', null, '図形のようす'),
          h('p', { class: 'hint' }, '図形をクリックすると、ここで名前・材料・寸法（mm）・発熱量や荷重を変えられます。'),
          h('p', { class: 'hint' }, 'まず左の「長方形」や「円」を選んで、キャンバスをドラッグしてみましょう。'),
        ),
      );
      return;
    }

    const card = h('section', { class: 'card' }, h('h3', null, '選んだ図形'));

    const name = h('input', { type: 'text', value: s.name, maxlength: 40 });
    name.addEventListener('input', () => edit(s, 'name', () => (s.name = name.value)));
    card.append(fieldRow('名前', name));

    card.append(
      selectField(
        '役割',
        ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
        s.role,
        (v) => {
          edit(s, 'role', () => {
            s.role = v as ShapeRole;
            ensureRoleDefaults(s);
          });
          build();
        },
        ROLE_HINTS[s.role],
      ).root,
    );

    if (roleUsesMaterial(s.role)) {
      card.append(
        selectField(
          '材料',
          solidMaterials().map((m) => ({ value: m.id, label: m.name })),
          s.materialId,
          (v) => edit(s, 'mat', () => (s.materialId = v)),
        ).root,
      );
    }
    if (s.role === 'heatSource') {
      card.append(
        numField({
          label: '発熱量',
          unit: 'W',
          hint: 'この図形全体の発熱量。CPU は 5〜100 W、LED は 0.1〜3 W くらい',
          value: s.heatW ?? 0,
          min: 0,
          onChange: (v) => edit(s, 'heatW', () => (s.heatW = v)),
        }).root,
      );
    }
    if (s.role === 'fixedTemp') {
      card.append(
        numField({
          label: '固定する温度',
          unit: '°C',
          hint: 'ヒーターなら 60〜200、氷水なら 0',
          value: s.tempC ?? 0,
          onChange: (v) => edit(s, 'tempC', () => (s.tempC = v)),
        }).root,
      );
    }
    if (s.role === 'load') {
      const f = s.force ?? { fx: 0, fy: 0 };
      card.append(
        h(
          'div',
          { class: 'row2' },
          numField({ label: '力 x（右が＋）', unit: 'N', value: f.fx, onChange: (v) => edit(s, 'fx', () => (s.force = { fx: v, fy: s.force?.fy ?? 0 })) }).root,
          numField({
            label: '力 y（上が＋）',
            unit: 'N',
            hint: '下向きは −',
            value: f.fy,
            onChange: (v) => edit(s, 'fy', () => (s.force = { fx: s.force?.fx ?? 0, fy: v })),
          }).root,
        ),
        h('p', { class: 'hint' }, '荷重は、重なった物体の範囲に合計の力を均等にかけます。1 kgf ≒ 9.8 N'),
      );
    }

    // 寸法
    card.append(h('h4', null, '位置と大きさ（mm）'));
    const addGeom = (label: string, get: (g: ShapeGeom) => number, set: (g: ShapeGeom, v: number) => void, min?: number): HTMLElement => {
      const field = numField({
        label,
        unit: 'mm',
        value: get(s.geom) * MM,
        min,
        digits: 2,
        onChange: (v) => edit(s, `g:${label}`, () => set(s.geom, v / MM)),
      });
      geomFields.push({ field, get });
      return field.root;
    };
    const g = s.geom;
    if (g.kind === 'rect') {
      card.append(
        h(
          'div',
          { class: 'row2' },
          addGeom('左下 x', (q) => (q.kind === 'rect' ? q.x : 0), (q, v) => q.kind === 'rect' && (q.x = v)),
          addGeom('左下 y', (q) => (q.kind === 'rect' ? q.y : 0), (q, v) => q.kind === 'rect' && (q.y = v)),
          addGeom('幅 w', (q) => (q.kind === 'rect' ? q.w : 0), (q, v) => q.kind === 'rect' && (q.w = v), 0.01),
          addGeom('高さ h', (q) => (q.kind === 'rect' ? q.h : 0), (q, v) => q.kind === 'rect' && (q.h = v), 0.01),
        ),
      );
    } else if (g.kind === 'circle') {
      card.append(
        h(
          'div',
          { class: 'row2' },
          addGeom('中心 x', (q) => (q.kind === 'circle' ? q.cx : 0), (q, v) => q.kind === 'circle' && (q.cx = v)),
          addGeom('中心 y', (q) => (q.kind === 'circle' ? q.cy : 0), (q, v) => q.kind === 'circle' && (q.cy = v)),
          addGeom('半径 r', (q) => (q.kind === 'circle' ? q.r : 0), (q, v) => q.kind === 'circle' && (q.r = v), 0.01),
        ),
      );
    } else {
      // 多角形: 外接の長方形の左下を動かせる（頂点の形はキャンバス上の白い点で編集する）
      const moveTo = (axis: 0 | 1) => (q: ShapeGeom, v: number) => {
        const b = geomBBox(q);
        const next = translateGeom(q, axis === 0 ? v - b.x0 : 0, axis === 1 ? v - b.y0 : 0);
        s.geom = next;
      };
      card.append(
        h(
          'div',
          { class: 'row2' },
          addGeom('左端 x', (q) => geomBBox(q).x0, moveTo(0)),
          addGeom('下端 y', (q) => geomBBox(q).y0, moveTo(1)),
        ),
        h(
          'p',
          { class: 'hint' },
          `頂点 ${g.points.length} 個 ・ 外形 ${((geomBBox(g).x1 - geomBBox(g).x0) * MM).toFixed(1)} × ${((geomBBox(g).y1 - geomBBox(g).y0) * MM).toFixed(1)} mm。形はキャンバス上の白い点をドラッグして整えます`,
        ),
      );
    }

    const idx = store.project.shapes.indexOf(s);
    card.append(
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', title: '先に適用される（下に敷かれる）', disabled: idx <= 0, onclick: () => { store.moveShape(s.id, -1); build(); } }, '後ろへ'),
        h('button', { class: 'btn', type: 'button', title: '後に適用される（上書きする）', disabled: idx >= store.project.shapes.length - 1, onclick: () => { store.moveShape(s.id, 1); build(); } }, '前へ'),
      ),
      h('p', { class: 'hint' }, '重ね順: 後ろにある図形から順に適用され、前の図形が上書きします。穴は削りたい物体より「前」に置きます。'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', onclick: () => store.duplicateShape(s.id) }, '複製'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => store.deleteShape(s.id) }, 'この図形を削除'),
      ),
    );
    host.append(card);
  }

  // 値だけ更新（キャンバスでの移動・変形に追従する。入力中の欄は触らない）
  function refreshGeom(): void {
    const s = store.getShape(store.selectedId);
    if (!s) return;
    for (const { field, get } of geomFields) field.set(get(s.geom) * MM);
  }

  store.on('selection', build);
  store.on('load', build);
  store.on('project', (src) => {
    if (src === 'canvas') {
      // 図形が増減した可能性（追加・削除）は selection 側で再構築される。ここでは値の追従のみ
      refreshGeom();
    }
  });
  build();
}
