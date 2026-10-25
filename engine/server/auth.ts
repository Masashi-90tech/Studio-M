// 合言葉（トークン）。起動のたびに作り直し、画面に表示し、ファイルにも書く（デスクトップ版が後で読めるように）。
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/** 既定のトークンファイル: ~/.studio-m/engine-token */
export function defaultTokenFile(): string {
  return join(homedir(), '.studio-m', 'engine-token');
}

/** 'Bearer xxx' → 'xxx'。形が違えば null */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}

/** 時間差で推測されないように、同じ長さにそろえて比べる */
export function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** トークンをファイルに書く（自分だけが読める権限で）。書けなくてもエンジンは動かすので、失敗は例外で返す */
export async function writeTokenFile(token: string, file: string = defaultTokenFile()): Promise<string> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows など権限を変えられない環境では、そのままにする
  }
  return file;
}
