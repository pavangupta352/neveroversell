"""The Python client against a real Postgres. Same guarantees as the TypeScript suite, same SQL."""

from __future__ import annotations

import os
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from neveroversell import Inventory, SweepRow, sql_files

DATABASE_URL = os.environ.get("DATABASE_URL", "postgres://nos:nos@127.0.0.1:54329/nos")


@pytest.fixture(scope="module")
def pool():
    p = ConnectionPool(DATABASE_URL, min_size=2, max_size=40, kwargs={"row_factory": dict_row}, open=True)
    yield p
    p.close()


@pytest.fixture(scope="module")
def inv(pool):
    i = Inventory(pool=pool)
    i.migrate()
    return i


@pytest.fixture(autouse=True)
def clean(pool, inv):
    with pool.connection() as conn:
        conn.execute("truncate nos_hold_events, nos_holds, nos_resources restart identity cascade")
        conn.execute(
            "update nos_settings set hold_ttl = default, payment_window = default, account_cap = default, cap_scope = default, max_extensions = default, extension = default"
        )
    inv.apply_settings()


def no_drift(inv: Inventory) -> None:
    assert [c for c in inv.check() if c.drift] == []


def test_bundled_sql_matches_the_repository_sql():
    root = Path(__file__).resolve().parents[2] / "sql"
    if not root.exists():
        pytest.skip("repository sql/ not present (installed package)")
    bundled = dict(sql_files())
    repo = {p.name: p.read_text(encoding="utf-8") for p in sorted(root.glob("*.sql"))}
    assert bundled == repo


def test_migrations_are_idempotent(inv):
    assert inv.migrate() == []


def test_500_concurrent_holds_on_10_units(inv):
    inv.upsert_resource("gig", 10)
    with ThreadPoolExecutor(max_workers=40) as ex:
        results = list(ex.map(lambda i: inv.hold("gig", 1, f"buyer-{i}"), range(500)))
    assert Counter(r.status for r in results) == {"held": 10, "insufficient": 490}
    s = inv.status("gig")
    assert (s.held, s.sold, s.available) == (10, 0, 0)
    no_drift(inv)


def test_confirm_is_idempotent_across_both_paths(inv):
    inv.upsert_resource("r", 5)
    h = inv.hold("r", 2, "a")
    assert h.status == "held"
    with ThreadPoolExecutor(max_workers=12) as ex:
        results = list(ex.map(lambda _: inv.confirm(h.hold.id, "pay_1"), range(12)))
    assert Counter(r.status for r in results) == {"confirmed": 1, "already_confirmed": 11}
    s = inv.status("r")
    assert (s.held, s.sold, s.available) == (0, 2, 3)
    no_drift(inv)


def test_duplicate_payment_is_reported_with_both_references(inv):
    inv.upsert_resource("r", 5)
    h = inv.hold("r", 1, "a")
    assert inv.confirm(h.hold.id, "pay_A").status == "confirmed"
    dup = inv.confirm(h.hold.id, "pay_B")
    assert (dup.status, dup.payment_ref, dup.existing_payment_ref) == ("duplicate_payment", "pay_B", "pay_A")
    assert [e.event for e in inv.events(h.hold.id)] == ["held", "confirmed", "duplicate_payment"]
    no_drift(inv)


def test_one_payment_cannot_buy_two_holds(inv, pool):
    inv.upsert_resource("r1", 5)
    inv.upsert_resource("r2", 5)
    h1 = inv.hold("r1", 1, "a")
    h2 = inv.hold("r2", 1, "a")
    with ThreadPoolExecutor(max_workers=2) as ex:
        results = list(ex.map(lambda hid: inv.confirm(hid, "pay_shared"), [h1.hold.id, h2.hold.id]))
    assert Counter(r.status for r in results) == {"confirmed": 1, "payment_ref_in_use": 1}
    used = next(r for r in results if r.status == "payment_ref_in_use")
    winner = next(r for r in results if r.status == "confirmed")
    assert used.other_hold_id == winner.hold.id
    with pool.connection() as conn:
        n = conn.execute("select count(*) as n from nos_holds where payment_ref = 'pay_shared'").fetchone()["n"]
    assert n == 1
    no_drift(inv)


def test_late_confirmation_never_revives_a_hold(inv):
    inv.upsert_resource("r", 1)
    h = inv.hold("r", 1, "a", ttl=timedelta(milliseconds=100))
    time.sleep(0.2)
    assert inv.sweep() == [SweepRow("r", 1, 1)]
    late = inv.confirm(h.hold.id, "pay_late")
    assert (late.status, late.payment_ref, late.hold.state) == ("expired", "pay_late", "expired")
    assert inv.hold("r", 1, "someone-else").status == "held"
    no_drift(inv)


def test_payment_phase_outlives_the_ttl(inv):
    inv.upsert_resource("r", 1)
    h = inv.hold("r", 1, "a", ttl=timedelta(milliseconds=100))
    assert inv.begin_payment(h.hold.id, window=timedelta(milliseconds=600)).status == "awaiting_payment"
    time.sleep(0.25)
    assert inv.sweep() == []
    assert inv.hold("r", 1, "b").status == "insufficient"
    assert inv.confirm(h.hold.id, "pay_slow_bank").status == "confirmed"
    assert inv.status("r").sold == 1
    no_drift(inv)


def test_idempotency_key_replays(inv):
    inv.upsert_resource("r", 50)
    with ThreadPoolExecutor(max_workers=20) as ex:
        results = list(ex.map(lambda _: inv.hold("r", 1, "a", idempotency_key="same"), range(20)))
    assert len({r.hold.id for r in results}) == 1
    assert Counter(r.status for r in results)["held"] == 1
    assert inv.status("r").held == 1
    no_drift(inv)


def test_release_and_extend(inv):
    inv.upsert_resource("r", 2)
    h = inv.hold("r", 1, "a", ttl=timedelta(seconds=5))
    assert inv.extend(h.hold.id, by=timedelta(minutes=1)).status == "extended"
    assert inv.extend(h.hold.id, by=timedelta(minutes=1)).status == "not_extendable"
    assert inv.release(h.hold.id, reason="changed mind").status == "released"
    assert inv.release(h.hold.id).status == "already_released"
    assert inv.confirm(h.hold.id, "pay_late").status == "released"
    assert inv.status("r").available == 2
    no_drift(inv)


def test_configuration_is_validated_twice(inv, pool):
    with pytest.raises(ValueError, match="must exceed hold_ttl"):
        Inventory(pool=pool, hold_ttl=timedelta(minutes=20), payment_window=timedelta(minutes=10))
    with pool.connection() as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("update nos_settings set hold_ttl = interval '2 minutes', payment_window = interval '1 minute'")


def test_the_database_is_the_last_line_of_defence(inv, pool):
    inv.upsert_resource("r", 3)
    inv.hold("r", 2, "a")
    with pool.connection() as conn, pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("update nos_resources set sold = total where id = 'r'")
    assert inv.upsert_resource("r", 1).status == "capacity_below_committed"


def test_account_cap_across_resources(pool):
    capped = Inventory(pool=pool, account_cap=3, cap_scope="account")
    capped.apply_settings()
    capped.upsert_resource("r1", 100)
    capped.upsert_resource("r2", 100)
    with ThreadPoolExecutor(max_workers=20) as ex:
        results = list(ex.map(lambda i: capped.hold("r1" if i % 2 else "r2", 1, "greedy"), range(20)))
    assert Counter(r.status for r in results) == {"held": 3, "account_cap": 17}
    assert capped.status("r1").held + capped.status("r2").held == 3
    no_drift(capped)


def test_programmer_errors_raise(inv):
    inv.upsert_resource("r", 1)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        inv.hold("r", 0, "a")
    assert inv.hold("nope", 1, "a").status == "unknown_resource"
