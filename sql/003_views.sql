-- neveroversell: observability views

create or replace view nos_holds_by_state as
select resource_id,
       state,
       count(*)::integer      as holds,
       sum(qty)::integer      as qty,
       min(created_at)        as oldest,
       max(created_at)        as newest
  from nos_holds
 group by resource_id, state;

create or replace view nos_resource_status as
select r.id            as resource_id,
       r.total,
       r.held,
       r.sold,
       r.total - r.held - r.sold as available,
       coalesce(sum(h.qty) filter (where h.state = 'held'), 0)::integer             as held_plain,
       coalesce(sum(h.qty) filter (where h.state = 'awaiting_payment'), 0)::integer as held_paying,
       r.updated_at
  from nos_resources r
  left join nos_holds h on h.resource_id = r.id and h.state in ('held', 'awaiting_payment')
 group by r.id;
