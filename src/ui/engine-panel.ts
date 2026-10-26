// 設定（⚙）の「PCのエンジン」: URL と合言葉を入れて接続を確かめ、見つかったエンジンを一覧する。
import './engine.css';
import { clear, h } from './dom';
import { DEFAULT_ENGINE_URL, inArtifactViewer, normalizeEngineUrl } from './engine-config';
import type { EngineSession } from './engine-session';

export function mountEnginePanel(opts: { session: EngineSession; container: HTMLElement }): void {
  const { session, container } = opts;

  const url = h('input', { type: 'text', id: 'engineUrl', spellcheck: 'false', autocomplete: 'off', placeholder: DEFAULT_ENGINE_URL, 'aria-label': 'エンジンの URL' });
  url.value = session.config.url;
  const token = h('input', { type: 'password', id: 'engineToken', spellcheck: 'false', autocomplete: 'off', placeholder: 'エンジンの画面に出た合言葉を貼り付け', 'aria-label': '合言葉' });
  token.value = session.config.token;
  const urlError = h('p', { class: 'notice error', role: 'alert', hidden: true });
  const result = h('div', { class: 'engine-conn', 'aria-live': 'polite' });
  const connectBtn = h('button', { class: 'btn small primary', type: 'button' }, '接続を確認');
  const forgetBtn = h('button', { class: 'btn small', type: 'button', title: 'このブラウザに保存した URL と合言葉を消します' }, '合言葉を消す');

  const artifact = inArtifactViewer()
    ? h(
        'p',
        { class: 'notice warn' },
        'このページは claude.ai の公開ページ（Artifact）として開かれているため、PC のエンジンには接続できません。ダウンロードした HTML（dist/index.html）か、開発版（npm run dev）で開いてください。',
      )
    : null;

  async function connect(): Promise<void> {
    const normalized = normalizeEngineUrl(url.value);
    urlError.hidden = normalized !== null;
    if (normalized === null) {
      urlError.textContent = 'URL を読めません。http://127.0.0.1:47800 のように入力してください。';
      return;
    }
    url.value = normalized;
    session.setConfig({ url: normalized, token: token.value });
    connectBtn.disabled = true;
    await session.connect({ refresh: true });
    connectBtn.disabled = false;
  }

  connectBtn.addEventListener('click', () => void connect());
  for (const el of [url, token]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void connect();
    });
  }
  forgetBtn.addEventListener('click', () => {
    token.value = '';
    url.value = DEFAULT_ENGINE_URL;
    session.setConfig({ url: DEFAULT_ENGINE_URL, token: '' });
  });

  function renderConn(): void {
    clear(result);
    const c = session.conn;
    if (c.kind === 'none') return;
    if (c.kind === 'checking') {
      result.append(h('p', { class: 'hint' }, '確認しています…'));
      return;
    }
    if (c.kind === 'error') {
      result.append(h('p', { class: 'notice error', role: 'alert' }, c.message));
      return;
    }
    const s = c.status;
    result.append(h('p', { class: 'engine-ok' }, `✓ 接続しました（Studio M Engine ${s.version}）`));
    const list = h('ul', { class: 'engine-list' });
    for (const e of s.engines) {
      const note = e.note ?? '見つかりません';
      const body = h('span', null, h('strong', null, e.name));
      if (e.available) {
        body.append(` ${[e.version ?? '', e.via === 'docker' ? 'Docker' : 'PC に直接'].filter(Boolean).join(' ・ ')}`);
      } else if (note.length <= 40) {
        body.append(` — ${note}`);
      } else {
        // 入れ方の説明は長いので、開いたときだけ全部見せる
        body.append(' — 見つかりません', h('details', { class: 'engine-note' }, h('summary', null, '入れ方を見る'), h('p', null, note)));
      }
      list.append(h('li', { class: e.available ? 'ok' : 'ng' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, e.available ? '✓' : '✗'), body));
    }
    result.append(list);
    if (s.capabilities.length === 0) result.append(h('p', { class: 'hint' }, 'このエンジンには、解析のアダプターが組み込まれていません。'));
  }

  container.append(
    h('div', { class: 'pop-title engine-title' }, 'PCのエンジン（本計算）'),
    h('p', { class: 'pop-hint engine-lead' }, 'この PC で動く Studio M Engine につなぐと、CalculiX（強度）や OpenFOAM（流れ）で本計算できます。ダウンロードした HTML か開発版でだけ使えます。'),
    ...(artifact ? [artifact] : []),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'URL'), url),
    urlError,
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '合言葉'), token, h('span', { class: 'hint' }, 'エンジンを起動したときに画面に出る文字列です。このブラウザにだけ保存されます。')),
    h('div', { class: 'btn-row' }, connectBtn, forgetBtn),
    result,
    h('p', { class: 'pop-hint engine-lead' }, 'エンジンは `npm run engine` で起動します。入れ方は docs/ENGINE.md を見てください。'),
  );
  session.subscribe(renderConn);
  renderConn();
}
