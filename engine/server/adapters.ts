// アダプターの登録表。engine/adapters/<名前>/index.ts が export する EngineAdapter を自動で集める。
// フォルダがなくても（まだ書かれていなくても）エンジンは起動する。
import type { EngineAdapter } from '../types';

/** EngineAdapter の形をしているか（id・capabilities・detect・solve が揃っているか） */
export function isAdapter(v: unknown): v is EngineAdapter {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Partial<EngineAdapter>;
  return typeof a.id === 'string' && Array.isArray(a.capabilities) && typeof a.detect === 'function' && typeof a.solve === 'function';
}

/** モジュールの export の中から EngineAdapter を取り出す（同じ id は最初のものを使う） */
export function collectAdapters(modules: Record<string, Record<string, unknown>>): EngineAdapter[] {
  const out: EngineAdapter[] = [];
  for (const path of Object.keys(modules).sort()) {
    for (const value of Object.values(modules[path])) {
      if (isAdapter(value) && !out.some((a) => a.id === value.id)) out.push(value);
    }
  }
  return out;
}

// Vite がビルド時に engine/adapters/*/index.ts を拾う（ひとつもなければ空）
const modules = import.meta.glob<Record<string, unknown>>('../adapters/*/index.ts', { eager: true });

export function loadAdapters(): EngineAdapter[] {
  return collectAdapters(modules);
}
