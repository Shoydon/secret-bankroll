import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { installMcp, launchArgs, mcpSource, viaNpx, zingoCli } from "../mcps.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "salts-mcps-"));

test("mcpSource runs in place from a clone, and from an installed copy out of npm", () => {
  const repo = tmp();
  const here = path.join(repo, "salts-tools");
  mkdirSync(path.join(repo, "local-mcps", "analyst-mcp"), { recursive: true });
  writeFileSync(path.join(repo, "local-mcps", "analyst-mcp", "pyproject.toml"), "");
  assert.deepEqual(mcpSource(here, "analyst-mcp", "/root"), {
    dir: path.join(repo, "local-mcps", "analyst-mcp"),
  });

  const pkg = path.join(tmp(), "salts-tools");
  assert.deepEqual(mcpSource(pkg, "analyst-mcp", "/root"), {
    dir: path.join("/root", "analyst-mcp"),
    bundled: path.join(pkg, "mcps", "analyst-mcp"),
  });
});

test("installMcp copies a new version over the old and keeps the user's .env, data and .venv", () => {
  const bundled = tmp();
  const target = path.join(tmp(), "analyst-mcp");
  writeFileSync(path.join(bundled, "pyproject.toml"), "v1");

  assert.equal(installMcp(bundled, target, "1.0.0"), true);
  assert.equal(readFileSync(path.join(target, "pyproject.toml"), "utf8"), "v1");
  assert.equal(installMcp(bundled, target, "1.0.0"), false, "same version: nothing to do");

  for (const kept of [".venv", "data"]) mkdirSync(path.join(target, kept));
  writeFileSync(path.join(target, ".env"), "ALLOW_PYTHON=true");
  writeFileSync(path.join(target, "old.py"), "");
  writeFileSync(path.join(bundled, "pyproject.toml"), "v2");

  assert.equal(installMcp(bundled, target, "1.1.0"), true);
  assert.equal(readFileSync(path.join(target, "pyproject.toml"), "utf8"), "v2");
  assert.equal(readFileSync(path.join(target, ".env"), "utf8"), "ALLOW_PYTHON=true");
  assert.ok(existsSync(path.join(target, ".venv")) && existsSync(path.join(target, "data")));
  assert.ok(!existsSync(path.join(target, "old.py")), "files the new version dropped go");
});

test("installMcp refuses a package with no bundled server", () => {
  assert.throws(() => installMcp(tmp(), path.join(tmp(), "x"), "1.0.0"), /missing/);
});

test("a login item starts a clone or install directly, and an npx run through npx", () => {
  const cli = "/home/u/salts-agent/salts-tools/cli.mjs";
  assert.deepEqual(launchArgs({ cli, execPath: "/usr/bin/node", platform: "linux" }), ["/usr/bin/node", cli]);

  const cached = "/home/u/.npm/_npx/ab12/node_modules/salts-tools/cli.mjs";
  assert.ok(viaNpx(cached) && !viaNpx(cli));
  assert.deepEqual(launchArgs({ cli: cached, execPath: "/opt/node/bin/node", platform: "darwin" }), [
    "/opt/node/bin/npx",
    "--yes",
    "--prefer-offline",
    "salts-tools",
  ]);
});

test("zingoCli finds the binary from the environment, then the server's .env, then PATH", () => {
  const dir = tmp();
  const built = path.join(dir, "built", "zingo-cli");
  mkdirSync(path.dirname(built), { recursive: true });
  writeFileSync(built, "");

  // ZINGO_CLI_BIN in the environment wins.
  assert.equal(zingoCli({ dir, env: { ZINGO_CLI_BIN: built }, have: () => false }), built);

  // Then the server's own .env, which is what the user edits.
  writeFileSync(path.join(dir, ".env"), `ZINGO_CHAIN=testnet\nZINGO_CLI_BIN=${built}\n`);
  assert.equal(zingoCli({ dir, env: {}, have: () => false }), built);

  // Then a zingo-cli on PATH, which the server resolves for itself.
  assert.equal(zingoCli({ dir: tmp(), env: {}, have: (cmd) => cmd === "zingo-cli" }), "zingo-cli");
});

test("zingoCli reports nothing when the binary isn't built yet", () => {
  assert.equal(zingoCli({ dir: tmp(), env: {}, have: () => false }), "");
});

test("zingoCli ignores a ZINGO_CLI_BIN pointing at a binary that isn't there", () => {
  const dir = tmp();
  writeFileSync(path.join(dir, ".env"), `ZINGO_CLI_BIN=${path.join(dir, "gone")}\n`);
  assert.equal(zingoCli({ dir, env: { ZINGO_CLI_BIN: path.join(dir, "also-gone") }, have: () => false }), "");
});

test("zingoCli reads a quoted and commented .env the way the server does", () => {
  const dir = tmp();
  const built = path.join(dir, "zingo-cli");
  writeFileSync(built, "");
  writeFileSync(path.join(dir, ".env"), `# ZINGO_CLI_BIN=/wrong\nZINGO_CLI_BIN="${built}"  \n`);
  assert.equal(zingoCli({ dir, env: {}, have: () => false }), built);
});
