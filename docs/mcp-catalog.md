# Adding an MCP server to the catalogue

The catalogue is the row of provider tiles on an agent's capabilities page. Picking a
tile fills in the add-server form with the provider's name, URL and auth type. The
frontend and the Worker ship no templates of their own: every tile comes from the
`mcp_catalog` deployment setting.

Shipped entries: Notion (`oauth`), Swiggy (`oauth`), Instamart (`oauth`), Porkbun (`oauth`), Bitrefill (`oauth`), GitHub (`headers`), Bonfire (`headers`), and the
salts-tools servers `matchmaker`, `analyst`, `coinbase-wallet` and `zcash-wallet` (`headers`, with a placeholder tunnel URL
that salts-tools repoints once the token matches).

## What an entry looks like

```json
{
  "id": "github",
  "name": "GitHub",
  "url": "https://api.githubcopilot.com/mcp/",
  "auth": "headers",
  "icon": "data:image/svg+xml;base64,…"
}
```

| Field | Rule |
|---|---|
| `id` | Unique, lowercase. Per-agent template filters (`meta.mcp.templates`) refer to it. |
| `name` | Shown on the tile and pre-filled as the server name. |
| `url` | The provider's remote MCP endpoint. It must speak Streamable HTTP. |
| `auth` | `oauth`, `headers` or `none`. See the next section. |
| `icon` | Optional SVG. Stored as a data URL, capped by the `max_icon_bytes` limit (20000 shipped). |
| `letter`, `color` | Optional. Used for the tile only when there is no `icon`. |
| `headers` | Optional. Header names and placeholder values the add form starts with, e.g. `{"Authorization": "Bearer API-KEY"}`. At most 8 plain names. |
| `description` | Optional. One line, at most 200 characters, shown in the popup when the tile is hovered. Every shipped entry has one. |
| `guide` | Optional. A user guide slug (`mcp-github` for `/guide/mcp-github`). Once the server is added, its card links to that article as **Open manual**. |

## Choosing `auth`

Our OAuth flow needs the provider's authorization server to support either **CIMD**
(client ID metadata documents, preferred) or **dynamic client registration**
(`agent/src/routes/mcp-oauth.ts`). Check which before choosing `oauth`:

```sh
# 1. The server names its authorization server in the 401 it sends back.
curl -s -i -X POST <url> -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
curl -s <resource_metadata url from above>      # read "authorization_servers"

# 2. That server's metadata must support CIMD or list a registration_endpoint.
curl -s https://<auth host>/.well-known/oauth-authorization-server/<path> \
  | grep -oE '"(client_id_metadata_document_supported|registration_endpoint)":[^,]*'
```

- `client_id_metadata_document_supported: true` (with `none` among its
  `token_endpoint_auth_methods_supported`, or no such list): use `oauth`. The Worker's
  client id is `<worker>/oauth/client.json`, and no registration happens.
- There is a `registration_endpoint`: use `oauth`. The user clicks through a sign-in. Notion works this way.
- Neither: use `headers`. The user pastes a token into the form
  as `Authorization: Bearer <token>`. GitHub works this way because it has no dynamic
  registration, so the user needs a personal access token.
- The server needs no credentials: use `none`.

## Getting an icon

Use the provider's official mark as an SVG. For example, GitHub's comes from
`primer/octicons` (`icons/mark-github-24.svg`) and Notion's from Wikimedia Commons
(`Notion-logo.svg`). Keep it under `max_icon_bytes`. The page draws icons with `<img>`,
so a script inside an SVG never runs. Colour the paths explicitly: `currentColor`
has nothing to inherit inside an `<img>`, so it renders black.

## Adding one

There are two places to update. Most of the time you need both.

**1. Shipped defaults** (fresh deployments, and the value `d` resets to):
add the entry to `mcp_catalog` in `admin-cli/defaults.json`, with `icon` already
encoded:

```sh
echo "data:image/svg+xml;base64,$(base64 -i logo.svg | tr -d '\n')"
```

Then run the tests (`cd agent && npm test`). The test "ships Notion with its own logo"
validates every shipped entry, including its icon and size.

**2. A live deployment** (dev, staging or production): `init` never overwrites a
setting that is already set, so a new shipped entry does not reach a running
deployment by itself. Open the CLI (`cd admin-cli && node index.mjs [--dev|--staging]`),
go to tab **4 Defaults** and select `mcp_catalog`. Then do one of these:

- Press `d` to replace the whole catalogue with the shipped one. This drops any entry
  that exists only on this deployment.
- Press `enter` and append the entry to the JSON. Set `"icon": "@path/to/logo.svg"`
  and the CLI reads the file and uploads it on save.

In the editor, `"@keep"` stands for an icon that is already stored. Leave it as it is
to keep that icon. Remove the `"icon"` key to fall back to the letter mark.

## Checking it

```sh
curl -s <worker>/api/agents/catalog -H "authorization: Bearer <your Clerk session token>" \
  | python3 -c 'import sys,json; print([e["id"] for e in json.load(sys.stdin)["mcp_catalog"]])'
```

Then open an agent's capabilities page with MCP on. The tile should be there, and
picking it should pre-fill the form.

## Things that override the catalogue

- An agent's own `meta.mcp.catalog` (set by whoever provisioned it) **replaces** the
  deployment catalogue for that agent. It does not add to it.
- `meta.mcp.templates` narrows the catalogue to the listed ids. An empty list means all of them.
- The code: `svgIcon` / `checkIconSize` and `case "mcp_catalog"` in
  `agent/src/settings.ts`, `validateCatalogEntry` in `agent/src/server.ts`, `toPreset`
  in `frontend/src/components/McpPresets.tsx`, and `loadIcons` in `admin-cli/index.mjs`.
