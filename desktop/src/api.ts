// window.studioMPro の型。main・preload が共有する（electron は import しない）。
// `window.studioMPro` がある = Studio M Pro、という判定に使う。
// 注意: 画面（src/main.ts）が開発用に window.studioM を自分で作るので、同じ名前は使えない（読み取り専用の公開と衝突して画面が起動しない）。

/** Engine への中継の要求。許可される形は request-guard.ts が決める */
export interface EngineRequest {
  method: string;
  path: string;
  /** POST /jobs の本文（JSON にできる値）。他の宛先では指定しない */
  body?: unknown;
}

/** Engine からの応答（HTTP の応答をそのまま写したもの）。合言葉は含まれない */
export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

export interface OpenedFile {
  path: string;
  text: string;
}

export interface SaveRequest {
  /** 直前に開いた・保存したファイルの path。あればダイアログなしで上書きする */
  path?: string;
  text: string;
  suggestedName: string;
}

export interface StudioMApi {
  engine: {
    request(req: EngineRequest): Promise<EngineResponse>;
  };
  file: {
    /** 開くダイアログを出して読む。取り消しなら null */
    open(): Promise<OpenedFile | null>;
    /** 保存する。path が直前のファイルと違えばダイアログを出す。取り消しなら null */
    save(req: SaveRequest): Promise<{ path: string } | null>;
  };
}

declare global {
  interface Window {
    studioMPro?: StudioMApi;
  }
}
