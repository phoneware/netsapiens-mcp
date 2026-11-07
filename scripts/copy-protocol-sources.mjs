// Copies the ESM sources and declarations that tsc does not emit into the build output, at the same relative
// path. tsc emits only .js and .d.ts for .ts sources, so the cutover .mjs modules and their .d.mts declarations
// would otherwise be missing, and every relative .mjs import from build/ would fail to resolve.
//
// Usage: node scripts/copy-protocol-sources.mjs [srcRoot=src] [destRoot=build]
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// The export map names this declaration explicitly, so it is copied even though it is not an .mjs source.
const NAMED_DECLARATIONS = ['store/cutover-protocol.d.ts'];

export function protocolSourceFiles(srcRoot) {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== '__tests__') walk(path);
      }
      else if (entry.endsWith('.mjs') || entry.endsWith('.d.mts')) found.push(relative(srcRoot, path));
    }
  })(srcRoot);
  return found.sort();
}

export function copyProtocolSources(srcRoot, destRoot) {
  const files = [...protocolSourceFiles(srcRoot), ...NAMED_DECLARATIONS];
  for (const rel of files) {
    const target = join(destRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(srcRoot, rel), target);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcRoot = process.argv[2] ?? 'src';
  const destRoot = process.argv[3] ?? 'build';
  const copied = copyProtocolSources(srcRoot, destRoot);
  process.stdout.write(`copied ${copied.length} protocol source files from ${srcRoot} to ${destRoot}\n`);
}
