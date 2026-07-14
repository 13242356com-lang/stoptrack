"""S7 address parser — the one bit of S7 logic that's pure and unit-testable."""
import pytest

from plc_gateway.adapters.s7 import parse_s7_address


def test_bit_address():
    a = parse_s7_address("DB1.DBX0.0")
    assert (a.db, a.kind, a.byte, a.bit, a.width) == (1, "X", 0, 0, 1)


def test_bit_address_high_bit():
    a = parse_s7_address("DB7.DBX3.7")
    assert (a.db, a.kind, a.byte, a.bit) == (7, "X", 3, 7)


def test_word_address():
    a = parse_s7_address("DB1.DBW2")
    assert (a.db, a.kind, a.byte, a.width) == (1, "W", 2, 2)


def test_dword_address():
    a = parse_s7_address("DB1.DBD4")
    assert (a.db, a.kind, a.byte, a.width) == (1, "D", 4, 4)


def test_case_insensitive():
    a = parse_s7_address("db2.dbx1.3")
    assert (a.db, a.kind, a.byte, a.bit) == (2, "X", 1, 3)


@pytest.mark.parametrize("bad", [
    "DB1.DBB0",         # byte access not supported
    "DB1.DBX0",         # bit access without bit index
    "DB1.DBX0.8",       # bit out of range
    "DB1.DBW2.0",       # word access with a bit index
    "M0.0",             # not a DB
    "DB1.DBX",          # missing offset
    "garbage",
])
def test_malformed_rejected(bad):
    with pytest.raises(ValueError):
        parse_s7_address(bad)
