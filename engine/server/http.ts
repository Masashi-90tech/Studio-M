// HTTP の入口。127.0.0.1 だけで待ち受け、合言葉・接続元・本文を検査してから処理する。
//   GET  /status[?refresh=1]     POST /jobs     GET /jobs/:id     POST /jobs/:id/cancel     GET /jobs/:id/files/:name
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import { ENGINE_PROTOCOL_VERSION, type EngineCapability, type EngineStatus } from '../../src/core/engine-protocol';
import type { EngineStatusResponse } from '../../src/core/engine-wire';
import { extractBearer, tokenMatches } from './auth';
import { corsHeaders, isAllowedHost, isAllowedOrigin } from './cors';
import { isJobId, JobManager, QueueFullError } from './jobs';
import { checkJobRequest } from './validate';
import { ENGINE_SERVER_ID, ENGINE_VERSION } from './version';

export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface HttpDeps {
  token: string;
  jobs: JobManager;
  /** 検出結果の EngineStatus。refresh が true なら検出をやり直す */
  getStatus(refresh: boolean): Promise<EngineStatus>;
  maxBodyBytes?: number;
}

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.vtk': 'text/plain; charset=utf-8',
  '.vtu': 'application/xml',
  '.inp': 'text/plain; charset=utf-8',
  '.frd': 'text/plain; charset=utf-8',
  '.dat': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, `送られたデータが大きすぎます（上限 ${Math.round(limit / 1024 / 1024)} MB）。格子を粗くしてみてください`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `送られたデータが大きすぎます（上限 ${Math.round(limit / 1024 / 1024)} MB）。格子を粗くしてみてください`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function publicStatus(): EngineStatusResponse {
  return { server: ENGINE_SERVER_ID, protocol: ENGINE_PROTOCOL_VERSION, version: ENGINE_VERSION, engines: [], capabilities: [], maxConcurrentJobs: 0, authorized: false };
}

export function createEngineServer(deps: HttpDeps): Server {
  const limit = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) send(res, e.status, JSON.stringify({ error: e.message }), headersFor(req));
      else {
        console.error('[engine] 内部エラー', e);
        send(res, 500, JSON.stringify({ error: 'エンジンの内部でエラーが起きました。エンジンを起動した画面のログを確認してください' }), headersFor(req));
      }
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;

  const headersFor = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    return origin && isAllowedOrigin(origin) ? corsHeaders({ origin }) : {};
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as { port: number } | null)?.port ?? 0;
    const origin = req.headers.origin;
    if (!isAllowedHost(req.headers.host, port)) throw new HttpError(403, 'この名前ではエンジンに接続できません。http://127.0.0.1:<ポート> を使ってください');
    if (origin !== undefined && !isAllowedOrigin(origin)) throw new HttpError(403, 'このページからの接続は許可されていません（この PC で開いた Studio M だけが使えます）');
    const cors = headersFor(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      const pna = req.headers['access-control-request-private-network'] === 'true';
      res.writeHead(204, origin ? corsHeaders({ origin, privateNetwork: pna }) : {});
      res.end();
      return;
    }

    const authorized = tokenMatches(extractBearer(req.headers.authorization), deps.token);

    if (path === '/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'GET で呼んでください');
      if (!authorized) return send(res, 200, JSON.stringify(publicStatus()), cors);
      const status = await deps.getStatus(url.searchParams.get('refresh') === '1');
      const body: EngineStatusResponse = { ...status, authorized: true };
      return send(res, 200, JSON.stringify(body), cors);
    }

    if (!authorized) {
      throw new HttpError(401, '合言葉（トークン）が正しくありません。エンジンを起動したときに表示された合言葉を、Studio M の設定（⚙）に貼り付けてください');
    }

    if (path === '/jobs') {
      if (req.method !== 'POST') throw new HttpError(405, 'POST で呼んでください');
      return postJob(req, res, cors);
    }

    const m = /^\/jobs\/([^/]+)(?:\/(cancel)|\/files\/(.+))?$/.exec(path);
    if (!m) throw new HttpError(404, '知らない宛先です');
    const [, id, cancel, rawName] = m;
    if (!isJobId(id) || !deps.jobs.get(id)) throw new HttpError(404, 'その計算は見つかりません（エンジンを再起動したか、古い計算が片づけられた可能性があります）');

    if (cancel) {
      if (req.method !== 'POST') throw new HttpError(405, 'POST で呼んでください');
      deps.jobs.cancel(id);
      return send(res, 200, deps.jobs.wire(id) ?? '{}', cors);
    }
    if (rawName !== undefined) {
      if (req.method !== 'GET') throw new HttpError(405, 'GET で呼んでください');
      return sendFile(res, id, rawName, cors);
    }
    if (req.method !== 'GET') throw new HttpError(405, 'GET で呼んでください');
    return send(res, 200, deps.jobs.wire(id) ?? '{}', cors);
  }

  async function postJob(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type は application/json にしてください');
    const raw = await readBody(req, limit);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, '本文が JSON として読めません');
    }
    const status = await deps.getStatus(false);
    const checked = checkJobRequest(body, status.capabilities as EngineCapability[]);
    if (!checked.ok) throw new HttpError(400, checked.error);
    const info = status.engines.find((e) => e.id === checked.value.engine);
    if (!info?.available) throw new HttpError(409, `${info?.name ?? checked.value.engine} がこの PC で使えません。${info?.note ?? 'docs/ENGINE.md の手順で入れてください'}`);
    try {
      const id = deps.jobs.submit(checked.value);
      send(res, 201, JSON.stringify({ id }), cors);
    } catch (e) {
      if (e instanceof QueueFullError) throw new HttpError(429, e.message);
      throw e;
    }
  }

  async function sendFile(res: ServerResponse, id: string, rawName: string, cors: Record<string, string>): Promise<void> {
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      throw new HttpError(400, 'ファイル名が正しくありません');
    }
    const file = await deps.jobs.resolveFile(id, name);
    if (!file) throw new HttpError(404, 'そのファイルはありません');
    const base = name.split('/').pop() ?? name;
    res.writeHead(200, {
      'Content-Type': MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(file.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(base)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...cors,
    });
    const stream = createReadStream(file.path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return server;
}
