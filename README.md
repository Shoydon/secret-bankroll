# Secret Bankroll

Private WhatsApp agent wallets for all your employees. Manage onchain salaries securely
without giving away business secrets or creating office politics.

Employees get an easy way to access their salary accounts directly from WhatsApp.

**Demo:** https://x.com/Always_Hungrie_/status/2118043007836635328

## salts-agent

Chat agents that run as Cloudflare Durable Objects — one DO per session, one per agent
— with a Next.js frontend that shows what every message costs, in tokens and in
Cloudflare resources, as it streams.

Agents share nothing: each has its own OpenRouter key, Telegram bot, WhatsApp number,
MCP servers, memories and sessions. The home page lists them; each one has a page of its
own. A fleet is a batch of agents one person creates, configures and pays for on behalf
of other people.

```
agent/         Cloudflare Worker + Durable Objects (the agent itself)
frontend/      Next.js web app: chat, settings, capabilities, fleets, and the user guide at /guide
landing-page/  Next.js marketing site
admin-cli/     Owner dashboard: counts, users, limit requests, deployment settings + their defaults
salts-tools/   Optional: local services for an agent (SearXNG, local MCPs) behind one tunnel from a laptop
local-mcps/    MCP servers salts-tools runs locally (matchmaker-mcp)
infra/vercel/  Terraform for the two Vercel projects
scripts/       Cloudflare cost queries (cost.sh, settle.sh)
docs/          Architecture, infrastructure, costs, MCP catalogue, WhatsApp setup
```

New here? [docs/architecture.md](docs/architecture.md) explains the Cloudflare primitives
from scratch, what each Durable Object owns, how a message travels end to end, and the one
object in the design that cannot be scaled horizontally.

## Run it

Two terminals.

```bash
# 1. the agent
cd agent && npm install && npm run dev        # http://localhost:8787
```

The agent is npm, not pnpm — `package-lock.json` is its lockfile, and installing it
with pnpm resolves an `@modelcontextprotocol/sdk` the Agents SDK cannot build against.
The frontend is pnpm.

`agent/.dev.vars` is gitignored. It holds `API_SECRET`, required for admin access to the project, and deployming without it is prohibited. There is no
deployment-wide OpenRouter key: every agent is given its own under Settings, and an
agent without one cannot answer. See `.dev.vars.example`.

The worker answers every request with **503** until its deployment settings are set
(see [Deployment settings](#deployment-settings) below). On a fresh local worker, once
`npm run dev` is up:

```bash
cd admin-cli && npm run init -- --dev         # writes the shipped defaults
```

`admin-cli/.env` holds the URL and `API_SECRET` for each target — `AGENT_URL` /
`API_SECRET` for production, the `_DEV` and `_STAGING` pairs for the others. See
`admin-cli/.env.example`.

```bash
# 2. the frontend
cd frontend && pnpm install && pnpm dev       # http://localhost:3000
```

`frontend/.env.local` points at the worker via `AGENT_URL`, and holds the Clerk keys —
see `.env.example`. It holds no shared secret: the worker identifies a caller by the
Clerk session token this app forwards. The frontend never talks to the worker from the
browser — every call goes through a Next route handler, so there is no CORS and no key
exposure.

The landing page is separate and talks to nothing:

```bash
cd landing-page && pnpm install && pnpm dev   # http://localhost:4000
```

Sign-in is Clerk, and a verified session token is the worker's gate: it answers nobody
it cannot identify. Each agent then carries its own list of email addresses, and an
address not on it is told the agent does not exist. `CLERK_ISSUER` in
`agent/wrangler.jsonc` names the Clerk instance whose signatures count — the worker
refuses to serve without it, and `npm run deploy` refuses to ship without it. It needs the
Clerk instance to emit an `email` claim in its session token.

The worker's `API_SECRET` opens the owner's admin routes (`admin-cli`) and names
nobody; acting as a user takes that user's Clerk sign-in. See `agent/README.md`.

## Deployment settings

Every limit and default the worker uses is a runtime setting: sessions per agent, file
storage, upload sizes, page sizes, tool rounds, the model list, the model a new agent
starts on, the system prompt, the starting value of each capability, and so on. They are
stored in the deployment and edited from `admin-cli` (`npm start`, then the **Defaults**
and **Limits** tabs), with no redeploy.

The worker has no built-in values for any of them. Their defaults ship with the admin
CLI, in [admin-cli/defaults.json](admin-cli/defaults.json), and have to be written to
each deployment before it will serve.

What that means in practice:

- **A worker with any setting unset returns 503** to every request except
  `/api/admin/settings` and `/api/admin/stats`. The response says only
  `Deployment is missing default settings`, which is what the UI shows; the unset
  fields are listed by `admin-cli check` and the dashboard, not to end users. This applies to a brand-new deployment, a fresh local `wrangler dev`
  database, and a deployment whose stored settings are partial.
- **`npm run init`** in `admin-cli` writes the default from `defaults.json` for every
  field that is unset. Fields already set are left alone. Add `-- --dev` or
  `-- --staging` to target those.
- **`npm run check`** in `admin-cli` exits 1 and lists the unset fields, or exits 0 when
  everything is set.
- **The admin CLI dashboard** marks the Defaults and Limits tabs, and each unset row in
  them, with `!`. `i` fills every unset row with its default; on a row, `enter` edits it
  and `d` sets it to the shipped value.
- **Settings cannot be unset or reset.** `PATCH /api/admin/settings` refuses `null`, and
  there is no `DELETE`. Change a value by setting a new one.

### Deploying

`npm run deploy` (and `deploy:staging`) in `agent/`:

1. typechecks and runs the test suite,
2. runs the preflight, which calls `admin-cli check` against the live deployment and
   **refuses to deploy if any setting is unset**,
3. runs `wrangler deploy`,
4. runs `admin-cli init` against the deployment it just shipped.

Step 4 covers a release that adds a new setting: the previous worker rejects keys it
does not know, so a new setting can only be written after the release that defines it
is live. `init` writes its default straight away.

If the preflight refuses, run `npm run init` (or `npm run init -- --staging`) in
`admin-cli`, then deploy again. This works against the worker that is currently live,
including one older than this change.

### First deploy onto a worker older than deployment settings

A live worker from before the settings route answers `/api/admin/settings` with 401,
because the route falls through to the sign-in check. `check` detects this — the same
secret still opens `/api/admin/stats` — and exits **2** instead of 1. The preflight
allows exit 2, the deploy installs the settings route, and step 4 writes the defaults.
The new worker returns 503 for the few seconds between `wrangler deploy` and `init`.

A wrong `API_SECRET` fails on both routes and still exits 1, so it cannot pass as this
case.

### Adding a setting

Add the field to `agent/src/settings.ts` and its default to `admin-cli/defaults.json`.
A test fails if the two disagree.

## What the UI shows

- **Home** — every agent. Creating one asks for a name and an OpenRouter key, so it
  can answer the moment it opens; deleting one takes its sessions, files, memories
  and MCP connections with it.
- **Left sidebar** — every session of the agent you opened. Each one is a separate
  Durable Object with its own SQLite database. Creating a session registers it;
  deleting one wipes its storage.
- **Header** — the model, message count, tokens, and the LLM spend for that session.
- **Each assistant message** — tokens in and out, dollar cost, and model latency.
- **Attach** — files, images or audio, when the matching capability is on.
- **Stop** — cancels the stream. The partial reply is kept, along with the tokens
  OpenRouter already billed for, and the Durable Object stops accruing duration.

Two pages sit behind the buttons at the bottom of the sidebar:

- **Settings** — how the agent talks: model, custom instructions, reasoning effort,
  temperature, reply cap, context window, auto-titling.
- **Capabilities** — what the agent can do: web search, reading a URL, file ingest, image
  input, image generation, audio input, voice notes, scheduled tasks, Telegram, WhatsApp,
  MCP servers, memory. The ones needing a key say so. See
  [agent/README.md](agent/README.md#capabilities).

The **Guide** (`/guide`) is the end-user documentation, written in Markdown under
`frontend/content/guide/`.

The model a new agent starts on and the models Settings offers are the `default_model`
and `models` deployment settings (shipped default: `deepseek/deepseek-v4-flash` on
OpenRouter). Meta settings can widen that per agent. Image input needs a multimodal model,
which is what each entry's `vision` flag records.

## Hosting and branches

[docs/infra.md](docs/infra.md) has the full picture. In short:

- The Worker deploys to Cloudflare with `npm run deploy` (or `deploy:staging`) in `agent/`.
- The web app and landing page deploy on Vercel from git. Merging to `main` ships
  production; pushing to the `staging` branch ships the staging web app.
- `main` is protected: every change lands through a pull request.

## Costs

The app shows LLM cost only, which OpenRouter reports exactly per call. Cloudflare's
costs are not shown: they cannot be measured honestly from inside the object, and their
analytics lag by minutes.

[docs/cloudflare-durable-object-costs.md](docs/cloudflare-durable-object-costs.md) has
the full picture — roughly **$0.00005 per message**, about 78% of it tokens and most of
the rest the Durable Object sitting awake waiting for the model. It also documents how to
query the real numbers, and the traps involved.
