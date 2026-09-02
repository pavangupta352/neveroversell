-- neveroversell: schema
-- Postgres 13 or newer. Every object is prefixed nos_ so it can live inside an existing database.

create table if not exists nos_settings (
  id              boolean primary key default true check (id),
  hold_ttl        interval not null default interval '15 minutes' check (hold_ttl > interval '0'),
  payment_window  interval not null default interval '30 minutes',
  account_cap     integer check (account_cap is null or account_cap > 0),
  cap_scope       text not null default 'resource' check (cap_scope in ('resource', 'account')),
  max_extensions  integer not null default 1 check (max_extensions >= 0),
  extension       interval not null default interval '5 minutes' check (extension > interval '0'),
  -- A live checkout must never be killed by the TTL: the payment window has to outlast the hold.
  constraint nos_settings_window_gt_ttl check (payment_window > hold_ttl)
);
insert into nos_settings default values on conflict (id) do nothing;

create table if not exists nos_resources (
  id          text primary key,
  total       integer not null check (total >= 0),
  held        integer not null default 0 check (held >= 0),
  sold        integer not null default 0 check (sold >= 0),
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  -- The last line of defence: even a wrong code path cannot commit an oversell.
  constraint nos_resources_capacity check (held + sold <= total)
);

do $$ begin
  create type nos_hold_state as enum ('held', 'awaiting_payment', 'confirmed', 'released', 'expired');
exception when duplicate_object then null; end $$;

create table if not exists nos_holds (
  id                  uuid primary key default gen_random_uuid(),
  resource_id         text not null references nos_resources (id),
  account_id          text not null,
  qty                 integer not null check (qty > 0),
  state               nos_hold_state not null default 'held',
  idempotency_key     text,
  payment_ref         text,
  expires_at          timestamptz not null,
  payment_started_at  timestamptz,
  payment_deadline    timestamptz,
  extensions          integer not null default 0,
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp()
);

-- One hold per (resource, account, idempotency key): a client retry cannot double-hold.
create unique index if not exists nos_holds_idem_uq
  on nos_holds (resource_id, account_id, idempotency_key) where idempotency_key is not null;
-- One payment buys one hold, enforced by the database.
create unique index if not exists nos_holds_payment_ref_uq
  on nos_holds (payment_ref) where payment_ref is not null;
create index if not exists nos_holds_active_ix   on nos_holds (resource_id) where state in ('held', 'awaiting_payment');
create index if not exists nos_holds_account_ix  on nos_holds (account_id)  where state in ('held', 'awaiting_payment');
create index if not exists nos_holds_expiry_ix   on nos_holds (expires_at)  where state = 'held';
create index if not exists nos_holds_deadline_ix on nos_holds (payment_deadline) where state = 'awaiting_payment';

create table if not exists nos_hold_events (
  id       bigserial primary key,
  hold_id  uuid not null references nos_holds (id),
  event    text not null,
  detail   jsonb not null default '{}'::jsonb,
  at       timestamptz not null default clock_timestamp()
);
create index if not exists nos_hold_events_hold_ix on nos_hold_events (hold_id, id);

-- Every function returns this shape. status carries the outcome; the rest is context for the caller.
do $$ begin
  create type nos_result as (
    status                text,
    hold_id               uuid,
    resource_id           text,
    account_id            text,
    qty                   integer,
    state                 nos_hold_state,
    expires_at            timestamptz,
    payment_deadline      timestamptz,
    payment_ref           text,
    existing_payment_ref  text,
    other_hold_id         uuid,
    available             integer
  );
exception when duplicate_object then null; end $$;
