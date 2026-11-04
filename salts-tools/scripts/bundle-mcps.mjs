// `npm pack` / `npm publish` (prepack): copy the MCP servers salts-tools runs into
// mcps/<name>, so the package works without the repo. Only what `uv sync` and the
// server need at run time goes in; postpack deletes the copy again.

import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const out = path.join(root, "mcps");

/** Per server, the files and folders it needs at run time. */
const SERVERS = {
  "matchmaker-mcp": ["pyproject.toml", "uv.lock", "src", "prompts"],
  "analyst-mcp": ["pyproject.toml", "uv.lock", "src"],
  "zcash-wallet-mcp": ["pyproject.toml", "uv.lock", "src"],
};

const skip = (src) => !/(__pycache__|\.pyc$|\.egg-info|\.DS_Store)/.test(src);

rmSync(out, { recursive: true, force: true });
if (process.argv[2] === "clean") process.exit(0);

for (const [name, entries] of Object.entries(SERVERS)) {
  const from = path.join(root, "..", "local-mcps", name);
  for (const entry of entries) {
    const src = path.join(from, entry);
    if (!existsSync(src)) throw new Error(`missing ${src}`);
    cpSync(src, path.join(out, name, entry), { recursive: true, filter: skip });
  }
}
console.log(`bundled ${Object.keys(SERVERS).join(", ")} into ${out}`);
