// MealCal Pro — Master tracker, member calendar, meal edit modal, weekly menu
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// --- Update loadMasterTracker ---
async function loadMasterTracker() {
  if (!currentCycleId) return;

  const table = document.getElementById("masterMatrixTable");
  if (!table) return;

  try {
    const cycle = allCycles.find((c) => c.id == currentCycleId);
    const { data: meals } = await supabase
      .from("meals")
      .select("*")
      .eq("cycle_id", currentCycleId);

    const matrixData = {};
    meals?.forEach((m) => {
      if (!matrixData[m.meal_date]) matrixData[m.meal_date] = {};
      matrixData[m.meal_date][m.member_id] = {
        d: m.day_count,
        n: m.night_count,
        gd: m.guest_day_count || 0,
        gn: m.guest_night_count || 0,
      };
    });

    // Fetch boundary day meals (next cycle's first date) for the last row's Day column
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    boundaryMeals.forEach((m) => {
      if (!matrixData[m.meal_date]) matrixData[m.meal_date] = {};
      matrixData[m.meal_date][m.member_id] = {
        d: m.day_count,
        n: matrixData[m.meal_date]?.[m.member_id]?.n || 0,
        gd: m.guest_day_count || 0,
        gn: matrixData[m.meal_date]?.[m.member_id]?.gn || 0,
      };
    });

    let currentIter = parseLocalDate(cycle.start_date);
    let endIter = parseLocalDate(cycle.end_date);
    
    // --- THE CRITICAL FIX ---
    // 1. Get the actual Active Bazar Session Date (This accounts for whether auto-entry has run)
    const activeSessionDateObj = await getActiveSessionDate();
    const activeSessionStr = toLocalISO(activeSessionDateObj);

    const activeMembers = allMembers.filter(m => !m.archived_from_cycle_id || parseInt(currentCycleId) < m.archived_from_cycle_id);

    let headerHTML = `
            <thead>
                <tr>
                    <th style="vertical-align: bottom; padding: 0;">
                        <div style="padding: 12px 8px 6px;">BAZAR</div>
                    </th>
                    ${activeMembers.map((m) => `
                    <th style="padding: 0; vertical-align: bottom;">
                        <div style="padding: 12px 8px 6px;">${escapeHtml(m.name.split(" ")[0])}</div>
                        <div style="display: flex; width: 100%; border-top: 1px dashed rgba(0,0,0,0.1); background: rgba(0,0,0,0.02);">
                
                        </div>
                    </th>`).join("")}
                </tr>
            </thead>`;

    // 2. Generate Body Rows
    let bodyHTML = "<tbody>";
    while (currentIter.getTime() <= endIter.getTime()) {
      const dateSessionStr = toLocalISO(currentIter);
      const dNext = new Date(currentIter);
      dNext.setDate(currentIter.getDate() + 1);
      const dateNextStr = toLocalISO(dNext);

      // --- UNIFIED PENDING CHECK ---
      // Both Night and Day meals of this row belong to the same "Bazar Session".
      // If this Bazar Session is >= the Active Session, it means auto-entry hasn't finalized it.
      const isPendingSession = dateSessionStr >= activeSessionStr;

      const displayDate = currentIter.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
      });
      
      // Highlight the currently active pending row
      const isTodayRow = dateSessionStr === activeSessionStr;

      bodyHTML += `<tr ${isTodayRow ? 'style="background: #f0f9ff;"' : ""}>
                <td>${displayDate}</td>
                ${activeMembers
                  .map((m) => {
                    const nVal = matrixData[dateSessionStr]?.[m.id]?.n || 0;
                    const dVal = matrixData[dateNextStr]?.[m.id]?.d || 0;
                    const gnVal = matrixData[dateSessionStr]?.[m.id]?.gn || 0;
                    const gdVal = matrixData[dateNextStr]?.[m.id]?.gd || 0;
                    
                    // Both share the exact same logic based on isPendingSession. No split logic.
                    const nDisplay = (nVal > 0 || gnVal > 0) ? (gnVal > 0 ? `${nVal}+${gnVal}` : nVal) : (isPendingSession ? "-" : "0");
                    const dDisplay = (dVal > 0 || gdVal > 0) ? (gdVal > 0 ? `${dVal}+${gdVal}` : dVal) : (isPendingSession ? "-" : "0");
                    
                    return `
                        <td>
                            <div class="cell-split-premium" onclick="openMealModal('${m.id}', '${dateSessionStr}', ${nVal}, ${dVal}, ${gnVal}, ${gdVal})">
                                <div class="cell-val-half night ${nVal > 0 || gnVal > 0 ? "active" : "zero"}">${nDisplay}</div>
                                <div class="cell-val-half day ${dVal > 0 || gdVal > 0 ? "active" : "zero"}">${dDisplay}</div>
                            </div>
                        </td>`;
                  })
                  .join("")}
            </tr>`;

      currentIter.setDate(currentIter.getDate() + 1);
    }
    bodyHTML += "</tbody>";

    // 3. Update Table
    table.innerHTML = headerHTML + bodyHTML;
    pageLoaded.tracker = true;
  } catch (err) {
    console.error("Tracker Sync Error:", err);
  }
}

// --- Update loadWeeklyMenuEditor ---
async function loadWeeklyMenuEditor() {
  const tbody = document.getElementById("weeklyMenuBody");
  const isAdmin =
    currentUser.role === "admin" || currentUser.role === "manager";

  try {
    const { data, error } = await supabase
      .from("weekly_menus")
      .select("*")
      .order("day_index", { ascending: true });
    if (error) throw error;

    const order = [6, 0, 1, 2, 3, 4, 5];
    const sortedData = order.map((idx) =>
      data.find((d) => d.day_index === idx),
    );

    tbody.innerHTML = sortedData
      .map(
        (day) => `
            <tr>
                <td class="menu-day-label">${day.day_name}</td>
                <td style="padding-right: 5px;">
                    <input type="text" id="night-${day.day_index}" class="menu-input-pill" 
                        value="${escapeHtml(day.night_menu || "")}" ${!isAdmin ? "disabled" : ""} 
                        onchange="saveDayMenu(${day.day_index})" placeholder="Night...">
                </td>
                <td>
                    <input type="text" id="day-${day.day_index}" class="menu-input-pill" 
                        value="${escapeHtml(day.day_menu || "")}" ${!isAdmin ? "disabled" : ""} 
                        onchange="saveDayMenu(${day.day_index})" placeholder="Day...">
                </td>
            </tr>
        `,
      )
      .join("");
  } catch (err) {
    console.error(err);
  }
}

// ============================================
// TRACKER PAGE
// ============================================

function loadTracker() {
  // The old dropdown logic is gone.
  // We simply load the master matrix now.
  loadMasterTracker();
}

async function loadMemberCalendar(memberId) {
  if (!currentCycleId) return;

  try {
    const cycle = allCycles.find((c) => c.id === currentCycleId);
    if (!cycle) return;

    const startDate = new Date(cycle.start_date);
    const endDate = new Date(cycle.end_date);

    // Fetch meals for this member and cycle
    const { data: meals } = await supabase
      .from("meals")
      .select("*")
      .eq("cycle_id", currentCycleId)
      .eq("member_id", memberId);

    const mealMap = {};
    meals?.forEach((meal) => {
      mealMap[meal.meal_date] = meal;
    });

    const calendarGrid = document.getElementById("calendarGrid");
    calendarGrid.innerHTML = "";

    // Generate calendar days
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      const dateStr = toLocalISO(d);
      const meal = mealMap[dateStr];
      const totalMeals = meal
        ? parseFloat(meal.day_count) + parseFloat(meal.night_count)
        : 0;

      const todayStr = toLocalISO(new Date());
      const isFuture = dateStr > todayStr;
      const displayMeals = totalMeals > 0 ? totalMeals.toFixed(1) : (isFuture ? "-" : "0");

      const dayDiv = document.createElement("div");
      dayDiv.className = "calendar-day" + (totalMeals > 0 ? " has-meal" : "");
      dayDiv.innerHTML = `
                    <div class="calendar-day-number">${d.getDate()}</div>
                    <div class="calendar-day-meals">${displayMeals}</div>
                `;

      // Only managers and admins can edit
      if (currentUser.role === "admin" || currentUser.role === "manager") {
        dayDiv.addEventListener("click", () => {
          openMealModal(memberId, dateStr, meal);
        });
      }

      calendarGrid.appendChild(dayDiv);
    }
  } catch (err) {
    console.error("Error loading calendar:", err);
  }
}

function openMealModal(memberId, sessionDate, currentNightVal, nextDayVal, guestNightVal = 0, guestDayVal = 0) {
  const dSession = new Date(sessionDate);
  const dNext = new Date(dSession);
  dNext.setDate(dSession.getDate() + 1);
  const nextDateStr = toLocalISO(dNext);

  const fmt = (d) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const member = allMembers.find((m) => m.id == memberId);

  // Set Hidden Fields
  document.getElementById("mealMemberId").value = memberId;
  document.getElementById("mealDateSession").value = sessionDate;
  document.getElementById("mealDateNext").value = nextDateStr;

  // Set Values
  document.getElementById("mealNightCount").value = currentNightVal || 0;
  document.getElementById("mealDayCount").value = nextDayVal || 0;
  const guestNightInput = document.getElementById("mealGuestNightCount");
  const guestDayInput = document.getElementById("mealGuestDayCount");
  if (guestNightInput) guestNightInput.value = guestNightVal || 0;
  if (guestDayInput) guestDayInput.value = guestDayVal || 0;

  // PERMISSION CHECK
  const isAdminOrManager =
    currentUser.role === "admin" || currentUser.role === "manager";
  const saveBtn = document.querySelector('#mealForm button[type="submit"]');
  const nightInput = document.getElementById("mealNightCount");
  const dayInput = document.getElementById("mealDayCount");
  const modalTitle = document.getElementById("mealModalTitle");

  if (!isAdminOrManager) {
    // Mode: View Only
    if (saveBtn) { saveBtn.classList.add("hidden"); saveBtn.style.display = "none"; }
    if (nightInput) nightInput.disabled = true;
    if (dayInput) dayInput.disabled = true;
    if (guestNightInput) guestNightInput.disabled = true;
    if (guestDayInput) guestDayInput.disabled = true;
    modalTitle.innerHTML = `<div style="color:var(--text-secondary); font-size:14px;">View Session: ${escapeHtml(member?.name)}</div>
                               <div style="font-size:11px; color:var(--danger-color); font-weight:700;">READ ONLY MODE</div>`;
  } else {
    // Mode: Edit
    if (saveBtn) { saveBtn.classList.remove("hidden"); saveBtn.style.display = "block"; }
    if (nightInput) nightInput.disabled = false;
    if (dayInput) dayInput.disabled = false;
    if (guestNightInput) guestNightInput.disabled = false;
    if (guestDayInput) guestDayInput.disabled = false;
    modalTitle.innerHTML = `<div style="color:var(--primary-color); font-size:16px;">Edit Session: ${escapeHtml(member?.name)}</div>
                               <div style="font-size:11px;">Bazar Date: ${fmt(dSession)}</div>`;
  }

  document.getElementById("mealNightLabel").innerHTML =
    `Night (${fmt(dSession)})`;
  document.getElementById("mealDayLabel").innerHTML = `Day (${fmt(dNext)})`;

  document.getElementById("mealModal").classList.add("active");
}

function closeMealModal() {
  document.getElementById("mealModal").classList.remove("active");
}

// ==========================================
// UPDATED MEAL FORM HANDLER (FIXED NOTIFICATION & GUEST MEALS)
// ==========================================
document.getElementById("mealForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const originalText = btn.textContent;

  const memberId = parseInt(document.getElementById("mealMemberId").value);
  const sessionDate = document.getElementById("mealDateSession").value;
  const nextDate = document.getElementById("mealDateNext").value;
  const nightVal =
    Math.round(parseFloat(document.getElementById("mealNightCount").value)) ||
    0;
  const dayVal =
    Math.round(parseFloat(document.getElementById("mealDayCount").value)) || 0;
  const guestNightVal =
    Math.round(parseFloat(document.getElementById("mealGuestNightCount")?.value || 0)) || 0;
  const guestDayVal =
    Math.round(parseFloat(document.getElementById("mealGuestDayCount")?.value || 0)) || 0;

  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const { data: existingRows } = await supabase
      .from("meals")
      .select("*")
      .eq("member_id", memberId)
      .in("meal_date", [sessionDate, nextDate]);
    const findRow = (d) => existingRows?.find((r) => r.meal_date === d);
    const rowSession = findRow(sessionDate);
    const rowNext = findRow(nextDate);

    // Determine correct cycle_id for the next-day record (handles cross-cycle boundary)
    const cycle = allCycles.find(c => c.id == currentCycleId);
    const nextDayCycleId = (cycle && nextDate > cycle.end_date)
      ? (rowNext?.cycle_id || allCycles.find(c => c.start_date <= nextDate && c.end_date >= nextDate)?.id || currentCycleId)
      : currentCycleId;

    const upserts = [
      {
        cycle_id: currentCycleId,
        member_id: memberId,
        meal_date: sessionDate,
        night_count: nightVal,
        guest_night_count: guestNightVal,
        day_count: rowSession ? (rowSession.day_count || 0) : 0,
        guest_day_count: rowSession ? (rowSession.guest_day_count || 0) : 0,
      },
      {
        cycle_id: nextDayCycleId,
        member_id: memberId,
        meal_date: nextDate,
        day_count: dayVal,
        guest_day_count: guestDayVal,
        night_count: rowNext ? (rowNext.night_count || 0) : 0,
        guest_night_count: rowNext ? (rowNext.guest_night_count || 0) : 0,
      },
    ];

    const { error } = await supabase
      .from("meals")
      .upsert(upserts, { onConflict: "member_id, meal_date" });
    if (error) throw error;

    const actor = currentUser.members ? currentUser.members.name : "Admin";
    const targetMember = allMembers.find((m) => m.id === memberId);
    await logActivity(
      `Tracker Override: ${targetMember?.name}'s session (${sessionDate}) set (Night: ${nightVal}, Day: ${dayVal}, Guest Night: ${guestNightVal}, Guest Day: ${guestDayVal}) by ${actor}`,
      "meal",
      memberId
    );

    closeMealModal();
    await loadMasterTracker();
    showNotification("Session updated", "success");
  } catch (err) {
    showNotification(err.message, "error");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
});

// Add this helper function
function getStrictSessionDate() {
  const now = new Date();

  // Parse the Bazar End Time from config (e.g., "19:00")
  const endTimeStr = appConfig.lock_time_end || "19:00";
  const [endH, endM] = endTimeStr.split(":").map(Number);

  const bazarDeadline = new Date();
  bazarDeadline.setHours(endH, endM, 0, 0);

  // If we are PAST the deadline (e.g., it's 8 PM), the "Session" is Tomorrow.
  if (now > bazarDeadline) {
    const tomorrow = new Date();
    tomorrow.setDate(now.getDate() + 1);
    return toLocalISO(tomorrow);
  } else {
    // Otherwise, the Session is Today.
    return toLocalISO(now);
  }
}

// 2. Save logic (triggered on change)
async function saveDayMenu(dayIndex) {
  const night = document.getElementById(`night-${dayIndex}`).value;
  const day = document.getElementById(`day-${dayIndex}`).value;

  // --- PREVENT EDITS IF CURRENT CYCLE IS INACTIVE ---
  // Assuming weekly menu changes apply to the currently viewed cycle logic
  if (currentCycleId) {
    const cycle = allCycles.find(c => c.id == currentCycleId);
    if (cycle && !cycle.is_active) {
      showNotification("Cannot edit menus for past cycles", "error");
      
      // visual reset would be nice but returning is crucial
      return;
    }
  }

  // Visual feedback: briefly highlight the inputs
  const inputs = [
    document.getElementById(`night-${dayIndex}`),
    document.getElementById(`day-${dayIndex}`),
  ];

  try {
    const { error } = await supabase
      .from("weekly_menus")
      .update({ night_menu: night, day_menu: day })
      .eq("day_index", dayIndex);

    if (error) throw error;

    // Success: flash green border
    inputs.forEach((i) => {
      i.style.borderColor = "var(--success-color)";
      setTimeout(() => (i.style.borderColor = ""), 1000);
    });

    // Update dashboard if visible
    if (
      !document.getElementById("dashboardPage").classList.contains("hidden")
    ) {
      updateDashboardMealPlan();
    }
  } catch (err) {
    // Error: flash red border
    inputs.forEach((i) => {
      i.style.borderColor = "var(--danger-color)";
      setTimeout(() => (i.style.borderColor = ""), 1000);
    });
    showNotification("Auto-save failed", "error");
  }
}
