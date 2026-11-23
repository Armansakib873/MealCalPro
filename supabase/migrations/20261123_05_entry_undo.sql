-- =====================================================================
-- MealCal Pro · Migration 05 · Who created a request + "Undo" for fresh requests
-- =====================================================================
alter table public.expenses add column if not exists created_by bigint default public.my_member_id();
alter table public.deposits add column if not exists created_by bigint default public.my_member_id();

-- Cancel my own request while it is still pending (max 10 minutes old). Staff can cancel any pending one.
create or replace function public.cancel_request(p_kind text, p_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare r record; v_me bigint := my_member_id();
begin
  if not is_approved_member() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  if p_kind = 'expense' then
    select id, member_id, amount, status::text as status, created_by, created_at into r from expenses where id = p_id for update;
  elsif p_kind = 'deposit' then
    select id, member_id, amount, status, created_by, created_at into r from deposits where id = p_id for update;
  else
    raise exception 'Unknown request type.';
  end if;
  if r.id is null then raise exception 'Request not found.'; end if;
  if r.status <> 'pending' then raise exception 'Already %, it can''t be undone here.', r.status; end if;
  if not is_staff() and (r.created_by is distinct from v_me or r.created_at < now() - interval '10 minutes') then
    raise exception 'Only the person who sent it can undo, within 10 minutes.' using errcode = '42501';
  end if;

  perform set_config('mealcal.silent', 'on', true);
  if p_kind = 'expense' then delete from expenses where id = p_id; else delete from deposits where id = p_id; end if;
  perform set_config('mealcal.silent', 'off', true);

  perform notify(p_kind || '.cancelled', p_kind,
    initcap(p_kind) || ' request cancelled ' || tk(abs(r.amount)) || ' · ' || member_name(r.member_id) || by_suffix(r.member_id),
    r.member_id, array[p_kind, 'cancelled']);
  return json_build_object('ok', true);
end $$;
revoke execute on function public.cancel_request(text, bigint) from public, anon;
grant execute on function public.cancel_request(text, bigint) to authenticated;
