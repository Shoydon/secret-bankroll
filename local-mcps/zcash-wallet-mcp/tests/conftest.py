import json
import os
import stat
from pathlib import Path

import pytest

from zcash_wallet_mcp import config


def fake_zingo(path: Path, body: str) -> Path:
    """A stand-in zingo-cli. `body` is shell run with the CLI's argv, so a test sees the real
    subprocess: argv quoting, exit codes, stdout and stderr all behave as they will in production."""
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


#: Prints every argument on its own line, so a test can assert on the argv zingo-cli was given.
ECHO_ARGV = 'for a in "$@"; do echo "$a"; done'


@pytest.fixture
def wallet(tmp_path, monkeypatch):
    """Settings pointed at a tmp data dir, with `ZINGO_CLI_BIN` naming a binary a test installs."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("MCP_AUTH_TOKEN", "test-token")
    monkeypatch.setenv("ZINGO_CHAIN", "testnet")
    monkeypatch.setenv("ZINGO_CLI_BIN", str(tmp_path / "zingo-cli"))
    for leftover in ("ZINGO_SERVER", "MAX_SEND_ZEC", "ZINGO_TIMEOUT_SECONDS"):
        monkeypatch.delenv(leftover, raising=False)
    config.get_settings.cache_clear()
    yield config.get_settings()
    config.get_settings.cache_clear()


@pytest.fixture
def argv_log(tmp_path) -> Path:
    """Every argument of every zingo-cli run, one per line, newest run last."""
    return tmp_path / "argv.txt"


@pytest.fixture
def zingo(wallet, argv_log):
    """Installs a fake zingo-cli from a shell body: `zingo(ECHO_ARGV)`. Records its argv."""

    def install(body: str) -> Path:
        record = f'for a in "$@"; do echo "$a" >> "{argv_log}"; done'
        return fake_zingo(Path(os.environ["ZINGO_CLI_BIN"]), f"{record}\n{body}")

    return install


@pytest.fixture
def prints(zingo):
    """Installs a fake zingo-cli that prints `payload` as JSON and succeeds."""
    return lambda payload: zingo(f"cat <<'JSON'\n{json.dumps(payload)}\nJSON")


def argv_of(argv_log: Path) -> list[str]:
    return argv_log.read_text().splitlines() if argv_log.exists() else []


def text(res) -> str:
    return res.content[0].text


def error(res) -> dict:
    assert res.is_error, text(res)
    return json.loads(text(res))["error"]


def ok(res) -> str:
    assert not res.is_error, text(res)
    return text(res)


@pytest.fixture
def answers(zingo):
    """Installs a fake zingo-cli that answers each command with its own JSON payload. Patterns are
    tried in the order given, so put `t_addresses` before `addresses`."""

    def install(by_command: dict[str, object]) -> Path:
        cases = "\n".join(
            f"  *{command}*) cat <<'JSON'\n{json.dumps(payload)}\nJSON\n  ;;" for command, payload in by_command.items()
        )
        return zingo(f'case "$*" in\n{cases}\n  *) echo "unexpected command: $*" >&2; exit 64 ;;\nesac')

    return install
