// MealCal Pro — Cycle closing + due settlement
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// CYCLE CLOSING & DUE MANAGEMENT
// ============================================
// ============================================
// REFINED CYCLE CLOSING LOGIC
// ============================================

const monthNames = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// 1. Open the Modal and Pre-fill
// document.getElementById('closeMonthBtn').addEventListener('click', () => {
//     const modal = document.getElementById('cycleCloseModal');
//     const monthSelect = document.getElementById('newCycleMonth');
//     const yearInput = document.getElementById('newCycleYear');

//     // Populate Month Dropdown
//     monthSelect.innerHTML = monthNames.map((m, i) => `<option value="${i}">${m}</option>`).join('');

//     // Auto-select based on Old Cycle end date + 1 day
//     const currentCycle = allCycles.find(c => c.id == currentCycleId);
//     let targetDate = new Date();
//     if (currentCycle) {
//         targetDate = parseLocalDate(currentCycle.end_date);
//         targetDate.setDate(targetDate.getDate() + 1);
//     }

//     monthSelect.value = targetDate.getMonth();
//     yearInput.value = targetDate.getFullYear();

//     updateCycleFields(); // Trigger first calculation
//     modal.classList.add('active');
// });

// ==========================================
// STRICT CYCLE CLOSING LOGIC
// ==========================================

// 1. Trigger the Check when button clicked
document.getElementById("closeMonthBtn").addEventListener("click", () => {
  const modal = document.getElementById("cycleCloseModal");
  modal.classList.add("active");

  // Reset UI
  document.getElementById("cycleValidationArea").style.display = "block";
  document.getElementById("cycleCloseForm").style.display = "none";
  document.getElementById("cycleCloseForm").style.opacity = "0";
  document.getElementById("cycleBlockedMsg").style.display = "none";

  runCycleDiagnostics();
});

// 2. Main Diagnostic Function
async function runCycleDiagnostics() {
  const listEl = document.getElementById("checklistItems");
  const hintEl = document.getElementById("balanceFixHint");
  listEl.innerHTML = '<div class="loading">Calculating financials...</div>';
  hintEl.style.display = "none";

  try {
    // --- STEP A: FETCH DATA ---
    const [pendDep, pendExp, allExp, allDep, activeDues] = await Promise.all([
      // 1. Pending Deposits Count
      supabase
        .from("deposits")
        .select("*", { count: "exact", head: true })
        .eq("cycle_id", currentCycleId)
        .eq("status", "pending"),
      // 2. Pending Expenses Count
      supabase
        .from("expenses")
        .select("*", { count: "exact", head: true })
        .eq("cycle_id", currentCycleId)
        .eq("status", "pending"),
      // 3. Approved Expenses Sum
      supabase
        .from("expenses")
        .select("amount")
        .eq("cycle_id", currentCycleId)
        .eq("status", "approved"),
      // 4. Approved Deposits Sum
      supabase
        .from("deposits")
        .select("amount")
        .eq("cycle_id", currentCycleId)
        .neq("status", "pending"),

      // 5. Outstanding Dues (FETCH ACTUAL ROWS NOW INSTEAD OF COUNTING)
      supabase
        .from("cycle_dues")
        .select("due_amount, settled_amount")
        .eq("to_cycle_id", currentCycleId)
        .neq("status", "settled"),
    ]);

    // --- STEP B: CALCULATE ---
    const pendingDepositsCount = pendDep.count || 0;
    const pendingExpensesCount = pendExp.count || 0;

    // NEW: Filter out fractional un-settlements just like the frontend UI does
    const activeDuesList =
      activeDues.data?.filter((d) => {
        const remaining = Math.abs(d.due_amount) - Math.abs(d.settled_amount);
        return remaining >= 1; // Only flag as unsettled if they owe 1 Taka or more
      }) || [];

    // Count only the truly active dues
    const outstandingDuesCount = activeDuesList.length;

    const totalExpenses =
      allExp.data?.reduce((sum, item) => sum + parseFloat(item.amount), 0) || 0;
    const totalDeposits =
      allDep.data?.reduce((sum, item) => sum + parseFloat(item.amount), 0) || 0;

    // Net Cash in Hand (Must be 0)
    const netBalance = totalDeposits - totalExpenses;
    // Allow a tiny margin for float rounding error (0.1)
    const isBalanceZero = Math.abs(netBalance) < 0.1;

    // --- STEP C: RENDER CHECKLIST ---
    const checks = [
      {
        label: "Pending Deposits",
        val: pendingDepositsCount,
        pass: pendingDepositsCount === 0,
        text:
          pendingDepositsCount === 0
            ? "0 (Clean)"
            : `${pendingDepositsCount} Pending`,
      },
      {
        label: "Pending Expenses",
        val: pendingExpensesCount,
        pass: pendingExpensesCount === 0,
        text:
          pendingExpensesCount === 0
            ? "0 (Clean)"
            : `${pendingExpensesCount} Pending`,
      },
      {
        label: "Unsettled Past Dues",
        val: outstandingDuesCount,
        pass: outstandingDuesCount === 0,
        text:
          outstandingDuesCount === 0
            ? "All Settled"
            : `${outstandingDuesCount} Unpaid`,
      },
      {
        label: "Net Cash Balance",
        val: netBalance,
        pass: isBalanceZero,
        text: `৳${parseFloat(netBalance.toFixed(2))}`,
      },
    ];

    let allPassed = true;
    let html = "";

    checks.forEach((c) => {
      if (!c.pass) allPassed = false;
      html += `
                <div class="check-item">
                    <span class="check-label">${c.label}</span>
                    <span class="check-status ${c.pass ? "status-pass" : "status-fail"}">
                        ${c.pass ? "✔" : "✖"} ${c.text}
                    </span>
                </div>
            `;
    });

    listEl.innerHTML = html;

    // --- STEP D: HANDLE BALANCE FIX HINT ---
    if (!isBalanceZero) {
      hintEl.style.display = "block";
      if (netBalance > 0) {
        // Surplus: Need to carry forward or refund
        hintEl.innerHTML = `💡 <strong>Surplus Funds: ৳${netBalance.toFixed(2)}</strong><br>You have extra cash. Please add an Expense entry labeled "Carry Forward to Next Month" for exactly ৳${netBalance.toFixed(2)} to zero this out.`;
      } else {
        // Deficit: Manager spent from pocket
        hintEl.innerHTML = `💡 <strong>Deficit: ৳${Math.abs(netBalance).toFixed(2)}</strong><br>The mess owes money (Negative Balance). Please add a Deposit entry labeled "Manager Input" for ৳${Math.abs(netBalance).toFixed(2)} to balance the books.`;
      }
    }

    // --- STEP E: UNLOCK FORM OR BLOCK ---
    if (allPassed) {
      document.getElementById("cycleBlockedMsg").style.display = "none";
      initNextCycleForm(); // Pre-fill dates
    } else {
      document.getElementById("cycleBlockedMsg").style.display = "block";
    }
  } catch (err) {
    console.error("Diagnostic Error:", err);
    listEl.innerHTML =
      '<div style="color:red">Diagnostics failed. Check console.</div>';
  }
}

// 3. Helper to Show/Init the Form
function initNextCycleForm() {
  const form = document.getElementById("cycleCloseForm");
  form.style.display = "block";

  // Small delay for animation
  setTimeout(() => (form.style.opacity = "1"), 50);

  // Populate Date Pickers (Same as before)
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const monthSelect = document.getElementById("newCycleMonth");
  const yearInput = document.getElementById("newCycleYear");

  // Fill Month Dropdown if empty
  if (monthSelect.options.length === 0) {
    monthSelect.innerHTML = monthNames
      .map((m, i) => `<option value="${i}">${m}</option>`)
      .join("");
  }

  // Auto-select based on Old Cycle end date + 1 day
  const currentCycle = allCycles.find((c) => c.id == currentCycleId);
  let targetDate = new Date();
  if (currentCycle) {
    targetDate = parseLocalDate(currentCycle.end_date);
    targetDate.setDate(targetDate.getDate() + 1);
  }

  monthSelect.value = targetDate.getMonth();
  yearInput.value = targetDate.getFullYear();

  updateCycleFields(); // Trigger date calculation
}

// 2. Helper to calculate dates when Month/Year changes
function updateCycleFields() {
  const month = parseInt(document.getElementById("newCycleMonth").value);
  const year = parseInt(document.getElementById("newCycleYear").value);

  // Calculate first and last day of selected month
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0); // Day 0 of next month is last day of this month

  // Format for inputs (YYYY-MM-DD)
  document.getElementById("newCycleStart").value = toLocalISO(firstDay);
  document.getElementById("newCycleEnd").value = toLocalISO(lastDay);
  document.getElementById("newCycleName").value =
    `${monthNames[month]} ${year}`;
}

// Attach change listeners
document
  .getElementById("newCycleMonth")
  .addEventListener("change", updateCycleFields);
document
  .getElementById("newCycleYear")
  .addEventListener("change", updateCycleFields);

// 3. Handle the Final Submission
document
  .getElementById("cycleCloseForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    if (
      !(await uiConfirm(
        "Close this cycle and start the new one?",
        "Final balances are calculated, dues are carried forward and everyone moves to the new cycle. This cannot be undone.",
        { danger: true, confirmText: "Close cycle" },
      ))
    )
      return;

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = "Processing Balances...";
    btn.disabled = true;

    try {
      const name = document.getElementById("newCycleName").value;
      const start = document.getElementById("newCycleStart").value;
      const end = document.getElementById("newCycleEnd").value;

      // A. Calculate final balances of the cycle being closed
      const balances = await calculateMemberBalances(currentCycleId);
      const balancesWithDues = balances.filter((b) => b.balance !== 0);

      // B. Deactivate current cycle
      const { error: deacError } = await supabase
        .from("cycles")
        .update({ is_active: false })
        .eq("id", currentCycleId);
      if (deacError) throw deacError;

      // C. Create new cycle
      const { data: newCycle, error: cycError } = await supabase
        .from("cycles")
        .insert({ name, start_date: start, end_date: end, is_active: true })
        .select()
        .single();
      if (cycError) throw cycError;

      // D. Forward Dues (Debt/Credit)
      if (balancesWithDues.length > 0) {
        const dueRecords = balancesWithDues.map((b) => ({
          from_cycle_id: currentCycleId,
          to_cycle_id: newCycle.id,
          member_id: b.member_id,
          due_amount: b.balance,
          status: "pending",
          settled_amount: 0,
        }));
        const { error: dueError } = await supabase
          .from("cycle_dues")
          .insert(dueRecords);
        if (dueError) throw dueError;
      }

      // Success Cleanup
      const actor = currentUser.members ? currentUser.members.name : "Admin";
      await logActivity(
        `📊 Monthly Cycle Settled: Cycle "${name}" (${start} to ${end}) finalized by ${actor}! All balances & carried dues calculated.`,
        "cycle",
        null
      );
      showNotification("Cycle finalized successfully!", "success");
      location.reload(); // Hard refresh to reset all state
    } catch (err) {
      console.error(err);
      showNotification(err.message, "error");
      btn.textContent = "Confirm & Finalize";
      btn.disabled = false;
    }
  });

// Helper: Calculate member balances for current cycle
async function calculateMemberBalances(cycleId) {
  try {
    // Fetch data
    const { data: meals } = await supabase
      .from("meals")
      .select("*")
      .eq("cycle_id", cycleId);
    // Find this part in calculateMemberBalances(cycleId)
    const { data: expenses } = await supabase
      .from("expenses")
      .select("*")
      .eq("cycle_id", cycleId)
      .eq("status", "approved"); // <--- ADD THIS FILTER
    // Change the deposit query to:
    const { data: deposits } = await supabase
      .from("deposits")
      .select("*")
      .eq("cycle_id", cycleId)
      .neq("status", "pending"); // <--- ADD THIS FILTER

    // Calculate meal rate (Session-Corrected)
    const boundaryMeals = await fetchBoundaryDayMeals(cycleId);
    const cycle = allCycles.find(c => c.id == cycleId);
    const cycleStartDate = cycle?.start_date;
    const totalExpense =
      expenses?.reduce((sum, e) => sum + parseFloat(e.amount), 0) || 0;
    const totalMeals = adjustMealTotal(meals || [], boundaryMeals, cycleStartDate);
    const mealRate = totalMeals > 0 ? totalExpense / totalMeals : 0;

    // Calculate per-member balances
    const balances = [];
    allMembers.forEach((member) => {
      const memberMeals = adjustMealTotal(meals || [], boundaryMeals, cycleStartDate, member.id);

      const memberDeposits =
        deposits
          ?.filter((d) => d.member_id === member.id)
          .reduce((sum, d) => sum + parseFloat(d.amount), 0) || 0;

      const memberCost = memberMeals * mealRate;
      const balance = memberDeposits - memberCost;

      balances.push({
        member_id: member.id,
        member_name: member.name,
        balance: parseFloat(balance.toFixed(2)),
      });
    });

    return balances;
  } catch (err) {
    console.error("Balance calculation error:", err);
    throw err;
  }
}

// ============================================
// DUE SETTLEMENT UI
// ============================================

// ==========================================
// LOAD DUE SETTLEMENT (WITH THRESHOLD)
// ==========================================

async function loadDueSettlement() {
  dlog("🔍 Loading due settlement for cycle:", currentCycleId);

  if (!currentCycleId) {
    // Hide card if no cycle
    const card = document.getElementById("dueSettlementCard");
    if (card) card.style.display = "none";
    return;
  }

  try {
    // Fetch dues for current cycle
    const { data: dues, error } = await supabase
      .from("cycle_dues")
      .select(
        "*, members(name), from_cycle:cycles!cycle_dues_from_cycle_id_fkey(name)",
      )
      .eq("to_cycle_id", currentCycleId)
      .order("due_amount", { ascending: true });

    if (error) throw error;

    const card = document.getElementById("dueSettlementCard");
    if (!card) return;

    // --- FILTER LOGIC (THE FIX) ---
    const activeDues =
      dues?.filter((d) => {
        // 1. Ignore if explicitly marked 'settled'
        if (d.status === "settled") return false;

        // 2. Calculate Real Remaining Amount
        // (Using absolute values handles both Debtors[-] and Creditors[+])
        const remaining = Math.abs(d.due_amount) - Math.abs(d.settled_amount);

        // 3. THRESHOLD CHECK:
        // If remaining amount is less than 1 Taka, hide it (treat as settled)
        if (remaining < 1) return false;

        return true;
      }) || [];

    // --- SHOW/HIDE CARD ---
    if (activeDues.length === 0) {
      card.style.display = "none";
      return;
    }

    card.style.display = "block";

    // Split Data
    const debtors = activeDues.filter((d) => d.due_amount < 0);
    const creditors = activeDues.filter((d) => d.due_amount > 0);

    // Render Debtors (People who owe money)
    const debtorsList = document.getElementById("debtorsList");
    if (debtors.length === 0) {
      debtorsList.innerHTML =
        '<div style="text-align:center; padding:15px; font-size:11px; color:var(--text-secondary);">No significant debts</div>';
    } else {
      debtorsList.innerHTML = debtors
        .map((d) => renderDueItem(d, "debtor"))
        .join("");
    }

    // Render Creditors (People owed money)
    const creditorsList = document.getElementById("creditorsList");
    if (creditors.length === 0) {
      creditorsList.innerHTML =
        '<div style="text-align:center; padding:15px; font-size:11px; color:var(--text-secondary);">No pending credits</div>';
    } else {
      creditorsList.innerHTML = creditors
        .map((d) => renderDueItem(d, "creditor"))
        .join("");
    }
  } catch (err) {
    console.error("Due settlement error:", err);
  }
}

function renderDueItem(due, type) {
  const absAmount = Math.abs(due.due_amount);
  const settled = Math.abs(due.settled_amount);
  const remaining = absAmount - settled;
  const progress = (settled / absAmount) * 100;

  const statusClass =
    due.status === "pending"
      ? "due-status-pending"
      : due.status === "settling"
        ? "due-status-settling"
        : "due-status-settled";

  return `
    <div class="due-item ${type}">
        <div class="due-item-header">
            <div class="due-item-name">${escapeHtml(due.members.name)}</div>
            <div class="due-item-amount ${type === "debtor" ? "balance-negative" : "balance-positive"}">
                ${formatCurrency(remaining)}
            </div>
        </div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 5px;">
            From: ${escapeHtml(due.from_cycle.name)} 
            <span class="due-status-badge ${statusClass}">${due.status}</span>
        </div>
        <div class="due-progress-bar">
            <div class="due-progress-fill" style="width: ${progress}%"></div>
        </div>
        <div style="font-size: 10px; color: var(--text-secondary); margin-top: 4px;">
            Settled: ${formatCurrency(settled)} / ${formatCurrency(absAmount)} (${progress.toFixed(0)}%)
        </div>
    </div>
    `;
}

// [REMOVED] loadSummary override — loadDueSettlement is already called inside loadSummary directly.
