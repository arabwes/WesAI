"""Topology validation + lookups."""

from app.core.config import TransitionConfig
from app.identity.topology import Topology


def t(frm, to, **kw):
    return TransitionConfig(**{"from": frm, "to": to}, **kw)


def test_possible_and_get():
    topo = Topology([t("a", "b", expected_seconds=5)])
    assert topo.possible("a", "b")
    assert not topo.possible("b", "a")
    assert topo.get("a", "b").expected_seconds == 5


def test_bidirectional():
    topo = Topology([t("a", "b", bidirectional=True)])
    assert topo.possible("a", "b") and topo.possible("b", "a")


def test_validate_unknown_camera():
    topo = Topology([t("a", "ghost")])
    problems = topo.validate({"a", "b"})
    assert any("ghost" in p for p in problems)


def test_validate_bad_timing():
    topo = Topology([t("a", "b", min_seconds=10, expected_seconds=5, max_seconds=30)])
    problems = topo.validate({"a", "b"})
    assert any("min <= expected <= max" in p for p in problems)


def test_validate_clean():
    topo = Topology([t("a", "b")])
    assert topo.validate({"a", "b"}) == []
