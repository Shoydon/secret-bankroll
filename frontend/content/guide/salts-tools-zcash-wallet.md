---
title: Add the Zcash wallet
section: salts-tools
order: 6
summary: Give your agent a Zcash wallet that lives on your own computer, so it can show you an address, tell you your balance and send ZEC for you, up to a limit you set.
---

The Zcash wallet gives your agent a [Zcash](https://z.cash) wallet of your own. It runs on your computer on top of `zingo-cli`, the Zcash light wallet, and your keys never leave the machine. Your agent can show you an address to be paid at, tell you your balance, make a new shielded address and send ZEC to someone, for example "what's my ZEC balance" or "send 0.1 ZEC to this address".

This guide will help you build `zingo-cli`, switch the wallet on, back up its seed phrase and set the limit that keeps your spending safe. You will need salts-tools installed (see [Install salts-tools](/guide/salts-tools-install)). The Zcash wallet does not need Docker, but it does need uv and `zingo-cli`.

## 1. Build zingo-cli

`zingo-cli` is the only salts-tools tool you have to build yourself: there is no download for it. You need [Rust](https://rustup.rs) first, and then one more command to get `cargo-make`:

```bash
cargo install cargo-make

git clone https://github.com/zingolabs/zingolib.git
cd zingolib
makers run-cli --build-only
```

The build takes a while the first time. It leaves two files in `zingolib/target/release`: `zingo-cli` and `nym-proxy`. Keep them together — the wallet cannot reach the Zcash network without the proxy beside it.

## 2. Tell salts-tools where it is

Open the `.env` file for the wallet. Run `npx salts-tools`, open the **Tools** tab and the **Zcash wallet** card: it shows you the folder. Put the path to the binary in that file:

```
ZINGO_CLI_BIN=/path/to/zingolib/target/release/zingo-cli
```

While you are in there, we recommend you start on Zcash's test network, where the coins are free and a mistake costs nothing:

```
ZINGO_CHAIN=testnet
```

## 3. Switch the Zcash wallet on

Run `npx salts-tools`, open your agent in the **Agents** tab and switch on **Zcash wallet**. The first time, salts-tools installs the server's packages, which takes a minute. Your agent then has a new MCP server called **zcash-wallet**, already connected. It needs **MCP servers** switched on for your agent; if that is off, your agent in the salts-tools screen shows it as **to do**, and pressing **Enter** switches it on.

Ask your agent "show me my Zcash address". The first time, a brand new wallet is created on your computer and your agent reads its address out of it.

## 4. Back up your seed phrase

A wallet is only as safe as its backup, and if you lose the seed phrase the coins are gone for good. **Your agent cannot show it to you, on purpose** — a seed phrase typed into a chat is a seed phrase saved in a log. Read it yourself instead. The **Zcash wallet** card in salts-tools shows you the wallet folder and the exact command; it looks like this:

```bash
zingo-cli --data-dir ~/.salts-tools/mcps/zcash-wallet-mcp/data/wallets/testnet \
  --chain testnet recovery_info
```

Write the words down on paper and keep them somewhere safe. Never paste them into a chat, an email or a note on your computer.

## 5. Set your send limit

Your agent chooses the amount and the address from what you asked it for, so the one thing that cannot be talked around is a limit. In the same `.env` file:

```
MAX_SEND_ZEC=0.1
```

No single payment can go above it. Note that it is a limit **per payment**, not per day: ten payments can still add up. We recommend two habits alongside it:

- **Keep only pocket money in this wallet.** Think of it as a prepaid card, not your savings. Your long-term ZEC belongs in a wallet no agent can reach.
- **Read a payment back before you agree to it.** Your agent will tell you the address and the amount; check both, because a send cannot be undone.

## 6. Switch off what you do not need

Open the **zcash-wallet** card on your agent's **Capabilities** page by clicking its name. We recommend two changes there:

- **Switch off Use in Telegram groups**, so that only you, in your private chats, can ask your agent about the wallet or to send from it. Anyone in a group your agent is in could otherwise spend your ZEC.
- **Switch off the `send_zcash` tool** if you only want your agent to read the wallet. With it off, your agent can still show addresses and balances but cannot move any money at all.

## Going to mainnet

When you are happy on testnet, change `ZINGO_CHAIN` to `mainnet` and restart salts-tools. **This opens a different, empty wallet** — each network keeps its own, and your testnet coins do not come with you. Back up the new wallet's seed phrase too, the same way as in step 4.

## Shielded and transparent

Zcash has two kinds of address, and the difference matters:

- A **shielded** address keeps the amount and who paid whom private. Your agent's `new_shielded_address` makes these, and this is what you should give someone paying you.
- A **transparent** address starts with `t`, and everything paid to it is public on the chain forever, like Bitcoin. Your wallet has them, and your agent will show them if you ask, but it offers a shielded one first.

## You are done

Ask your agent for an address, get some testnet ZEC from a faucet, and ask it to send a little back out. Your agent tells you the transaction id, and "what's my balance" shows the change once the network confirms it.
