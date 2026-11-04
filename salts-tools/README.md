# salts-tools — local services for a salt-agent, behind one tunnel

salts-tools runs services for Salts agents on your own computer and puts all of them on
the internet through a single cloudflared quick tunnel (free, no account):

| Service | What it is | Put on the agent as |
| --- | --- | --- |
| `web` | [SearXNG](https://github.com/searxng/searxng), a self-hosted metasearch engine (Google, Bing, DuckDuckGo, Brave, Wikipedia and about 70 others, merged, over a JSON API). No account, no API key, no per-query bill. | **SearXNG URL** and **SearXNG token**: `<tunnel>/web` |
| `matchmaker` | [local-mcps/matchmaker-mcp](../local-mcps/matchmaker-mcp/docs/matchmaker-spec.md): resumes and cover letters in, the best people for a job out, as an MCP server. Files on disk, no Docker. | MCP server `matchmaker`: `<tunnel>/matchmaker/mcp` |
| `analyst` | [local-mcps/analyst-mcp](../local-mcps/analyst-mcp/README.md): Excel and CSV analysis as an MCP server. It reads workbooks sent in the chat, answers questions about them, previews tables and charts, and returns built workbooks. No Docker. | MCP server `analyst`: `<tunnel>/analyst/mcp` |
| `coinbase-wallet` | Coinbase Wallet, from Coinbase's [Payments MCP](https://github.com/coinbase/payments-mcp) package: a non-custodial USDC wallet app (Base, Polygon, Solana) plus an MCP server that pays x402 endpoints, such as a Coinbase Business checkout's `x402_url`. It speaks stdio only; salts-tools puts it on loopback HTTP through `stdio-bridge.mjs`. | MCP server `coinbase-wallet`: `<tunnel>/coinbase-wallet/mcp` |
| `zcash-wallet` | [local-mcps/zcash-wallet-mcp](../local-mcps/zcash-wallet-mcp/README.md): a Zcash light wallet, as an MCP server. Its addresses, its balance, a new shielded address, and sending ZEC — on top of [`zingo-cli`](https://github.com/zingolabs/zingolib), whose keys stay on this computer. No Docker. | MCP server `zcash-wallet`: `<tunnel>/zcash-wallet/mcp` |

The computer is paired with the user's Salts account once, from the browser; that is
the only thing done there. After that, the user adds agents to the dashboard by ID (or
a link to one) and switches tools on and off per agent in it, and the Worker keeps each
agent pointed at the tunnel. Only agents added there are listed, so an owner of a fleet
sees just the ones this computer serves. Nothing else is copied by hand: no tokens, no
tunnel addresses.

The CLI:

- runs each service bound to `127.0.0.1` only
- runs a gateway on loopback that routes by the first path segment and refuses anything
  without the gateway token, except a service's share links (`/<service>/share/…`)
- opens one cloudflared tunnel to the gateway, so every service shares its address
- runs every service this machine can run, whether or not an agent uses it yet
- reports to the Worker every 30 seconds
- rebuilds the tunnel whenever it drops or moves
- optionally starts at login

It runs on macOS, Linux and Windows.

## Requirements

- Node 20 or later.
- cloudflared: `brew install cloudflared` (macOS), `winget install --id Cloudflare.cloudflared`
  (Windows), or [the Cloudflare downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (Linux). No Cloudflare account is needed.
- For `web` only: Docker with the compose plugin. Docker does not need to start at login.
  - macOS: Docker Desktop, OrbStack or Colima. salts-tools starts it when it is not running.
  - Windows: Docker Desktop. salts-tools starts it when it is not running.
  - Linux: Docker Engine, Docker Desktop or Colima. salts-tools starts Docker Desktop and
    Colima itself. Docker Engine runs as a system service, so start it with
    `sudo systemctl enable --now docker`, and add your user to the `docker` group so
    `docker info` works without `sudo`.
- For `coinbase-wallet`: nothing beyond Node. salts-tools runs Coinbase's installer
  (`npx @coinbase/payments-mcp install --client other --no-auto-config`) the first time,
  which puts the wallet app (Electron) in `~/.payments-mcp`. Updating it is left to the
  user: `npx @coinbase/payments-mcp install`.
  When that installer fails (it gives up when the release Coinbase names as latest has no
  zip yet), salts-tools installs it directly: the newest patch release of that version
  that downloads, unzipped into `~/.payments-mcp`, then `npm install` (`coinbase-wallet.mjs`).
- For `matchmaker`, `analyst` and `zcash-wallet`: [uv](https://docs.astral.sh/uv/). salts-tools
  runs `uv sync` the first time.
- For `zcash-wallet` also: the `zingo-cli` binary, which has no package anywhere and is built from
  [zingolib](https://github.com/zingolabs/zingolib) (`cargo install cargo-make`, then
  `makers run-cli --build-only`). That build also produces `nym-proxy` and puts it beside the
  binary; a wallet that goes online needs it there. Then name the binary in the server's `.env`:
  `ZINGO_CLI_BIN=/path/to/zingolib/target/release/zingo-cli`. The Tools tab shows the folder, the
  network, the wallet directory and the per-send limit.
- Linux only, optional: `secret-tool` (package `libsecret-tools` on Debian/Ubuntu,
  `libsecret` on Fedora/Arch) to keep the secrets in the desktop keyring. See
  [Where things live](#where-things-live).

A tool whose requirement is missing shows as `error` in the dashboard, with what to
install; the others run regardless.

## Install

Nothing to install: run it with `npx salts-tools <command>`. npx fetches the package from
npm the first time. The package carries the matchmaker, analyst and Zcash wallet sources, which it
installs into `~/.salts-tools/mcps/<name>` (their `.venv`, `.env` and `data` live there and
are kept when a new version is installed over them). The login item runs it through npx too.

From a clone of this repo, `npm link` in `salts-tools` puts `salts-tools` on your PATH,
or run `node salts-tools/cli.mjs <command>`. A clone runs the MCP servers in place from
`local-mcps/`.

### Publishing

```bash
cd salts-tools
npm version minor   # a new version makes every npx install copy the MCP servers again
npm publish         # prepack copies local-mcps/{matchmaker,analyst,zcash-wallet}-mcp into mcps/
```

## First run

```bash
npx salts-tools
```

1. Checks that cloudflared is installed.
2. Opens a pairing with the Worker (`POST /salts/pair`), prints a code and a link to
   `<site>/salts-tools/pair?code=…`, and opens it in the browser.
3. The signed-in user checks the code and clicks **Connect**. salts-tools polls
   (`POST /salts/pair/poll`) and receives this computer's credential, once. It makes a
   gateway token if it has none.
4. Starts the supervisor, which reports in.
5. Asks whether to start salts-tools at login, then opens the dashboard on the Agents tab.

There the user presses `a` and enters an agent's ID or a link to it (`POST
/salts/computer/agents/:id` registers it with no tools on; one the user is not a member
of is refused), then switches tools on for it (`PUT /salts/computer/agents/:id`).
Unregistering (`DELETE …/:id`) turns every tool off for it and takes it off the list. The agent lists what is still to do before they work, and
`enter` does it: switch on a capability a tool needs (`POST …/capability`), type in a
header value such as the matchmaker's OpenRouter key (`PUT …/headers`, never shown or
sent back). A Brave key that would take over from SearXNG, or a server of the same name
set up some other way, is pointed out.

## The matchmaker and the analyst

The Worker creates the agent's MCP server (`matchmaker` or `analyst`) with
`Authorization: Bearer <gateway token>`. For the matchmaker it adds these headers empty,
for the user to fill in once on the agent; they are kept when the address changes:

| Header | Suggested value | Covers |
| --- | --- | --- |
| `X-OpenRouter-Api-Key` | your OpenRouter key | pays for its model calls |
| `Tool-Call-Max-Charge` | `0.25` | optional: the most one call may spend, in US dollars (a resume ~$0.001, a judged page of 50 ~$0.10) |

The analyst needs **File ingest** and **MCP** switched on for the agent; the dashboard
offers to switch them on.

Deleting the server on the agent switches that tool off for that agent, so it stays
deleted. A server of the same name set up some other way is never touched; the dashboard
says the name is taken.

Each server's own `.env` still applies (`MM_DATA_DIR`, models, `DATA_DIR`, `INBOX_DIR`,
`ALLOW_PYTHON`, …). salts-tools overrides the transport, host, port and token. Logs:
`~/.salts-tools/matchmaker.log`, `~/.salts-tools/analyst.log`.

## Coinbase Wallet

One Payments MCP process serves every agent, over the bridge in `stdio-bridge.mjs`: one
JSON-RPC message per `POST /mcp`, answered as JSON. Request ids are swapped so two
callers cannot collide, `initialize` reaches the server once and is answered from
memory after that, and anything the server asks of the client (sampling, elicitation)
is refused. The bridge checks the gateway token like every other service.

The wallet is signed in to on this computer: the agent's `show_wallet_app` tool opens it.
Spend limits per call and per session are set there, and the agent cannot change them.
The server also offers `send` and `trade`, which move funds to any address; the user
guide recommends switching them off on the agent's server card, and switching the
server off for Telegram groups. Log: `~/.salts-tools/coinbase-wallet.log`.

## Dashboard

`npx salts-tools` (`npx salts-tools :staging` for staging) starts salts-tools if it is not
running, then opens a full-screen dashboard. It has four tabs and updates every second
while the supervisor works in the background.

| Tab | Shows | Keys |
| --- | --- | --- |
| 1 Services | Display only. Each service and its status: `live` (an agent uses it), `live · not in use`, `error` (it cannot run here, or failed, with why), `starting` on the way up. `enter` opens a service: who uses it, its address, port, files and log. | `s` start, `r` new tunnel, `x` stop everything |
| 2 Agents | The agents added to this computer, and the tools on for each. `a` adds one by its ID or a link to it. `enter` opens an agent: a switch per tool, what is left to do (`enter` does it), and unregister it. | `a` add agent, `enter` toggle, `esc` back |
| 3 Settings | The connection, start at login, the Worker, where files live, disconnect, reset. | `enter` change |
| 4 Log | The supervisor's log, newest at the bottom. | |

On every tab: `↑`/`↓` move, `←`/`→` or `1`–`4` switch tab, `q` quits. The line under the
list explains the selected row. Quitting leaves the services running.

## Commands

| Command | What it does |
| --- | --- |
| `salts-tools` | Starts if needed (pairing on first run), then opens the dashboard. |
| `salts-tools start` | Checks the machine, pairs on first run, starts the supervisor. The login item runs this; unattended, it never pairs. |
| `salts-tools stop` | Stops the supervisor, the tunnel and the containers. The next `start` brings back the same services. |
| `salts-tools restart` | Opens a new tunnel; the agents follow it on the next report. |
| `salts-tools disconnect` | Unpairs this computer (`DELETE /salts/computer`, which takes its tools off every agent) and stops it. The gateway token and state stay, so pairing again reuses them. |
| `salts-tools reset` | Stops everything, disconnects this computer (`DELETE /salts/computer`, which takes its tools off every agent), and deletes both secrets, `~/.salts-tools` (except `mcps/` and `staging/`), the login item and any salts-web leftovers. Keeps the matchmaker's people and jobs and the analyst's files. |
| `salts-tools autostart on` / `off` | Adds or removes the login item. |

## Staging

Add `:staging` to any command to use the staging Worker
(`api-staging.salts.dev`) and the staging site instead of
production:

```bash
npx salts-tools :staging
npx salts-tools stop:staging
npx salts-tools reset:staging
```

Staging runs as a separate instance, with its own credential, gateway token, state,
containers, ports, tunnel and login item, so it can run alongside production. State and
logs are in `~/.salts-tools/staging/`. `SALTS_TOOLS_WORKER` and `SALTS_TOOLS_APP`
override the Worker and the site.

## How it stays up

`start` launches a background supervisor. It runs the gateway on `127.0.0.1` and, every
30 seconds:

- Brings up each service that does not answer on loopback (starting Docker if needed),
  unless something it needs is not installed.
- Restarts cloudflared if it is not running; opens a new tunnel after three failures in
  a row to reach the tunnel from outside.
- Reports to the Worker (`PUT /salts/computer`, the credential as bearer): the tunnel
  address, the gateway token, version, and for each tool its kind, state (`ready`,
  `starting`, `missing`, `failed`, `off`), what it is waiting on, the headers it wants
  filled in and the capabilities it needs. The Worker brings every agent served in step
  and answers with those agents and the tools on for each. A report while a new tunnel
  opens keeps the last address on the agents.
- A credential the Worker refuses (the computer was disconnected) stops everything;
  `salts-tools` then pairs again.

At login, the login item runs `salts-tools start` without a terminal. That start skips
the Docker wait and leaves it to the supervisor, so login is never held up.

## Upgrading from an install that pushed addresses

Versions before 3 pushed addresses to agents listed by ID, proven by a token pasted into
each agent's SearXNG token field. The token stays in the secret store as the gateway
token, so on the first report after pairing, a newly linked agent adopts the tools that
token already reaches there (its SearXNG token, MCP servers whose `Authorization` is
`Bearer <token>`). They are repointed rather than removed, and headers filled in on them
are kept. The `/searxng/:agentId/*` routes remain on the Worker for installs that have not
upgraded.

## Security

- Every service listens on `127.0.0.1` only. cloudflared reaches only the gateway.
- The gateway refuses any request without `Authorization: Bearer <gateway token>`
  (compared in constant time) and passes the header on, so SearXNG's Caddy gate and the
  MCP servers check the same token again.
- The one exception is a `GET` or `POST` to `/<service>/share/…`: a link the matchmaker
  hands out for the user to open in a browser (a person's files, the bulk upload page).
  The link is a random 20-character code the matchmaker records with what it opens and
  when it expires (24 hours by default, `MM_LINK_TTL_HOURS`). The matchmaker checks it;
  SearXNG and the analyst still refuse the path without the token.
- The gateway sends each request on with a loopback `Host`, which the matchmaker's MCP
  library requires, and the address it came in on as `X-Forwarded-Host`, `-Proto` and
  `-Prefix`, so the matchmaker can write links to itself.
- The credential proves reports come from this computer. The Worker stores its hash
  only, and changes or removes only what carries this computer's gateway token. Whoever
  holds the credential can point the linked agents' tools at another address; whoever
  holds the gateway token can use the services. Neither is ever printed.

## Where things live

- **Secrets**: never passed on a command line or shown. The gateway token reaches
  SearXNG's Caddy container as `SALTS_TOKEN` and the MCP servers as `MCP_AUTH_TOKEN`.

  | Platform | Stored in |
  | --- | --- |
  | macOS | Keychain, service `salts-web`, accounts `searxng-token` (gateway token) and `computer-credential` |
  | Linux with `secret-tool` and a running keyring | Secret Service keyring, attributes `service=salts-web`, `account=…` as on macOS |
  | Linux without a keyring (headless) | `~/.salts-tools/token` and `~/.salts-tools/credential`, mode `0600` |
  | Windows | `%USERPROFILE%\.salts-tools\token.dpapi` and `credential.dpapi`, encrypted with DPAPI for the current user |

  Staging's accounts and files carry a `-staging` suffix or live under `staging/`.

- **State**: `~/.salts-tools/state.json` holds the Worker URL, the services wanted, the
  agents served and the tools as last reported, ports and the tunnel address. It
  contains no secrets.
- **Logs**: `~/.salts-tools/supervisor.log`, `~/.salts-tools/matchmaker.log`,
  `~/.salts-tools/analyst.log`.
- **Login item**:

  | Platform | Login item |
  | --- | --- |
  | macOS | LaunchAgent `~/Library/LaunchAgents/com.salts-tools.plist` |
  | Linux | systemd user unit `~/.config/systemd/user/salts-tools.service` |
  | Windows | `salts-tools.cmd` in the Startup folder (`shell:startup`) |

## Moving from salts-web

The first `salts-tools` command on a machine that ran salts-web stops the salts-web
supervisor and its tunnel, copies its Worker and port from `~/.salts-web` into
`~/.salts-tools` (the old `state.json` is renamed `state.json.migrated`), and replaces a
salts-web login item with a salts-tools one. The token stays where it is and becomes the
gateway token. The SearXNG containers are the same Docker project, so they are reused.

## Check it by hand

```bash
T=$(security find-generic-password -s salts-web -a searxng-token -w)   # macOS
# T=$(secret-tool lookup service salts-web account searxng-token)      # Linux, keyring
# T=$(cat ~/.salts-tools/token)                                        # Linux, no keyring
U=$(node -p 'require(process.env.HOME+"/.salts-tools/state.json").url')
curl -s -H "Authorization: Bearer $T" "$U/web/search?q=solana&format=json" | head -c 400
curl -s -H "Authorization: Bearer $T" "$U/matchmaker/healthz"
```

A request without the token gets a 401.

## Running SearXNG unguarded

To remove the token gate on a machine where nothing else can reach the port, add the
override file. Do not use it with the tunnel, because a public SearXNG with
`format: json` enabled is an open proxy.

```bash
salts-tools stop
cd web
SALTS_TOKEN=unused docker compose -f docker-compose.yml -f docker-compose.unguarded.yml up -d
curl -s 'http://localhost:8080/search?q=solana&format=json' | head -c 400
```

## Files

- `cli.mjs`: the CLI, the dashboard and the supervisor
- `computer.mjs`: pairing, the report to the Worker and what it says about each tool
- `status.mjs`: the status of each service and of the connection, read from `state.json`
- `tui.mjs`: the dashboard's drawing and key handling
- `gateway.mjs`: the token check (and the share-link exception) and path routing in front of every service
- `mcps.mjs`: where each MCP server runs from (the repo, or its installed copy from npm) and the login item's command
- `scripts/bundle-mcps.mjs`: copies the MCP servers into the package on `npm pack`/`npm publish`
- `test/`: tests (`npm test`)
- `web/docker-compose.yml`: the first-run secret generator, SearXNG (no host port), and
  the token gate on loopback
- `web/docker-compose.unguarded.yml`: an opt-in override that removes the gate
- `web/settings.yml`: enables the JSON format the agent parses and disables the limiter
- `web/limiter.toml`: turns off bot-detection throttling on a private instance
- `web/Caddyfile`: the bearer-token gate, which reads the token from the environment
