import json
import time

import pytest

from zcash_wallet_mcp import config
from zcash_wallet_mcp.errors import ToolFailure
from zcash_wallet_mcp.zingo import Zingo, parse_balance

from .conftest import ECHO_ARGV


def cli(**over) -> Zingo:
    settings = config.get_settings()
    return Zingo.from_settings(settings.model_copy(update=over))


# ------------------------------------------------------------------ argv

def test_a_local_command_runs_offline_in_the_chains_own_data_dir(wallet):
    argv = cli().argv("addresses", network=False)
    assert argv[1:] == ["--data-dir", str(wallet.wallet_dir()), "--chain", "testnet", "--offline", "addresses"]


def test_the_data_dir_is_per_chain_so_the_wallets_never_mix(wallet):
    assert cli(zingo_chain="mainnet").argv("addresses", network=False)[2].endswith("/mainnet")
    assert cli(zingo_chain="testnet").argv("addresses", network=False)[2].endswith("/testnet")


def test_a_network_command_waits_for_the_sync_and_never_passes_offline(wallet):
    argv = cli().argv("balance", network=True)
    assert "--offline" not in argv
    assert argv[-2:] == ["--waitsync", "balance"]


def test_a_network_command_pins_the_indexer_when_one_is_configured(wallet):
    argv = cli(zingo_server="https://testnet.zec.rocks:443").argv("balance", network=True)
    # --server implies online consent, so --online would be redundant.
    assert "--server" in argv and argv[argv.index("--server") + 1] == "https://testnet.zec.rocks:443"
    assert "--online" not in argv


def test_a_network_command_asks_to_go_online_when_no_indexer_is_pinned(wallet):
    assert "--online" in cli().argv("balance", network=True)


def test_command_arguments_come_after_the_command(wallet):
    argv = cli().argv("quicksend", "ztestaddr", "1000", "hi", network=True)
    assert argv[-4:] == ["quicksend", "ztestaddr", "1000", "hi"]


# ------------------------------------------------------------------ run

def test_run_passes_the_whole_argv_to_zingo_cli(zingo, wallet):
    zingo(ECHO_ARGV)
    lines = cli().run("addresses", network=False).splitlines()
    assert lines == ["--data-dir", str(wallet.wallet_dir()), "--chain", "testnet", "--offline", "addresses"]


def test_run_keeps_a_memo_with_spaces_as_one_argument(zingo):
    zingo(ECHO_ARGV)
    lines = cli().run("quicksend", "addr", "100", "thanks for lunch", network=True).splitlines()
    assert lines[-1] == "thanks for lunch"


def test_run_creates_the_wallet_dir_so_zingo_cli_can_make_a_wallet_there(zingo, wallet):
    zingo("exit 0")
    assert not wallet.wallet_dir().exists()
    cli().run("addresses", network=False)
    assert wallet.wallet_dir().is_dir()


def test_run_reports_what_zingo_cli_complained_about_when_it_fails(zingo):
    zingo('echo "Error: wallet chain name mismatch" >&2; exit 1')
    with pytest.raises(ToolFailure) as e:
        cli().run("balance", network=True)
    assert e.value.code == "zingo_failed"
    assert "wallet chain name mismatch" in e.value.message


def test_run_falls_back_to_stdout_when_a_failure_says_nothing_on_stderr(zingo):
    zingo('echo "no funds available"; exit 3')
    with pytest.raises(ToolFailure) as e:
        cli().run("quicksend", "addr", "1", network=True)
    assert "no funds available" in e.value.message


def test_run_says_zingo_cli_is_missing_rather_than_crashing(wallet):
    with pytest.raises(ToolFailure) as e:
        cli().run("addresses", network=False)
    assert e.value.code == "zingo_cli_missing"
    assert str(wallet.zingo_cli_bin) in e.value.message


def test_run_gives_up_after_the_timeout(zingo):
    zingo("sleep 5")
    with pytest.raises(ToolFailure) as e:
        cli(zingo_timeout_seconds=1).run("balance", network=True)
    assert e.value.code == "zingo_timeout"


def test_run_json_parses_what_zingo_cli_printed(zingo):
    zingo("""echo '[{"encoded_address": "utest1abc"}]'""")
    assert cli().run_json("addresses", network=False) == [{"encoded_address": "utest1abc"}]


def test_run_json_skips_log_lines_zingo_cli_prints_before_the_json(zingo):
    # In command mode zingo-cli logs to stderr, but a stray line on stdout must not break a tool.
    zingo("""echo 'INFO starting up'; echo '{"txids": ["ab12"]}'""")
    assert cli().run_json("quicksend", "addr", "1", network=True) == {"txids": ["ab12"]}


def test_run_json_complains_when_there_is_no_json_at_all(zingo):
    zingo("echo 'Zingo CLI quit successfully.'")
    with pytest.raises(ToolFailure) as e:
        cli().run_json("addresses", network=False)
    assert e.value.code == "zingo_unreadable"


# ------------------------------------------------------------------ parse_balance

BALANCE = """[
    confirmed_ironwood_balance: 0
    unconfirmed_ironwood_balance: 0
    total_ironwood_balance: 0

    confirmed_orchard_balance: 1_234_567_890
    unconfirmed_orchard_balance: 0
    total_orchard_balance: 1_234_567_890

    confirmed_sapling_balance: 50_000_000
    unconfirmed_sapling_balance: 25_000_000
    total_sapling_balance: 75_000_000

    confirmed_transparent_balance: no view capability
    unconfirmed_transparent_balance: no view capability
    total_transparent_balance: no view capability
]"""


def test_parse_balance_strips_the_digit_separators_zingo_cli_prints():
    assert parse_balance(BALANCE)["total_orchard_balance"] == 1_234_567_890
    assert parse_balance(BALANCE)["unconfirmed_sapling_balance"] == 25_000_000


def test_parse_balance_reads_a_pool_without_a_viewing_key_as_unknown():
    assert parse_balance(BALANCE)["total_transparent_balance"] is None


def test_parse_balance_complains_when_the_output_holds_no_balances():
    with pytest.raises(ToolFailure) as e:
        parse_balance("Error: offline")
    assert e.value.code == "zingo_unreadable"


def test_parse_balance_survives_a_pool_being_added_or_renamed():
    one = parse_balance("[\n    confirmed_mystery_balance: 7\n]")
    assert one == {"confirmed_mystery_balance": 7}


def test_json_output_round_trips_through_run_json(zingo):
    payload = {"account": 0, "address_index": 3, "encoded_address": "utest1xyz"}
    zingo(f"echo '{json.dumps(payload)}'")
    assert cli().run_json("new_address", "oz", network=False) == payload


def test_a_timeout_kills_the_processes_zingo_cli_started_too(zingo, tmp_path):
    """zingo-cli spawns nym-proxy for an online session. Killing only zingo-cli leaves the
    proxy running, and one is left behind by every call that times out."""
    marker = tmp_path / "grandchild.alive"
    # A stand-in for nym-proxy: outlives its parent and says so while it runs.
    zingo(f"""
      ( while true; do echo alive > "{marker}"; sleep 0.1; done ) &
      sleep 30
    """)
    with pytest.raises(ToolFailure) as e:
        cli(zingo_timeout_seconds=1).run("balance", network=True)
    assert e.value.code == "zingo_timeout"

    marker.unlink(missing_ok=True)
    time.sleep(0.5)
    assert not marker.exists(), "a process zingo-cli started is still running after the timeout"
