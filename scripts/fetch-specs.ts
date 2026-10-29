import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const branches: string[] = JSON.parse(await readFile(resolve(root, 'spec/v2/BRANCHES.json'), 'utf8'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function get(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (response.status === 429 && attempt < 4) {
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`Documentation request failed: ${response.status}`);
    return response;
  }
  throw new Error('Documentation request exhausted retries');
}

if (process.argv.includes('--check')) {
  const html = await (await get('https://docs.ns-api.com/')).text();
  const found = new Set([...html.matchAll(/\/v(\d+\.\d+)\//g)].map(match => match[1]));
  if (!found.size) throw new Error('No documentation branches found');
  const missing = [...found].filter(branch => !branches.includes(branch)).sort();
  if (missing.length) {
    console.error(`Missing documentation branches: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else console.log('All published documentation branches are recorded');
} else {
  const v1Path = 'spec/v1/apidoc-44.4.10.json';
  const v1 = await readFile(resolve(root, v1Path));
  const sources: Record<string, object> = {
    [v1Path]: { url: 'https://<netsapiens-host>/ns-api/webroot/apidoc/api_data.json', effectiveUrl: null, retrievedAt: null, apiVersion: '44.4.10', sha256: digest(v1), bytes: v1.length },
  };
  const fetched: Array<{ path: string; bytes: Buffer }> = [];
  for (const branch of branches) {
    const url = `https://docs.ns-api.com/v${branch}/openapi/netsapiens-api-v2.json`;
    const response = await get(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    const path = `spec/v2/${branch}.json`;
    if (branch === '45.0') {
      const original = await readFile(resolve(root, path));
      if (!bytes.equals(original)) throw new Error('45.0 documentation differs from the existing vendored spec');
    }
    fetched.push({ path, bytes });
    sources[path] = { url, effectiveUrl: response.url, retrievedAt: new Date().toISOString(), sha256: digest(bytes), bytes: bytes.length };
    console.log(`Fetched ${branch}: ${bytes.length} bytes`);
  }
  for (const { path, bytes } of fetched) await writeFile(resolve(root, path), bytes);
  await writeFile(resolve(root, 'spec/SOURCES.json'), JSON.stringify(sources, null, 2) + '\n');
}
