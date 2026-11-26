// Studio M Pro（インストール版）の、アプリ内エンジンへの接続。DOM には触れない。
// Pro では画面のウィンドウに window.studioMPro が渡される。エンジンへの要求はそこを通って main に届き、
// 合言葉は main が付ける。ここでは IPC を fetch の形に包み、engine-client（fetch だけで動く）にそのまま渡せるようにする。
// Lite（ブラウザ版）では window.studioMPro がないので、このファイルの部品は何もしない。

/**
 * window.studioMPro のうち、画面が使う部分の型。
 * desktop/src/api.ts と形を揃える（src から desktop は import しないので、構造だけを写している）。
 */
export interface ProEngineRequest {
  method: string;
  path: string;
  body?: unknown;
}
export interface ProEngineResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}
export interface ProOpenedFile {
  path: string;
  text: string;
}
export interface ProSaveRequest {
  path?: string;
  text: string;
  suggestedName: string;
}
export interface ProApi {
  engine?: { request(req: ProEngineRequest): Promise<ProEngineResponse> };
  file?: {
    open(): Promise<ProOpenedFile | null>;
    save(req: ProSaveRequest): Promise<{ path: string } | null>;
  };
}

export interface ProBridge {
  request(req: ProEngineRequest): Promise<ProEngineResponse>;
}

function proApi(win: unknown = globalThis): ProApi | null {
  const api = (win as { studioMPro?: ProApi } | null | undefined)?.studioMPro;
  return api && typeof api === 'object' ? api : null;
}

/** Studio M Pro のときだけ、アプリ内エンジンへの中継口を返す（Lite では null） */
export function getProBridge(win?: unknown): ProBridge | null {
  const req = proApi(win)?.engine?.request;
  return typeof req === 'function' ? { request: (r) => req(r) } : null;
}

/** Studio M Pro のファイルの開く・保存（OS のダイアログ）。Lite では null */
export function getProFiles(win?: unknown): NonNullable<ProApi['file']> | null {
  const f = proApi(win)?.file;
  return f && typeof f.open === 'function' && typeof f.save === 'function' ? f : null;
}

/** 本文を持たない応答（new Response に本文を渡すと例外になる状態コード） */
const NULL_BODY = new Set([101, 204, 205, 304]);

function abortError(): Error {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

/**
 * IPC を包んだ fetch。method・パス（pathname + search）・本文（JSON）だけを main に渡す。
 * 宛先のホストは見ない（main が 127.0.0.1 のエンジンに固定している）。
 * IPC が失敗したときは、ネットワーク失敗（TypeError）として拒否する。
 */
export function createIpcFetch(bridge: ProBridge): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError();

    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const rawUrl = isRequest ? input.url : String(input);
    let u: URL;
    try {
      u = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      throw new TypeError('Failed to fetch');
    }
    const method = (init.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    let body: unknown;
    if (typeof init.body === 'string' && init.body !== '') {
      try {
        body = JSON.parse(init.body);
      } catch {
        throw new TypeError('Failed to fetch');
      }
    }

    const call = bridge.request({ method, path: `${u.pathname}${u.search}`, ...(body !== undefined ? { body } : {}) });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const out = await Promise.race([call, aborted]);
      return new Response(NULL_BODY.has(out.status) ? null : out.body, { status: out.status, headers: out.headers });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      throw new TypeError('Failed to fetch');
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      call.catch(() => undefined); // 中断したあとに失敗しても、未処理の拒否にしない
    }
  }) as typeof fetch;
}
