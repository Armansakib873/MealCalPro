-- =====================================================================
-- MealCal Pro · Migration 01 · Schema additions + helper functions
-- Applied 2026-11-23. Backup of the previous state: schema mealcal_backup.*_20261123
-- =====================================================================

-- ---------- 1. New columns ----------
alter table public.members add column if not exists is_approved boolean not null default false;
alter table public.members add column if not exists approved_at timestamptz;
alter table public.members add column if not exists approved_by bigint;
alter table public.members add column if not exists meal_shutdown_at timestamptz;
-- Every member that already exists is a real, approved member.
update public.members set is_approved = true, approved_at = coalesce(approved_at, created_at, now()) where is_approved = false;

alter table public.notifications add column if not exists event_key text;
alter table public.notifications add column if not exists tags text[] not null default '{}';
alter table public.notifications add column if not exists target_member_id bigint;
alter table public.notifications add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.notifications add column if not exists audience text not null default 'all';

alter table public.expenses add column if not exists category text;
alter table public.deposits add column if not exists cycle_due_id bigint;

-- ---------- 2. New tables ----------
create table if not exists public.audit_log (
  id bigserial primary key,
  table_name text not null,
  row_id text,
  action text not null,
  actor_user uuid,
  actor_member_id bigint,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_table_row_idx on public.audit_log (table_name, row_id);

create table if not exists public.meal_day_reports (
  id bigserial primary key,
  cycle_id bigint,
  session_date date not null unique,      -- the bazar day: its NIGHT meal + next date's DAY meal
  night_date date not null,
  day_date date not null,
  items jsonb not null default '[]'::jsonb, -- [{member_id,name,night,guest_night,day,guest_day}]
  total_night numeric not null default 0,
  total_day numeric not null default 0,
  total_guest numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meal_day_reports_cycle_idx on public.meal_day_reports (cycle_id, session_date desc);

-- ---------- 3. Remove duplicate unique constraints (each one is an extra index on every write) ----------
alter table public.meals drop constraint if exists unique_meal_per_member_date;
alter table public.members drop constraint if exists unique_member_name;

-- ---------- 4. Speed indexes ----------
create index if not exists deposits_cycle_idx on public.deposits (cycle_id, created_at desc);
create index if not exists deposits_parent_idx on public.deposits (parent_deposit_id);
create index if not exists expenses_cycle_idx on public.expenses (cycle_id, created_at desc);
create index if not exists meals_cycle_idx on public.meals (cycle_id, meal_date);
create index if not exists meal_plans_date_idx on public.meal_plans (plan_date);
create index if not exists notifications_cycle_idx on public.notifications (cycle_id, created_at desc);
create index if not exists cycle_dues_to_cycle_idx on public.cycle_dues (to_cycle_id, member_id);
create index if not exists members_user_idx on public.members (user_id);

-- ---------- 5. Helper functions (SECURITY DEFINER so RLS policies can use them without recursion) ----------
create or replace function public.my_member_id() returns bigint
language sql stable security definer set search_path = public as $$
  select id from members where user_id = auth.uid() limit 1
$$;

create or replace function public.is_approved_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and is_approved)
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and is_approved and role in ('admin','manager'))
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where user_id = auth.uid() and is_approved and role = 'admin')
$$;

create or replace function public.active_cycle_id() returns bigint
language sql stable security definer set search_path = public as $$
  select id from cycles where is_active order by id desc limit 1
$$;

create or replace function public.member_name(p_id bigint) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from members where id = p_id), 'Unknown member')
$$;

create or replace function public.cfg(p_key text, p_default text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value_text from app_config where key_name = p_key limit 1), p_default)
$$;

-- Bangladesh local time (the whole app runs on Asia/Dhaka)
create or replace function public.local_now() returns timestamp
language sql stable as $$ select (now() at time zone 'Asia/Dhaka') $$;

-- Active bazar session: switches to tomorrow after lock_time_end (same rule as getStrictSessionDate() in the app)
create or replace function public.current_session_date() returns date
language sql stable security definer set search_path = public as $$
  select case when local_now()::time > cfg('lock_time_end','22:00')::time
              then local_now()::date + 1 else local_now()::date end
$$;

-- Is a meal slot locked for normal users? A slot belongs to session (night: plan_date, day: plan_date - 1).
create or replace function public.is_slot_locked(p_plan_date date, p_slot text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  v_session date := case when p_slot = 'day' then p_plan_date - 1 else p_plan_date end;
  v_t time := local_now()::time;
begin
  if v_session < current_session_date() then return true; end if;           -- past session
  if v_session = local_now()::date
     and v_t >= cfg('lock_time_start','18:00')::time
     and v_t <= cfg('lock_time_end','22:00')::time then return true; end if; -- bazar window
  return false;
end $$;

create or replace function public.is_silent() returns boolean
language sql stable as $$ select coalesce(current_setting('mealcal.silent', true), '') = 'on' $$;

create or replace function public.is_system() returns boolean
language sql stable as $$ select coalesce(current_setting('mealcal.system', true), '') = 'on' $$;

-- ৳1,250 / ৳1,250.50
create or replace function public.tk(p numeric) returns text
language sql stable as $$
  select '৳' || case when round(coalesce(p,0),2) = trunc(coalesce(p,0))
                     then to_char(trunc(coalesce(p,0)), 'FM9,999,999,990')
                     else to_char(round(coalesce(p,0),2), 'FM9,999,999,990.00') end
$$;

create or replace function public.dlabel(p date) returns text
language sql stable as $$ select to_char(p, 'Dy, DD Mon') $$;

-- Actor suffix for messages: "" when the actor is the subject, " · by Arman (admin)" otherwise, " · by System" for cron
create or replace function public.by_suffix(p_subject bigint default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_me bigint := my_member_id(); v_role text;
begin
  if v_me is null then return ' · by System'; end if;
  if p_subject is not null and v_me = p_subject then return ''; end if;
  select role into v_role from members where id = v_me;
  return ' · by ' || member_name(v_me) || case when v_role in ('admin','manager') then ' (' || v_role || ')' else '' end;
end $$;

-- Single place that writes notifications. Clients cannot insert notifications directly.
create or replace function public.notify(
  p_key text, p_type text, p_msg text, p_target bigint default null,
  p_tags text[] default '{}', p_meta jsonb default '{}'::jsonb, p_audience text default 'all'
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into notifications (cycle_id, message, type, member_id, target_member_id, event_key, tags, meta, audience, is_read)
  values (active_cycle_id(), p_msg, p_type, my_member_id(), p_target, p_key, coalesce(p_tags,'{}'), coalesce(p_meta,'{}'::jsonb), p_audience, false);
end $$;

-- Generic audit trail (old + new row as JSON, who did it)
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then return null; end if;
  insert into audit_log (table_name, row_id, action, actor_user, actor_member_id, old_data, new_data)
  values (tg_table_name,
          (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id',
          tg_op, auth.uid(), my_member_id(),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
