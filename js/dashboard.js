// MealCal Pro — Dashboard page, badges, balance warning, today meal plan card
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// DASHBOARD PAGE
// ============================================

// --- Update loadDashboard to set the welcome name ---
async function loadDashboard() {
  if (!currentCycleId) return;

  try {
    // 1. DETERMINE STRICT SESSION DATES
    // This ensures Dashboard looks at exactly the same dates as the Scheduler/Summary
    const sessionDateObj = await getActiveSessionDate(); // The active "Bazar Date"
    const sessionDateStr = toLocalISO(sessionDateObj); // YYYY-MM-DD (For Night Meal)

    const nextDateObj = new Date(sessionDateObj);
    nextDateObj.setDate(sessionDateObj.getDate() + 1);
    const nextDateStr = toLocalISO(nextDateObj); // YYYY-MM-DD (For Day Meal)

    // 2. FETCH ALL REQUIRED DATA IN PARALLEL
    const [
      expRes, // Approved Expenses (For Rate/Liquidity)
      mealsRes, // Historical Meals (For Rate Calculation)
      depsRes, // Deposits (For Liquidity)
      plansNightRes, // PLAN: Tonight's Night Counts (The "First Card" Truth)
      plansDayRes, // PLAN: Tomorrow's Day Counts (The "First Card" Truth)
      menuRes, // Menu for the session day
    ] = await Promise.all([
      supabase
        .from("expenses")
        .select("amount")
        .eq("cycle_id", currentCycleId)
        .eq("status", "approved"),
      supabase
        .from("meals")
        .select("*")
        .eq("cycle_id", currentCycleId),
      supabase
        .from("deposits")
        .select("amount, member_id")
        .eq("cycle_id", currentCycleId)
        .neq("status", "pending"),

      // Critical Fix: Summing actual DB rows for the Pulse Card (Personal + Guests)
      supabase
        .from("meal_plans")
        .select("member_id, night_count, guest_night_count")
        .eq("plan_date", sessionDateStr),
      supabase
        .from("meal_plans")
        .select("member_id, day_count, guest_day_count")
        .eq("plan_date", nextDateStr),

      supabase
        .from("weekly_menus")
        .select("*")
        .eq("day_index", sessionDateObj.getDay())
        .maybeSingle(),
    ]);

    // 3. CALCULATE FINANCIAL STATS (Accounting)
    const totalExp =
      expRes.data?.reduce((s, i) => s + parseFloat(i.amount), 0) || 0;
    const totalDep =
      depsRes.data?.reduce((s, i) => s + parseFloat(i.amount), 0) || 0;

    // Total Historical Meals (Session-Corrected)
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    const cycleStartDate = allCycles.find(c => c.id == currentCycleId)?.start_date;
    const totalMealsHistory = adjustMealTotal(mealsRes.data || [], boundaryMeals, cycleStartDate);

    const rate = totalMealsHistory > 0 ? totalExp / totalMealsHistory : 0;
    const liquidity = totalDep - totalExp;

    // 4. CALCULATE PULSE CARD COUNTS (Live Schedule: Personal + Guest)
    const liveNightCount =
      plansNightRes.data?.reduce((sum, row) => sum + (parseFloat(row.night_count) || 0) + (parseFloat(row.guest_night_count) || 0), 0) || 0;
    const liveDayCount =
      plansDayRes.data?.reduce((sum, row) => sum + (parseFloat(row.day_count) || 0) + (parseFloat(row.guest_day_count) || 0), 0) || 0;

    // ===================================
    // UI UPDATES
    // ===================================

    // A. Update Text Stats (Pills)
    document.getElementById("statMealRate").innerHTML = formatCurrency(rate);
    document.getElementById("statTotalExpense").innerHTML =
      formatCurrency(totalExp);
    document.getElementById("statTotalDeposit").innerHTML =
      formatCurrency(totalDep);

    // Total Meals Card (Bengali)
    const mealsEl = document.getElementById("statTotalMealsDisplay");
    if (mealsEl) {
      mealsEl.textContent = toBn(
        totalMealsHistory.toFixed(1).replace(/\.0$/, ""),
      );
    }

    // B. Update Meal Pulse Card (The First Card)
    // Dates
    document.getElementById("planNightDate").textContent =
      formatBengaliDate(sessionDateObj);
    document.getElementById("planDayDate").textContent =
      formatBengaliDate(nextDateObj);

    // Counts (Synced with Summary)
    document.getElementById("planNightTotal").textContent =
      toBn(liveNightCount);
    document.getElementById("planDayTotal").textContent = toBn(liveDayCount);

    // Menus
    const menu = menuRes.data;
    if (menu) {
      document.getElementById("planNightMenu").textContent =
        menu.night_menu || "মেনু নেই";
      document.getElementById("planDayMenu").textContent =
        menu.day_menu || "মেনু নেই";
    }

    // C. Update the mess cash gauge
    updateLiquidityMeter(liquidity);

    // D. Personal parts of the dashboard (greeting, my meals, my balance)
    const me = currentUser?.member_id;
    const myNight = (plansNightRes.data || []).find((r) => r.member_id === me);
    const myDay = (plansDayRes.data || []).find((r) => r.member_id === me);
    window._dbSession = {
      night: sessionDateStr, day: nextDateStr,
      myNight: myNight ? Number(myNight.night_count) : 0, myDay: myDay ? Number(myDay.day_count) : 0,
      gNight: myNight ? Number(myNight.guest_night_count || 0) : 0, gDay: myDay ? Number(myDay.guest_day_count || 0) : 0,
    };
    renderMySlot("dbMyNight", window._dbSession.myNight, window._dbSession.gNight);
    renderMySlot("dbMyDay", window._dbSession.myDay, window._dbSession.gDay);
    renderMealOffNote();
    const myMeals = me ? adjustMealTotal(mealsRes.data || [], boundaryMeals, cycleStartDate, me) : 0;
    const myPaid = (depsRes.data || []).filter((d) => d.member_id === me).reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
    renderMyBalance(myPaid - myMeals * rate, myMeals, rate);
    renderDashGreeting();

    // D. Trigger Background Updates
    loadSystemStatus();
    loadDashboardMemberSchedules();
    updateDashboardBadges();
    updatePendingCounts();
  } catch (err) {
    console.error("Dashboard Load Error:", err);
  }
}

// Mess cash gauge (half-circle). 0 – ৳10,000 fills the arc.
function updateLiquidityMeter(liquidity) {
  const balEl = document.getElementById("statMessBalance");
  const gauge = document.getElementById("messBalanceContainer");
  const arc = document.getElementById("liquidFillBar");
  const pill = document.getElementById("balanceStatusPill");
  const percentEl = document.getElementById("liquidPercent");
  if (!balEl || !gauge) return;

  const rounded = Math.round(liquidity);
  balEl.textContent = toBn(Math.abs(rounded).toLocaleString("en-IN"));
  const sign = document.getElementById("dbGaugeSign");
  if (sign) sign.textContent = rounded < 0 ? "−" : "";
  const percent = Math.max(0, Math.min(100, (Math.abs(liquidity) / 10000) * 100));
  // Deficit: the arc turns red and shows how deep the shortfall is
  if (arc) {
    const len = rounded === 0 ? 0 : Math.max(3, percent);
    arc.setAttribute("stroke-dasharray", len.toFixed(1) + " 100");
  }
  if (percentEl) {
    percentEl.textContent = rounded < 0 ? "Short by " + formatTk(Math.abs(rounded)) : rounded === 0 ? "Empty" : Math.round(percent) + "% of ৳10k";
  }

  const state = liquidity >= 1000 ? "good" : liquidity > 0 ? "low" : "empty";
  gauge.classList.remove("is-good", "is-low", "is-empty");
  gauge.classList.add("is-" + state);
  if (pill) {
    pill.className = "db-status-pill is-" + state;
    pill.textContent = state === "good" ? "✓ Healthy" : state === "low" ? "⚠ Running low" : "✕ No cash left";
  }
}

// Power button under each meal counter: green = my meal ON, red = OFF (tap to toggle)
function renderMySlot(id, count, guests) {
  const btn = document.getElementById(id);
  const label = document.getElementById(id + "Label");
  if (!btn) return;
  const on = Number(count) > 0;
  btn.classList.toggle("on", on);
  btn.classList.toggle("off", !on);
  btn.setAttribute("aria-pressed", String(on));
  const slot = id === "dbMyNight" ? "রাত" : "দুপুর";
  btn.setAttribute("aria-label", "My " + (id === "dbMyNight" ? "night" : "day") + " meal is " + (on ? "ON" : "OFF") + ". Tap to turn " + (on ? "off" : "on"));
  if (label) label.textContent = (on ? "My meal ON" : "My meal OFF") + (guests > 0 ? " · +" + guests + " guest" : "");
}

// Toggle my own meal for the current session from the dashboard
async function dashToggleMyMeal(slot, btn) {
  const s = window._dbSession;
  const me = currentUser?.member_id;
  if (!s || !me) return;
  const date = slot === "night" ? s.night : s.day;
  if (!isStaff() && isMealLocked(date, slot)) {
    if (btn) { btn.style.animation = "shake 0.4s ease"; setTimeout(() => (btn.style.animation = ""), 400); }
    showNotification("⛔ Locked until " + convertTo12Hour(appConfig.lock_time_end), "error");
    return;
  }
  const key = slot === "night" ? "myNight" : "myDay";
  const prev = s[key];
  const next = prev > 0 ? 0 : 1;
  s[key] = next;
  renderMySlot(slot === "night" ? "dbMyNight" : "dbMyDay", next, slot === "night" ? s.gNight : s.gDay);
  if (btn) btn.disabled = true;
  try {
    const row = { member_id: me, plan_date: date };
    row[slot === "night" ? "night_count" : "day_count"] = next;
    const { error } = await supabase.from("meal_plans").upsert(row, { onConflict: "member_id,plan_date" });
    if (error) throw error;
    updateDashboardMealPlan();
    pageLoaded.profile = false;
  } catch (err) {
    s[key] = prev;
    renderMySlot(slot === "night" ? "dbMyNight" : "dbMyDay", prev, slot === "night" ? s.gNight : s.gDay);
    showNotification(niceError(err), "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// "Your meals are OFF since…" — shown under My balance only while my meals are shut down
function renderMealOffNote() {
  const box = document.getElementById("dbMealOffNote");
  if (!box) return;
  const me = (allMembers || []).find((m) => m.id === currentUser?.member_id);
  if (!me?.meal_shutdown_at) { box.innerHTML = ""; return; }
  box.innerHTML =
    '<div class="db-off-note"><span class="db-off-icon">⛔</span>' +
    '<span class="db-off-text">Your meals are OFF since ' + escapeHtml(formatDateTimeFull(me.meal_shutdown_at)) + '.</span>' +
    '<button type="button" class="nm-btn nm-btn-accent db-off-btn" onclick="toggleMealPower(' + me.id + ', true)">Start meals</button></div>';
}

// My balance strip: number, a bar and one plain-language sentence
function renderMyBalance(balance, myMeals, rate) {
  const val = document.getElementById("dbMyBalanceVal");
  const bar = document.getElementById("dbMyBalanceBar");
  const sub = document.getElementById("dbMyBalanceSub");
  const box = document.getElementById("dbMyBalance");
  if (!val || !box) return;
  const owe = balance < -0.5;
  const meals = Math.round(myMeals * 10) / 10;
  box.classList.toggle("owe", owe);
  box.classList.toggle("credit", !owe);
  val.innerHTML = formatCurrency(balance);
  if (bar) bar.style.width = Math.min(100, Math.max(6, (Math.abs(balance) / 2000) * 100)) + "%";
  if (sub) {
    sub.textContent = owe
      ? "You owe " + formatTk(Math.abs(balance)) + " — please deposit (" + meals + " meals × " + formatTk(rate) + ")"
      : "You're covered — " + formatTk(balance) + " left after " + meals + " meals";
  }
}

// Greeting + whether meal changes are open or locked right now
function renderDashGreeting() {
  const h = new Date().getHours();
  const hello = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 21 ? "Good evening" : "Good night";
  const g = document.getElementById("dbGreeting");
  const n = document.getElementById("welcomeName");
  if (g) g.textContent = hello;
  if (n) n.textContent = (currentUser?.name || "Friend").split(" ")[0] + " 👋";

  const chip = document.getElementById("dbSessionChip");
  const txt = document.getElementById("dbSessionText");
  const sub = document.getElementById("dbSessionSub");
  if (!chip || !txt || !appConfig?.lock_time_start) return;
  const now = new Date();
  const at = (hhmm) => { const [hh, mm] = hhmm.split(":").map(Number); const d = new Date(); d.setHours(hh, mm, 0, 0); return d; };
  const start = at(appConfig.lock_time_start), end = at(appConfig.lock_time_end);
  const locked = now >= start && now <= end;
  chip.className = "db-session-chip " + (locked ? "locked" : "open");
  txt.textContent = locked
    ? "Locked until " + convertTo12Hour(appConfig.lock_time_end)
    : "Open · changes until " + convertTo12Hour(appConfig.lock_time_start);
  const sess = parseLocalDate(getStrictSessionDate());
  if (sub) sub.textContent = "Bazar session · " + sess.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
setInterval(() => { if (currentUser && !document.hidden && getActivePage() === "dashboard") renderDashGreeting(); }, 60000);

// ==========================================
// BADGE MANAGER SYSTEM
// ==========================================

async function updateDashboardBadges() {
  // Only run if cycle is loaded
  if (!currentCycleId) return;

  try {
    // 1. Fetch Pending Counts in Parallel
    // We use { count: 'exact', head: true } for maximum performance (doesn't download data rows)
    const [pendingDep, pendingExp] = await Promise.all([
      supabase
        .from("deposits")
        .select("*", { count: "exact", head: true })
        .eq("cycle_id", currentCycleId)
        .eq("status", "pending"),

      supabase
        .from("expenses")
        .select("*", { count: "exact", head: true })
        .eq("cycle_id", currentCycleId)
        .eq("status", "pending"),
    ]);

    // 2. Update UI
    toggleBadge("badgeDeposit", pendingDep.count);
    toggleBadge("badgeExpense", pendingExp.count);

    // 3. Optional: Update Bottom Nav Badges (If you want them there too)
    updateNavBadge("deposits", pendingDep.count);
    updateNavBadge("expenses", pendingExp.count);
  } catch (err) {
    console.error("Badge Sync Error:", err);
  }
}

// ==========================================
// PENDING BADGE SYSTEM
// ==========================================

async function updatePendingCounts() {
  if (!currentCycleId) return;

  try {
    // Run count queries in parallel for speed
    const [depReq, expReq] = await Promise.all([
      // Count Pending Deposits
      supabase
        .from("deposits")
        .select("*", { count: "exact", head: true }) // head:true means don't fetch data, just count
        .eq("cycle_id", currentCycleId)
        .eq("status", "pending"),

      // Count Pending Expenses
      supabase
        .from("expenses")
        .select("*", { count: "exact", head: true })
        .eq("cycle_id", currentCycleId)
        .eq("status", "pending"),
    ]);

    // Update UI
    toggleBadgeUI("badgeDeposit", depReq.count);
    toggleBadgeUI("badgeExpense", expReq.count);
  } catch (err) {
    console.error("Badge Sync Error:", err);
  }
}

// ==========================================
// BADGE NAVIGATION HANDLER
// ==========================================

async function navigateToPending(page, event) {
  // Prevent bubbling if the card itself has a click listener (optional safety)
  if (event) event.stopPropagation();

  // 1. Navigate to the page
  await navigateToPage(page);

  // 2. Determine target container ID
  let targetId = "";
  if (page === "expenses") targetId = "pendingExpensesCard";
  if (page === "deposits") targetId = "pendingDepositsCard";

  // 3. Scroll and Highlight
  setTimeout(() => {
    const el = document.getElementById(targetId);

    if (el && el.style.display !== "none") {
      // Smooth Scroll to the pending box
      el.scrollIntoView({ behavior: "smooth", block: "center" });

      // Visual Pulse Effect to show user "Here it is!"
      const originalTransform = el.style.transform;
      const originalShadow = el.style.boxShadow;

      el.style.transition = "all 0.3s ease";
      el.style.transform = "scale(1.02)";
      el.style.boxShadow = "0 0 0 4px rgba(245, 158, 11, 0.4)"; // Amber glow ring

      // Remove effect after 600ms
      setTimeout(() => {
        el.style.transform = originalTransform;
        el.style.boxShadow = originalShadow;
      }, 600);
    } else {
      // Fallback if badge showed number but list is somehow empty (rare sync issue)
      showNotification("No pending items found visible.", "info");
    }
  }, 300); // Small delay to ensure page rendering is complete
}

function toggleBadgeUI(elementId, count) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (count && count > 0) {
    // Set text (99+ if too large)
    el.textContent = count > 99 ? "99+" : count;

    // Remove hidden class first
    el.classList.remove("hidden");

    // Use timeout to allow CSS transition to animate in
    setTimeout(() => {
      el.classList.add("active");
      // Make it pill-shaped if double digits
      if (count > 9) el.classList.add("wide");
      else el.classList.remove("wide");
    }, 10);
  } else {
    el.classList.remove("active");
    // Wait for fade out animation before hiding
    setTimeout(() => el.classList.add("hidden"), 400);
  }
}

// Helper to animate badge
function toggleBadge(elementId, count) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (count && count > 0) {
    el.textContent = count > 99 ? "99+" : count;
    el.classList.remove("hidden");
    // Small delay to allow 'display:block' to apply before adding 'active' for animation
    requestAnimationFrame(() => {
      el.classList.add("active");
      if (count > 9) el.classList.add("wide");
    });
  } else {
    el.classList.remove("active");
    // Wait for transition to finish before hiding
    setTimeout(() => el.classList.add("hidden"), 300);
  }
}

// Optional Helper: Add red dots to bottom nav icons
function updateNavBadge(pageName, count) {
  const navLink = document.querySelector(
    `.bottom-nav-link[data-page="${pageName}"]`,
  );
  if (!navLink) return;

  // Check if dot exists, else create it
  let dot = navLink.querySelector(".nav-dot");
  if (!dot) {
    dot = document.createElement("div");
    dot.className = "nav-dot";
    dot.style.cssText =
      "position:absolute; top:8px; right:20px; width:8px; height:8px; background:#ef4444; border-radius:50%; border:1px solid white; display:none;";
    navLink.style.position = "relative";
    navLink.appendChild(dot);
  }

  dot.style.display = count > 0 ? "block" : "none";
}

async function checkGlobalBalanceWarning() {
  if (!currentUser || !currentUser.member_id || !currentCycleId) return;

  try {
    // 1. Fetch data needed for Meal Rate
    const { data: expenses } = await supabase
      .from("expenses")
      .select("amount")
      .eq("cycle_id", currentCycleId)
      .eq("status", "approved");

    const { data: allMeals } = await supabase
      .from("meals")
      .select("*")
      .eq("cycle_id", currentCycleId);

    // 2. Fetch User Specific data
    const { data: userMeals } = await supabase
      .from("meals")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .eq("cycle_id", currentCycleId);

    const { data: userDeposits } = await supabase
      .from("deposits")
      .select("amount")
      .eq("member_id", currentUser.member_id)
      .eq("cycle_id", currentCycleId)
      .neq("status", "pending");

    // 3. Perform Calculations (Session-Corrected)
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    const cycleStartDate = allCycles.find(c => c.id == currentCycleId)?.start_date;
    const totalExp =
      expenses?.reduce((sum, e) => sum + parseFloat(e.amount), 0) || 0;
    const totalGlobalMeals = adjustMealTotal(allMeals || [], boundaryMeals, cycleStartDate) || 0;
    const mealRate = totalGlobalMeals > 0 ? totalExp / totalGlobalMeals : 0;

    const totalUserMeals = adjustMealTotal(userMeals || [], boundaryMeals, cycleStartDate, currentUser.member_id);
    const totalUserDeposit =
      userDeposits?.reduce((sum, d) => sum + parseFloat(d.amount), 0) || 0;

    const currentBalance = totalUserDeposit - totalUserMeals * mealRate;

    // 4. Update Header UI
    const header = document.querySelector(".app-header");
    const nameDisplay = document.getElementById("headerUserName");

    if (currentBalance < 0) {
      header.classList.add("balance-warning");
      // Optional: Add a small warning icon next to the name
      if (!nameDisplay.innerHTML.includes("⚠️")) {
        nameDisplay.innerHTML = "⚠️ " + nameDisplay.innerHTML;
      }

      // Send daily negative balance push notification once per session
      const todaySession = typeof getStrictSessionDate === "function" ? getStrictSessionDate() : new Date().toISOString().split("T")[0];
      const alertKey = `neg_bal_push_${currentUser.member_id}_${todaySession}`;
      if (!localStorage.getItem(alertKey)) {
        localStorage.setItem(alertKey, "true");
        triggerBrowserPushNotification({
          title: "⚠️ Negative Balance Alert",
          body: `Your balance is negative (-৳${Math.abs(Math.round(currentBalance))}). Please submit a deposit request.`,
          url: "#deposits",
          targetMemberId: currentUser.member_id
        });
      }
    } else {
      header.classList.remove("balance-warning");
      // Remove warning icon if balance is recovered
      nameDisplay.innerHTML = nameDisplay.innerHTML.replace("⚠️ ", "");
    }
  } catch (err) {
    console.error("Balance Warning Check Error:", err);
  }
}

// --- Helper: Convert Date to Bengali Format ---
// Output: '১২ জানুয়ারি সোমবার'
function formatBengaliDate(dateObj) {
  const bnMonths = [
    "জানুয়ারি",
    "ফেব্রুয়ারি",
    "মার্চ",
    "এপ্রিল",
    "মে",
    "জুন",
    "জুলাই",
    "আগস্ট",
    "সেপ্টেম্বর",
    "অক্টোবর",
    "নভেম্বর",
    "ডিসেম্বর",
  ];
  const bnDays = [
    "রবিবার",
    "সোমবার",
    "মঙ্গলবার",
    "বুধবার",
    "বৃহস্পতিবার",
    "শুক্রবার",
    "শনিবার",
  ];

  const dayName = bnDays[dateObj.getDay()];
  const monthName = bnMonths[dateObj.getMonth()];
  const dateNum = toBn(dateObj.getDate()); // Uses your existing toBn helper

  return `${dateNum} ${monthName} ${dayName}`;
}

// --- Updated Function ---
async function updateDashboardMealPlan() {
  // 1. Calculate Dates
  const now = new Date();
  const todayStr = toLocalISO(now); // YYYY-MM-DD

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = toLocalISO(tomorrow);

  try {
    // 2. Fetch Data (Menu, Defaults, Plans)
    const [menuRes, membersRes, plansRes] = await Promise.all([
      supabase
        .from("weekly_menus")
        .select("*")
        .eq("day_index", now.getDay())
        .maybeSingle(),
      supabase.from("members").select("id, default_day_on, default_night_on").eq("is_approved", true),
      supabase
        .from("meal_plans")
        .select("*")
        .in("plan_date", [todayStr, tomorrowStr]),
    ]);

    const members = membersRes.data || [];
    const plans = plansRes.data || [];
    const menu = menuRes.data;

    // 3. Calculate Totals
    let nightSum = 0; // Today Night
    let daySum = 0; // Tomorrow Day

    members.forEach((m) => {
      // Check for tonight's override
      const nPlan = plans.find(
        (p) => p.member_id === m.id && p.plan_date === todayStr,
      );
      // Check for tomorrow morning's override
      const dPlan = plans.find(
        (p) => p.member_id === m.id && p.plan_date === tomorrowStr,
      );

      nightSum += nPlan
        ? Number(nPlan.night_count)
        : m.default_night_on
          ? 1
          : 0;
      daySum += dPlan ? Number(dPlan.day_count) : m.default_day_on ? 1 : 0;
    });

    // 4. Update Visuals

    // Dates (Using the new Bengali Formatter)
    document.getElementById("planNightDate").textContent =
      formatBengaliDate(now);
    document.getElementById("planDayDate").textContent =
      formatBengaliDate(tomorrow);

    // Counts (Using toBn for Bengali Digits)
    document.getElementById("planNightTotal").textContent = toBn(nightSum);
    document.getElementById("planDayTotal").textContent = toBn(daySum);

    // Menus
    if (menu) {
      document.getElementById("planNightMenu").textContent =
        menu.night_menu || "মেনু নেই";
      document.getElementById("planDayMenu").textContent =
        menu.day_menu || "মেনু নেই";
    }
  } catch (err) {
    console.error("Dashboard calculation failed:", err);
  }
}
