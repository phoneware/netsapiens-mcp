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
      if (!file.startsWith('spec/') && matches(readFileSync(file).toString('utf8'))) report(file);
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
          objects.set(id, { type, targets, matched: matches(text.slice(separator + 2)) });
        }
      }
      await exited;
    }
    function matchingObjects(selected) {
      const hits = new Set();
      const seen = new Set();
      const seenTrees = new Set();
      const stack = selected.map(ref => ({ id: ref.id, root: true }));
      while (stack.length) {
        const { id, root } = stack.pop();
        const object = objects.get(id);
        if (!object) throw new Error('Missing reachable object');
        if (object.type === 'tree') {
          const key = `${id}:${root}`;
          if (seenTrees.has(key)) continue;
          seenTrees.add(key);
          for (const entry of object.entries) {
            if (entry.mode === '160000' || (root && entry.name === 'spec')) continue;
            stack.push({ id: entry.id, root: false });
          }
        } else {
          if (seen.has(id)) continue;
          seen.add(id);
          if (object.matched) hits.add(id);
          for (const target of object.targets ?? []) stack.push({ id: target, root: true });
        }
      }
      return hits;
    }
    const ordinary = refs.filter(ref => !ref.name.startsWith('refs/pull/'));
    for (const ref of ordinary) if (matches(ref.name)) report(`ref ${ref.name}`);
    for (const id of matchingObjects(ordinary)) report(`object ${id}`);
    for (const ref of refs.filter(ref => ref.name.startsWith('refs/pull/'))) {
      if (matches(ref.name) || matchingObjects([ref]).size) console.log(`PENDING ${safe(ref.name)}`);
    }
  } else {
    console.error('Usage: scan-forbidden.mjs --tree | --pack <tgz> | --history <git-dir>');
    process.exit(2);
  }
} catch {
  console.error('Content scan failed');
  process.exit(2);
}
process.exit(found ? 1 : 0);
