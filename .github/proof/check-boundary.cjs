'use strict';
// Containment, emulator and protected-result checks for the isolated proof.
//   boundary <gateway-ipv4> <port>            no network device or route beyond lo; TCP and UDP to
//                                             external and canary addresses unreachable; loopback usable
//   probe-tcp <ip> <port> <4|6>               TCP to ip:port must be unreachable. A reachable target fails
//                                             with "unexpected connection"
//   probe-udp <ip> <port> <4|6>               one UDP datagram to ip:port must fail with an unreachable
//                                             error. A send that succeeds fails with "udp send succeeded"
//   reach <gateway-ipv4> <port>               positive control: the host TCP canary answers this container
//   reach-udp <gateway-ipv4> <port>           positive control: the host UDP canary replies to this container
//   env [file]                                environment names and values in file (NUL-separated, e.g.
//                                             /proc/1/environ, which is the container's own env, not a
//                                             shell's exports); without a file, this process's env
//   status                                    seccomp mode 2 (filter), docker-default AppArmor, no_new_privs,
//                                             empty capability sets
//   emulator <pid>                            the pid owns 127.0.0.1:8080 and the protected projects behave,
//                                             all within one 120 s monotonic budget
//   identity <pid>                            stable pid:start-time:inode identity of that listener
//   results <vitest.json> <expected> <root>   <expected> is the archive-derived suite inventory; protected
//                                             files exist with exact case counts, all passed
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
// One budget for the whole emulator check: readiness polling and the marker and reset calls share it.
const EMULATOR_BUDGET_MS = 120000;
const REQUEST_CAP_MS = 3000;
const DOCKER_DEFAULT_APPARMOR = 'docker-default (enforce)';
const UDP_REPLY = 'canary-udp-hit\n';

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

// One datagram. An unreachable error passes; a send that completes fails. The canary logs a hit
// for any datagram that reaches it, which is how the owned bridge negative shows the probe catches reachability.
function udpExpect(host, port, family) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    s.once('error', e => { s.close(); reject(new Error(`udp ${host}:${port}: ${e.code}`)); });
    s.send(Buffer.from('nsmcp-probe'), port, host, err => {
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

function checkTarget(host, port, family) {
  assert.ok(net.isIP(host), 'target must be an IP literal');
  assert.match(port, /^\d+$/);
  assert.ok(family === '4' || family === '6', 'family must be 4 or 6');
  return { host, port: Number(port), family: Number(family) };
}

async function probeTcp(host, port, family) {
  const t = checkTarget(host, port, family);
  await connectExpect(t.host, t.port, t.family, UNREACHABLE);
}

async function probeUdp(host, port, family) {
  const t = checkTarget(host, port, family);
  await udpExpect(t.host, t.port, t.family);
}

function reachTcp(gateway, port) {
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

// The UDP canary echoes a fixed reply to the sender. Receiving it proves the datagram reached the host.
function reachUdp(gateway, port) {
  assert.ok(net.isIPv4(gateway), 'gateway must be IPv4');
  assert.match(port, /^\d+$/);
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => { s.close(); reject(new Error('udp canary reply timed out')); }, REQUEST_CAP_MS);
    s.once('error', e => { clearTimeout(timer); s.close(); reject(new Error(`udp canary: ${e.code}`)); });
    s.once('message', msg => {
      clearTimeout(timer);
      s.close();
      if (msg.toString('utf8') === UDP_REPLY) resolve();
      else reject(new Error(`udp canary reply: ${JSON.stringify(msg.toString('utf8'))}`));
    });
    s.send(Buffer.from('nsmcp-probe'), Number(port), gateway, err => {
      if (err) { clearTimeout(timer); s.close(); reject(new Error(`udp canary send: ${err.code}`)); }
    });
  });
}

// Reads NAME=value pairs from a NUL-separated environment file, or from this process when no file is given.
function environment(file) {
  if (!file) return { ...process.env };
  const pairs = {};
  for (const entry of fs.readFileSync(file, 'latin1').split('\0')) {
    if (!entry) continue;
    const i = entry.indexOf('=');
    assert.ok(i > 0, 'malformed environment entry');
    pairs[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return pairs;
}

function checkEnv(file) {
  const env = environment(file);
  const names = Object.keys(env);
  const denied = names.filter(n => DENIED_ENV.some(r => r.test(n)));
  assert.deepEqual(denied, [], `denied environment names: ${denied.join(',')}`);
  const unknown = names.filter(n => !ALLOWED_ENV.has(n));
  assert.deepEqual(unknown, [], `unlisted environment names: ${unknown.join(',')}`);
  assert.equal(env.HOME, '/work/home', 'HOME is not /work/home');
  assert.equal(env.LANG, 'C', 'LANG is not C');
}

function checkStatus() {
  const s = fs.readFileSync('/proc/self/status', 'utf8');
  const get = k => {
    const m = new RegExp(`^${k}:\\s*(\\S+)`, 'm').exec(s);
    assert(m, `missing ${k}`);
    return m[1];
  };
  // Seccomp mode 2 proves a filter is loaded in filter mode. It does not prove Docker's default
  // profile is the one loaded; the AppArmor label below is the only profile identity checked here.
  assert.equal(get('Seccomp'), '2', 'seccomp mode is not 2 (filter)');
  assert.equal(get('NoNewPrivs'), '1', 'no_new_privs is not set');
  for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    assert.match(get(k), /^0+$/, `${k} is not empty`);
  }
  assert.equal(readOptional('/proc/self/attr/current').trim(), DOCKER_DEFAULT_APPARMOR,
    'AppArmor profile is not docker-default');
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

// Every request is capped at 3 s and at whatever remains of the shared emulator deadline.
function remaining(deadline) {
  const left = deadline - performance.now();
  if (left <= 0) throw new Error('emulator check exceeded its 120 s budget');
  return left;
}

async function request(url, deadline, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(Math.min(REQUEST_CAP_MS, remaining(deadline))) });
}

async function probe8081() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8081, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}

async function emulator(pid) {
  assert.match(pid, /^\d+$/);
  const deadline = performance.now() + EMULATOR_BUDGET_MS;
  await probe8081();
  let ready = false;
  while (performance.now() < deadline) {
    if (!fs.existsSync(`/proc/${pid}`)) throw new Error('emulator exited before becoming ready');
    if (ownerOf8080(pid)) {
      try {
        const r = await request('http://127.0.0.1:8080/', deadline);
        await r.text();
        ready = true;
        break;
      } catch {}
    }
    await sleep(Math.min(250, Math.max(0, deadline - performance.now())));
  }
  assert(ready, 'emulator not ready within 120 s, or the process does not own port 8080');
  for (const project of ['firestore-test', 'demo-netsapiens-cutover']) {
    const root = `http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents`;
    const reset = `http://127.0.0.1:8080/emulator/v1/projects/${project}/databases/(default)/documents`;
    const doc = `${root}/proof_boundary/marker`;
    const json = { 'content-type': 'application/json' };
    let r = await request(doc, deadline, { method: 'PATCH', headers: json, body: JSON.stringify({ fields: { marker: { stringValue: 'disposable-proof' } } }) });
    assert(r.ok, `marker write failed: ${project} ${r.status}`);
    r = await request(doc, deadline);
    assert(r.ok, `marker read failed: ${project}`);
    assert.equal((await r.json()).fields.marker.stringValue, 'disposable-proof');
    r = await request(doc, deadline, { method: 'DELETE' });
    assert(r.ok, `marker delete failed: ${project}`);
    r = await request(doc, deadline);
    assert.equal(r.status, 404, `marker survived deletion: ${project}`);
    r = await request(doc, deadline, { method: 'PATCH', headers: json, body: JSON.stringify({ fields: { marker: { stringValue: 'reset-proof' } } }) });
    assert(r.ok, `reset marker write failed: ${project}`);
    r = await request(doc, deadline);
    assert(r.ok && (await r.json()).fields.marker.stringValue === 'reset-proof', `reset marker read failed: ${project}`);
    r = await request(reset, deadline, { method: 'DELETE' });
    assert(r.ok, `emulator reset failed: ${project} ${r.status}`);
    r = await request(doc, deadline);
    assert.equal(r.status, 404, `marker survived reset: ${project}`);
  }
  assert(ownerOf8080(pid), 'emulator no longer owns port 8080');
  await probe8081();
}

function results(file, expectedFile, root) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.success, true, 'Vitest reported failure');
  assert.equal(data.numFailedTests, 0, 'failed test aggregate');
  assert.equal(data.numFailedTestSuites, 0, 'failed suite aggregate');
  if (data.numRuntimeErrorTestSuites !== undefined) assert.equal(data.numRuntimeErrorTestSuites, 0, 'runtime suite errors');
  if (data.errors !== undefined) assert(Array.isArray(data.errors) && data.errors.length === 0, 'unhandled errors');
  assert(Array.isArray(data.testResults), 'missing testResults');

  // The expected inventory comes from the digest-pinned archive list, never from walking the working tree.
  const expected = fs.readFileSync(expectedFile, 'utf8').split('\n').filter(Boolean)
    .map(rel => path.resolve(root, rel));
  assert(expected.length > 0, 'empty suite inventory');
  const actual = data.testResults.map(x => path.resolve(x.name));
  assert.equal(new Set(actual).size, actual.length, 'duplicate suite result');
  assert.deepEqual([...actual].sort(), [...expected].sort(), 'selected suite inventory mismatch');

  const assertions = data.testResults.flatMap(x => x.assertionResults || []);
  assert.equal(data.numTotalTests, assertions.length, 'test count mismatch');
  assert.equal(data.numPassedTests, assertions.filter(x => x.status === 'passed').length, 'passed test count mismatch');
  assert.equal(data.numPendingTests, assertions.filter(x => ['pending', 'skipped', 'todo'].includes(x.status)).length, 'pending test count mismatch');
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
  const [mode, a, b, c] = process.argv.slice(2);
  if (mode === 'boundary') await boundary(a, b);
  else if (mode === 'probe-tcp') await probeTcp(a, b, c);
  else if (mode === 'probe-udp') await probeUdp(a, b, c);
  else if (mode === 'reach') await reachTcp(a, b);
  else if (mode === 'reach-udp') await reachUdp(a, b);
  else if (mode === 'env') checkEnv(a);
  else if (mode === 'status') checkStatus();
  else if (mode === 'emulator') await emulator(a);
  else if (mode === 'identity') { console.log(emulatorIdentity(a)); return; }
  else if (mode === 'results') results(a, b, c);
  else throw new Error('unknown mode');
  console.log(`${mode}: passed`);
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
});
