import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, SourceTextModule, SyntheticModule, runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';

const claudeSource = readFileSync(new URL('../../src/host/claude-host.mjs', import.meta.url), 'utf8');

async function boot(env) {
  const context = createContext({ process: { env, ppid: 42 }, hostEntered: false, routerEntered: false });
  const source = claudeSource.slice(0, claudeSource.indexOf('// Sibling MCP relay')) + '\nglobalThis.hostEntered = true;';
  const module = new SourceTextModule(source, {
    context,
    initializeImportMeta: (meta) => { meta.url = 'file:///test/claude-host.mjs'; },
    importModuleDynamically: async (name) => {
      assert.equal(name, './router.mjs');
      const router = new SyntheticModule([], function () { context.routerEntered = true; }, { context });
      await router.link(() => {}); await router.evaluate();
      return router;
    },
  });
  await module.link(async (name) => {
    const actual = await import(name);
    const values = { ...actual };
    if (name === 'node:fs') values.existsSync = () => true;
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  const evaluation = module.evaluate();
  await new Promise((resolve) => setImmediate(resolve));
  if (context.hostEntered) await evaluation;
  return context;
}

test('legacy Claude entry point starts only the router before any host side effects', async () => {
  const context = await boot({});
  assert.equal(context.routerEntered, true);
  assert.equal(context.hostEntered, false);
});

test('router child runs Claude without recursively opening another router', async () => {
  const context = await boot({ LIZARD_STUDIO_ROUTER_PID: '42' });
  assert.equal(context.routerEntered, false);
  assert.equal(context.hostEntered, true);
});

test('a stale inherited router marker cannot bypass the legacy entry point', async () => {
  const context = await boot({ LIZARD_STUDIO_ROUTER_PID: '99' });
  assert.equal(context.routerEntered, true);
  assert.equal(context.hostEntered, false);
});

test('router sends ChatGPT workspace requests to Codex and shared folder requests to Claude', async () => {
  const spawned = [], timers = [];
  const proc = new EventEmitter();
  Object.assign(proc, { pid: 42, execPath: '/test/node', env: { PATH: '/test/bin' }, stdin: new EventEmitter(), stdout: new EventEmitter() });
  proc.stdout.write = () => {};
  const imports = {
    'node:child_process': { spawn: (bin, args, options) => {
      const child = new EventEmitter();
      Object.assign(child, { stdin: { write: (frame) => child.written.push(JSON.parse(frame.toString())) }, stdout: new EventEmitter(), stderr: new EventEmitter(), written: [] });
      spawned.push({ bin, args, options, child });
      return child;
    } },
    'node:fs': { existsSync: () => true },
    'node:path': path,
    './hostkit.mjs': { HOST_DIR: '/test', makeLog: () => () => {}, frameReader: () => () => {}, frameRaw: (raw) => raw, writeFrame: () => {} },
  };
  const context = createContext({ process: proc, Buffer, setTimeout: (fn) => { timers.push(fn); return { unref() {} }; } });
  const module = new SourceTextModule(readFileSync(new URL('../../src/host/router.mjs', import.meta.url), 'utf8') + '\nexport { route };', { context });
  await module.link((name) => {
    const values = imports[name];
    assert.ok(values, name);
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const send = (message) => { const text = JSON.stringify(message); module.namespace.route(Buffer.from(text), text); };
  send({ type: 'start', id: 'a', agent: 'codex', permissionMode: 'workspace' });
  send({ type: 'restartSession', id: 'a', permissionMode: 'workspace' });
  send({ type: 'pickFolder', id: 'a', agent: 'codex' });
  assert.equal(spawned.length, 2);
  const [claude, codex] = spawned;
  assert.equal(claude.args[0], '/test/claude-host.mjs');
  assert.equal(codex.args[0], '/test/codex-host.mjs');
  assert.equal(claude.options.env.LIZARD_STUDIO_ROUTER_PID, '42');
  assert.equal(claude.options.env.PATH, '/test/bin');
  assert.deepEqual(codex.child.written.map((m) => m.type), ['start', 'restartSession']);
  assert.deepEqual(claude.child.written.map((m) => m.type), ['pickFolder']);
  assert.equal(codex.child.written[0].permissionMode, 'workspace');
});

test('Claude refuses misrouted agent operations without touching sessions', () => {
  const messages = [];
  const source = claudeSource.slice(claudeSource.indexOf('function handle(msg)'), claudeSource.indexOf('function shutdown(code)'));
  const context = { send: (m) => messages.push(m) };
  runInNewContext(source + '\nglobalThis.handle = handle;', context);
  for (const type of ['start', 'restartSession', 'prompt', 'rewind', 'permissionResult']) {
    context.handle({ type, agent: 'codex', id: 'a', permissionMode: 'workspace' });
  }
  assert.equal(messages.length, 5);
  assert.ok(messages.every((m) => m.code === 'AGENT_ROUTING_REQUIRED'));
});

test('Claude rejects foreign permission modes before killing or spawning a session', () => {
  const messages = [];
  const source = claudeSource.slice(claudeSource.indexOf('function startClaude('), claudeSource.indexOf('// Claude pids we killed'));
  const context = { send: (m) => messages.push(m) };
  runInNewContext(source + '\nglobalThis.startClaude = startClaude;', context);
  for (const permissionMode of ['workspace', 'read-only', 'full', 'unknown']) context.startClaude({ id: 'a', permissionMode });
  assert.equal(messages.length, 4);
  assert.ok(messages.every((m) => m.code === 'INVALID_PERMISSION_MODE'));
});
