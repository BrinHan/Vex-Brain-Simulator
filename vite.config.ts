import { defineConfig } from 'vite';

// base './' so the built site also loads from file:// inside Electron
export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
  test: { include: ['tests/**/*.test.ts'] },
});
