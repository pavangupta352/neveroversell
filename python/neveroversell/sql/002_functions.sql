-- neveroversell: functions
--
-- Rules that every function follows:
--   1. Default READ COMMITTED isolation. No SERIALIZABLE, no client retries.
--   2. Lock the resource row first with FOR NO KEY UPDATE. Functions that start from a hold id read the
--      hold's resource_id without a lock, lock the resource, then re-read the hold under that lock.
--   3. An account-wide cap takes an advisory lock on the account BEFORE the resource lock.
--   4. Expected outcomes are statuses in nos_result. Exceptions are for programmer errors only.
--   5. All time decisions use clock_timestamp() captured once at the top of the call.

-- Build a nos_result from a hold row plus optional context.
create or replace function nos_pack(
  p_status        text,
  p_hold          nos_holds,
  p_resource      text    default null,
  p_available     integer default null,
  p_payment_ref   text    default null,
  p_existing_ref  text    default null,
  p_other         uuid    default null
) returns nos_result language sql immutable as $$
  select row(
    p_status,
    (p_hold).id,
    coalesce((p_hold).resource_id, p_resource),
    (p_hold).account_id,
    (p_hold).qty,
    (p_hold).state,
    (p_hold).expires_at,
    (p_hold).payment_deadline,
    coalesce(p_payment_ref, (p_hold).payment_ref),
    p_existing_ref,
    p_other,
    p_available
  )::nos_result;
$$;

-- Create a resource or change its capacity. Lowering total below held + sold is refused.
create or replace function nos_upsert_resource(p_id text, p_total integer)
returns nos_result language plpgsql as $$
declare
  r nos_resources%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text;
begin
  if p_id is null or p_id = '' then
    raise exception 'resource id is required' using errcode = '22023';
  end if;
  if p_total is null or p_total < 0 then
    raise exception 'total must be zero or positive' using errcode = '22023';
  end if;
  v_status := case when exists (select 1 from nos_resources where id = p_id) then 'updated' else 'created' end;
  begin
    insert into nos_resources (id, total) values (p_id, p_total)
    on conflict (id) do update set total = excluded.total, updated_at = v_now
    returning * into r;
  exception when check_violation then
    select * into r from nos_resources where id = p_id;
    return nos_pack('capacity_below_committed', null::nos_holds, p_id, r.total - r.held - r.sold);
  end;
  return nos_pack(v_status, null::nos_holds, p_id, r.total - r.held - r.sold);
end $$;

-- Take a hold. Statuses: held | replayed | insufficient | account_cap | unknown_resource
create or replace function nos_hold(
  p_resource  text,
  p_qty       integer,
  p_account   text,
  p_idem      text     default null,
  p_ttl       interval default null
) returns nos_result language plpgsql as $$
declare
  s        nos_settings%rowtype;
  r        nos_resources%rowtype;
  h        nos_holds%rowtype;
  v_now    timestamptz := clock_timestamp();
  v_ttl    interval;
  v_exp    integer;
  v_avail  integer;
  v_used   integer;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'qty must be positive' using errcode = '22023';
  end if;
  if p_account is null or p_account = '' then
    raise exception 'account id is required' using errcode = '22023';
  end if;
  select * into s from nos_settings;
  v_ttl := coalesce(p_ttl, s.hold_ttl);
  if v_ttl <= interval '0' then
    raise exception 'ttl must be positive' using errcode = '22023';
  end if;

  -- 1. Idempotent replay, before any lock.
  if p_idem is not null then
    select * into h from nos_holds
     where resource_id = p_resource and account_id = p_account and idempotency_key = p_idem;
    if found then
      return nos_pack('replayed', h);
    end if;
  end if;

  -- 2. An account-wide cap needs an account lock, always before the resource lock.
  if s.account_cap is not null and s.cap_scope = 'account' then
    perform pg_advisory_xact_lock(hashtext('nos:account:' || p_account));
  end if;

  -- 3. The resource lock. Everything below happens under it.
  select * into r from nos_resources where id = p_resource for no key update;
  if not found then
    return nos_pack('unknown_resource', null::nos_holds, p_resource, null);
  end if;

  -- 4. Expire this resource's plain holds that are past their TTL. Payment-phase holds are left alone.
  with x as (
    update nos_holds set state = 'expired', updated_at = v_now
     where resource_id = p_resource and state = 'held' and expires_at <= v_now
     returning id, qty
  ), ev as (
    insert into nos_hold_events (hold_id, event, detail)
    select id, 'expired', jsonb_build_object('by', 'hold', 'reason', 'ttl') from x
  )
  select coalesce(sum(qty), 0)::integer into v_exp from x;
  if v_exp > 0 then
    update nos_resources set held = held - v_exp, updated_at = v_now
     where id = p_resource returning * into r;
  end if;

  -- 5. Availability from the counters, never from counting rows.
  v_avail := r.total - r.held - r.sold;
  if p_qty > v_avail then
    return nos_pack('insufficient', null::nos_holds, p_resource, v_avail);
  end if;

  -- 6. Per-account cap.
  if s.account_cap is not null then
    select coalesce(sum(qty), 0)::integer into v_used from nos_holds
     where account_id = p_account and state in ('held', 'awaiting_payment')
       and (s.cap_scope = 'account' or resource_id = p_resource);
    if v_used + p_qty > s.account_cap then
      return nos_pack('account_cap', null::nos_holds, p_resource, v_avail);
    end if;
  end if;

  -- 7. Record the hold, then move the counter. Both under the lock.
  begin
    insert into nos_holds (resource_id, account_id, qty, state, idempotency_key, expires_at)
    values (p_resource, p_account, p_qty, 'held', p_idem, v_now + v_ttl)
    returning * into h;
  exception when unique_violation then
    -- A concurrent call with the same idempotency key committed first. Return its hold.
    select * into h from nos_holds
     where resource_id = p_resource and account_id = p_account and idempotency_key = p_idem;
    return nos_pack('replayed', h);
  end;

  update nos_resources set held = held + p_qty, updated_at = v_now where id = p_resource;
  insert into nos_hold_events (hold_id, event, detail)
  values (h.id, 'held', jsonb_build_object('qty', p_qty, 'ttl', v_ttl::text));

  return nos_pack('held', h, null, v_avail - p_qty);
end $$;

-- Enter the payment phase. Statuses: awaiting_payment | replayed | expired | confirmed | released | not_found
create or replace function nos_begin_payment(p_hold uuid, p_window interval default null)
returns nos_result language plpgsql as $$
declare
  s      nos_settings%rowtype;
  h      nos_holds%rowtype;
  v_res  text;
  v_now  timestamptz := clock_timestamp();
begin
  select * into s from nos_settings;
  select resource_id into v_res from nos_holds where id = p_hold;
  if not found then
    return nos_pack('not_found', null::nos_holds);
  end if;
  perform 1 from nos_resources where id = v_res for no key update;
  select * into h from nos_holds where id = p_hold;

  if h.state = 'held' then
    if h.expires_at <= v_now then
      update nos_holds set state = 'expired', updated_at = v_now where id = h.id returning * into h;
      update nos_resources set held = held - h.qty, updated_at = v_now where id = v_res;
      insert into nos_hold_events (hold_id, event, detail)
      values (h.id, 'expired', jsonb_build_object('by', 'begin_payment', 'reason', 'ttl'));
      return nos_pack('expired', h);
    end if;
    update nos_holds
       set state = 'awaiting_payment',
           payment_started_at = v_now,
           payment_deadline = v_now + coalesce(p_window, s.payment_window),
           updated_at = v_now
     where id = h.id returning * into h;
    insert into nos_hold_events (hold_id, event, detail)
    values (h.id, 'awaiting_payment', jsonb_build_object('deadline', h.payment_deadline));
    return nos_pack('awaiting_payment', h);
  elsif h.state = 'awaiting_payment' then
    return nos_pack('replayed', h);
  else
    return nos_pack(h.state::text, h);
  end if;
end $$;

-- Confirm a hold with a payment reference. Idempotent across both confirmation paths.
-- Statuses: confirmed | already_confirmed | duplicate_payment | payment_ref_in_use | expired | released | not_found
create or replace function nos_confirm(p_hold uuid, p_payment_ref text)
returns nos_result language plpgsql as $$
declare
  h        nos_holds%rowtype;
  v_res    text;
  v_other  uuid;
  v_now    timestamptz := clock_timestamp();
begin
  if p_payment_ref is null or p_payment_ref = '' then
    raise exception 'payment_ref is required' using errcode = '22023';
  end if;
  select resource_id into v_res from nos_holds where id = p_hold;
  if not found then
    return nos_pack('not_found', null::nos_holds, null, null, p_payment_ref);
  end if;
  perform 1 from nos_resources where id = v_res for no key update;
  select * into h from nos_holds where id = p_hold;

  if h.state in ('held', 'awaiting_payment') then
    -- A plain hold past its TTL is expired here rather than confirmed; a payment-phase hold is
    -- honoured until the sweeper expires it, because the customer has paid and the units are still held.
    if h.state = 'held' and h.expires_at <= v_now then
      update nos_holds set state = 'expired', updated_at = v_now where id = h.id returning * into h;
      update nos_resources set held = held - h.qty, updated_at = v_now where id = v_res;
      insert into nos_hold_events (hold_id, event, detail)
      values (h.id, 'expired', jsonb_build_object('by', 'confirm', 'reason', 'ttl', 'payment_ref', p_payment_ref));
      return nos_pack('expired', h, null, null, p_payment_ref);
    end if;

    -- Has this payment already bought a different hold?
    select id into v_other from nos_holds where payment_ref = p_payment_ref and id <> h.id;
    if found then
      insert into nos_hold_events (hold_id, event, detail)
      values (h.id, 'payment_ref_in_use', jsonb_build_object('payment_ref', p_payment_ref, 'other_hold_id', v_other));
      return nos_pack('payment_ref_in_use', h, null, null, p_payment_ref, null, v_other);
    end if;

    begin
      update nos_holds set state = 'confirmed', payment_ref = p_payment_ref, updated_at = v_now
       where id = h.id returning * into h;
    exception when unique_violation then
      -- Two different holds raced to confirm with the same payment reference. The unique index decided.
      select id into v_other from nos_holds where payment_ref = p_payment_ref and id <> h.id;
      insert into nos_hold_events (hold_id, event, detail)
      values (h.id, 'payment_ref_in_use', jsonb_build_object('payment_ref', p_payment_ref, 'other_hold_id', v_other));
      return nos_pack('payment_ref_in_use', h, null, null, p_payment_ref, null, v_other);
    end;
    update nos_resources set held = held - h.qty, sold = sold + h.qty, updated_at = v_now where id = v_res;
    insert into nos_hold_events (hold_id, event, detail)
    values (h.id, 'confirmed', jsonb_build_object('payment_ref', p_payment_ref));
    return nos_pack('confirmed', h);

  elsif h.state = 'confirmed' then
    if h.payment_ref = p_payment_ref then
      -- The second confirmation path for the same payment: a no-op that returns the same answer.
      return nos_pack('already_confirmed', h);
    end if;
    -- A different payment for an already-confirmed hold: the customer paid twice. Caller refunds p_payment_ref.
    insert into nos_hold_events (hold_id, event, detail)
    values (h.id, 'duplicate_payment', jsonb_build_object('payment_ref', p_payment_ref, 'existing_payment_ref', h.payment_ref));
    return nos_pack('duplicate_payment', h, null, null, p_payment_ref, h.payment_ref);

  else
    -- released or expired: a late confirmation never revives a hold. Caller refunds p_payment_ref.
    insert into nos_hold_events (hold_id, event, detail)
    values (h.id, 'late_confirm', jsonb_build_object('state', h.state, 'payment_ref', p_payment_ref));
    return nos_pack(h.state::text, h, null, null, p_payment_ref);
  end if;
end $$;

-- Release a hold explicitly. Statuses: released | already_released | confirmed | expired | not_found
create or replace function nos_release(p_hold uuid, p_reason text default null)
returns nos_result language plpgsql as $$
declare
  h      nos_holds%rowtype;
  v_res  text;
  v_now  timestamptz := clock_timestamp();
begin
  select resource_id into v_res from nos_holds where id = p_hold;
  if not found then
    return nos_pack('not_found', null::nos_holds);
  end if;
  perform 1 from nos_resources where id = v_res for no key update;
  select * into h from nos_holds where id = p_hold;

  if h.state in ('held', 'awaiting_payment') then
    update nos_holds set state = 'released', updated_at = v_now where id = h.id returning * into h;
    update nos_resources set held = held - h.qty, updated_at = v_now where id = v_res;
    insert into nos_hold_events (hold_id, event, detail)
    values (h.id, 'released', jsonb_build_object('reason', p_reason));
    return nos_pack('released', h);
  elsif h.state = 'released' then
    return nos_pack('already_released', h);
  else
    return nos_pack(h.state::text, h);
  end if;
end $$;

-- Extend a plain hold's TTL, a bounded number of times. Statuses: extended | not_extendable | not_found
create or replace function nos_extend(p_hold uuid, p_by interval default null)
returns nos_result language plpgsql as $$
declare
  s      nos_settings%rowtype;
  h      nos_holds%rowtype;
  v_res  text;
  v_now  timestamptz := clock_timestamp();
begin
  select * into s from nos_settings;
  select resource_id into v_res from nos_holds where id = p_hold;
  if not found then
    return nos_pack('not_found', null::nos_holds);
  end if;
  perform 1 from nos_resources where id = v_res for no key update;
  select * into h from nos_holds where id = p_hold;

  if h.state = 'held' and h.expires_at > v_now and h.extensions < s.max_extensions then
    update nos_holds
       set expires_at = greatest(expires_at, v_now) + coalesce(p_by, s.extension),
           extensions = extensions + 1,
           updated_at = v_now
     where id = h.id returning * into h;
    insert into nos_hold_events (hold_id, event, detail)
    values (h.id, 'extended', jsonb_build_object('expires_at', h.expires_at, 'extensions', h.extensions));
    return nos_pack('extended', h);
  end if;
  insert into nos_hold_events (hold_id, event, detail)
  values (h.id, 'extend_refused', jsonb_build_object(
    'state', h.state,
    'reason', case
      when h.state <> 'held' then h.state::text
      when h.expires_at <= v_now then 'expired'
      else 'max_extensions' end));
  return nos_pack('not_extendable', h);
end $$;

-- Expire plain holds past their TTL and payment-phase holds past their deadline.
-- Safe to run from several workers at once: per-resource row lock plus conditional updates.
create or replace function nos_sweep(p_limit integer default 1000)
returns table (resource_id text, expired_holds integer, expired_qty integer) language plpgsql as $$
declare
  v_res  text;
  v_now  timestamptz := clock_timestamp();
  v_n    integer;
  v_q    integer;
begin
  for v_res in
    select distinct h.resource_id from nos_holds h
     where (h.state = 'held' and h.expires_at <= v_now)
        or (h.state = 'awaiting_payment' and h.payment_deadline <= v_now)
     order by h.resource_id
     limit p_limit
  loop
    perform 1 from nos_resources where id = v_res for no key update;
    with x as (
      update nos_holds set state = 'expired', updated_at = v_now
       where nos_holds.resource_id = v_res
         and ((state = 'held' and expires_at <= v_now)
           or (state = 'awaiting_payment' and payment_deadline <= v_now))
       returning id, qty, (payment_deadline is not null) as was_paying
    ), ev as (
      insert into nos_hold_events (hold_id, event, detail)
      select id, 'expired', jsonb_build_object('by', 'sweep', 'reason', case when was_paying then 'payment_window' else 'ttl' end)
        from x
    )
    select count(*)::integer, coalesce(sum(qty), 0)::integer into v_n, v_q from x;
    if v_q > 0 then
      update nos_resources set held = held - v_q, updated_at = v_now where id = v_res;
    end if;
    if v_n > 0 then
      resource_id := v_res; expired_holds := v_n; expired_qty := v_q;
      return next;
    end if;
  end loop;
end $$;

-- Compare the counters with the rows. drift = true means something is wrong and nos_repair may be used.
create or replace function nos_check()
returns table (resource_id text, held integer, held_by_rows bigint, sold integer, sold_by_rows bigint, drift boolean)
language sql stable as $$
  select r.id,
         r.held,
         coalesce(sum(h.qty) filter (where h.state in ('held', 'awaiting_payment')), 0),
         r.sold,
         coalesce(sum(h.qty) filter (where h.state = 'confirmed'), 0),
         r.held <> coalesce(sum(h.qty) filter (where h.state in ('held', 'awaiting_payment')), 0)
         or r.sold <> coalesce(sum(h.qty) filter (where h.state = 'confirmed'), 0)
    from nos_resources r
    left join nos_holds h on h.resource_id = r.id
   group by r.id, r.held, r.sold
   order by r.id;
$$;

-- Recompute one resource's counters from its rows, under the resource lock. Explicit opt-in only.
create or replace function nos_repair(p_resource text)
returns table (resource_id text, held_before integer, held_after integer, sold_before integer, sold_after integer)
language plpgsql as $$
declare
  r       nos_resources%rowtype;
  v_held  integer;
  v_sold  integer;
begin
  select * into r from nos_resources where id = p_resource for no key update;
  if not found then
    return;
  end if;
  select coalesce(sum(qty) filter (where state in ('held', 'awaiting_payment')), 0)::integer,
         coalesce(sum(qty) filter (where state = 'confirmed'), 0)::integer
    into v_held, v_sold
    from nos_holds where nos_holds.resource_id = p_resource;
  update nos_resources set held = v_held, sold = v_sold, updated_at = clock_timestamp() where id = p_resource;
  resource_id := p_resource; held_before := r.held; held_after := v_held; sold_before := r.sold; sold_after := v_sold;
  return next;
end $$;
