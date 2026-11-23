// MealCal Pro — Members' 7-day schedule on dashboard + guest/day modals
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// 👥 MEMBERS' 7-DAY MEAL SCHEDULE DASHBOARD ENGINE
// ============================================

let cachedDashboardSchedules = {
  dates: [],
  membersList: [],
  planMap: {},
  sessionDateObj: null
};

async function loadDashboardMemberSchedules() {
  const container = document.getElementById("dashMemberSchedulesContainer");
  if (!container) return;

  try {
    // 1. Get current active session date & construct 8 session dates (D0 to D7 for 7 sessions)
    const sessionDateObj = await getActiveSessionDate();
    const dates = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(sessionDateObj);
      d.setDate(sessionDateObj.getDate() + i);
      dates.push(toLocalISO(d)); // 'YYYY-MM-DD'
    }

    // 2. Fetch Members if allMembers is empty
    let membersList = allMembers || [];
    if (!membersList || membersList.length === 0) {
      const { data: fetchedMembers } = await supabase
        .from("members")
        .select("*")
        .eq("is_approved", true)
        .order("name", { ascending: true });
      if (fetchedMembers) {
        membersList = fetchedMembers;
        allMembers = fetchedMembers;
      }
    }

    if (!membersList || membersList.length === 0) {
      container.innerHTML = '<div style="font-size:12px; color:#64748b; text-align:center; padding:20px;">No members found.</div>';
      return;
    }

    // 3. Fetch 8-day meal plans for all members in parallel
    const { data: plansData, error: plansErr } = await supabase
      .from("meal_plans")
      .select("*")
      .in("plan_date", dates);

    if (plansErr) throw plansErr;

    const planMap = {};
    (plansData || []).forEach((p) => {
      planMap[`${p.member_id}_${p.plan_date}`] = p;
    });

    cachedDashboardSchedules = {
      dates,
      membersList,
      planMap,
      sessionDateObj,
    };

    renderDashboardMemberSchedules();
  } catch (err) {
    console.error("Error loading dashboard member schedules:", err);
    container.innerHTML = `<div style="font-size:12px; color:#ef4444; text-align:center; padding:15px;">Failed to load schedules: ${err.message || err}</div>`;
  }
}

function renderDashboardMemberSchedules() {
  const container = document.getElementById("dashMemberSchedulesContainer");
  if (!container || !cachedDashboardSchedules.dates) return;

  const { dates, planMap, sessionDateObj } = cachedDashboardSchedules;
  // Always use the freshest member list (shutdown/default changes arrive via loadMembers)
  const membersList = allMembers && allMembers.length ? allMembers : cachedDashboardSchedules.membersList;
  const searchInput = document.getElementById("dashMemberSearch");
  const searchQuery = (searchInput?.value || "").toLowerCase().trim();

  // Exclude archived members
  const activeMembers = (membersList || []).filter((m) => {
    if (m.archived) return false;
    if (m.archived_from_cycle_id && currentCycleId && parseInt(currentCycleId) >= m.archived_from_cycle_id) {
      return false;
    }
    if (!searchQuery) return true;
    return (m.name || "").toLowerCase().includes(searchQuery) || (m.role || "").toLowerCase().includes(searchQuery);
  });

  const countBadge = document.getElementById("dashSchedulesCount");
  if (countBadge) countBadge.textContent = `${activeMembers.length} Members`;

  const canManage = currentUser && (currentUser.role === "admin" || currentUser.role === "manager");
  const activeSessionStr = toLocalISO(sessionDateObj);
  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  if (activeMembers.length === 0) {
    container.innerHTML = '<div style="font-size:12px; color:#64748b; text-align:center; padding:20px;">No matching members found.</div>';
    return;
  }

  // Generate 7 session cards (i = 0 to 6) matching profile card system
  const sessionDates = dates.slice(0, 7);

  container.innerHTML = activeMembers
    .map((member) => {
      const roleClass = (member.role || "user").toLowerCase();
      const defDayActive = !!member.default_day_on;
      const defNightActive = !!member.default_night_on;

      // 7 session cards timeline HTML
      const timelineHTML = sessionDates
        .map((dateSessionStr, idx) => {
          const dateNextStr = dates[idx + 1];

          const dateObj = parseLocalDate(dateSessionStr);
          const dateNextObj = parseLocalDate(dateNextStr);

          const dateNum = dateObj.getDate();
          const dayName = weekDays[dateObj.getDay()];
          const nextDayNum = dateNextObj.getDate();
          const nextDayName = weekDays[dateNextObj.getDay()];

          const sessionLabel = `${dayName} ${dateNum}`;
          const nextDayLabel = `${nextDayName} ${nextDayNum}`;

          const isToday = dateSessionStr === activeSessionStr;

          const pNight = planMap[`${member.id}_${dateSessionStr}`];
          const pDay = planMap[`${member.id}_${dateNextStr}`];

          const nightActive = pNight ? Number(pNight.night_count) > 0 : defNightActive;
          const dayActive = pDay ? Number(pDay.day_count) > 0 : defDayActive;

          const gNight = pNight ? Number(pNight.guest_night_count || 0) : 0;
          const gDay = pDay ? Number(pDay.guest_day_count || 0) : 0;

          const nightBtnClass = `micro-toggle night ${nightActive ? "active" : "off"} ${canManage ? "" : "readonly"}`;
          const dayBtnClass = `micro-toggle day ${dayActive ? "active" : "off"} ${canManage ? "" : "readonly"}`;

          return `
            <div class="timeline-day-card ${isToday ? "today-card" : ""}" style="cursor: pointer;" onclick="openDayScheduleModal(${member.id}, '${escapeJsArg(member.name || '')}', '${dateSessionStr}', '${dateNextStr}', '${sessionLabel}', '${nextDayLabel}', ${nightActive ? 1 : 0}, ${dayActive ? 1 : 0}, ${gNight}, ${gDay}, ${canManage})">
              ${isToday ? '<div class="today-pulse-dot"></div>' : ''}
              <div class="timeline-weekday">${dayName}</div>
              <div class="timeline-date-num">${dateNum}</div>
              
              <div class="day-slot-columns" style="display: flex; gap: 4px; justify-content: center; width: 100%; margin-top: 4px;">
                <!-- Night Column First (Date Session) -->
                <div class="slot-col" style="display: flex; flex-direction: column; align-items: center; gap: 3px; flex: 1;">
                  <div class="${nightBtnClass}" title="Night Meal (${sessionLabel})">🌙</div>
                  <div class="dash-guest-box ${gNight > 0 ? "active" : ""}" id="dash-gnight-box-${member.id}-${dateSessionStr}" title="Night Guests">🌙 ${gNight}</div>
                </div>

                <!-- Day Column Second (Date Next Day) -->
                <div class="slot-col" style="display: flex; flex-direction: column; align-items: center; gap: 3px; flex: 1;">
                  <div class="${dayBtnClass}" title="Day Meal (${nextDayLabel})">☀️</div>
                  <div class="dash-guest-box ${gDay > 0 ? "active" : ""}" id="dash-gday-box-${member.id}-${dateNextStr}" title="Day Guests">☀️ ${gDay}</div>
                </div>
              </div>
            </div>`;
        })
        .join("");

      // Power: all meals running (green) or shut down (red). Staff can switch anyone, members themselves.
      const shutdown = !!member.meal_shutdown_at;
      const canPower = canManage || member.id === currentUser?.member_id;
      const powerBtn = `<button type="button" class="member-power ${shutdown ? "off" : "on"}" ${canPower ? `onclick="event.stopPropagation(); toggleMealPower(${member.id}, ${shutdown})"` : "disabled"}
          title="${shutdown ? "All meals OFF — tap to start" : "Meals running — tap to shut down"}" aria-label="${escapeHtml(member.name)}: ${shutdown ? "meals off, start" : "meals on, shut down"}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/></svg>
          <span>${shutdown ? "Start" : "Shut down"}</span>
        </button>`;
      const defDayOnClick = canManage ? `onclick="toggleDashboardMemberDefault(${member.id}, 'day')"` : "";
      const defNightOnClick = canManage ? `onclick="toggleDashboardMemberDefault(${member.id}, 'night')"` : "";

      return `
        <div class="member-schedule-card">
          <div class="member-card-top" style="align-items: center;">
            <div class="member-info-left">
              <div class="member-name-role">
                <div class="member-card-name" style="font-size: 16px; font-weight: 800; color: #0f172a;">
                  ${escapeHtml(member.name)}
                  <span class="role-pill ${roleClass}">${member.role || "Member"}</span>
                </div>
              </div>
            </div>
            <div class="default-prefs-container" style="display: flex; flex-direction: column; align-items: flex-end; gap: 3px;">
              <div style="font-size: 9px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Default Meals</div>
              <div class="default-prefs-wrap">
                <button class="def-pref-btn day ${defDayActive ? "active" : ""} ${canManage ? "" : "readonly"}" ${defDayOnClick}>
                  ☀️ ${defDayActive ? "ON" : "OFF"}
                </button>
                <button class="def-pref-btn night ${defNightActive ? "active" : ""} ${canManage ? "" : "readonly"}" ${defNightOnClick}>
                  🌙 ${defNightActive ? "ON" : "OFF"}
                </button>
                ${powerBtn}
              </div>
            </div>
          </div>
          <div class="schedule-timeline-strip">
            ${timelineHTML}
          </div>
        </div>`;
    })
    .join("");
}

function filterDashboardMemberSchedules() {
  renderDashboardMemberSchedules();
}

async function toggleDashboardMemberPlan(targetMemberId, planDate, mealType, newValue) {
  if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
    showNotification("Only Admins and Managers can edit member schedules", "error");
    return;
  }

  const targetMember = (allMembers || []).find((m) => m.id === targetMemberId);
  const targetName = targetMember ? targetMember.name : "Member";

  try {
    const planKey = `${targetMemberId}_${planDate}`;
    let existingPlan = cachedDashboardSchedules.planMap ? cachedDashboardSchedules.planMap[planKey] : null;

    const upsertData = {
      member_id: targetMemberId,
      plan_date: planDate,
      day_count: existingPlan ? Number(existingPlan.day_count) : (targetMember?.default_day_on ? 1 : 0),
      night_count: existingPlan ? Number(existingPlan.night_count) : (targetMember?.default_night_on ? 1 : 0),
    };

    if (mealType === "day") upsertData.day_count = newValue;
    else upsertData.night_count = newValue;

    // Optimistic local update
    if (cachedDashboardSchedules.planMap) {
      cachedDashboardSchedules.planMap[planKey] = upsertData;
      renderDashboardMemberSchedules();
    }

    const { error } = await supabase
      .from("meal_plans")
      .upsert(upsertData, { onConflict: "member_id, plan_date" });

    if (error) throw error;

    const actionText = newValue > 0 ? "turned ON" : "turned OFF";
    const mealLabel = mealType === "day" ? "☀️ Day" : "🌙 Night";
    const niceDate = parseLocalDate(planDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

    showNotification(`Updated ${targetName}'s ${mealLabel} for ${niceDate}`, "success");
  } catch (err) {
    console.error("Failed to toggle dashboard meal plan:", err);
    showNotification("Failed to update meal plan", "error");
    loadDashboardMemberSchedules(); // revert on error
  }
}

async function toggleDashboardMemberDefault(targetMemberId, mealType) {
  if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
    showNotification("Only Admins and Managers can edit member defaults", "error");
    return;
  }

  const targetMember = (allMembers || []).find((m) => m.id === targetMemberId);
  if (!targetMember) return;

  let updates = {};
  let newState = false;
  if (mealType === "day") {
    newState = !targetMember.default_day_on;
    updates = { default_day_on: newState };
    targetMember.default_day_on = newState;
  } else {
    newState = !targetMember.default_night_on;
    updates = { default_night_on: newState };
    targetMember.default_night_on = newState;
  }

  try {
    // Optimistic UI update
    renderDashboardMemberSchedules();

    const { error } = await supabase
      .from("members")
      .update(updates)
      .eq("id", targetMemberId);

    if (error) throw error;

    const mealLabel = mealType === "day" ? "☀️ Day" : "🌙 Night";
    const statusText = newState ? "ON" : "OFF";
    showNotification(`Updated ${targetMember.name}'s default ${mealLabel} to ${statusText}`, "success");
  } catch (err) {
    console.error("Failed to update default preference:", err);
    showNotification("Failed to update default preference", "error");
    loadDashboardMemberSchedules();
  }
}

// ============================================
// FLOATING GUEST MEAL CONTROLLER MODAL HANDLERS
// ============================================
let currentGuestModalContext = null;

function openGuestModalForProfile(dateSession, dateNextDay, sessionLabel, nextDayLabel, nGuest, dGuest, isNightLocked, isDayLocked) {
  currentGuestModalContext = {
    source: 'profile',
    memberId: currentUser.member_id,
    dateNight: dateSession,
    dateDay: dateNextDay,
    nightVal: nGuest || 0,
    dayVal: dGuest || 0,
    isNightLocked,
    isDayLocked,
    sessionLabel,
    nextDayLabel,
  };

  document.getElementById("guestModalTitle").textContent = "👥 Guest Meals";
  document.getElementById("guestModalSub").textContent = `${sessionLabel} Bazar Session`;
  document.getElementById("guestModalNightLabel").textContent = `Night (${sessionLabel})`;
  document.getElementById("guestModalDayLabel").textContent = `Day (${nextDayLabel})`;

  document.getElementById("guestModalNightVal").textContent = currentGuestModalContext.nightVal;
  document.getElementById("guestModalDayVal").textContent = currentGuestModalContext.dayVal;

  document.getElementById("guestModalNightMinus").disabled = isNightLocked;
  document.getElementById("guestModalNightPlus").disabled = isNightLocked;
  document.getElementById("guestModalDayMinus").disabled = isDayLocked;
  document.getElementById("guestModalDayPlus").disabled = isDayLocked;

  document.getElementById("guestMealModal").classList.add("active");
}

function openGuestModalForDashboard(memberId, memberName, dateStr, dateLabel, nGuest, dGuest, canManage) {
  const dateObj = parseLocalDate(dateStr);
  const nextDObj = new Date(dateObj);
  nextDObj.setDate(dateObj.getDate() + 1);
  const dateNextStr = toLocalISO(nextDObj);

  const fmt = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const nightLabelStr = fmt(dateObj);
  const dayLabelStr = fmt(nextDObj);

  currentGuestModalContext = {
    source: 'dashboard',
    memberId,
    memberName,
    dateNight: dateStr,
    dateDay: dateNextStr,
    nightVal: nGuest || 0,
    dayVal: dGuest || 0,
    canManage,
    dateLabel,
  };

  document.getElementById("guestModalTitle").textContent = `👥 ${memberName}'s Guest Meals`;
  document.getElementById("guestModalSub").textContent = `${dateLabel} Bazar Session`;
  document.getElementById("guestModalNightLabel").textContent = `Night (${nightLabelStr})`;
  document.getElementById("guestModalDayLabel").textContent = `Day (${dayLabelStr})`;

  document.getElementById("guestModalNightVal").textContent = currentGuestModalContext.nightVal;
  document.getElementById("guestModalDayVal").textContent = currentGuestModalContext.dayVal;

  const isReadonly = !canManage;
  document.getElementById("guestModalNightMinus").disabled = isReadonly;
  document.getElementById("guestModalNightPlus").disabled = isReadonly;
  document.getElementById("guestModalDayMinus").disabled = isReadonly;
  document.getElementById("guestModalDayPlus").disabled = isReadonly;

  document.getElementById("guestMealModal").classList.add("active");
}

function closeGuestModal() {
  const modal = document.getElementById("guestMealModal");
  if (modal) modal.classList.remove("active");
  currentGuestModalContext = null;
}

async function stepGuestModal(slotType, delta) {
  if (!currentGuestModalContext) return;
  const ctx = currentGuestModalContext;

  if (ctx.source === 'profile') {
    const targetDate = slotType === 'night' ? ctx.dateNight : ctx.dateDay;
    const btn = document.getElementById(slotType === 'night' ? "guestModalNightPlus" : "guestModalDayPlus");

    await updateGuestPlan(targetDate, slotType, delta, btn, ctx.dateNight);

    if (slotType === 'night') {
      ctx.nightVal = Math.max(0, ctx.nightVal + delta);
      document.getElementById("guestModalNightVal").textContent = ctx.nightVal;
    } else {
      ctx.dayVal = Math.max(0, ctx.dayVal + delta);
      document.getElementById("guestModalDayVal").textContent = ctx.dayVal;
    }
  } else if (ctx.source === 'dashboard') {
    if (!ctx.canManage) {
      showNotification("Only Admins and Managers can edit member guest meals", "error");
      return;
    }

    await updateDashGuestPlanDetailed(ctx.memberId, ctx.dateNight, slotType, delta);

    if (slotType === 'night') {
      ctx.nightVal = Math.max(0, ctx.nightVal + delta);
      document.getElementById("guestModalNightVal").textContent = ctx.nightVal;
    } else {
      ctx.dayVal = Math.max(0, ctx.dayVal + delta);
      document.getElementById("guestModalDayVal").textContent = ctx.dayVal;
    }
  }
}

// ============================================
// DAY SCHEDULE & GUEST MODAL (Dashboard Protection)
// ============================================
let currentDayModalContext = null;

function openDayScheduleModal(memberId, memberName, dateNight, dateDay, sessionLabel, nextDayLabel, nightActive, dayActive, gNight, gDay, canManage) {
  currentDayModalContext = {
    memberId,
    memberName,
    dateNight,
    dateDay,
    sessionLabel,
    nextDayLabel,
    nightActive: !!nightActive,
    dayActive: !!dayActive,
    gNight: gNight || 0,
    gDay: gDay || 0,
    canManage: !!canManage,
  };

  document.getElementById("dayModalTitle").textContent = `📅 ${memberName}'s Schedule`;
  document.getElementById("dayModalSub").textContent = `${sessionLabel} Bazar Session`;
  document.getElementById("dayModalNightGuestLabel").textContent = `Night (${sessionLabel})`;
  document.getElementById("dayModalDayGuestLabel").textContent = `Day (${nextDayLabel})`;

  updateDayModalUI();

  document.getElementById("dayScheduleModal").classList.add("active");
}

function updateDayModalUI() {
  if (!currentDayModalContext) return;
  const ctx = currentDayModalContext;

  const dayBtn = document.getElementById("dayModalDayBtn");
  const nightBtn = document.getElementById("dayModalNightBtn");

  if (dayBtn) {
    dayBtn.textContent = `☀️ Day: ${ctx.dayActive ? "ON" : "OFF"}`;
    if (ctx.dayActive) {
      dayBtn.classList.add("active");
    } else {
      dayBtn.classList.remove("active");
    }
    dayBtn.disabled = !ctx.canManage;
  }

  if (nightBtn) {
    nightBtn.textContent = `🌙 Night: ${ctx.nightActive ? "ON" : "OFF"}`;
    if (ctx.nightActive) {
      nightBtn.classList.add("active");
    } else {
      nightBtn.classList.remove("active");
    }
    nightBtn.disabled = !ctx.canManage;
  }

  document.getElementById("dayModalDayGuestVal").textContent = ctx.gDay;
  document.getElementById("dayModalNightGuestVal").textContent = ctx.gNight;

  const isReadonly = !ctx.canManage;
  document.getElementById("dayModalDayGuestMinus").disabled = isReadonly;
  document.getElementById("dayModalDayGuestPlus").disabled = isReadonly;
  document.getElementById("dayModalNightGuestMinus").disabled = isReadonly;
  document.getElementById("dayModalNightGuestPlus").disabled = isReadonly;
}

function closeDayScheduleModal() {
  const modal = document.getElementById("dayScheduleModal");
  if (modal) modal.classList.remove("active");
  currentDayModalContext = null;
}

async function toggleDayModalPersonal(mealType) {
  if (!currentDayModalContext) return;
  const ctx = currentDayModalContext;

  if (!ctx.canManage) {
    showNotification("Only Admins and Managers can edit member schedules", "error");
    return;
  }

  const isDay = mealType === "day";
  const newValue = isDay ? (ctx.dayActive ? 0 : 1) : (ctx.nightActive ? 0 : 1);
  const planDate = isDay ? ctx.dateDay : ctx.dateNight;

  if (isDay) ctx.dayActive = !ctx.dayActive;
  else ctx.nightActive = !ctx.nightActive;

  updateDayModalUI();

  await toggleDashboardMemberPlan(ctx.memberId, planDate, mealType, newValue);
}

async function stepDayModalGuest(slotType, delta) {
  if (!currentDayModalContext) return;
  const ctx = currentDayModalContext;

  if (!ctx.canManage) {
    showNotification("Only Admins and Managers can edit member guest meals", "error");
    return;
  }

  const targetDate = slotType === "day" ? ctx.dateDay : ctx.dateNight;

  if (slotType === "day") {
    ctx.gDay = Math.max(0, ctx.gDay + delta);
  } else {
    ctx.gNight = Math.max(0, ctx.gNight + delta);
  }

  updateDayModalUI();

  await updateDashGuestPlanDetailed(ctx.memberId, targetDate, slotType, delta);
}

async function updateDashGuestPlanDetailed(targetMemberId, planDate, slotType, delta) {
  if (!currentUser || (currentUser.role !== "admin" && currentUser.role !== "manager")) {
    showNotification("Only Admins and Managers can edit member guest meals", "error");
    return;
  }

  const targetMember = (allMembers || []).find((m) => m.id === targetMemberId);
  const targetName = targetMember ? targetMember.name : "Member";

  try {
    const planKey = `${targetMemberId}_${planDate}`;
    let existingPlan = cachedDashboardSchedules.planMap ? cachedDashboardSchedules.planMap[planKey] : null;

    let currentNight = existingPlan ? Number(existingPlan.guest_night_count || 0) : 0;
    let currentDay = existingPlan ? Number(existingPlan.guest_day_count || 0) : 0;

    if (slotType === "night") {
      currentNight = Math.max(0, currentNight + delta);
    } else {
      currentDay = Math.max(0, currentDay + delta);
    }

    const upsertData = {
      member_id: targetMemberId,
      plan_date: planDate,
      day_count: existingPlan ? Number(existingPlan.day_count) : (targetMember?.default_day_on ? 1 : 0),
      night_count: existingPlan ? Number(existingPlan.night_count) : (targetMember?.default_night_on ? 1 : 0),
      guest_night_count: currentNight,
      guest_day_count: currentDay,
    };

    // Optimistic local cache update
    if (cachedDashboardSchedules.planMap) {
      cachedDashboardSchedules.planMap[planKey] = upsertData;
    }

    // Optimistic DOM update for Day and Night boxes
    const dayBox = document.getElementById(`dash-gday-box-${targetMemberId}-${planDate}`);
    const nightBox = document.getElementById(`dash-gnight-box-${targetMemberId}-${planDate}`);

    if (dayBox) {
      dayBox.textContent = `☀️ ${currentDay}`;
      if (currentDay > 0) dayBox.classList.add("active");
      else dayBox.classList.remove("active");
    }
    if (nightBox) {
      nightBox.textContent = `🌙 ${currentNight}`;
      if (currentNight > 0) nightBox.classList.add("active");
      else nightBox.classList.remove("active");
    }

    // Optimistic DOM update
    const total = currentNight + currentDay;
    const nightEl = document.getElementById(`dash-gnight-${targetMemberId}-${planDate}`);
    const dayEl = document.getElementById(`dash-gday-${targetMemberId}-${planDate}`);
    const totalEl = document.getElementById(`dash-guest-total-${targetMemberId}-${planDate}`);
    const badgeBtn = totalEl?.closest(".dash-guest-badge");

    if (nightEl) nightEl.textContent = currentNight;
    if (dayEl) dayEl.textContent = currentDay;
    if (totalEl) totalEl.textContent = total;
    if (badgeBtn) {
      if (total > 0) badgeBtn.classList.add("active");
      else badgeBtn.classList.remove("active");
    }

    const { error } = await supabase
      .from("meal_plans")
      .upsert(upsertData, { onConflict: "member_id, plan_date" });

    if (error) throw error;

    const niceDate = parseLocalDate(planDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const slotLabel = slotType === "night" ? "Night" : "Day";
    const newCount = slotType === "night" ? currentNight : currentDay;
    showNotification(`👥 Set ${targetName}'s guest ${slotLabel} meals to ${newCount} for ${niceDate}`, "success");

    // Specific notification activity log
    if (currentCycleId) {
      const actorName = currentUser.name || "Admin/Manager";
      await logActivity(
        `${actorName} updated ${targetName}'s guest ${slotLabel} meals to ${newCount} (Total: ${total}) for ${niceDate}`,
        "meal"
      );
    }

    // Refresh dashboard pulse counts
    pageLoaded.dashboard = false;
    if (!document.getElementById("dashboardPage").classList.contains("hidden")) {
      loadDashboard();
    }
  } catch (err) {
    console.error("Failed to update dashboard guest plan:", err);
    showNotification("Failed to update guest meals", "error");
    loadDashboardMemberSchedules();
  }
}

// Fallback compatibility alias for loadRecentActivity
async function loadRecentActivity() {
  loadDashboardMemberSchedules();
}
