-- =====================================================================
-- MealCal Pro · Migration 03 · Event notifications written by the database
-- Every change is logged here, no matter which screen/device made it, so
-- nobody can skip or fake a notification. Format: "Subject · detail · date · by X".
-- event_key = machine key (e.g. meal.on), tags = filter chips, type = legacy UI group.
-- =====================================================================

-- ---------- Meal schedule cards ----------
create or replace function public.trg_meal_plans_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m record;
  o_night numeric; o_day numeric; o_gn numeric; o_gd numeric;
  v_by text; v_tags text[];
  v_def_night int; v_def_day int;
begin
  if is_silent() then return null; end if;
  select * into m from members where id = new.member_id;
  if m.id is null or not m.is_approved then return null; end if;
  v_def_night := case when m.default_night_on then 1 else 0 end;
  v_def_day   := case when m.default_day_on then 1 else 0 end;

  if tg_op = 'UPDATE' then
    o_night := old.night_count; o_day := old.day_count; o_gn := old.guest_night_count; o_gd := old.guest_day_count;
  else -- a brand new card only matters if it differs from the defaults
    o_night := v_def_night; o_day := v_def_day; o_gn := 0; o_gd := 0;
  end if;
  v_by := by_suffix(m.id);

  if new.night_count is distinct from o_night then
    v_tags := array['meal','night'] || case when new.night_count::int <> v_def_night then array['exception'] else '{}' end
                                     || case when v_by <> '' then array['by-staff'] else '{}' end;
    perform notify(case when new.night_count > 0 then 'meal.on' else 'meal.off' end, 'meal',
      m.name || ' · Night meal ' || case when new.night_count > 0 then 'ON' else 'OFF' end || ' · ' || dlabel(new.plan_date)
        || case when new.night_count::int <> v_def_night
                then ' · differs from default (Night ' || case when v_def_night = 1 then 'ON' else 'OFF' end || ')' else '' end
        || v_by,
      m.id, v_tags, jsonb_build_object('date', new.plan_date, 'slot', 'night', 'from', o_night, 'to', new.night_count));
  end if;

  if new.day_count is distinct from o_day then
    v_tags := array['meal','day'] || case when new.day_count::int <> v_def_day then array['exception'] else '{}' end
                                   || case when v_by <> '' then array['by-staff'] else '{}' end;
    perform notify(case when new.day_count > 0 then 'meal.on' else 'meal.off' end, 'meal',
      m.name || ' · Day meal ' || case when new.day_count > 0 then 'ON' else 'OFF' end || ' · ' || dlabel(new.plan_date)
        || case when new.day_count::int <> v_def_day
                then ' · differs from default (Day ' || case when v_def_day = 1 then 'ON' else 'OFF' end || ')' else '' end
        || v_by,
      m.id, v_tags, jsonb_build_object('date', new.plan_date, 'slot', 'day', 'from', o_day, 'to', new.day_count));
  end if;

  if new.guest_night_count is distinct from o_gn then
    perform notify('meal.guest', 'meal',
      m.name || ' · Night guests ' || o_gn::int || ' → ' || new.guest_night_count::int || ' · ' || dlabel(new.plan_date) || v_by,
      m.id, array['meal','guest','night'], jsonb_build_object('date', new.plan_date, 'slot', 'guest_night', 'from', o_gn, 'to', new.guest_night_count));
  end if;
  if new.guest_day_count is distinct from o_gd then
    perform notify('meal.guest', 'meal',
      m.name || ' · Day guests ' || o_gd::int || ' → ' || new.guest_day_count::int || ' · ' || dlabel(new.plan_date) || v_by,
      m.id, array['meal','guest','day'], jsonb_build_object('date', new.plan_date, 'slot', 'guest_day', 'from', o_gd, 'to', new.guest_day_count));
  end if;
  return null;
end $$;
drop trigger if exists trg_meal_plans_notify on public.meal_plans;
create trigger trg_meal_plans_notify after insert or update on public.meal_plans for each row execute function trg_meal_plans_notify();

-- ---------- Final tracker edits (meals table) ----------
create or replace function public.trg_meals_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text; v_parts text[] := '{}';
begin
  if is_silent() then return null; end if;
  if tg_op = 'DELETE' then
    perform notify('tracker.edit', 'meal', member_name(old.member_id) || ' · Tracker entry removed · ' || dlabel(old.meal_date) || by_suffix(null),
                   old.member_id, array['tracker','meal']);
    return null;
  end if;
  v_name := member_name(new.member_id);
  if tg_op = 'INSERT' then
    v_parts := array['Night ' || new.night_count::int, 'Day ' || new.day_count::int];
    if coalesce(new.guest_night_count,0) + coalesce(new.guest_day_count,0) > 0 then
      v_parts := v_parts || ('Guests ' || (coalesce(new.guest_night_count,0) + coalesce(new.guest_day_count,0))::int);
    end if;
  else
    if new.night_count is distinct from old.night_count then v_parts := v_parts || ('Night ' || old.night_count::int || ' → ' || new.night_count::int); end if;
    if new.day_count is distinct from old.day_count then v_parts := v_parts || ('Day ' || old.day_count::int || ' → ' || new.day_count::int); end if;
    if new.guest_night_count is distinct from old.guest_night_count then v_parts := v_parts || ('Night guests ' || coalesce(old.guest_night_count,0)::int || ' → ' || coalesce(new.guest_night_count,0)::int); end if;
    if new.guest_day_count is distinct from old.guest_day_count then v_parts := v_parts || ('Day guests ' || coalesce(old.guest_day_count,0)::int || ' → ' || coalesce(new.guest_day_count,0)::int); end if;
  end if;
  if array_length(v_parts,1) is null then return null; end if;
  perform notify('tracker.edit', 'meal',
    v_name || ' · Tracker ' || case when tg_op = 'INSERT' then 'entry added' else 'edited' end || ' · ' || array_to_string(v_parts, ', ') || ' · ' || dlabel(new.meal_date) || by_suffix(null),
    new.member_id, array['tracker','meal']);
  return null;
end $$;
drop trigger if exists trg_meals_notify on public.meals;
create trigger trg_meals_notify after insert or update or delete on public.meals for each row execute function trg_meals_notify();

-- ---------- Members (defaults, approval, role, archive, rename, signup) ----------
create or replace function public.trg_members_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_by text;
begin
  if is_silent() then return null; end if;
  if tg_op = 'INSERT' then
    if new.is_approved then
      perform notify('member.added', 'other', new.name || ' · Added to the mess' || by_suffix(null), new.id, array['member']);
    else
      perform notify('member.signup', 'other', 'New signup waiting for approval · ' || new.name || coalesce(' (' || new.email || ')', ''),
                     new.id, array['member','approval'], '{}'::jsonb, 'staff');
    end if;
    return null;
  end if;

  if not new.is_approved and not old.is_approved then return null; end if; -- pending users stay invisible
  v_by := by_suffix(new.id);

  if new.is_approved and not old.is_approved then
    perform notify('member.approved', 'other', new.name || ' · Joined the mess (approved)' || by_suffix(null), new.id, array['member','approval']);
  end if;
  if new.default_night_on is distinct from old.default_night_on then
    perform notify(case when new.default_night_on then 'meal.default.on' else 'meal.default.off' end, 'meal',
      new.name || ' · Default Night meal ' || case when old.default_night_on then 'ON' else 'OFF' end || ' → ' || case when new.default_night_on then 'ON' else 'OFF' end
        || ' · new schedule cards follow this' || v_by,
      new.id, array['meal','default','night']);
  end if;
  if new.default_day_on is distinct from old.default_day_on then
    perform notify(case when new.default_day_on then 'meal.default.on' else 'meal.default.off' end, 'meal',
      new.name || ' · Default Day meal ' || case when old.default_day_on then 'ON' else 'OFF' end || ' → ' || case when new.default_day_on then 'ON' else 'OFF' end
        || ' · new schedule cards follow this' || v_by,
      new.id, array['meal','default','day']);
  end if;
  if new.role is distinct from old.role then
    perform notify('member.role', 'other', new.name || ' · Role ' || coalesce(old.role,'user') || ' → ' || coalesce(new.role,'user') || by_suffix(null), new.id, array['member','role']);
  end if;
  if new.name is distinct from old.name then
    perform notify('member.renamed', 'other', old.name || ' · Renamed to ' || new.name || v_by, new.id, array['member']);
  end if;
  if new.archived_from_cycle_id is distinct from old.archived_from_cycle_id then
    perform notify('member.archived', 'other',
      new.name || case when new.archived_from_cycle_id is null then ' · Restored to the mess' else ' · Left the mess (archived)' end || by_suffix(null),
      new.id, array['member']);
  end if;
  return null;
end $$;
drop trigger if exists trg_members_notify on public.members;
create trigger trg_members_notify after insert or update on public.members for each row execute function trg_members_notify();

-- ---------- Expenses ----------
create or replace function public.trg_expenses_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_parts text[] := '{}'; v_desc text;
begin
  if is_silent() then return null; end if;
  if tg_op = 'INSERT' then
    v_desc := coalesce(nullif(new.category,''), nullif(new.description,''), 'Bazar');
    perform notify(case when new.status = 'pending' then 'expense.request' else 'expense.added' end, 'expense',
      'Expense ' || case when new.status = 'pending' then 'request ' else 'added ' end || tk(new.amount) || ' · ' || v_desc
        || ' · shopper ' || member_name(new.member_id) || ' · ' || dlabel(new.expense_date) || by_suffix(new.member_id),
      new.member_id, array['expense', new.status::text], jsonb_build_object('expense_id', new.id, 'amount', new.amount));
    return null;
  elsif tg_op = 'DELETE' then
    perform notify('expense.deleted', 'expense',
      'Expense deleted ' || tk(old.amount) || ' · shopper ' || member_name(old.member_id) || ' · ' || dlabel(old.expense_date) || by_suffix(null),
      old.member_id, array['expense','deleted'], jsonb_build_object('expense_id', old.id, 'amount', old.amount));
    return null;
  end if;

  if new.status is distinct from old.status then
    perform notify('expense.' || new.status::text, 'expense',
      'Expense ' || new.status::text || ' ' || tk(new.amount) || ' · ' || coalesce(nullif(new.description,''), 'Bazar')
        || ' · shopper ' || member_name(new.member_id) || ' · ' || dlabel(new.expense_date) || by_suffix(null),
      new.member_id, array['expense', new.status::text], jsonb_build_object('expense_id', new.id, 'amount', new.amount));
  end if;
  if new.amount is distinct from old.amount then v_parts := v_parts || (tk(old.amount) || ' → ' || tk(new.amount)); end if;
  if new.expense_date is distinct from old.expense_date then v_parts := v_parts || ('date ' || dlabel(old.expense_date) || ' → ' || dlabel(new.expense_date)); end if;
  if new.member_id is distinct from old.member_id then v_parts := v_parts || ('shopper ' || member_name(old.member_id) || ' → ' || member_name(new.member_id)); end if;
  if new.description is distinct from old.description then v_parts := v_parts || ('items "' || coalesce(old.description,'') || '" → "' || coalesce(new.description,'') || '"'); end if;
  if array_length(v_parts,1) is not null then
    perform notify('expense.edited', 'expense', 'Expense edited · ' || array_to_string(v_parts, ' · ') || by_suffix(null),
      new.member_id, array['expense','edited'], jsonb_build_object('expense_id', new.id));
  end if;
  return null;
end $$;
drop trigger if exists trg_expenses_notify on public.expenses;
create trigger trg_expenses_notify after insert or update or delete on public.expenses for each row execute function trg_expenses_notify();

-- ---------- Deposits (requests + any direct staff edits; approvals/reverts notify from their RPCs) ----------
create or replace function public.trg_deposits_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_silent() then return null; end if;
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform notify('deposit.request', 'deposit',
      case when new.amount < 0 then 'Deduction request ' || tk(abs(new.amount)) else 'Deposit request ' || tk(new.amount) end
        || ' · ' || member_name(new.member_id) || coalesce(' · ' || nullif(new.label,''), '') || by_suffix(new.member_id),
      new.member_id, array['deposit','pending'], jsonb_build_object('deposit_id', new.id, 'amount', new.amount));
  elsif tg_op = 'DELETE' then
    perform notify('deposit.deleted', 'deposit',
      'Deposit record deleted ' || tk(old.amount) || ' · ' || member_name(old.member_id) || by_suffix(null),
      old.member_id, array['deposit','deleted'], jsonb_build_object('deposit_id', old.id, 'amount', old.amount));
  elsif tg_op = 'UPDATE' and new.amount is distinct from old.amount then
    perform notify('deposit.edited', 'deposit',
      'Deposit edited · ' || member_name(new.member_id) || ' · ' || tk(old.amount) || ' → ' || tk(new.amount) || by_suffix(null),
      new.member_id, array['deposit','edited'], jsonb_build_object('deposit_id', new.id));
  end if;
  return null;
end $$;
drop trigger if exists trg_deposits_notify on public.deposits;
create trigger trg_deposits_notify after insert or update or delete on public.deposits for each row execute function trg_deposits_notify();

-- ---------- Settings / menu / cycles ----------
create or replace function public.trg_config_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_label text;
begin
  if is_silent() then return null; end if;
  if tg_op = 'UPDATE' and new.value_text is not distinct from old.value_text then return null; end if;
  v_label := case new.key_name when 'lock_time_start' then 'Bazar lock starts' when 'lock_time_end' then 'Bazar lock ends'
                               when 'auto_entry_time' then 'Auto meal entry time' else new.key_name end;
  perform notify('settings.changed', 'other',
    'Setting changed · ' || v_label || ' ' || coalesce(case when tg_op = 'UPDATE' then old.value_text end, '—') || ' → ' || new.value_text || by_suffix(null),
    null, array['settings']);
  return null;
end $$;
drop trigger if exists trg_config_notify on public.app_config;
create trigger trg_config_notify after insert or update on public.app_config for each row execute function trg_config_notify();

create or replace function public.trg_menu_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_silent() then return null; end if;
  if new.night_menu is not distinct from old.night_menu and new.day_menu is not distinct from old.day_menu then return null; end if;
  perform notify('menu.updated', 'other',
    'Menu updated · ' || coalesce(new.day_name, 'Day ' || new.day_index) || ' · Night: ' || coalesce(nullif(new.night_menu,''),'—')
      || ' · Day: ' || coalesce(nullif(new.day_menu,''),'—') || by_suffix(null),
    null, array['menu']);
  return null;
end $$;
drop trigger if exists trg_menu_notify on public.weekly_menus;
create trigger trg_menu_notify after update on public.weekly_menus for each row execute function trg_menu_notify();

create or replace function public.trg_cycles_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_silent() then return null; end if;
  if tg_op = 'INSERT' then
    perform notify('cycle.started', 'other', 'New cycle started · ' || new.name || ' · ' || dlabel(new.start_date) || ' to ' || dlabel(new.end_date) || by_suffix(null),
                   null, array['cycle']);
  elsif new.is_active is distinct from old.is_active and not new.is_active then
    perform notify('cycle.closed', 'other', 'Cycle closed · ' || new.name || by_suffix(null), null, array['cycle']);
  end if;
  return null;
end $$;
drop trigger if exists trg_cycles_notify on public.cycles;
create trigger trg_cycles_notify after insert or update on public.cycles for each row execute function trg_cycles_notify();

-- Trigger functions are never called directly
do $$ declare f text; begin
  foreach f in array array['trg_meal_plans_notify','trg_meals_notify','trg_members_notify','trg_expenses_notify',
                           'trg_deposits_notify','trg_config_notify','trg_menu_notify','trg_cycles_notify',
                           'members_guard','meal_plans_guard'] loop
    execute format('revoke execute on function public.%I() from public, anon, authenticated', f);
  end loop;
end $$;
