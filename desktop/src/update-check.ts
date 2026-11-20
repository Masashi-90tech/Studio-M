// 新しい版の確認（electron は import しない純粋な部分。テストできるよう分けてある）。
// 署名なしの Mac では自動更新ができないので、「新しい版を見つけて知らせ、ダウンロードページを開く」方式にする。
// 署名を取ったら、electron-updater による本物の自動更新へ移る（desktop/README.md）。

// releases/latest は使わない: Lite（v で始まるタグ）や ccx のリリースが「最新」になると、Pro の更新を見つけられないため。
// 一覧から pro-v のタグだけを選ぶ。
export const RELEASES_API = 'https://api.github.com/repos/Masashi-90tech/Studio-M/releases?per_page=30';
const TIMEOUT_MS = 8000;

export type UpdateResult = { latest: string; url: string } | { error: string } | null;

export interface CheckForUpdateOptions {
  /** 今の版（例: 0.6.0） */
  current: string;
  /** テスト用に差し替えられる */
  fetch?: typeof fetch;
}

/** 'pro-v0.7.1' → '0.7.1'。形が違えば null（ccx-v2.23 など、Studio M Pro 以外のタグは対象外） */
export function parseProTag(tag: string): string | null {
  const m = /^pro-v(\d+\.\d+\.\d+)$/.exec(tag);
  return m ? m[1] : null;
}

/** '1.2.3' を数字 3 つにする。形が違えば null */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a が b より新しければ正、同じなら 0、古ければ負。どちらかが X.Y.Z の形でなければ NaN */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** ダウンロードページとして開いてよい URL か（https://github.com/ で始まるものだけ） */
export function isSafeReleaseUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' && url.startsWith('https://github.com/');
  } catch {
    return false;
  }
}

/**
 * 最新の Release を調べる。新しければ { latest, url }、同じか古い（または Studio M Pro の Release ではない）なら null、
 * 失敗は { error }（日本語の理由）。GitHub には版以外の個人情報を送らない。
 */
export async function checkForUpdate(o: CheckForUpdateOptions): Promise<UpdateResult> {
  const doFetch = o.fetch ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(RELEASES_API, {
      headers: { 'User-Agent': 'Studio-M-Pro', Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { error: aborted ? '更新情報の取得に時間がかかりすぎました。ネットワークを確認して、もう一度試してください' : 'ネットワークに接続できず、更新情報を取得できませんでした。接続を確認して、もう一度試してください' };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return { error: '更新情報を取得できませんでした（公開されたリリースが見つかりません）。しばらくしてからもう一度試してください' };
  if (!res.ok) return { error: `更新情報を取得できませんでした（GitHub が HTTP ${res.status} を返しました）。しばらくしてからもう一度試してください` };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { error: '更新情報の形が正しくありません。しばらくしてからもう一度試してください' };
  }
  // 一覧（配列）が返る。1 件だけのオブジェクトも受け付ける（テストと将来の API の変更のため）
  const items = (Array.isArray(json) ? json : [json]) as unknown[];
  if (items.length === 0 || items.some((x) => typeof x !== 'object' || x === null)) return { error: '更新情報の形が正しくありません。しばらくしてからもう一度試してください' };
  if (items.every((x) => typeof (x as { tag_name?: unknown }).tag_name !== 'string')) return { error: '更新情報の形が正しくありません。しばらくしてからもう一度試してください' };
  // Pro のリリース（pro-vX.Y.Z）の中で最も新しいもの。下書き・先行版は除く
  let best: { latest: string; url: unknown } | null = null;
  for (const x of items as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown }[]) {
    if (typeof x.tag_name !== 'string' || x.draft === true || x.prerelease === true) continue;
    const v = parseProTag(x.tag_name);
    if (!v) continue; // Studio M Pro のリリースではない（Lite・ccx など）
    if (!best || compareSemver(v, best.latest) > 0) best = { latest: v, url: x.html_url };
  }
  if (!best) return null;
  const cmp = compareSemver(best.latest, o.current);
  if (Number.isNaN(cmp) || cmp <= 0) return null;
  if (!isSafeReleaseUrl(best.url)) return { error: '更新情報のダウンロード先が正しくありません。GitHub のリリースページを直接開いてください' };
  return { latest: best.latest, url: best.url };
}
