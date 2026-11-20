// renderer → Engine の中継で許す要求の判定（純粋な関数。electron は import しない）。
// 許すのは次の 5 つだけ。内容の検証（ジョブの形など）は Engine 側に任せ、ここでは重ねて書かない。
//   GET /status（?refresh=1 だけ可）、POST /jobs、GET /jobs/:id、POST /jobs/:id/cancel、GET /jobs/:id/files/:name
import type { EngineRequest } from './api';

export type GuardResult = { ok: true; method: 'GET' | 'POST'; path: string; hasBody: boolean } | { ok: false; error: string };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const reject = (why: string): GuardResult => ({ ok: false, error: `この宛先は中継できません（${why}）` });

export function checkEngineRequest(req: unknown): GuardResult {
  if (typeof req !== 'object' || req === null) return reject('要求の形が正しくありません');
  const { method, path, body } = req as Partial<EngineRequest>;
  if (typeof method !== 'string' || typeof path !== 'string') return reject('要求の形が正しくありません');
  if (method !== 'GET' && method !== 'POST') return reject('許可されたメソッドではありません');
  if (path.length === 0 || path.length > 512 || !path.startsWith('/')) return reject('パスは / で始めてください');
  // 制御文字・バックスラッシュ・「//」（別ホストの指定になりうる）・「@」・「#」は使わない
  if (/[\u0000-\u001f\u007f\\@#]/.test(path) || path.includes('//')) return reject('使えない文字が含まれています');
  // パーセント表記で「.」「/」「\」「NUL」を隠す書き方は認めない
  if (/%(2e|2f|5c|00)/i.test(path)) return reject('エンコードされたパス記号は使えません');

  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = q < 0 ? '' : path.slice(q + 1);
  if (query !== '' && !(pathname === '/status' && query === 'refresh=1')) return reject('クエリは /status の refresh=1 だけ使えます');

  const segments = pathname.split('/').slice(1);
  if (segments.some((s) => s === '.' || s === '..')) return reject('「..」は使えません');

  let ok = false;
  let hasBody = false;
  if (pathname === '/status') ok = method === 'GET';
  else if (pathname === '/jobs') {
    ok = method === 'POST';
    hasBody = true;
  } else if (segments[0] === 'jobs' && segments.length >= 2 && ID_RE.test(segments[1])) {
    if (segments.length === 2) ok = method === 'GET';
    else if (segments.length === 3 && segments[2] === 'cancel') ok = method === 'POST';
    else if (segments.length >= 4 && segments[2] === 'files') {
      ok = method === 'GET' && segments.slice(3).every((s) => s.length > 0);
      if (ok) {
        try {
          // 日本語などのファイル名は通す。デコード後に「..」や区切りが現れないかも見る
          ok = decodeURIComponent(segments.slice(3).join('/')).split('/').every((s) => s !== '.' && s !== '..' && s.length > 0);
        } catch {
          ok = false;
        }
      }
    }
  }
  if (!ok) return reject('許可された宛先・メソッドの組み合わせではありません');
  if (body !== undefined && !hasBody) return reject('この宛先に本文は付けられません');
  if (method === 'POST' && pathname === '/jobs' && body === undefined) return reject('POST /jobs には本文が必要です');
  return { ok: true, method, path, hasBody };
}
