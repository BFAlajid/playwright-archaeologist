import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  external: ['playwright', 'commander', 'zod', 'ora'],
});
