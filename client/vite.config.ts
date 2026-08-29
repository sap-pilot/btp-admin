import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
) as { version: string };

function getCommitHash(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '..') })
      .toString()
      .trim()
      .slice(0, 7);
  } catch {
    return 'unknown';
  }
}

function getBuildDate(): string {
  return new Date().toISOString(); // full UTC timestamp; formatted to local tz at display time
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __COMMIT_HASH__: JSON.stringify(getCommitHash()),
    __BUILD_DATE__: JSON.stringify(getBuildDate()),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:  path.resolve(__dirname, 'index.html'),
        popup: path.resolve(__dirname, 'popup.html'),
      },
    },
  },
});
