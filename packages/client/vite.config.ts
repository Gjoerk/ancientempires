import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@kingsfall/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
});
