// build/parts/ の各 JSON を 1 つにまとめ、results/<名前>.json と .md（docs/EXPERIMENT-4.md の「結果」に貼れる表）を出す。
//   node summarize.mjs --parts <build/parts> --out <results> --name <ホスト名-日時>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname, totalmem, release } from 'node:os';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.parts || !args.out || !args.name) {
  console.error('使い方: node summarize.mjs --parts <フォルダー> --out <フォルダー> --name <名前>');
  process.exit(2);
}
const readPart = (n) => {
  const p = join(args.parts, n);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { error: `${n} を読めません` }; }
};

const data = {
  host: { name: hostname(), os: `${process.platform} ${release()}`, arch: process.arch, cpu: cpus()[0]?.model ?? '', cores: cpus().length, memory_gb: Math.round(totalmem() / 2 ** 30), node: process.version },
  generated_at: new Date().toISOString(),
  steps: readPart('steps.json') ?? {},
  install_paths: readPart('install-paths.json'),
  bundle: readPart('bundle.json'),
  pipeline: { normal: readPart('pipeline-normal.json'), japanese: readPart('pipeline-japanese.json') },
  app: readPart('app.json'),
};

// ---------- Markdown ----------
const mb = (kb) => (kb === undefined || kb === null ? '—' : kb >= 1024 * 100 ? `${(kb / 1024 / 1024).toFixed(2)} GB` : `${(kb / 1024).toFixed(0)} MB`);
const sec = (s) => (s === undefined || s === null ? '—' : `${Number(s).toFixed(1)} s`);
const ms = (v) => (v === undefined || v === null ? '—' : `${(v / 1000).toFixed(2)} s`);
const pct = (v) => (v === undefined || v === null ? '—' : `${(v * 100).toFixed(2)}%`);
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const md = [];
md.push(`## 実証実験 4 の測定結果（${data.host.name}、${data.generated_at.slice(0, 10)}）`, '');
md.push(`- 環境: ${data.host.os} / ${data.host.arch} / ${data.host.cpu} / ${data.host.cores} コア / メモリ ${data.host.memory_gb} GB / Node ${data.host.node}`);
if (data.install_paths) md.push(`- 導入経路の測定: ${data.install_paths.install_mode === 'install' ? '`--install` で入れて測った' : '入っているものを検出しただけ（何も入れていない）'}`);
const failed = Object.entries(data.steps).filter(([, v]) => v !== 'ok');
if (failed.length) md.push(`- **失敗した段**: ${failed.map(([k, v]) => `${k}（${v}）`).join('、')}`);
md.push('');

// 1. 導入経路
const ip = data.install_paths;
if (ip) {
  md.push('### 1. 導入経路', '');
  const names = {
    calculix_brew_tap: 'CalculiX: brew（costerwi の tap）',
    calculix_path: 'CalculiX: PATH 上の ccx',
    openfoam_brew: 'OpenFOAM: brew（gerlero/openfoam@2606）',
    openfoam_app: 'OpenFOAM: /Applications の OpenFOAM.app',
    openfoam_docker: 'OpenFOAM: Docker（opencfd/openfoam-default:2406）',
  };
  const rows = Object.entries(names).map(([k, label]) => {
    const e = ip[k] ?? {};
    const disk = e.keg_kb !== undefined ? `${mb(e.keg_kb)}（依存 ${mb(e.deps_kb)}）` : e.app_kb !== undefined ? mb(e.app_kb) : e.image_kb !== undefined ? mb(e.image_kb) : e.binary_kb !== undefined ? mb(e.binary_kb) : '—';
    let smoke = '—';
    if (e.smoke) {
      smoke = e.smoke.ok ? `通った（${sec(e.smoke.seconds)}${e.smoke.rel_error !== undefined ? `、梁の理論値との差 ${pct(e.smoke.rel_error)}` : ''}${e.smoke.style ? `、${e.smoke.style}` : ''}）` : `**通らない**（${esc(e.smoke.note)}）`;
    }
    return [label, e.detected ? '入っている' : '入っていない', esc(String(e.version ?? '—').trim()), disk, e.install_seconds !== undefined ? sec(e.install_seconds) : '—', smoke, esc(e.note ?? '')];
  });
  md.push(table(['経路', '状態', '版', 'ディスク', '導入の時間', '小さな計算', '備考'], rows), '');
  const eng = ip.engine_detection;
  if (eng?.engines) {
    md.push('既存の Studio M Engine の検出結果（`EngineStatus.engines`）:', '');
    md.push(table(['エンジン', '使える', '経路', '備考'], eng.engines.map((x) => [esc(x.id), x.available ? 'はい' : 'いいえ', esc(x.via ?? '—'), esc(x.note ?? '')])), '');
  } else if (eng?.note) md.push(`既存の Studio M Engine の検出: 測れませんでした（${esc(eng.note)}）`, '');
}

// 2. 同梱物のサイズ
const b = data.bundle;
if (b) {
  md.push('### 2. 同梱物のサイズ（build/payload）', '');
  if (/試走用/.test(b.python_source ?? '')) md.push(`> ${esc(b.python_source)}`, '');
  const labels = [
    ['python_runtime', 'Python 本体'], ['shape_site_packages', '形状ワーカーの site-packages（OCP + vtk + numpy など）'],
    ['ocp_packages', '  うち OCP（cadquery-ocp）'], ['vtk_packages', '  うち vtk'],
    ['shape_site_packages_novtk', '形状ワーカー: vtk なしの変種（参考。別フォルダー）'],
    ['mesh_site_packages', 'メッシュワーカーの site-packages（gmsh.py + numpy）'], ['gmsh_lib', '  Gmsh の共有ライブラリ'],
    ['ccx_bin', 'CalculiX の実行ファイル'], ['ccx_lib', 'CalculiX の共有ライブラリ'], ['payload_total', '**同梱物の合計**'],
  ];
  md.push(table(['部品', '削除前', '削除後（不要物を消した）'], labels.map(([k, l]) => [l, mb(b.sizes_kb?.before?.[k]), mb(b.sizes_kb?.after?.[k])])), '');
  const ex = data.app?.sizes_kb;
  if (ex && !data.app?.skipped) {
    md.push('Electron を含めた `.app`:', '');
    md.push(table(['項目', 'サイズ'], [
      ['.app の合計', mb(ex.app_total)], ['Electron 本体（Frameworks）', mb(ex.electron_frameworks)], ['同梱物（Resources/payload）', mb(ex.resources_payload)],
      ['  Python', mb(ex.payload_python)], ['  形状ワーカー', mb(ex.payload_shape_worker)], ['  メッシュワーカー', mb(ex.payload_mesh_worker)], ['  CalculiX', mb(ex.payload_calculix)],
      ['エンジン（Resources/dist-engine）', mb(ex.resources_dist_engine)], ['zip（ditto）', mb(ex.zip)], ['dmg', mb(ex.dmg)],
    ]), '');
  }
  md.push('形状ワーカーの確認（`import OCP` と STEP の読み書き）:', '');
  const v = b.variants ?? {};
  md.push(table(['変種', '結果', 'import OCP', '備考'], [
    [b.shape_package === 'cadquery-ocp-novtk' ? 'vtk なし（本体。cadquery-ocp-novtk）' : 'vtk あり（標準）', v.with_vtk?.ok ? '通った' : '**通らない**', sec(v.with_vtk?.result?.seconds?.import_ocp), esc(v.with_vtk?.note ?? '')],
    ['vtk なし（cadquery-ocp-novtk）', v.without_vtk ? (v.without_vtk.ok ? '通った' : '**通らない**') : '作っていない', sec(v.without_vtk?.result?.seconds?.import_ocp), esc(v.without_vtk?.note ?? '')],
  ]), '');
}

// 3. 一連の処理
const stagesTable = (runs) => table(['回', '形状', 'メッシュ', 'ccx', '合計', 'OCP import', '応力集中係数（積分点）', '文献 3.149 との差', '判定'],
  (runs ?? []).map((r) => [r.label === 'cold' ? '1 回目（コールド）' : `${runs.indexOf(r) + 1} 回目（ウォーム）`, ms(r.stages.shape_ms), ms(r.stages.mesh_ms), ms(r.stages.ccx_ms), ms(r.stages.total_ms),
    sec(r.shape?.seconds?.import_ocp), r.kt.kt_integration_point.toFixed(3), pct(r.kt.rel_error_integration_point), r.ok ? '3% 以内' : '**3% を超えた**']));
md.push('### 3. 一連の処理（STEP → 形状ワーカー → Gmsh → CalculiX）', '');
for (const [k, label] of [['normal', '通常のパス'], ['japanese', '日本語と空白を含むパス（Mac では下の 4 章が本番）']]) {
  const p = data.pipeline[k];
  if (!p) { md.push(`${label}: 測っていません`, ''); continue; }
  if (!p.runs) { md.push(`${label}: 失敗しました`, ''); continue; }
  md.push(`**${label}**`, '', stagesTable(p.runs), '');
  const r0 = p.runs[0];
  md.push(`（メッシュ: 四面体 ${r0.mesh.tets}、節点 ${r0.mesh.nodes}、最大寸法 ${r0.mesh.size_mm} mm。節点値の応力集中係数は ${r0.kt.kt_node.toFixed(3)}（外挿のため高めに出る）。作業フォルダー: \`${r0.workDir}\`）`, '');
}
const a = data.pipeline.normal?.runs, j = data.pipeline.japanese?.runs;
if (a && j) {
  const same = Math.abs(a[a.length - 1].kt.kt_integration_point - j[j.length - 1].kt.kt_integration_point) < 1e-6;
  md.push(`日本語・空白を含むパスと通常のパスで、応力集中係数は${same ? '一致した' : '**一致しなかった**'}。`, '');
}

// 4. Electron
md.push('### 4. Electron アプリ（desktop-probe）', '');
const app = data.app;
if (!app) md.push('測っていません。', '');
else if (app.skipped) md.push(`飛ばしました: ${esc(app.reason)}`, '');
else {
  md.push(`Electron ${esc(app.electron_version)}、署名: ${esc(app.codesign)}`, '');
  for (const [k, label] of [['build_dir', 'ビルドした場所'], ['japanese_path', '`~/Studio M テスト/`（日本語と空白）']]) {
    const sc = app.scenarios?.[k];
    if (!sc) continue;
    const rows = Object.entries(sc).map(([n, l]) => {
      const r = l.report;
      const first = r?.pipeline?.[0];
      return [n.replace('launch', '起動 ') + `（${l.label === 'cold' ? 'コールド' : 'ウォーム'}）`, sec(l.wall_seconds), r ? ms(r.marks?.app_ready) : '—', r ? ms(r.marks?.did_finish_load) : '—', ms(r?.engine?.startup_ms),
        first ? ms(first.stages.shape_ms) : '—', first ? ms(first.stages.mesh_ms) : '—', first ? ms(first.stages.ccx_ms) : '—', first ? (first.ok ? `${first.kt.kt_integration_point.toFixed(3)}（${pct(first.kt.rel_error_integration_point)}）` : '**ずれた**') : esc(l.note ?? '失敗')];
    });
    md.push(`**${label}**`, '', table(['起動', '全体', 'app ready', '画面表示', 'エンジン応答まで', '形状', 'メッシュ', 'ccx', '応力集中係数（差）'], rows), '');
  }
  if (app.quarantine) md.push('quarantine 付き・署名なしのアプリの `spctl -a -vv`:', '', '```', app.quarantine.spctl, '```', '');
}

// 5. 合格の目安
md.push('### 5. 合格の目安（docs/EXPERIMENT-4.md）', '');
const okAll = (p) => p?.runs?.length > 0 && p.runs.every((r) => r.ok);
const appOk = !app || app.skipped ? null : Object.values(app.scenarios?.japanese_path ?? {}).every((l) => l.report?.pipeline?.every((r) => r.ok));
md.push(table(['項目', '結果'], [
  ['追加の導入なしで STEP → 形状 → Gmsh → CalculiX が通り、応力集中係数が 3.149 の 3% 以内（通常のパス）', okAll(data.pipeline.normal) ? '合格' : '**不合格または未測定**'],
  ['日本語と空白を含む作業フォルダーで同じ結果', okAll(data.pipeline.japanese) ? '合格（シンボリックリンク経由・作業フォルダー）' : '**不合格または未測定**'],
  ['Mac の .app を日本語・空白のパスに置いて同じ結果', appOk === null ? '未測定（Mac 以外）' : appOk ? '合格' : '**不合格**'],
  ['配布サイズと起動時間の記録', b && (data.pipeline.normal?.runs ?? []).length ? '記録した（上の表）' : '**未記録**'],
]), '');

mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, `${args.name}.json`), JSON.stringify(data, null, 2) + '\n');
writeFileSync(join(args.out, `${args.name}.md`), md.join('\n') + '\n');
console.log(`${join(args.out, args.name)}.json / .md を書きました`);
