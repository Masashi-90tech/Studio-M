import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 単一HTMLにまとめてどこでも開けるようにする（Artifactプレビュー用）
export default defineConfig({
  plugins: [viteSingleFile()],
  test: { globals: true, environment: 'node' },
});
