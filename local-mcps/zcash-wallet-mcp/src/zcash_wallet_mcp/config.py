from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

Chain = Literal["mainnet", "testnet", "regtest"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # The wallet lives in DATA_DIR/wallets/<chain>, so it survives a salts-tools update.
    data_dir: Path = Path("./data")

    # zingo-cli: the binary itself, the network, and the indexer to pin (its own sweep picks one
    # when this is unset). Build the binary from https://github.com/zingolabs/zingolib.
    zingo_cli_bin: Path = Path("zingo-cli")
    zingo_chain: Chain = "mainnet"
    zingo_server: str | None = None
    # A send waits for the sync, a signature and a transmission, so this is generous.
    zingo_timeout_seconds: int = 600

    # The most one send_zcash call may move. The agent decides what to send, so this is the stop.
    max_send_zec: Decimal = Decimal("1")

    # Testnet swap desk: ZEC goes to desk_zec_address, the desk pays USDC on Base Sepolia.
    desk_zec_address: str | None = None
    desk_evm_key_file: Path = Path("./data/desk/evm.key")
    desk_usdc_per_zec: Decimal = Decimal("30")
    base_rpc_url: str = "https://sepolia.base.org"
    base_usdc_address: str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

    mcp_transport: Literal["stdio", "http"] = "stdio"
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8000
    mcp_auth_token: str | None = None

    def wallet_dir(self) -> Path:
        """Each network needs its own wallet directory: one shared by two raises a chain mismatch."""
        return self.data_dir / "wallets" / self.zingo_chain


@lru_cache
def get_settings() -> Settings:
    return Settings()
