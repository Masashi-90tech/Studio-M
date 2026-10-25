// OpenFOAM の出力を読む・入力の数値リストを書く純粋な関数（ファイルや実行には触れない）。

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

export interface FoamField {
  /** 成分数（スカラー 1、ベクトル 3） */
  size: 1 | 3;
  /** 長さ n × size（セル順） */
  data: Float64Array;
  /** セル数 */
  n: number;
}

/**
 * ascii の場の internalField を読む。uniform と nonuniform List<scalar|vector> に対応する。
 * uniform のときはセル数 nCells だけ並べて返す。
 */
export function parseInternalField(text: string, nCells: number): FoamField {
  const head = /internalField\s+(uniform|nonuniform)\s*(List<(\w+)>)?/.exec(text);
  if (!head) throw new Error('internalField が見つかりません（結果ファイルが ascii 形式ではないか、壊れています）');
  if (head[1] === 'uniform') {
    const after = text.slice(head.index + head[0].length);
    const end = after.indexOf(';');
    const nums = (after.slice(0, end).match(NUMBER) ?? []).map(Number);
    const size = nums.length === 3 ? 3 : 1;
    if (nums.length !== 1 && nums.length !== 3) throw new Error('uniform の値を読めません');
    const data = new Float64Array(nCells * size);
    for (let c = 0; c < nCells; c++) for (let k = 0; k < size; k++) data[c * size + k] = nums[k];
    return { size, data, n: nCells };
  }
  const kind = head[3];
  const size: 1 | 3 = kind === 'vector' ? 3 : 1;
  if (kind !== 'vector' && kind !== 'scalar') throw new Error(`未対応の型です: List<${kind}>`);
  const rest = text.slice(head.index + head[0].length);
  const open = /^\s*(\d+)\s*\(/.exec(rest);
  if (!open) throw new Error('nonuniform の個数を読めません');
  const n = Number(open[1]);
  const data = new Float64Array(n * size);
  if (n > 0) {
    const body = rest.slice(open[0].length);
    NUMBER.lastIndex = 0;
    let k = 0;
    let m: RegExpExecArray | null;
    while (k < data.length && (m = NUMBER.exec(body)) !== null) data[k++] = Number(m[0]);
    if (k < data.length) throw new Error(`値の数が足りません（${k} / ${data.length}）`);
  }
  return { size, data, n };
}

/** 初期値として書くベクトルのリスト（nonuniform List<vector>）。internalField の右辺になる */
export function vectorListLiteral(ux: ArrayLike<number>, uy: ArrayLike<number>): string {
  const n = ux.length;
  const lines = new Array<string>(n);
  for (let c = 0; c < n; c++) lines[c] = `(${fmt(ux[c])} ${fmt(uy[c])} 0)`;
  return `nonuniform List<vector>\n${n}\n(\n${lines.join('\n')}\n)`;
}

function fmt(v: number): string {
  return Number(v.toPrecision(8)).toString();
}

/** 元のセル番号を値に持つ場 cellId の internalField の右辺（0 から numbering の昇順に並べる） */
export function scalarListLiteral(values: ArrayLike<number>): string {
  const lines = new Array<string>(values.length);
  for (let c = 0; c < values.length; c++) lines[c] = String(values[c]);
  return `nonuniform List<scalar>\n${values.length}\n(\n${lines.join('\n')}\n)`;
}

export interface LogSummary {
  /** 最後に出た Time = の値 */
  lastTime: number | null;
  /** SIMPLE が収束した反復回数（収束しなかったら null） */
  convergedAt: number | null;
  /** 最大クーラン数（最後に出た値） */
  courantMax: number | null;
  /** FOAM FATAL ERROR の最初の行（なければ null） */
  fatal: string | null;
  /** 浮動小数点例外（発散） */
  diverged: boolean;
}

/** `Time = 0.0123` の行から時刻を取り出す（`Time = 0.5s` のように単位が付く版もある） */
export function parseTimeLine(line: string): number | null {
  const m = /^Time = (\S+?)s?\s*$/.exec(line.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

export function parseSolverLog(text: string): LogSummary {
  const s: LogSummary = { lastTime: null, convergedAt: null, courantMax: null, fatal: null, diverged: false };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = parseTimeLine(line);
    if (t !== null) s.lastTime = t;
    const co = /Courant Number mean: \S+ max: (\S+)/.exec(line);
    if (co) s.courantMax = Number(co[1]);
    const conv = /SIMPLE solution converged in (\d+) iterations/.exec(line);
    if (conv) s.convergedAt = Number(conv[1]);
    if (s.fatal === null && /FOAM FATAL (IO )?ERROR/.test(line)) {
      // 次の空でない行が原因の説明
      for (let k = i + 1; k < Math.min(lines.length, i + 6); k++) {
        if (lines[k].trim()) {
          s.fatal = lines[k].trim();
          break;
        }
      }
      s.fatal ??= line.trim();
    }
    // 起動時のヘッダ「Floating point exception trapping enabled」は発散ではない
    if (/Foam::sigFpe|Floating point exception(?!\s+trapping)/.test(line)) s.diverged = true;
  }
  return s;
}
