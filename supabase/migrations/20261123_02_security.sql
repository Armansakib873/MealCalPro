-- =====================================================================
-- MealCal Pro · Migration 02 · Row Level Security + guard triggers
-- Before: most tables allowed ANYONE (even logged-out) to read/insert/update/delete.
-- After:  logged-out visitors see nothing; pending signups see only their own row;
--         approved members read; writes are limited by role; money moves only via RPCs.
-- =====================================================================

-- ---------- 1. Drop every old policy on public tables ----------
do $$ declare r record; begin
  for r in select tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ---------- 2. RLS on for every table ----------
do $$ declare t text; begin
  foreach t in array array['app_config','app_settings','cycle_dues','cycles','deposits','expenses','meal_plans',
                           'meals','members','notifications','system_logs','user_settings','weekly_menus',
                           'audit_log','meal_day_reports'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------- 3. Policies ----------
-- members
create policy members_select on public.members for select to authenticated
  using (user_id = auth.uid() or (is_approved_member() and (is_approved or is_staff())));
create policy members_insert on public.members for insert to authenticated with check (is_staff());
create policy members_update on public.members for update to authenticated
  using (is_staff() or (user_id = auth.uid() and is_approved))
  with check (is_staff() or (user_id = auth.uid() and is_approved));
create policy members_delete on public.members for delete to authenticated using (is_admin());

-- meal plans (schedule cards): own cards, or staff for anyone
create policy meal_plans_select on public.meal_plans for select to authenticated using (is_approved_member());
create policy meal_plans_insert on public.meal_plans for insert to authenticated
  with check (is_staff() or (is_approved_member() and member_id = my_member_id()));
create policy meal_plans_update on public.meal_plans for update to authenticated
  using (is_staff() or (is_approved_member() and member_id = my_member_id()))
  with check (is_staff() or (is_approved_member() and member_id = my_member_id()));
create policy meal_plans_delete on public.meal_plans for delete to authenticated using (is_staff());

-- meals (final tracker data): staff only
create policy meals_select on public.meals for select to authenticated using (is_approved_member());
create policy meals_write on public.meals for all to authenticated using (is_staff()) with check (is_staff());

-- expenses: anyone approved can REQUEST (pending); staff approve/edit/delete
create policy expenses_select on public.expenses for select to authenticated using (is_approved_member());
create policy expenses_insert on public.expenses for insert to authenticated
  with check (is_staff() or (is_approved_member() and status = 'pending'));
create policy expenses_update on public.expenses for update to authenticated using (is_staff()) with check (is_staff());
create policy expenses_delete on public.expenses for delete to authenticated using (is_staff());

-- deposits: requests only; approval/settlement/revert go through RPCs
create policy deposits_select on public.deposits for select to authenticated using (is_approved_member());
create policy deposits_insert on public.deposits for insert to authenticated
  with check (is_approved_member() and status = 'pending');
create policy deposits_update on public.deposits for update to authenticated using (is_staff()) with check (is_staff());
create policy deposits_delete on public.deposits for delete to authenticated using (is_staff());

-- cycle dues / cycles
create policy cycle_dues_select on public.cycle_dues for select to authenticated using (is_approved_member());
create policy cycle_dues_write on public.cycle_dues for all to authenticated using (is_staff()) with check (is_staff());
create policy cycles_select on public.cycles for select to authenticated using (is_approved_member());
create policy cycles_write on public.cycles for all to authenticated using (is_staff()) with check (is_staff());

-- notifications: read-only for clients (written by the database itself)
create policy notifications_select on public.notifications for select to authenticated
  using (is_approved_member() and (audience = 'all' or is_staff()));

-- config / menus / settings
create policy app_config_select on public.app_config for select to authenticated using (is_approved_member());
create policy app_config_write on public.app_config for all to authenticated using (is_staff()) with check (is_staff());
create policy app_settings_select on public.app_settings for select to authenticated using (is_approved_member());
create policy app_settings_write on public.app_settings for all to authenticated using (is_staff()) with check (is_staff());
create policy weekly_menus_select on public.weekly_menus for select to authenticated using (is_approved_member());
create policy weekly_menus_write on public.weekly_menus for all to authenticated using (is_staff()) with check (is_staff());
create policy system_logs_select on public.system_logs for select to authenticated using (is_approved_member());
create policy user_settings_own on public.user_settings for all to authenticated
  using (user_id = my_member_id()) with check (user_id = my_member_id());

create policy audit_log_select on public.audit_log for select to authenticated using (is_staff());
create policy meal_day_reports_select on public.meal_day_reports for select to authenticated using (is_approved_member());

-- ---------- 4. Guard: members can only edit their own safe columns ----------
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_system() then return new; end if;
  if not is_staff() then
    if new.role is distinct from old.role or new.is_approved is distinct from old.is_approved
       or new.approved_at is distinct from old.approved_at or new.approved_by is distinct from old.approved_by
       or new.archived_from_cycle_id is distinct from old.archived_from_cycle_id
       or new.user_id is distinct from old.user_id or new.email is distinct from old.email
       or new.meal_shutdown_at is distinct from old.meal_shutdown_at then
      raise exception 'Only an admin or manager can change that.' using errcode = '42501';
    end if;
  end if;
  if new.role is distinct from old.role and not is_admin() then
    raise exception 'Only the admin can change roles.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_members_guard on public.members;
create trigger trg_members_guard before update on public.members for each row execute function members_guard();

-- ---------- 5. Guard: meal cards respect lock time + sane values ----------
create or replace function public.meal_plans_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o_night numeric; o_day numeric; o_gn numeric; o_gd numeric;
  m record;
begin
  new.night_count := greatest(0, least(coalesce(new.night_count,0), 1));
  new.day_count   := greatest(0, least(coalesce(new.day_count,0), 1));
  new.guest_night_count := greatest(0, least(coalesce(new.guest_night_count,0), 20));
  new.guest_day_count   := greatest(0, least(coalesce(new.guest_day_count,0), 20));
  new.updated_at := now();
  if is_system() or is_staff() then return new; end if;

  if tg_op = 'UPDATE' then
    o_night := old.night_count; o_day := old.day_count; o_gn := old.guest_night_count; o_gd := old.guest_day_count;
  else
    select default_night_on, default_day_on into m from members where id = new.member_id;
    o_night := case when m.default_night_on then 1 else 0 end;
    o_day   := case when m.default_day_on then 1 else 0 end;
    o_gn := 0; o_gd := 0;
  end if;

  if (new.night_count is distinct from o_night or new.guest_night_count is distinct from o_gn)
     and is_slot_locked(new.plan_date, 'night') then
    raise exception 'Night meal for % is locked (bazar time or past session). Ask an admin.', dlabel(new.plan_date) using errcode = '42501';
  end if;
  if (new.day_count is distinct from o_day or new.guest_day_count is distinct from o_gd)
     and is_slot_locked(new.plan_date, 'day') then
    raise exception 'Day meal for % is locked (bazar time or past session). Ask an admin.', dlabel(new.plan_date) using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_meal_plans_guard on public.meal_plans;
create trigger trg_meal_plans_guard before insert or update on public.meal_plans for each row execute function meal_plans_guard();

-- ---------- 6. Audit triggers ----------
do $$ declare t text; begin
  foreach t in array array['members','expenses','deposits','cycle_dues','cycles','app_config','weekly_menus','meals'] loop
    execute format('drop trigger if exists trg_audit on public.%I', t);
    execute format('create trigger trg_audit after insert or update or delete on public.%I for each row execute function audit_row()', t);
  end loop;
end $$;
drop trigger if exists trg_audit on public.meal_plans;
create trigger trg_audit after update on public.meal_plans for each row execute function audit_row();

-- ---------- 7. Lock down functions ----------
revoke execute on function public.notify(text,text,text,bigint,text[],jsonb,text) from public, anon, authenticated;
revoke execute on function public.audit_row() from public, anon, authenticated;
-- Unused + unprotected: let anyone insert approved deposits. Replaced by approve_deposit().
drop function if exists public.process_deposit_with_settlement(bigint, bigint, numeric, text, text);
revoke execute on function public.sync_auto_entry_cron() from public, anon, authenticated;
revoke execute on function public.admin_reset_password(uuid, text) from anon;

-- Realtime for the new report table
do $$ begin
  alter publication supabase_realtime add table public.meal_day_reports;
exception when duplicate_object then null; end $$;
