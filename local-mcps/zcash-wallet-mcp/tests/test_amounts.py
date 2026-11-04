import pytest

from zcash_wallet_mcp.amounts import ZATOSHIS_PER_ZEC, to_zatoshis, zec
from zcash_wallet_mcp.errors import ToolFailure


def test_one_zec_is_a_hundred_million_zatoshis():
    assert ZATOSHIS_PER_ZEC == 100_000_000
    assert to_zatoshis("1") == 100_000_000


def test_converts_a_fractional_amount_exactly():
    assert to_zatoshis("0.12345678") == 12_345_678


def test_accepts_a_float_without_binary_rounding_error():
    assert to_zatoshis(0.1) == 10_000_000


def test_rejects_more_than_eight_decimal_places():
    with pytest.raises(ToolFailure) as e:
        to_zatoshis("0.123456789")
    assert e.value.code == "invalid_amount"
    assert "8 decimal places" in e.value.message


def test_rejects_zero():
    with pytest.raises(ToolFailure) as e:
        to_zatoshis("0")
    assert e.value.code == "invalid_amount"


def test_rejects_a_negative_amount():
    with pytest.raises(ToolFailure) as e:
        to_zatoshis("-1.5")
    assert e.value.code == "invalid_amount"


def test_rejects_text_that_is_not_a_number():
    with pytest.raises(ToolFailure) as e:
        to_zatoshis("all of it")
    assert e.value.code == "invalid_amount"


def test_shows_zatoshis_as_zec_without_trailing_zeros():
    assert zec(150_000_000) == "1.5"
    assert zec(100_000_000) == "1"
    assert zec(1) == "0.00000001"
    assert zec(0) == "0"
