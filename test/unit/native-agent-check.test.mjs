import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped dispatchers without starting a CLI or touching the Mac.
for (const agent of ['claude', 'codex']) {
  test(`${agent} installation can be rechecked without replacing running sessions`, () => {
    const source = readFileSync(new URL(`../../src/host/${agent}-host.mjs`, import.meta.url), 'utf8');
    const start = source.indexOf('function handle(msg)');
    const end = source.indexOf(agent === 'claude' ? 'function shutdown(code)' : 'const rateLimits = new Map();', start);
    const announcement = agent === 'claude'
      ? source.slice(source.indexOf('function announceAgent()'), source.indexOf('\nannounceAgent();'))
      : source.slice(source.indexOf('function announce()'), source.indexOf('// ---- browser bridge'));
    let installed = false;
    const sent = [];
    const sessions = new Map([['running', { running: true, text: 'partial reply' }]]);
    const current = sessions.get('running');
    const scope = {
      CLAUDE: 'claude', CODEX: '', HOST_VERSION: 41, CODEX_HOST_VERSION: 12, sessions,
      resolveClaude: () => installed ? '/test/bin/claude' : 'claude',
      resolveCodex: () => installed ? '/test/bin/codex' : '',
      existsSync: (path) => installed && path === '/test/bin/claude',
      homedir: () => '/test/home', osUserName: () => 'test',
      send: (message) => sent.push(JSON.parse(JSON.stringify(message))),
    };
    vm.createContext(scope);
    vm.runInContext(announcement + source.slice(start, end), scope);
    scope.handle({ type: 'checkAgent', agent });
    assert.equal(sent.at(-1).ok, false);
    installed = true;
    scope.handle({ type: 'checkAgent', agent });
    assert.equal(sent.at(-1).ok, true);
    assert.equal(sent.at(-1).type, agent === 'claude' ? 'ready' : 'agentReady');
    assert.equal(sent.at(-1)[`${agent}Path`], `/test/bin/${agent}`);
    assert.equal(sessions.get('running'), current);
    assert.equal(current.text, 'partial reply');
  });
}
