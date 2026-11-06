import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('build/auth/kit', { recursive: true });
for (const file of ['cutover-protocol.mjs', 'cutover-protocol.d.mts', 'cutover-protocol.d.ts']) {
  await copyFile(`src/auth/kit/${file}`, `build/auth/kit/${file}`);
}
await mkdir('build/auth/kit/cutover', { recursive: true });
await copyFile('src/auth/kit/cutover/canonical-core.d.mts', 'build/auth/kit/cutover/canonical-core.d.mts');
