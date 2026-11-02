import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const entryFile = resolve(rootDir, 'src/cutover/protocol.entry.mjs');
const outFile = resolve(rootDir, 'src/store/cutover-protocol.mjs');

const result = await build({
  entryPoints: [entryFile],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  target: 'node18.0',
  format: 'esm',
  splitting: false,
  minify: false,
  treeShaking: false,
  sourcemap: false,
  metafile: true,
  keepNames: true,
  allowOverwrite: true,
});

console.log('esbuild bundle completed successfully into', outFile);
