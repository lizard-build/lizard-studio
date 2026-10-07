import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/host/claude-host.mjs", import.meta.url), "utf8");
const cut = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

// The smallest npm-style tarball the host's reader accepts: ustar headers with
// a name, an octal size and a regular-file flag, then two zero blocks.
function tarball(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const header = Buffer.alloc(512);
    header.write("package/src/host/" + name, 0);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function host({ installed, published }) {
  const dir = mkdtempSync(join(tmpdir(), "self-update-"));
  const current = `const HOST_VERSION = ${installed};\n// installed copy\n`;
  writeFileSync(join(dir, "claude-host.mjs"), current);
  writeFileSync(join(dir, "mcp-browser.mjs"), "// installed relay\n");
  const tgz = tarball({ "claude-host.mjs": `const HOST_VERSION = ${published};\n// registry copy\n`, "mcp-browser.mjs": "// registry relay\n" });
  const sent = [];
  let shutdowns = 0;
  const scope = {
    HOST_VERSION: installed, HERE: dir, join, existsSync, readFileSync, writeFileSync, renameSync, createHash, gunzipSync,
    sessions: new Map(), send: (m) => sent.push(JSON.parse(JSON.stringify(m))), log() {}, shutdown: () => { shutdowns++; },
    setTimeout: (fn) => { fn(); return 0; },
    fetchJson: async () => ({ version: "9.9.9", dist: { tarball: "https://registry.test/host.tgz",
      integrity: "sha512-" + createHash("sha512").update(tgz).digest("base64") } }),
    fetchBuffer: async () => tgz,
  };
  vm.createContext(scope);
  vm.runInContext(cut("const HOST_PKG", "// install.sh writes resolved binary paths"), scope);
  return { dir, sent, current, shutdowns: () => shutdowns, run: () => scope.selfUpdate("panel") };
}

test("an older registry release never replaces a helper installed from source", async () => {
  const h = host({ installed: 39, published: 37 });
  await h.run();
  assert.equal(readFileSync(join(h.dir, "claude-host.mjs"), "utf8"), h.current);
  assert.equal(readFileSync(join(h.dir, "mcp-browser.mjs"), "utf8"), "// installed relay\n");
  assert.deepEqual(h.sent.at(-1), { type: "selfUpdate", id: "panel", updated: false, version: "9.9.9" });
  assert.equal(h.shutdowns(), 0);
});

test("the same release number does not swap files either", async () => {
  const h = host({ installed: 39, published: 39 });
  await h.run();
  assert.equal(readFileSync(join(h.dir, "claude-host.mjs"), "utf8"), h.current);
  assert.equal(h.sent.at(-1).updated, false);
});

test("a newer registry release installs and restarts the helper", async () => {
  const h = host({ installed: 37, published: 40 });
  await h.run();
  assert.match(readFileSync(join(h.dir, "claude-host.mjs"), "utf8"), /HOST_VERSION = 40;/);
  assert.equal(readFileSync(join(h.dir, "mcp-browser.mjs"), "utf8"), "// registry relay\n");
  assert.deepEqual(h.sent.at(-1), { type: "selfUpdate", id: "panel", updated: true, restarting: true, version: "9.9.9" });
  assert.equal(h.shutdowns(), 1);
});
