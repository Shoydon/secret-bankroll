"""Running zingo-cli. Every tool goes through here: one process per call, in command mode."""

import json
import logging
import os
import re
import shutil
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .config import Settings
from .errors import ToolFailure

log = logging.getLogger("zcash_wallet_mcp")

#: The wallet zingo-cli keeps in its data directory. Its absence means "no wallet yet".
WALLET_FILE = "zingo-wallet.dat"

#: `confirmed_orchard_balance: 1_234_567_890` or `… : no view capability`, as `balance` prints them.
BALANCE_LINE = re.compile(r"^\s*(\w+_balance)\s*:\s*(.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class Zingo:
    cli: Path
    wallet_dir: Path
    chain: str
    server: str | None
    timeout: int

    @classmethod
    def from_settings(cls, settings: Settings) -> "Zingo":
        return cls(
            cli=settings.zingo_cli_bin,
            wallet_dir=settings.wallet_dir(),
            chain=settings.zingo_chain,
            server=settings.zingo_server,
            timeout=settings.zingo_timeout_seconds,
        )

    def argv(self, command: str, *args: str, network: bool) -> list[str]:
        """The whole command line. Session options come first: zingo-cli refuses them after a command.

        `network=False` is a local command (addresses, a new address), run `--offline` so a stored
        standing consent cannot quietly put it on the network. `network=True` consents to go online
        and waits for the sync, so a balance or a send sees the chain as it is.
        """
        argv = [str(self.cli), "--data-dir", str(self.wallet_dir), "--chain", self.chain]
        if network:
            # --server implies the consent --online asks for, so they are never both needed.
            argv += ["--server", self.server] if self.server else ["--online"]
            # Synced already by sync() — --waitsync never returns on this build.
            argv.append("--nosync")
        else:
            argv.append("--offline")
        return [*argv, command, *args]

    def run(self, command: str, *args: str, network: bool) -> str:
        """`command`'s output on stdout. Raises ToolFailure for anything that went wrong."""
        argv = self.argv(command, *args, network=network)
        if not self._resolved():
            raise ToolFailure(
                "zingo_cli_missing",
                f"zingo-cli isn't at {self.cli}. Build it (https://github.com/zingolabs/zingolib) "
                "and set ZINGO_CLI_BIN to the binary.",
            )
        self.wallet_dir.mkdir(parents=True, exist_ok=True)
        self._ensure_wallet()
        if network:
            self.sync()
        log.info("zingo-cli %s", " ".join(argv[1:]))
        try:
            done = _run(argv, self.timeout)
        except subprocess.TimeoutExpired:
            raise ToolFailure(
                "zingo_timeout", f"zingo-cli took longer than {self.timeout}s on `{command}` and was stopped."
            ) from None
        except OSError as e:
            raise ToolFailure("zingo_cli_missing", f"couldn't run zingo-cli at {self.cli}: {e}") from None
        if done.returncode != 0:
            raise ToolFailure("zingo_failed", _why(command, done))
        return done.stdout

    def sync(self, limit: int = 180) -> None:
        """Bring the wallet to the chain tip. zingo-cli's sync finishes but its process never exits
        (it stays to watch the mempool), so poll the scan state and stop it once fully scanned."""
        import time

        base = [str(self.cli), "--data-dir", str(self.wallet_dir), "--chain", self.chain]
        online = base + (["--server", self.server] if self.server else ["--online"]) + ["--waitsync", "height"]
        log.info("zingo-cli sync")
        proc = subprocess.Popen(online, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True)
        started, done_polls = time.monotonic(), 0
        try:
            while time.monotonic() - started < limit and proc.poll() is None:
                time.sleep(2)
                if time.monotonic() - started < 6:
                    continue  # let it fetch the new tip first
                status = _run(base + ["--offline", "sync", "status"], 30).stdout
                start = status.find("{")
                try:
                    ranges = json.JSONDecoder().raw_decode(status, start)[0].get("scan_ranges", [])
                except (ValueError, AttributeError):
                    continue
                done_polls = done_polls + 1 if ranges and all(r.get("priority") == "Scanned" for r in ranges) else 0
                if done_polls >= 2:
                    break
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        log.info("zingo-cli sync done in %ds", time.monotonic() - started)

    def run_json(self, command: str, *args: str, network: bool) -> object:
        """`command`'s output, decoded. Log lines printed before the JSON are skipped."""
        out = self.run(command, *args, network=network)
        start = min((i for i in (out.find("{"), out.find("[")) if i != -1), default=-1)
        if start != -1:
            try:
                return json.JSONDecoder().raw_decode(out, start)[0]
            except json.JSONDecodeError:
                pass
        raise ToolFailure("zingo_unreadable", f"zingo-cli's `{command}` output wasn't JSON: {_snippet(out)}")

    def _ensure_wallet(self) -> None:
        """Make the wallet, once, in a session that can reach the chain.

        zingo-cli creates one on its first run in a data directory, and sets its birthday to
        the chain height it sees. A session created `--offline` sees none, so it falls back to
        a checkpoint compiled into the binary — hundreds of thousands of blocks back — and
        every sync afterwards grinds through that whole gap to find nothing. Spending one
        online call here is what keeps the first real sync seconds rather than tens of minutes.
        """
        if (self.wallet_dir / WALLET_FILE).exists():
            return
        argv = [str(self.cli), "--data-dir", str(self.wallet_dir), "--chain", self.chain]
        argv += ["--server", self.server] if self.server else ["--online"]
        # --nosync: the point is the birthday zingo-cli stamps on a new wallet, not its contents.
        argv += ["--nosync", "addresses"]
        try:
            done = _run(argv, self.timeout)
        except (subprocess.TimeoutExpired, OSError) as e:
            log.warning("couldn't create the wallet online (%s); zingo-cli will make one offline", e)
            return
        if done.returncode != 0:
            # Offline, or no indexer: let the command the agent asked for make the wallet
            # instead. It still works, it just starts life far behind the chain.
            log.warning("couldn't create the wallet online: %s", _snippet(done.stderr or done.stdout))

    def _resolved(self) -> bool:
        parts = Path(self.cli).parts
        return bool(shutil.which(str(self.cli))) if len(parts) == 1 else Path(self.cli).is_file()


def _run(argv: list[str], timeout: int) -> subprocess.CompletedProcess:
    """zingo-cli, in a process group of its own, killed whole if it runs over `timeout`.

    An online session spawns nym-proxy beside it. Killing only zingo-cli leaves the proxy
    running, so every call that timed out would leak one; the group is what has to die.
    """
    # Windows has no process groups to signal: a new group plus taskkill /T is the equivalent.
    group = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **group)
    try:
        out, err = child.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        _kill_group(child)
        child.communicate()
        raise
    return subprocess.CompletedProcess(argv, child.returncode, out, err)


def _kill_group(child: subprocess.Popen) -> None:
    """End `child` and everything it started. Never raises: the run already failed."""
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(child.pid)], capture_output=True, timeout=30)
        else:
            os.killpg(os.getpgid(child.pid), signal.SIGKILL)
    except (OSError, subprocess.SubprocessError) as e:
        log.warning("couldn't stop the timed-out zingo-cli (pid %s): %s", child.pid, e)
        child.kill()


def parse_balance(out: str) -> dict[str, int | None]:
    """`balance`'s block of pools as zatoshis. A pool the wallet cannot view is None."""
    pools: dict[str, int | None] = {}
    for name, raw in BALANCE_LINE.findall(out):
        digits = raw.replace("_", "")
        pools[name] = int(digits) if digits.isdigit() else None
    if not pools:
        raise ToolFailure("zingo_unreadable", f"zingo-cli's `balance` output held no balances: {_snippet(out)}")
    return pools


def _why(command: str, done: subprocess.CompletedProcess) -> str:
    """The line of a failed run worth showing the agent: zingo-cli's own complaint, if it made one."""
    lines = [line.strip() for line in f"{done.stderr}\n{done.stdout}".splitlines() if line.strip()]
    said = next((line for line in lines if re.search(r"error|fail|refus|offline|insufficient", line, re.I)), "")
    return f"zingo-cli's `{command}` failed ({done.returncode}): {said or _snippet(' '.join(lines)) or 'no output'}"


def _snippet(text: str, limit: int = 300) -> str:
    one_line = " ".join(text.split())
    return one_line[:limit] + ("…" if len(one_line) > limit else "")
