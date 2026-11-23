// MealCal Pro — In-app notifications, push notifications, activity log
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// NOTIFICATION LOGIC (FIXED)
// ============================================

let allNotifications = [];
let currentNotifFilter = "all";

function initNotifications() {
  // 1. Attach Bell Click Listener
  const bellBtn = document.getElementById("notifBellBtn");
  const panel = document.getElementById("notifPanel");
  const closeBtn = document.getElementById("closeNotifPanel");

  // Remove old listeners to prevent duplicates (cloning trick)
  const newBell = bellBtn.cloneNode(true);
  bellBtn.parentNode.replaceChild(newBell, bellBtn);

  const newClose = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(newClose, closeBtn);

  // Re-attach listeners
  // Inside initNotifications() ...

  document.getElementById("notifBellBtn").addEventListener("click", (e) => {
    e.stopPropagation(); // Stop click from bubbling


    // Show loading state briefly in the list if you want, or just fetch
    const container = document.getElementById("notifListContainer");
    if (container.innerHTML.trim() === "")
      container.innerHTML = '<div class="loading">Syncing...</div>';

    loadNotifications();

    // 2. TOGGLE UI
    document.getElementById("notifPanel").classList.toggle("active");
    if (typeof updatePushNotificationButtonState === "function") {
      updatePushNotificationButtonState();
    }

    // 3. Everything up to now has been seen
    markNotificationsSeen();
  });

  document.getElementById("closeNotifPanel").addEventListener("click", () => {
    document.getElementById("notifPanel").classList.remove("active");
  });

  // 2. Filter Clicks
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      document
        .querySelectorAll(".filter-chip")
        .forEach((c) => c.classList.remove("active"));
      e.target.classList.add("active");
      currentNotifFilter = e.target.getAttribute("data-filter");
      renderNotifications();
    });
  });

  const search = document.getElementById("notifSearch");
  if (search) search.addEventListener("input", debounce((e) => { notifSearchTerm = e.target.value; renderNotifications(); }, 200));

  // 3. Close panel when clicking outside
  document.addEventListener("click", (e) => {
    const p = document.getElementById("notifPanel");
    const b = document.getElementById("notifBellBtn");
    if (
      p.classList.contains("active") &&
      !p.contains(e.target) &&
      !b.contains(e.target)
    ) {
      p.classList.remove("active");
    }
  });

  // 4. Start Loading
  loadNotifications();
  refreshUnreadBadge();
}

// ============================================
// UNREAD COUNTER — counts every notification newer than the last time this device
// opened the panel (remembered across reloads, per member).
// ============================================
let _unreadCount = 0;
const _seenKey = () => "mc_notif_seen_" + (currentUser?.member_id || "x");

function _renderUnreadBadge() {
  const badge = document.getElementById("notifBadge");
  if (!badge) return;
  badge.textContent = _unreadCount > 99 ? "99+" : String(_unreadCount);
  badge.classList.toggle("hidden", _unreadCount <= 0);
  const bell = document.getElementById("notifBellBtn");
  if (bell) bell.setAttribute("aria-label", _unreadCount ? `Notifications, ${_unreadCount} unread` : "Notifications");
}

function bumpUnreadBadge(n = 1) {
  _unreadCount += n;
  _renderUnreadBadge();
  const bell = document.getElementById("notifBellBtn");
  if (bell) { bell.classList.remove("bell-ring"); void bell.offsetWidth; bell.classList.add("bell-ring"); }
}

async function refreshUnreadBadge() {
  if (!currentCycleId) return;
  let seen = null;
  try { seen = localStorage.getItem(_seenKey()); } catch (_) {}
  if (!seen) {
    // First time on this device: start counting from now
    markNotificationsSeen();
    return;
  }
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("cycle_id", currentCycleId)
    .gt("created_at", seen);
  if (error) return;
  _unreadCount = count || 0;
  _renderUnreadBadge();
}

function markNotificationsSeen() {
  try { localStorage.setItem(_seenKey(), new Date().toISOString()); } catch (_) {}
  _unreadCount = 0;
  _renderUnreadBadge();
}

const NOTIF_PAGE = 150;
let notifHasMore = false;
let notifSearchTerm = "";

async function loadNotifications(append = false) {
  if (!currentCycleId) return;

  try {
    const targetCycleId = parseInt(currentCycleId);
    let q = supabase
      .from("notifications")
      .select("id, message, type, created_at, member_id, target_member_id, event_key, tags, members(name, role)")
      .eq("cycle_id", targetCycleId)
      .order("created_at", { ascending: false })
      .limit(NOTIF_PAGE);
    if (append && allNotifications.length) q = q.lt("created_at", allNotifications[allNotifications.length - 1].created_at);

    let { data, error } = await q;
    if (error) throw error;

    notifHasMore = (data || []).length === NOTIF_PAGE;
    allNotifications = append ? allNotifications.concat(data || []) : data || [];
    renderNotifications();
  } catch (err) {
    console.error("❌ Notification Fetch Error:", err);
    const container = document.getElementById("notifListContainer");
    if (container)
      container.innerHTML = `<div class="loading" style="color:var(--danger-color)">Failed to load notifications.</div>`;
  }
}

// event_key → chip label + style. Older notifications (before tags existed) are classified from their text.
const NOTIF_KEYS = {
  "meal.on": ["MEAL ON", "meal-on"], "meal.off": ["MEAL OFF", "meal-off"], "meal.guest": ["GUEST", "meal-guest"],
  "meal.default.on": ["DEFAULT ON", "default"], "meal.default.off": ["DEFAULT OFF", "default"],
  "meal.shutdown": ["SHUTDOWN", "danger"], "meal.restart": ["RESTART", "success"],
  "tracker.sent": ["MEAL COUNT SENT", "tracker"], "tracker.edit": ["TRACKER EDIT", "warn"],
  "deposit.request": ["DEPOSIT REQUEST", "pending"], "deposit.approved": ["DEPOSIT APPROVED", "success"],
  "deposit.rejected": ["DEPOSIT REJECTED", "danger"], "deposit.reverted": ["DEPOSIT REVERTED", "danger"],
  "deposit.deleted": ["DEPOSIT DELETED", "danger"], "deposit.edited": ["DEPOSIT EDITED", "warn"],
  "expense.request": ["EXPENSE REQUEST", "pending"], "expense.approved": ["EXPENSE APPROVED", "success"],
  "expense.added": ["EXPENSE ADDED", "success"], "expense.rejected": ["EXPENSE REJECTED", "danger"],
  "expense.edited": ["EXPENSE EDITED", "warn"], "expense.deleted": ["EXPENSE DELETED", "danger"],
  "expense.cancelled": ["EXPENSE CANCELLED", "warn"], "deposit.cancelled": ["DEPOSIT CANCELLED", "warn"],
  "member.signup": ["NEW SIGNUP", "pending"], "member.approved": ["MEMBER APPROVED", "success"],
  "member.rejected": ["SIGNUP REJECTED", "danger"], "member.added": ["MEMBER ADDED", "success"],
  "member.role": ["ROLE", "info"], "member.renamed": ["RENAMED", "info"], "member.archived": ["MEMBER LEFT", "warn"],
  "settings.changed": ["SETTINGS", "info"], "menu.updated": ["MENU", "info"],
  "cycle.started": ["NEW CYCLE", "success"], "cycle.closed": ["CYCLE CLOSED", "warn"],
};

function notifKey(n) {
  if (n.event_key) return n.event_key;
  const m = (n.message || "").toLowerCase();
  if (n.type === "deposit") return m.includes("revers") ? "deposit.reverted" : m.includes("reject") ? "deposit.rejected" : m.includes("approv") || m.includes("cash deposit") ? "deposit.approved" : "deposit.request";
  if (n.type === "expense") return m.includes("edit") ? "expense.edited" : m.includes("reject") ? "expense.rejected" : m.includes("approv") ? "expense.approved" : "expense.request";
  if (n.type && n.type.includes("meal")) return m.includes("default") ? "meal.default.on" : m.includes(" off") ? "meal.off" : "meal.on";
  if (m.includes("cycle")) return "cycle.started";
  return "settings.changed";
}

function notifGroup(key) {
  const k = key.split(".")[0];
  if (k === "meal" || k === "tracker") return "meal";
  if (k === "deposit" || k === "expense") return "money";
  return "other";
}

function notifMatches(n) {
  const key = notifKey(n);
  const tags = n.tags || [];
  switch (currentNotifFilter) {
    case "mine": return n.target_member_id === currentUser?.member_id || n.member_id === currentUser?.member_id;
    case "meal": return notifGroup(key) === "meal";
    case "money": return notifGroup(key) === "money";
    case "important": return tags.includes("important") || tags.includes("exception") || /shutdown|restart|reverted|rejected|deleted|tracker\.edit/.test(key);
    case "other": return notifGroup(key) === "other";
    default: return true;
  }
}

function renderNotifications() {
  const container = document.getElementById("notifListContainer");
  if (!container) return;

  const term = notifSearchTerm.trim().toLowerCase();
  const filtered = allNotifications.filter((n) => notifMatches(n) && (!term || (n.message || "").toLowerCase().includes(term) || (n.members?.name || "").toLowerCase().includes(term)));

  if (filtered.length === 0) {
    container.innerHTML = `<div class="notif-empty">${term ? "No notifications match your search." : "Nothing here yet for this cycle."}</div>`;
    return;
  }

  const today = toLocalISO(new Date());
  const yesterday = toLocalISO(new Date(Date.now() - 86400000));
  let lastDay = "";
  let html = "";
  for (const n of filtered) {
    const d = new Date(n.created_at);
    const dayIso = toLocalISO(d);
    if (dayIso !== lastDay) {
      lastDay = dayIso;
      const label = dayIso === today ? "Today" : dayIso === yesterday ? "Yesterday" : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
      html += `<div class="notif-day">${label}</div>`;
    }
    const key = notifKey(n);
    const [chip, tone] = NOTIF_KEYS[key] || ["UPDATE", "info"];
    const tags = (n.tags || []).filter((t) => ["exception", "by-staff", "settlement", "important"].includes(t));
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const by = n.members ? `${escapeHtml(n.members.name)}${n.members.role && n.members.role !== "user" ? ` · ${escapeHtml(n.members.role)}` : ""}` : "System";
    const aboutMe = n.target_member_id && n.target_member_id === currentUser?.member_id;
    html += `
      <div class="notif-item tone-${tone}${aboutMe ? " about-me" : ""}" onclick="handleNotifClick('${escapeJsArg(n.type || "")}')">
        <div class="notif-top">
          <span class="notif-chip chip-${tone}">${chip}</span>
          ${tags.map((t) => `<span class="notif-tag">#${escapeHtml(t)}</span>`).join("")}
          ${aboutMe ? `<span class="notif-tag notif-tag-me">you</span>` : ""}
          <span class="notif-time">${time}</span>
        </div>
        <div class="notif-msg">${escapeHtml(n.message)}</div>
        <div class="notif-by">by ${by}</div>
      </div>`;
  }
  if (notifHasMore && !term) {
    html += `<button type="button" class="ui-btn ui-btn-ghost notif-more" onclick="this.disabled=true;this.textContent='Loading…';loadNotifications(true)">Load older</button>`;
  }
  container.innerHTML = html;
}

// ============================================
// BROWSER PUSH NOTIFICATION SYSTEM HELPERS
// ============================================

// Helper: Strip HTML tags from strings for clean plain-text push notifications
function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>?/gm, "").replace(/\s+/g, " ").trim();
}

/**
 * Updates the Enable Push button state in the Notification Panel header
 */
function updatePushNotificationButtonState() {
  const btn = document.getElementById("enablePushNotifBtn");
  const iconEl = document.getElementById("pushNotifIcon");
  const textEl = document.getElementById("pushNotifText");
  if (!btn) return;

  if (!("Notification" in window)) {
    btn.style.background = "#f1f5f9";
    btn.style.color = "#94a3b8";
    btn.style.borderColor = "#e2e8f0";
    if (iconEl) iconEl.textContent = "⚠️";
    if (textEl) textEl.textContent = "Unsupported";
    return;
  }

  if (Notification.permission === "granted") {
    btn.style.background = "#dcfce7";
    btn.style.color = "#15803d";
    btn.style.borderColor = "#86efac";
    if (iconEl) iconEl.textContent = "🔔";
    if (textEl) textEl.textContent = "Push Active";
  } else if (Notification.permission === "denied") {
    btn.style.background = "#fee2e2";
    btn.style.color = "#b91c1c";
    btn.style.borderColor = "#fca5a5";
    if (iconEl) iconEl.textContent = "🔕";
    if (textEl) textEl.textContent = "Blocked";
  } else {
    btn.style.background = "#f8fafc";
    btn.style.color = "#475569";
    btn.style.borderColor = "#cbd5e1";
    if (iconEl) iconEl.textContent = "🔔";
    if (textEl) textEl.textContent = "Enable Push";
  }
}

function openPushGuideModal() {
  const modal = document.getElementById("pushGuideModal");
  if (modal) modal.classList.add("active");
}

function closePushGuideModal() {
  const modal = document.getElementById("pushGuideModal");
  if (modal) modal.classList.remove("active");
}

/**
 * Triggered when user taps "Enable Push" button in Notification header
 */
async function handleNotificationPermissionClick() {
  if (!("Notification" in window)) {
    showNotification("Push notifications are not supported on this browser.", "warning");
    updatePushNotificationButtonState();
    return;
  }

  if (Notification.permission === "granted") {
    showNotification("Push notifications are active!", "info");
    updatePushNotificationButtonState();
    return;
  }

  if (Notification.permission === "denied") {
    updatePushNotificationButtonState();
    openPushGuideModal();
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      showNotification("Push notifications enabled!", "success");
      updatePushNotificationButtonState();
      triggerBrowserPushNotification({
        title: "🔔 Notifications Activated!",
        body: "You will now receive instant push updates on this device.",
        url: "#dashboard"
      });
    } else {
      updatePushNotificationButtonState();
      openPushGuideModal();
    }
  } catch (err) {
    console.error("Permission click error:", err);
  }
}

async function requestNotificationPermission() {
  updatePushNotificationButtonState();
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  return false;
}

async function triggerBrowserPushNotification({ title, body, icon = "./192.png", url = "./", targetMemberId = null }) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (targetMemberId !== null && targetMemberId !== undefined) {
    if (currentUser?.member_id != targetMemberId) return;
  }

  const cleanTitle = stripHtml(title);
  const cleanBody = stripHtml(body);

  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) {
        reg.showNotification(cleanTitle, {
          body: cleanBody,
          icon: icon,
          badge: icon,
          vibrate: [100, 50, 100],
          data: { url: url }
        });
        return;
      }
    }
    new Notification(cleanTitle, { body: cleanBody, icon: icon, data: { url: url } });
  } catch (err) {
    console.error("Push Notification Error:", err);
  }
}

function dispatchPushFromMessage(message, type = "info", targetMemberId = null) {
  const cleanMsg = stripHtml(message);
  let title = "MealCal Pro Alert";
  let url = "#dashboard";
  const msgLower = cleanMsg.toLowerCase();

  if (type === "deposit" || msgLower.includes("deposit") || msgLower.includes("cash")) {
    title = "💰 Deposit Log Update";
    url = "#deposits";
  } else if (type === "expense" || msgLower.includes("expense") || msgLower.includes("bazar")) {
    title = "🛒 Bazar Expense Update";
    url = "#expenses";
  } else if (type === "meal" || msgLower.includes("tracker override") || msgLower.includes("meal")) {
    title = "🍽️ Meal Schedule Alert";
    url = "#profile";
  } else if (msgLower.includes("balance") || msgLower.includes("warning")) {
    title = "⚠️ Negative Balance Alert";
    url = "#deposits";
  } else if (msgLower.includes("role") || msgLower.includes("manager") || msgLower.includes("access control")) {
    title = "📢 Role & Permissions Update";
    targetMemberId = null; // Broadcast to everyone
    url = "#dashboard";
  } else if (msgLower.includes("cycle") || msgLower.includes("finalized") || msgLower.includes("settled")) {
    title = "📊 Monthly Cycle Settlement";
    targetMemberId = null; // Broadcast to everyone
    url = "#summary";
  }

  triggerBrowserPushNotification({
    title: title,
    body: cleanMsg,
    url: url,
    targetMemberId: targetMemberId
  });
}

// Updated Log Activity (Supports targetMemberId for targeted notifications)
/**
 * Notifications are written by the DATABASE (triggers + RPCs) so they can't be skipped or faked.
 * Kept as a no-op so older call sites stay harmless.
 */
async function logActivity() {}


// --- Deep Linking Action ---
function handleNotifClick(type) {
  document.getElementById("notifPanel").classList.remove("active");

  if (type === "deposit") {
    navigateToPage("deposits");
  } else if (type === "expense") {
    navigateToPage("expenses");
  } else if (type.includes("meal")) {
    navigateToPage("tracker");
  } else {
    navigateToPage("dashboard");
  }
}

// Helper to keep Dashboard synced
function updateDashboardActivity(data) {
  const container = document.getElementById("recentActivity");
  if (!container) return;

  const slice = data.slice(0, 10);
  if (slice.length === 0) {
    container.innerHTML = '<div class="loading">No recent activity</div>';
    return;
  }

  container.innerHTML = slice
    .map(
      (notif) => `
        <div class="list-item">
            <div class="list-item-info">
                <div class="list-item-title">${escapeHtml(notif.message)}</div>
                <div class="list-item-subtitle">${formatDateTime(notif.created_at)}</div>
            </div>
        </div>
    `,
    )
    .join("");
}

async function loadCycles() {
  try {
    const { data, error } = await supabase
      .from("cycles")
      .select("*")
      .order("start_date", { ascending: false });

    if (error) throw error;

    allCycles = data || [];
    const cycleSelect = document.getElementById("cycleSelect");
    cycleSelect.innerHTML = "";

    if (allCycles.length === 0) {
      cycleSelect.innerHTML = '<option value="">No cycles available</option>';
      return;
    }

    // Locate this in your initialization or loadCycles
    document.getElementById("cycleSelect").addEventListener("change", (e) => {
      currentCycleId = e.target.value;
      const selectedOption = e.target.options[e.target.selectedIndex];
      document.getElementById("headerCycleName").textContent =
        selectedOption.text;

      // ✅ Restart real-time for new cycle
      dlog(
        "🔄 Cycle changed, restarting realtime for cycle:",
        currentCycleId,
      );
      initRealtimeSync();

      refreshCurrentPage();
      updateEntryStatusIndicator();
      checkGlobalBalanceWarning();
    });

    // FIND THE ACTIVE ONE OR FALLBACK TO THE NEWEST
    const activeCycle =
      allCycles.find((c) => c.is_active === true) || allCycles[0];
    currentCycleId = activeCycle.id;

    allCycles.forEach((cycle) => {
      const option = document.createElement("option");
      option.value = cycle.id;
      option.textContent = cycle.name;
      if (cycle.id === currentCycleId) {
        option.selected = true;
      }
      cycleSelect.appendChild(option);
    });

    // Update the header badge
    document.getElementById("headerCycleName").textContent = activeCycle.name;
  } catch (err) {
    console.error("Error loading cycles:", err);
  }
}
let pendingMembers = [];

async function loadMembers() {
  try {
    const { data, error } = await supabase
      .from("members")
      .select("*")
      .order("name");

    if (error) throw error;

    // Pending signups are invisible everywhere except the admin approval panel
    allMembers = (data || []).filter((m) => m.is_approved !== false);
    pendingMembers = (data || []).filter((m) => m.is_approved === false);
    if (currentUser?.member_id) {
      const me = allMembers.find((m) => m.id === currentUser.member_id);
      if (me) currentUser.members = me;
    }
    populateMemberSelects();
    if (typeof renderPendingApprovals === "function") renderPendingApprovals();
  } catch (err) {
    console.error("Error loading members:", err);
  }
}

function populateMemberSelects() {
  const selects = [
    "trackerMemberSelect",
    "expenseMember",
    "depositMember",
    "depositLogFilter",
    "expenseFilterMember",
  ];
  const placeholders = { depositLogFilter: "All members", expenseFilterMember: "All shoppers", depositMember: "Choose member…" };

  selects.forEach((selectId) => {
    const select = document.getElementById(selectId);
    if (!select) return;

    // Save current selection if refreshing
    const currentValue = select.value;

    // Clear and add placeholder
    select.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = placeholders[selectId] || "Select...";
    select.appendChild(defaultOption);

    // Populate Members
    const activeMembersForCycle = allMembers.filter(m => !m.archived_from_cycle_id || parseInt(currentCycleId) < m.archived_from_cycle_id);
    activeMembersForCycle.forEach((member) => {
      const option = document.createElement("option");
      option.value = member.id;
      option.textContent = member.name;
      select.appendChild(option);
    });

    // --- SPECIFIC DEFAULTS LOGIC ---

    // 1. Expenses: Always default to Current User initially
    if (selectId === "expenseMember" && currentUser.member_id) {
      select.value = currentUser.member_id;
    }
    // 2. Deposits: Always default to Current User
    else if (selectId === "depositMember" && currentUser.member_id) {
      select.value = currentUser.member_id;
    }
    // 3. Others: Restore previous value if exists
    else if (currentValue) {
      select.value = currentValue;
    }
  });

  // Force date default on load as well
  resetExpenseForm();
}
