import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts', 'src/internal.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  // Node CLI: splitting creates extra chunks with no perf benefit and
  // makes the tarball noisier.
  splitting: false,
  // Emit .map files alongside the JS, but exclude them from the npm tarball
  // via .npmignore so we do not publish absolute TypeScript paths or full
  // original source. Local debugging still works via the generated .map.
  sourcemap: true,
  external: [
    'playwright',
    'commander',
    'zod',
    'ora',
    'pixelmatch',
    'pngjs',
    '@axe-core/playwright',
    'axe-core',
  ],
});
