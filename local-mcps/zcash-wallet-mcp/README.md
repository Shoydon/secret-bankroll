# zcash-wallet-mcp

A Zcash wallet your agent can use, running on your own computer.

It is an MCP server in front of [`zingo-cli`](https://github.com/zingolabs/zingolib), the Zcash
light wallet. The keys never leave this machine: the agent asks the server, the server runs
`zingo-cli`, and `zingo-cli` talks to a Zcash indexer. Four tools:

| Tool | What the agent can do | Network |
| --- | --- | --- |
| `wallet_address` | Show the wallet's addresses: the unified ones to be paid at, and the transparent ones | no |
| `wallet_balance` | Show the balance per pool and in total, in ZEC | syncs first |
| `new_shielded_address` | Make a fresh shielded address (orchard + sapling, no transparent receiver) | no |
| `send_zcash` | Send ZEC to any address, with an optional memo | syncs, signs, transmits |

Run it through [salts-tools](../../salts-tools/README.md) and it reaches your agent over the same
tunnel as the other tools — nothing to copy by hand. It also runs on its own over stdio.

## What you need first

`zingo-cli` is built from source; there is no package for it. The build also produces `nym-proxy`
and puts it beside the binary, and a session that goes online needs that proxy there.

```bash
# Rust (https://rustup.rs) and cargo-make
cargo install cargo-make

git clone https://github.com/zingolabs/zingolib.git
cd zingolib
makers run-cli --build-only
# → ./target/release/zingo-cli and ./target/release/nym-proxy
```

Then point this server at it:

```bash
cp .env.example .env
# ZINGO_CLI_BIN=/path/to/zingolib/target/release/zingo-cli
```

## Running it

```bash
uv sync
MCP_TRANSPORT=http MCP_AUTH_TOKEN=secret MCP_PORT=8580 uv run zcash-wallet-mcp
```

Over stdio instead (for a client that launches it itself): leave `MCP_TRANSPORT` unset.

## Your wallet

The wallet lives in `DATA_DIR/wallets/<chain>` — `./data/wallets/mainnet` by default. `zingo-cli`
creates one the first time it runs there, and `data/` is kept when salts-tools updates the server.

**Back up the seed phrase.** This server has no tool that prints it, on purpose: a seed phrase in a
chat is a seed phrase in a log. Read it yourself and keep it somewhere safe:

```bash
zingo-cli --data-dir <DATA_DIR>/wallets/mainnet --chain mainnet recovery_info
```

To use a wallet you already have, restore it with `zingo-cli` into that directory before the agent
ever sees it (`--seed`, with `--birthday`; see the
[zingo-cli README](https://github.com/zingolabs/zingolib/blob/dev/zingo-cli/README.md)).

Each network keeps its own wallet. Switching `ZINGO_CHAIN` from `testnet` to `mainnet` does not move
your funds — it opens a different, empty wallet.

## Trying it on testnet first

```
ZINGO_CHAIN=testnet
ZINGO_SERVER=https://testnet.zec.rocks:443
```

Ask the agent for an address, get testnet ZEC from a faucet, and send some back out. Then switch to
`mainnet` (and `https://zec.rocks:443`, or leave `ZINGO_SERVER` unset and let `zingo-cli` choose).

## Settings

Every one of these is optional except the binary; see `.env.example`.

| Setting | Default | What it does |
| --- | --- | --- |
| `ZINGO_CLI_BIN` | `zingo-cli` | The binary. A bare name is looked up on `PATH`. |
| `ZINGO_CHAIN` | `mainnet` | `mainnet`, `testnet` or `regtest`. |
| `ZINGO_SERVER` | unset | The indexer to sync and send through. Unset, `zingo-cli` picks one. |
| `DATA_DIR` | `./data` | The wallet lives in `DATA_DIR/wallets/<chain>`. |
| `MAX_SEND_ZEC` | `1` | The most one `send_zcash` call may move. |
| `ZINGO_TIMEOUT_SECONDS` | `600` | How long any one `zingo-cli` run may take. |

## Before you give an agent your mainnet wallet

- **`send_zcash` spends real money and cannot be undone.** The model decides the amount and the
  address from what you said in the chat. Read a payment back before you agree to it.
- **`MAX_SEND_ZEC` is the ceiling, and it is the only one.** There is no daily total and no
  allow-list of payees: one call cannot exceed it, ten calls can. Set it to an amount you would not
  mind losing, and keep the bulk of your ZEC in a wallet no agent can reach.
- **Reads are private, a send is not.** A transparent (`t…`) address and anything paid to it is
  public on the chain forever. The shielded pools are not, which is why
  `new_shielded_address` makes addresses without a transparent receiver.
- **Whoever can reach the MCP endpoint can spend.** Through salts-tools it is behind the gateway
  token and switched on per agent; run it yourself and the bearer token is all that stands in front
  of your wallet.
