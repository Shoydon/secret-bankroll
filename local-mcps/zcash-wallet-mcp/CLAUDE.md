# zcash-wallet-mcp

Zcash light wallet MCP server for a salt-agent (Python 3.12+, uv, mcp SDK 2.2). Four tools over
`zingo-cli`: the wallet's addresses, its balance, a new shielded address, and sending ZEC. No
database, no daemon: one `zingo-cli` process per tool call, in its command (one-shot) mode.

## Commands

```sh
uv sync
uv run pytest -q           # 53 tests, ~12 s, offline (a fake zingo-cli, no chain, no network)
uv run ruff check src tests
MCP_TRANSPORT=http MCP_AUTH_TOKEN=x MCP_PORT=8580 uv run zcash-wallet-mcp
```

`zingo-cli` is not on PATH by default and cannot be installed from a package manager: it is built
from [zingolib](https://github.com/zingolabs/zingolib) with `makers run-cli --build-only`, which
also bundles `nym-proxy` beside it. A session that goes online needs that proxy. The tests never
need the real binary.

## Layout (src/zcash_wallet_mcp)

| File | Role |
|---|---|
| `server.py` | The four tools, `tool_handler` (runs in a thread, ToolFailure → `{code, message}`), `/healthz`, transports |
| `zingo.py` | `Zingo`: the argv for a command, running it, `run_json`, and `parse_balance` |
| `amounts.py` | ZEC ↔ zatoshis, exactly (`Decimal`), and the display of an amount |
| `config.py` | Settings from the environment and `.env` |
| `auth.py` | Bearer-token gate for the http transport (`/healthz` exempt) |

## Decisions that must not be undone

- **Amounts go through `Decimal`, never `float`.** `to_zatoshis` rejects anything finer than a
  zatoshi rather than rounding it. Money must not be silently changed on its way to the chain.
- **A local command runs `--offline`.** `addresses`, `t_addresses` and `new_address` need no
  network, and zingo-cli refuses `--online` with a command that doesn't. `--offline` also stops a
  stored standing consent from putting a read on the network behind the user's back.
- **A network command runs `--waitsync`.** A balance or a send must see the chain as it is, not as
  the wallet last left it.
- **`quicksend`, never `send`.** `send` leaves a proposal for `confirm`, and a one-shot process
  exits before that can happen. `quicksend` proposes, signs and transmits in the one run.
- **`MAX_SEND_ZEC` is checked before zingo-cli runs.** The model picks the amount; the ceiling is
  the user's, and a refused send must not reach the wallet at all.
- **A pool with no viewing key reads as unknown, never 0.** `balance` prints "no view capability";
  showing that as zero would tell the user their money is gone.
- **The wallet directory is per chain** (`DATA_DIR/wallets/<chain>`): one directory shared by two
  networks makes zingo-cli refuse with a chain mismatch.
- **Tests run against a fake `zingo-cli`** (a shell script installed by `tests/conftest.py`), so the
  suite exercises the real subprocess — argv quoting, exit codes, stdout and stderr — with no chain,
  no keys and no network.
