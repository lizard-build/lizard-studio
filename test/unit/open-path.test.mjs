import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/host/claude-host.mjs", import.meta.url), "utf8");
const code = source.slice(source.indexOf("const LAUNCHABLE_EXT"), source.indexOf("function openPath("));
const scope = { realpathSync, statSync, process, Set };
vm.createContext(scope);
vm.runInContext(code + "\n;this.isLaunchable = isLaunchable;", scope);

test("transcript links to programs are revealed, never launched", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-path-"));
  const file = (name, mode = 0o644) => { const p = join(dir, name); writeFileSync(p, "x"); chmodSync(p, mode); return p; };
  for (const name of ["run.command", "x.sh", "setup.EXE", "a.desktop", "b.AppImage", "c.jar", "d.ps1", "e.lnk", "f.url", "g.pkg", "h.dmg", "i.scpt"]) {
    assert.equal(scope.isLaunchable(file(name)), true, name);
  }
  const app = join(dir, "Evil.app"); mkdirSync(app);
  assert.equal(scope.isLaunchable(app), true, ".app bundle");
  if (process.platform !== "win32") assert.equal(scope.isLaunchable(file("noext", 0o755)), true, "exec bit");
  for (const name of ["notes.md", "index.html", "photo.png", "report.pdf"]) assert.equal(scope.isLaunchable(file(name)), false, name);
  assert.equal(scope.isLaunchable(dir), false, "a plain folder opens");
});
