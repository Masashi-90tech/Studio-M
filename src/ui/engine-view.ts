// 結果ボックスの下の「本計算（PC のエンジン）」カード。
// 接続済みで、いまの解析を解けるエンジンがあるときだけ出る（解析の種類は見分けず、サーバーの capabilities を見る）。
import './engine.css';
import type { EngineCapability, JobFile } from '../core/engine-protocol';
import { clear, h } from './dom';
import { capabilitiesFor, compareScalars, engineInfo, engineName, formatBytes, formatDiffPct, JOB_STATUS_TEXT, QUALITY_CHOICES, STALE_MESSAGE } from './engine-logic';
import type { EngineSession, RemoteRun } from './engine-session';
import { formatNumber, formatQuantity } from './format';
import type { Runner } from './runner';
import type { Store } from './state';

export interface EngineView {
  update(): void;
}

export function mountEngineView(opts: { store: Store; runner: Runner; session: EngineSession; host: HTMLElement }): EngineView {
  const { store, runner, session, host } = opts;
  const body = h('div', { class: 'engine-body' });
  const card = h('section', { class: 'card engine-card', 'aria-label': '本計算（PCのエンジン）' }, h('h3', null, '本計算（PCのエンジン）'), body);
  host.append(card);
  host.hidden = true;

  let sig = '';
  let logOpen = false;
  let pickedEngine = '';

  function launch(caps: EngineCapability[], run: RemoteRun | undefined): HTMLElement {
    const status = session.status;
    const cap = caps.find((c) => c.engine === pickedEngine) ?? caps[0];
    pickedEngine = cap.engine;
    const info = engineInfo(status, cap.engine);
    const name = engineName(status, cap.engine);
    const root = h('div', { class: 'engine-launch' });

    if (caps.length > 1) {
      const sel = h('select', { 'aria-label': 'エンジン' }, ...caps.map((c) => h('option', { value: c.engine }, engineName(status, c.engine))));
      sel.value = cap.engine;
      sel.addEventListener('change', () => {
        pickedEngine = sel.value;
        render();
      });
      root.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'エンジン'), sel));
    }

    const quality = h('select', { 'aria-label': '計算の細かさ' }, ...QUALITY_CHOICES.map((q) => h('option', { value: q.value, title: q.hint }, q.label)));
    quality.value = session.quality;
    quality.addEventListener('change', () => {
      session.quality = quality.value as typeof session.quality;
      qualityHint.textContent = QUALITY_CHOICES.find((q) => q.value === session.quality)?.hint ?? '';
    });
    const qualityHint = h('span', { class: 'hint' }, QUALITY_CHOICES.find((q) => q.value === session.quality)?.hint ?? '');
    root.append(h('label', { class: 'field' }, h('span', { class: 'field-label' }, '計算の細かさ'), quality, qualityHint));

    // プロモード: そのエンジンのオプション
    if (store.mode === 'pro' && cap.options && cap.options.length > 0) {
      const values = session.options(cap);
      const box = h('div', { class: 'engine-options' }, h('div', { class: 'field-label' }, `${name} のオプション`));
      for (const spec of cap.options) {
        let control: HTMLElement;
        if (spec.kind === 'boolean') {
          const input = h('input', { type: 'checkbox', checked: values[spec.key] === true });
          input.addEventListener('change', () => (values[spec.key] = input.checked));
          control = h('label', { class: 'inline toggle' }, input, h('span', null, spec.label));
        } else if (spec.kind === 'select') {
          const sel = h('select', { 'aria-label': spec.label }, ...(spec.choices ?? []).map((c) => h('option', { value: c.value }, c.label)));
          sel.value = String(values[spec.key]);
          sel.addEventListener('change', () => (values[spec.key] = sel.value));
          control = h('label', { class: 'field' }, h('span', { class: 'field-label' }, spec.label), sel);
        } else {
          const input = h('input', { type: 'number', step: 'any', value: String(values[spec.key]), 'aria-label': spec.label });
          input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            if (Number.isFinite(v)) values[spec.key] = v;
          });
          control = h('label', { class: 'field' }, h('span', { class: 'field-label' }, spec.label, spec.unit ? h('span', { class: 'unit' }, ` [${spec.unit}]`) : null), input);
        }
        box.append(control);
        if (spec.hint) box.append(h('span', { class: 'hint' }, spec.hint));
      }
      root.append(box);
    }

    const available = info?.available === true;
    const btn = h(
      'button',
      { class: 'btn primary engine-solve', type: 'button', disabled: !available || !!(run && (run.phase === 'submitting' || run.phase === 'active')), onclick: () => void session.start(cap) },
      run?.phase === 'done' ? `もう一度本計算する（${name}）` : `本計算で解く（${name}）`,
    );
    root.append(btn);
    if (!available) root.append(h('p', { class: 'notice warn' }, `${name} はこの PC で見つかりません。${info?.note ?? 'docs/ENGINE.md の手順で入れてください'}`));
    else root.append(h('span', { class: 'hint' }, cap.label + (info?.version ? `（${name} ${info.version}${info.via === 'docker' ? '・Docker' : ''}）` : '')));
    return root;
  }

  function progress(run: RemoteRun): HTMLElement {
    const job = run.job;
    const frac = run.phase === 'submitting' ? 0 : Math.min(1, Math.max(0, job?.progress ?? 0));
    const statusText = run.cancelling ? '中止しています' : run.phase === 'submitting' ? 'エンジンに送っています' : JOB_STATUS_TEXT[job?.status ?? 'queued'];
    const bar = h('div', { class: 'progress-bar', style: `width:${Math.round(frac * 100)}%` });
    const root = h(
      'div',
      { class: 'engine-run' },
      h('div', { class: 'status-row' }, h('span', { class: 'badge run' }, statusText), h('span', { class: 'status-text' }, `${run.engineName} ・ ${Math.round(frac * 100)}%`)),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(frac * 100)) }, bar),
      h('div', { class: 'status-msg hint' }, job?.message ?? ''),
    );
    if (run.rev !== runner.revision) root.append(h('p', { class: 'notice warn' }, `${STALE_MESSAGE}（この計算が終わっても、結果は使えません。中止してやり直すこともできます）`));
    root.append(
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', disabled: run.cancelling || run.phase === 'submitting', onclick: () => void session.cancel(run.kind) }, '中止')),
      logBox(run),
    );
    return root;
  }

  function logBox(run: RemoteRun): HTMLElement {
    const lines = run.job?.log ?? [];
    const pre = h('pre', { class: 'engine-log', tabindex: '0', 'aria-label': 'ソルバーの出力' }, lines.slice(-200).join('\n') || '（まだ出力はありません）');
    const details = h('details', { class: 'engine-log-box' }, h('summary', null, `ログ（最後の ${Math.min(lines.length, 200)} 行）`), pre);
    details.open = logOpen;
    details.addEventListener('toggle', () => (logOpen = details.open));
    requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
    return details;
  }

  function files(run: RemoteRun): HTMLElement | null {
    if (run.files.length === 0) return null;
    const row = (f: JobFile): HTMLElement =>
      h('li', null, h('button', { class: 'link-btn', type: 'button', onclick: () => void session.downloadFile(run.kind, f.name) }, f.name), h('span', { class: 'hint' }, ` ${f.description}（${formatBytes(f.size)}）`));
    return h('details', { class: 'engine-files' }, h('summary', null, `計算に使ったファイル（${run.files.length}）`), h('ul', null, ...run.files.map(row)), h('p', { class: 'hint' }, 'ParaView などで開いて、くわしく確かめられます。'));
  }

  function done(run: RemoteRun): HTMLElement {
    const remote = runner.currentRemote();
    const root = h('div', { class: 'engine-done' });
    if (!remote) {
      // 形や条件が変わって、結果が古くなった
      root.append(h('p', { class: 'notice warn', role: 'status' }, STALE_MESSAGE));
      return root;
    }
    const viewing = runner.viewingRemote;
    const seg = h(
      'div',
      { class: 'seg engine-toggle', role: 'group', 'aria-label': '表示する結果' },
      h('button', { class: `seg-btn${viewing ? '' : ' active'}`, type: 'button', 'aria-pressed': String(!viewing), onclick: () => runner.showRemote(false) }, 'Lite'),
      h('button', { class: `seg-btn${viewing ? ' active' : ''}`, type: 'button', 'aria-pressed': String(viewing), onclick: () => runner.showRemote(true) }, '本計算'),
    );
    root.append(h('div', { class: 'engine-toggle-row' }, seg, h('span', { class: 'hint' }, viewing ? `${remote.label} の結果を表示中` : 'Lite（ブラウザの中の計算）を表示中')));
    const rows = compareScalars(runner.liteResult, remote.result);
    if (rows.length > 0) {
      root.append(
        h(
          'table',
          { class: 'engine-table' },
          h('caption', null, 'Lite と本計算の比較'),
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, '項目'), h('th', { scope: 'col' }, 'Lite'), h('th', { scope: 'col' }, '本計算'), h('th', { scope: 'col' }, '差'))),
          h(
            'tbody',
            null,
            ...rows.map((r) =>
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, r.label),
                h('td', null, formatQuantity(r.lite, r.unit)),
                h('td', null, formatQuantity(r.remote, r.unit)),
                h('td', { class: Math.abs(r.diffPct ?? 0) >= 10 ? 'diff big' : 'diff' }, formatDiffPct(r.diffPct)),
              ),
            ),
          ),
        ),
      );
    } else {
      root.append(h('p', { class: 'hint' }, '比べられる共通の代表値はありません。上の切り替えで、結果の図を見比べてください。'));
    }
    const elapsed = run.job?.finishedAt && run.job.startedAt ? (run.job.finishedAt - run.job.startedAt) / 1000 : null;
    if (elapsed !== null) root.append(h('p', { class: 'hint' }, `計算時間 ${formatNumber(elapsed, 3)} 秒`));
    const f = files(run);
    if (f) root.append(f);
    return root;
  }

  function render(): void {
    clear(body);
    const kind = runner.analysis;
    const caps = capabilitiesFor(session.status, kind);
    const run = session.runFor(kind);
    const conn = session.conn;

    if (conn.kind === 'error') {
      body.append(
        h('p', { class: 'notice error', role: 'alert' }, conn.message),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn small', type: 'button', onclick: () => void session.connect() }, '再接続'), h('span', { class: 'hint' }, '設定（⚙）の「PCのエンジン」で URL と合言葉を確かめられます')),
      );
      return;
    }
    if (caps.length === 0) return;

    if (run && (run.phase === 'submitting' || run.phase === 'active')) {
      body.append(progress(run));
      return;
    }
    if (run?.phase === 'failed') body.append(h('p', { class: 'notice error', role: 'alert' }, run.error ?? '計算に失敗しました'), logBox(run));
    if (run?.phase === 'cancelled') body.append(h('p', { class: 'hint' }, '中止しました。'));
    if (run?.phase === 'done') body.append(done(run));
    else if (runner.remote.isStale(kind, runner.revision)) body.append(h('p', { class: 'notice warn', role: 'status' }, STALE_MESSAGE));
    body.append(launch(caps, run));
  }

  function update(): void {
    const kind = runner.analysis;
    const run = session.runFor(kind);
    const caps = capabilitiesFor(session.status, kind);
    const visible = session.conn.kind === 'error' || (session.conn.kind === 'ok' && caps.length > 0);
    host.hidden = !visible;
    const next = [session.version, kind, store.mode, runner.revision, runner.viewingRemote, run?.phase, run?.job?.progress, run?.job?.log.length].join('|');
    if (next === sig) return;
    sig = next;
    if (visible) render();
  }

  session.subscribe(() => {
    sig = '';
  });
  return { update };
}
