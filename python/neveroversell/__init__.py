"""neveroversell: holds that cannot oversell, for Postgres.

The guarantees live in the SQL functions shipped inside this package. This module applies them,
pushes your settings into the database, and turns each function's result row into a typed value.
Every method is one SQL call; nothing here opens a transaction across calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from importlib import resources
from typing import Any, Literal, Optional

from psycopg import errors
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

__all__ = [
    "CheckRow",
    "Hold",
    "HoldEvent",
    "HoldState",
    "Inventory",
    "RepairRow",
    "ResourceStatus",
    "Result",
    "SweepRow",
    "sql_files",
]

__version__ = "0.1.0"

HoldState = Literal["held", "awaiting_payment", "confirmed", "released", "expired"]


@dataclass(frozen=True)
class Hold:
    id: str
    resource_id: str
    account_id: str
    qty: int
    state: HoldState
    expires_at: datetime
    payment_deadline: Optional[datetime]
    payment_ref: Optional[str]


@dataclass(frozen=True)
class Result:
    """The outcome of hold, begin_payment, confirm, release, extend and upsert_resource.

    ``status`` is the value to match on. The other fields are filled when they mean something:
    ``hold`` for any status that concerns an existing hold; ``available`` for insufficient,
    account_cap, held and the resource statuses; ``payment_ref`` for the reference you should
    refund on duplicate_payment, expired and released; ``existing_payment_ref`` on
    duplicate_payment; ``other_hold_id`` on payment_ref_in_use.
    """

    status: str
    hold: Optional[Hold] = None
    resource_id: Optional[str] = None
    available: Optional[int] = None
    payment_ref: Optional[str] = None
    existing_payment_ref: Optional[str] = None
    other_hold_id: Optional[str] = None


@dataclass(frozen=True)
class SweepRow:
    resource_id: str
    expired_holds: int
    expired_qty: int


@dataclass(frozen=True)
class CheckRow:
    resource_id: str
    held: int
    held_by_rows: int
    sold: int
    sold_by_rows: int
    drift: bool


@dataclass(frozen=True)
class RepairRow:
    resource_id: str
    held_before: int
    held_after: int
    sold_before: int
    sold_after: int


@dataclass(frozen=True)
class ResourceStatus:
    resource_id: str
    total: int
    held: int
    sold: int
    available: int
    held_plain: int
    held_paying: int


@dataclass(frozen=True)
class HoldEvent:
    id: int
    hold_id: str
    event: str
    detail: dict[str, Any]
    at: datetime


def sql_files() -> list[tuple[str, str]]:
    """The migration files bundled with the package, as (name, contents), in apply order."""
    folder = resources.files(__package__).joinpath("sql")
    out: list[tuple[str, str]] = []
    for entry in sorted(folder.iterdir(), key=lambda e: e.name):
        if entry.name.endswith(".sql"):
            out.append((entry.name, entry.read_text(encoding="utf-8")))
    return out


def _hold(row: dict[str, Any]) -> Optional[Hold]:
    if row.get("hold_id") is None:
        return None
    return Hold(
        id=str(row["hold_id"]),
        resource_id=row["resource_id"],
        account_id=row["account_id"],
        qty=row["qty"],
        state=row["state"],
        expires_at=row["expires_at"],
        payment_deadline=row.get("payment_deadline"),
        payment_ref=row.get("payment_ref"),
    )


def _result(row: dict[str, Any]) -> Result:
    # The SQL already puts the right reference in payment_ref: the hold's own on confirmed and
    # already_confirmed, the one to refund on duplicate_payment, expired and released.
    return Result(
        status=row["status"],
        hold=_hold(row),
        resource_id=row.get("resource_id"),
        available=row.get("available"),
        payment_ref=row.get("payment_ref"),
        existing_payment_ref=row.get("existing_payment_ref"),
        other_hold_id=str(row["other_hold_id"]) if row.get("other_hold_id") else None,
    )


class Inventory:
    """Holds, payment phase, confirmation, release, extension, sweeping and checking.

    Pass either a connection string, from which a small pool is created, or your own
    ``psycopg_pool.ConnectionPool``.
    """

    def __init__(
        self,
        conninfo: Optional[str] = None,
        *,
        pool: Optional[ConnectionPool] = None,
        hold_ttl: timedelta = timedelta(minutes=15),
        payment_window: timedelta = timedelta(minutes=30),
        account_cap: Optional[int] = None,
        cap_scope: Literal["resource", "account"] = "resource",
        max_extensions: int = 1,
        extension: timedelta = timedelta(minutes=5),
        max_size: int = 8,
    ) -> None:
        if hold_ttl <= timedelta(0):
            raise ValueError("hold_ttl must be positive")
        if payment_window <= hold_ttl:
            raise ValueError(
                f"payment_window ({payment_window}) must exceed hold_ttl ({hold_ttl}); otherwise the sweeper can kill a live checkout"
            )
        if account_cap is not None and account_cap <= 0:
            raise ValueError("account_cap must be positive or None")
        if max_extensions < 0:
            raise ValueError("max_extensions must be zero or positive")
        if extension <= timedelta(0):
            raise ValueError("extension must be positive")
        if cap_scope not in ("resource", "account"):
            raise ValueError("cap_scope must be 'resource' or 'account'")
        if pool is None:
            if conninfo is None:
                raise ValueError("pass a connection string or a pool")
            pool = ConnectionPool(conninfo, min_size=1, max_size=max_size, kwargs={"row_factory": dict_row}, open=True)
        self._pool = pool
        self.hold_ttl = hold_ttl
        self.payment_window = payment_window
        self.account_cap = account_cap
        self.cap_scope = cap_scope
        self.max_extensions = max_extensions
        self.extension = extension

    # ---- infrastructure -------------------------------------------------------------------

    def close(self) -> None:
        self._pool.close()

    def _one(self, query: str, params: tuple[Any, ...]) -> dict[str, Any]:
        with self._pool.connection() as conn:
            row = conn.execute(query, params).fetchone()  # type: ignore[union-attr]
        if row is None:
            raise RuntimeError(f"neveroversell: {query} returned no row")
        return dict(row)

    def _all(self, query: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self._pool.connection() as conn:
            rows = conn.execute(query, params).fetchall()  # type: ignore[union-attr]
        return [dict(r) for r in rows]

    def migrate(self) -> list[str]:
        """Apply the bundled migrations that have not been applied yet, then push the settings."""
        applied: list[str] = []
        with self._pool.connection() as conn:
            conn.execute("select pg_advisory_lock(hashtext('nos_migrations'))")
            try:
                conn.execute(
                    "create table if not exists nos_migrations (name text primary key, applied_at timestamptz not null default clock_timestamp())"
                )
                done = {r["name"] for r in conn.execute("select name from nos_migrations").fetchall()}  # type: ignore[index]
                conn.commit()
                for name, body in sql_files():
                    if name in done:
                        continue
                    try:
                        conn.execute(body)
                        conn.execute("insert into nos_migrations (name) values (%s)", (name,))
                        conn.commit()
                        applied.append(name)
                    except Exception as err:
                        conn.rollback()
                        raise RuntimeError(f"neveroversell migration {name} failed: {err}") from err
            finally:
                conn.execute("select pg_advisory_unlock(hashtext('nos_migrations'))")
                conn.commit()
        self.apply_settings()
        return applied

    def apply_settings(self) -> None:
        """Write the configured settings to nos_settings. The database enforces payment_window > hold_ttl."""
        try:
            with self._pool.connection() as conn:
                conn.execute(
                    """
                    update nos_settings
                       set hold_ttl = %s, payment_window = %s, account_cap = %s,
                           cap_scope = %s, max_extensions = %s, extension = %s
                     where id
                    """,
                    (self.hold_ttl, self.payment_window, self.account_cap, self.cap_scope, self.max_extensions, self.extension),
                )
        except errors.CheckViolation as err:
            raise ValueError(f"neveroversell: the database rejected these settings ({err})") from err

    # ---- the primitive ------------------------------------------------------------------------

    def upsert_resource(self, resource_id: str, total: int) -> Result:
        return _result(self._one("select * from nos_upsert_resource(%s, %s)", (resource_id, total)))

    def hold(
        self,
        resource_id: str,
        qty: int,
        account_id: str,
        *,
        idempotency_key: Optional[str] = None,
        ttl: Optional[timedelta] = None,
    ) -> Result:
        """Statuses: held, replayed, insufficient, account_cap, unknown_resource."""
        return _result(self._one("select * from nos_hold(%s, %s, %s, %s, %s)", (resource_id, qty, account_id, idempotency_key, ttl)))

    def begin_payment(self, hold_id: str, *, window: Optional[timedelta] = None) -> Result:
        """Statuses: awaiting_payment, replayed, expired, confirmed, released, not_found."""
        return _result(self._one("select * from nos_begin_payment(%s, %s)", (hold_id, window)))

    def confirm(self, hold_id: str, payment_ref: str) -> Result:
        """Statuses: confirmed, already_confirmed, duplicate_payment, payment_ref_in_use, expired, released, not_found."""
        return _result(self._one("select * from nos_confirm(%s, %s)", (hold_id, payment_ref)))

    def release(self, hold_id: str, *, reason: Optional[str] = None) -> Result:
        """Statuses: released, already_released, confirmed, expired, not_found."""
        return _result(self._one("select * from nos_release(%s, %s)", (hold_id, reason)))

    def extend(self, hold_id: str, *, by: Optional[timedelta] = None) -> Result:
        """Statuses: extended, not_extendable, not_found."""
        return _result(self._one("select * from nos_extend(%s, %s)", (hold_id, by)))

    def sweep(self, limit: int = 1000) -> list[SweepRow]:
        return [SweepRow(r["resource_id"], r["expired_holds"], r["expired_qty"]) for r in self._all("select * from nos_sweep(%s)", (limit,))]

    def check(self) -> list[CheckRow]:
        return [
            CheckRow(r["resource_id"], r["held"], int(r["held_by_rows"]), r["sold"], int(r["sold_by_rows"]), r["drift"])
            for r in self._all("select * from nos_check()")
        ]

    def repair(self, resource_id: str) -> Optional[RepairRow]:
        rows = self._all("select * from nos_repair(%s)", (resource_id,))
        if not rows:
            return None
        r = rows[0]
        return RepairRow(r["resource_id"], r["held_before"], r["held_after"], r["sold_before"], r["sold_after"])

    def status(self, resource_id: str) -> Optional[ResourceStatus]:
        rows = self._all("select * from nos_resource_status where resource_id = %s", (resource_id,))
        if not rows:
            return None
        r = rows[0]
        return ResourceStatus(r["resource_id"], r["total"], r["held"], r["sold"], r["available"], r["held_plain"], r["held_paying"])

    def holds(
        self,
        *,
        resource_id: Optional[str] = None,
        state: Optional[HoldState] = None,
        older_than: Optional[timedelta] = None,
        limit: int = 200,
    ) -> list[Hold]:
        rows = self._all(
            """
            select id as hold_id, resource_id, account_id, qty, state, expires_at, payment_deadline, payment_ref
              from nos_holds
             where (%(resource)s::text is null or resource_id = %(resource)s)
               and (%(state)s::nos_hold_state is null or state = %(state)s)
               and (%(older)s::interval is null or created_at <= clock_timestamp() - %(older)s::interval)
             order by created_at asc
             limit %(limit)s
            """,
            {"resource": resource_id, "state": state, "older": older_than, "limit": limit},  # type: ignore[arg-type]
        )
        return [h for h in (_hold(r) for r in rows) if h is not None]

    def events(self, hold_id: str) -> list[HoldEvent]:
        return [
            HoldEvent(int(r["id"]), str(r["hold_id"]), r["event"], r["detail"], r["at"])
            for r in self._all("select id, hold_id, event, detail, at from nos_hold_events where hold_id = %s order by id", (hold_id,))
        ]

