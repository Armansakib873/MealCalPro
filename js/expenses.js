// MealCal Pro — Expenses page: list, approval, edit form
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ==========================================
// EXPENSE APPROVAL HANDLER (GLOBAL)
// ==========================================

// Explicitly attach to 'window' to ensure HTML buttons can find it
// Attach to window so HTML onClick works

// Global lock to prevent double clicks on admin actions
let isProcessingApproval = false;

window.handleExpenseApproval = async function (expenseId, newStatus) {
  if (isProcessingApproval) return;
  if (!isStaff()) {
    showNotification("Permission Denied", "error");
    return;
  }
  const btn = event?.target?.closest("button");
  if (newStatus === "rejected") {
    const ok = await uiConfirm("Reject this expense request?", "It will not count in the meal rate. The shopper is notified.", { danger: true, confirmText: "Reject" });
    if (!ok) return;
  }
  isProcessingApproval = true;
  const originalText = btn?.textContent;
  if (btn) { btn.textContent = "..."; btn.disabled = true; }
  try {
    // The database writes the approval/rejection notification (with who did it)
    const { error } = await supabase.from("expenses").update({ status: newStatus }).eq("id", expenseId).eq("status", "pending");
    if (error) throw error;
    if (newStatus === "approved") {
      showNotification("Expense approved", "success");
    } else {
      showNotification("Expense request rejected", "warning");
    }
    await loadExpenses();
    loadDashboard();
  } catch (err) {
    showNotification(niceError(err), "error");
  } finally {
    isProcessingApproval = false; // was never reset before → later approvals silently did nothing
    if (btn && document.body.contains(btn)) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

const EXP_CAT_ICON = { Bazar: "🥬", Gas: "🔥", Utilities: "💡", Snacks: "🍪", Transport: "🛺", Other: "📦" };

async function loadExpenses() {
  const historyContainer = document.getElementById("expenseList");
  const pendingContainer = document.getElementById("pendingExpensesList");
  const pendingCard = document.getElementById("pendingExpensesCard");
  if (!currentCycleId || !historyContainer) return;

  try {
    const { data: expenses, error } = await supabase
      .from("expenses")
      .select("*, members(name)")
      .eq("cycle_id", currentCycleId)
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    window._expenseCache = expenses || [];

    // ---- Pending requests ----
    const pendingItems = window._expenseCache.filter((e) => e.status === "pending");
    pendingCard.style.display = pendingItems.length ? "block" : "none";
    const staff = isStaff();
    pendingContainer.innerHTML = pendingItems
      .map((exp) => {
        const dateStr = parseLocalDate(exp.expense_date).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        const mine = exp.created_by && exp.created_by === currentUser?.member_id;
        const fresh = Date.now() - new Date(exp.created_at).getTime() < 10 * 60 * 1000;
        const footer = staff
          ? `<div class="pending-actions">
               <button class="btn-mobile-action btn-approve" onclick="handleExpenseApproval('${exp.id}', 'approved')">✓ Approve</button>
               <button class="btn-mobile-action btn-reject" onclick="handleExpenseApproval('${exp.id}', 'rejected')">✕ Reject</button>
             </div>`
          : `<div class="pending-status-label">Waiting for admin approval${mine && fresh ? ` · <button type="button" class="link-btn" onclick="undoRequest('expense', ${exp.id})">Cancel</button>` : ""}</div>`;
        return `
          <div class="pending-card-inner">
            <div class="pending-main-row">
              <div class="pending-left-group">
                <div class="pending-icon-circle">${EXP_CAT_ICON[exp.category] || "🛒"}</div>
                <div>
                  <div class="pending-shopper-name">${escapeHtml(exp.members?.name || "Unknown")}</div>
                  <div class="pending-desc">${escapeHtml(exp.description || exp.category || "Bazar")}</div>
                </div>
              </div>
              <div class="pending-right-group">
                <div class="pending-amt">${formatTk(exp.amount)}</div>
                <div class="pending-date">${dateStr}</div>
              </div>
            </div>
            ${footer}
          </div>`;
      })
      .join("");

    renderExpenseHistory();
  } catch (err) {
    console.error("Load Exp Error:", err);
    historyContainer.innerHTML = '<div class="list-empty error">Failed to load expenses.</div>';
  }
}

function renderExpenseHistory() {
  const historyContainer = document.getElementById("expenseList");
  if (!historyContainer) return;
  const term = (document.getElementById("expenseSearch")?.value || "").trim().toLowerCase();
  const who = document.getElementById("expenseFilterMember")?.value || "";
  const cat = document.getElementById("expenseFilterCat")?.value || "";
  const staff = isStaff();

  const items = (window._expenseCache || []).filter((e) => e.status === "approved")
    .filter((e) => !who || String(e.member_id) === who)
    .filter((e) => !cat || (e.category || "Bazar") === cat)
    .filter((e) => !term || `${e.description || ""} ${e.category || ""} ${e.members?.name || ""} ${e.amount}`.toLowerCase().includes(term));

  const total = items.reduce((s, e) => s + Number(e.amount || 0), 0);
  const countEl = document.getElementById("expenseCount");
  const totalEl = document.getElementById("expenseTotal");
  if (countEl) countEl.textContent = items.length;
  if (totalEl) totalEl.textContent = items.length ? `· ${formatTk(total)}` : "";

  if (!items.length) {
    historyContainer.innerHTML = `<div class="list-empty">${term || who || cat ? "No expenses match these filters." : "No approved expenses yet."}</div>`;
    return;
  }

  let lastDate = "";
  historyContainer.innerHTML = items
    .map((exp) => {
      const dateStr = parseLocalDate(exp.expense_date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
      const head = exp.expense_date !== lastDate ? `<div class="list-day">${dateStr}</div>` : "";
      lastDate = exp.expense_date;
      const editBtn = staff
        ? `<button class="btn-icon-edit" aria-label="Edit expense" onclick="populateExpenseForm('${exp.id}', '${exp.expense_date}', '${exp.member_id}', '${exp.amount}', this.dataset.desc)" data-desc="${escapeHtml(exp.description || "")}">✎</button>`
        : "";
      return `${head}
        <div class="expense-card-modern">
          <div class="exp-info-left">
            <div class="exp-icon-box">${EXP_CAT_ICON[exp.category] || "🛒"}</div>
            <div class="exp-details">
              <div class="title">${escapeHtml(exp.members?.name || "Unknown")}${exp.is_edited ? ' <span class="edited-badge">EDITED</span>' : ""}</div>
              <div class="meta">${escapeHtml(exp.description || exp.category || "General Expense")}</div>
            </div>
          </div>
          <div class="exp-info-left" style="gap:0;">
            <div class="exp-amount-right"><div class="val">${formatTk(exp.amount)}</div></div>
            ${editBtn}
          </div>
        </div>`;
    })
    .join("");
}

(function wireExpenseFilters() {
  const s = document.getElementById("expenseSearch");
  if (s) s.addEventListener("input", debounce(renderExpenseHistory, 150));
  ["expenseFilterMember", "expenseFilterCat"].forEach((id) => document.getElementById(id)?.addEventListener("change", renderExpenseHistory));
})();

// Function to fill the form with existing data
function populateExpenseForm(id, date, memberId, amount, desc) {
  // The quick entry sheet is used for editing on every screen size
  if (true) {
    // Open the bottom sheet in EDIT mode
    openBottomSheetForEdit(id, date, memberId, amount, desc);
    return; // Don't touch the hidden desktop form
  }

  // --- DESKTOP: Fill the standard form ---
  // 1. Fill Fields
  document.getElementById("editExpenseId").value = id;
  document.getElementById("expenseDate").value = date;
  document.getElementById("expenseMember").value = memberId;
  document.getElementById("expenseAmount").value = amount;
  document.getElementById("expenseDescription").value = desc;

  // 2. Change UI to "Edit Mode"
  document.getElementById("expenseFormTitle").textContent = "Edit Expense Log";
  document.getElementById("expenseFormTitle").style.color =
    "var(--primary-color)";

  const submitBtn = document.getElementById("expenseSubmitBtn");
  submitBtn.textContent = "Update ✓";
  submitBtn.classList.remove("btn-primary");
  submitBtn.classList.add("btn-success");
  submitBtn.style.backgroundColor = "#059669"; // Force green

  document.getElementById("expenseCancelBtn").classList.remove("hidden");

  // 3. Scroll to top so user sees the form
  document
    .getElementById("expensesPage")
    .scrollIntoView({ behavior: "smooth" });
}

// Function to cancel edit and reset form
function resetExpenseForm() {
  const form = document.getElementById("expenseForm");
  if (!form) return;

  // 1. Clear standard inputs
  form.reset();
  document.getElementById("editExpenseId").value = "";

  // 2. Reset UI Styling (Title & Buttons)
  const title = document.getElementById("expenseFormTitle");
  const submitBtn = document.getElementById("expenseSubmitBtn");
  const cancelBtn = document.getElementById("expenseCancelBtn");

  title.textContent = "Add Expense";
  title.style.color = "var(--text-primary)";

  submitBtn.textContent = "ADD +";
  submitBtn.className = "btn btn-primary"; // Reset classes
  submitBtn.style.backgroundColor = ""; // Reset inline styles

  if (cancelBtn) cancelBtn.classList.add("hidden");

  // 3. SET DEFAULT DATE: TODAY (Local Time)
  // We adjust for timezone offset to get the correct local "YYYY-MM-DD"
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .split("T")[0];

  document.getElementById("expenseDate").value = localDate;

  // 4. SET DEFAULT SHOPPER: CURRENT USER
  // This applies to everyone (Admins included) for convenience
  if (currentUser && currentUser.member_id) {
    const memberSelect = document.getElementById("expenseMember");
    if (memberSelect) {
      memberSelect.value = currentUser.member_id;
    }
  }
}
