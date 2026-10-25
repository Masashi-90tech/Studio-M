// コマンドラインの読み取り。エンジンの設定は、ここで受け取るものだけ（合言葉は引数に書かせない）。
import { ENGINE_DEFAULT_PORT } from '../../src/core/engine-protocol';

export interface EngineArgs {
  port: number;
  keep: boolean;
  maxJobs: number;
  ttlHours: number;
  timeoutMin: number;
  help: boolean;
  /** 読み取れなかった指定（あれば説明つき） */
  errors: string[];
}

export const HELP_TEXT = `Studio M Engine — PC 上で本格的な解析ソフト（CalculiX・OpenFOAM）を動かす補助プログラム

使い方:  npm run engine -- [オプション]

  --port <番号>        待ち受けるポート（既定 ${ENGINE_DEFAULT_PORT}）。127.0.0.1 だけで待ち受けます
  --max-jobs <数>      同時に走らせる計算の数（既定 1）
  --keep               終了時に計算用の一時フォルダを消さない（入力ファイルの確認用）
  --ttl-hours <時間>   終わった計算を覚えておく時間（既定 24）
  --timeout-min <分>   1 つのコマンドの時間切れ（既定 60）
  --help               この説明を出す

環境変数 STUDIO_M_ENGINE_TOKEN に 16 文字以上を入れると、その文字列を合言葉に使います（開発・テスト用）。
`;

function intArg(name: string, value: string | undefined, min: number, max: number, errors: string[]): number | null {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} には ${min}〜${max} の整数を指定してください`);
    return null;
  }
  return n;
}

export function parseArgs(argv: string[]): EngineArgs {
  const out: EngineArgs = { port: ENGINE_DEFAULT_PORT, keep: false, maxJobs: 1, ttlHours: 24, timeoutMin: 60, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const next = (): string | undefined => inline ?? argv[++i];
    switch (name) {
      case '--port':
        out.port = intArg('--port', next(), 1, 65535, out.errors) ?? out.port;
        break;
      case '--max-jobs':
        out.maxJobs = intArg('--max-jobs', next(), 1, 16, out.errors) ?? out.maxJobs;
        break;
      case '--ttl-hours':
        out.ttlHours = intArg('--ttl-hours', next(), 1, 24 * 30, out.errors) ?? out.ttlHours;
        break;
      case '--timeout-min':
        out.timeoutMin = intArg('--timeout-min', next(), 1, 24 * 60, out.errors) ?? out.timeoutMin;
        break;
      case '--keep':
        out.keep = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        out.errors.push(`知らない指定です: ${a}`);
    }
  }
  return out;
}
