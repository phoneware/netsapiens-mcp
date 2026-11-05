import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('build/auth/kit', { recursive: true });
for (const file of ['cutover-protocol.mjs', 'cutover-protocol.d.mts', 'cutover-protocol.d.ts']) {
  await copyFile(`src/auth/kit/${file}`, `build/auth/kit/${file}`);
}
