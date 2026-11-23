-- =====================================================================
-- MealCal Pro · Migration 04 · Server-side actions (RPCs)
-- Money and bulk meal changes run here, in ONE transaction each, with row locks.
-- =====================================================================

-- ---------- Signup: every new login becomes a PENDING member (no takeover of existing names) ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),
                          nullif(trim(new.raw_user_meta_data->>'username'),''),
                          split_part(new.email, '@', 1));
  v_admin_created boolean := coalesce(current_setting('mealcal.admin_create', true), '') = 'on';
  v_role text := coalesce(nullif(current_setting('mealcal.new_role', true), ''), 'user');
begin
  if exists (select 1 from members where user_id = new.id) then return new; end if;
  if exists (select 1 from members where lower(name) = lower(v_name)) then
    v_name := v_name || ' ' || upper(substr(replace(new.id::text,'-',''), 1, 4));
  end if;
  insert into members (user_id, name, email, role, is_approved, approved_at, approved_by)
  values (new.id, v_name, new.email,
          case when v_admin_created then v_role else 'user' end,
          v_admin_created,
          case when v_admin_created then now() end,
          case when v_admin_created then my_member_id() end);
  return new;
exception when others then
  raise warning 'handle_new_user failed: %', sqlerrm;
  return new;
end $$;

-- ---------- Admin creates a ready-to-use (approved) account ----------
drop function if exists public.admin_create_user(text, text, text);
create or replace function public.admin_create_user(p_email text, p_password text, p_display_name text,
                                                    p_role text default 'user', p_avatar text default null)
returns uuid
language plpgsql security definer set search_path = public, auth, extensions as $$
declare new_user_id uuid;
begin
  if not is_staff() then raise exception 'Only an admin or manager can add members.' using errcode = '42501'; end if;
  if p_role not in ('user','manager') and not is_admin() then raise exception 'Only the admin can create that role.'; end if;
  if length(coalesce(p_password,'')) < 6 then raise exception 'Password must be at least 6 characters.'; end if;
  if exists (select 1 from auth.users where lower(email) = lower(trim(p_email))) then raise exception 'That email already has an account.'; end if;
  if exists (select 1 from members where lower(name) = lower(trim(p_display_name))) then raise exception 'That name is already used.'; end if;

  perform set_config('mealcal.admin_create', 'on', true);
  perform set_config('mealcal.new_role', coalesce(p_role,'user'), true);
  insert into auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, created_at, updated_at,
                          raw_user_meta_data, raw_app_meta_data, aud, role)
  values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', lower(trim(p_email)),
          crypt(p_password, gen_salt('bf')), now(), now(), now(),
          jsonb_build_object('display_name', trim(p_display_name), 'email', lower(trim(p_email))),
          '{"provider":"email","providers":["email"]}'::jsonb, 'authenticated', 'authenticated')
  returning id into new_user_id;
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), new_user_id, new_user_id::text,
          jsonb_build_object('sub', new_user_id::text, 'email', lower(trim(p_email)), 'email_verified', true),
          'email', now(), now(), now())
  on conflict do nothing;
  perform set_config('mealcal.admin_create', 'off', true);
  if p_avatar is not null then
    update members set avatar_url = p_avatar where user_id = new_user_id;
  end if;
  return new_user_id;
end $$;
revoke execute on function public.admin_create_user(text,text,text,text,text) from public, anon;
grant execute on function public.admin_create_user(text,text,text,text,text) to authenticated;

-- ---------- Approve / reject a signup ----------
create or replace function public.approve_member(p_member_id bigint, p_approve boolean default true)
returns json
language plpgsql security definer set search_path = public, auth as $$
declare m record;
begin
  if not is_staff() then raise exception 'Only an admin or manager can approve members.' using errcode = '42501'; end if;
  select * into m from members where id = p_member_id for update;
  if m.id is null then raise exception 'Member not found.'; end if;
  if m.is_approved then raise exception '% is already approved.', m.name; end if;

  if p_approve then
    update members set is_approved = true, approved_at = now(), approved_by = my_member_id() where id = p_member_id;
    perform manage_meal_plans(current_session_date());
    return json_build_object('ok', true, 'approved', true, 'name', m.name);
  else
    perform notify('member.rejected', 'other', 'Signup rejected · ' || m.name || coalesce(' (' || m.email || ')','') || by_suffix(null),
                   null, array['member','approval'], '{}'::jsonb, 'staff');
    perform set_config('mealcal.silent', 'on', true);
    delete from members where id = p_member_id;
    if m.user_id is not null then delete from auth.users where id = m.user_id; end if;
    perform set_config('mealcal.silent', 'off', true);
    return json_build_object('ok', true, 'approved', false, 'name', m.name);
  end if;
end $$;

-- ---------- Login helpers (work before login, expose only approved names) ----------
create or replace function public.get_login_names() returns table(name text)
language sql stable security definer set search_path = public as $$
  select m.name from members m
  where m.is_approved and (m.archived_from_cycle_id is null or m.archived_from_cycle_id > coalesce(active_cycle_id(), 0))
  order by m.name
$$;
create or replace function public.get_login_email(p_name text) returns text
language sql stable security definer set search_path = public as $$
  select email from members where lower(name) = lower(trim(p_name)) and is_approved limit 1
$$;
grant execute on function public.get_login_names() to anon, authenticated;
grant execute on function public.get_login_email(text) to anon, authenticated;

-- ---------- Schedule cards (8 days ahead) for approved, active members — silent ----------
create or replace function public.manage_meal_plans(target_date date) returns void
language plpgsql security definer set search_path = public as $$
declare d int; v_cycle bigint := coalesce(active_cycle_id(), 0);
begin
  if auth.uid() is not null and not is_approved_member() then return; end if;
  perform set_config('mealcal.silent', 'on', true);
  perform set_config('mealcal.system', 'on', true);
  for d in 0..7 loop
    insert into meal_plans (member_id, plan_date, day_count, night_count)
    select m.id, target_date + d,
           case when m.default_day_on and m.meal_shutdown_at is null then 1 else 0 end,
           case when m.default_night_on and m.meal_shutdown_at is null then 1 else 0 end
    from members m
    where m.is_approved and (m.archived_from_cycle_id is null or m.archived_from_cycle_id > v_cycle)
    on conflict (member_id, plan_date) do nothing;
  end loop;
  delete from meal_plans where plan_date < (target_date - 1);
  perform set_config('mealcal.silent', 'off', true);
  perform set_config('mealcal.system', 'off', true);
end $$;
revoke execute on function public.manage_meal_plans(date) from public, anon;
grant execute on function public.manage_meal_plans(date) to authenticated;

-- ---------- Meal shutdown / start (one notification) ----------
create or replace function public.set_meal_power(p_member_id bigint, p_on boolean) returns json
language plpgsql security definer set search_path = public as $$
declare
  m record;
  v_from date := current_session_date();
  v_cards int;
begin
  if not (is_staff() or (is_approved_member() and p_member_id = my_member_id())) then
    raise exception 'You can only change your own meals.' using errcode = '42501';
  end if;
  select * into m from members where id = p_member_id for update;
  if m.id is null or not m.is_approved then raise exception 'Member not found.'; end if;
  -- Normal users cannot touch a session that is locked (bazar already done)
  if not is_staff() and is_slot_locked(v_from, 'night') then v_from := v_from + 1; end if;

  perform set_config('mealcal.silent', 'on', true);
  perform set_config('mealcal.system', 'on', true);
  update members set default_day_on = p_on, default_night_on = p_on,
                     meal_shutdown_at = case when p_on then null else now() end
   where id = p_member_id;
  perform manage_meal_plans(v_from);
  perform set_config('mealcal.silent', 'on', true);
  perform set_config('mealcal.system', 'on', true);
  update meal_plans set night_count = case when p_on then 1 else 0 end,
                        guest_night_count = case when p_on then guest_night_count else 0 end
   where member_id = p_member_id and plan_date >= v_from;
  get diagnostics v_cards = row_count;
  update meal_plans set day_count = case when p_on then 1 else 0 end,
                        guest_day_count = case when p_on then guest_day_count else 0 end
   where member_id = p_member_id and plan_date >= v_from + 1;
  perform set_config('mealcal.silent', 'off', true);
  perform set_config('mealcal.system', 'off', true);

  perform notify(case when p_on then 'meal.restart' else 'meal.shutdown' end, 'meal',
    m.name || case when p_on then ' · ALL meals turned ON' else ' · ALL meals turned OFF' end
      || ' · from Night of ' || dlabel(v_from) || ' · default Day & Night ' || case when p_on then 'ON' else 'OFF' end
      || ' · at ' || to_char(local_now(), 'DD Mon, HH12:MI AM') || by_suffix(m.id),
    m.id, array['meal', case when p_on then 'restart' else 'shutdown' end, 'important'],
    jsonb_build_object('from_session', v_from, 'cards', v_cards));
  return json_build_object('ok', true, 'on', p_on, 'from_session', v_from);
end $$;
revoke execute on function public.set_meal_power(bigint, boolean) from public, anon;
grant execute on function public.set_meal_power(bigint, boolean) to authenticated;

-- ---------- Approve deposit + precise auto-settlement (atomic) ----------
create or replace function public.approve_deposit(p_deposit_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare
  d record; debt record; cred record;
  v_remaining numeric; v_debt_left numeric; v_cred_left numeric; v_amt numeric; v_debt_settled numeric;
  v_total numeric := 0; v_lines text[] := '{}'; v_debtor text;
begin
  if not is_staff() then raise exception 'Only an admin or manager can approve deposits.' using errcode = '42501'; end if;
  select * into d from deposits where id = p_deposit_id for update;
  if d.id is null then raise exception 'Deposit request not found (maybe already handled).'; end if;
  if d.status <> 'pending' then raise exception 'This deposit is already %.', d.status; end if;
  v_debtor := member_name(d.member_id);

  perform set_config('mealcal.silent', 'on', true);
  update deposits set status = 'approved', is_approved = true, approved_by = my_member_id() where id = d.id;

  if d.amount > 0 then
    v_remaining := d.amount;
    for debt in select * from cycle_dues
                where member_id = d.member_id and to_cycle_id = d.cycle_id and due_amount < 0
                  and status in ('pending','settling')
                order by created_at, id for update loop
      exit when v_remaining <= 0.004;
      v_debt_left := abs(debt.due_amount) - abs(coalesce(debt.settled_amount, 0));
      continue when v_debt_left <= 0.004;
      v_debt_settled := 0;
      for cred in select * from cycle_dues
                  where to_cycle_id = d.cycle_id and due_amount > 0 and member_id <> d.member_id
                    and status in ('pending','settling')
                  order by created_at, id for update loop
        exit when v_remaining <= 0.004 or v_debt_left - v_debt_settled <= 0.004;
        v_cred_left := cred.due_amount - coalesce(cred.settled_amount, 0);
        continue when v_cred_left <= 0.004;
        v_amt := round(least(v_remaining, v_debt_left - v_debt_settled, v_cred_left), 2);
        continue when v_amt <= 0;

        insert into deposits (cycle_id, member_id, amount, label, notes, status, is_approved, approved_by, parent_deposit_id, cycle_due_id)
        values (d.cycle_id, d.member_id, -v_amt, 'Auto-Settlement', 'Paid to ' || member_name(cred.member_id), 'approved', true, my_member_id(), d.id, debt.id),
               (d.cycle_id, cred.member_id, v_amt, 'Auto-Settlement', 'Received from ' || v_debtor, 'approved', true, my_member_id(), d.id, cred.id);

        update cycle_dues
           set settled_amount = round(coalesce(settled_amount,0) + v_amt, 2),
               status = case when round(coalesce(settled_amount,0) + v_amt, 2) >= due_amount - 0.004 then 'settled' else 'settling' end,
               settled_at = case when round(coalesce(settled_amount,0) + v_amt, 2) >= due_amount - 0.004 then now() else null end
         where id = cred.id;

        v_remaining := v_remaining - v_amt;
        v_debt_settled := v_debt_settled + v_amt;
        v_total := v_total + v_amt;
        v_lines := v_lines || (tk(v_amt) || ' to ' || member_name(cred.member_id));
      end loop;

      if v_debt_settled > 0 then
        update cycle_dues
           set settled_amount = -round(abs(coalesce(settled_amount,0)) + v_debt_settled, 2),
               status = case when round(abs(coalesce(settled_amount,0)) + v_debt_settled, 2) >= abs(due_amount) - 0.004 then 'settled' else 'settling' end,
               settled_at = case when round(abs(coalesce(settled_amount,0)) + v_debt_settled, 2) >= abs(due_amount) - 0.004 then now() else null end
         where id = debt.id;
      end if;
    end loop;
  end if;
  perform set_config('mealcal.silent', 'off', true);

  perform notify('deposit.approved', 'deposit',
    case when d.amount < 0 then 'Deduction approved ' || tk(abs(d.amount)) else 'Deposit approved ' || tk(d.amount) end
      || ' · ' || v_debtor || coalesce(' · ' || nullif(d.label,''), '')
      || case when v_total > 0 then ' · auto-settled old dues: ' || array_to_string(v_lines, ', ') else '' end
      || by_suffix(null),
    d.member_id, array['deposit','approved'] || case when v_total > 0 then array['settlement'] else '{}' end,
    jsonb_build_object('deposit_id', d.id, 'amount', d.amount, 'settled', v_total));
  return json_build_object('ok', true, 'deposit_id', d.id, 'settled', v_total);
end $$;

-- ---------- Reject a pending request ----------
create or replace function public.reject_deposit(p_deposit_id bigint, p_reason text default null) returns json
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if not is_staff() then raise exception 'Only an admin or manager can reject deposits.' using errcode = '42501'; end if;
  select * into d from deposits where id = p_deposit_id for update;
  if d.id is null then raise exception 'Request not found (maybe already handled).'; end if;
  if d.status <> 'pending' then raise exception 'Only pending requests can be rejected. Use Revert for approved deposits.'; end if;
  perform set_config('mealcal.silent', 'on', true);
  delete from deposits where id = d.id;
  perform set_config('mealcal.silent', 'off', true);
  perform notify('deposit.rejected', 'deposit',
    case when d.amount < 0 then 'Deduction request rejected ' || tk(abs(d.amount)) else 'Deposit request rejected ' || tk(d.amount) end
      || ' · ' || member_name(d.member_id) || coalesce(' · reason: ' || nullif(trim(p_reason),''), '') || by_suffix(null),
    d.member_id, array['deposit','rejected'], jsonb_build_object('amount', d.amount));
  return json_build_object('ok', true);
end $$;

-- ---------- Revert an approved deposit (mistakes), undoing its settlement exactly ----------
create or replace function public.revert_deposit(p_deposit_id bigint, p_reason text default null) returns json
language plpgsql security definer set search_path = public as $$
declare
  d record; c record; v_due bigint; v_undone numeric := 0; v_lines text[] := '{}';
begin
  if not is_staff() then raise exception 'Only an admin or manager can revert deposits.' using errcode = '42501'; end if;
  select * into d from deposits where id = p_deposit_id for update;
  if d.id is null then raise exception 'Deposit not found.'; end if;
  if d.status <> 'approved' then raise exception 'Only approved deposits can be reverted.'; end if;
  if d.parent_deposit_id is not null or d.label = 'Auto-Settlement' then
    raise exception 'This is an automatic settlement line. Revert the original deposit instead.';
  end if;

  perform set_config('mealcal.silent', 'on', true);
  for c in select * from deposits where parent_deposit_id = d.id order by id for update loop
    v_due := c.cycle_due_id;
    if v_due is null then -- older settlements (before 2026-11-23) have no direct link: find the matching due
      select id into v_due from cycle_dues
       where to_cycle_id = c.cycle_id and member_id = c.member_id
         and ((c.amount > 0 and due_amount > 0) or (c.amount < 0 and due_amount < 0))
       order by created_at, id limit 1;
    end if;
    if v_due is not null then
      if c.amount > 0 then  -- creditor received money: reduce their settled amount
        update cycle_dues set settled_amount = greatest(0, round(coalesce(settled_amount,0) - c.amount, 2)) where id = v_due;
        v_lines := v_lines || (tk(c.amount) || ' from ' || member_name(c.member_id));
        v_undone := v_undone + c.amount;
      else                  -- debtor paid: their (negative) settled amount shrinks back
        update cycle_dues set settled_amount = -greatest(0, round(abs(coalesce(settled_amount,0)) - abs(c.amount), 2)) where id = v_due;
      end if;
      update cycle_dues
         set status = case when abs(coalesce(settled_amount,0)) >= abs(due_amount) - 0.004 then 'settled'
                           when abs(coalesce(settled_amount,0)) > 0.004 then 'settling' else 'pending' end,
             settled_at = case when abs(coalesce(settled_amount,0)) >= abs(due_amount) - 0.004 then settled_at else null end
       where id = v_due;
    end if;
  end loop;
  delete from deposits where parent_deposit_id = d.id;
  delete from deposits where id = d.id;
  perform set_config('mealcal.silent', 'off', true);

  perform notify('deposit.reverted', 'deposit',
    case when d.amount < 0 then 'Deduction reverted ' || tk(abs(d.amount)) else 'Deposit reverted ' || tk(d.amount) end
      || ' · ' || member_name(d.member_id) || ' · made ' || to_char(d.created_at at time zone 'Asia/Dhaka', 'DD Mon')
      || case when v_undone > 0 then ' · settlement undone: ' || array_to_string(v_lines, ', ') || ' (dues reopened)' else '' end
      || coalesce(' · reason: ' || nullif(trim(p_reason),''), '') || by_suffix(null),
    d.member_id, array['deposit','reverted','important'] || case when v_undone > 0 then array['settlement'] else '{}' end,
    jsonb_build_object('amount', d.amount, 'undone', v_undone));
  return json_build_object('ok', true, 'undone', v_undone);
end $$;

do $$ declare f text; begin
  foreach f in array array['approve_deposit(bigint)','reject_deposit(bigint,text)','revert_deposit(bigint,text)',
                           'approve_member(bigint,boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ---------- Daily auto entry: plans -> tracker + daily report + one notification ----------
create or replace function public.handle_auto_meal_entry(force_run boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_cycle bigint;
  v_today date := local_now()::date;   -- session (bazar) date: its NIGHT meal
  v_tomorrow date := local_now()::date + 1; -- + the next date's DAY meal
  v_items jsonb; v_tn numeric; v_td numeric; v_tg numeric;
begin
  if auth.uid() is not null and not is_staff() then raise exception 'Only an admin or manager can run the meal entry.' using errcode = '42501'; end if;
  if not force_run and exists (select 1 from system_logs where log_date = v_today) then return; end if;
  v_cycle := active_cycle_id();
  if v_cycle is null then raise exception 'No active cycle found'; end if;

  perform manage_meal_plans(v_today);
  perform set_config('mealcal.silent', 'on', true);

  insert into meals (cycle_id, member_id, meal_date, day_count, night_count, guest_day_count, guest_night_count, updated_at)
  select v_cycle, m.id, v_today,
         coalesce(ex.day_count, 0),
         coalesce(mp.night_count, case when m.default_night_on and m.meal_shutdown_at is null then 1 else 0 end),
         coalesce(ex.guest_day_count, 0),
         coalesce(mp.guest_night_count, 0), now()
  from members m
  left join meal_plans mp on mp.member_id = m.id and mp.plan_date = v_today
  left join meals ex on ex.member_id = m.id and ex.meal_date = v_today and ex.cycle_id = v_cycle
  where m.is_approved and (m.archived_from_cycle_id is null or m.archived_from_cycle_id > v_cycle)
  on conflict (member_id, meal_date) do update
    set night_count = excluded.night_count, guest_night_count = excluded.guest_night_count, updated_at = now();

  insert into meals (cycle_id, member_id, meal_date, day_count, night_count, guest_day_count, guest_night_count, updated_at)
  select v_cycle, m.id, v_tomorrow,
         coalesce(mp.day_count, case when m.default_day_on and m.meal_shutdown_at is null then 1 else 0 end),
         coalesce(ex.night_count, 0),
         coalesce(mp.guest_day_count, 0),
         coalesce(ex.guest_night_count, 0), now()
  from members m
  left join meal_plans mp on mp.member_id = m.id and mp.plan_date = v_tomorrow
  left join meals ex on ex.member_id = m.id and ex.meal_date = v_tomorrow and ex.cycle_id = v_cycle
  where m.is_approved and (m.archived_from_cycle_id is null or m.archived_from_cycle_id > v_cycle)
  on conflict (member_id, meal_date) do update
    set day_count = excluded.day_count, guest_day_count = excluded.guest_day_count, updated_at = now();

  -- Snapshot of who was counted for this session (night of v_today + day of v_tomorrow)
  select coalesce(jsonb_agg(jsonb_build_object('member_id', x.id, 'name', x.name, 'night', x.n, 'guest_night', x.gn, 'day', x.d, 'guest_day', x.gd) order by x.name), '[]'::jsonb),
         coalesce(sum(x.n),0), coalesce(sum(x.d),0), coalesce(sum(x.gn + x.gd),0)
    into v_items, v_tn, v_td, v_tg
  from (
    select m.id, m.name,
           coalesce(a.night_count,0) n, coalesce(a.guest_night_count,0) gn,
           coalesce(b.day_count,0) d, coalesce(b.guest_day_count,0) gd
    from members m
    left join meals a on a.member_id = m.id and a.meal_date = v_today
    left join meals b on b.member_id = m.id and b.meal_date = v_tomorrow
    where m.is_approved and (m.archived_from_cycle_id is null or m.archived_from_cycle_id > v_cycle)
  ) x
  where x.n + x.gn + x.d + x.gd > 0;

  insert into meal_day_reports (cycle_id, session_date, night_date, day_date, items, total_night, total_day, total_guest, updated_at)
  values (v_cycle, v_today, v_today, v_tomorrow, v_items, v_tn, v_td, v_tg, now())
  on conflict (session_date) do update
    set cycle_id = excluded.cycle_id, items = excluded.items, total_night = excluded.total_night,
        total_day = excluded.total_day, total_guest = excluded.total_guest, updated_at = now();

  insert into system_logs (log_date, executed_at, details)
  values (v_today, now(), 'Automated meal entry executed successfully')
  on conflict (log_date) do update set executed_at = now(), details = 'Automated meal entry forced/re-executed';
  perform set_config('mealcal.silent', 'off', true);

  perform notify('tracker.sent', 'meal',
    'Meal count sent to tracker · Session ' || dlabel(v_today) || ' · Night ' || v_tn::int || ' (' || dlabel(v_today) || ')'
      || ' · Day ' || v_td::int || ' (' || dlabel(v_tomorrow) || ')'
      || case when v_tg > 0 then ' · Guests ' || v_tg::int else '' end
      || case when force_run then by_suffix(null) else '' end,
    null, array['tracker','meal','report'], jsonb_build_object('session_date', v_today));
end $$;
revoke execute on function public.handle_auto_meal_entry(boolean) from public, anon;
grant execute on function public.handle_auto_meal_entry(boolean) to authenticated;
