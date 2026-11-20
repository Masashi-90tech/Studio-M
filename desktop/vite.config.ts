// Studio M Pro のビルド設定（ブラウザ版・エンジンとは別）。リポジトリのルートから実行する:
//   vite build -c desktop/vite.config.ts                  → desktop/dist/main.js（main プロセス。ESM）
//   vite build -c desktop/vite.config.ts --mode preload   → desktop/dist/preload.cjs（preload。サンドボックスでは CJS が必須）
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const preload = mode === 'preload';
  return {
    build: {
      ssr: preload ? 'desktop/src/preload.ts' : 'desktop/src/main.ts',
      outDir: 'desktop/dist',
      emptyOutDir: !preload, // preload は main のあとに作るので、消さない
      target: 'node20',
      minify: false,
      rollupOptions: {
        external: ['electron'],
        output: preload ? { format: 'cjs' as const, entryFileNames: 'preload.cjs' } : { format: 'es' as const, entryFileNames: 'main.js' },
      },
    },
  };
});
