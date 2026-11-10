#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const lines = (process.env.FORBIDDEN_CONTENT_PATTERNS ?? '').split(/\r?\n/).filter(line => line.trim());
if (!lines.length) {
  console.error('Content patterns are required');
  process.exit(2);
}
let patterns;
try {
  patterns = lines.map(line => {
    const match = line.match(/^\/(.*)\/([a-z]*)$/);
    return match ? new RegExp(match[1], match[2]) : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  });
} catch {
  console.error('Invalid content pattern');
  process.exit(2);
}
const matches = value => patterns.some(pattern => { pattern.lastIndex = 0; return pattern.test(value); });
const run = (command, args) => execFileSync(command, args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
let found = false;
const safe = value => matches(value) ? '[redacted]' : value;
const report = location => { console.log(`MATCH ${safe(location)}`); found = true; };
const mode = process.argv[2];
try {
  if (mode === '--tree' && process.argv.length === 3) {
    const files = run('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean);
    for (const file of files) {
      if (matches(file)) report('[redacted]');
      if (!file.startsWith('spec/') && matches(readFileSync(file).toString('utf8'))) report(file);
    }
  } else if (mode === '--commit' && process.argv.length === 4) {
    // Scans one commit's tree only: not history, commit messages, headers or tags. Entries under the root spec/
    // directory are excluded from content matching; their paths and object types are still checked.
    const input = process.argv[3];
    const MAX_ENTRIES = 50_000;
    const MAX_LISTING_BYTES = 32 * 1024 * 1024;
    const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
    const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
    delete env.FORBIDDEN_CONTENT_PATTERNS;
    const git = (args, options = {}) => execFileSync('git', args, { env, maxBuffer: 2 * MAX_OBJECT_BYTES, ...options });
    const format = git(['rev-parse', '--show-object-format']).toString('ascii').trim();
    const length = format === 'sha1' ? 40 : format === 'sha256' ? 64 : 0;
    if (input.length !== length || !/^[0-9a-f]+$/i.test(input)) throw new Error('Invalid commit');
    const commit = input.toLowerCase();
    if (git(['cat-file', '-t', commit]).toString('ascii').trim() !== 'commit') throw new Error('Not a commit');
    const listing = git(['ls-tree', '-r', '-t', '-z', '--full-tree', commit], { maxBuffer: MAX_LISTING_BYTES })
      .toString('utf8').split('\0').filter(Boolean);
    if (listing.length > MAX_ENTRIES) throw new Error('Too many entries');
    const kinds = { '040000': 'tree', '100644': 'blob', '100755': 'blob', '120000': 'blob' };
    const entries = listing.map(line => {
      const tab = line.indexOf('\t');
      const header = tab < 0 ? null : line.slice(0, tab).match(/^(\d{6}) (tree|blob|commit) ([0-9a-f]+)$/);
      if (!header || kinds[header[1]] !== header[2] || header[3].length !== length) throw new Error('Unsupported tree entry');
      return { type: header[2], oid: header[3], path: line.slice(tab + 1) };
    });
    const oids = [...new Set(entries.map(entry => entry.oid))];
    const rows = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${oids.join('\n')}\n` })
      .toString('ascii').split('\n');
    rows.pop();
    if (rows.length !== oids.length) throw new Error('Object inspection failed');
    const objects = new Map();
    rows.forEach((row, index) => {
      const [oid, type, size, extra] = row.split(' ');
      if (oid !== oids[index] || extra !== undefined || !/^\d+$/.test(size ?? '')) throw new Error('Missing object');
      objects.set(oid, { type, size: Number(size) });
    });
    let bytes = 0;
    for (const { size } of objects.values()) bytes += size;
    if (bytes > MAX_OBJECT_BYTES) throw new Error('Too many object bytes');
    if (entries.some(entry => objects.get(entry.oid).type !== entry.type)) throw new Error('Object type mismatch');
    let verdict = entries.some(entry => matches(entry.path));
    const wanted = [...new Set(entries.filter(entry => entry.type === 'blob' && !entry.path.startsWith('spec/')).map(entry => entry.oid))];
    if (wanted.length) {
      const out = git(['cat-file', '--batch'], { input: `${wanted.join('\n')}\n` });
      let offset = 0;
      for (const oid of wanted) {
        const end = out.indexOf(0x0a, offset);
        if (end < 0) throw new Error('Unexpected object output');
        const [name, type, size] = out.toString('ascii', offset, end).split(' ');
        const start = end + 1;
        const next = start + Number(size) + 1;
        if (name !== oid || type !== 'blob' || Number(size) !== objects.get(oid).size || out[next - 1] !== 0x0a) throw new Error('Unexpected object output');
        verdict = verdict || matches(out.toString('utf8', start, next - 1));
        offset = next;
      }
      if (offset !== out.length) throw new Error('Unexpected object output');
    }
    if (verdict) {
      found = true;
      console.log('MATCH [redacted]');
    }
  } else if (mode === '--pack' && process.argv.length === 4) {
    const archive = process.argv[3];
    const files = run('tar', ['-tzf', archive]).toString().split('\n').filter(name => name && !name.endsWith('/'));
    for (const file of files) {
      if (matches(run('tar', ['-xOzf', archive, '--', file]).toString('utf8'))) report(file);
    }
  } else if (mode === '--history' && process.argv.length === 4) {
    const gitDir = process.argv[3];
    const git = (...args) => run('git', ['--git-dir', gitDir, ...args]).toString('utf8');
    const refs = git('for-each-ref', '--format=%(refname)%00%(objectname)').split('\n').filter(Boolean).map(line => {
      const [name, id] = line.split('\0');
      return { name, id };
    });
    const ids = new Set(git('rev-list', '--objects', '--all').split('\n').filter(Boolean).map(line => line.split(' ', 1)[0]));
    for (const ref of refs) ids.add(ref.id);
    const objects = new Map();
    if (ids.size) {
      const batch = spawn('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise((resolve, reject) => {
        batch.on('error', reject);
        batch.on('close', code => code === 0 ? resolve() : reject(new Error('git batch failed')));
      });
      batch.stderr.resume();
      batch.stdin.on('error', () => { });
      batch.stdin.end([...ids].join('\n') + '\n');
      const input = batch.stdout[Symbol.asyncIterator]();
      let buffer = Buffer.alloc(0);
      async function fill() {
        const next = await input.next();
        if (next.done) throw new Error('Unexpected end of git batch');
        buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
      }
      async function line() {
        while (buffer.indexOf(10) < 0) await fill();
        const end = buffer.indexOf(10);
        const result = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        return result;
      }
      async function take(size) {
        const parts = [];
        let remaining = size;
        while (remaining) {
          if (!buffer.length) await fill();
          const n = Math.min(buffer.length, remaining);
          parts.push(buffer.subarray(0, n));
          buffer = buffer.subarray(n);
          remaining -= n;
        }
        return parts.length === 1 ? parts[0] : Buffer.concat(parts, size);
      }
      for (let i = 0; i < ids.size; i++) {
        const header = await line();
        const match = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(header);
        if (!match) throw new Error('Invalid git batch response');
        const [, id, type, length] = match;
        const data = await take(Number(length));
        if ((await take(1))[0] !== 10) throw new Error('Invalid git batch framing');
        if (type === 'tree') {
          const entries = [];
          const oidBytes = id.length / 2;
          for (let pos = 0; pos < data.length;) {
            const space = data.indexOf(32, pos), zero = data.indexOf(0, space + 1);
            if (space < 0 || zero < 0 || zero + 1 + oidBytes > data.length) throw new Error('Invalid tree object');
            entries.push({ mode: data.subarray(pos, space).toString(), name: data.subarray(space + 1, zero).toString(), id: data.subarray(zero + 1, zero + 1 + oidBytes).toString('hex') });
            pos = zero + 1 + oidBytes;
          }
          objects.set(id, { type, entries });
        } else if (type === 'blob') {
          objects.set(id, { type, matched: matches(data.toString('utf8')) });
        } else {
          const text = data.toString('utf8');
          const separator = text.indexOf('\n\n');
          if (separator < 0) throw new Error('Invalid git object');
          const headers = text.slice(0, separator).split('\n');
          const targets = headers.filter(value => /^(tree|parent|object) /.test(value)).map(value => value.slice(value.indexOf(' ') + 1));
          const metadata = headers.filter(value => !/^(tree|parent|object) /.test(value)).join('\n');
          objects.set(id, { type, targets, matched: matches(metadata) || matches(text.slice(separator + 2)) });
        }
      }
      await exited;
    }
    function matchingObjects(selected) {
      const hits = new Set();
      const seen = new Set();
      const seenTrees = new Set();
      const stack = selected.map(ref => ({ id: ref.id, path: '', excluded: false }));
      while (stack.length) {
        const { id, path, excluded } = stack.pop();
        const object = objects.get(id);
        if (!object) throw new Error('Missing reachable object');
        if (object.type === 'tree') {
          const key = `${id}:${path}`;
          if (seenTrees.has(key)) continue;
          seenTrees.add(key);
          for (const entry of object.entries) {
            const childPath = path ? `${path}/${entry.name}` : entry.name;
            if (matches(childPath)) hits.add('path');
            if (entry.mode === '160000') continue;
            const childExcluded = excluded || (!path && entry.name === 'spec' && entry.mode === '40000');
            stack.push({ id: entry.id, path: childPath, excluded: childExcluded });
          }
        } else {
          if (object.type === 'blob' && excluded) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          if (object.matched) hits.add(id);
          for (const target of object.targets ?? []) stack.push({ id: target, path: '', excluded: false });
        }
      }
      return hits;
    }
    const ordinary = refs.filter(ref => !ref.name.startsWith('refs/pull/'));
    for (const ref of ordinary) if (matches(ref.name)) report(`ref ${ref.name}`);
    for (const id of matchingObjects(ordinary)) report(id === 'path' ? '[redacted]' : `object ${id}`);
    for (const ref of refs.filter(ref => ref.name.startsWith('refs/pull/'))) {
      if (matches(ref.name) || matchingObjects([ref]).size) console.log(`PENDING ${safe(ref.name)}`);
    }
  } else {
    console.error('Usage: scan-forbidden.mjs --tree | --commit <sha> | --pack <tgz> | --history <git-dir>');
    process.exit(2);
  }
} catch {
  console.error('Content scan failed');
  process.exit(2);
}
process.exit(found ? 1 : 0);
