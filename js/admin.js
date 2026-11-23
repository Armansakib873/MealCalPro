// MealCal Pro — Admin panel, members, system status
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// ADMIN PAGE
// ============================================

async function loadAdmin() {
  await loadMembersList();
}

document
  .getElementById("createCycleForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    const name = document.getElementById("cycleName").value;
    const startDate = document.getElementById("cycleStartDate").value;
    const endDate = document.getElementById("cycleEndDate").value;

    btn.textContent = "Creating...";
    btn.disabled = true;

    try {
      await supabase.from("cycles").update({ is_active: false }).neq("id", 0);
      const { error } = await supabase
        .from("cycles")
        .insert({
          name,
          start_date: startDate,
          end_date: endDate,
          is_active: true,
        });
      if (error) throw error;

      const actor = currentUser.members ? currentUser.members.name : "Admin";
      await logActivity(
        `System: New cycle "${name}" created and activated by ${actor}`,
        "other",
      );

      document.getElementById("createCycleForm").reset();
      await loadCycles();
      showNotification("Cycle created", "success");
    } catch (err) {
      showNotification(err.message, "error");
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

document
  .getElementById("addMemberForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    const name     = document.getElementById("memberName").value.trim();
    const email    = document.getElementById("memberEmail").value.trim();
    const password = document.getElementById("memberPassword").value;
    const role     = document.getElementById("memberRole").value;
    const avatar   = document.getElementById("memberAvatar").value.trim();

    // Basic validation
    if (!name)             return showNotification("Full name is required.", "error");
    if (!email)            return showNotification("Login email is required.", "error");
    if (password.length < 6) return showNotification("Password must be at least 6 characters.", "error");

    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.innerHTML;
    btn.innerHTML = "⏳ Creating...";
    btn.disabled = true;

    try {
      // One secure server call: creates the login (no confirmation email) and an
      // already-approved member row. Only admins/managers are allowed to run it.
      const { error: rpcError } = await supabase.rpc("admin_create_user", {
        p_email: email,
        p_password: password,
        p_display_name: name,
        p_role: role || "user",
        p_avatar: avatar || null,
      });
      if (rpcError) throw rpcError;

      document.getElementById("addMemberForm").reset();
      await loadMembers();
      await loadMembersList();
      showNotification(`✅ ${name} added! They can now log in with their email and password.`, "success");

    } catch (err) {
      console.error("Error adding member:", err);
      showNotification("Failed to add member: " + niceError(err), "error");
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  });


async function loadMembersList() {
  const container = document.getElementById("membersList");
  if (!container) return;
  container.innerHTML = '<div class="loading">Loading members...</div>';

  try {
    const { data: allRows, error } = await supabase
      .from("members")
      .select("*")
      .order("name");

    if (error) throw error;
    const members = (allRows || []).filter((m) => m.is_approved !== false); // pending signups live in the approvals card

    if (!members || members.length === 0) {
      container.innerHTML = '<div class="loading">No members yet</div>';
      return;
    }

    container.innerHTML = members
      .map((member) => {
        const isManager = member.role === "manager";
        const isAdmin = member.role === "admin";
        const hasLogin = member.user_id !== null;
        const isArchived = member.archived_from_cycle_id && parseInt(currentCycleId) >= member.archived_from_cycle_id;

        // --- FIXED AVATAR LOGIC (Inside the loop) ---
        const avatarHtml =
          member.avatar_url && member.avatar_url.trim() !== ""
            ? `<img src="${escapeHtml(member.avatar_url)}" style="width:45px; height:45px; border-radius:50%; object-fit:cover; border: 2px solid #e2e8f0;">`
            : `<div style="width:45px; height:45px; border-radius:50%; background:#f1f5f9; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:16px; color:#64748b; border: 2px solid #cbd5e1;">${escapeHtml(member.name[0].toUpperCase())}</div>`;

        return `
            <div class="list-item" style="flex-wrap: wrap; gap: 12px; align-items: center; padding: 15px; background: white; border-radius: 16px; margin-bottom: 10px; border: 1px solid #f1f5f9;">
                
                <!-- Avatar column -->
                <div style="flex-shrink: 0;">
                    ${avatarHtml}
                </div>

                <!-- Info column -->
                <div class="list-item-info" style="flex: 1; min-width: 150px;">
                    <div class="list-item-title" style="font-size: 15px; font-weight: 800;">
                        ${escapeHtml(member.name)} 
                        ${isAdmin ? '<span style="font-size:9px; background:#0f172a; color:white; padding:2px 6px; border-radius:6px; margin-left:5px;">ADMIN</span>' : ""}
                        ${isManager ? '<span style="font-size:9px; background:#10b981; color:white; padding:2px 6px; border-radius:6px; margin-left:5px;">MANAGER</span>' : ""}
                        ${isArchived ? '<span style="font-size:9px; background:#ef4444; color:white; padding:2px 6px; border-radius:6px; margin-left:5px;">ARCHIVED</span>' : ""}
                    </div>
                    <div class="list-item-subtitle" style="font-size: 11px;">
                        ${hasLogin ? '<span style="color:#10b981">● Active User</span>' : '<span style="color:#f59e0b">○ No Login Linked</span>'}
                    </div>
                </div>
                
                <!-- Actions column -->
                <div style="display: flex; gap: 8px;">
                    ${
                      !isAdmin
                        ? `
                    <button class="btn btn-sm ${isManager ? "btn-secondary" : "btn-success"}" 
                            style="font-size: 10px; padding: 6px 10px;"
                            onclick="toggleManagerRole('${member.id}', '${member.role}')">
                        ${isManager ? "Demote" : "Promote"}
                    </button>
                    `
                        : ""
                    }
                    
                    <button class="btn btn-sm btn-primary" 
                            style="font-size: 10px; padding: 6px 10px;"
                            onclick="openEditMemberModal('${member.id}')">
                        Edit
                    </button>
                    ${!isAdmin && !isArchived ? `<button class="btn btn-sm btn-danger" style="font-size: 10px; padding: 6px 10px;" onclick="archiveMember('${member.id}', '${escapeJsArg(member.name)}', '${member.user_id || ""}')">Archive</button>` : ""}
                    ${isArchived ? `<button class="btn btn-sm btn-success" style="font-size: 10px; padding: 6px 10px;" onclick="restoreMember(${member.id}, '${escapeJsArg(member.name)}')">↩ Restore</button>` : ""}
                </div>
            </div>
            `;
      })
      .join("");
  } catch (err) {
    console.error("Error loading members list:", err);
    container.innerHTML =
      '<div class="loading" style="color:red">Error loading list</div>';
  }
}

// --- Action 1: Toggle Manager Role ---
async function toggleManagerRole(memberId, currentRole) {
  const isManager = currentRole === "manager";
  const newRole = isManager ? "user" : "manager";
  const roleName = (allMembers.find((m) => m.id === memberId) || {}).name || "this member";
  const okRole = await uiConfirm(
    `Make ${roleName} ${newRole === "manager" ? "a manager" : "a normal user"}?`,
    newRole === "manager" ? "Managers can approve deposits/expenses, edit the tracker and manage meals." : "They will lose manager permissions.",
    { confirmText: "Change role" },
  );
  if (!okRole) return;

  try {
    const { error } = await supabase
      .from("members")
      .update({ role: newRole })
      .eq("id", memberId);
    if (error) throw error;

    const targetMember = allMembers.find((m) => m.id == memberId);
    const actor = currentUser.members ? currentUser.members.name : "Admin";

    // LOG ROLE CHANGE (Broadcast to everyone's browser)
    await logActivity(
      `📢 Role Update: ${targetMember.name} was ${isManager ? "demoted to User" : "appointed as Manager"} by ${actor}`,
      "other",
      null
    );

    showNotification("Role updated successfully", "success");
    await loadMembersList();
  } catch (err) {
    showNotification("Failed to update role", "error");
  }
}

// --- Action 2: Archive Member (Safe Deletion) ---
// --- Action 3: Restore an archived member (undo Archive) ---
async function restoreMember(memberId, memberName) {
  if (!isStaff()) {
    showNotification("Only an admin or manager can restore members.", "error");
    return;
  }
  const ok = await uiConfirm(
    `Restore ${memberName} to the mess?`,
    "They come back into the current cycle: they appear in all lists, can log in again, and get schedule cards from the current session using their default meals. Their old history is kept.",
    { icon: "↩️", confirmText: "Restore member" },
  );
  if (!ok) return;

  const btn = event?.target?.closest("button");
  if (btn) { btn.disabled = true; btn.textContent = "Restoring…"; }
  try {
    // The database notifies everyone ("Restored to the mess") and records it in the audit log
    const { error } = await supabase.from("members").update({ archived_from_cycle_id: null }).eq("id", memberId);
    if (error) throw error;

    // Create their schedule cards for the coming sessions right away
    await supabase.rpc("manage_meal_plans", { target_date: getStrictSessionDate() });

    showNotification(`${memberName} is back in the mess`, "success");
    await loadMembers();
    await loadMembersList();
    pageLoaded.dashboard = false;
    pageLoaded.summary = false;
    pageLoaded.tracker = false;
  } catch (err) {
    showNotification("Could not restore: " + niceError(err), "error");
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.textContent = "↩ Restore"; }
  }
}

async function archiveMember(memberId, memberName, userId) {
  const okArchive = await uiConfirm(
    `Remove ${memberName} from the mess?`,
    "They are archived from the current and future cycles. Their history stays. Their balance must be settled first.",
    { danger: true, confirmText: "Archive member" },
  );
  if (!okArchive) return;

  try {
    showNotification("Validating balances...", "info");

    const sessionDateStr = toLocalISO(await getActiveSessionDate());
    // 1. Calculate Current Balance natively
    const [duesRes, myDepsRes, mealsRes, expsRes, allMealsRes] = await Promise.all([
      supabase.from("cycle_dues").select("due_amount, settled_amount").eq("member_id", memberId).neq("status", "settled"),
      supabase.from("deposits").select("amount").eq("member_id", memberId).eq("cycle_id", currentCycleId).neq("status", "pending"),
      supabase.from("meals").select("*").eq("member_id", memberId).eq("cycle_id", currentCycleId),
      supabase.from("expenses").select("amount").eq("cycle_id", currentCycleId).eq("status", "approved"),
      supabase.from("meals").select("*").eq("cycle_id", currentCycleId)
    ]);

    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    const cycleStartDate = allCycles.find(c => c.id == currentCycleId)?.start_date;
    
    const totalExp = expsRes.data?.reduce((s, e) => s + parseFloat(e.amount), 0) || 0;
    const totalGlobalMeals = adjustMealTotal(allMealsRes.data || [], boundaryMeals, cycleStartDate) || 1;
    const mealRate = totalExp / totalGlobalMeals;

    const myDeposit = myDepsRes.data?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;
    const myMealCost = adjustMealTotal(mealsRes.data || [], boundaryMeals, cycleStartDate, memberId) * mealRate;
    
    // Balance calculation identically to status badge
    const myBalance = myDeposit - myMealCost;

    // 2. Sum historical unpaid dues (Negative is debt, positive is credit)
    let historicalDue = 0;
    duesRes.data?.forEach(d => {
        const netDueForRecord = Math.abs(d.due_amount) - Math.abs(d.settled_amount || 0);
        if (d.due_amount < 0) historicalDue -= netDueForRecord; // Debt
        else historicalDue += netDueForRecord; // Credit awaiting settlement
    });

    const totalNetStatus = historicalDue + myBalance;

    if (totalNetStatus < -2 || totalNetStatus > 2) {
      showNotification(`Cannot remove ${memberName}. Net balance across all cycles is ${totalNetStatus < 0 ? "-" : ""}৳${Math.abs(totalNetStatus).toFixed(2)}. Must be settled to ±৳2.`, "error");
      return;
    }

    // Validation Passed. Archive Member.
    const { error: mError } = await supabase
      .from("members")
      .update({ archived_from_cycle_id: parseInt(currentCycleId) })
      .eq("id", memberId);

    if (mError) throw mError;
    

    showNotification(`${memberName} successfully archived.`, "success");
    await loadMembers(); 
    await loadMembersList(); 
  } catch (err) {
    console.error("Archive error:", err);
    if (err.message && err.message.includes("archived_from_cycle_id")) {
        showNotification("CRITICAL: 'archived_from_cycle_id' column missing in Supabase. Check Admin Guide.", "error");
    } else {
        showNotification(err.message, "error");
    }
  }
}

// --- Action 3: Edit Member (Modal & Save) ---
async function openEditMemberModal(memberId) {
  // 1. Try allMembers first (full global list, always loaded)
  let m = allMembers.find(mem => mem.id == memberId);
  // 2. If not found, try appState.members
  if (!m) m = appState.members.find(mem => mem.id == memberId);
  // 3. Final fallback: fetch directly from Supabase
  if (!m) {
    try {
      const { data } = await supabase.from("members").select("*").eq("id", memberId).maybeSingle();
      if (data) m = data;
    } catch (err) {
      console.error("Fallback member fetch failed:", err);
    }
  }

  if (!m) {
    showNotification("Member data not found. Please reload the page.", "error");
    return;
  }

  // Populate base fields
  document.getElementById("editMemberId").value = m.id;
  document.getElementById("editUserId").value = m.user_id || "";
  document.getElementById("editMemberName").value = m.name || "";
  document.getElementById("editMemberEmail").value = m.email || "";
  document.getElementById("editAuthEmail").value = ""; // will be fetched
  document.getElementById("editMemberAvatar").value = m.avatar_url || "";
  document.getElementById("editMemberRole").value = m.role || "user";
  document.getElementById("editMemberPassword").value = "";

  // Hide mismatch banner while loading
  document.getElementById("emailMismatchBanner").style.display = "none";

  // Reset title
  document.querySelector("#editMemberModal .modal-title").textContent = "Edit Member Details";
  document.getElementById("editMemberModal").classList.add("active");

  // Fetch the REAL Auth email via RPC (runs after modal opens for responsiveness)
  if (m.user_id) {
    try {
      const { data: authData, error: authErr } = await supabase.rpc("admin_get_user_email", {
        target_user_id: m.user_id
      });

      const realAuthEmail = authData || "";
      document.getElementById("editAuthEmail").value = realAuthEmail;

      // Check for mismatch
      const memberEmail = (m.email || "").toLowerCase().trim();
      const authEmail = realAuthEmail.toLowerCase().trim();

      if (authEmail && memberEmail && authEmail !== memberEmail) {
        document.getElementById("emailMismatchBanner").style.display = "block";
        document.getElementById("emailMismatchDetail").textContent =
          `Auth Login: "${realAuthEmail}" vs Member Record: "${m.email}" — Fix by clicking "↺ Copy from Auth" then Save.`;
      }
    } catch (err) {
      console.warn("Could not fetch auth email (RPC may not exist):", err.message);
      // Fallback: just show member email in both fields
      document.getElementById("editAuthEmail").value = m.email || "";
    }
  } else {
    document.getElementById("editAuthEmail").value = "No linked auth account";
  }
}

// Helper: Copy Auth email into the Members Table email field
function syncEmailFromAuth() {
  const authEmail = document.getElementById("editAuthEmail").value.trim();
  if (authEmail && authEmail !== "No linked auth account") {
    document.getElementById("editMemberEmail").value = authEmail;
    document.getElementById("emailMismatchBanner").style.display = "none";
    showNotification("Profile email updated. Click Save to apply.", "info");
  }
}

document
  .getElementById("editMemberForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    // 1. Get all form values
    const memberId = document.getElementById("editMemberId").value;
    const userId = document.getElementById("editUserId").value;
    const newName = document.getElementById("editMemberName").value.trim();
    const newMemberEmail = document.getElementById("editMemberEmail").value.trim();
    const newAuthEmail = document.getElementById("editAuthEmail").value.trim();
    const newAvatar = document.getElementById("editMemberAvatar").value.trim();
    const newRole = document.getElementById("editMemberRole").value;
    const newPassword = document.getElementById("editMemberPassword").value;

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;

    // 2. Lock UI
    submitBtn.innerHTML = "⏳ Saving...";
    submitBtn.disabled = true;

    try {
      // --- A. Update members table ---
      const { error: mError } = await supabase
        .from("members")
        .update({
          name: newName,
          email: newMemberEmail,
          avatar_url: newAvatar,
          role: newRole
        })
        .eq("id", memberId);

      if (mError) throw mError;

      // --- B. Sync Auth email if it changed ---
      const isValidUserId = userId && userId !== "null" && userId !== "undefined";
      if (isValidUserId && newAuthEmail && newAuthEmail !== "No linked auth account") {
        // Update own auth email
        if (currentUser && currentUser.id === userId) {
          const { error: ownAuthErr } = await supabase.auth.updateUser({ email: newAuthEmail });
          if (ownAuthErr) {
            showNotification("⚠️ Members table updated but auth email change failed: " + ownAuthErr.message, "warning");
          } else {
            dlog("Updated own auth email.");
          }
        } else {
          // Update other user's auth email via admin RPC
          try {
            const { error: rpcErr } = await supabase.rpc("admin_update_user_email", {
              target_user_id: userId,
              new_email: newAuthEmail
            });
            if (rpcErr) {
              showNotification("⚠️ Members table saved but Auth email update failed: " + rpcErr.message, "warning");
            } else {
              dlog("Admin updated auth email via RPC.");
            }
          } catch (rpcEx) {
            console.warn("admin_update_user_email RPC not found – skipping auth email sync:", rpcEx.message);
          }
        }
      }

      // --- C. Handle password change ---
      if (newPassword && newPassword.trim() !== "") {
        if (!isValidUserId) {
          throw new Error("This member has no linked User Account, so the password cannot be changed.");
        }

        if (currentUser && currentUser.id === userId) {
          const { error: authError } = await supabase.auth.updateUser({ password: newPassword });
          if (authError) throw authError;
        } else {
          const { error: rpcError } = await supabase.rpc("admin_reset_password", {
            target_user_id: userId,
            new_password: newPassword,
          });
          if (rpcError) throw rpcError;
        }
      }

      // --- D. Log & notify ---
      const actor = currentUser.name || "Admin";
      await logActivity(`Profile Update: ${newName}'s details updated by ${actor}`, "other");

      document.getElementById("editMemberModal").classList.remove("active");
      showNotification("✅ Member updated successfully", "success");

      // Refresh lists
      await loadMembersList();
      await loadMembers();

      // If updating self, update in-memory currentUser
      if (currentUser.member_id == memberId) {
        currentUser.name = newName;
        currentUser.role = newRole;
        document.getElementById("profileName").textContent = newName;
        document.getElementById("headerUserName").textContent =
          `${newName} (${newRole.toUpperCase()})`;
      }
    } catch (err) {
      console.error("Edit error:", err);
      showNotification("Update failed: " + err.message, "error");
    } finally {
      submitBtn.innerHTML = originalText;
      submitBtn.disabled = false;
    }
  });



// ============================================
// UTILITY: LOG ACTIVITY
// ============================================

// Helper for whole number currency display
function formatCurrencyRound(amount) {
  return `৳${Math.round(parseFloat(amount || 0))}`;
}

// [REMOVED] Duplicate logActivity — the correct version is defined earlier in the file.

async function triggerManualAutoEntry() {
  const okRun = await uiConfirm(
    "Send meal count to the tracker now?",
    "Copies today's Night and tomorrow's Day from the schedule cards into the tracker (overwriting what is there) and creates today's meal-count report.",
    { icon: "📋", confirmText: "Send now" },
  );
  if (!okRun) return;

  const btn = document.querySelector(
    'button[onclick="triggerManualAutoEntry()"]',
  );
  const originalText = btn.textContent;
  btn.textContent = "Running...";
  btn.disabled = true;

  try {
    // Call the RPC function with force_run = true
    const { error } = await supabase.rpc("handle_auto_meal_entry", {
      force_run: true,
    });

    if (error) throw error;

    showNotification("✅ Meal count sent to the tracker", "success");
    await updateEntryStatusIndicator(); // <--- REFRESH BADGE IMMEDIATELY
    await loadDashboard(); // Reload logs
    await loadMasterTracker(); // Update tracker view if looking at it
    loadMealReports();
  } catch (err) {
    console.error("Force Run Error", err);
    showNotification("Failed to run automation: " + niceError(err), "error");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ==========================================
// ENTRY STATUS INDICATOR LOGIC
// ==========================================

// Global rotation variables moved to top of file

async function updateEntryStatusIndicator() {
  const badge = document.getElementById("entryStatusBadge");
  if (!badge || !currentCycleId || !currentUser?.member_id) return;

  try {
    const today = new Date();
    const sessionDate = await getActiveSessionDate();
    const dateLabel = sessionDate
      .toLocaleDateString("en-GB", { day: "numeric", month: "short" })
      .toUpperCase();

    // 1. FETCH DATA
    const [expRes, allMealsRes, myMealsRes, myDepsRes, duesRes] =
      await Promise.all([
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
          .from("cycle_dues")
          .select("due_amount, settled_amount")
          .eq("member_id", currentUser.member_id)
          .eq("to_cycle_id", currentCycleId)
          .neq("status", "settled"),
      ]);

    // 2. CALCULATE CURRENT BALANCE (Session-Corrected)
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    const cycleStartDate = allCycles.find(c => c.id == currentCycleId)?.start_date;
    const totalExp =
      expRes.data?.reduce((s, e) => s + parseFloat(e.amount), 0) || 0;
    const totalGlobalMeals = adjustMealTotal(allMealsRes.data || [], boundaryMeals, cycleStartDate) || 1;
    const mealRate = totalExp / totalGlobalMeals;

    const myDeposit =
      myDepsRes.data?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;
    const myMealCost = adjustMealTotal(myMealsRes.data || [], boundaryMeals, cycleStartDate, currentUser.member_id) * mealRate;

    // Use Math.ceil to avoid -0.01 issues
    const myBalance = Math.ceil(myDeposit - myMealCost);

    // 3. CALCULATE PREVIOUS DUE (Only negative amounts = Debt)
    const prevDebt =
      duesRes.data
        ?.filter((d) => d.due_amount < 0)
        .reduce(
          (s, d) => s + (Math.abs(d.due_amount) - Math.abs(d.settled_amount)),
          0,
        ) || 0;

    // 4. BUILD THE ROTATION QUEUE
    const newQueue = [];

    // CONDITION 1: Target
    const isToday =
      sessionDate.getDate() === today.getDate() &&
      sessionDate.getMonth() === today.getMonth();
    newQueue.push({
      text: `TARGET: ${dateLabel} BAZAR`,
      class: isToday ? "status-pending" : "status-done",
    });

    // CONDITION 2 & 4: Add Current Debt Card if negative
    if (myBalance < -1) {
      const debtAmount = toBn(Math.round(Math.abs(myBalance)));
      newQueue.push({
        text: `DEBT: -৳${debtAmount}`, // Added negative sign here
        class: "status-debt",
      });
    }

    // CONDITION 3 & 4: Add Past Due Card if exists
    if (prevDebt > 1) {
      const pastDueAmount = toBn(Math.round(prevDebt));
      newQueue.push({
        text: `PAST DUE: -৳${pastDueAmount}`, // Added negative sign here
        class: "status-due",
      });
    }

    // --- CRITICAL FIX: PREVENT ANIMATION RESET ---
    // We compare the new queue with the old one. If they are identical,
    // we DO NOT reset the interval. This stops the "blink" issue.
    const currentQueueStr = JSON.stringify(statusQueue);
    const newQueueStr = JSON.stringify(newQueue);

    if (currentQueueStr === newQueueStr && statusCycleInterval) {
      return; // Nothing changed, let it keep rotating smoothly
    }

    // If data changed, update state and restart timer
    if (statusCycleInterval) clearInterval(statusCycleInterval);

    statusQueue = newQueue;
    currentStatusIndex = 0;

    // Apply first item immediately
    applyBadgeState(statusQueue[0]);

    // Start rotation only if we have 2+ items (Condition 2, 3, 4)
    if (statusQueue.length > 1) {
      statusCycleInterval = setInterval(rotateStatusBadge, 3000); // 3 Seconds
    }
  } catch (err) {
    console.error("Badge Sync Error:", err);
  }
}

function applyBadgeState(state) {
  const badge = document.getElementById("entryStatusBadge");
  badge.style.opacity = "1";
  badge.style.transform = "translateY(0)";
  badge.textContent = state.text;
  badge.className = `entry-status-badge ${state.class}`;
}

function rotateStatusBadge() {
  const badge = document.getElementById("entryStatusBadge");
  if (!badge || statusQueue.length <= 1) return;

  // Transition Out
  badge.style.opacity = "0";
  badge.style.transform = "translateY(-8px)";

  setTimeout(() => {
    currentStatusIndex = (currentStatusIndex + 1) % statusQueue.length;
    const state = statusQueue[currentStatusIndex];

    badge.textContent = state.text;
    badge.className = `entry-status-badge ${state.class}`;

    // Transition In
    badge.style.opacity = "1";
    badge.style.transform = "translateY(0)";
  }, 600); // Duration of the "disappeared" state
}

async function loadSystemStatus() {
  const container = document.getElementById("systemStatusContent");
  const dateDisplay = document.getElementById("statusDateDisplay");

  // 1. Get Today's Date (Local/BD)
  const now = new Date();
  const todayStr = toLocalISO(now);
  const niceDate = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  if (dateDisplay) dateDisplay.textContent = niceDate;

  try {
    // 2. Fetch Log for Today
    const { data: log, error } = await supabase
      .from("system_logs")
      .select("*")
      .eq("log_date", todayStr)
      .maybeSingle();

    // 3. Render State
    if (log) {
      // === STATE: SUCCESS ===
      const runTime = new Date(log.executed_at).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });

      container.innerHTML = `
                <div class="status-box success">
                    <div>
                        <div class="status-title">System Auto-Entry Completed, RUN TIME: ${runTime}</div>
                    </div>
                </div>
            `;
    } else {
      // === STATE: PENDING ===
      // Get target time from our config variable
      const targetTime24 = appConfig.auto_entry_time || "18:30";
      const [h, m] = targetTime24.split(":");
      const targetTime12 = new Date(0, 0, 0, h, m).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });

      container.innerHTML = `
                <div class="status-box pending">
                    <div>
                        <div class="status-meta">
                            SCHEDULED TIME: ${targetTime12}
                        </div>
                    </div>
                </div>
            `;
    }
  } catch (err) {
    console.error("Status Load Error", err);
    container.innerHTML =
      '<div style="color:red; font-size:12px;">Failed to load status.</div>';
  }
}
