import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/host/claude-host.mjs', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('// ---- model discovery'), source.indexOf('// ---- claude process management'));
const reader = source.slice(source.indexOf('function lineJsonReader('), source.indexOf('// Host protocol version'));
function setup() {
  const sent = [], children = [], timers = new Set();
  const scope = {
    homedir: () => '/home', CHILD_ENV: { CLI: 'environment' },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    send(msg) { sent.push(JSON.parse(JSON.stringify(msg))); },
    spawnClaude(args, opts) {
      const child = new EventEmitter();
      Object.assign(child, { args, opts, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        requests: [], killed: false, kill() { this.killed = true; } });
      child.stdin.on('data', chunk => child.requests.push(JSON.parse(chunk)));
      children.push(child);
      return child;
    },
  };
  vm.createContext(scope); vm.runInContext(reader + code, scope);
  function reply(payload, child = children.at(-1)) {
    const frame = JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: 'model-catalog', response: payload,
    } }) + '\n';
    child.stdout.emit('data', frame.slice(0, 17));
    child.stdout.emit('data', frame.slice(17));
  }
  return { scope, sent, children, timers, reply };
}
const models = [
  { value: 'default', displayName: 'Default', resolvedModel: 'claude-next[1m]' },
  { value: 'new-model[1m]', displayName: 'New model', description: 'CLI description' },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-next' },
];

test('model discovery uses initialize only, deduplicates calls and preserves CLI aliases', () => {
  const { scope, sent, children, timers, reply } = setup();
  scope.refreshModels('/project'); scope.refreshModels('/project');
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.opts.cwd, '/project');
  assert.equal(child.opts.env.CLI, 'environment');
  assert.ok(child.args.includes('--no-session-persistence'));
  assert.ok(child.args.includes('--strict-mcp-config'));
  assert.deepEqual(child.requests, [{ type: 'control_request', request_id: 'model-catalog', request: { subtype: 'initialize' } }]);
  reply({ models: [...models, models[1], null, { value: '', displayName: 'Bad' }] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agent, 'claude');
  assert.equal(sent[0].defaultModel, 'default');
  assert.deepEqual(sent[0].models.map(m => m.id), ['default', 'new-model[1m]', 'sonnet']);
  assert.equal(sent[0].models[0].contextLimit, 1000000);
  assert.equal(sent[0].models[1].description, 'CLI description');
  assert.equal(child.killed, true);
  assert.equal(timers.size, 0);
  child.emit('exit', 0);
  assert.equal(sent.length, 1);
  scope.refreshModels();
  assert.equal(children.length, 2);
  assert.equal(children[1].opts.cwd, '/home');
});

test('invalid responses, spawn errors, early exit, broken stdin and timeouts allow retry', () => {
  for (const failure of ['invalid', 'exit', 'error', 'stdin', 'timeout', 'throw']) {
    const { scope, sent, children, timers, reply } = setup();
    const spawn = scope.spawnClaude;
    if (failure === 'throw') scope.spawnClaude = () => { throw Error('not found'); };
    scope.refreshModels();
    if (failure === 'invalid') reply({ models: [] });
    if (failure === 'exit') children[0].emit('exit', 1);
    if (failure === 'error') children[0].emit('error', Error('spawn failed'));
    if (failure === 'stdin') children[0].stdin.emit('error', Error('EPIPE'));
    if (failure === 'timeout') [...timers][0]();
    assert.equal(sent[0].type, 'modelsError', failure);
    assert.equal(timers.size, 0, failure);
    scope.spawnClaude = spawn;
    scope.refreshModels(); reply({ models });
    assert.equal(sent.at(-1).type, 'models', failure);
  }
});

test('unrelated responses cannot complete discovery and shutdown cancels its process', () => {
  const { scope, sent, children, timers } = setup();
  scope.refreshModels();
  children[0].stdout.emit('data', JSON.stringify({ type: 'control_response', response: { request_id: 'other', subtype: 'success', response: { models } } }) + '\n');
  assert.equal(sent.length, 0);
  assert.equal(timers.size, 1);
  vm.runInContext('modelProbe.cancel()', scope);
  assert.equal(children[0].killed, true);
  assert.equal(timers.size, 0);
  assert.equal(sent.length, 0);
});
