// MealCal Pro — Realtime sync, table handlers, visibility & lifecycle
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// REAL-TIME SYNCHRONIZATION
// One channel for all tables. Supabase applies the same security rules (RLS)
// to realtime, so every user only receives rows they are allowed to see.
// ============================================

let realtimeChannels = [];
let _rtRetry = 0;
let _rtRetryTimer = null;

// Which pages show data from which table (used to mark hidden pages stale)
const TABLE_PAGES = {
  meal_plans: ["dashboard", "profile", "summary"],
  meals: ["tracker", "summary", "profile", "dashboard"],
  deposits: ["deposits", "summary", "dashboard", "profile"],
  expenses: ["expenses", "summary", "dashboard"],
  members: ["dashboard", "summary", "tracker", "admin", "profile"],
  cycle_dues: ["summary", "deposits", "profile"],
  meal_day_reports: ["tracker", "dashboard"],
  weekly_menus: ["tracker", "dashboard"],
  app_config: ["profile", "admin", "dashboard"],
};

let _rtGeneration = 0; // every new channel gets a number; old channels' events are ignored

function initRealtimeSync() {
  cleanupRealtimeChannels();
  clearTimeout(_rtRetryTimer);
  if (!currentCycleId) return;
  const gen = ++_rtGeneration;

  let ch = supabase.channel("db_changes_" + Date.now());
  const tables = ["meal_plans", "meals", "deposits", "expenses", "members", "cycle_dues", "meal_day_reports", "weekly_menus", "app_config", "cycles"];
  tables.forEach((table) => {
    ch = ch.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => handleRealtimeUpdate(table, payload));
  });
  ch = ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) =>
    handleRealtimeUpdate("notifications", payload),
  );

  ch.subscribe((status) => {
    // A channel we removed on purpose reports CLOSED — that's not a real disconnect.
    // Reacting to it caused an endless reconnect loop (and the flashing "loading" line).
    if (gen !== _rtGeneration) return;
    updateConnectionStatus(status);
    if (status === "SUBSCRIBED") {
      _rtRetry = 0;
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      // Reconnect with backoff (2s, 4s, 8s … max 30s) while the app is visible
      if (document.hidden || !currentUser) return;
      clearTimeout(_rtRetryTimer);
      const wait = Math.min(30000, 2000 * 2 ** _rtRetry++);
      _rtRetryTimer = setTimeout(() => { if (!document.hidden) initRealtimeSync(); }, wait);
    }
  });
  realtimeChannels.push(ch);
}

function cleanupRealtimeChannels() {
  realtimeChannels.forEach((channel) => {
    try { supabase.removeChannel(channel); } catch (_) {}
  });
  realtimeChannels = [];
}

// ============================================
// UNIFIED REAL-TIME HANDLER
// ============================================
const refreshTimers = {};

function handleRealtimeUpdate(table, payload) {
  const activePage = getActivePage();
  const newData = payload.new;
  const oldData = payload.old;

  if (table === "cycles") {
    // A cycle started/closed somewhere else: everything changes → clean restart
    debounceRefresh(() => { showNotification("Cycle changed — refreshing…", "info"); setTimeout(_hardReload, 1200); }, "cycle", 300);
    return;
  }

  // Ignore rows from other cycles
  if (newData?.cycle_id && newData.cycle_id != currentCycleId) return;
  if (oldData?.cycle_id && oldData.cycle_id != currentCycleId) return;

  // Pages that are not on screen will reload fresh data next time they open
  (TABLE_PAGES[table] || []).forEach((p) => { if (p !== activePage) pageLoaded[p] = false; });

  switch (table) {
    case "meal_plans": handleMealPlanUpdate(activePage, payload); break;
    case "meals": handleMealUpdate(activePage, payload); break;
    case "deposits": handleDepositUpdate(activePage, payload, newData, oldData); break;
    case "expenses": handleExpenseUpdate(activePage, payload, newData); break;
    case "notifications": handleNotificationUpdate(payload, newData); break;
    case "members": handleMemberUpdate(activePage, payload); break;
    case "cycle_dues": handleDueUpdate(activePage, newData, oldData); break;
    case "meal_day_reports": debounceRefresh(() => loadMealReports(), "meal-reports", 400); break;
    case "weekly_menus":
      debounceRefresh(() => { updateDashboardMealPlan(); if (activePage === "tracker") loadWeeklyMenuEditor(); }, "menus", 600);
      break;
    case "app_config":
      debounceRefresh(async () => { await loadAppConfig(); if (activePage === "profile") loadScheduler(); }, "config", 600);
      break;
  }
}

// ============================================
// INDIVIDUAL TABLE HANDLERS
// ============================================
function handleMealPlanUpdate(activePage, payload) {
  debounceRefresh(() => updateDashboardMealPlan(), "dash-plan", 400);
  if (activePage === "dashboard" || !activePage) {
    debounceRefresh(() => loadDashboardMemberSchedules(), "dash_schedules", 500);
  }
  const isMe = payload.new?.member_id === currentUser?.member_id || payload.old?.member_id === currentUser?.member_id;
  if (activePage === "profile" && isMe) debounceRefresh(() => loadScheduler(), "scheduler", 400);
  if (activePage === "summary") debounceRefresh(() => loadSummary(), "summary", 1000);
}

function handleMealUpdate(activePage, payload) {
  const isMe = payload.new?.member_id === currentUser?.member_id || payload.old?.member_id === currentUser?.member_id;
  if (activePage === "tracker") debounceRefresh(() => loadMasterTracker(), "tracker", 800);
  if (activePage === "summary") debounceRefresh(() => loadSummary(), "summary", 1000);
  if (activePage === "dashboard") debounceRefresh(() => loadDashboard(), "dashboard", 1200);
  if (activePage === "profile" && isMe) {
    debounceRefresh(() => loadProfile(), "profile", 800);
    debounceRefresh(() => loadScheduler(), "scheduler", 800);
  }
}

function handleDepositUpdate(activePage, payload, newData, oldData) {
  const isCurrentUser = newData?.member_id === currentUser?.member_id || oldData?.member_id === currentUser?.member_id;
  if (activePage === "deposits") debounceRefresh(() => loadDeposits(), "deposits", 500);
  if (activePage === "summary") debounceRefresh(() => loadSummary(), "summary", 1000);
  if (activePage === "dashboard") debounceRefresh(() => loadDashboard(), "dashboard", 1000);
  if (activePage === "profile" && isCurrentUser) debounceRefresh(() => loadProfile(), "profile", 800);
  if (isCurrentUser) {
    debounceRefresh(() => { checkGlobalBalanceWarning(); updateEntryStatusIndicator(); }, "balance-check", 1000);
  }
  debounceRefresh(() => { updateDashboardBadges(); updatePendingCounts(); }, "badges", 500);
}

function handleExpenseUpdate(activePage) {
  if (activePage === "expenses") debounceRefresh(() => loadExpenses(), "expenses-ui", 500);
  if (activePage === "summary") debounceRefresh(() => loadSummary(), "summary-ui", 1000);
  if (activePage === "dashboard") debounceRefresh(() => loadDashboard(), "dash-ui", 1000);
  debounceRefresh(() => { updateDashboardBadges(); updatePendingCounts(); }, "badges", 500);
}

function handleNotificationUpdate(payload, newData) {
  if (!newData || newData.cycle_id != currentCycleId) return;

  if (document.getElementById("notifPanel").classList.contains("active")) {
    debounceRefresh(() => loadNotifications(), "notifications", 400);
  } else {
    allNotifications = []; // reload fully next time the panel opens
  }

  // Unread counter: every new notification counts until the panel is opened
  if (!document.getElementById("notifPanel").classList.contains("active")) bumpUnreadBadge(1);

  if (getActivePage() === "dashboard") debounceRefresh(() => loadRecentActivity(), "activity", 800);

  const mine = String(newData.member_id) === String(currentUser?.member_id);
  if (mine) {
    // The database just recorded MY action → confirm it to me with its exact text
    confirmSavedFromDb(newData.message);
  } else {
    // Events about me done by someone else (shutdown, approvals, tracker edits…)
    const aboutMe = newData.target_member_id && newData.target_member_id === currentUser?.member_id;
    if (aboutMe) showNotification(newData.message, "info");
  }

  if (shouldSendPushToUser(newData)) dispatchPushFromMessage(newData.message, newData.type);
}

function shouldSendPushToUser(newData) {
  if (!newData || !newData.message) return false;
  // Never notify the person who did it
  if (newData.member_id && String(newData.member_id) === String(currentUser?.member_id)) return false;
  // Targeted events → only the member they are about (plus staff for money/approval events)
  if (newData.target_member_id) {
    if (newData.target_member_id === currentUser?.member_id) return true;
    const key = newData.event_key || "";
    return isStaff() && /^(deposit\.request|expense\.request|member\.signup)/.test(key);
  }
  // Broadcasts (meal count sent, new cycle, settings, menu) go to everyone
  return true;
}

function handleMemberUpdate(activePage, payload) {
  debounceRefresh(async () => {
    await loadMembers();
    renderStaffMealControl();
    renderMyMealPower();
    if (typeof renderMealOffNote === "function") renderMealOffNote();
    if (payload?.new?.user_id === currentUser?.id && payload.new.role && payload.new.role !== currentUser.role) {
      showNotification("Your role changed — reloading…", "info");
      setTimeout(_hardReload, 1500);
    }
  }, "members-global", 600);
  if (activePage === "admin") debounceRefresh(() => loadMembersList(), "members-list", 800);
  if (activePage === "summary") debounceRefresh(() => loadSummary(), "summary", 1000);
  if (activePage === "dashboard") debounceRefresh(() => loadDashboardMemberSchedules(), "dash_schedules", 800);
}

function handleDueUpdate(activePage, newData, oldData) {
  if (newData?.to_cycle_id != currentCycleId && oldData?.to_cycle_id != currentCycleId) return;
  if (activePage === "summary") debounceRefresh(() => loadDueSettlement(), "dues", 800);
  if (newData?.member_id === currentUser?.member_id || oldData?.member_id === currentUser?.member_id) {
    debounceRefresh(() => updateEntryStatusIndicator(), "status-indicator", 1000);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function debounceRefresh(callback, key, delay = 500) {
  if (refreshTimers[key]) clearTimeout(refreshTimers[key]);
  refreshTimers[key] = setTimeout(async () => {
    delete refreshTimers[key];
    try {
      await callback();
    } catch (err) {
      console.error(`Error in debounced refresh for ${key}:`, err);
    }
  }, delay);
}

function getActivePage() {
  const activePage = document.querySelector(".page-content:not(.hidden)");
  if (!activePage) return null;
  return activePage.id.replace("Page", "");
}

// Live badge: steady green "Live" when connected, blinking red "Disconnected" (every second) when not.
function updateConnectionStatus(status) {
  const statusEl = document.getElementById("realtimeStatus");
  if (!statusEl) return;
  if (status === "SUBSCRIBED") {
    statusEl.innerHTML = '<span class="rt-dot"></span>Live';
    statusEl.className = "realtime-status connected";
  } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
    statusEl.innerHTML = '<span class="rt-dot"></span>Disconnected';
    statusEl.className = "realtime-status disconnected rt-blink";
  }
}

// ============================================
// VISIBILITY & LIFECYCLE — soft resume instead of full reloads
// When the user comes back from another app the page is NOT reloaded.
// We refresh the session, reconnect realtime and re-fetch what's on screen.
// A full reload happens only after a very long absence or if the soft sync fails.
// ============================================
let _appHiddenAt = 0;
let _lastHeartbeat = Date.now();
let _resumeInFlight = null;
const LONG_ABSENCE_MS = 6 * 60 * 60 * 1000; // 6 hours

function _hardReload() {
  try { sessionStorage.setItem("bg_reload", "1"); } catch (_) {}
  window.location.reload();
}
// Kept for older callers
function _bgReload() { _hardReload(); }

async function resumeApp(reason) {
  if (!currentUser || !currentCycleId) return;
  if (_resumeInFlight) return _resumeInFlight;
  const awayFor = _appHiddenAt ? Date.now() - _appHiddenAt : 0;
  _appHiddenAt = 0;
  if (awayFor > LONG_ABSENCE_MS) return _hardReload();

  document.documentElement.classList.add("app-resyncing");
  _resumeInFlight = (async () => {
    try {
      // 1. Make sure the login token is fresh (it may have expired in the background)
      const { data } = await withTimeout(supabase.auth.getSession(), 8000, "Session timeout");
      if (!data?.session) return _hardReload();

      // 2. Realtime sockets die in the background → reconnect
      initRealtimeSync();

      // 3. Session date may have switched while away (e.g. past 10 PM)
      await checkSessionAutoSwitch();

      // 4. Everything not on screen is stale; refresh what IS on screen
      Object.keys(pageLoaded).forEach((p) => (pageLoaded[p] = false));
      const active = getActivePage() || "dashboard";
      await withTimeout(Promise.all([loadMembers(), loadPageData(active, true)]), 12000, "Sync timeout");
      updateDashboardBadges();
      updatePendingCounts();
      updateEntryStatusIndicator();
      allNotifications = [];
      refreshUnreadBadge();
      if (document.getElementById("notifPanel")?.classList.contains("active")) loadNotifications();
    } catch (e) {
      console.warn("Soft resume failed (" + reason + "), reloading:", e?.message);
      _hardReload();
    } finally {
      document.documentElement.classList.remove("app-resyncing");
      _resumeInFlight = null;
    }
  })();
  return _resumeInFlight;
}

// Detect the JS engine waking up from a freeze (phones suspend background tabs)
setInterval(() => {
  const now = Date.now();
  const gap = now - _lastHeartbeat;
  _lastHeartbeat = now;
  if (gap > 15000 && !document.hidden) {
    if (!_appHiddenAt) _appHiddenAt = now - gap;
    resumeApp("wake");
  }
}, 5000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    _appHiddenAt = Date.now();
    if (statusCycleInterval) {
      clearInterval(statusCycleInterval);
      statusCycleInterval = null;
    }
  } else if (_appHiddenAt) {
    // Short glance away (<3s): realtime is usually still alive, nothing to do
    if (Date.now() - _appHiddenAt < 3000) { _appHiddenAt = 0; return; }
    resumeApp("visible");
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) resumeApp("bfcache");
});

window.addEventListener("beforeunload", () => {
  cleanupRealtimeChannels();
  if (statusCycleInterval) clearInterval(statusCycleInterval);
});

window.addEventListener("online", () => {
  showNotification("Back online — syncing", "success");
  _appHiddenAt = _appHiddenAt || Date.now() - 10000;
  resumeApp("online");
});

window.addEventListener("offline", () => {
  showNotification("You're offline — changes won't save until you're back online", "warning");
  updateConnectionStatus("CLOSED");
});

// Optional: Keep this as an alias in case you already changed some calls
const formatDateTime = formatDate;

function showNotification(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  if (type === "error") icon = "❌";
  if (type === "warning") icon = "⚠️";

  toast.innerHTML = `
        <div class="toast-icon">${icon}</div>
        <div class="toast-msg">${escapeHtml(message)}</div>
    `;
  container.appendChild(toast);

  // Keep at most 3 toasts on screen
  while (container.children.length > 3) container.firstElementChild.remove();

  toast.addEventListener("click", () => removeToast(toast));
  // Longer messages stay a little longer; errors stay longest
  const ms = type === "error" ? 5000 : Math.min(6000, 2600 + String(message).length * 30);
  toast._timer = setTimeout(() => removeToast(toast), ms);
  if (type === "success") { _lastSuccessToast = toast; _lastSuccessAt = Date.now(); }
  return toast;
}

// ============================================
// ACTION CONFIRMATIONS — "it really reached the database"
// 1. Every successful write (insert/update/upsert/delete/RPC) is noted centrally.
// 2. The database writes a notification for the change; when it arrives over realtime
//    and was made by ME, I see its exact text with a ✓ (batched if several arrive together).
// 3. If no database notification arrives within 2.5 s (e.g. a change that has no
//    notification, or realtime is reconnecting) a plain "✓ Saved" is shown instead.
// ============================================
let _lastSuccessToast = null;
let _lastSuccessAt = 0;
let _pendingSaveTimer = null;
let _pendingSaveLabel = "";
let _dbConfirmBatch = [];
let _dbConfirmTimer = null;
let _dbConfirmToast = null;

const _WRITE_LABELS = {
  meal_plans: "Meal schedule saved", meals: "Tracker saved", members: "Profile saved", expenses: "Expense saved",
  deposits: "Deposit saved", app_config: "Settings saved", weekly_menus: "Menu saved", cycles: "Cycle saved",
  cycle_dues: "Dues saved", user_settings: "Preference saved",
};

function noteSuccessfulWrite(label) {
  _pendingSaveLabel = label || _pendingSaveLabel || "Saved";
  clearTimeout(_pendingSaveTimer);
  _pendingSaveTimer = setTimeout(() => {
    _pendingSaveTimer = null;
    // A specific success message was already shown for this action → don't add a second one
    if (Date.now() - _lastSuccessAt < 2500) return;
    showNotification(`✓ ${_pendingSaveLabel}`, "success");
  }, 2500);
}

function confirmSavedFromDb(message) {
  // The database confirmed it → cancel the generic fallback
  clearTimeout(_pendingSaveTimer);
  _pendingSaveTimer = null;
  _dbConfirmBatch.push(message);
  clearTimeout(_dbConfirmTimer);
  _dbConfirmTimer = setTimeout(() => {
    const batch = _dbConfirmBatch;
    _dbConfirmBatch = [];
    const text = batch.length === 1 ? `✓ Saved · ${batch[0]}` : `✓ ${batch.length} changes saved · ${batch[batch.length - 1]}`;
    // Upgrade the success toast that the action just showed (or the previous DB toast) instead of stacking
    const target = (_dbConfirmToast && document.body.contains(_dbConfirmToast) && _dbConfirmToast) ||
      (Date.now() - _lastSuccessAt < 3000 && _lastSuccessToast && document.body.contains(_lastSuccessToast) ? _lastSuccessToast : null);
    if (target) {
      const msg = target.querySelector(".toast-msg");
      if (msg) msg.textContent = text;
      target.classList.remove("hide", "info", "warning");
      target.classList.add("success", "db-confirmed");
      clearTimeout(target._timer);
      target._timer = setTimeout(() => removeToast(target), 4000);
      _dbConfirmToast = target;
    } else {
      _dbConfirmToast = showNotification(text, "success");
      _dbConfirmToast?.classList.add("db-confirmed");
    }
    _lastSuccessAt = Date.now();
  }, 350);
}

// Watch every database write made by the app (one central place — no screen can be missed)
(function watchWrites() {
  if (!window.supabase || typeof supabase === "undefined" || supabase._mcWatched) return;
  supabase._mcWatched = true;
  const wrapThen = (builder, onOk) => {
    if (!builder || typeof builder.then !== "function") return builder;
    const origThen = builder.then.bind(builder);
    builder.then = (resolve, reject) =>
      origThen((res) => {
        try { if (res && !res.error) onOk(); } catch (_) {}
        return res;
      }).then(resolve, reject);
    return builder;
  };
  const origFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const qb = origFrom(table);
    if (table === "notifications") return qb;
    ["insert", "update", "upsert", "delete"].forEach((m) => {
      const orig = qb[m]?.bind(qb);
      if (!orig) return;
      qb[m] = (...args) => wrapThen(orig(...args), () => noteSuccessfulWrite(_WRITE_LABELS[table] || "Saved"));
    });
    return qb;
  };
  // Background calls the user did not trigger: never show "Saved" for these
  const READ_ONLY_RPC = new Set(["get_login_names", "get_login_email", "manage_meal_plans"]);
  const origRpc = supabase.rpc.bind(supabase);
  supabase.rpc = (fn, ...args) => {
    const b = origRpc(fn, ...args);
    return READ_ONLY_RPC.has(fn) ? b : wrapThen(b, () => noteSuccessfulWrite("Saved"));
  };
})();

function removeToast(toastElement) {
  toastElement.classList.add("hide");
  setTimeout(() => {
    if (toastElement.parentNode) toastElement.remove();
  }, 300);
}
