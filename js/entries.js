// MealCal Pro — Quick Entry: shared expense/deposit submit logic + the entry sheet
// (Classic script; shares global scope. Used by the floating ＋ button, page buttons and expense edit.)

// ============================================
// SHARED ENTRY LOGIC
// ============================================
function getActorName() {
  return currentUser?.members?.name || currentUser?.name || "User";
}

function getMemberName(memberId) {
  const m = (allMembers || []).find((x) => String(x.id) === String(memberId));
  return m ? m.name : "Member";
}

/**
 * Create (pending) or edit an expense. Returns the row id. Throws on validation / DB errors.
 * Notifications are written by the database.
 */
async function saveExpense({ id, date, memberId, description, category, notes, amount }) {
  if (!currentCycleId) throw new Error("System Error: No active cycle.");
  if (!memberId) throw new Error("Please choose who bought it.");
  if (!date) throw new Error("Please pick a date.");
  if (!isFinite(amount) || amount <= 0) throw new Error("Please enter a valid amount.");
  if (amount > 200000) throw new Error("That amount looks too large — please check it.");

  // The expenses table has no notes column, so a note is appended to the description
  let desc = (description || "").trim() || (category && category !== "Bazar" ? category : "General Expense");
  const note = (notes || "").trim();
  if (note) desc = `${desc} — ${note}`;

  if (id) {
    if (!isStaff()) throw new Error("Only admins or managers can edit expenses.");
    const { error } = await supabase
      .from("expenses")
      .update({ expense_date: date, member_id: memberId, description: desc, amount, category: category || null, is_edited: true })
      .eq("id", id);
    if (error) throw error;
    showNotification("Expense updated", "success");
    loadExpenses();
    loadDashboard();
    return id;
  }

  const { data, error } = await supabase
    .from("expenses")
    .insert({
      cycle_id: parseInt(currentCycleId),
      expense_date: date,
      member_id: memberId,
      description: desc,
      category: category || null,
      amount,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw error;
  loadExpenses();
  loadDashboard();
  return data.id;
}

/** Submit a deposit / deduction request (always pending). Whole Taka. Returns the row id. */
async function submitDepositRequest({ memberId, type, amount, label, notes }) {
  if (!currentCycleId) throw new Error("System Error: No active cycle.");
  memberId = parseInt(memberId);
  if (!memberId) throw new Error("Please choose a member.");
  const rounded = Math.round(amount);
  if (!rounded || rounded <= 0) throw new Error("Please enter a valid amount.");
  if (rounded > 200000) throw new Error("That amount looks too large — please check it.");

  const finalAmount = type === "charge" ? -Math.abs(rounded) : Math.abs(rounded);
  const finalLabel = (label || "").trim() || (type === "charge" ? "Deduction" : "Deposit");

  const { data, error } = await supabase
    .from("deposits")
    .insert({ cycle_id: parseInt(currentCycleId), member_id: memberId, amount: finalAmount, label: finalLabel, notes: notes || "", status: "pending" })
    .select("id")
    .single();
  if (error) throw error;
  loadDeposits();
  if (typeof loadDashboard === "function") loadDashboard();
  return data.id;
}

async function undoRequest(kind, id) {
  const { error } = await supabase.rpc("cancel_request", { p_kind: kind, p_id: id });
  if (error) throw error;
  showNotification("Request cancelled", "info");
  if (kind === "expense") loadExpenses(); else loadDeposits();
  loadDashboard();
}

// ============================================
// SAFE AMOUNT MATH — "120+85+40", "2*450", "(500-20)/2" (no eval)
// ============================================
function evalAmountExpr(input) {
  const src = String(input || "").replace(/[৳,\s]/g, "").replace(/[০-৯]/g, (d) => "০১২৩৪৫৬৭৮৯".indexOf(d)).replace(/×/g, "*").replace(/÷/g, "/");
  if (!src) return NaN;
  if (!/^[\d.+\-*/()]+$/.test(src)) return NaN;
  let i = 0;
  const peek = () => src[i];
  const num = () => {
    let s = "";
    while (i < src.length && /[\d.]/.test(src[i])) s += src[i++];
    if (!s || (s.match(/\./g) || []).length > 1) throw 0;
    return parseFloat(s);
  };
  const factor = () => {
    if (peek() === "-") { i++; return -factor(); }
    if (peek() === "(") { i++; const v = expr(); if (src[i++] !== ")") throw 0; return v; }
    return num();
  };
  const term = () => {
    let v = factor();
    while (peek() === "*" || peek() === "/") { const op = src[i++]; const r = factor(); v = op === "*" ? v * r : v / r; }
    return v;
  };
  const expr = () => {
    let v = term();
    while (peek() === "+" || peek() === "-") { const op = src[i++]; const r = term(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  try {
    const v = expr();
    if (i !== src.length || !isFinite(v)) return NaN;
    return Math.round(v * 100) / 100;
  } catch (_) {
    return NaN;
  }
}

// ============================================
// QUICK ENTRY SHEET
// ============================================
let activeSheetTab = "expense";
let editingExpenseId = null; // Tracks if the sheet is in edit mode

const QE_AMOUNTS = { expense: [100, 200, 500, 1000, 2000], deposit: [500, 1000, 1500, 2000, 3000] };

function qeStore(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem("mc_qe_" + key) || "null");
    localStorage.setItem("mc_qe_" + key, JSON.stringify(val));
  } catch (_) { return null; }
}

function _activeMembersForEntry() {
  const cycle = parseInt(currentCycleId) || 0;
  return (allMembers || []).filter((m) => !m.archived_from_cycle_id || cycle < m.archived_from_cycle_id);
}

// Member chips: me first, then recently used, then everyone else A→Z
function renderMemberChips(selectedId) {
  const box = document.getElementById("qeMemberChips");
  const hidden = document.getElementById("sheetMember");
  const recent = qeStore("recent_" + activeSheetTab) || [];
  const meId = currentUser?.member_id;
  const members = _activeMembersForEntry().slice().sort((a, b) => {
    const rank = (m) => (m.id === meId ? -1000 : recent.includes(m.id) ? -100 + recent.indexOf(m.id) : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  // When editing, make sure the original member is selectable even if archived
  if (selectedId && !members.some((m) => String(m.id) === String(selectedId))) {
    const extra = (allMembers || []).find((m) => String(m.id) === String(selectedId));
    if (extra) members.unshift(extra);
  }
  const sel = String(selectedId || hidden.value || meId || "");
  hidden.value = sel;
  box.innerHTML = members
    .map((m) => `
      <button type="button" class="qe-member${String(m.id) === sel ? " selected" : ""}" role="radio" aria-checked="${String(m.id) === sel}" data-id="${m.id}" onclick="qeSelectMember(${m.id})">
        <span class="qe-member-avatar">${m.avatar_url ? `<img src="${escapeHtml(m.avatar_url)}" alt="" loading="lazy" onerror="this.parentNode.textContent=this.dataset.i" data-i="${escapeHtml((m.name || "?")[0].toUpperCase())}">` : escapeHtml((m.name || "?")[0].toUpperCase())}</span>
        <span class="qe-member-name">${m.id === meId ? "Me" : escapeHtml(m.name.split(" ")[0])}</span>
      </button>`)
    .join("");
  const selected = box.querySelector(".selected");
  if (selected) selected.scrollIntoView({ block: "nearest", inline: "center" });
}

function qeSelectMember(id) {
  document.getElementById("sheetMember").value = id;
  document.querySelectorAll("#qeMemberChips .qe-member").forEach((b) => {
    const on = b.dataset.id === String(id);
    b.classList.toggle("selected", on);
    b.setAttribute("aria-checked", on);
  });
  qeUpdateSummary();
}

function renderAmountChips() {
  const box = document.getElementById("qeAmountChips");
  const last = qeStore("last_amount_" + activeSheetTab);
  const list = QE_AMOUNTS[activeSheetTab].slice();
  box.innerHTML =
    (last && !list.includes(last) ? `<button type="button" class="sheet-chip qe-last" onclick="qeSetAmount(${last})">↺ ${formatCurrencyRound(last)}</button>` : "") +
    list.map((a) => `<button type="button" class="sheet-chip" onclick="qeSetAmount(${a})">${formatCurrencyRound(a)}</button>`).join("") +
    `<button type="button" class="sheet-chip qe-op" onclick="qeAppendOp('+')" aria-label="Add another amount">＋ add</button>`;
}

function qeSetAmount(a) {
  const input = document.getElementById("sheetAmount");
  input.value = String(a);
  qeOnAmountInput();
}

function qeAppendOp(op) {
  const input = document.getElementById("sheetAmount");
  if (input.value && !/[+\-*/]$/.test(input.value)) input.value += op;
  input.focus();
  qeOnAmountInput();
}

function qeOnAmountInput() {
  const input = document.getElementById("sheetAmount");
  const raw = input.value;
  // Shrink the big number as the sum gets longer so it always fits
  const fs = raw.length > 14 ? "26px" : raw.length > 9 ? "34px" : "";
  if (fs) input.style.setProperty("font-size", fs, "important"); else input.style.removeProperty("font-size");
  const calc = document.getElementById("qeCalc");
  const val = evalAmountExpr(raw);
  if (/[+\-*/]/.test(raw.replace(/^-/, "")) && isFinite(val)) calc.textContent = `= ${formatTk(val)}`;
  else if (raw && !isFinite(val)) calc.textContent = "Check the amount";
  else calc.textContent = "";
  calc.classList.toggle("bad", !!raw && !isFinite(val));
  qeUpdateSummary();
}

function qePickDate(which) {
  const input = document.getElementById("sheetDate");
  if (which === "today") input.value = toLocalISO(new Date());
  else if (which === "yesterday") input.value = toLocalISO(new Date(Date.now() - 86400000));
  const today = toLocalISO(new Date());
  const yest = toLocalISO(new Date(Date.now() - 86400000));
  const mode = input.value === today ? "today" : input.value === yest ? "yesterday" : "pick";
  document.querySelectorAll("#qeDateChips [data-date]").forEach((c) => c.classList.toggle("selected", c.dataset.date === mode));
  document.getElementById("qeDatePickLabel").textContent =
    mode === "pick" && input.value ? parseLocalDate(input.value).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "Pick date";
  qeUpdateSummary();
}

function qeUpdateSummary() {
  const box = document.getElementById("qeSummary");
  if (!box) return;
  const amount = evalAmountExpr(document.getElementById("sheetAmount").value);
  const memberId = document.getElementById("sheetMember").value;
  if (!isFinite(amount) || amount <= 0 || !memberId) { box.textContent = ""; return; }
  const who = String(memberId) === String(currentUser?.member_id) ? "you" : getMemberName(memberId);
  if (activeSheetTab === "expense") {
    const d = document.getElementById("sheetDate").value;
    const dl = d ? parseLocalDate(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
    const cat = document.querySelector("#qeCategoryChips .selected")?.dataset.cat || "Bazar";
    box.textContent = `${formatTk(amount)} · ${cat} · bought by ${who} · ${dl}`;
  } else {
    const t = document.getElementById("sheetDepType").value;
    box.textContent = `${t === "charge" ? "Deduct" : "Add"} ${formatCurrencyRound(Math.round(amount))} ${t === "charge" ? "from" : "for"} ${who}`;
  }
}

function fillSheetMemberSelect() {
  renderMemberChips();
  return document.getElementById("sheetMember");
}

function openBottomSheet(tab) {
  editingExpenseId = null;
  const overlay = document.getElementById("sheetOverlay");
  const sheet = document.getElementById("sheetModal");
  document.getElementById("sheetMember").value = currentUser?.member_id || "";
  document.getElementById("sheetAmount").value = "";
  document.getElementById("sheetDesc").value = "";
  document.getElementById("sheetNotes").value = "";
  document.getElementById("qeCalc").textContent = "";
  switchSheetTab(tab || qeStore("last_tab") || "expense");
  qePickDate("today");
  overlay.classList.add("active");
  sheet.classList.add("active");
  document.body.classList.add("sheet-open");
  setTimeout(() => document.getElementById("sheetAmount").focus({ preventScroll: true }), 350);
}

function closeBottomSheet() {
  document.getElementById("sheetOverlay").classList.remove("active");
  document.getElementById("sheetModal").classList.remove("active");
  document.body.classList.remove("sheet-open");
  if (document.activeElement) document.activeElement.blur(); // Close keyboard
  editingExpenseId = null;
}

// EDIT MODE (staff): open the sheet pre-filled
function openBottomSheetForEdit(expenseId, date, memberId, amount, desc) {
  const overlay = document.getElementById("sheetOverlay");
  const sheet = document.getElementById("sheetModal");
  switchSheetTab("expense");
  editingExpenseId = expenseId;
  document.getElementById("sheetAmount").value = amount;
  document.getElementById("sheetDate").value = date;
  qePickDate("pick");
  renderMemberChips(memberId);
  const cached = (window._expenseCache || []).find((e) => String(e.id) === String(expenseId));
  const cat = cached?.category || "Bazar";
  document.querySelectorAll("#qeCategoryChips .sheet-chip").forEach((c) => c.classList.toggle("selected", c.dataset.cat === cat));
  document.getElementById("sheetDesc").value = desc || "";
  document.getElementById("sheetNotes").value = "";
  document.getElementById("sheetMainTitle").textContent = "Edit expense";
  document.getElementById("sheetSubmitBtn").textContent = "Save changes ✓";
  document.getElementById("tabDeposit").disabled = true;
  qeOnAmountInput();
  overlay.classList.add("active");
  sheet.classList.add("active");
  document.body.classList.add("sheet-open");
}

function switchSheetTab(tab) {
  if (editingExpenseId && tab === "deposit") return;
  activeSheetTab = tab;
  const sheet = document.getElementById("sheetModal");
  const isExp = tab === "expense";
  document.getElementById("tabExpense").classList.toggle("active", isExp);
  document.getElementById("tabDeposit").classList.toggle("active", !isExp);
  document.getElementById("tabExpense").setAttribute("aria-selected", isExp);
  document.getElementById("tabDeposit").setAttribute("aria-selected", !isExp);
  document.getElementById("tabDeposit").disabled = false;
  sheet.classList.toggle("sheet-theme-expense", isExp);
  sheet.classList.toggle("sheet-theme-deposit", !isExp);
  document.getElementById("sheetMainTitle").textContent = editingExpenseId ? "Edit expense" : isExp ? "New expense" : "New deposit";
  document.getElementById("sheetSubmitBtn").textContent = editingExpenseId ? "Save changes ✓" : isExp ? "Send expense" : "Send deposit";
  document.getElementById("qeWhoLabel").textContent = isExp ? "Who bought it?" : "Whose money?";
  document.getElementById("expenseExtras").style.display = isExp ? "block" : "none";
  document.getElementById("depositExtras").style.display = isExp ? "none" : "block";
  document.getElementById("qeWhenStep").style.display = isExp ? "block" : "none";
  renderMemberChips();
  renderAmountChips();
  qeUpdateSummary();
}

// --- KEYBOARD FIX: Ensure input is visible when focused ---
function ensureVisible(element) {
  setTimeout(() => element.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
}

function selectChip(cat, el) {
  document.querySelectorAll("#qeCategoryChips .sheet-chip").forEach((c) => c.classList.remove("selected"));
  (el || event?.target)?.classList.add("selected");
  qeUpdateSummary();
}

function selectDepositType(type, el) {
  document.getElementById("sheetDepType").value = type;
  document.getElementById("sheetLabel").value = type === "charge" ? "Deduction" : "Deposit";
  document.querySelectorAll("#depositExtras .sheet-chip").forEach((c) => c.classList.remove("selected"));
  (el || event?.target)?.classList.add("selected");
  qeUpdateSummary();
}

// Same member + same amount already sent recently? (prevents accidental double entries)
async function qeFindDuplicate(kind, memberId, amount, date) {
  try {
    if (kind === "expense") {
      const { data } = await supabase.from("expenses").select("id, status")
        .eq("cycle_id", currentCycleId).eq("member_id", memberId).eq("amount", amount).eq("expense_date", date).neq("status", "rejected").limit(1);
      return data && data[0];
    }
    const since = new Date(Date.now() - 2 * 86400000).toISOString();
    const { data } = await supabase.from("deposits").select("id, status")
      .eq("cycle_id", currentCycleId).eq("member_id", memberId).eq("amount", amount).neq("label", "Auto-Settlement").gte("created_at", since).limit(1);
    return data && data[0];
  } catch (_) {
    return null;
  }
}

function _rememberEntry(kind, memberId, amount) {
  qeStore("last_tab", kind);
  qeStore("last_amount_" + kind, Math.round(amount));
  const recent = (qeStore("recent_" + kind) || []).filter((x) => x !== Number(memberId));
  recent.unshift(Number(memberId));
  qeStore("recent_" + kind, recent.slice(0, 5));
}

async function submitMobileEntry() {
  const btn = document.getElementById("sheetSubmitBtn");
  const originalText = btn.textContent;

  const amount = evalAmountExpr(document.getElementById("sheetAmount").value);
  const memberId = document.getElementById("sheetMember").value;
  const notes = document.getElementById("sheetNotes").value;
  const kind = activeSheetTab;
  if (!isFinite(amount) || amount <= 0) {
    showNotification("Please enter a valid amount", "error");
    document.getElementById("sheetAmount").focus();
    return;
  }
  if (!memberId) { showNotification("Please choose a member", "error"); return; }

  btn.textContent = "Saving…";
  btn.disabled = true;
  try {
    if (kind === "expense") {
      const date = document.getElementById("sheetDate").value;
      const category = document.querySelector("#qeCategoryChips .selected")?.dataset.cat || "Bazar";
      if (!editingExpenseId) {
        const dup = await qeFindDuplicate("expense", memberId, amount, date);
        if (dup && !(await uiConfirm("Looks like a duplicate", `${getMemberName(memberId)} already has a ${formatTk(amount)} expense on this date (${dup.status}). Send another one?`, { confirmText: "Send anyway" }))) return;
      }
      const wasEdit = !!editingExpenseId;
      const id = await saveExpense({ id: editingExpenseId, date, memberId, description: document.getElementById("sheetDesc").value, category, notes, amount });
      editingExpenseId = null;
      closeBottomSheet();
      if (!wasEdit) {
        _rememberEntry("expense", memberId, amount);
        showActionToast(`Expense ${formatTk(amount)} sent for approval`, "Undo", () => undoRequest("expense", id));
      }
    } else {
      const type = document.getElementById("sheetDepType").value;
      const finalAmt = type === "charge" ? -Math.round(amount) : Math.round(amount);
      const dup = await qeFindDuplicate("deposit", memberId, finalAmt);
      if (dup && !(await uiConfirm("Looks like a duplicate", `A ${formatCurrencyRound(Math.abs(finalAmt))} ${type === "charge" ? "deduction" : "deposit"} for ${getMemberName(memberId)} was already sent in the last 2 days (${dup.status}). Send another one?`, { confirmText: "Send anyway" }))) return;
      const id = await submitDepositRequest({ memberId, type, amount, label: document.getElementById("sheetLabel").value, notes });
      closeBottomSheet();
      _rememberEntry("deposit", memberId, amount);
      showActionToast(`${type === "charge" ? "Deduction" : "Deposit"} ${formatCurrencyRound(Math.round(amount))} sent for approval`, "Undo", () => undoRequest("deposit", id));
    }
  } catch (err) {
    showNotification(niceError(err), "error");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// Wire amount input + Enter to submit
(function initQuickEntry() {
  const amount = document.getElementById("sheetAmount");
  if (!amount) return;
  amount.addEventListener("input", qeOnAmountInput);
  amount.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitMobileEntry(); } });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("sheetModal").classList.contains("active")) closeBottomSheet();
  });
})();

// The desktop inline forms were replaced by the quick entry; keep handlers harmless if present
const _expenseFormEl = document.getElementById("expenseForm");
if (_expenseFormEl) {
  _expenseFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    await runSafeAction("expenseSubmitBtn", async () => {
      await saveExpense({
        id: document.getElementById("editExpenseId").value,
        date: document.getElementById("expenseDate").value,
        memberId: document.getElementById("expenseMember").value,
        description: document.getElementById("expenseDescription").value,
        amount: evalAmountExpr(document.getElementById("expenseAmount").value),
      });
      resetExpenseForm();
    }, "Saving...");
  });
}
