"""ZEC and zatoshis. zingo-cli speaks zatoshis; the agent and the user speak ZEC."""

from decimal import Decimal, InvalidOperation

from .errors import ToolFailure

ZATOSHIS_PER_ZEC = 100_000_000
# A zatoshi is 1e-8 ZEC, so that is as fine as an amount can be.
DECIMAL_PLACES = 8


def to_zatoshis(amount: str | int | float) -> int:
    """`amount` in ZEC as a whole number of zatoshis. Raises for anything unsendable."""
    try:
        # str() first: Decimal(0.1) is 0.1000000000000000055511151231257827, Decimal("0.1") is not.
        value = Decimal(str(amount).strip())
    except (InvalidOperation, ValueError, ArithmeticError):
        raise ToolFailure("invalid_amount", f"{amount!r} is not an amount of ZEC") from None
    if not value.is_finite():
        raise ToolFailure("invalid_amount", f"{amount!r} is not an amount of ZEC")
    if value <= 0:
        raise ToolFailure("invalid_amount", f"the amount must be more than 0 ZEC, not {value}")
    zatoshis = value * ZATOSHIS_PER_ZEC
    if zatoshis != zatoshis.to_integral_value():
        raise ToolFailure(
            "invalid_amount",
            f"{value} ZEC is finer than a zatoshi; ZEC has at most {DECIMAL_PLACES} decimal places",
        )
    return int(zatoshis)


def zec(zatoshis: int) -> str:
    """`zatoshis` as ZEC, without trailing zeros: 150000000 -> "1.5"."""
    value = (Decimal(zatoshis) / ZATOSHIS_PER_ZEC).quantize(Decimal(1).scaleb(-DECIMAL_PLACES))
    return f"{value.normalize():f}"
