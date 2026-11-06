#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
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
const report = location => { console.log(`MATCH ${location}`); found = true; };
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
    const refs = git('for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
    const scanRefs = (selected, pending) => {
      if (!selected.length) return;
      for (const ref of selected) {
        if (matches(ref)) pending ? console.log(`PENDING ${ref}`) : report(`ref ${ref}`);
      }
      const tagChain = ref => {
        const ids = [];
        let id = git('rev-parse', ref).trim();
        for (; ;) {
          ids.push(id);
          if (git('cat-file', '-t', id).trim() !== 'tag') break;
          id = git('cat-file', 'tag', id).split('\n', 1)[0].slice(7);
        }
        return ids;
      };
      if (pending) {
        for (const ref of selected) {
          const ids = git('rev-list', '--objects', '--no-object-names', ref).split('\n').filter(Boolean);
          ids.push(...tagChain(ref));
          if (ids.some(id => objectMatches(id))) console.log(`PENDING ${ref}`);
        }
      } else {
        const ids = git('rev-list', '--objects', '--no-object-names', ...selected).split('\n').filter(Boolean);
        ids.push(...selected.flatMap(tagChain));
        for (const id of new Set(ids)) if (objectMatches(id)) report(`object ${id}`);
      }
    };
    function objectMatches(id) {
      const type = git('cat-file', '-t', id).trim();
      if (!['blob', 'commit', 'tag'].includes(type)) return false;
      let content = git('cat-file', type, id);
      if (type !== 'blob') content = content.slice(content.indexOf('\n\n') + 2);
      return matches(content);
    }
    scanRefs(refs.filter(ref => !ref.startsWith('refs/pull/')), false);
    scanRefs(refs.filter(ref => ref.startsWith('refs/pull/')), true);
  } else {
    console.error('Usage: scan-forbidden.mjs --tree | --pack <tgz> | --history <git-dir>');
    process.exit(2);
  }
} catch {
  console.error('Content scan failed');
  process.exit(2);
}
process.exit(found ? 1 : 0);
