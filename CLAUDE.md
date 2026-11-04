# Project Rules

- Tests are expected. `agent/` runs vitest on `@cloudflare/vitest-pool-workers`;
  new behaviour lands with tests, and `npm run deploy` refuses on a red suite.
- No extra features or content beyond the ask.
- Changing a bang command or agent behaviour: check whether the docs need updating too —
  `agent/README.md` and the user guide in `frontend/content/guide/` (`commands.md` lists
  every command).
- Do not use Playwright.

# Admin: deployment settings

- Every hard limit (sessions, file storage, access-list size, agents per account, upload
  ceilings, tool rounds, page sizes, voice-note length) and every soft default (model
  catalogue, seeded model, system prompt, per-column starting values, MCP template
  catalogue) is one runtime document — no deploy needed.
- Defined in `agent/src/settings.ts`, stored in `AgentDirectory`, edited from the
  `admin-cli` Defaults and Limits tabs.
- Routes: `GET|PATCH /api/admin/settings`, same `x-api-secret` gate as below.
- No hardcoded fallbacks: every field is required. Until the stored document is complete
  the Worker 503s every route except `/api/admin/settings` and `/api/admin/stats`, and
  `npm run deploy` refuses (preflight runs `admin-cli check`). Deploy scripts run
  `admin-cli init` after `wrangler deploy`; `check` exits 2 (allowed) only when the
  live Worker predates the settings route — the one-time bootstrap.
- Adding an MCP server to the catalogue (tiles on the capabilities page): follow
  `docs/mcp-catalog.md`.
- Shipped defaults live in `admin-cli/defaults.json`; `npm run init` in `admin-cli`
  writes them for every unset field. Adding a setting = field in `settings.ts` + its
  default in `defaults.json` (a test checks the two agree).

# Admin: business account limits

- Owner (dhairyashah98@gmail.com) can set any account's agent limit directly, no separate approval needed.
- Route: `POST /api/admin/business-account { email, agent_limit }` on the deployed Worker.
- Auth: header `x-api-secret: <API_SECRET>`. Read value from `agent/.dev.vars` (local) or `wrangler secret list`/prod store — never print it or write it into a committed file.
- Deployed base URL: `https://api.salts.dev`.

# Git: no direct commits to main

- `main` is protected by a GitHub ruleset ("Protect main"): no direct pushes, no
  force-push, no deletion, no bypass (admins included). Every change lands through a PR.
- Never commit on `main` locally. Branch first (`git switch -c <branch>`), commit there,
  push the branch, open a PR with `gh pr create --base main`, merge with `gh pr merge`.
- Merging to `main` deploys production on Vercel. Pushing to `staging` deploys the
  staging web app (`git push origin <branch>:staging`); `staging` is not protected.

# Agent API (OpenAPI)

- Every route an agent API key can reach is a typed `createRoute` (`@hono/zod-openapi`) in
  `agent/src/routes/*`, registered in `agent/src/api/index.ts`. The spec at `/openapi.json`
  is generated from those schemas and drives the user guide's API playground — never
  hand-write it. Schemas mirroring a TS type are pinned to it in `agent/src/api/schemas.ts`.

# Layout

- `agent/` — agent code
- `frontend/` — Next.js app (pnpm)
- `app-experiments/devcon-jobs-matchmaker/` — Next.js app (pnpm, local MongoDB): standalone jobs matchmaker on the staging agent via its API key
- `app-experiments/hsk-swap-mcp/` — MCP server (Python/uv), runs locally: a wallet's HSKswap positions and P&L on HSK Chain testnet, read live
- `salts-tools/` — laptop CLI: runs local services behind one ngrok tunnel, pushes their URLs to the agent
- `local-mcps/` — MCP servers salts-tools runs (`matchmaker-mcp`, `analyst-mcp` for Excel/CSV analysis,
  `zcash-wallet-mcp` for a Zcash light wallet over `zingo-cli`; Python/uv)

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **serverless-agent** (2758 symbols, 6102 relationships, 237 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/serverless-agent/context` | Codebase overview, check index freshness |
| `gitnexus://repo/serverless-agent/clusters` | All functional areas |
| `gitnexus://repo/serverless-agent/processes` | All execution flows |
| `gitnexus://repo/serverless-agent/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
