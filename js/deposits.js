// MealCal Pro — Deposits page: list, approval, revert, auto-settlement engine
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

window.revertApprovedDeposit = async function (depositId) {
  if (!isStaff()) {
    showNotification("Permission Denied", "error");
    return;
  }
  const btn = event?.target?.closest("button");
  const dep = (window._depositCache || []).find((d) => d.id == depositId);
  const who = dep?.members?.name ? ` for ${dep.members.name}` : "";
  const amt = dep ? ` (${formatTk(dep.amount)})` : "";
  const reason = await uiPrompt(
    `Revert this deposit${who}${amt}?`,
    "The deposit is removed and any old dues it auto-settled are reopened exactly. Everyone gets a notification.\nWrite a short reason (optional):",
    { icon: "↩️", placeholder: "e.g. entered twice / wrong member", confirmText: "Revert deposit" },
  );
  if (reason === null) return;

  if (btn) { btn.disabled = true; btn.innerHTML = "Reverting..."; }
  try {
    const { data, error } = await supabase.rpc("revert_deposit", { p_deposit_id: depositId, p_reason: reason || null });
    if (error) throw error;
    showNotification(data?.undone > 0 ? `Reverted — ${formatTk(data.undone)} of settlements reopened` : "Deposit reverted", "success");
    await loadDeposits();
    if (typeof loadDashboard === "function") loadDashboard();
  } catch (err) {
    showNotification("Cannot revert: " + niceError(err), "error");
    if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = "↩ Revert"; }
  }
};

window.handleDepositAction = async function (depositId, action) {
  if (!isStaff()) {
    showNotification("Permission Denied", "error");
    return;
  }
  if (isProcessingApproval) return;

  const btn = event?.target?.closest("button");
  let reason = null;
  if (action === "reject") {
    reason = await uiPrompt("Reject this request?", "The request is removed and the member is notified. Reason (optional):",
      { icon: "✕", placeholder: "e.g. money not received", confirmText: "Reject" });
    if (reason === null) return;
  }

  isProcessingApproval = true;
  const originalText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "..."; }

  try {
    if (action === "approve") {
      const { data, error } = await supabase.rpc("approve_deposit", { p_deposit_id: depositId });
      if (error) throw error;
      showNotification(data?.settled > 0 ? `Approved — ${formatTk(data.settled)} auto-settled old dues` : "Deposit approved", "success");
    } else if (action === "reject") {
      const { error } = await supabase.rpc("reject_deposit", { p_deposit_id: depositId, p_reason: reason || null });
      if (error) throw error;
      showNotification("Request rejected", "warning");
    }
    await loadDeposits();
    if (typeof loadDashboard === "function") loadDashboard();
  } catch (err) {
    showNotification(niceError(err), "error");
  } finally {
    isProcessingApproval = false;
    if (btn && document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
};

// ============================================
// DEPOSITS PAGE
// ============================================
async function loadDeposits() {
  if (!currentCycleId) return;
  const historyContainer = document.getElementById("depositList");
  try {
    const { data, error } = await supabase
      .from("deposits")
      .select("*, members(name)")
      .eq("cycle_id", currentCycleId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    window._depositCache = data || [];

    // ---- Pending requests ----
    const pendingCard = document.getElementById("pendingDepositsCard");
    const pendingList = document.getElementById("pendingDepositList");
    const pendingItems = window._depositCache.filter((d) => d.status === "pending");
    const staff = isStaff();
    pendingCard.style.display = pendingItems.length ? "block" : "none";
    pendingList.innerHTML = pendingItems
      .map((t) => {
        const mine = t.created_by && t.created_by === currentUser?.member_id;
        const fresh = Date.now() - new Date(t.created_at).getTime() < 10 * 60 * 1000;
        return `
        <div class="pending-row">
          <div class="pending-row-main">
            <div class="log-member">${escapeHtml(t.members?.name)} <span class="due-status-badge due-status-pending">${t.amount < 0 ? "DEDUCTION" : "DEPOSIT"} REQUEST</span></div>
            <div class="log-meta">${formatTk(Math.abs(t.amount))} · ${escapeHtml(t.label || "Deposit")}${t.notes ? ` · ${escapeHtml(t.notes)}` : ""} · ${escapeHtml(formatDateTimeFull(t.created_at))}</div>
          </div>
          ${staff
            ? `<div class="pending-row-actions">
                 <button class="ui-btn ui-btn-primary ui-btn-sm" onclick="handleDepositAction(${t.id}, 'approve')">Approve</button>
                 <button class="ui-btn ui-btn-ghost-danger ui-btn-sm" onclick="handleDepositAction(${t.id}, 'reject')" aria-label="Reject">✕</button>
               </div>`
            : mine && fresh ? `<button type="button" class="link-btn" onclick="undoRequest('deposit', ${t.id})">Cancel</button>` : ""}
        </div>`;
      })
      .join("");

    renderDepositHistory();
    const dm = document.getElementById("depositMember");
    if (dm && dm.value) loadSelectedMemberHistory(dm.value);
  } catch (err) {
    console.error("Error loading deposits:", err);
    if (historyContainer) historyContainer.innerHTML = '<div class="list-empty error">Error loading transactions.</div>';
  }
}

function renderDepositHistory() {
  const historyContainer = document.getElementById("depositList");
  if (!historyContainer) return;
  const filterId = document.getElementById("depositLogFilter")?.value || "";
  const type = document.getElementById("depositTypeFilter")?.value || "";
  const term = (document.getElementById("depositSearch")?.value || "").trim().toLowerCase();
  const staff = isStaff();

  const items = (window._depositCache || [])
    .filter((d) => d.status === "approved" || !d.status)
    .filter((d) => !filterId || String(d.member_id) === filterId)
    .filter((d) => !type || (type === "settle" ? d.label === "Auto-Settlement" : type === "charge" ? d.amount < 0 && d.label !== "Auto-Settlement" : d.amount >= 0 && d.label !== "Auto-Settlement"))
    .filter((d) => !term || `${d.members?.name || ""} ${d.label || ""} ${d.notes || ""} ${Math.abs(d.amount)}`.toLowerCase().includes(term));

  const countEl = document.getElementById("depositCount");
  if (countEl) countEl.textContent = items.length;

  if (!items.length) {
    historyContainer.innerHTML = `<div class="list-empty">${term || filterId || type ? "No transactions match these filters." : "No transactions yet."}</div>`;
    return;
  }

  historyContainer.innerHTML = items
    .map((t) => {
      const isSettlement = t.label === "Auto-Settlement";
      const isNegative = t.amount < 0;
      let icon = "💰", iconClass = "deposit", tagClass = "tag-deposit", typeLabel = "Deposit";
      if (isSettlement) { icon = "🔄"; iconClass = "settlement"; tagClass = "tag-settle"; typeLabel = "Settlement"; }
      else if (isNegative) { icon = "🔻"; iconClass = "charge"; tagClass = "tag-settle"; typeLabel = "Deduction"; }
      const canRevert = staff && t.status === "approved" && !isSettlement && !t.parent_deposit_id;
      return `
        <div class="log-item">
          <div class="log-content">
            <div class="log-main">
              <div class="log-icon ${iconClass}">${icon}</div>
              <div class="log-details">
                <div class="log-member">${escapeHtml(t.members?.name || "Unknown")} <span class="log-type-tag ${tagClass}">${typeLabel}</span></div>
                <div class="log-meta">${escapeHtml(formatDateTimeFull(t.created_at))}${!isSettlement && t.label && !/^(Deposit|Deduction|Reduction)$/.test(t.label) ? ` · ${escapeHtml(t.label)}` : ""}${t.notes && !isSettlement ? ` · ${escapeHtml(t.notes)}` : ""}</div>
                ${isSettlement && t.notes ? `<div class="transfer-info">📌 ${escapeHtml(t.notes)} (old dues)</div>` : ""}
                ${canRevert ? `<button class="link-btn link-danger" onclick="revertApprovedDeposit(${t.id})">↩ Revert</button>` : ""}
              </div>
            </div>
            <div class="log-amount ${isNegative ? "balance-negative" : "balance-positive"}">${isNegative ? "−" : "+"}${formatTk(Math.abs(t.amount))}</div>
          </div>
        </div>`;
    })
    .join("");
}

(function wireDepositFilters() {
  const s = document.getElementById("depositSearch");
  if (s) s.addEventListener("input", debounce(renderDepositHistory, 150));
})();


function autoUpdateDepositLabel() {
  const type = document.getElementById("depositType").value;
  const labelInput = document.getElementById("depositLabel");

  // Only update if the user hasn't typed something custom yet (optional logic,
  // strictly replacing is usually safer for UX in this context)
  if (type === "charge") {
    labelInput.value = "Reduction";
  } else {
    labelInput.value = "Deposit";
  }
}

async function loadSelectedMemberHistory(memberId) {
  const container = document.getElementById("selectedMemberHistoryList");
  const nameLabel = document.getElementById("historyMemberName");

  // Defensive check: If the page isn't loaded yet, stop here.
  if (!container || !nameLabel) return;

  if (!memberId) {
    container.innerHTML =
      '<div style="font-size:11px; color:gray; text-align:center; padding:10px;">Select a member to view their specific log.</div>';
    nameLabel.textContent = "No member selected";
    return;
  }

  const member = allMembers.find((m) => m.id == memberId);
  nameLabel.textContent = member ? member.name.toUpperCase() : "UNKNOWN";
  container.innerHTML =
    '<div class="loading" style="font-size:11px;">Loading history...</div>';

  try {
    const { data, error } = await supabase
      .from("deposits")
      .select("*, members(name)")
      .eq("cycle_id", currentCycleId)
      .eq("member_id", memberId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML =
        '<div style="font-size:11px; color:gray; text-align:center; padding:10px;">No personal history found.</div>';
      return;
    }

    // Reuse the premium renderHistoryItem function for consistency
    container.innerHTML = data.map((t) => renderHistoryItem(t)).join("");
  } catch (err) {
    console.error("Error loading member history:", err);
    container.innerHTML =
      '<div style="font-size:11px; color:red; text-align:center; padding:10px;">Error loading data.</div>';
  }
}

function renderHistoryItem(t) {
  const isNegative = t.amount < 0;
  const isSettle = t.label === "Auto-Settlement";

  let icon = "💰";
  let iconClass = "plus";
  if (isSettle) {
    icon = "🔄";
    iconClass = "settle";
  } else if (isNegative) {
    icon = "📉";
    iconClass = "minus";
  }

  const dateStr = new Date(t.created_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

  // --- CHANGED LINE BELOW: toBn(Math.round(t.amount)) ---
  return `
    <div class="history-item-premium">
        <div class="hist-left">
            <div class="hist-icon ${iconClass}">${icon}</div>
            <div class="hist-details">
                <div class="name">${escapeHtml(t.members?.name || "User")}</div>
                <div class="meta">${dateStr} ${t.notes ? `• ${escapeHtml(t.notes)}` : ""}</div>
            </div>
        </div>
        <div class="hist-amount">
            <div class="val" style="color: ${isNegative ? "#e11d48" : "#059669"}">
                ${isNegative ? "−" : "+"}৳${toBn(Math.abs(Math.round(t.amount)))}
            </div>
            <div class="label" style="color: var(--text-muted)">${escapeHtml(t.label || "Entry")}</div>
        </div>
    </div>`;
}



document.getElementById("depositForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  await runSafeAction(
    submitBtn,
    async () => {
      await submitDepositRequest({
        memberId: document.getElementById("depositMember").value,
        type: document.getElementById("depositType").value,
        amount: parseFloat(document.getElementById("depositAmount").value),
        label: document.getElementById("depositLabel").value,
        notes: document.getElementById("depositNotes").value,
      });
      document.getElementById("depositAmount").value = "";
      document.getElementById("depositNotes").value = "";
    },
    "Processing...",
  );
});
