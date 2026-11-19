// renderer からの要求を、127.0.0.1 の Studio M Engine に合言葉つきで中継する（electron は import しない）。
// 合言葉はここの中だけに持ち、応答にも要求にも出さない。
import type { EngineRequest, EngineResponse } from './api';
import { checkEngineRequest } from './request-guard';

export interface EngineBridgeOptions {
  /** 例: http://127.0.0.1:12345（ループバックだけ許す） */
  baseUrl: string;
  token: string;
  /** テスト用に差し替えられる */
  fetch?: typeof fetch;
}

export interface EngineBridge {
  request(req: EngineRequest): Promise<EngineResponse>;
}

/** 応答のうち renderer に渡すヘッダー（それ以外は渡さない） */
const PASS_HEADERS = ['content-type', 'content-disposition', 'content-length'];

const errorResponse = (status: number, message: string): EngineResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: new TextEncoder().encode(JSON.stringify({ error: message })).buffer as ArrayBuffer,
});

export function createEngineBridge(o: EngineBridgeOptions): EngineBridge {
  const base = new URL(o.baseUrl);
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('エンジンの宛先は http://127.0.0.1 だけ使えます');
  const doFetch = o.fetch ?? fetch;

  return {
    async request(req) {
      const checked = checkEngineRequest(req);
      if (!checked.ok) return errorResponse(403, checked.error);
      const headers: Record<string, string> = { Authorization: `Bearer ${o.token}` };
      let body: string | undefined;
      if (checked.hasBody) {
        headers['Content-Type'] = 'application/json';
        try {
          body = JSON.stringify(req.body);
        } catch {
          return errorResponse(400, '本文を JSON に変換できません');
        }
      }
      let res: Response;
      try {
        res = await doFetch(new URL(checked.path, base).toString(), { method: checked.method, headers, body, redirect: 'error' });
      } catch (e) {
        return errorResponse(502, `エンジンに届きませんでした（${e instanceof Error ? e.message : String(e)}）。アプリを再起動してください`);
      }
      const out: Record<string, string> = {};
      for (const k of PASS_HEADERS) {
        const v = res.headers.get(k);
        if (v !== null) out[k] = v;
      }
      return { status: res.status, headers: out, body: await res.arrayBuffer() };
    },
  };
}
