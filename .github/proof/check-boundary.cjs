'use strict';
// Containment, emulator and protected-result checks for the isolated proof.
//   boundary <gateway-ipv4> <port>  no network device or route beyond lo; TCP and UDP to
//                                   external and canary addresses unreachable; loopback usable
//   reach <gateway-ipv4> <port>     positive control: the host canary answers this container
//   env                             environment holds only allowlisted names
//   status                          default seccomp filter, no_new_privs, empty capability sets
//   emulator <pid>                  the pid owns 127.0.0.1:8080 and the protected projects behave
//   identity <pid>                  stable pid:start-time:inode identity of that listener
//   results <vitest.json> <src>     protected files exist with exact case counts, all passed
const fs = require('node:fs');
const net = require('node:net');
const dgram = require('node:dgram');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const UNREACHABLE = ['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'];
const EXTERNAL = [
  ['1.1.1.1', 443, 4],
  ['169.254.169.254', 80, 4],
  ['2606:4700:4700::1111', 443, 6],
  ['fd00:ec2::254', 80, 6],
];
const ALLOWED_ENV = new Set(['PATH', 'HOME', 'LANG', 'HOSTNAME', 'NODE_VERSION', 'YARN_VERSION']);
const DENIED_ENV = [/^(GITHUB_|ACTIONS_|RUNNER_)/, /TOKEN/i, /AWS/i, /GOOGLE_APPLICATION/i];
// Protected inventory with the case count each file declares. A skipped file, a lost case
// or an extra case fails. Counts were taken from the candidate source and must be re-taken
// whenever the candidate changes.
const PROTECTED = [
  ['store/__tests__/scope-closed-positive.test.ts', 27],
  ['store/__tests__/scope-gate-negative.test.ts', 5],
  ['store/__tests__/scope-open-refusal.test.ts', 1],
  ['store/__tests__/preparation-proof.test.ts', 6],
  ['store/__tests__/cutover-fence-adopt-runner.test.ts', 16],
  ['store/__tests__/protected-factory-emulator.test.ts', 9],
  ['__tests__/pr56-adoption-e2e.test.ts', 10],
  ['__tests__/pr56-retired-replay.test.ts', 1],
];

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

function connectExpect(host, port, family, allowed) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, family });
    s.setTimeout(1500, () => { s.destroy(); reject(new Error(`connection timed out: ${host}:${port}`)); });
    s.once('connect', () => { s.destroy(); reject(new Error(`unexpected connection: ${host}:${port}`)); });
    s.once('error', e => (allowed.includes(e.code) ? resolve() : reject(new Error(`${host}:${port}: ${e.code}`))));
  });
}

function udpExpect(host, port, family) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    const timer = setTimeout(() => { s.close(); reject(new Error(`udp timed out: ${host}:${port}`)); }, 1500);
    s.send(Buffer.from('nsmcp-probe'), port, host, err => {
      clearTimeout(timer);
      s.close();
      if (!err) reject(new Error(`udp send succeeded: ${host}:${port}`));
      else if (UNREACHABLE.includes(err.code)) resolve();
      else reject(new Error(`udp ${host}:${port}: ${err.code}`));
    });
  });
}

function loopbackChild() {
  const server = net.createServer(s => s.end('inner-loopback'));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }).then(() => new Promise((resolve, reject) => {
    const code = "const n=require('node:net');const c=n.connect(+process.argv[1],'127.0.0.1');let x='';c.setTimeout(3000,()=>process.exit(1));c.on('data',b=>x+=b);c.on('end',()=>process.exit(x==='inner-loopback'?0:1));c.on('error',()=>process.exit(1))";
    const child = spawn(process.execPath, ['-e', code, String(server.address().port)], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (status, signal) => (status === 0 ? resolve() : reject(new Error(`child loopback failed: ${status} ${signal}`))));
  })).finally(() => new Promise(resolve => server.close(resolve)));
}

async function boundary(gateway, port) {
  assert.ok(net.isIPv4(gateway), 'gateway must be IPv4');
  assert.match(port, /^\d+$/);
  const devices = readOptional('/proc/net/dev').split('\n').slice(2)
    .map(s => s.split(':')[0].trim()).filter(Boolean);
  assert.deepEqual(devices, ['lo'], `unexpected network devices: ${devices.join(',')}`);
  const routes = readOptional('/proc/net/route').trim().split('\n').slice(1).filter(Boolean);
  assert(routes.every(x => x.trim().split(/\s+/)[0] === 'lo'), 'external IPv4 route');
  const routes6 = readOptional('/proc/net/ipv6_route').trim().split('\n').filter(Boolean);
  assert(routes6.every(x => x.trim().split(/\s+/).at(-1) === 'lo'), 'external IPv6 route');

  const targets = [[gateway, Number(port), 4], ...EXTERNAL];
  for (const [h, p, f] of targets) await connectExpect(h, p, f, UNREACHABLE);
  for (const [h, p, f] of targets) await udpExpect(h, p, f);
  await connectExpect('127.0.0.1', Number(port), 4, ['ECONNREFUSED']);
  await loopbackChild();
}

function reach(gateway, port) {
  assert.ok(net.isIPv4(gateway), 'gateway must be IPv4');
  assert.match(port, /^\d+$/);
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: gateway, port: Number(port), family: 4 });
    let body = '';
    s.setTimeout(5000, () => { s.destroy(); reject(new Error('canary timed out')); });
    s.on('data', chunk => { body += chunk; });
    s.once('error', reject);
    s.once('close', () => (body === 'canary-hit\n' ? resolve() : reject(new Error(`canary reply: ${JSON.stringify(body)}`))));
  });
}

function checkEnv() {
  const names = Object.keys(process.env);
  const denied = names.filter(n => DENIED_ENV.some(r => r.test(n)));
  assert.deepEqual(denied, [], `denied environment names: ${denied.join(',')}`);
  const unknown = names.filter(n => !ALLOWED_ENV.has(n));
  assert.deepEqual(unknown, [], `unlisted environment names: ${unknown.join(',')}`);
  assert.equal(process.env.HOME, '/work/home');
  assert.equal(process.env.LANG, 'C');
}

function checkStatus() {
  const s = fs.readFileSync('/proc/self/status', 'utf8');
  const get = k => {
    const m = new RegExp(`^${k}:\\s*(\\S+)`, 'm').exec(s);
    assert(m, `missing ${k}`);
    return m[1];
  };
  assert.equal(get('Seccomp'), '2', 'default seccomp filter is not active');
  assert.equal(get('NoNewPrivs'), '1', 'no_new_privs is not set');
  for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    assert.match(get(k), /^0+$/, `${k} is not empty`);
  }
}

function ownerOf8080(pid) {
  const fds = fs.readdirSync(`/proc/${pid}/fd`).map(x => {
    try { return fs.readlinkSync(`/proc/${pid}/fd/${x}`); } catch { return ''; }
  });
  const inodes = new Set(fds.map(x => /^socket:\[(\d+)\]$/.exec(x)?.[1]).filter(Boolean));
  const listeners = [
    ['/proc/net/tcp', '0100007F:1F90'],
    ['/proc/net/tcp6', '0000000000000000FFFF00000100007F:1F90'],
  ];
  const matches = listeners.flatMap(([file, address]) =>
    readOptional(file).trim().split('\n').slice(1)
      .map(x => x.trim().split(/\s+/)).filter(x => x[1] === address && x[3] === '0A'));
  return matches.length === 1 && inodes.has(matches[0][9]) ? matches[0][9] : null;
}

function emulatorIdentity(pid) {
  assert.match(pid, /^\d+$/);
  const inode = ownerOf8080(pid);
  assert(inode, 'emulator process does not own the 127.0.0.1:8080 listener');
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  assert.match(start, /^\d+$/);
  return `${pid}:${start}:${inode}`;
}

async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
}

async function probe8081() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8081, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}

async function emulator(pid) {
  assert.match(pid, /^\d+$/);
  await probe8081();
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (!fs.existsSync(`/proc/${pid}`)) throw new Error('emulator exited before becoming ready');
    if (ownerOf8080(pid)) {
      try { const r = await request('http://127.0.0.1:8080/'); await r.text(); ready = true; break; } catch {}
    }
    await sleep(250);
  }
  assert(ready, 'emulator not ready, or the process does not own port 8080');
  for (const project of ['firestore-test', 'demo-netsapiens-cutover']) {
    const root = `http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents`;
    const reset = `http://127.0.0.1:8080/emulator/v1/projects/${project}/databases/(default)/documents`;
    const doc = `${root}/proof_boundary/marker`;
    const json = { 'content-type': 'application/json' };
    let r = await request(doc, { method: 'PATCH', headers: json, body: JSON.stringify({ fields: { marker: { stringValue: 'disposable-proof' } } }) });
    assert(r.ok, `marker write failed: ${project} ${r.status}`);
    r = await request(doc);
    assert(r.ok, `marker read failed: ${project}`);
    assert.equal((await r.json()).fields.marker.stringValue, 'disposable-proof');
    r = await request(doc, { method: 'DELETE' });
    assert(r.ok, `marker delete failed: ${project}`);
    r = await request(doc);
    assert.equal(r.status, 404, `marker survived deletion: ${project}`);
    r = await request(doc, { method: 'PATCH', headers: json, body: JSON.stringify({ fields: { marker: { stringValue: 'reset-proof' } } }) });
    assert(r.ok, `reset marker write failed: ${project}`);
    r = await request(doc);
    assert(r.ok && (await r.json()).fields.marker.stringValue === 'reset-proof', `reset marker read failed: ${project}`);
    r = await request(reset, { method: 'DELETE' });
    assert(r.ok, `emulator reset failed: ${project} ${r.status}`);
    r = await request(doc);
    assert.equal(r.status, 404, `marker survived reset: ${project}`);
  }
  assert(ownerOf8080(pid), 'emulator no longer owns port 8080');
  await probe8081();
}

function results(file, root) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.success, true, 'Vitest reported failure');
  assert.equal(data.numFailedTests, 0, 'failed test aggregate');
  assert.equal(data.numFailedTestSuites, 0, 'failed suite aggregate');
  if (data.numRuntimeErrorTestSuites !== undefined) assert.equal(data.numRuntimeErrorTestSuites, 0, 'runtime suite errors');
  if (data.errors !== undefined) assert(Array.isArray(data.errors) && data.errors.length === 0, 'unhandled errors');
  assert(Array.isArray(data.testResults), 'missing testResults');

  const expected = [];
  (function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'build', '.claude', '.git'].includes(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(p);
      else if (entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) expected.push(path.resolve(p));
    }
  })(root);
  assert(expected.length > 0, 'empty suite inventory');
  const actual = data.testResults.map(x => path.resolve(x.name));
  assert.equal(new Set(actual).size, actual.length, 'duplicate suite result');
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'selected suite inventory mismatch');

  const assertions = data.testResults.flatMap(x => x.assertionResults || []);
  assert.equal(data.numTotalTests, assertions.length, 'test count mismatch');
  assert.equal(data.numPassedTests, assertions.filter(x => x.status === 'passed').length, 'passed test count mismatch');
  assert.equal(assertions.filter(x => x.status === 'failed').length, 0, 'failed test cases');

  for (const [suffix, count] of PROTECTED) {
    const matches = data.testResults.filter(x => x.name.endsWith(`/src/${suffix}`));
    assert.equal(matches.length, 1, `expected exactly one result for ${suffix}`);
    const file = matches[0];
    assert.equal(file.status, 'passed', `protected file not passed: ${suffix}`);
    const cases = file.assertionResults || [];
    assert.equal(cases.length, count, `protected case count for ${suffix}`);
    for (const t of cases) {
      assert.equal(t.status, 'passed', `not passed: ${suffix}: ${t.fullName || t.title}`);
    }
  }
  assert.equal(PROTECTED.reduce((n, [, c]) => n + c, 0), 75, 'protected inventory total');
}

(async () => {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'boundary') await boundary(a, b);
  else if (mode === 'reach') await reach(a, b);
  else if (mode === 'env') checkEnv();
  else if (mode === 'status') checkStatus();
  else if (mode === 'emulator') await emulator(a);
  else if (mode === 'identity') { console.log(emulatorIdentity(a)); return; }
  else if (mode === 'results') results(a, b);
  else throw new Error('unknown mode');
  console.log(`${mode}: passed`);
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
});
