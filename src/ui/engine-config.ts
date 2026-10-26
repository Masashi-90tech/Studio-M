// PC のエンジンへの接続設定（URL と合言葉）。閲覧者ごとに localStorage へ保存する。DOM に触れない。
import { ENGINE_DEFAULT_PORT } from '../core/engine-protocol';

export interface EngineConfig {
  url: string;
  token: string;
}

export const ENGINE_CONFIG_KEY = 'studio-m-lite:engine:v1';
export const DEFAULT_ENGINE_URL = `http://127.0.0.1:${ENGINE_DEFAULT_PORT}`;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 入力された URL を整える。http(s):// がなければ http:// を補い、末尾の / とパスは落とす。
 * 読めない・http(s) でないときは null。
 */
export function normalizeEngineUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** 保存された設定を読む。なければ既定の URL と空の合言葉 */
export function loadEngineConfig(storage: StorageLike | null = defaultStorage()): EngineConfig {
  const fallback: EngineConfig = { url: DEFAULT_ENGINE_URL, token: '' };
  if (!storage) return fallback;
  try {
    const raw: unknown = JSON.parse(storage.getItem(ENGINE_CONFIG_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return fallback;
    const r = raw as Record<string, unknown>;
    const url = typeof r.url === 'string' ? normalizeEngineUrl(r.url) : null;
    return { url: url ?? DEFAULT_ENGINE_URL, token: typeof r.token === 'string' ? r.token.trim() : '' };
  } catch {
    return fallback;
  }
}

/** 合言葉を保存してあるか（起動時に自動で接続を試すかの判断に使う） */
export function hasSavedEngineToken(storage: StorageLike | null = defaultStorage()): boolean {
  return loadEngineConfig(storage).token !== '';
}

/** 保存できたら true。保存できない環境でも画面は動く */
export function saveEngineConfig(config: EngineConfig, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ENGINE_CONFIG_KEY, JSON.stringify({ url: config.url, token: config.token }));
    return true;
  } catch {
    return false;
  }
}

export function clearEngineConfig(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(ENGINE_CONFIG_KEY);
  } catch {
    // 消せなくても何もしない
  }
}

/** claude.ai の Artifact として開かれているか（そこからは PC のエンジンに届かない） */
export function inArtifactViewer(): boolean {
  try {
    return typeof (window as unknown as { claude?: unknown }).claude !== 'undefined';
  } catch {
    return false;
  }
}
