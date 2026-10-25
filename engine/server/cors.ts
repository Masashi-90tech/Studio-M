// 接続元の確認（CORS と Host）。エンジンは 127.0.0.1 だけで待ち受け、許す接続元もこの PC のページだけにする。

/**
 * 許す Origin:
 *  - 'null'（file:// で開いたダウンロード版の HTML）
 *  - http://localhost[:port] / http://127.0.0.1[:port] / http://[::1][:port]（開発サーバーなど）
 * claude.ai の Artifact などの別サイトは、ブラウザの制限でそもそも届かないが、念のため許さない。
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === 'null') return true;
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(origin);
}

/** Host ヘッダー（DNS リバインディング対策）。この PC の名前で、待ち受けているポートのときだけ通す */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** 許可した接続元に返す CORS ヘッダー */
export function corsHeaders(opts: { origin: string | undefined; privateNetwork?: boolean }): Record<string, string> {
  if (!opts.origin) return {};
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': opts.origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'Access-Control-Max-Age': '600',
  };
  // https のページからローカルへの要求（Private Network Access）の事前確認
  if (opts.privateNetwork) headers['Access-Control-Allow-Private-Network'] = 'true';
  return headers;
}
