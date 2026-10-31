import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  // CRÍTICO: Incrusta y compila dentro de dist/main.js cualquier paquete interno del monorepo
  // (@chapus/core, @chapus/api-contract) para que Node 20 en producción no toque archivos .ts
  noExternal: [/^@chapus\//],
});
