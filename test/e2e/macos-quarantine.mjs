// Run on a logged-in Mac: node test/e2e/macos-quarantine.mjs
// A test app enables the same Launch Services quarantine flag as Chrome.
// The direct file must be quarantined; host and shell output must not be.
// Fixtures stay in the printed temporary directory for inspection.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

assert.equal(process.platform, "darwin", "This check requires macOS.");
const dir = mkdtempSync(join(tmpdir(), "studio-quarantine-check-"));
const app = join(dir, "QuarantineCheck.app");
mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
const modulePath = fileURLToPath(new URL("../../src/host/codex-spawn.mjs", import.meta.url));
const resultPath = join(dir, "result.json");
const entry = join(dir, "parent.mjs");
const helper = join(dir, "helper.mjs");
writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundleIdentifier</key><string>build.lizard.quarantine-check</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSFileQuarantineEnabled</key><true/>
</dict></plist>`);
writeFileSync(join(dir, "run.m"), `#import <Cocoa/Cocoa.h>
#include <unistd.h>
int main(void) { @autoreleasepool { [NSApplication sharedApplication]; execl(${JSON.stringify(process.execPath)}, "node", ${JSON.stringify(entry)}, (char *)0); } return 127; }
`);
execFileSync("/usr/bin/clang", [join(dir, "run.m"), "-framework", "Cocoa", "-o", join(app, "Contents", "MacOS", "run")]);
writeFileSync(helper, `import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (process.env.LIZARD_STUDIO_ROUTER_PID !== String(process.ppid)) throw new Error('incorrect parent marker');
writeFileSync('host.so', 'fixture');
execFileSync('/bin/sh', ['-c', 'printf fixture > shell.so']);
process.stdin.once('data', b => { process.stdout.write(b, () => process.exit(0)); });
`);
writeFileSync(entry, `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHostSpawner } from ${JSON.stringify(modulePath)};
const dir = ${JSON.stringify(dir)};
const launcher = createHostSpawner({ hostDir: dir });
const timer = setTimeout(() => { writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: 'timeout' })); process.exit(1); }, 20000);
function attrs(path) { return execFileSync('/usr/bin/xattr', [path], { encoding: 'utf8' }).trim().split('\\n'); }
try {
  writeFileSync(dir + '/direct.so', 'fixture');
  const direct = attrs(dir + '/direct.so');
  assert.ok(direct.includes('com.apple.quarantine'), 'test app did not reproduce Chrome quarantine');
  const child = launcher.spawn(process.execPath, [${JSON.stringify(helper)}], { cwd: dir, env: { ...process.env, LIZARD_STUDIO_ROUTER_PID: String(process.pid) } });
  const chunks = [];
  child.stdout.on('data', b => chunks.push(b));
  child.stderr.on('data', b => process.stderr.write(b));
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('helper exit ' + code))); });
  const frame = Buffer.from([4, 0, 0, 0, 0, 127, 128, 255]);
  child.stdin.write(frame);
  await exited;
  assert.deepEqual(Buffer.concat(chunks), frame, 'relay changed native messaging bytes');
  const host = attrs(dir + '/host.so'), shell = attrs(dir + '/shell.so');
  assert.ok(!host.includes('com.apple.quarantine'), 'host inherited quarantine');
  assert.ok(!shell.includes('com.apple.quarantine'), 'shell inherited quarantine');
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ok: true, direct, host, shell }));
} catch (err) {
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: err.stack }));
} finally {
  clearTimeout(timer);
  launcher.close();
}
`);
console.log("Fixtures:", dir);
execFileSync("/usr/bin/open", ["-n", "-W", app], { timeout: 30000 });
assert.ok(existsSync(resultPath), "Test app did not write a result.");
const result = JSON.parse(readFileSync(resultPath, "utf8"));
console.log(result);
assert.equal(result.ok, true, result.error);
