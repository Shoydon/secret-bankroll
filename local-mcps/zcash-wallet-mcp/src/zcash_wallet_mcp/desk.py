"""Testnet swap desk: pays USDC on Base Sepolia from the desk's own key."""

from decimal import Decimal

from eth_account import Account
from web3 import Web3

from .config import Settings
from .errors import ToolFailure

ERC20 = [
    {"name": "transfer", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"}],
     "outputs": [{"name": "", "type": "bool"}]},
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "a", "type": "address"}], "outputs": [{"name": "", "type": "uint256"}]},
]


def _desk(settings: Settings):
    w3 = Web3(Web3.HTTPProvider(settings.base_rpc_url))
    acct = Account.from_key(settings.desk_evm_key_file.read_text().strip())
    usdc = w3.eth.contract(address=Web3.to_checksum_address(settings.base_usdc_address), abi=ERC20)
    return w3, acct, usdc


def usdc_units(settings: Settings, zatoshis: int) -> int:
    """USDC base units (6 decimals) for an amount of ZEC at the desk's fixed rate."""
    return int(Decimal(zatoshis) / Decimal(10**8) * settings.desk_usdc_per_zec * Decimal(10**6))


def check_liquidity(settings: Settings, units: int) -> None:
    w3, acct, usdc = _desk(settings)
    have = usdc.functions.balanceOf(acct.address).call()
    if have < units:
        raise ToolFailure("desk_empty", f"desk holds {have / 1e6} USDC, needs {units / 1e6}; fund {acct.address}")
    if w3.eth.get_balance(acct.address) == 0:
        raise ToolFailure("desk_no_gas", f"desk has no Base Sepolia ETH for gas; fund {acct.address}")


def pay_usdc(settings: Settings, to: str, units: int) -> str:
    w3, acct, usdc = _desk(settings)
    tx = usdc.functions.transfer(Web3.to_checksum_address(to), units).build_transaction(
        {"from": acct.address, "nonce": w3.eth.get_transaction_count(acct.address), "chainId": w3.eth.chain_id}
    )
    signed = acct.sign_transaction(tx)
    txh = w3.eth.send_raw_transaction(signed.raw_transaction)
    w3.eth.wait_for_transaction_receipt(txh, timeout=120)
    return "0x" + txh.hex().removeprefix("0x")
