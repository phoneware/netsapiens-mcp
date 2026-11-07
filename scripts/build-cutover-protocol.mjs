import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaration } from './cutover-declaration-template.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const entryFile = resolve(rootDir, 'src/cutover/protocol.entry.mjs');
const outFile = resolve(rootDir, 'src/store/cutover-protocol.mjs');
const declarationFile = resolve(rootDir, 'src/store/cutover-protocol.d.ts');

const result = await build({
  absWorkingDir: rootDir,
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
  write: false,
  allowOverwrite: true,
});

const generated = result.outputFiles[0].contents;
if (process.argv.includes('--check')) {
  if (!(await readFile(outFile)).equals(Buffer.from(generated))) {
    throw new Error('Generated migration protocol differs from its sources');
  }
  if ((await readFile(declarationFile, 'utf8')) !== declaration) {
    throw new Error('Generated migration protocol declarations differ from their template');
  }
} else {
  await writeFile(outFile, generated);
  await writeFile(declarationFile, declaration);
}
