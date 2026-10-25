// Studio M Engine のビルド設定（ブラウザ版の vite.config.ts とは別）。
//   vite build --ssr engine/main.ts --outDir dist-engine -c engine/vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'engine/main.ts',
    outDir: 'dist-engine',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'main.js' } },
  },
});
