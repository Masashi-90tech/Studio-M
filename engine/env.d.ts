// Vite の import.meta.glob の最小限の型（エンジンは Node で動くので vite/client の型は使わない）
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true }): Record<string, T>;
  glob<T = unknown>(pattern: string, options?: { eager?: false }): Record<string, () => Promise<T>>;
}
