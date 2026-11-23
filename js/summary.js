// MealCal Pro — Summary page (meal rate + balances)
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// SUMMARY PAGE
// ============================================

async function loadSummary() {
  if (!currentCycleId) return;

  const tbody = document.getElementById("summaryTableBody");
  if (!tbody) return;

  try {
    const sessionDate = await getActiveSessionDate();
    const nightDateStr = toLocalISO(sessionDate);

    // Calculate next day properly
    const nextDay = new Date(sessionDate);
    nextDay.setDate(sessionDate.getDate() + 1);
    const dayDateStr = toLocalISO(nextDay);

    const [mealsRes, plansRes, depositsRes, expensesRes] = await Promise.all([
      supabase.from("meals").select("*").eq("cycle_id", currentCycleId),
      supabase
        .from("meal_plans")
        .select("*")
        .in("plan_date", [nightDateStr, dayDateStr]),
      supabase
        .from("deposits")
        .select("*")
        .eq("cycle_id", currentCycleId)
        .neq("status", "pending"),
      supabase
        .from("expenses")
        .select("*")
        .eq("cycle_id", currentCycleId)
        .eq("status", "approved"),
    ]);

    const meals = mealsRes.data || [];
    const plans = plansRes.data || [];
    const deposits = depositsRes.data || [];
    const expenses = expensesRes.data || [];

    // Fetch boundary meals and cycle start date for session-corrected totals
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    const cycleStartDate = allCycles.find(c => c.id == currentCycleId)?.start_date;

    // Update Top Stat Cards
    const totalExpense = expenses.reduce(
      (sum, e) => sum + parseFloat(e.amount || 0),
      0,
    );
    const allTotalMeals = adjustMealTotal(meals, boundaryMeals, cycleStartDate);
    const mealRate = allTotalMeals > 0 ? totalExpense / allTotalMeals : 0;

    document.getElementById("summaryMealRate").textContent =
      `৳${mealRate.toFixed(2)}`;
    document.getElementById("summaryTotalCost").textContent =
      `৳${Math.round(totalExpense)}`;
    document.getElementById("summaryTotalMeals").textContent =
      allTotalMeals.toFixed(0);

    // Build Table Rows
    const isAdmin =
      currentUser.role === "admin" || currentUser.role === "manager";
    const bazarCountMap = {};
    expenses.forEach((exp) => {
      bazarCountMap[exp.member_id] = (bazarCountMap[exp.member_id] || 0) + 1;
    });

    // --- UPDATE 1: ADD HEADER FOR DEPOSIT ---
    const tableHead = document.querySelector("#summaryTable thead tr");
    if (tableHead) {
      tableHead.innerHTML = `
                <th>Member</th>
                <th>🌙 Night</th>
                <th>🌞 Day</th>
                <th>Bazar</th>
                <th>Meals</th>
                <th>Deposit</th> <!-- NEW COLUMN -->
                <th>Balance</th>
            `;
    }

    const activeSummaryMembers = allMembers.filter(m => !m.archived_from_cycle_id || parseInt(currentCycleId) < m.archived_from_cycle_id);
    tbody.innerHTML = activeSummaryMembers
      .map((member) => {
        const memMeals = adjustMealTotal(meals, boundaryMeals, cycleStartDate, member.id);

        // This variable already existed in your code
        const memPaid = deposits
          .filter((d) => d.member_id === member.id)
          .reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);

        const memBal = memPaid - memMeals * mealRate;

        const nPlan = plans.find(
          (p) => p.member_id === member.id && p.plan_date === nightDateStr,
        );
        const dPlan = plans.find(
          (p) => p.member_id === member.id && p.plan_date === dayDateStr,
        );

        const nVal = nPlan ? nPlan.night_count : 0;
        const dVal = dPlan ? dPlan.day_count : 0;

        // --- UPDATE 2: ADD DATA CELL FOR DEPOSIT ---
        return `
            <tr>
                <td><strong>${escapeHtml(member.name.split(" ")[0])}</strong></td>
                <td><button class="summary-status-btn ${nVal > 0 ? "on" : "off"}" ${isAdmin ? `onclick="quickToggleSummaryMeal(${member.id}, '${nightDateStr}', 'night', ${nVal})"` : "disabled"}>${nVal > 0 ? "ON" : "OFF"}</button></td>
                <td><button class="summary-status-btn ${dVal > 0 ? "on" : "off"}" ${isAdmin ? `onclick="quickToggleSummaryMeal(${member.id}, '${dayDateStr}', 'day', ${dVal})"` : "disabled"}>${dVal > 0 ? "ON" : "OFF"}</button></td>
                <td style="font-weight:700; color:var(--premium-indigo);">${toBn(bazarCountMap[member.id] || 0)}</td>
                <td>${toBn(memMeals.toFixed(1))}</td>
                
                <!-- NEW DEPOSIT CELL -->
                <td style="font-weight:700; color: #059669;">৳${toBn(Math.round(memPaid))}</td>
                
                <td><span class="balance-tag ${memBal >= 0 ? "pos" : "neg"}">${toBn(Math.round(memBal))}</span></td>
            </tr>`;
      })
      .join("");

    await loadDueSettlement();
  } catch (err) {
    console.error("Summary Error:", err);
    tbody.innerHTML =
      '<tr><td colspan="7" style="color:red">Error loading summary</td></tr>';
  }
}

// Function to instantly toggle meal from Summary Page
async function quickToggleSummaryMeal(memberId, dateStr, type, currentVal) {
  // --- PREVENT EDITS TO PAST CYCLES ---
  // Find which cycle this date belongs to
  const targetDateObj = parseLocalDate(dateStr);
  const targetCycle = allCycles.find(c => {
    const sDate = parseLocalDate(c.start_date);
    const eDate = parseLocalDate(c.end_date);
    // Include the boundary day (end_date + 1) which belongs to the final session
    const boundaryDate = new Date(eDate);
    boundaryDate.setDate(boundaryDate.getDate() + 1);
    return targetDateObj >= sDate && targetDateObj <= boundaryDate;
  });

  if (targetCycle && !targetCycle.is_active) {
    showNotification("Cannot edit past cycle data", "error");
    return;
  }

  const btn = event.target; // Optimistic UI
  const originalText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  // 1. Calculate New Value
  const newVal = currentVal > 0 ? 0 : 1;

  try {
    // 2. Fetch existing PLAN
    const { data: existingPlan } = await supabase
      .from("meal_plans")
      .select("*")
      .eq("member_id", memberId)
      .eq("plan_date", dateStr)
      .maybeSingle();

    // 3. Prepare Upsert Data
    const upsertPlan = {
      member_id: memberId,
      plan_date: dateStr,
      day_count: existingPlan ? existingPlan.day_count : 0,
      night_count: existingPlan ? existingPlan.night_count : 0,
    };

    if (type === "night") {
      upsertPlan.night_count = newVal;
    } else {
      upsertPlan.day_count = newVal;
    }

    // 4. Send to Database
    const { error } = await supabase
      .from("meal_plans")
      .upsert(upsertPlan, { onConflict: "member_id, plan_date" });

    if (error) throw error;

    // 5. LOGGING
    const targetMember = allMembers.find((m) => m.id === memberId);
    const targetName = targetMember ? targetMember.name : "Member";
    const actorName = currentUser.members
      ? currentUser.members.name
      : currentUser.name;

    const actionText = newVal > 0 ? "enabled" : "disabled";
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const dateObj = new Date(dateStr);
    const niceDate = dateObj.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });

    const logMsg = `${typeLabel} meal for ${niceDate} ${actionText} for "${targetName}" by "${actorName}"`;

    await logActivity(logMsg, "meal");

    // --- THE FIX STARTS HERE ---

    // A. Refresh Summary Table (Immediate UI feedback)
    await loadSummary();

    // B. Refresh Dashboard Top Card (So totals are correct instantly)
    if (typeof updateDashboardMealPlan === "function") {
      updateDashboardMealPlan();
    }

    // C. Refresh Scheduler Card (CRITICAL FIX)
    // If I changed MY OWN meal, update my scheduler immediately
    if (memberId === currentUser.member_id) {
      // 1. Force the page to reload next time we visit
      pageLoaded.profile = false;

      // 2. Clear the container so it doesn't show stale data
      const container = document.getElementById("schedulerList");
      if (container)
        container.innerHTML = '<div class="loading">Syncing changes...</div>';

      // 3. Actually reload it now in the background
      await loadScheduler();
    }

    showNotification("Schedule updated successfully", "success");
  } catch (err) {
    console.error("Quick Toggle Error", err);
    showNotification("Update failed", "error");
    btn.textContent = originalText;
  } finally {
    btn.disabled = false;
  }
}

// "Table only" Excel export (works on phones and PC)
document.getElementById("exportSummaryBtn").addEventListener("click", async () => {
  const btn = document.getElementById("exportSummaryBtn");
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    await ensureXLSX();
    const table = document.getElementById("summaryTable");
    if (!table) throw new Error("Summary table not loaded yet");
    const wb = XLSX.utils.table_to_book(table, { raw: false });
    const cycleName = (document.getElementById("headerCycleName")?.textContent || "cycle").replace(/[^a-z0-9]/gi, "_");
    const how = await deliverWorkbook(wb, `MealCal_Summary_${cycleName}.xlsx`);
    if (how !== "cancelled") showNotification("Summary exported (Excel)", "success");
  } catch (err) {
    showNotification("Export failed: " + niceError(err), "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});
