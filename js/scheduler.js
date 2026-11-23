// MealCal Pro — Profile page 7-day meal scheduler
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

async function loadScheduler() {
  if (!currentUser.member_id || !currentCycleId) return;

  const container = document.getElementById("schedulerList");

  try {
    // 1. ASYNC CHECK: Ask DB "What is the active session?"
    const sessionDateObj = await getActiveSessionDate();
    const currentSessionStr = toLocalISO(sessionDateObj); // YYYY-MM-DD

    // 2. STALENESS CHECK: Did the session change since we last drew the cards?
    if (
      lastRenderedSessionDate &&
      lastRenderedSessionDate !== currentSessionStr
    ) {
      dlog(
        `🔄 Session Shift Detected (Log Found). Rolling cards to ${currentSessionStr}...`,
      );

      // A. Update Tracker
      lastRenderedSessionDate = currentSessionStr;

      // B. Force DB to generate the new 7th card immediately
      await supabase.rpc("manage_meal_plans", {
        target_date: currentSessionStr,
      });

      // C. Invalidate Cache to force redraw
      pageLoaded.profile = false;
      if (container)
        container.innerHTML =
          '<div class="loading">Refreshing session...</div>';
    }

    // 3. CACHE CHECK (Standard)
    if (container.querySelector(".scheduler-card") && pageLoaded.profile) {
      return;
    }

    if (!container.innerHTML.includes("scheduler-card")) {
      container.innerHTML =
        '<div class="loading">Syncing your schedule...</div>';
    }

    // 4. FETCH DATA & RENDER (Standard Logic)
    const { data: memberData } = await supabase
      .from("members")
      .select("default_day_on, default_night_on")
      .eq("id", currentUser.member_id)
      .maybeSingle();

    if (memberData) updateDefaultButtons(memberData);

    // Generate 8 Days (Last session + 7 Upcoming)
    const dates = [];
    for (let i = -1; i <= 8; i++) {
      const d = new Date(sessionDateObj);
      d.setDate(sessionDateObj.getDate() + i);
      dates.push(toLocalISO(d));
    }

    const { data: plans } = await supabase
      .from("meal_plans")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .in("plan_date", dates);

    const planMap = {};
    plans?.forEach((p) => (planMap[p.plan_date] = p));

    let newHTML = "";
    const fmt = (dStr) => {
      const d = parseLocalDate(dStr);
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    };

    for (let i = -1; i < 7; i++) {
      // Map i (-1 to 6) to the array indices bounds (0 to 8)
      const arrayIndex = i + 1;
      const dateSession = dates[arrayIndex];
      const dateNextDay = dates[arrayIndex + 1];

      const sessionLabel = fmt(dateSession);
      const nextDayLabel = fmt(dateNextDay);

      const isFirstCard = i === 0;
      const isPastCard = i === -1;

      const nPlan = planMap[dateSession];
      const dPlan = planMap[dateNextDay];

      const nightActive = nPlan ? nPlan.night_count > 0 : false;
      const dayActive = dPlan ? dPlan.day_count > 0 : false;
      const nGuestCount = nPlan ? (parseFloat(nPlan.guest_night_count) || 0) : 0;
      const dGuestCount = dPlan ? (parseFloat(dPlan.guest_day_count) || 0) : 0;

      // Lock Logic (Visual Only - Security is in toggle function)
      const userRole = currentUser?.role;
      const isAdmin = userRole === "admin" || userRole === "manager";
      
      let isNightLocked = !isAdmin && isMealLocked(dateSession, "night");
      let isDayLocked = !isAdmin && isMealLocked(dateNextDay, "day");
      
      if (isPastCard) {
          isNightLocked = true;
          isDayLocked = true;
      }
      
      const lockIcon = `<span style="font-size:10px; margin-left:4px;">🔒</span>`;

      const cardOpacityStyle = isPastCard ? 'style="opacity: 0.6; pointer-events: none; filter: grayscale(1); border-left: 3px solid #6b7280;"' : '';
      const subLabelText = isPastCard ? "LAST SESSION" : (isFirstCard ? "ACTIVE SESSION" : "UPCOMING");

      const totalGuestCount = nGuestCount + dGuestCount;

      newHTML += `
            <div class="scheduler-card ${isFirstCard ? "is-today" : ""}" ${cardOpacityStyle}>
                <div class="sched-date-main">${sessionLabel} Bazar</div>
                <div class="sched-sub-label">${subLabelText}</div>
                
                <div class="sched-actions">
                    <button class="sched-btn night-btn ${nightActive ? "active" : ""}" 
                        ${isPastCard ? "" : `onclick="toggleSchedulerPlan('${dateSession}', 'night', this)"`}
                        style="${isNightLocked ? "opacity: 0.6;" : ""}">
                        <span class="status-text">${nightActive ? "ON" : "OFF"}</span>
                        <span class="btn-label"> Night <span class="btn-date-micro">${sessionLabel}</span> ${isNightLocked ? lockIcon : ""}</span>
                    </button>
                    
                    <button class="sched-btn day-btn ${dayActive ? "active" : ""}" 
                        ${isPastCard ? "" : `onclick="toggleSchedulerPlan('${dateNextDay}', 'day', this)"`}
                        style="${isDayLocked ? "opacity: 0.6;" : ""}">
                        <span class="status-text">${dayActive ? "ON" : "OFF"}</span>
                        <span class="btn-label"> Day <span class="btn-date-micro">${nextDayLabel}</span> ${isDayLocked ? lockIcon : ""}</span>
                    </button>
                </div>

                <div class="guest-card-wrapper">
                  <button class="guest-compact-badge ${totalGuestCount > 0 ? 'active' : ''}" onclick="openGuestModalForProfile('${dateSession}', '${dateNextDay}', '${sessionLabel}', '${nextDayLabel}', ${nGuestCount}, ${dGuestCount}, ${isPastCard || isNightLocked}, ${isPastCard || isDayLocked})">
                    <span>👥 Guest Meals: <strong id="guest-total-val-${dateSession}">${totalGuestCount}</strong></span>
                    <span style="font-size: 11px;">✏️</span>
                  </button>
                </div>
            </div>`;
    }

    container.innerHTML = newHTML;

    // Save state
    lastRenderedSessionDate = currentSessionStr;
    pageLoaded.profile = true;
  } catch (err) {
    console.error("Scheduler Error:", err);
  }
}

// Function triggered by clicking scheduler buttons (Optimistic UI Version)
async function toggleSchedulerPlan(date, type, btnElement) {
  // 1. Security Check
  const userRole = currentUser?.role;
  const isAdmin = userRole === "admin" || userRole === "manager";

  if (!isAdmin && isMealLocked(date, type)) {
    btnElement.style.animation = "shake 0.4s ease";
    setTimeout(() => (btnElement.style.animation = ""), 400);
    showNotification(
      `⛔ Locked until ${convertTo12Hour(appConfig.lock_time_end)}`,
      "error",
    );
    return;
  }

  // 2. Prevent Double Clicks
  if (btnElement.dataset.locking === "true") return;
  btnElement.dataset.locking = "true";

  // 3. OPTIMISTIC UPDATE (Instant Visual Change)
  const statusLabel = btnElement.querySelector(".status-text");
  const wasActive = btnElement.classList.contains("active");

  // Toggle visual state immediately
  if (wasActive) {
    btnElement.classList.remove("active");
    if (statusLabel) statusLabel.textContent = "OFF";
  } else {
    btnElement.classList.add("active");
    if (statusLabel) statusLabel.textContent = "ON";
  }

  try {
    // 4. DATABASE UPDATE
    const newCount = wasActive ? 0 : 1;

    // Get existing row ID first to avoid constraint errors if needed, or just upsert by key
    const { data: existing } = await supabase
      .from("meal_plans")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .eq("plan_date", date)
      .maybeSingle();

    const upsertData = {
      member_id: currentUser.member_id,
      plan_date: date,
      day_count: existing ? existing.day_count : 0,
      night_count: existing ? existing.night_count : 0,
    };

    if (type === "day") upsertData.day_count = newCount;
    else upsertData.night_count = newCount;

    const { error } = await supabase
      .from("meal_plans")
      .upsert(upsertData, { onConflict: "member_id, plan_date" });

    if (error) throw error;

    // 5. CONDITIONAL LOGGING (Only log if it's the "Active Session" card)
    const activeSessionStr = getStrictSessionDate();
    const activeDateObj = parseLocalDate(activeSessionStr);
    activeDateObj.setDate(activeDateObj.getDate() + 1);
    const activeNextDayStr = toLocalISO(activeDateObj);

    let isActiveCard = false;
    if (type === "night" && date === activeSessionStr) isActiveCard = true;
    else if (type === "day" && date === activeNextDayStr) isActiveCard = true;

    if (isActiveCard) {
      const actorName = currentUser.name || "User";
      const actionText = newCount > 0 ? "turned ON" : "turned OFF";
      const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
      const dateObj = new Date(date);
      const niceDate = dateObj.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      });

      // Log silently
      logActivity(
        `${actorName} ${actionText} their ${niceDate} ${typeLabel} meal`,
        "meal",
      );
    }

    // Update Dashboard Stats immediately if on Dashboard
    if (
      !document.getElementById("dashboardPage").classList.contains("hidden")
    ) {
      updateDashboardMealPlan();
    }
  } catch (err) {
    console.error("Plan update failed", err);
    showNotification("Failed to save plan. Reverting...", "error");

    // 6. ROLLBACK ON ERROR
    if (wasActive) {
      btnElement.classList.add("active");
      if (statusLabel) statusLabel.textContent = "ON";
    } else {
      btnElement.classList.remove("active");
      if (statusLabel) statusLabel.textContent = "OFF";
    }
  } finally {
    // Unlock
    btnElement.dataset.locking = "false";
  }
}

function toggleGuestPanel(dateStr) {
  const panel = document.getElementById(`guest-panel-${dateStr}`);
  const chevron = document.getElementById(`guest-chevron-${dateStr}`);
  if (panel) {
    const isHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (chevron) {
      chevron.textContent = isHidden ? "▲" : "▼";
    }
  }
}

// Function to update Guest Meal schedule counts with steppers
async function updateGuestPlan(date, type, delta, btnElement, sessionDateKey) {
  const userRole = currentUser?.role;
  const isAdmin = userRole === "admin" || userRole === "manager";

  if (!isAdmin && isMealLocked(date, type)) {
    if (btnElement) {
      btnElement.style.animation = "shake 0.4s ease";
      setTimeout(() => (btnElement.style.animation = ""), 400);
    }
    showNotification(
      `⛔ Locked until ${convertTo12Hour(appConfig.lock_time_end)}`,
      "error"
    );
    return;
  }

  if (btnElement && btnElement.dataset.locking === "true") return;
  if (btnElement) btnElement.dataset.locking = "true";

  try {
    const { data: existing } = await supabase
      .from("meal_plans")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .eq("plan_date", date)
      .maybeSingle();

    const currentVal = type === "day"
      ? parseFloat(existing?.guest_day_count || 0)
      : parseFloat(existing?.guest_night_count || 0);

    const newCount = Math.max(0, currentVal + delta);
    if (newCount === currentVal) {
      if (btnElement) btnElement.dataset.locking = "false";
      return;
    }

    // Optimistic UI update
    const countEl = document.getElementById(`guest-count-${date}-${type}`);
    if (countEl) countEl.textContent = newCount;

    // Update Card Total Badge live
    if (sessionDateKey) {
      const sDateObj = parseLocalDate(sessionDateKey);
      const nextDObj = new Date(sDateObj);
      nextDObj.setDate(sDateObj.getDate() + 1);
      const nextDKey = toLocalISO(nextDObj);

      const nVal = parseFloat(document.getElementById(`guest-count-${sessionDateKey}-night`)?.textContent || 0);
      const dVal = parseFloat(document.getElementById(`guest-count-${nextDKey}-day`)?.textContent || 0);
      const tot = nVal + dVal;
      const totalBadge = document.getElementById(`guest-total-val-${sessionDateKey}`);
      const badgeBtn = totalBadge?.closest('.guest-compact-badge');
      if (totalBadge) totalBadge.textContent = tot;
      if (badgeBtn) {
        if (tot > 0) badgeBtn.classList.add('active');
        else badgeBtn.classList.remove('active');
      }
    }

    const upsertData = {
      member_id: currentUser.member_id,
      plan_date: date,
      day_count: existing ? existing.day_count : 0,
      night_count: existing ? existing.night_count : 0,
      guest_day_count: existing ? (existing.guest_day_count || 0) : 0,
      guest_night_count: existing ? (existing.guest_night_count || 0) : 0,
    };

    if (type === "day") upsertData.guest_day_count = newCount;
    else upsertData.guest_night_count = newCount;

    const { error } = await supabase
      .from("meal_plans")
      .upsert(upsertData, { onConflict: "member_id, plan_date" });

    if (error) throw error;

    // Detailed & Specific Notification Logging
    const actorName = currentUser.name || "User";
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const dateObj = parseLocalDate(date);
    const niceDate = dateObj.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });

    const notifMsg = `${actorName} updated guest ${typeLabel} meals to ${newCount} for ${niceDate}`;
    showNotification(`👥 ${newCount} Guest ${typeLabel} meal(s) set for ${niceDate}`, "success");
    logActivity(notifMsg, "meal");

    pageLoaded.dashboard = false;
    if (!document.getElementById("dashboardPage").classList.contains("hidden")) {
      loadDashboard();
    }
  } catch (err) {
    console.error("Guest Plan Error:", err);
    showNotification(err.message || "Failed to update guest meals", "error");
    pageLoaded.profile = false;
    loadScheduler();
  } finally {
    if (btnElement) btnElement.dataset.locking = "false";
  }
}
