// Where the MCP servers' sources live, and how this CLI is launched again at login.
//
// From a clone of the repo, each MCP server runs in place from ../local-mcps/<name>.
// From npm (`npx salts-tools`), the package carries a copy under mcps/<name> (see
// scripts/bundle-mcps.mjs). The npx cache can be cleared at any time, so that copy is
// installed into ~/.salts-tools/mcps/<name> and runs from there, with its own .venv,
// .env and data beside it.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Kept in an installed copy across updates: the user's settings, data and environment. */
export const KEPT = new Set([".venv", ".env", "data"]);
const MARKER = ".salts-tools-version";

/**
 * The folder each MCP server `dir` (e.g. "matchmaker-mcp") runs from, and the packaged
 * copy to install there first (undefined when it runs in place from the repo).
 */
export function mcpSource(here, dir, installRoot) {
  const repo = path.join(here, "..", "local-mcps", dir);
  if (existsSync(path.join(repo, "pyproject.toml"))) return { dir: repo };
  return { dir: path.join(installRoot, dir), bundled: path.join(here, "mcps", dir) };
}

/**
 * Copy the packaged `bundled` source into `target` unless it already holds `version`.
 * What the user keeps there (KEPT) is left alone. Returns whether anything was copied,
 * so the caller knows to `uv sync` again.
 */
export function installMcp(bundled, target, version) {
  const marker = path.join(target, MARKER);
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === version) return false;
  if (!existsSync(path.join(bundled, "pyproject.toml"))) {
    throw new Error(`This salts-tools package is missing ${bundled}. Reinstall it.`);
  }
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(target)) {
    if (!KEPT.has(name)) rmSync(path.join(target, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(bundled)) {
    if (!KEPT.has(name)) cpSync(path.join(bundled, name), path.join(target, name), { recursive: true });
  }
  writeFileSync(marker, version);
  return true;
}

/** Whether `cli` is running out of npm's npx cache rather than an install or a clone. */
export const viaNpx = (cli) => /[\\/]_npx[\\/]/.test(cli);

/**
 * The program and arguments a login item runs to start this CLI again. Out of the npx
 * cache it goes through npx (beside node), since that cache can be cleared; otherwise it
 * runs this file with this node.
 */
export function launchArgs({ cli, execPath, platform }) {
  if (!viaNpx(cli)) return [execPath, cli];
  const npx = path.join(path.dirname(execPath), platform === "win32" ? "npx.cmd" : "npx");
  return [npx, "--yes", "--prefer-offline", "salts-tools"];
}

/**
 * The zingo-cli binary the Zcash wallet server will use, or "" when it isn't built yet.
 *
 * The server resolves it itself, in this same order, so this only has to answer whether it can:
 * `ZINGO_CLI_BIN` in the environment, then in the server's own `.env` (what the user edits), then
 * a `zingo-cli` on PATH. A path that names nothing counts as not built.
 */
export function zingoCli({ dir, env = process.env, have }) {
  for (const named of [env.ZINGO_CLI_BIN, envValue(path.join(dir, ".env"), "ZINGO_CLI_BIN")]) {
    if (named && existsSync(named)) return named;
  }
  return have("zingo-cli") ? "zingo-cli" : "";
}

/** `name`'s value in a dotenv file: last one wins, comments and surrounding quotes dropped. */
export function envValue(file, name) {
  let found = "";
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
      if (m) found = m[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    return "";
  }
  return found;
}
