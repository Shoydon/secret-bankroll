#!/usr/bin/env node
// salts-tools: local services for a salt-agent, from this laptop, behind one tunnel.
//
// Runs the services below, puts them on the internet through a single cloudflared quick
// tunnel (no account needed), and reports to the Worker. Every service shares the
// tunnel's address and is told apart by path (see gateway.mjs): `<tunnel>/web` is
// SearXNG, `<tunnel>/matchmaker` the matchmaker MCP server, `<tunnel>/analyst` the
// spreadsheet analyst MCP server, `<tunnel>/coinbase-wallet` Coinbase's wallet MCP
// server (Payments MCP) and `<tunnel>/zcash-wallet` the Zcash wallet MCP server (zingo-cli).
//
// The computer is paired once from the browser: `start` shows a code and opens the Salts
// site, where the signed-in user picks the agents it serves. From then on a supervisor
// reports every 30 seconds (tunnel address, gateway token, what each tool needs) and the
// Worker answers with the tools switched on for those agents, which it runs. Tools are
// switched on and off per agent on the site; the Worker keeps each agent pointed at the
// tunnel. Nothing is ever copied by hand.
//
//   salts-tools           start if needed (pairing on first run), then the dashboard
//   salts-tools start     check the machine, pair on first run, start the supervisor
//   salts-tools stop      stop everything: the supervisor, the tunnel and the containers
//   salts-tools restart   bring the tunnel up again on a new address
//   salts-tools reset     disconnect this computer and forget everything (keeps data)
//   salts-tools autostart on|off
//                         start at login, or stop doing so (a LaunchAgent on macOS, a
//                         systemd user unit on Linux, a Startup-folder script on Windows)
//
// Every command takes a `:staging` suffix (`start:staging`, `stop:staging`, …) to run
// against the staging Worker and site instead of production. The two are separate
// instances — own credential, state, containers, ports, tunnel and login item — and can
// run side by side.
//
// Two secrets, both in the OS secret store (the macOS Keychain, the Secret Service keyring
// on Linux via `secret-tool`, a DPAPI-encrypted file on Windows, or a file only this user
// can read on a Linux machine with no keyring), never in argv and never shown:
// - the gateway token, made here: the gateway, SearXNG's Caddy gate and each MCP server
//   (as its MCP_AUTH_TOKEN) check it, and the Worker puts it on the agents' side;
// - this computer's credential, handed over once by the Worker when the user approved
//   the pairing, which proves the reports come from here.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { agentIdFrom, call, openCommand, startPairing, toolsReport, waitForApproval, wantedServices } from "./computer.mjs";
import { startGateway } from "./gateway.mjs";
import { envValue, installMcp, launchArgs, mcpSource, viaNpx, zingoCli } from "./mcps.mjs";
import { installCoinbaseWallet } from "./coinbase-wallet.mjs";
import { caffeinateArgs, codeFingerprint, orphanTunnels, parseProcessList, supervisorsOf } from "./procs.mjs";
import { connectionStatus, serviceStatus } from "./status.mjs";
import { startStdioBridge } from "./stdio-bridge.mjs";
import { BOLD, DIM, INV, OFF, follow, keys, paint, rowText, wrap } from "./tui.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = fileURLToPath(import.meta.url);
const VERSION = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")).version;
/** The code this process runs; a supervisor saves it, so an outdated one can be replaced. */
const CODE = codeFingerprint(here);
/** How the user runs this CLI, for the commands it tells them to run. */
const SELF = viaNpx(CLI) ? "npx salts-tools" : "salts-tools";
/** The login item's program and arguments, before the command. */
const LAUNCH = launchArgs({ cli: CLI, execPath: process.execPath, platform: process.platform });

const [command = "", ...args] = process.argv.slice(2);
const [cmd, TARGET = "production"] = command.split(":");

/** Per target: the Worker it pushes to, and the suffix that keeps its resources apart. */
const TARGETS = {
  production: {
    worker: "https://api.salts.dev",
    app: "https://app.salts.dev",
    suffix: "",
  },
  staging: {
    worker: "https://api-staging.salts.dev",
    app: "https://staging.salts.dev",
    suffix: "-staging",
  },
};
if (!TARGETS[TARGET]) {
  console.error(`Unknown target "${TARGET}". Leave it off for production, or add :staging for staging.`);
  process.exit(1);
}
const { worker: DEFAULT_WORKER, suffix: SUFFIX } = TARGETS[TARGET];
/** The Salts site, where computers are paired and tools switched on per agent. */
const APP = (process.env.SALTS_TOOLS_APP || TARGETS[TARGET].app).replace(/\/+$/, "");
/** The Worker reported to: the one this computer was paired with, unless overridden. */
const workerUrl = () => process.env.SALTS_TOOLS_WORKER || readState().worker || DEFAULT_WORKER;
/** The command again, with this target's suffix, for re-invoking the CLI. */
const withTarget = (name) => (SUFFIX ? `${name}:${TARGET}` : name);

const homeFor = (name) => path.join(os.homedir(), `.${name}`, ...(SUFFIX ? [TARGET] : []));
const HOME = homeFor("salts-tools");
const STATE_FILE = path.join(HOME, "state.json");
const PID_FILE = path.join(HOME, "supervisor.pid");
const LOG_FILE = path.join(HOME, "supervisor.log");
const MATCHMAKER_LOG = path.join(HOME, "matchmaker.log");
const ANALYST_LOG = path.join(HOME, "analyst.log");
const WALLET_LOG = path.join(HOME, "coinbase-wallet.log");
const ZCASH_LOG = path.join(HOME, "zcash-wallet.log");
/** `salts-tools restart` drops this file; the supervisor picks it up (no SIGUSR1 on Windows). */
const RESTART_FILE = path.join(HOME, "restart.request");
/** `start`/`stop` of one service drop this file: the supervisor re-reads which are on. */
const RELOAD_FILE = path.join(HOME, "reload.request");

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

// Still named after salts-web, so the token saved before the rename keeps working.
const KEYCHAIN_SERVICE = "salts-web";

/**
 * The two secrets. `file` holds one on Linux without a keyring (mode 0600), `dpapi` on
 * Windows. The gateway token keeps its salts-web name, so servers that already carry it
 * on an agent are still recognised as this computer's after pairing.
 */
const SECRETS = {
  token: {
    account: `searxng-token${SUFFIX}`,
    file: path.join(HOME, "token"),
    dpapi: path.join(HOME, "token.dpapi"),
  },
  credential: {
    account: `computer-credential${SUFFIX}`,
    file: path.join(HOME, "credential"),
    dpapi: path.join(HOME, "credential.dpapi"),
  },
};

/** The login item for this CLI under `name` (salts-web was its name before). */
function autostartFor(name) {
  const label = `com.${name}${SUFFIX}`;
  const file = IS_MAC
    ? path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`)
    : IS_WIN
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
          "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${name}${SUFFIX}.cmd`
        )
      : path.join(
          process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
          "systemd", "user", `${name}${SUFFIX}.service`
        );
  return { label, file };
}
const AUTOSTART = autostartFor("salts-tools");

const HEARTBEAT_MS = 30_000;
/** Public checks that may fail in a row before the tunnel is torn down and rebuilt. */
const PUBLIC_FAILURES_BEFORE_RESTART = 3;
/** How long a new tunnel may take to connect and resolve before it is rebuilt. */
const TUNNEL_READY_MS = 120_000;
const DOCKER_WAIT_MS = 180_000;
/** Where each free-port scan starts, far enough apart not to race each other. */
const GATEWAY_PORT = 8080;
const WEB_PORT = 8180;
const MATCHMAKER_PORT = 8280;
const ANALYST_PORT = 8380;
const WALLET_PORT = 8480;
const ZCASH_PORT = 8580;

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `host` has a DNS record, asking 1.1.1.1 directly. A quick tunnel's name is
 * published a few seconds after cloudflared prints it, and asking the system resolver
 * too early leaves it caching "no such host" long after the name exists.
 */
async function resolvable(host, seconds = 60) {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(["1.1.1.1", "1.0.0.1"]);
  for (let i = 0; i < seconds; i++) {
    try {
      if ((await resolver.resolve4(host)).length) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

// ─── state ──────────────────────────────────────────────────────────────────────

/**
 * Everything salts-tools remembers that is not the token: which agent, which Worker,
 * which services are on, their ports, and what the supervisor last saw of each (under
 * `svc.<name>`). The supervisor writes its progress here and the commands read it back,
 * which is how the two talk.
 */
function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  mkdirSync(HOME, { recursive: true });
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Merge into one service's entry under `svc`. */
function writeSvc(name, patch) {
  const svc = readState().svc ?? {};
  return writeState({ svc: { ...svc, [name]: { ...svc[name], ...patch } } });
}

// ─── the secrets, in the OS secret store ────────────────────────────────────────

/** PowerShell reading/writing a DPAPI file; the secret only ever travels on stdin/stdout. */
function powershell(script, input, file = "") {
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, SALTS_DPAPI_FILE: file },
  });
}

const secretToolAttrs = ({ account }) => ["service", KEYCHAIN_SERVICE, "account", account];

function readSecret(secret) {
  if (IS_MAC) {
    const res = spawnSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", secret.account, "-w"],
      { encoding: "utf8" }
    );
    return res.status === 0 ? res.stdout.trim() : "";
  }
  if (IS_WIN) {
    if (!existsSync(secret.dpapi)) return "";
    const res = powershell(
      "$s = Get-Content -Raw $env:SALTS_DPAPI_FILE | ConvertTo-SecureString; " +
        "[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))",
      undefined,
      secret.dpapi
    );
    return res.status === 0 ? res.stdout.trim() : "";
  }
  if (have("secret-tool")) {
    const res = spawnSync("secret-tool", ["lookup", ...secretToolAttrs(secret)], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  }
  try {
    return readFileSync(secret.file, "utf8").trim();
  } catch {
    return "";
  }
}

/** Written on stdin, so the secret never appears in a process list. */
function writeSecret(secret, value) {
  mkdirSync(HOME, { recursive: true });
  let res;
  if (IS_MAC) {
    res = spawnSync("security", ["-i"], {
      input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${secret.account} -w ${value}\n`,
      encoding: "utf8",
    });
  } else if (IS_WIN) {
    res = powershell(
      "[Console]::In.ReadLine() | ConvertTo-SecureString -AsPlainText -Force | " +
        "ConvertFrom-SecureString | Set-Content -NoNewline $env:SALTS_DPAPI_FILE",
      `${value}\n`,
      secret.dpapi
    );
  } else {
    if (have("secret-tool")) {
      res = spawnSync("secret-tool", ["store", `--label=salts-tools ${secret.account}`, ...secretToolAttrs(secret)], {
        input: value,
        encoding: "utf8",
      });
    }
    // No keyring (a headless box, or no Secret Service running): a file only this user reads.
    if (!res || res.status !== 0) {
      writeFileSync(secret.file, `${value}\n`, { mode: 0o600 });
      res = { status: 0, stderr: "" };
    } else {
      rmSync(secret.file, { force: true });
    }
  }
  if (res.status !== 0 || readSecret(secret) !== value) {
    throw new Error(`Couldn't save the ${secret === SECRETS.token ? "gateway token" : "credential"}: ${(res.stderr ?? "").trim()}`);
  }
}

/** Returns whether there was a secret to delete. */
function deleteSecret(secret) {
  if (IS_MAC) {
    return run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", secret.account]).status === 0;
  }
  const file = IS_WIN ? secret.dpapi : secret.file;
  let had = existsSync(file);
  rmSync(file, { force: true });
  if (!IS_WIN && have("secret-tool") && run("secret-tool", ["lookup", ...secretToolAttrs(secret)]).status === 0) {
    run("secret-tool", ["clear", ...secretToolAttrs(secret)]);
    had = true;
  }
  return had;
}

const readToken = () => readSecret(SECRETS.token);
const readCredential = () => readSecret(SECRETS.credential);

/** Where the secrets are kept, for messages. */
function tokenStoreName() {
  if (IS_MAC) return "the Keychain";
  if (IS_WIN) return "DPAPI-encrypted files";
  return existsSync(SECRETS.token.file) ? HOME : "the keyring";
}

function newToken() {
  const token = randomBytes(32).toString("hex");
  writeSecret(SECRETS.token, token);
  return token;
}

// ─── the machine ────────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, ...opts });
}

function have(cmd) {
  return IS_WIN
    ? run("where", [cmd], { windowsHide: true }).status === 0
    : run("/bin/sh", ["-c", `command -v ${cmd}`]).status === 0;
}

function dockerUp() {
  return run("docker", ["info"], { timeout: 15_000 }).status === 0;
}

/**
 * Get a Docker daemon running, whatever provides it. Nothing assumes Docker was set to
 * start at login: if it is down, the app that provides it is launched and waited for.
 */
async function ensureDocker(say = () => {}) {
  if (dockerUp()) return;
  const winDesktop = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
  if (IS_MAC && existsSync("/Applications/Docker.app")) {
    say("Docker isn't running. Starting Docker Desktop…");
    run("open", ["-g", "-a", "Docker"]);
  } else if (IS_WIN && existsSync(winDesktop)) {
    say("Docker isn't running. Starting Docker Desktop…");
    spawn(winDesktop, [], { detached: true, stdio: "ignore" }).unref();
  } else if (!IS_MAC && !IS_WIN && run("systemctl", ["--user", "cat", "docker-desktop"]).status === 0) {
    say("Docker isn't running. Starting Docker Desktop…");
    run("systemctl", ["--user", "start", "docker-desktop"]);
  } else if (have("orbctl")) {
    say("Docker isn't running. Starting OrbStack…");
    run("orbctl", ["start"], { timeout: DOCKER_WAIT_MS });
  } else if (have("colima")) {
    say("Docker isn't running. Starting Colima…");
    run("colima", ["start"], { timeout: DOCKER_WAIT_MS });
  } else {
    throw new Error(
      IS_MAC || IS_WIN
        ? "Docker isn't running, and Docker Desktop, OrbStack or Colima couldn't be found to start it."
        : "Docker isn't running. Start it with `sudo systemctl start docker`, and check your user can run `docker info`."
    );
  }
  const until = Date.now() + DOCKER_WAIT_MS;
  while (Date.now() < until) {
    if (dockerUp()) return;
    await sleep(3000);
  }
  throw new Error(`Docker didn't start within ${DOCKER_WAIT_MS / 1000} seconds.`);
}

/** What stops `name` running here that it cannot fix itself, or "" when nothing does. */
function toolMissing(name) {
  if (SERVICES[name].docker) {
    if (!have("docker")) {
      return IS_MAC
        ? "install Docker Desktop (or OrbStack / Colima)"
        : IS_WIN
          ? "install Docker Desktop"
          : "install Docker Engine with the compose plugin (https://docs.docker.com/engine/install/)";
    }
    if (run("docker", ["compose", "version"]).status !== 0) return "update Docker (`docker compose` isn't available)";
  }
  if (SERVICES[name].uv && !have("uv")) return "install uv (https://docs.astral.sh/uv/)";
  // zingo-cli has no package anywhere: it is built from zingolib, which also bundles nym-proxy beside it.
  if (SERVICES[name].zingo && !zingoCli({ dir: ZCASH_DIR, have })) {
    return `build zingo-cli (https://github.com/zingolabs/zingolib: \`makers run-cli --build-only\`) and set ZINGO_CLI_BIN in ${path.join(ZCASH_DIR, ".env")}`;
  }
  return "";
}

/** cloudflared, which every tool needs: what to run to install it, or "". */
function cloudflaredMissing() {
  if (have("cloudflared")) return "";
  const why = "Salts tools needs cloudflared to connect your agents to this computer.";
  return IS_MAC
    ? `cloudflared isn't installed. ${why} To install it, run:\n    brew install cloudflared`
    : IS_WIN
      ? `cloudflared isn't installed. ${why} To install it, run:\n    winget install --id Cloudflare.cloudflared`
      : `cloudflared isn't installed. ${why} To install it, follow:\n    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`;
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function freePort(from) {
  for (let port = from; port < from + 200; port++) {
    if ((await portFree(port, "127.0.0.1")) && (await portFree(port, "0.0.0.0"))) return port;
  }
  throw new Error(`No free port between ${from} and ${from + 199}.`);
}


/** A saved port if it is still free, else the first free one from `from`. */
async function portFrom(saved, from) {
  return saved && (await portFree(saved, "127.0.0.1")) ? saved : await freePort(from);
}

// ─── the services ───────────────────────────────────────────────────────────────

function compose(dir, project, composeArgs, env = {}) {
  return run("docker", ["compose", "-p", project, ...composeArgs], {
    cwd: dir,
    timeout: 300_000,
    env: { ...process.env, ...env },
  });
}

/** The host port a compose service publishes `containerPort` on, if it is up. */
function publishedPort(dir, project, service, containerPort, env = {}) {
  const res = compose(dir, project, ["port", service, String(containerPort)], env);
  const m = res.status === 0 ? res.stdout.match(/:(\d+)\s*$/m) : null;
  return m ? Number(m[1]) : 0;
}

async function ok(url, token) {
  try {
    const res = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntil(check, seconds) {
  for (let i = 0; i < seconds; i++) {
    if (await check()) return true;
    await sleep(1000);
  }
  return false;
}

/** A pid whose command line still matches, as opposed to a number some other process now holds. */
function isProcess(pid, pattern) {
  if (!alive(pid)) return false;
  const res = IS_WIN
    ? run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true })
    : run("ps", ["-p", String(pid), "-o", "command="]);
  return pattern.test(res.stdout);
}

const WEB_DIR = path.join(here, "web");
// `searxng` is kept from salts-web, so a stack already running is reused in place.
const WEB_PROJECT = `searxng${SUFFIX}`;
/**
 * Every command interpolates the whole file: it names its containers after the project
 * and refuses an empty token, so `port` and `down` get a stand-in.
 */
const webEnv = (token = "unused", port = WEB_PORT) => ({
  SALTS_TOKEN: token,
  SALTS_PORT: String(port),
  SALTS_PROJECT: WEB_PROJECT,
});
const webPort = () => publishedPort(WEB_DIR, WEB_PROJECT, "caddy", 8081, webEnv());

/** Installed copies of packaged MCP servers: shared by every target, as the repo's are. */
const MCP_ROOT = path.join(os.homedir(), ".salts-tools", "mcps");
const MATCHMAKER_SRC = mcpSource(here, "matchmaker-mcp", MCP_ROOT);
const ANALYST_SRC = mcpSource(here, "analyst-mcp", MCP_ROOT);
const ZCASH_SRC = mcpSource(here, "zcash-wallet-mcp", MCP_ROOT);
const MATCHMAKER_DIR = MATCHMAKER_SRC.dir;
const ANALYST_DIR = ANALYST_SRC.dir;
const ZCASH_DIR = ZCASH_SRC.dir;

/**
 * Make `src` ready to run as `bin`: install the packaged copy when this version has not
 * been, then `uv sync` when that changed anything or there is no environment yet.
 */
function readyMcp(name, src, bin) {
  const fresh = src.bundled ? installMcp(src.bundled, src.dir, VERSION) : false;
  if (!fresh && existsSync(bin)) return;
  log(`${name}: uv sync`);
  const res = run("uv", ["sync", "--frozen"], { cwd: src.dir, timeout: 600_000 });
  if (res.status !== 0) throw new Error(`Couldn't install ${name}'s packages (uv sync): ${(res.stderr || res.stdout).trim()}`);
}
const ANALYST_BIN = IS_WIN
  ? path.join(ANALYST_DIR, ".venv", "Scripts", "analyst-mcp.exe")
  : path.join(ANALYST_DIR, ".venv", "bin", "analyst-mcp");

const MATCHMAKER_BIN = IS_WIN
  ? path.join(MATCHMAKER_DIR, ".venv", "Scripts", "matchmaker-mcp.exe")
  : path.join(MATCHMAKER_DIR, ".venv", "bin", "matchmaker-mcp");

const ZCASH_BIN = IS_WIN
  ? path.join(ZCASH_DIR, ".venv", "Scripts", "zcash-wallet-mcp.exe")
  : path.join(ZCASH_DIR, ".venv", "bin", "zcash-wallet-mcp");

/**
 * The headers the matchmaker's paid tools need on the agent's `matchmaker` MCP server,
 * beside the Authorization salts-tools sets. The cap (USD per tool call) is optional.
 */
const MATCHMAKER_HEADERS = [
  ["X-OpenRouter-Api-Key", "<your OpenRouter key>", "pays for its model calls"],
  ["Tool-Call-Max-Charge", "0.25", "most one call may spend; a judged page of 50 is ~$0.10"],
];

/**
 * Coinbase Wallet (Coinbase's Payments MCP package): a wallet app and a stdio server, installed by its own npm
 * installer into ~/.payments-mcp (shared by every target, as its wallet is).
 */
const WALLET_DIR = path.join(os.homedir(), ".payments-mcp");
const WALLET_BUNDLE = path.join(WALLET_DIR, "bundle.js");

/**
 * Install the wallet when it is not there yet, with Coinbase's installer, or directly
 * when that fails (see coinbase-wallet.mjs). Updates are left to the user.
 */
async function readyWallet() {
  if (existsSync(WALLET_BUNDLE)) return;
  log("coinbase-wallet: installing @coinbase/payments-mcp");
  const npx = IS_WIN ? "npx.cmd" : "npx";
  const res = run(npx, ["--yes", "@coinbase/payments-mcp", "install", "--client", "other", "--no-auto-config"], {
    timeout: 600_000,
  });
  if (res.status === 0 && existsSync(WALLET_BUNDLE)) return;
  const why = (res.stderr || res.stdout || "").trim().split("\n").filter((l) => /fail|error/i.test(l)).pop() ?? "";
  log(`coinbase-wallet: Coinbase's installer failed (${why.trim()}); installing it directly`);
  try {
    const version = await installCoinbaseWallet({
      dir: WALLET_DIR,
      log,
      // Windows' tar reads zip files; elsewhere unzip does.
      extract: (zip, dir) => (IS_WIN ? run("tar", ["-xf", zip, "-C", dir]) : run("unzip", ["-q", "-o", zip, "-d", dir])),
      npmInstall: (dir) => run(IS_WIN ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeout: 600_000 }),
    });
    if (!existsSync(WALLET_BUNDLE)) throw new Error(`v${version} has no bundle.js`);
    log(`coinbase-wallet: installed v${version}`);
  } catch (err) {
    throw new Error(`Couldn't install Coinbase Wallet: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Each service: how to bring it up on loopback (returning its port), whether it answers
 * there, how to take it down, and what to tell the Worker once the tunnel reaches it.
 * `up` and `down` run in the supervisor.
 */
const SERVICES = {
  web: {
    label: "Web search",
    kind: "searxng",
    needs: ["cap_web_search"],
    about: "web search for the agent (SearXNG, in Docker)",
    log: LOG_FILE,
    docker: true,
    healthy: (port, token) => ok(`http://127.0.0.1:${port}/healthz`, token),
    async up(token) {
      let port = webPort();
      if (port && (await this.healthy(port, token))) return port;
      port = port || (await portFrom(readState().svc?.web?.port, WEB_PORT));
      log(`web: docker compose up on port ${port}`);
      const res = compose(WEB_DIR, WEB_PROJECT, ["up", "-d", "--remove-orphans"], webEnv(token, port));
      if (res.status !== 0) throw new Error(`Couldn't start Web search in Docker: ${(res.stderr || res.stdout).trim()}`);
      port = webPort() || port;
      // SearXNG takes a few seconds before the gate stops answering 502.
      await waitUntil(() => this.healthy(port, token), 30);
      return port;
    },
    down() {
      return compose(WEB_DIR, WEB_PROJECT, ["down"], webEnv());
    },
    reached: (tunnel) => `${tunnel}/web`,
  },

  matchmaker: {
    label: "Matchmaker",
    kind: "mcp",
    headers: MATCHMAKER_HEADERS.map(([header]) => header),
    needs: ["cap_mcp"],
    about: "resumes, cover letters and job matching (uv, no Docker)",
    log: MATCHMAKER_LOG,
    docker: false,
    uv: true,
    child: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      readyMcp("matchmaker", MATCHMAKER_SRC, MATCHMAKER_BIN);
      this.stop();
      const port = await portFrom(readState().svc?.matchmaker?.port, MATCHMAKER_PORT);
      const out = openSync(MATCHMAKER_LOG, "a");
      // Its own .env still applies (MM_DATA_DIR, models, …); these win over it.
      const child = spawn(MATCHMAKER_BIN, [], {
        cwd: MATCHMAKER_DIR,
        stdio: ["ignore", out, out],
        windowsHide: true,
        env: {
          ...process.env,
          MCP_TRANSPORT: "http",
          MCP_HOST: "127.0.0.1",
          MCP_PORT: String(port),
          MCP_AUTH_TOKEN: token,
        },
      });
      this.child = child;
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        log(`matchmaker exited (${signal ?? code})`);
      });
      writeSvc("matchmaker", { pid: child.pid });
      log(`matchmaker started (pid ${child.pid}) on port ${port}; log at ${MATCHMAKER_LOG}`);
      if (!(await waitUntil(() => this.healthy(port), 60))) {
        throw new Error(`Matchmaker didn't respond on port ${port}. Details are in ${MATCHMAKER_LOG}`);
      }
      return port;
    },
    stop() {
      if (this.child) this.child.kill("SIGTERM");
      this.child = null;
      // One left behind by a supervisor killed hard (recruiter-mcp: the server before this one).
      const stale = readState().svc?.matchmaker?.pid;
      if (isProcess(stale, /matchmaker-mcp|recruiter-mcp/i)) process.kill(stale, "SIGTERM");
    },
    down() {
      this.stop();
      return { status: 0, stdout: "", stderr: "" };
    },
    reached: (tunnel) => `${tunnel}/matchmaker/mcp`,
  },

  analyst: {
    label: "Spreadsheet analyst",
    kind: "mcp",
    needs: ["cap_mcp", "cap_file_ingest"],
    about: "Excel and CSV analysis (uv, no Docker)",
    log: ANALYST_LOG,
    docker: false,
    uv: true,
    child: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      readyMcp("analyst", ANALYST_SRC, ANALYST_BIN);
      this.stop();
      const port = await portFrom(readState().svc?.analyst?.port, ANALYST_PORT);
      const out = openSync(ANALYST_LOG, "a");
      // Its own .env still applies (DATA_DIR, INBOX_DIR, ALLOW_PYTHON, …); these win over it.
      const child = spawn(ANALYST_BIN, [], {
        cwd: ANALYST_DIR,
        stdio: ["ignore", out, out],
        windowsHide: true,
        env: {
          ...process.env,
          MCP_TRANSPORT: "http",
          MCP_HOST: "127.0.0.1",
          MCP_PORT: String(port),
          MCP_AUTH_TOKEN: token,
        },
      });
      this.child = child;
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        log(`analyst exited (${signal ?? code})`);
      });
      writeSvc("analyst", { pid: child.pid });
      log(`analyst started (pid ${child.pid}) on port ${port}; log at ${ANALYST_LOG}`);
      if (!(await waitUntil(() => this.healthy(port), 60))) {
        throw new Error(`Spreadsheet analyst didn't respond on port ${port}. Details are in ${ANALYST_LOG}`);
      }
      return port;
    },
    stop() {
      if (this.child) this.child.kill("SIGTERM");
      this.child = null;
      const stale = readState().svc?.analyst?.pid;
      if (isProcess(stale, /analyst-mcp/i)) process.kill(stale, "SIGTERM");
    },
    down() {
      this.stop();
      return { status: 0, stdout: "", stderr: "" };
    },
    reached: (tunnel) => `${tunnel}/analyst/mcp`,
  },

  "zcash-wallet": {
    label: "Zcash wallet",
    kind: "mcp",
    needs: ["cap_mcp"],
    about: "a Zcash light wallet on this computer: addresses, balance and sending ZEC (zingo-cli, uv, no Docker)",
    log: ZCASH_LOG,
    docker: false,
    uv: true,
    zingo: true,
    child: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      readyMcp("zcash-wallet", ZCASH_SRC, ZCASH_BIN);
      this.stop();
      const port = await portFrom(readState().svc?.["zcash-wallet"]?.port, ZCASH_PORT);
      const out = openSync(ZCASH_LOG, "a");
      // Its own .env still applies (ZINGO_CLI_BIN, ZINGO_CHAIN, MAX_SEND_ZEC, …); these win over it.
      const child = spawn(ZCASH_BIN, [], {
        cwd: ZCASH_DIR,
        stdio: ["ignore", out, out],
        windowsHide: true,
        env: {
          ...process.env,
          MCP_TRANSPORT: "http",
          MCP_HOST: "127.0.0.1",
          MCP_PORT: String(port),
          MCP_AUTH_TOKEN: token,
        },
      });
      this.child = child;
      child.on("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        log(`zcash-wallet exited (${signal ?? code})`);
      });
      writeSvc("zcash-wallet", { pid: child.pid });
      log(`zcash-wallet started (pid ${child.pid}) on port ${port}; log at ${ZCASH_LOG}`);
      if (!(await waitUntil(() => this.healthy(port), 60))) {
        throw new Error(`Zcash wallet didn't respond on port ${port}. Details are in ${ZCASH_LOG}`);
      }
      return port;
    },
    stop() {
      if (this.child) this.child.kill("SIGTERM");
      this.child = null;
      const stale = readState().svc?.["zcash-wallet"]?.pid;
      if (isProcess(stale, /zcash-wallet-mcp/i)) process.kill(stale, "SIGTERM");
    },
    down() {
      this.stop();
      return { status: 0, stdout: "", stderr: "" };
    },
    reached: (tunnel) => `${tunnel}/zcash-wallet/mcp`,
  },

  "coinbase-wallet": {
    label: "Coinbase Wallet",
    kind: "mcp",
    needs: ["cap_mcp"],
    about: "non-custodial USDC wallet on Base, Polygon and Solana; pays x402 links such as Coinbase Business checkouts",
    log: WALLET_LOG,
    docker: false,
    bridge: null,
    healthy: (port) => ok(`http://127.0.0.1:${port}/healthz`),
    async up(token) {
      await readyWallet();
      this.stop();
      const port = await portFrom(readState().svc?.["coinbase-wallet"]?.port, WALLET_PORT);
      const out = openSync(WALLET_LOG, "a");
      // It speaks stdio only; the bridge puts it on loopback HTTP like the others.
      const bridge = await startStdioBridge({
        command: process.execPath,
        args: [WALLET_BUNDLE],
        cwd: WALLET_DIR,
        // Started from inside an editor (itself Electron), this would make the wallet app
        // run as plain Node, which cannot open it.
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE")),
        port,
        token,
        output: out,
      });
      this.bridge = bridge;
      bridge.child.on("exit", (code, signal) => {
        if (this.bridge === bridge) log(`coinbase-wallet exited (${signal ?? code})`);
      });
      writeSvc("coinbase-wallet", { pid: bridge.child.pid });
      log(`coinbase-wallet started (pid ${bridge.child.pid}) on port ${port}; log at ${WALLET_LOG}`);
      if (!(await waitUntil(() => this.healthy(port), 30))) {
        throw new Error(`Coinbase Wallet didn't respond on port ${port}. Details are in ${WALLET_LOG}`);
      }
      return port;
    },
    stop() {
      this.bridge?.close();
      this.bridge = null;
      const stale = readState().svc?.["coinbase-wallet"]?.pid;
      if (isProcess(stale, /payments-mcp/i)) process.kill(stale, "SIGTERM");
    },
    down() {
      this.stop();
      return { status: 0, stdout: "", stderr: "" };
    },
    reached: (tunnel) => `${tunnel}/coinbase-wallet/mcp`,
  },
};

/** Stop every service that runs as a child process of the supervisor (not containers). */
function stopChildren() {
  for (const svc of Object.values(SERVICES)) svc.stop?.();
}
const NAMES = Object.keys(SERVICES);

// ─── the supervisor ─────────────────────────────────────────────────────────────

function log(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  try {
    appendFileSync(LOG_FILE, text);
  } catch {
    process.stdout.write(text);
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidIn(file) {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return alive(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

const supervisorPid = () => pidIn(PID_FILE);
const isTunnel = (pid) => isProcess(pid, /cloudflared/i);

function processList() {
  const res = IS_WIN
    ? powershell(
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }'
      )
    : run("ps", ["-axo", "pid=,ppid=,command="]);
  return parseProcessList(res.stdout);
}

/**
 * End every supervisor of this target except `except`, then every tunnel left without its
 * supervisor. supervisor.pid names only the newest supervisor, so one started beside it
 * (a second `start`, the login item) used to keep running with its own tunnel.
 */
async function endStrays(except = 0) {
  const kill = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {}
  };
  const others = supervisorsOf(processList(), withTarget("_supervise"), except);
  for (const pid of others) kill(pid, "SIGTERM"); // each stops its own tunnel on the way out
  for (let i = 0; i < 20 && others.some(alive); i++) await sleep(250);
  for (const pid of others.filter(alive)) kill(pid, "SIGKILL");
  const orphans = orphanTunnels(processList());
  for (const pid of orphans) kill(pid, "SIGTERM");
  return others.length + orphans.length;
}

/**
 * The long-running half: keeps Docker, the services, the gateway and the tunnel up, and
 * reports to the Worker, which keeps the agents pointed at the tunnel.
 *
 * Every heartbeat walks the same list — each service that is wanted answering locally
 * (and each that is not taken down), cloudflared alive, the tunnel answering from
 * outside — repairs what is wrong, then reports. The Worker's answer says which services
 * are wanted now. A laptop waking up on a new network, a killed cloudflared and a Docker
 * that was never started all end up at the same place.
 */
async function supervise() {
  mkdirSync(HOME, { recursive: true });
  try {
    if (statSync(LOG_FILE).size > 1_000_000) rmSync(LOG_FILE);
  } catch {}
  writeFileSync(PID_FILE, String(process.pid));

  // A sleeping Mac drops the tunnel and every service; stay awake while this runs.
  // `-w` ends caffeinate with this process, however it exits.
  if (IS_MAC) {
    spawn("caffeinate", caffeinateArgs(process.pid), { stdio: "ignore" })
      .on("error", (err) => log(`caffeinate: ${err.message}`))
      .unref();
  }

  // One supervisor and one tunnel per target: end any other, and any cloudflared left behind.
  const stale = readState().tunnelPid;
  if (isTunnel(stale)) process.kill(stale, "SIGTERM");
  const ended = await endStrays(process.pid);
  if (ended) log(`ended ${ended} stray supervisor/cloudflared process(es)`);

  const credential = readCredential();
  if (!credential) {
    log(`not connected: run \`${SELF} ${withTarget("start")}\` in a terminal first`);
    writeState({ lastError: "not connected" });
    process.exit(1);
  }
  const token = readToken() || newToken();
  const worker = workerUrl();
  writeState({ url: "", lastError: "", reportError: "", supervisorStartedAt: new Date().toISOString(), supervisorCode: CODE });

  /** Loopback port of each service that is on and answering; what the gateway routes to. */
  const ports = {};
  const gatewayPort = await portFrom(readState().gatewayPort, GATEWAY_PORT);
  await startGateway(gatewayPort, { token: () => token, routes: () => ports });
  writeState({ gatewayPort });
  log(`supervisor up (pid ${process.pid}) for ${worker}; gateway on 127.0.0.1:${gatewayPort}`);

  let tunnel = null;
  let url = "";
  let publicFailures = 0;
  let tunnelStartedAt = 0;
  let busy = false;
  // A tick asked for while one runs (a new tunnel address, a manual restart) runs
  // straight after it rather than waiting out the heartbeat.
  let again = false;

  const startTunnel = () => {
    url = "";
    publicFailures = 0;
    tunnelStartedAt = Date.now();
    const child = spawn(
      "cloudflared",
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${gatewayPort}`],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );
    tunnel = child;
    writeState({ tunnelPid: child.pid, url: "" });
    log(`cloudflared started (pid ${child.pid}) -> 127.0.0.1:${gatewayPort}`);
    // cloudflared logs to stderr; a quick tunnel's address appears once, in a banner,
    // before the tunnel is connected. It is only used once connected and resolvable.
    let pending = "";
    let buf = "";
    const announce = async () => {
      const host = new URL(pending).host;
      pending = "";
      if (!(await resolvable(host))) log(`${host} still does not resolve; using it anyway`);
      if (tunnel !== child) return;
      url = `https://${host}`;
      writeState({ url, lastError: "" });
      log(`tunnel at ${url}`);
      tick();
    };
    child.stderr.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !url) pending = m[0];
        else if (pending && /Registered tunnel connection/.test(line)) announce();
        else if (/\s(ERR|FTL)\s/.test(line)) {
          const err = line.replace(/^\S+\s+(ERR|FTL)\s+/, "").trim();
          log(`cloudflared: ${err}`);
          writeState({ lastError: `cloudflared: ${err}` });
        }
      }
    });
    child.on("exit", (code, signal) => {
      if (tunnel === child) {
        tunnel = null;
        url = "";
        log(`cloudflared exited (${signal ?? code})`);
      }
    });
  };

  const stopTunnel = () => {
    const child = tunnel;
    tunnel = null;
    url = "";
    if (child) child.kill("SIGTERM");
  };

  const restartTunnel = async (why) => {
    log(`restarting the tunnel: ${why}`);
    stopTunnel();
    await sleep(1500);
    startTunnel();
  };

  /** What stops each service running here, by name; read again every heartbeat. */
  let missing = {};

  /**
   * Every service runs whenever this machine can run it, whether or not an agent uses it
   * yet, so switching one on for an agent works straight away. One that cannot (Docker or
   * uv missing) is reported as such.
   */
  const services = async () => {
    missing = Object.fromEntries(NAMES.map((name) => [name, toolMissing(name)]).filter(([, m]) => m));
    for (const name of NAMES) {
      const svc = SERVICES[name];
      if (missing[name]) {
        if (ports[name]) {
          delete ports[name];
          svc.down();
        }
        writeSvc(name, { up: false, error: "" });
        continue;
      }
      if (ports[name] && (await svc.healthy(ports[name], token))) continue;
      delete ports[name];
      writeSvc(name, { up: false });
      try {
        if (svc.docker) await ensureDocker(log);
        const port = await svc.up(token);
        ports[name] = port;
        writeSvc(name, { up: true, port, error: "" });
      } catch (err) {
        writeSvc(name, { error: err.message });
        log(err.message);
      }
    }
  };

  /**
   * Tell the Worker where everything is and what each tool needs; it answers with the
   * agents served and the services wanted for them. A credential it no longer accepts
   * (the computer was disconnected in the browser) stops everything.
   */
  const reportIn = async () => {
    const state = readState();
    const tools = toolsReport(SERVICES, { wanted: NAMES, missing, svc: state.svc ?? {}, ports });
    writeState({ tools });
    const { status, body } = await call(worker, "/salts/computer", {
      method: "PUT",
      credential,
      body: { tunnel_url: url, gateway_token: token, tools, version: VERSION },
    });
    if (status === 401) {
      log("this computer was disconnected from Salts; stopping");
      writeState({ unpaired: true, lastError: "disconnected in the browser" });
      for (const name of Object.keys(ports)) SERVICES[name].down();
      shutdown();
      return;
    }
    if (status !== 200) {
      const why =
        status === 0
          ? "could not reach Salts (offline?); retrying every 30s"
          : status === 404
            ? "this Salts server does not support salts-tools computers yet"
            : body.error || `Salts answered ${status}; retrying every 30s`;
      if (state.reportError !== why) log(`report: ${why}`);
      writeState({ reportError: why });
      return;
    }
    const wanted = wantedServices(body, NAMES);
    const before = (state.services ?? []).join(",");
    writeState({
      reportError: "",
      reportedAt: new Date().toISOString(),
      computer: body.computer,
      agents: body.agents ?? [],
      services: wanted,
    });
    if (wanted.join(",") !== before) {
      log(`tools wanted: ${wanted.join(", ") || "none"}`);
      again = true;
    }
  };

  const tick = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await services();

      if (!tunnel) {
        startTunnel();
      } else if (!url) {
        if (Date.now() - tunnelStartedAt > TUNNEL_READY_MS) {
          await restartTunnel(`no reachable address after ${TUNNEL_READY_MS / 1000}s`);
        }
      } else if (await ok(`${url}/healthz`, token)) {
        publicFailures = 0;
      } else if (++publicFailures >= PUBLIC_FAILURES_BEFORE_RESTART) {
        await restartTunnel(`${url} unreachable ${publicFailures} times in a row`);
      } else {
        log(`${url} unreachable (${publicFailures}/${PUBLIC_FAILURES_BEFORE_RESTART})`);
      }

      await reportIn();
    } catch (err) {
      writeState({ lastError: err.message });
      log(err.message);
    } finally {
      busy = false;
      if (again) {
        again = false;
        setTimeout(tick, 0);
      }
    }
  };

  const shutdown = () => {
    log("supervisor stopping");
    stopTunnel();
    stopChildren();
    try {
      rmSync(PID_FILE);
    } catch {}
    writeState({ url: "", tunnelPid: 0 });
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  rmSync(RESTART_FILE, { force: true });
  rmSync(RELOAD_FILE, { force: true });
  setInterval(() => {
    // `salts-tools restart`: a new tunnel, reported as soon as it is up.
    if (existsSync(RESTART_FILE)) {
      rmSync(RESTART_FILE, { force: true });
      stopTunnel();
      tick().then(() => log("manual restart done"));
    }
    // `salts-tools start` with this already running: report now.
    if (existsSync(RELOAD_FILE)) {
      rmSync(RELOAD_FILE, { force: true });
      tick();
    }
  }, 1000);

  await tick();
  setInterval(tick, HEARTBEAT_MS);
}

// ─── moving over from salts-web ─────────────────────────────────────────────────

/**
 * salts-tools was salts-web, which ran SearXNG alone. Its state moves here once: the
 * old supervisor and its ngrok are stopped, the agent and web
 * port carry over, and a salts-web login item is replaced by this one. The token stays
 * where it was, under the same Keychain entry.
 */
async function migrateFromSaltsWeb() {
  const old = homeFor("salts-web");
  const oldState = path.join(old, "state.json");
  if (existsSync(STATE_FILE) || !existsSync(oldState)) return;

  const pid = pidIn(path.join(old, "supervisor.pid"));
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  const prev = JSON.parse(readFileSync(oldState, "utf8"));
  if (isProcess(prev.ngrokPid, /ngrok/i)) process.kill(prev.ngrokPid, "SIGTERM");

  mkdirSync(HOME, { recursive: true });
  for (const file of ["token", "token.dpapi"]) {
    if (existsSync(path.join(old, file))) copyFileSync(path.join(old, file), path.join(HOME, file));
  }
  writeState({
    agentIds: prev.agentId ? [prev.agentId] : [],
    worker: prev.worker,
    services: ["web"],
    svc: { web: { port: prev.port || 0 } },
  });
  renameSync(oldState, `${oldState}.migrated`);
  console.log(`${GREEN}✓${OFF} Moved your salts-web settings to ${HOME}`);

  const legacy = autostartFor("salts-web");
  if (existsSync(legacy.file)) {
    autostartOff(legacy);
    autostartOn();
    console.log(`${GREEN}✓${OFF} Replaced the salts-web login item with Salts tools`);
  }
}

// ─── the commands ───────────────────────────────────────────────────────────────

function spawnSupervisor() {
  mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, [CLI, withTarget("_supervise")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function stopSupervisor() {
  const pid = supervisorPid();
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  const strays = await endStrays();
  const { tunnelPid, svc } = readState();
  if (isTunnel(tunnelPid)) process.kill(tunnelPid, "SIGTERM");
  if (isProcess(svc?.matchmaker?.pid, /recruiter-mcp/i)) process.kill(svc.matchmaker.pid, "SIGTERM");
  if (isProcess(svc?.analyst?.pid, /analyst-mcp/i)) process.kill(svc.analyst.pid, "SIGTERM");
  if (isProcess(svc?.["coinbase-wallet"]?.pid, /payments-mcp/i)) process.kill(svc["coinbase-wallet"].pid, "SIGTERM");
  if (isProcess(svc?.["zcash-wallet"]?.pid, /zcash-wallet-mcp/i)) process.kill(svc["zcash-wallet"].pid, "SIGTERM");
  return Boolean(pid || strays);
}

/** A running supervisor reports again now; otherwise one starts. Returns its pid and when. */
async function ensureSupervisor() {
  const since = new Date().toISOString();
  let pid = supervisorPid();
  // One started before an upgrade runs the old code, and would never run a new service.
  if (pid && readState().supervisorCode !== CODE) {
    console.log("  salts-tools was updated: restarting it to run the new version …");
    await stopSupervisor();
    pid = 0;
  }
  if (pid) {
    await endStrays(pid);
    writeFileSync(RELOAD_FILE, since);
  } else {
    await stopSupervisor();
    writeState({ lastError: "", reportError: "", unpaired: false });
    pid = spawnSupervisor();
  }
  return { pid, since };
}

/** Wait for a report Salts accepted after `since` (and `until(state)`, if given), or a failure. */
async function waitForReport(pid, since, { timeoutMs = 90_000, until = () => true } = {}) {
  const end = Date.now() + timeoutMs;
  const shown = new Set();
  while (Date.now() < end) {
    const s = readState();
    if (s.reportedAt && s.reportedAt >= since && until(s)) return { ok: true, state: s };
    if (s.unpaired) return { ok: false, state: s };
    for (const err of [s.lastError, s.reportError]) {
      if (err && !shown.has(err)) {
        shown.add(err);
        console.log(`  … ${err}`);
      }
    }
    // The spawned pid, not the pid file: the file is written a moment after spawning.
    if (!alive(pid)) return { ok: false, state: readState() };
    await sleep(1000);
  }
  return { ok: false, state: readState(), timedOut: true };
}

function autostartOn({ label, file } = AUTOSTART) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (IS_WIN) {
    // A script in the Startup folder; `start /min` so no console window stays open.
    writeFileSync(
      file,
      `@echo off\r\nstart "salts-tools" /min ${LAUNCH.map((a) => `"${a}"`).join(" ")} ${withTarget("start")}\r\n`
    );
    return;
  }
  if (!IS_MAC) {
    // A systemd user unit. `start` exits once the supervisor is spawned; RemainAfterExit
    // keeps the unit (and so the supervisor in its cgroup) alive.
    if (!have("systemctl")) throw new Error("Starting at login on Linux needs systemd (`systemctl --user`).");
    const q = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    writeFileSync(
      file,
      `[Unit]
Description=salts-tools (${TARGET})

[Service]
Type=oneshot
RemainAfterExit=yes
Environment=${q(`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`)}
ExecStart=${LAUNCH.map(q).join(" ")} ${withTarget("start")}
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`
    );
    run("systemctl", ["--user", "daemon-reload"]);
    const res = run("systemctl", ["--user", "enable", path.basename(file)]);
    if (res.status !== 0) throw new Error(res.stderr.trim());
    return;
  }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // launchd starts with a bare PATH; docker, cloudflared and uv live wherever this shell found them.
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${LAUNCH.map((a) => `    <string>${esc(a)}</string>\n`).join("")}    <string>${withTarget("start")}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${esc(process.env.PATH ?? "/usr/bin:/bin")}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${esc(LOG_FILE)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_FILE)}</string>
</dict>
</plist>
`
  );
  const domain = `gui/${process.getuid()}`;
  run("launchctl", ["bootout", `${domain}/${label}`]);
  const res = run("launchctl", ["bootstrap", domain, file]);
  // Bootstrapping runs it once now (RunAtLoad); harmless, `start` is idempotent.
  if (res.status !== 0 && !existsSync(file)) throw new Error(res.stderr.trim());
}

function autostartOff({ label, file } = AUTOSTART) {
  if (IS_MAC) run("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]);
  else if (!IS_WIN && existsSync(file)) run("systemctl", ["--user", "disable", path.basename(file)]);
  rmSync(file, { force: true });
  if (!IS_MAC && !IS_WIN) run("systemctl", ["--user", "daemon-reload"]);
}

/** Open `url` in the browser; false when this machine has no way to. */
function openBrowser(url) {
  const [cmd, cmdArgs] = openCommand(url, process.platform);
  const res = run(cmd, cmdArgs, { windowsHide: true, timeout: 10_000 });
  return res.status === 0;
}

/**
 * Pair this computer: a code, shown here and opened in the browser, which the signed-in
 * user approves for some of their agents. The credential then arrives by itself.
 * Returns false when the user gave up.
 */
async function pair(rl) {
  const worker = workerUrl();
  // What older versions kept (agent ids, per-agent services) is chosen on the site now.
  writeState({ worker, agentIds: undefined, agentId: undefined, agentServices: undefined, unpaired: false });
  const name = os.hostname().replace(/\.(local|lan|home)$/i, "") || "This computer";
  for (;;) {
    const pairing = await startPairing(worker, name);
    const link = `${APP}/salts-tools/pair?code=${encodeURIComponent(pairing.user_code)}`;
    const opened = openBrowser(link);
    console.log(`
Connect this computer to your Salts account.

  1. Open this link${opened ? " (it should have opened in your browser)" : ""}:
       ${link}

  2. Check the code on the page is ${pairing.user_code}, then press Connect.

Waiting for you to press Connect…`);
    const credential = await waitForApproval(worker, pairing, { sleep });
    if (credential) {
      deleteSecret(SECRETS.credential);
      writeSecret(SECRETS.credential, credential);
      if (!readToken()) newToken();
      console.log(`\n${GREEN}✓${OFF} Connected.`);
      return true;
    }
    const again = await rl.question("\nThe code expired. Press Enter to get a new one, or type q to quit: ");
    if (again.trim().toLowerCase() === "q") return false;
  }
}

/** Who this computer is, which agents it serves with what, and where to change that. */
function summary(s) {
  const agents = s.agents ?? [];
  const width = Math.max(0, ...agents.map((a) => a.name.length));
  console.log(`\n${GREEN}✓${OFF} Salts tools is running.\n  Your agents can now use this computer.\n`);
  console.log(`  Agents\n  ${"─".repeat(40)}`);
  if (!agents.length) console.log("  No agents added yet.");
  for (const a of agents) {
    console.log(`  ${a.name.padEnd(width)}   ${a.tools.length ? a.tools.join(", ") : "no tools turned on yet"}`);
  }
  const missing = Object.entries(s.tools ?? {}).filter(([, tool]) => tool.state === "missing");
  if (missing.length) console.log("");
  for (const [name, tool] of missing) console.log(`  ${name} can't run here yet: ${tool.detail}`);
  console.log(`\n  To add agents or choose their tools, run:\n${commandLine(SUFFIX ? `:${TARGET}` : "")}\n  then open the Agents tab.\n`);
}

/** A command for the user to run, on a line of its own. */
function commandLine(rest) {
  return `    ${SELF}${rest ? ` ${rest}` : ""}`;
}

async function askAutostart(rl) {
  if (existsSync(AUTOSTART.file)) return;
  const yes = (await rl.question("\nStart Salts tools by itself when you log in? [Y/n] ")).trim().toLowerCase();
  if (yes === "" || yes === "y" || yes === "yes") {
    autostartOn();
    console.log(`\n${GREEN}✓${OFF} Salts tools will start by itself when you log in.\n\n  To turn that off, run:\n${commandLine(`${withTarget("autostart")} off`)}\n`);
  }
}

/** Connected (pairing first if not) and running, reporting to Salts. */
async function start({ interactive, summarize = true }) {
  if (args.length) console.log(`Every tool starts when it can. Choose which agent uses which tool in the dashboard's Agents tab.`);
  const cloudflared = cloudflaredMissing();
  if (cloudflared) {
    console.error(`\n${RED}✗${OFF} ${cloudflared}\n`);
    process.exit(1);
  }

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    let fresh = false;
    if (!readCredential() || readState().unpaired) {
      if (!rl) {
        console.error(`\n${RED}✗${OFF} This computer isn't connected to Salts yet. To connect it, run this in a terminal:\n${commandLine(withTarget("start"))}\n`);
        process.exit(1);
      }
      if (!(await pair(rl))) return false;
      fresh = true;
    }

    const { pid, since } = await ensureSupervisor();
    if (!rl) {
      console.log(`Salts tools is running in the background. Its log is at ${LOG_FILE}`);
      return true;
    }
    console.log(`\nStarting Salts tools…`);
    const result = await waitForReport(pid, since);
    if (result.ok && summarize) summary(result.state);
    else if (result.ok) console.log(`\n${GREEN}✓${OFF} Salts tools is running.\n`);
    else if (result.state.unpaired) console.log(`\n${RED}✗${OFF} This computer was disconnected from Salts in the browser.\n  Run this command again to connect it.\n`);
    else console.log(`\n${RED}✗${OFF} Salts tools couldn't reach Salts: ${result.state.reportError || result.state.lastError || "no response yet"}\n  It will keep trying. Details are in:\n    ${LOG_FILE}\n`);
    if (fresh) await askAutostart(rl);
    return true;
  } finally {
    rl?.close();
  }
}

async function stop() {
  if (args.length) throw new Error("To turn a tool off for one agent, use the dashboard's Agents tab. `stop` on its own stops everything.");
  const { was, failed } = await stopAll();
  console.log("");
  for (const line of failed) console.log(`${RED}✗${OFF} ${line}`);
  console.log(was ? `${GREEN}✓${OFF} Salts tools stopped.\n  Your agents can't use this computer until you start it again.` : "Salts tools wasn't running.");
  if (existsSync(AUTOSTART.file)) {
    console.log(`\n  It will start by itself the next time you log in. To turn that off, run:\n${commandLine(`${withTarget("autostart")} off`)}`);
  }
  console.log("");
}

/**
 * Everything: the supervisor, the tunnel and the containers. What is wanted comes back
 * from Salts on the next `start`. Returns whether anything was running and a line for
 * each service that would not go down.
 */
async function stopAll() {
  const was = await stopSupervisor();
  const failed = [];
  if (dockerUp()) {
    for (const name of NAMES) {
      const res = SERVICES[name].down();
      if (res.status !== 0) failed.push(`${name}: ${res.stderr.trim()}`);
    }
  }
  const svc = readState().svc ?? {};
  for (const name of NAMES) svc[name] = { ...svc[name], up: false };
  writeState({ url: "", svc });
  return { was, failed };
}

/**
 * Delete this target's files in `dir`, and `dir` itself once empty. Production's folder
 * holds staging's in `staging/` and the installed MCP servers in `mcps/`, which are left alone.
 */
function clearHome(dir) {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir)) {
    if (!SUFFIX && (entry === "staging" || entry === "mcps")) continue;
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Unpair: stop, and have Salts take this computer's tools off every agent and forget it.
 * The secrets and state stay, so pairing again reuses the gateway token. A line saying
 * what happened.
 */
async function disconnect() {
  const credential = readCredential();
  if (!credential) return "This computer isn't connected.";
  if (supervisorPid()) await stopAll();
  const { status } = await call(workerUrl(), "/salts/computer", { method: "DELETE", credential });
  if (status !== 200 && status !== 401) {
    throw new Error(`Couldn't reach Salts (${status || "offline"}). This computer is still connected. Try again.`);
  }
  deleteSecret(SECRETS.credential);
  writeState({ unpaired: false, agents: [], services: [], computer: undefined, reportedAt: undefined });
  return status === 200
    ? "Disconnected. This computer's tools are turned off for every agent."
    : "This computer was already disconnected.";
}

/**
 * Back to a first run, as on a machine that never ran salts-tools (or salts-web): stopped,
 * disconnected from Salts (which takes its tools off every agent), and the secrets, state,
 * logs, login item and salts-web's leftovers gone. The matchmaker's people and jobs and
 * the analyst's files are kept.
 */
async function reset() {
  if (pidIn(path.join(homeFor("salts-web"), "supervisor.pid"))) {
    throw new Error("salts-web is running. Stop it first.");
  }
  const done = [];
  if (supervisorPid()) {
    await stopAll();
    done.push("Stopped Salts tools");
  }
  const credential = readCredential();
  if (credential) {
    const { status } = await call(workerUrl(), "/salts/computer", { method: "DELETE", credential });
    done.push(
      status === 200
        ? "Disconnected this computer from Salts"
        : status === 401
          ? "This computer was already disconnected"
          : `Couldn't reach Salts (${status || "offline"}), so it still lists this computer until you connect again`
    );
  }
  const where = tokenStoreName();
  if (deleteSecret(SECRETS.credential)) done.push(`Deleted the credential from ${where}`);
  if (deleteSecret(SECRETS.token)) done.push(`Deleted the gateway token from ${where}`);
  for (const item of [AUTOSTART, autostartFor("salts-web")]) {
    if (!existsSync(item.file)) continue;
    autostartOff(item);
    done.push(`Removed the login item ${item.file}`);
  }
  for (const dir of [HOME, homeFor("salts-web")]) {
    if (clearHome(dir)) done.push(`Deleted ${dir}${SUFFIX ? "" : " (staging and installed tools kept)"}`);
  }
  return done;
}

async function restart() {
  const pid = supervisorPid();
  if (!pid) {
    console.log("Salts tools isn't running. Starting it…");
    return await start({ interactive: process.stdin.isTTY });
  }
  const before = readState().url;
  const since = await requestRestart(pid);
  console.log(`\nOpening a new tunnel…`);
  const result = await waitForReport(pid, since, { timeoutMs: 150_000, until: (s) => s.url && s.url !== before });
  if (result.ok) console.log(`\n${GREEN}✓${OFF} New tunnel open. Every agent now uses it:\n    ${result.state.url}\n`);
  else console.log(`\n${RED}✗${OFF} ${result.state.lastError || result.state.reportError || "No new tunnel yet."}\n  Details are in:\n    ${LOG_FILE}\n`);
}

/** Ask the running supervisor `pid` for a new tunnel. Returns when. */
async function requestRestart(pid) {
  await endStrays(pid); // a stray's session would stop the new tunnel from opening
  const since = new Date().toISOString();
  writeState({ lastError: "" });
  writeFileSync(RESTART_FILE, since);
  return since;
}

// ─── the dashboard ──────────────────────────────────────────────────────────────
//
// `salts-tools` with no command, in a terminal. Four tabs, each a list of rows, drawn
// the way admin-cli draws its own. The site is only for pairing; everything else is here.
//
//   1 Services  each service and whether it is live, live but not in use, or in error;
//               `enter` opens one: its address, port, files and log. Display only.
//   2 Agents    the agents registered on this computer (not every agent the user has:
//               one may have a fleet); `a` adds one by its id or a link to it; `enter`
//               opens one: a switch per tool, what is left to do before they work (done
//               from here), and unregistering it
//   3 Settings  the connection, start at login, where things live, disconnect, reset
//   4 Log       the supervisor's log, newest at the bottom

const TABS = ["Services", "Agents", "Settings", "Log"];

const ui = {
  tab: 0,
  pos: { 0: { sel: 0, top: 0 }, 1: { sel: 0, top: 0 }, 2: { sel: 0, top: 0 }, 3: { sel: 0, top: 0, tail: true } },
  /** The service opened from the Services tab, or "" while the list is showing. */
  open: "",
  openPos: { sel: 0, top: 0 },
  /** The agent opened from the Agents tab, or "" while the list is showing. */
  openAgent: "",
  openAgentPos: { sel: 0, top: 0 },
  /** The agents registered here, as the Worker last listed them; null before its first answer. */
  agents: null,
  agentsError: "",
  /** Non-null while a value is being typed: `{ label, buffer, secret, submit(text) }`. */
  edit: null,
  /** Non-null while a y/n is pending: `{ prompt, run() }`. */
  confirm: null,
  status: "",
};

const say = (text) => {
  ui.status = text;
  render();
};

/** Put `text` on the clipboard, with whatever this machine has for it. */
function copy(text) {
  const tool = IS_MAC
    ? ["pbcopy", []]
    : IS_WIN
      ? ["clip", []]
      : have("wl-copy")
        ? ["wl-copy", []]
        : have("xclip")
          ? ["xclip", ["-selection", "clipboard"]]
          : null;
  return Boolean(tool) && run(tool[0], tool[1], { input: text, windowsHide: true }).status === 0;
}

function confirm(prompt, run) {
  ui.confirm = { prompt, run };
  say("");
}

function startEdit(label, { secret = false } = {}, submit) {
  ui.edit = { label, buffer: "", secret, submit };
  say("");
}

async function startFromDashboard() {
  if (!readCredential()) return say("This computer isn't connected. Quit (q) and run salts-tools again to connect it.");
  say("Starting…");
  await ensureSupervisor();
  say("Starting. This screen updates as it goes.");
}

async function stopEverything() {
  say("Stopping…");
  const { was, failed } = await stopAll();
  say(failed.length ? paint(failed.join("; "), "bad") : was ? "Salts tools stopped. Your agents can't use this computer until you start it again." : "Salts tools wasn't running.");
}

/** Ask the Worker about this computer's agents, with its credential. */
async function agentCall(path, method = "GET", body) {
  const credential = readCredential();
  if (!credential) throw new Error("This computer isn't connected. Quit (q) and run salts-tools again to connect it.");
  const res = await call(workerUrl(), `/salts/computer/agents${path}`, { method, body, credential });
  if (res.status === 401) throw new Error("This computer was disconnected from Salts. Quit (q) and run salts-tools again to connect it.");
  if (res.status !== 200) {
    const err = new Error(res.status === 0 ? "Couldn't reach Salts. Are you offline?" : res.body.error || `Salts returned an error (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res.body;
}

/** Fetch the agent list again; the screen shows the last one meanwhile. */
async function loadAgents() {
  try {
    ui.agents = (await agentCall("")).agents;
    ui.agentsError = "";
  } catch (err) {
    ui.agentsError = err.message;
  }
  render();
}

/** One agent changed: take its new state into the list, and have the supervisor report now. */
function updated(agent) {
  if (agent?.id) ui.agents = (ui.agents ?? []).map((a) => (a.id === agent.id ? agent : a));
  if (supervisorPid()) writeFileSync(RELOAD_FILE, new Date().toISOString());
}

async function toggleTool(agent, name) {
  const on = agent.tools.includes(name);
  const tools = on ? agent.tools.filter((t) => t !== name) : [...agent.tools, name];
  say(`Turning ${SERVICES[name].label} ${on ? "off" : "on"} for ${agent.name}…`);
  updated(await agentCall(`/${encodeURIComponent(agent.id)}`, "PUT", { tools }));
  say(`${SERVICES[name].label} is now ${on ? "off" : "on"} for ${agent.name}.`);
}

/** Register an agent on this computer by its id (or a link to it), then open it. */
function addAgent() {
  startEdit("Agent ID or link:", {}, async (text) => {
    const id = agentIdFrom(text);
    if (!id) return say("");
    say("Adding the agent…");
    let agent;
    try {
      agent = await agentCall(`/${encodeURIComponent(id)}`, "POST");
    } catch (err) {
      if (err.status === 404) return say(paint(`You do not have ownership of an agent with ID "${id}".`, "bad"));
      throw err;
    }
    const known = (ui.agents ?? []).some((a) => a.id === agent.id);
    ui.agents = known ? ui.agents.map((a) => (a.id === agent.id ? agent : a)) : [...(ui.agents ?? []), agent];
    ui.openAgent = agent.id;
    ui.openAgentPos = { sel: 0, top: 0 };
    say(known ? `${agent.name} is already added.` : `Added ${agent.name}. Choose the tools it can use.`);
  });
}

/** Every tool off for the agent, and it leaves this computer's list. */
function unregister(agent) {
  confirm(`Unregister ${agent.name}? Every tool is turned off for it, and it is removed from this list.`, async () => {
    await agentCall(`/${encodeURIComponent(agent.id)}`, "DELETE");
    ui.agents = (ui.agents ?? []).filter((a) => a.id !== agent.id);
    ui.openAgent = "";
    if (supervisorPid()) writeFileSync(RELOAD_FILE, new Date().toISOString());
    say(`Unregistered ${agent.name}.`);
  });
}

/** Do one thing left to do on an agent, or say how. */
async function doTodo(agent, todo) {
  const label = SERVICES[todo.tool]?.label ?? todo.tool;
  if (todo.kind === "capability") {
    updated(await agentCall(`/${encodeURIComponent(agent.id)}/capability`, "POST", { flag: todo.flag }));
    return say(`${todo.label} is now on for ${agent.name}.`);
  }
  if (todo.kind === "headers") {
    const [header] = todo.headers;
    return startEdit(`${label}: ${header}`, { secret: true }, async (value) => {
      if (!value.trim()) return say("");
      updated(
        await agentCall(`/${encodeURIComponent(agent.id)}/headers`, "PUT", {
          tool: todo.tool,
          headers: { [header]: value },
        })
      );
      say(`Saved ${header} for ${label} on ${agent.name}.`);
    });
  }
  say(todoNote(todo, label));
}

/** One thing left to do, as a short line and what `enter` does about it. */
function todoText(todo) {
  const label = SERVICES[todo.tool]?.label ?? todo.tool;
  switch (todo.kind) {
    case "capability":
      return [`${label} needs ${todo.label} turned on`, `Press "Enter" to turn on ${todo.label} for this agent.`];
    case "headers":
      return [`${label} needs ${todo.headers.join(", ")}`, `Press "Enter" to type it in. It's saved on the agent and never shown again.`];
    case "brave":
      return [`${label} isn't used: this agent has a Brave key`, "To use this computer's Web search, remove the Brave key in the agent's Capabilities on the Salts site."];
    case "disabled":
      return [`${label}'s MCP server is turned off`, "Turn it on in the agent's Capabilities on the Salts site."];
    case "name_taken":
      return [`Another MCP server is called ${todo.tool}`, `Delete it in the agent's Capabilities on the Salts site, and this computer's ${todo.tool} is added in its place.`];
    default:
      return [`${label} can't be added`, "This agent's admin manages its MCP servers."];
  }
}

const todoNote = (todo) => todoText(todo)[1];

/** Whatever this machine logs in `file`, last lines only: the log can reach a megabyte. */
function tail(file, bytes = 64 * 1024) {
  try {
    const size = statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    return len < size ? lines.slice(1) : lines;
  } catch {
    return [];
  }
}

/** Where a service keeps what it keeps, beyond its address. */
function serviceFiles(name) {
  if (name === "matchmaker") {
    const data = path.join(MATCHMAKER_DIR, "data", "matchmaker");
    return [["people and jobs", data, "To move it, set MM_DATA_DIR in its .env file.", data]];
  }
  if (name === "analyst") {
    return [
      ["inbox folder", ANALYST_INBOX, `Files you put here can be read too. To move it, set DATA_DIR or INBOX_DIR in ${path.join(ANALYST_DIR, ".env")}`, ANALYST_INBOX],
      ["run_python", "off unless ALLOW_PYTHON=true", `Set it in ${path.join(ANALYST_DIR, ".env")}`],
    ];
  }
  if (name === "coinbase-wallet") {
    return [
      ["wallet app", WALLET_DIR, "Ask the agent to show the wallet to sign in, add funds and set spend limits.", WALLET_DIR],
    ];
  }
  if (name === "zcash-wallet") {
    const env = path.join(ZCASH_DIR, ".env");
    const chain = zcashEnv("ZINGO_CHAIN", "mainnet");
    const wallet = zcashWallet(chain);
    const backup = `zingo-cli --data-dir ${wallet} --chain ${chain} recovery_info`;
    return [
      ["wallet", wallet, `Back up its seed phrase yourself; no tool prints it. Run: ${backup}`, wallet],
      ["network", chain, `Set ZINGO_CHAIN in ${env}. Each network keeps its own wallet, so switching opens a different one.`],
      ["send limit", `${zcashEnv("MAX_SEND_ZEC", "1")} ZEC per send`, `Set MAX_SEND_ZEC in ${env}`],
    ];
  }
  return [];
}

const ANALYST_INBOX = path.join(ANALYST_DIR, "data", "inbox");

/**
 * What the Zcash wallet's own .env says. Read on every look, not once at startup: the Tools tab is
 * where the user is told to edit that file, so the card has to show what is in it now.
 */
const zcashEnv = (name, fallback) => envValue(path.join(ZCASH_DIR, ".env"), name) || fallback;
// DATA_DIR is read by a server whose cwd is its own folder, so a relative one resolves against that.
const zcashWallet = (chain) => path.resolve(ZCASH_DIR, zcashEnv("DATA_DIR", "./data"), "wallets", chain);

/** A row whose `enter` copies `text`. */
const copyRow = (cells, text, note) => ({
  cells,
  note,
  enter: () => say(copy(text) ? `Copied ${text}` : "Couldn't copy: no clipboard tool found on this computer."),
});

const back = (key) => () => {
  ui[key] = "";
  say("");
};

/**
 * What the current tab shows: its columns, its rows, where the selection is, and the
 * keys it answers to beyond moving and `enter`.
 */
function view() {
  const s = readState();
  const running = Boolean(supervisorPid());
  const live = (name) => running && s.svc?.[name]?.up && s.url;

  switch (ui.tab) {
    case 0: {
      const name = ui.open;
      if (name) {
        const svc = SERVICES[name];
        const st = serviceStatus(s, name, running);
        const e = s.svc?.[name] ?? {};
        const users = (s.agents ?? []).filter((a) => a.tools.includes(name)).map((a) => a.name);
        return {
          title: `${svc.label}  ${DIM}${svc.about}${OFF}`,
          columns: [["", 20], ["", 0]],
          rows: [
            { cells: ["status", { text: st.label, tone: st.tone }], note: st.note },
            { cells: ["used by", users.length ? users.join(", ") : { text: "no agents", tone: "off" }], note: "Turn it on for an agent in the Agents tab." },
            live(name)
              ? copyRow(["address", svc.reached(s.url)], svc.reached(s.url), "Your agents reach it at this address. Salts is told whenever it changes.")
              : { cells: ["address", { text: "not running", tone: "off" }] },
            { cells: ["local port", live(name) && e.port ? `127.0.0.1:${e.port}` : "—"], note: "Only reachable from this computer. The tunnel reaches it through a token check." },
            ...serviceFiles(name).map(([label, value, note, copyText]) =>
              copyText ? copyRow([label, value], copyText, note) : { cells: [label, value], note }
            ),
            copyRow(["log", svc.log], svc.log),
          ],
          pos: ui.openPos,
          hint: "[enter] copy   [esc] back",
          keys: { "\x1b": back("open") },
        };
      }
      return {
        columns: [["service", 22], ["status", 20], ["address", 0]],
        rows: NAMES.map((name) => {
          const st = serviceStatus(s, name, running);
          return {
            cells: [SERVICES[name].label, { text: st.label, tone: st.tone }, live(name) ? SERVICES[name].reached(s.url) : ""],
            note: st.note || SERVICES[name].about,
            enter: () => {
              ui.open = name;
              ui.openPos = { sel: 0, top: 0 };
              say("");
            },
          };
        }),
        pos: ui.pos[0],
        hint: running ? "[enter] details   [r] new tunnel   [x] stop" : "[enter] details   [s] start",
        keys: {
          s: () => (running ? say("Salts tools is already running.") : startFromDashboard()),
          r: () => {
            const pid = supervisorPid();
            if (!pid) return say("Salts tools isn't running.");
            return requestRestart(pid).then(() => say("Opening a new tunnel…"));
          },
          x: () => running && confirm("Stop Salts tools? Your agents can't use this computer until you start it again.", stopEverything),
        },
      };
    }

    case 1: {
      const agents = ui.agents ?? [];
      const agent = agents.find((a) => a.id === ui.openAgent);
      if (agent) {
        const rows = NAMES.map((name) => {
          const on = agent.tools.includes(name);
          const st = serviceStatus(s, name, running);
          return {
            cells: [SERVICES[name].label, on ? { text: "on", tone: "good" } : { text: "off", tone: "off" }],
            note: `Press "Enter" to toggle "${SERVICES[name].label}" ${on ? "OFF" : "ON"} for ${agent.name}${st.tone === "bad" ? ` (${st.note})` : ""}`,
            enter: () => toggleTool(agent, name),
          };
        });
        for (const todo of agent.todos) {
          const [text, note] = todoText(todo);
          rows.push({ cells: ["to do", { text, tone: "bad" }], note, enter: () => doTodo(agent, todo) });
        }
        rows.push({
          cells: ["", { text: "Unregister this agent", tone: "bad" }],
          note: "Turns off every tool for this agent and removes it from this list.",
          enter: () => unregister(agent),
        });
        return {
          title: agent.name,
          columns: [["", 22], ["", 0]],
          rows,
          pos: ui.openAgentPos,
          hint: "[enter] toggle   [esc] back",
          keys: { "\x1b": back("openAgent") },
        };
      }
      return {
        columns: [["agent", 32], ["tools on", 0]],
        rows: agents.map((a) => ({
          cells: [
            a.name,
            a.tools.length
              ? { text: `${a.tools.map((t) => SERVICES[t]?.label ?? t).join(", ")}${a.todos.length ? `  (${a.todos.length} to do)` : ""}`, tone: a.todos.length ? "busy" : "good" }
              : { text: "—", tone: "off" },
          ],
          note: a.todos.length ? `${todoText(a.todos[0])[0]}. Press "Enter" to fix it.` : `Press "Enter" to update "${a.name}" tools`,
          enter: () => {
            ui.openAgent = a.id;
            ui.openAgentPos = { sel: 0, top: 0 };
            say("");
          },
        })),
        pos: ui.pos[1],
        empty:
          ui.agentsError ||
          (ui.agents
            ? `No agents added yet. Press "a" to add one by its ID, from its link on the Salts site (…/a/<ID>).`
            : "Loading your agents…"),
        hint: agents.length ? "[enter] update tools   [a] add agent" : "[a] add agent",
        keys: { a: addAgent },
      };
    }

    case 2: {
      const autostart = existsSync(AUTOSTART.file);
      const conn = connectionStatus(s, running);
      return {
        columns: [["", 18], ["", 0]],
        rows: [
          {
            cells: ["connection", { text: `${conn.label}${s.computer?.name ? ` as ${s.computer.name}` : ""}`, tone: conn.tone }],
            note: conn.note,
          },
          {
            cells: ["start at login", autostart ? { text: "on", tone: "good" } : { text: "off", tone: "off" }],
            note: "When this is on, Salts tools starts by itself when you log in.",
            enter: () => {
              if (autostart) autostartOff();
              else autostartOn();
              say(`Start at login is now ${autostart ? "off" : "on"}.`);
            },
          },
          { cells: ["worker", workerUrl()], note: `The ${TARGET} Salts server. To change it, set SALTS_TOOLS_WORKER before connecting.` },
          { cells: ["secrets kept in", tokenStoreName()] },
          copyRow(["state and logs", HOME], HOME),
          {
            cells: ["disconnect", { text: "Disconnect this computer", tone: "bad" }],
            note: "Stops everything and turns this computer's tools off for every agent. Run salts-tools again to reconnect.",
            enter: () =>
              confirm("Disconnect this computer from Salts?", async () => {
                say(`${await disconnect()} Quit (q) and run salts-tools again to connect.`);
              }),
          },
          {
            cells: ["reset", { text: "Disconnect and forget everything", tone: "bad" }],
            note: "Disconnects, then deletes the saved secrets, state, logs and login item. Your tools' data is kept.",
            enter: () =>
              confirm("Stop, disconnect this computer and forget everything?", async () => {
                const done = await reset();
                say(`${done.length ? `${done.join(". ")}.` : "Nothing to reset."} Quit (q) and run salts-tools again to connect.`);
              }),
          },
        ],
        pos: ui.pos[2],
        hint: "[enter] change",
      };
    }

    default: {
      const pos = ui.pos[3];
      const rows = tail(LOG_FILE).map((line) => {
        const m = line.match(/^\d{4}-(\d\d-\d\dT\d\d:\d\d:\d\d)\S*\s(.*)$/);
        return { cells: m ? [m[1].replace("T", " "), m[2]] : ["", line] };
      });
      if (pos.tail) pos.sel = rows.length - 1;
      return {
        columns: [["", 15], ["", 0]],
        rows,
        pos,
        empty: "No log yet.",
      };
    }
  }
}

function render() {
  const width = Math.max(40, (process.stdout.columns ?? 80) - 1);
  const size = Math.max(3, (process.stdout.rows ?? 24) - 12);
  const s = readState();
  const running = Boolean(supervisorPid());
  const v = view();
  const out = [];

  out.push(`${BOLD}salts-tools${OFF} ${DIM}${TARGET} · ${s.worker || DEFAULT_WORKER}${OFF}`);
  const conn = connectionStatus(s, running);
  out.push(
    s.unpaired
      ? paint(`  ${conn.note}`, "bad")
      : !running
        ? paint(`  Not running. Press "s" to start.`, "off")
        : s.url
          ? `${paint(`  tunnel ${s.url}`, "good")}  ${paint(conn.label, conn.tone)}`
          : paint(`  Opening a tunnel…${s.lastError ? `  ${s.lastError}` : ""}`, s.lastError ? "bad" : "busy")
  );
  const trouble = [
    NAMES.some((n) => serviceStatus(s, n, running).tone === "bad"),
    (ui.agents ?? []).some((a) => a.todos.length),
    conn.tone === "bad",
  ];
  out.push(
    TABS.map((name, i) => {
      let label = ` ${i + 1} ${name}`;
      if (trouble[i]) label += " !";
      label += " ";
      return i === ui.tab ? `${INV}${BOLD}${label}${OFF}` : label;
    }).join(" ")
  );
  out.push(`${DIM}${"─".repeat(width)}${OFF}`);

  if (v.title) out.push(`${BOLD}  ${v.title}${OFF}`);
  if (v.columns.some(([t]) => t)) {
    out.push(`${DIM}  ${rowText(v.columns.map(([t]) => t), v.columns, width - 2)}${OFF}`);
  }

  const pos = v.pos;
  if (!v.rows.length) {
    out.push(`${DIM}  ${v.empty ?? ""}${OFF}`);
  } else {
    follow(pos, v.rows.length, size);
    v.rows.slice(pos.top, pos.top + size).forEach((row, i) => {
      const text = `  ${rowText(row.cells, v.columns, width - 2)}`;
      out.push(pos.top + i === pos.sel ? `${INV}${text}${OFF}` : text);
    });
    if (pos.top + size < v.rows.length) out.push(`${DIM}  ↓ more${OFF}`);
  }

  out.push(`${DIM}${"─".repeat(width)}${OFF}`);
  if (ui.edit) {
    // The cursor is drawn rather than moved: the screen is repainted whole on every
    // change, so a real cursor position would be lost on the next paint. A secret is
    // shown as dots.
    const shown = ui.edit.secret ? "•".repeat(ui.edit.buffer.length) : ui.edit.buffer;
    out.push(`  ${BOLD}${ui.edit.label}${OFF} ${shown}${INV} ${OFF}`);
    out.push(`${DIM}  [enter] save   [esc] cancel${OFF}`);
  } else if (ui.confirm) {
    out.push(`  ${BOLD}${ui.confirm.prompt}${OFF}`);
    out.push(`${DIM}  [y] yes   [any other key] cancel${OFF}`);
  } else {
    // Two lines kept for the note, so the hints below do not jump as the selection moves.
    const note = wrap(v.rows[pos.sel]?.note ?? "", width - 2);
    for (let i = 0; i < 2; i++) out.push(note[i] ? `${DIM}  ${note[i]}${OFF}` : "");
    // Keys wrap between hints, never inside one.
    const hints = [...(v.hint ?? "").split(/\s{3,}/), "[↑/↓] move", "[←/→] switch tab", "[q] quit"].filter(Boolean);
    const lines = [""];
    for (const hint of hints) {
      const last = lines.length - 1;
      if (lines[last] && lines[last].length + 3 + hint.length > width - 2) lines.push(hint);
      else lines[last] = lines[last] ? `${lines[last]}   ${hint}` : hint;
    }
    for (const line of lines) out.push(`${DIM}  ${line}${OFF}`);
  }
  if (ui.status) out.push(`  ${ui.status}`);

  process.stdout.write(`\x1b[H\x1b[2J${out.join("\n")}\n`);
}

/** The line editor: printable characters, backspace, enter, esc. Pasting works. */
async function onEditKey(key) {
  const edit = ui.edit;
  if (key === "\x1b") {
    ui.edit = null;
    return say("");
  }
  if (key === "\r" || key === "\n") {
    ui.edit = null;
    return await edit.submit(edit.buffer);
  }
  if (key === "\x7f" || key === "\b") edit.buffer = edit.buffer.slice(0, -1);
  else if (key.length === 1 && key >= " ") edit.buffer += key;
  render();
}

function quit() {
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  if (supervisorPid()) console.log(`\nSalts tools is still running, so your agents can keep using this computer.\n\n  To stop it, run:\n${commandLine(withTarget("stop"))}\n`);
  process.exit(0);
}

function switchTab(tab) {
  ui.tab = (tab + TABS.length) % TABS.length;
  say("");
}

async function onKey(key) {
  if (key === "\u0003") quit();
  if (ui.edit) return await onEditKey(key);
  if (ui.confirm) {
    const { run } = ui.confirm;
    ui.confirm = null;
    if (key === "y" || key === "Y") return await run();
    return say("Cancelled.");
  }
  if (key === "q") quit();

  if (key >= "1" && key <= String(TABS.length)) return switchTab(Number(key) - 1);
  if (key === "\x1b[C" || key === "\t" || key === "l") return switchTab(ui.tab + 1);
  if (key === "\x1b[D" || key === "\x1b[Z" || key === "h") return switchTab(ui.tab - 1);

  const v = view();
  const row = v.rows[v.pos.sel];
  if (key === "\x1b[A" || key === "k") {
    v.pos.sel = Math.max(0, v.pos.sel - 1);
    v.pos.tail = false;
  } else if (key === "\x1b[B" || key === "j") {
    v.pos.sel = Math.max(0, Math.min(v.rows.length - 1, v.pos.sel + 1));
    v.pos.tail = v.pos.sel === v.rows.length - 1;
  } else if ((key === "\r" || key === "\n") && row?.enter) {
    ui.status = "";
    return await row.enter();
  } else if (v.keys?.[key]) return await v.keys[key](row);
  render();
}

/** The dashboard, opening on `tab` (the Agents tab after a first pairing). */
function dashboard(tab = 0) {
  ui.tab = tab;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  render();
  void loadAgents();
  // Agents and what is left to do change on the site and in other terminals too.
  setInterval(() => void loadAgents(), 15_000);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    for (const key of keys(chunk)) {
      try {
        await onKey(key);
      } catch (err) {
        say(paint(err.message, "bad"));
      }
    }
  });
  process.stdout.on("resize", render);
  process.on("SIGINT", quit);
  // The supervisor works in the background; repaint so the screen keeps up with it.
  setInterval(render, 1000);
}

const usage = `
Usage

  salts-tools                    Start Salts tools if needed, then open the dashboard
  salts-tools start              Connect this computer (on first run) and start
  salts-tools stop               Stop everything
  salts-tools restart            Open a new tunnel
  salts-tools disconnect         Disconnect this computer. Its tools turn off for every agent
  salts-tools reset              Disconnect and forget everything on this computer
  salts-tools autostart on|off   Start by itself when you log in, or stop doing that

Add agents and choose their tools in the dashboard's Agents tab.
For staging, add :staging to any command, e.g. salts-tools :staging or salts-tools start:staging.
`;

try {
  // Not before `reset`: it deletes salts-web's leftovers rather than moving them.
  if (cmd !== "_supervise" && cmd !== "reset") await migrateFromSaltsWeb();
  switch (cmd) {
    case "":
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(usage);
        break;
      }
      // Connected and running first, so the dashboard has something to show. Straight
      // after pairing, it opens on the agents to choose.
      {
        const pairing = !readCredential() || readState().unpaired;
        if (pairing || !supervisorPid()) {
          if (!(await start({ interactive: true, summarize: false }))) break;
          await sleep(1500);
        }
        dashboard(pairing ? 1 : 0);
      }
      break;
    case "start":
      await start({ interactive: process.stdin.isTTY });
      break;
    case "setup":
      console.log(`\nAgents and their tools are managed in the dashboard. To open it, run:\n${commandLine(SUFFIX ? `:${TARGET}` : "")}\nthen open the Agents tab.\n`);
      break;
    case "disconnect":
      console.log(`${GREEN}✓${OFF} ${await disconnect()}`);
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await restart();
      break;
    case "reset": {
      const done = await reset();
      for (const line of done) console.log(`${GREEN}✓${OFF} ${line}`);
      if (!done.length) console.log("Nothing to reset.");
      break;
    }
    case "autostart":
      if (args[0] === "on") autostartOn();
      else if (args[0] === "off") autostartOff();
      else throw new Error(`Use "autostart on" or "autostart off".`);
      console.log(`${GREEN}✓${OFF} Start at login is now ${args[0]}.`);
      break;
    case "_supervise":
      await supervise();
      break;
    case "help":
      console.log(usage);
      break;
    default:
      console.log(usage);
      process.exit(1);
  }
} catch (err) {
  console.error(`${RED}✗${OFF} ${err.message}`);
  process.exit(1);
}
