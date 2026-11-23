// MealCal Pro — Profile page
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// PROFILE PAGE
// ============================================

async function loadProfile() {
  if (!currentUser || !currentUser.member_id) return;
  if (!currentCycleId) return;

  try {
    const member = allMembers.find((m) => m.id === currentUser.member_id);
    if (member) {
      const avatarCircle = document.getElementById("profileAvatar");
      avatarCircle.onclick = changeProfilePicture;

      document.getElementById("profileName").textContent = member.name;
      document.getElementById("profileRoleDisplay").textContent =
        member.role || "Member";

      if (member.avatar_url && member.avatar_url.trim() !== "") {
        avatarCircle.innerHTML = `
                    <img src="${escapeHtml(member.avatar_url)}" alt="Profile photo" onerror="this.remove()">
                    <div class="profile-status-online"></div>
                `;
        avatarCircle.classList.add("has-image");
      } else {
        const initials = member.name
          .split(" ")
          .map((n) => n[0])
          .join("")
          .substring(0, 2)
          .toUpperCase();
        avatarCircle.innerHTML = `${initials}<div class="profile-status-online"></div>`;
        avatarCircle.classList.remove("has-image");
      }
    }

    // Fetch calculation data
    const [userMeals, userDeps, allExp, allMeals] = await Promise.all([
      supabase
        .from("meals")
        .select("*")
        .eq("member_id", currentUser.member_id)
        .eq("cycle_id", currentCycleId),
      supabase
        .from("deposits")
        .select("amount")
        .eq("member_id", currentUser.member_id)
        .eq("cycle_id", currentCycleId)
        .neq("status", "pending"),
      supabase
        .from("expenses")
        .select("amount")
        .eq("cycle_id", currentCycleId)
        .eq("status", "approved"),
      supabase
        .from("meals")
        .select("*")
        .eq("cycle_id", currentCycleId),
    ]);

    // Session-corrected calculations
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    const cycleStartDate = allCycles.find(c => c.id == currentCycleId)?.start_date;
    const totalUserMeals = adjustMealTotal(userMeals.data || [], boundaryMeals, cycleStartDate, currentUser.member_id);
    const totalUserPaid =
      userDeps.data?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;
    const totalGlobalExp =
      allExp.data?.reduce((s, e) => s + parseFloat(e.amount), 0) || 0;
    const totalGlobalMeals = adjustMealTotal(allMeals.data || [], boundaryMeals, cycleStartDate) || 1;

    const rate = totalGlobalMeals > 0 ? totalGlobalExp / totalGlobalMeals : 0;
    const currentBalance = totalUserPaid - totalUserMeals * rate;

    // --- UI UPDATES (FIXED) ---

    // 1. Fix Total Meals: Update the text content + Convert to Bengali
    const mealsEl = document.getElementById("profileTotalMeals");
    if (mealsEl) {
      // toBn converts "15" to "১৫"
      mealsEl.textContent = toBn(totalUserMeals);
    }

    // 2. Fix Total Paid: Convert to Bengali
    const depositEl = document.getElementById("profileTotalDeposit");
    if (depositEl) {
      depositEl.textContent = `৳${toBn(Math.round(totalUserPaid))}`;
    }

    // 3. Fix Main Wallet Balance: Use formatCurrency() for styling + Bengali
    const heroBal = document.getElementById("profileBalance");
    if (heroBal) {
      // Using innerHTML because formatCurrency returns <span> tags for styling
      heroBal.innerHTML = formatCurrency(currentBalance);
    }

    // 4. Update Color States (Positive/Negative)
    const heroCard = document.getElementById("profileBalanceCard");

    if (currentBalance < 0) {
      if (heroCard) {
        heroCard.classList.add("status-neg");
        heroCard.classList.remove("status-pos");
      }
    } else {
      if (heroCard) {
        heroCard.classList.add("status-pos");
        heroCard.classList.remove("status-neg");
      }
    }

    // Cycle Name
    const cycleObj = allCycles.find((c) => c.id == currentCycleId);
    document.getElementById("profileCycleName").textContent = cycleObj
      ? cycleObj.name
      : "Unknown";

    await loadProfileDepositHistory();
    pageLoaded.profile = true;
  } catch (err) {
    console.error("Error loading profile:", err);
  }
}

// Function to update the Avatar Link
async function changeProfilePicture() {
  // 1. Ask the user for the URL
  const currentUrl =
    allMembers.find((m) => m.id === currentUser.member_id)?.avatar_url || "";
  const newUrl = await uiPrompt("Profile picture", "Paste a direct link to an image (https://…). Leave empty to remove it.", {
    value: currentUrl, placeholder: "https://…", type: "url", icon: "🖼️",
  });
  if (newUrl && !/^https:\/\//i.test(newUrl.trim())) {
    showNotification("Please use a secure https:// image link", "error");
    return;
  }

  // 2. If user didn't cancel and entered something (or cleared it)
  if (newUrl !== null) {
    try {
      // Show a loading notification
      showNotification("Updating photo...", "info");

      // 3. Update Supabase
      const { error } = await supabase
        .from("members")
        .update({ avatar_url: newUrl.trim() })
        .eq("id", currentUser.member_id);

      if (error) throw error;

      // 4. Update local state so UI reflects change immediately
      const memberIndex = allMembers.findIndex(
        (m) => m.id === currentUser.member_id,
      );
      if (memberIndex !== -1)
        allMembers[memberIndex].avatar_url = newUrl.trim();

      // 5. Refresh the Profile UI
      loadProfile();
      showNotification("Profile picture updated!", "success");
    } catch (err) {
      console.error("Update failed:", err);
      showNotification("Failed to update photo.", "error");
    }
  }
}

async function loadTodayMealStatus() {
  if (!currentUser.member_id) return;
  const today = toLocalISO(new Date());

  try {
    const { data } = await supabase
      .from("meals")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .eq("meal_date", today)
      .maybeSingle();

    const dayCount = data?.day_count || 0;
    const nightCount = data?.night_count || 0;

    const dayToggle = document.getElementById("dayMealToggle");
    const nightToggle = document.getElementById("nightMealToggle");

    if (dayCount > 0) {
      dayToggle.classList.add("active");
      dayToggle.classList.remove("inactive");
      document.getElementById("dayMealStatus").textContent = "ON";
    } else {
      dayToggle.classList.add("inactive");
      dayToggle.classList.remove("active");
      document.getElementById("dayMealStatus").textContent = "OFF";
    }

    if (nightCount > 0) {
      nightToggle.classList.add("active");
      nightToggle.classList.remove("inactive");
      document.getElementById("nightMealStatus").textContent = "ON";
    } else {
      nightToggle.classList.add("inactive");
      nightToggle.classList.remove("active");
      document.getElementById("nightMealStatus").textContent = "OFF";
    }
  } catch (err) {
    console.error("Error loading meal status:", err);
  }
}

async function loadProfileDepositHistory() {
  if (!currentUser.member_id) return;
  try {
    const { data, error } = await supabase
      .from("deposits")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .eq("cycle_id", currentCycleId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const container = document.getElementById("profileDepositHistory");

    if (!data || data.length === 0) {
      container.innerHTML = '<div class="pf-empty">No deposits yet this cycle.</div>';
      return;
    }

    container.innerHTML = data
      .map(
        (deposit) => `
                <div class="pf-tx ${deposit.amount < 0 ? "is-out" : "is-in"}">
                    <span class="pf-tx-icon">${deposit.label === "Auto-Settlement" ? "🔄" : deposit.amount < 0 ? "🔻" : "💰"}</span>
                    <div class="pf-tx-main">
                        <div class="pf-tx-title">${escapeHtml(deposit.label === "Auto-Settlement" ? (deposit.notes || "Settlement") : (deposit.label || "Deposit"))}</div>
                        <div class="pf-tx-sub">${formatDateTime(deposit.created_at)}</div>
                    </div>
                    <div class="pf-tx-amt">${deposit.amount < 0 ? "−" : "+"}${formatTk(Math.abs(deposit.amount))}</div>
                </div>
            `,
      )
      .join("");
  } catch (err) {
    console.error("Error loading deposit history:", err);
  }
}

// Toggle meal status
// document.getElementById('dayMealToggle').addEventListener('click', async () => {
//     if (currentUser.member_id) await toggleMeal('day');
// });

// document.getElementById('nightMealToggle').addEventListener('click', async () => {
//     if (currentUser.member_id) await toggleMeal('night');
// });

async function toggleDefaultPreference(type) {
  if (!currentUser.member_id) return;

  // 1. Get current member data from local list to check current state
  const member = allMembers.find((m) => m.id === currentUser.member_id);
  if (!member) return;

  // 2. Determine new state (Toggle)
  let updates = {};
  if (type === "day") {
    const newState = !member.default_day_on;
    updates = { default_day_on: newState };
    // Optimistic Update (Visual)
    member.default_day_on = newState;
    updateDefaultButtons(member);
  } else {
    const newState = !member.default_night_on;
    updates = { default_night_on: newState };
    // Optimistic Update (Visual)
    member.default_night_on = newState;
    updateDefaultButtons(member);
  }

  try {
    // 3. Save to DB
    const { error } = await supabase
      .from("members")
      .update(updates)
      .eq("id", currentUser.member_id);

    if (error) throw error;
    // dlog("Default updated");

    // 4. Reload Scheduler to apply new default to any *future missing* cards immediately?
    // Actually, we usually only apply defaults when a card is CREATED.
    // Existing cards shouldn't change. So we don't reload scheduler here.
  } catch (err) {
    console.error("Failed to update defaults", err);
    showNotification("Failed to save default setting", "error");
  }
}

// Helper to update button colors
function updateDefaultButtons(member) {
  if (!member) return;
  const set = (id, on, icon, name) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.className = "def-btn" + (on ? " active" : "");
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-checked", String(on));
    btn.setAttribute("aria-label", "Default " + name + " meal " + (on ? "ON" : "OFF"));
    btn.innerHTML = '<span class="def-ico">' + icon + '</span><span class="def-name">' + name + '</span><span class="def-switch" aria-hidden="true"></span>';
  };
  set("defDayBtn", !!member.default_day_on, "☀️", "Day");
  set("defNightBtn", !!member.default_night_on, "🌙", "Night");
}

async function toggleMeal(mealType) {
  const today = toLocalISO(new Date());

  try {
    const { data: existing } = await supabase
      .from("meals")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .eq("meal_date", today)
      .maybeSingle();

    let dayCount = existing?.day_count || 0;
    let nightCount = existing?.night_count || 0;

    if (mealType === "day") {
      dayCount = dayCount > 0 ? 0 : 1;
    } else {
      nightCount = nightCount > 0 ? 0 : 1;
    }

    if (existing) {
      await supabase
        .from("meals")
        .update({
          day_count: dayCount,
          night_count: nightCount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("meals").insert({
        cycle_id: currentCycleId,
        member_id: currentUser.member_id,
        meal_date: today,
        day_count: dayCount,
        night_count: nightCount,
      });
    }

    // --- CRUCIAL UPDATE HERE ---
    // We get the name of the person performing the action
    const actorName = currentUser.members
      ? currentUser.members.name
      : currentUser.username;
    const actionType =
      mealType === "day"
        ? dayCount > 0
          ? "ON"
          : "OFF"
        : nightCount > 0
          ? "ON"
          : "OFF";

    await logActivity(
      `${actorName} turned ${mealType.toUpperCase()} meal ${actionType} for today`,
      "meal",
    );
    // ---------------------------

    await loadTodayMealStatus();
    showNotification("Meal status updated", "success");
  } catch (err) {
    console.error("Error toggling meal:", err);
    showNotification("Failed to update meal status", "error");
  }
}
