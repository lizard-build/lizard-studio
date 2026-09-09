// Older self-updaters copy mcp-browser.mjs but do not know about new files.
// Keep that entry point self-contained. Source stays in a small testable module.
import { readFileSync, writeFileSync } from "node:fs";
const source = readFileSync(new URL("../src/host/browser-workflows.mjs", import.meta.url), "utf8");
const target = new URL("../src/host/mcp-browser.mjs", import.meta.url);
const start = "// BEGIN GENERATED BROWSER WORKFLOWS";
const end = "// END GENERATED BROWSER WORKFLOWS";
const bundle = start + "\n// Regenerate with npm run build:browser. Do not edit this block.\n" +
  "const { WORKFLOW_TOOLS, createWorkflowRunner } = (() => {\n" + source.replace(/^export /gm, "") +
  "\nreturn { WORKFLOW_TOOLS, createWorkflowRunner };\n})();\n" + end;
const relay = readFileSync(target, "utf8");
const first = relay.indexOf(start), last = relay.indexOf(end);
if (first < 0 || last < first) throw new Error("Missing browser workflow bundle markers");
const updated = relay.slice(0, first) + bundle + relay.slice(last + end.length);
if (process.argv.includes("--check")) {
  if (updated !== relay) throw new Error("Browser workflow bundle is stale. Run npm run build:browser.");
} else writeFileSync(target, updated);
