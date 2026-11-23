// MealCal Pro — Member approvals, meal shutdown/start, daily meal-count reports.
// (Classic script; shares global scope. Server logic lives in Supabase RPCs:
//  approve_member, set_meal_power, handle_auto_meal_entry → meal_day_reports.)

// ============================================
// 1. SIGNUP APPROVALS (staff only)
// ============================================
function renderPendingApprovals() {
  const targets = ["dashPendingApprovals", "adminPendingApprovals"].map((id) => document.getElementById(id)).filter(Boolean);
  if (!targets.length) return;
  const list = isStaff() ? pendingMembers || [] : [];
  const html = !list.length ? "" : `
    <section class="mc-card mc-card-alert" aria-label="Signups waiting for approval">
      <div class="mc-card-head">
        <h3 class="mc-card-title"><span class="mc-dot mc-dot-warn"></span>Waiting for approval <span class="mc-count">${list.length}</span></h3>
        <span class="mc-card-sub">Not visible to members until approved</span>
      </div>
      <div class="mc-list">
        ${list.map((m) => `
          <div class="mc-row">
            <div class="mc-avatar">${escapeHtml((m.name || "?")[0].toUpperCase())}</div>
            <div class="mc-row-main">
              <div class="mc-row-title">${escapeHtml(m.name)}</div>
              <div class="mc-row-sub">${escapeHtml(m.email || "")} · signed up ${escapeHtml(formatDate(m.created_at))}</div>
            </div>
            <div class="mc-row-actions">
              <button type="button" class="ui-btn ui-btn-primary ui-btn-sm" onclick="decideMember(${m.id}, true)">Approve</button>
              <button type="button" class="ui-btn ui-btn-ghost ui-btn-sm" onclick="decideMember(${m.id}, false)">Reject</button>
            </div>
          </div>`).join("")}
      </div>
    </section>`;
  targets.forEach((t) => (t.innerHTML = html));
}

async function decideMember(memberId, approve) {
  const m = (pendingMembers || []).find((x) => x.id === memberId);
  const name = m?.name || "this person";
  const ok = approve
    ? await uiConfirm(`Approve ${name}?`, "They'll join the mess, get schedule cards (default: Night meal ON) and appear in all lists.", { icon: "✅", confirmText: "Approve" })
    : await uiConfirm(`Reject ${name}?`, "Their signup and login are deleted. They can sign up again later.", { danger: true, confirmText: "Reject & delete" });
  if (!ok) return;
  try {
    const { error } = await supabase.rpc("approve_member", { p_member_id: memberId, p_approve: approve });
    if (error) throw error;
    showNotification(approve ? `${name} approved` : `${name}'s signup rejected`, approve ? "success" : "warning");
    await loadMembers();
    if (typeof loadMembersList === "function" && document.getElementById("membersList")) loadMembersList();
    if (approve) refreshCurrentPage();
  } catch (err) {
    showNotification(niceError(err), "error");
  }
}

// ============================================
// 2. MEAL POWER — shut down / start ALL meals (one notification)
// ============================================
function mealPowerState(member) {
  return member?.meal_shutdown_at ? { on: false, since: member.meal_shutdown_at } : { on: true };
}

function renderMyMealPower() {
  const box = document.getElementById("mealPowerCard");
  if (!box || !currentUser?.member_id) return;
  const me = allMembers.find((m) => m.id === currentUser.member_id) || currentUser.members;
  const st = mealPowerState(me);
  box.innerHTML = `
    <div class="meal-power ${st.on ? "is-on" : "is-off"}">
      <div class="meal-power-icon">${st.on ? "🍽️" : "⛔"}</div>
      <div class="meal-power-text">
        <div class="meal-power-title">${st.on ? "Meals running" : "All meals are OFF"}</div>
        <div class="meal-power-sub">${st.on
          ? "Going away? Turn off every meal card and your defaults in one tap."
          : `Since ${escapeHtml(formatDateTimeFull(st.since))}. Tap Start when you're back.`}</div>
      </div>
      <button type="button" class="ui-btn ${st.on ? "ui-btn-danger" : "ui-btn-primary"}" onclick="toggleMealPower(${currentUser.member_id}, ${!st.on})">
        ${st.on ? "Shut down" : "Start meals"}
      </button>
    </div>`;
}

function renderStaffMealControl() {
  const box = document.getElementById("dashMealControl");
  if (!box) return;
  if (!isStaff()) { box.innerHTML = ""; return; }
  const cycle = parseInt(currentCycleId) || 0;
  const members = (allMembers || []).filter((m) => !m.archived_from_cycle_id || cycle < m.archived_from_cycle_id);
  const off = members.filter((m) => m.meal_shutdown_at);
  box.innerHTML = `
    <details class="mc-card mc-collapsible" ${off.length ? "open" : ""}>
      <summary class="mc-card-head">
        <h3 class="mc-card-title">⏻ Meal control <span class="mc-count ${off.length ? "warn" : ""}">${off.length} off</span></h3>
        <span class="mc-card-sub">Shut down or start all meals for a member</span>
      </summary>
      <div class="mc-list">
        ${members.map((m) => {
          const st = mealPowerState(m);
          return `
          <div class="mc-row">
            <div class="mc-avatar ${st.on ? "" : "off"}">${escapeHtml((m.name || "?")[0].toUpperCase())}</div>
            <div class="mc-row-main">
              <div class="mc-row-title">${escapeHtml(m.name)}</div>
              <div class="mc-row-sub">${st.on
                ? `Running · default Day ${m.default_day_on ? "ON" : "OFF"} · Night ${m.default_night_on ? "ON" : "OFF"}`
                : `<span class="mc-text-danger">All meals OFF</span> since ${escapeHtml(formatDateTimeFull(st.since))}`}</div>
            </div>
            <button type="button" class="ui-btn ui-btn-sm ${st.on ? "ui-btn-ghost-danger" : "ui-btn-primary"}" onclick="toggleMealPower(${m.id}, ${!st.on})">
              ${st.on ? "Shut down" : "Start"}
            </button>
          </div>`;
        }).join("")}
      </div>
    </details>`;
}

async function toggleMealPower(memberId, turnOn) {
  const m = allMembers.find((x) => x.id === memberId);
  const self = memberId === currentUser?.member_id;
  const who = self ? "your" : `${m?.name || "this member"}'s`;
  const ok = turnOn
    ? await uiConfirm(`Start ${who} meals?`, "Every upcoming schedule card turns Day + Night ON and both defaults turn ON.\nOne notification is sent to everyone.", { icon: "✅", confirmText: "Start meals" })
    : await uiConfirm(`Shut down ${who} meals?`, "Every upcoming schedule card (and guests) turns OFF and both defaults turn OFF, starting from the current session (or the next one if bazar time is locked).\nOne notification is sent to everyone.", { danger: true, icon: "⛔", confirmText: "Shut down" });
  if (!ok) return;
  try {
    const { data, error } = await supabase.rpc("set_meal_power", { p_member_id: memberId, p_on: turnOn });
    if (error) throw error;
    const from = data?.from_session ? parseLocalDate(data.from_session).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
    showNotification(turnOn ? `Meals started from night of ${from}` : `All meals off from night of ${from}`, turnOn ? "success" : "warning");
    await loadMembers();
    renderMyMealPower();
    renderStaffMealControl();
    if (typeof renderMealOffNote === "function") renderMealOffNote();
    if (typeof renderDashboardMemberSchedules === "function") renderDashboardMemberSchedules();
    if (typeof loadScheduler === "function" && self) loadScheduler();
    if (typeof loadDashboardMemberSchedules === "function") loadDashboardMemberSchedules();
    if (typeof updateDefaultButtons === "function" && self) updateDefaultButtons(allMembers.find((x) => x.id === memberId));
  } catch (err) {
    showNotification(niceError(err), "error");
  }
}

// ============================================
// 3. DAILY MEAL-COUNT REPORTS
// A session = that day's NIGHT + the next day's DAY.
// Saved reports (meal_day_reports, written at the nightly auto entry) are used when they exist;
// any other session is rebuilt from the tracker data (meals table), so past sessions always work.
// ============================================
let mealReportsCache = [];   // [{session_date, night_date, day_date, items, total_*}] newest first
let _reportIdx = 0;          // which session the tracker card shows

async function loadMealReports() {
  if (!currentCycleId) return;
  const [repRes, mealsRes] = await Promise.all([
    supabase.from("meal_day_reports").select("*").eq("cycle_id", currentCycleId).order("session_date", { ascending: false }),
    supabase.from("meals").select("member_id, meal_date, day_count, night_count, guest_day_count, guest_night_count").eq("cycle_id", currentCycleId),
  ]);
  const saved = repRes.data || [];
  const meals = mealsRes.data || [];
  const nameOf = Object.fromEntries((allMembers || []).map((m) => [m.id, m.name]));
  const addDays = (iso, n) => { const d = parseLocalDate(iso); d.setDate(d.getDate() + n); return toLocalISO(d); };

  // Every date that has night data recorded is a tracked session
  const nightDates = [...new Set(meals.filter((m) => Number(m.night_count) + Number(m.guest_night_count || 0) > 0).map((m) => m.meal_date))];
  const sessions = new Set([...nightDates, ...saved.map((r) => r.session_date)]);

  mealReportsCache = [...sessions]
    .sort((a, b) => b.localeCompare(a))
    .map((sd) => {
      const rep = saved.find((r) => r.session_date === sd);
      if (rep) return rep;
      const dd = addDays(sd, 1);
      const byMember = {};
      meals.forEach((m) => {
        if (m.meal_date !== sd && m.meal_date !== dd) return;
        const row = (byMember[m.member_id] ||= { member_id: m.member_id, name: nameOf[m.member_id] || "Member", night: 0, guest_night: 0, day: 0, guest_day: 0 });
        if (m.meal_date === sd) { row.night += Number(m.night_count || 0); row.guest_night += Number(m.guest_night_count || 0); }
        if (m.meal_date === dd) { row.day += Number(m.day_count || 0); row.guest_day += Number(m.guest_day_count || 0); }
      });
      const items = Object.values(byMember).filter((i) => i.night + i.day + i.guest_night + i.guest_day > 0).sort((a, b) => a.name.localeCompare(b.name));
      return {
        session_date: sd, night_date: sd, day_date: dd, items, from_tracker: true,
        total_night: items.reduce((s, i) => s + i.night, 0),
        total_day: items.reduce((s, i) => s + i.day, 0),
        total_guest: items.reduce((s, i) => s + i.guest_night + i.guest_day, 0),
      };
    });
  _reportIdx = Math.min(_reportIdx, Math.max(0, mealReportsCache.length - 1));
  renderDashMealReport();
  renderTrackerMealReports();
}

function _dayLabel(iso) {
  return parseLocalDate(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function sumGuests(items, key) {
  const g = items.reduce((s, i) => s + Number(i[key] || 0), 0);
  return g > 0 ? ` <span class="mc-guest">+${g}</span>` : "";
}

function mealReportTable(r) {
  const items = r.items || [];
  if (!items.length) return `<div class="mc-empty">Nobody had a meal this session.</div>`;
  const cell = (n, g) => `${n > 0 ? '<span class="mc-yes">✓</span>' : '<span class="mc-no">–</span>'}${g > 0 ? `<span class="mc-guest">+${g}</span>` : ""}`;
  return `
    <div class="mc-table-wrap">
      <table class="mc-table">
        <thead><tr><th>Member</th><th>রাত<br><small>${escapeHtml(_dayLabel(r.night_date))}</small></th><th>দুপুর<br><small>${escapeHtml(_dayLabel(r.day_date))}</small></th></tr></thead>
        <tbody>
          ${items.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td>${cell(i.night, i.guest_night)}</td><td>${cell(i.day, i.guest_day)}</td></tr>`).join("")}
        </tbody>
        <tfoot><tr><td>Total</td><td>${Number(r.total_night)}${sumGuests(items, "guest_night")}</td><td>${Number(r.total_day)}${sumGuests(items, "guest_day")}</td></tr></tfoot>
      </table>
    </div>`;
}

function renderDashMealReport() {
  const box = document.getElementById("dashMealReport");
  if (!box) return;
  const r = mealReportsCache[0];
  if (!r) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <details class="mc-card mc-collapsible">
      <summary class="mc-card-head">
        <h3 class="mc-card-title">📋 Last meal count</h3>
        <span class="mc-card-sub">Session ${escapeHtml(_dayLabel(r.session_date))} · রাত ${Number(r.total_night)} · দুপুর ${Number(r.total_day)}${Number(r.total_guest) ? ` · Guests ${Number(r.total_guest)}` : ""}</span>
      </summary>
      ${mealReportTable(r)}
      <button type="button" class="ui-btn ui-btn-ghost ui-btn-sm mc-more" onclick="navigateToPage('tracker')">All sessions →</button>
    </details>`;
}

function renderTrackerMealReports() {
  const box = document.getElementById("trackerMealReports");
  if (!box) return;
  if (!mealReportsCache.length) {
    box.innerHTML = `<section class="mc-card"><div class="mc-card-head"><h3 class="mc-card-title">📋 Daily meal counts</h3></div>
      <div class="mc-empty">Nothing has been sent to the tracker in this cycle yet.</div></section>`;
    return;
  }
  const r = mealReportsCache[_reportIdx];
  const total = mealReportsCache.length;
  box.innerHTML = `
    <section class="mc-card rep-card">
      <div class="mc-card-head">
        <h3 class="mc-card-title">📋 Daily meal counts</h3>
        <span class="mc-card-sub">${_reportIdx === 0 ? "Last tracked session" : `${_reportIdx} session${_reportIdx > 1 ? "s" : ""} earlier`}</span>
      </div>
      <div class="rep-nav" role="group" aria-label="Choose bazar session">
        <button type="button" class="rep-arrow" onclick="stepMealReport(1)" ${_reportIdx >= total - 1 ? "disabled" : ""} aria-label="Older session">‹</button>
        <select class="rep-select" onchange="pickMealReport(this.value)" aria-label="Bazar session">
          ${mealReportsCache.map((x, i) => `<option value="${i}" ${i === _reportIdx ? "selected" : ""}>${escapeHtml(_dayLabel(x.session_date))} Bazar</option>`).join("")}
        </select>
        <button type="button" class="rep-arrow" onclick="stepMealReport(-1)" ${_reportIdx <= 0 ? "disabled" : ""} aria-label="Newer session">›</button>
      </div>
      <div class="rep-totals">
        <div class="rep-total rep-night"><span>রাত</span><b>${Number(r.total_night)}</b><small>${escapeHtml(_dayLabel(r.night_date))}</small></div>
        <div class="rep-total rep-day"><span>দুপুর</span><b>${Number(r.total_day)}</b><small>${escapeHtml(_dayLabel(r.day_date))}</small></div>
        <div class="rep-total rep-guest"><span>Guests</span><b>${Number(r.total_guest)}</b><small>both meals</small></div>
      </div>
      ${mealReportTable(r)}
      ${r.from_tracker ? `<div class="chart-note">Built from the tracker data for this session.</div>` : ""}
    </section>`;
}

function stepMealReport(delta) {
  _reportIdx = Math.max(0, Math.min(mealReportsCache.length - 1, _reportIdx + delta));
  renderTrackerMealReports();
}
function pickMealReport(i) {
  _reportIdx = Math.max(0, Math.min(mealReportsCache.length - 1, parseInt(i) || 0));
  renderTrackerMealReports();
}

// ============================================
// Helpers + page hooks
// ============================================
function formatDateTimeFull(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}

/** Called by loadPageData() after a page's main data has loaded */
function onPageLoaded(pageName) {
  try {
    if (pageName === "dashboard") {
      renderPendingApprovals();
      renderStaffMealControl();
      loadMealReports();
    } else if (pageName === "profile") {
      renderMyMealPower();
    } else if (pageName === "tracker") {
      loadMealReports();
    } else if (pageName === "admin") {
      renderPendingApprovals();
    } else if (pageName === "summary") {
      if (typeof renderSummaryInsights === "function") renderSummaryInsights();
    }
  } catch (e) {
    console.warn("onPageLoaded", pageName, e);
  }
}
