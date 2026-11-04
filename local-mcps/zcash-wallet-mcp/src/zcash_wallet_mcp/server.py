import asyncio
import functools
import inspect
import json
import logging
import sys
import traceback
from typing import Annotated

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse

from . import desk
from .amounts import to_zatoshis, zec
from .auth import BearerAuthMiddleware
from .config import get_settings
from .errors import ToolFailure
from .zingo import Zingo, parse_balance

log = logging.getLogger("zcash_wallet_mcp")

INSTRUCTIONS = """\
A Zcash light wallet running on the user's own computer (zingo-cli). It holds the user's own ZEC: the
addresses are theirs to receive on, the balance is theirs, and send_zcash spends their money.

Rules:
- Shielded by default. When the user asks for an address to give someone, prefer a unified or a
  shielded one; a transparent (t…) address is public on the chain, so only offer one when asked.
- Before send_zcash, say back to the user who is being paid and how much, and send only once they
  have agreed. Never guess an amount or an address, and never round an amount up.
- A send cannot be undone. Call send_zcash once per payment: if it errors, read the error before
  trying again, and never repeat a call that may already have gone out.
- The balance comes from a sync, so it can take a while. Report what the tool returns, never a
  number you remember from earlier in the chat.
"""

mcp = MCPServer(name="zcash-wallet-mcp", instructions=INSTRUCTIONS, version="0.1.0")

#: The order `balance` prints the pools in, and the names the tools show the user.
POOLS = ("orchard", "sapling", "ironwood", "transparent")


def tool_handler(name: str):
    """Runs the tool in a worker thread (every tool waits on a zingo-cli process) and turns failures
    into {code, message} errors, never tracebacks."""

    def decorate(fn):
        signature = inspect.signature(fn)

        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            sent = lambda: signature.bind_partial(*args, **kwargs).arguments  # noqa: E731
            try:
                return await asyncio.to_thread(functools.partial(fn, *args, **kwargs))
            except ToolFailure as e:
                log.warning("tool %s failed: %s %s (args: %s)", name, e.code, e.message, sent())
                return _error(e.code, e.message)
            except Exception as e:
                frames = "\n".join(
                    f"  {f.filename}:{f.lineno} in {f.name}" for f in traceback.extract_tb(e.__traceback__)
                )
                log.error("tool %s crashed: %s\n%s", name, type(e).__name__, frames)
                return _error("internal_error", f"unexpected server error ({type(e).__name__}); see server logs")

        return wrapper

    return decorate


def _result(text: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=text)])


def _error(code: str, message: str) -> CallToolResult:
    body = json.dumps({"error": {"code": code, "message": message}})
    return CallToolResult(content=[TextContent(type="text", text=body)], is_error=True)


def _table(head: list[str], rows: list[list[str]]) -> str:
    def clean(s: str) -> str:
        return str(s).replace("|", "\\|").replace("\n", " ")

    lines = ["| " + " | ".join(clean(h) for h in head) + " |", "|" + "---|" * len(head)]
    lines += ["| " + " | ".join(clean(c) for c in row) + " |" for row in rows]
    return "\n".join(lines)


def _cli() -> Zingo:
    return Zingo.from_settings(get_settings())


def _pools_of(record: dict) -> str:
    """Which receivers a unified address carries, as the user would say them."""
    return ", ".join(pool for pool in ("orchard", "sapling", "transparent") if record.get(f"has_{pool}")) or "none"


def _records(value: object, command: str) -> list[dict]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ToolFailure("zingo_unreadable", f"zingo-cli's `{command}` didn't return a list of addresses")
    return value


# ---------------------------------------------------------------------- tools


@mcp.tool(
    description=(
        "Show the Zcash wallet's addresses on this computer: its unified addresses (what to give someone who is "
        "paying the user) and its transparent ones. Reads the wallet on disk; no network, no sync."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("wallet_address")
def wallet_address() -> CallToolResult:
    cli = _cli()
    unified = _records(cli.run_json("addresses", network=False), "addresses")
    transparent = _records(cli.run_json("t_addresses", network=False), "t_addresses")
    if not unified and not transparent:
        return _result(f"This wallet has no addresses yet on {cli.chain}. Call new_shielded_address to make one.")

    parts = [f"Zcash wallet on {cli.chain}."]
    if unified:
        best = max(unified, key=lambda a: (a.get("has_orchard", False), a.get("has_sapling", False)))
        parts.append(f"Address to receive on (unified, {_pools_of(best)}):\n{best['encoded_address']}")
        parts.append(
            "Unified addresses:\n"
            + _table(
                ["Address", "Receivers", "Index"],
                [[a["encoded_address"], _pools_of(a), a.get("address_index", "")] for a in unified],
            )
        )
    if transparent:
        parts.append(
            "Transparent addresses (public on the chain; funds here must be shielded before they can be sent):\n"
            + _table(
                ["Address", "Index", "Scope"],
                [[a["encoded_address"], a.get("address_index", ""), a.get("scope", "")] for a in transparent],
            )
        )
    return _result("\n\n".join(parts))


Sync = Annotated[
    bool,
    Field(
        description=(
            "Fetch new blocks before answering. Minutes, not seconds — only worth it when the user is waiting "
            "on a payment that has just been sent to them."
        )
    ),
]


@mcp.tool(
    description=(
        "The Zcash wallet's balance on this computer, per pool and in total, in ZEC. Answers from the wallet on "
        "disk, as of its last sync, in about a second. Pass sync=true to fetch new blocks first, which takes "
        "minutes. A pool the wallet holds no viewing key for reads as unknown, not zero."
    ),
    annotations=ToolAnnotations(read_only_hint=True, destructive_hint=False),
)
@tool_handler("wallet_balance")
def wallet_balance(sync: Sync = False) -> CallToolResult:
    cli = _cli()
    # `balance` adds up the notes already in the wallet, so it needs no network. Only
    # bringing new ones in does, and that is minutes: never make a read wait on it.
    pools = parse_balance(cli.run("balance", network=sync))

    def show(key: str) -> str:
        value = pools.get(key)
        return "unknown" if value is None else zec(value)

    rows = [
        [pool, show(f"confirmed_{pool}_balance"), show(f"unconfirmed_{pool}_balance"), show(f"total_{pool}_balance")]
        for pool in POOLS
        if f"total_{pool}_balance" in pools or f"confirmed_{pool}_balance" in pools
    ]
    known = [v for key, v in pools.items() if key.startswith("confirmed_") and v is not None]
    unviewable = [pool for pool in POOLS if pools.get(f"confirmed_{pool}_balance", 0) is None]

    parts = [
        f"Confirmed balance on {cli.chain}: {zec(sum(known))} ZEC",
        _table(["Pool", "Confirmed", "Unconfirmed", "Total"], rows),
    ]
    if unviewable:
        parts.append(f"Not counted in the total: {', '.join(unviewable)} (this wallet has no viewing key for it).")
    parts.append(
        "Synced with the chain just now."
        if sync
        else "This is what the wallet holds as of its last sync. A payment that arrived since then is not in it "
        "yet — call wallet_balance(sync=true) to fetch new blocks, which takes a few minutes."
    )
    return _result("\n\n".join(parts))


@mcp.tool(
    description=(
        "Make a new shielded address for the Zcash wallet on this computer: a unified address with orchard and "
        "sapling receivers and no transparent one, so what it receives is private. Use it when the user wants an "
        "address to be paid at. Reads and writes the wallet on disk; no network."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False),
)
@tool_handler("new_shielded_address")
def new_shielded_address() -> CallToolResult:
    cli = _cli()
    # `oz`: an orchard receiver and a sapling one. Transparent receivers are new_taddress's.
    made = cli.run_json("new_address", "oz", network=False)
    if not isinstance(made, dict) or not made.get("encoded_address"):
        raise ToolFailure("zingo_unreadable", "zingo-cli's `new_address` didn't return an address")

    index = made.get("address_index", "?")
    parts = [f"New shielded address on {cli.chain} (index {index}):\n{made['encoded_address']}"]
    if made.get("has_transparent"):
        parts.append(
            "Careful: zingo-cli gave this address a transparent receiver too, so a sender may pay it in the clear."
        )
    else:
        parts.append("It has orchard and sapling receivers only, so anything paid to it arrives shielded.")
    return _result("\n\n".join(parts))


ToAddress = Annotated[
    str,
    Field(description="The address to pay: unified (u…), sapling (zs…/ztestsapling…) or transparent (t…)"),
]
AmountZec = Annotated[
    str,
    Field(description="How much to send, in ZEC, as a decimal string (at most 8 decimal places), e.g. \"0.05\""),
]
Memo = Annotated[
    str | None,
    Field(description="Optional note sent with the payment. Shielded addresses only; a transparent one carries none."),
]


@mcp.tool(
    description=(
        "Send ZEC from the Zcash wallet on this computer to another address. This spends the user's own money and "
        "cannot be undone: confirm the address and the amount with the user before calling it, and call it once. "
        "Syncs, signs and transmits, so it can take a few minutes."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False),
)
@tool_handler("send_zcash")
def send_zcash(to: ToAddress, amount_zec: AmountZec, memo: Memo = None) -> CallToolResult:
    settings = get_settings()
    address = to.strip()
    if not address:
        raise ToolFailure("invalid_address", "send_zcash needs the address to pay")

    zatoshis = to_zatoshis(amount_zec)
    cap = to_zatoshis(settings.max_send_zec)
    if zatoshis > cap:
        raise ToolFailure(
            "over_send_limit",
            f"{zec(zatoshis)} ZEC is over this wallet's {zec(cap)} ZEC limit for one send. "
            "The user can raise it with MAX_SEND_ZEC in the server's .env file.",
        )

    note = [memo.strip()] if memo and memo.strip() else []
    sent = _cli().run_json("quicksend", address, str(zatoshis), *note, network=True)
    txids = sent.get("txids") if isinstance(sent, dict) else None
    if not txids:
        raise ToolFailure(
            "send_not_confirmed",
            "zingo-cli reported no transaction id, so the send may not have gone out. Check wallet_balance "
            "before trying again.",
        )

    parts = [f"Sent {zec(zatoshis)} ZEC to {address} on {_cli().chain}.", f"Transaction id: {', '.join(txids)}"]
    if note:
        parts.append(f"Memo sent: {note[0]}")
    return _result("\n".join(parts))


SwapAmount = Annotated[
    str,
    Field(description='ZEC to swap as a decimal string, or "all" for the whole balance minus the network fee'),
]
EvmAddress = Annotated[str, Field(description="The EVM address (0x…) on Base Sepolia to receive the USDC")]


@mcp.tool(
    description=(
        "Testnet only: swap ZEC from this wallet for USDC on Base Sepolia at the desk's fixed rate. "
        "Pass amount \"all\" to swap everything; the network fee is taken out automatically. "
        "Sends the ZEC to the swap desk, then the desk pays USDC to evm_address. "
        "Spends the user's ZEC: confirm the amount first. Takes a few minutes."
    ),
    annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False),
)
@tool_handler("swap_zec_to_usdc")
def swap_zec_to_usdc(amount_zec: SwapAmount, evm_address: EvmAddress) -> CallToolResult:
    settings = get_settings()
    if settings.zingo_chain == "mainnet":
        raise ToolFailure("testnet_only", "the swap desk only runs on testnet")
    if not settings.desk_zec_address:
        raise ToolFailure("desk_not_configured", "set DESK_ZEC_ADDRESS in the server's .env")
    from web3 import Web3

    if not Web3.is_address(evm_address.strip()):
        raise ToolFailure("invalid_address", f"{evm_address} is not an EVM address")

    cli = _cli()
    most = cli.run_json("max_send_value", settings.desk_zec_address, network=False)
    most = int(most["max_send_value"]) if isinstance(most, dict) and "max_send_value" in most else None
    if amount_zec.strip().lower() in ("all", "max"):
        if not most:
            raise ToolFailure("nothing_to_send", "the wallet has nothing it can send after the fee")
        zatoshis = most
    else:
        zatoshis = to_zatoshis(amount_zec)
        if most is not None and zatoshis > most:
            zatoshis = most  # leave room for the network fee
    if zatoshis <= 0:
        raise ToolFailure("nothing_to_send", "the wallet has nothing it can send after the fee")
    cap = to_zatoshis(settings.max_send_zec)
    if zatoshis > cap:
        raise ToolFailure("over_send_limit", f"{zec(zatoshis)} ZEC is over the {zec(cap)} ZEC limit for one send")
    units = desk.usdc_units(settings, zatoshis)
    desk.check_liquidity(settings, units)

    sent = _cli().run_json("quicksend", settings.desk_zec_address, str(zatoshis), "swap", network=True)
    txids = sent.get("txids") if isinstance(sent, dict) else None
    if not txids:
        raise ToolFailure("send_not_confirmed", "zingo-cli reported no transaction id; no USDC was paid")

    try:
        usdc_tx = desk.pay_usdc(settings, evm_address.strip(), units)
    except Exception as e:
        raise ToolFailure(
            "usdc_payout_failed", f"ZEC sent (tx {', '.join(txids)}) but the USDC payout failed: {e}"
        ) from e
    return _result(
        f"Swapped {zec(zatoshis)} ZEC for {units / 1e6} USDC at {settings.desk_usdc_per_zec} USDC/ZEC.\n"
        f"ZEC tx: {', '.join(txids)}\n"
        f"USDC tx (Base Sepolia): https://sepolia.basescan.org/tx/{usdc_tx}"
    )


# ---------------------------------------------------------------------- transport


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True})


def build_http_app():
    settings = get_settings()
    if not settings.mcp_auth_token:
        raise SystemExit("MCP_AUTH_TOKEN is required for the http transport")
    app = mcp.streamable_http_app(host="0.0.0.0")  # tunnel Host headers allowed; bearer token still gates
    return BearerAuthMiddleware(app, settings.mcp_auth_token)


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.INFO)
    settings = get_settings()
    settings.wallet_dir().mkdir(parents=True, exist_ok=True)
    if settings.mcp_transport == "stdio":
        mcp.run("stdio")
    else:
        uvicorn.run(build_http_app(), host=settings.mcp_host, port=settings.mcp_port)


if __name__ == "__main__":
    main()
