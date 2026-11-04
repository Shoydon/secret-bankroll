import pytest

from zcash_wallet_mcp import server

from .conftest import argv_of, error, ok

ADDRESSES = [
    {
        "account": 0,
        "address_index": 0,
        "has_orchard": True,
        "has_sapling": True,
        "has_transparent": True,
        "encoded_address": "utest1receiveme",
    },
    {
        "account": 0,
        "address_index": 1,
        "has_orchard": True,
        "has_sapling": False,
        "has_transparent": False,
        "encoded_address": "utest1shieldedonly",
    },
]

TADDRESSES = [{"account": 0, "address_index": 0, "scope": "External", "encoded_address": "tm9transparent"}]

BALANCE = """[
    confirmed_ironwood_balance: 0
    unconfirmed_ironwood_balance: 0
    total_ironwood_balance: 0

    confirmed_orchard_balance: 123_456_780
    unconfirmed_orchard_balance: 0
    total_orchard_balance: 123_456_780

    confirmed_sapling_balance: 50_000_000
    unconfirmed_sapling_balance: 25_000_000
    total_sapling_balance: 75_000_000

    confirmed_transparent_balance: no view capability
    unconfirmed_transparent_balance: no view capability
    total_transparent_balance: no view capability
]"""


# ------------------------------------------------------------- wallet_address

async def test_wallet_address_shows_every_address_and_names_the_network(answers):
    answers({"t_addresses": TADDRESSES, "addresses": ADDRESSES})
    out = ok(await server.wallet_address())
    assert "testnet" in out
    assert "utest1receiveme" in out
    assert "utest1shieldedonly" in out
    assert "tm9transparent" in out


async def test_wallet_address_recommends_a_unified_address_for_receiving(answers):
    answers({"t_addresses": [], "addresses": ADDRESSES})
    out = ok(await server.wallet_address())
    assert out.splitlines()[0].startswith("Zcash wallet on testnet")
    assert "utest1receiveme" in out.split("| Address")[0]


async def test_wallet_address_never_goes_online(zingo, argv_log):
    zingo("echo '[]'")
    await server.wallet_address()
    assert "--offline" in argv_of(argv_log)
    assert "--online" not in argv_of(argv_log)


async def test_wallet_address_says_so_when_the_wallet_has_no_addresses_yet(zingo):
    zingo("echo '[]'")
    out = ok(await server.wallet_address())
    assert "no addresses" in out.lower()


async def test_wallet_address_reports_a_missing_zingo_cli_as_an_error(wallet):
    assert error(await server.wallet_address())["code"] == "zingo_cli_missing"


# ------------------------------------------------------------- wallet_balance

async def test_wallet_balance_shows_each_pool_in_zec(zingo):
    zingo(f"cat <<'B'\n{BALANCE}\nB")
    out = ok(await server.wallet_balance())
    assert "1.2345678" in out
    assert "0.75" in out


async def test_wallet_balance_totals_the_confirmed_pools_it_can_see(zingo):
    zingo(f"cat <<'B'\n{BALANCE}\nB")
    # 123_456_780 orchard + 50_000_000 sapling + 0 ironwood confirmed = 1.7345678 ZEC
    assert "1.7345678 ZEC" in ok(await server.wallet_balance())


async def test_wallet_balance_calls_a_pool_it_cannot_view_unknown_not_zero(zingo):
    zingo(f"cat <<'B'\n{BALANCE}\nB")
    out = ok(await server.wallet_balance())
    transparent = next(line for line in out.splitlines() if "transparent" in line)
    assert "unknown" in transparent
    assert "0" not in transparent.replace("transparent", "")


async def test_wallet_balance_reads_the_wallet_without_waiting_for_the_network(zingo, argv_log):
    """`balance` is a local command: it adds up the notes already in the wallet. Putting it
    on the network makes the user wait minutes on a sync to be told a number already on disk."""
    zingo(f"cat <<'B'\n{BALANCE}\nB")
    await server.wallet_balance()
    assert "--offline" in argv_of(argv_log)
    assert "--waitsync" not in argv_of(argv_log)


async def test_wallet_balance_says_the_number_is_as_of_the_last_sync(zingo):
    zingo(f"cat <<'B'\n{BALANCE}\nB")
    assert "last sync" in ok(await server.wallet_balance()).lower()


async def test_wallet_balance_syncs_first_when_asked_to(zingo, argv_log):
    zingo(f"cat <<'B'\n{BALANCE}\nB")
    await server.wallet_balance(sync=True)
    argv = argv_of(argv_log)
    assert "--waitsync" in argv and "--offline" not in argv


async def test_wallet_balance_reports_an_offline_refusal_as_an_error(zingo):
    zingo('echo "Error: this command needs the network and the session is offline" >&2; exit 1')
    assert error(await server.wallet_balance())["code"] == "zingo_failed"


# -------------------------------------------------- new_shielded_address

async def test_new_shielded_address_asks_for_orchard_and_sapling_receivers_only(zingo, argv_log):
    zingo("""echo '{"address_index": 2, "has_orchard": true, "has_sapling": true,
                     "has_transparent": false, "encoded_address": "utest1fresh"}'""")
    ok(await server.new_shielded_address())
    argv = argv_of(argv_log)
    assert argv[-2:] == ["new_address", "oz"]


async def test_new_shielded_address_returns_the_new_address(zingo):
    zingo("""echo '{"address_index": 2, "has_orchard": true, "has_sapling": true,
                     "has_transparent": false, "encoded_address": "utest1fresh"}'""")
    out = ok(await server.new_shielded_address())
    assert "utest1fresh" in out
    assert "shielded" in out.lower()


async def test_new_shielded_address_warns_when_zingo_cli_gave_it_a_transparent_receiver(zingo):
    zingo("""echo '{"address_index": 2, "has_orchard": true, "has_sapling": true,
                     "has_transparent": true, "encoded_address": "utest1leaky"}'""")
    out = ok(await server.new_shielded_address())
    assert "transparent" in out.lower()


# --------------------------------------------------------------- send_zcash

TXIDS = {"txids": ["ab12cd34"], "transmissions": [{"txid": "ab12cd34", "over_mixnet": True, "rtt_ms": 812}]}


async def test_send_zcash_passes_the_amount_to_zingo_cli_in_zatoshis(prints, argv_log):
    prints(TXIDS)
    ok(await server.send_zcash(to="utest1payee", amount_zec="0.25"))
    assert argv_of(argv_log)[-2:] == ["utest1payee", "25000000"]


async def test_send_zcash_returns_the_transaction_id(prints):
    prints(TXIDS)
    out = ok(await server.send_zcash(to="utest1payee", amount_zec="0.25"))
    assert "ab12cd34" in out
    assert "0.25" in out


async def test_send_zcash_sends_a_memo_when_one_is_given(prints, argv_log):
    prints(TXIDS)
    ok(await server.send_zcash(to="utest1payee", amount_zec="0.25", memo="rent for March"))
    assert argv_of(argv_log)[-1] == "rent for March"


async def test_send_zcash_passes_no_memo_argument_when_there_is_no_memo(prints, argv_log):
    prints(TXIDS)
    ok(await server.send_zcash(to="utest1payee", amount_zec="1"))
    argv = argv_of(argv_log)
    assert argv[argv.index("quicksend") + 1 :] == ["utest1payee", "100000000"]


async def test_send_zcash_refuses_more_than_the_configured_cap_without_running_zingo_cli(prints, argv_log):
    prints(TXIDS)
    err = error(await server.send_zcash(to="utest1payee", amount_zec="1.00000001"))
    assert err["code"] == "over_send_limit"
    assert "MAX_SEND_ZEC" in err["message"]
    assert argv_of(argv_log) == []


async def test_send_zcash_allows_exactly_the_cap(prints):
    prints(TXIDS)
    ok(await server.send_zcash(to="utest1payee", amount_zec="1"))


@pytest.mark.parametrize("to", ["", "   "])
async def test_send_zcash_refuses_an_empty_address_without_running_zingo_cli(prints, argv_log, to):
    prints(TXIDS)
    assert error(await server.send_zcash(to=to, amount_zec="0.1"))["code"] == "invalid_address"
    assert argv_of(argv_log) == []


async def test_send_zcash_refuses_an_unsendable_amount(prints):
    prints(TXIDS)
    assert error(await server.send_zcash(to="utest1payee", amount_zec="0.123456789"))["code"] == "invalid_amount"


async def test_send_zcash_surfaces_what_zingo_cli_said_when_the_send_fails(zingo):
    zingo('echo "Error: insufficient funds" >&2; exit 1')
    err = error(await server.send_zcash(to="utest1payee", amount_zec="0.1"))
    assert err["code"] == "zingo_failed"
    assert "insufficient funds" in err["message"]


async def test_send_zcash_says_so_when_zingo_cli_reported_no_transaction(zingo):
    zingo("""echo '{"txids": [], "transmissions": []}'""")
    assert error(await server.send_zcash(to="utest1payee", amount_zec="0.1"))["code"] == "send_not_confirmed"
