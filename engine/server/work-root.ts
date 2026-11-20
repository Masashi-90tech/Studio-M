// 作業フォルダーの置き場所を、英数字だけの安全なパスにそろえる。
// OpenFOAM は、case のパスに日本語・空白などがあると致命的エラーにする。
// Windows のユーザー名が日本語だと、既定の一時フォルダーがそうなり得る。
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** ASCII の英数字と . _ - / \ :（Windows のドライブ）だけなら安全 */
export function isSafeWorkPath(p: string): boolean {
  return p.length > 0 && /^[A-Za-z0-9._\-/\\:]+$/.test(p);
}

export interface SafeWorkRoot {
  root: string;
  /** 安全でないので移したときの、元のパス */
  relocatedFrom?: string;
}

export interface ResolveSafeWorkRootOptions {
  requested: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** 候補の親フォルダーが存在するか（テスト用に差し替え可） */
  exists?: (p: string) => boolean | Promise<boolean>;
  /** フォルダーを作る（テスト用に差し替え可）。失敗したら例外 */
  mkdir?: (p: string) => Promise<unknown>;
}

const defaultExists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const defaultMkdir = (p: string): Promise<unknown> => mkdir(p, { recursive: true });

export function candidateParents(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === 'win32') {
    const list: string[] = [];
    if (env.ProgramData) list.push(env.ProgramData);
    list.push(env.PUBLIC || 'C:\\Users\\Public');
    list.push('C:\\studio-m-work');
    return list;
  }
  return [platform === 'darwin' ? '/private/tmp' : '/tmp'];
}

export async function resolveSafeWorkRoot(o: ResolveSafeWorkRootOptions): Promise<SafeWorkRoot> {
  if (isSafeWorkPath(o.requested)) return { root: o.requested };
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? defaultExists;
  const makeDir = o.mkdir ?? defaultMkdir;
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const parent of candidateParents(platform, env)) {
    if (!isSafeWorkPath(parent)) continue;
    const root = join(parent, 'studio-m-engine');
    try {
      // C:\studio-m-work のように、親そのものを作ってよい候補は mkdir に任せる
      if (!(await exists(parent)) && !parent.toLowerCase().endsWith('studio-m-work')) continue;
      await makeDir(root);
      return { root, relocatedFrom: o.requested };
    } catch {
      // 次の候補へ
    }
  }
  throw new Error('作業フォルダーを安全な場所に作れません。環境変数 STUDIO_M_WORK_ROOT に、英数字だけのフォルダー（例 C:\\studio-m-work）を指定してください');
}

/** 移したときに画面に出す 1 行 */
export function relocationNotice(r: SafeWorkRoot): string | undefined {
  return r.relocatedFrom === undefined
    ? undefined
    : `作業フォルダーを英数字だけの場所（${r.root}）に移しました（元のパス ${r.relocatedFrom} に日本語や空白があると OpenFOAM が動かないため）`;
}
