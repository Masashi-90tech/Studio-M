// ヘッダー: プロジェクト名、新規・プリセット・ファイル（開く・KiCad基板を開く・3Dモデルを開く・保存）・Excel 出力。
import { clear, downloadBlob, h, toast } from './dom';
import { attachMenu } from './menu';
import { openPreset } from './open-preset';
import { openMeshImport } from './mesh-open';
import { openKicadImport } from './pcb-open';
import { PRESETS } from './presets';
import { safeFileName, sanitizeProject } from './project-utils';
import type { Runner } from './runner';
import type { Store } from './state';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function initHeader(store: Store, runner: Runner): void {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const nameInput = $<HTMLInputElement>('projectName');
  const fileInput = $<HTMLInputElement>('fileInput');
  const presetBtn = $<HTMLButtonElement>('btnPreset');
  const presetMenu = $<HTMLElement>('presetMenu');

  // ---------- プロジェクト名 ----------
  nameInput.value = store.project.name;
  nameInput.addEventListener('input', () => {
    store.checkpoint('name', 1500);
    store.project.name = nameInput.value;
    store.touch('name');
  });
  store.on('load', () => (nameInput.value = store.project.name));
  store.on('project', (src) => {
    if (src !== 'name') nameInput.value = store.project.name;
  });

  // ---------- 新規 ----------
  $('btnNew').addEventListener('click', () => {
    store.newProject();
    toast('新しいプロジェクトを作りました（元に戻すボタンで前の内容に戻せます）');
  });

  // ---------- プリセット ----------
  clear(presetMenu);
  for (const p of PRESETS) {
    presetMenu.append(
      h(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          role: 'menuitem',
          onclick: () => openPreset({ store, presetId: p.id }),
        },
        h('strong', null, p.title),
        h('span', null, p.description),
      ),
    );
  }
  attachMenu({ button: presetBtn, menu: presetMenu });

  // ---------- ファイル（開く・KiCad基板を開く・3Dモデルを開く・保存） ----------
  attachMenu({ button: $('btnFile'), menu: $('fileMenu') });
  $('btnKicad').addEventListener('click', () => void openKicadImport({ store }));
  $('btnMesh').addEventListener('click', () => void openMeshImport({ store, runner }));

  // ---------- 保存 / 開く ----------
  $('btnSave').addEventListener('click', () => {
    const json = JSON.stringify(store.project, null, 2);
    downloadBlob(new Blob([json], { type: 'application/json' }), `${safeFileName(store.project.name)}.studiom.json`);
    toast('プロジェクトを保存しました');
  });
  $('btnOpen').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const project = sanitizeProject(JSON.parse(await file.text()));
      if (!project) throw new Error('Studio M のプロジェクトファイルではありません');
      store.loadProject(project);
      toast(`「${project.name}」を開きました`);
    } catch (e) {
      toast(`ファイルを開けませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  });

  // ---------- Excel 出力 ----------
  const run = async (btn: HTMLButtonElement, job: () => Promise<{ bytes: Uint8Array; file: string } | null>): Promise<void> => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '作成中…';
    try {
      const out = await job();
      if (out) {
        downloadBlob(new Blob([new Uint8Array(out.bytes)], { type: XLSX_MIME }), out.file);
        toast(`${out.file} を書き出しました`);
      }
    } catch (e) {
      toast(`Excel を作れませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  const btnExcel = $<HTMLButtonElement>('btnExcel');
  btnExcel.addEventListener('click', () =>
    run(btnExcel, async () => {
      const results = runner.collectResults();
      if (results.length === 0) {
        toast('まだ結果がありません。計算が始まってからもう一度押してください', 'error');
        return null;
      }
      const { exportResultsWorkbook } = await import('../export/excel');
      const bytes = await exportResultsWorkbook(store.project, results);
      return { bytes, file: `${safeFileName(store.project.name)}_結果.xlsx` };
    }),
  );

  const btnFormula = $<HTMLButtonElement>('btnFormula');
  btnFormula.addEventListener('click', () =>
    run(btnFormula, async () => {
      // 数式ブックはセル数が多いと重くなるため、格子を粗くした複製で作る
      const { project, raster } = runner.formulaInput();
      const { exportFormulaWorkbook } = await import('../export/excel');
      const bytes = await exportFormulaWorkbook(project, raster);
      return { bytes, file: `${safeFileName(store.project.name)}_数式.xlsx` };
    }),
  );
}
