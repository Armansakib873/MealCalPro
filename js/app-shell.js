// MealCal Pro — App boot, splash, config & lock times, header clock, navigation, sidebar
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// AUTHENTICATION
// ============================================

// [REMOVED] Duplicate logoutBtn handler — the correct handler with full signOut + reload is defined earlier.

function showApp() {
  document.getElementById("authPage").classList.add("hidden");
  document.getElementById("mainApp").classList.remove("hidden");

  document.body.style.overflow = "auto";
  document.documentElement.style.overflow = "auto";

  // --- UI SECURITY: HIDE/SHOW MENU ITEM ---
  const adminBtn = document.getElementById("adminMenuItem");
  if (adminBtn) {
    if (currentUser.role === "admin" || currentUser.role === "manager") {
      adminBtn.style.display = "block"; // Show for Admin/Manager
    } else {
      adminBtn.style.display = "none"; // Hide for everyone else
    }
  }

  initializeApp();
  if (typeof updatePushNotificationButtonState === "function") {
    updatePushNotificationButtonState();
  }
}

function hideApp() {
  document.getElementById("authPage").classList.remove("hidden");
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("loginForm").reset();
  initLoginPage(); // Reload dropdown
}

// Check for saved session
// Check for saved session & Load Dropdown
window.addEventListener("DOMContentLoaded", () => {
  // Start the new Auth System
  initAuth();

  // NEW: Load the users into the login dropdown
  loadLoginUserDropdown();
});

// Restore last page after app is fully initialized (after showApp completes)
window.addEventListener('load', () => {
  // Wait for app to be ready, then restore page
  setTimeout(() => {
    const lastPage = sessionStorage.getItem('last_page');
    if (lastPage && document.getElementById(lastPage + 'Page')) {
      dlog('🔄 Restoring last page:', lastPage);
      navigateToPage(lastPage, false);
    }
  }, 2000); // Wait for initializeApp to complete
});

async function checkSessionAutoSwitch() {
  // 1. Get what the date SHOULD be right now
  const currentCalculatedSession = getStrictSessionDate();

  // 2. Initialize if first run
  if (!lastRenderedSessionDate) {
    lastRenderedSessionDate = currentCalculatedSession;
    return;
  }

  // 3. Compare with what we last rendered
  if (currentCalculatedSession !== lastRenderedSessionDate) {
    dlog(
      "⚡ Session Shift Detected: Switching from " +
        lastRenderedSessionDate +
        " to " +
        currentCalculatedSession,
    );

    // A. Update the Global Tracker
    lastRenderedSessionDate = currentCalculatedSession;

    // B. Force DB Sync (Ensures the new 7th card exists)
    try {
      await supabase.rpc("manage_meal_plans", {
        target_date: currentCalculatedSession,
      });
      dlog("✅ New session cards generated.");
    } catch (e) {
      console.error("Auto-gen failed:", e);
    }

    // C. Clear Page Caches (Forces re-render)
    pageLoaded.profile = false;
    pageLoaded.dashboard = false;
    pageLoaded.summary = false;
    pageLoaded.tracker = false;

    // D. Refresh Current View Immediately
    // If user is staring at Profile, this makes the cards slide/update instantly
    refreshCurrentPage();

    // E. Notify User
    // showNotification(
    //   "Session changed to " + formatDate(currentCalculatedSession),
    //   "success",
    // );
  }
}

async function initializeApp() {
  const progress = document.getElementById("load-progress");
  const setProgress = (p) => {
    if (progress) progress.style.width = p + "%";
  };
  function updateRestrictedUI() {
    const badge = document.getElementById("lockTimeDisplay");
    if (!badge || !appConfig.lock_time_start) return;

    const now = new Date();
    const [sH, sM] = appConfig.lock_time_start.split(":").map(Number);
    const [eH, eM] = appConfig.lock_time_end.split(":").map(Number);

    const start = new Date();
    start.setHours(sH, sM, 0);
    const end = new Date();
    end.setHours(eH, eM, 0);

    const isLocked = now >= start && now <= end;

    if (isLocked) {
      badge.classList.add("is-restricted");
      badge.innerHTML = `<span class="dot"></span> RESTRICTED NOW: ${convertTo12Hour(appConfig.lock_time_start)} - ${convertTo12Hour(appConfig.lock_time_end)}`;
    } else {
      badge.classList.remove("is-restricted");
      badge.innerHTML = `<span class="dot"></span> Restricted: ${convertTo12Hour(appConfig.lock_time_start)} - ${convertTo12Hour(appConfig.lock_time_end)}`;
    }
  }

  // Call it once and set interval (guarded)
  updateRestrictedUI();
  if (_restrictedUIInterval) clearInterval(_restrictedUIInterval);
  _restrictedUIInterval = setInterval(updateRestrictedUI, 30000);

  try {
    // Step 1: Initialize DB connection
    setProgress(20);
    await loadCycles();

    // Step 2: Load Config and Members
    setProgress(40);
    await loadAppConfig();
    await loadMembers();

    // --- NEW INITIALIZATION LOGIC ---
    // 1. Ask DB: "Is Today's Bazar Closed?"
    const sessionDateObj = await getActiveSessionDate();
    const sessionDateStr = toLocalISO(sessionDateObj);

    dlog("📅 Active Session determined by DB Log:", sessionDateStr);
    lastRenderedSessionDate = sessionDateStr;

    // --- NEW: FORCE DB SYNC ---
    try {
      const sessionDate = getStrictSessionDate();
      dlog("⚡ Enforcing Schedule for Session:", sessionDate);

      // Call the SQL function we created
      const { error } = await supabase.rpc("manage_meal_plans", {
        target_date: sessionDate,
      });

      if (error) throw error;
      dlog("✅ Database rows synced & cleaned.");
    } catch (err) {
      console.error("Sync Error:", err);
    }

    lastRenderedSessionDate = getStrictSessionDate();
    if (_sessionSwitchInterval) clearInterval(_sessionSwitchInterval);
    _sessionSwitchInterval = setInterval(checkSessionAutoSwitch, 30000);

    initHeader();
    initNotifications();

    // Step 3: Priority Data Load (Dashboard)
    setProgress(70);
    await loadPageData("dashboard");

    // Finalize internal settings
    updateEntryStatusIndicator();
    initRealtimeSync();
    setProgress(100);

    // Final Progress
    const progress = document.getElementById("load-progress");
    if (progress) progress.style.width = "100%";

    // --- HIDE SPLASH ---
    setTimeout(() => {
      hideSplash();
    }, 1000); // Small delay to let the animation be seen

    // --- COORDINATED FADE OUT ---
    // We wait for the animation to feel "complete" (approx 1.5 - 2 seconds total)
    setTimeout(() => {
      const loader = document.getElementById("initial-loader");
      if (loader) {
        loader.classList.add("splash-hidden");

        // Remove from DOM to keep it light
        setTimeout(() => loader.remove(), 800);
      }
    }, 1200); // Adjust this delay based on your video length

    // Background loading begins after the app is visible
    setTimeout(() => preLoadAllPages(), 2000);
    initAndroidBackHandler();
  } catch (err) {
    console.error("Critical Init Error:", err);
    const splashText = document.querySelector(".splash-text");
    if (splashText)
      splashText.textContent = "Connection Error. Please check internet.";
    if (progress) progress.style.background = "var(--danger-color)";
  }
}

async function preLoadAllPages() {
  // Standard pages for everyone
  const pages = ["profile", "tracker", "summary", "expenses", "deposits"];

  // Only preload Admin for Admins/Managers
  if (currentUser.role === "admin" || currentUser.role === "manager") {
    pages.push("admin");
  }

  for (const page of pages) {
    await loadPageData(page);
  }
  dlog("✅ Pages pre-loaded.");
}

// [REMOVED] Duplicate loadPageData — the correct async version is defined earlier in the file.

// --- SPLASH CONTROL HELPERS ---

function hideSplash(delay = 800) {
  const loader = document.getElementById("initial-loader");
  if (!loader) return;

  // If this is a background auto-reload, splash is already hidden by top-of-file IIFE
  if (window._isBgReload) {
    return;
  }

  setTimeout(() => {
    loader.classList.add("splash-hidden");
    loader.style.display = '';
  }, delay);
}

function showSplash(text = "Preparing your kitchen...") {
  const loader = document.getElementById("initial-loader");
  const splashText = document.querySelector(".splash-text");
  const progress = document.getElementById("load-progress");

  if (loader) {
    if (splashText) splashText.textContent = text;
    if (progress) progress.style.width = "0%";
    loader.classList.remove("splash-hidden");
  }
}
// [REMOVED] Duplicate adminSettingsForm handler — the correct version is defined later.

async function getActiveSessionDate() {
  const now = new Date();
  const todayStr = toLocalISO(now); // e.g., "2026-02-02"

  try {
    // Check if the System has already run "Auto-Entry" for today
    const { data: log, error } = await supabase
      .from("system_logs")
      .select("id")
      .eq("log_date", todayStr)
      .maybeSingle();

    if (error && error.code !== "PGRST116")
      console.error("Session Check Error:", error);

    let sessionDate = new Date(now);

    if (log) {
      // Log EXISTS: Bazar closed. Session moves to Tomorrow.
      sessionDate.setDate(now.getDate() + 1);
    }
    // Log MISSING: Bazar open. Session is Today.

    return sessionDate;
  } catch (err) {
    console.error("Critical Session Error", err);
    return new Date(); // Fallback to Today
  }
}

// Global Config
let appConfig = {
  lock_time_start: "17:00",
  lock_time_end: "19:00",
  auto_entry_time: "18:30", // Default
};

async function loadAppConfig() {
  try {
    const { data, error } = await supabase.from("app_config").select("*");
    if (data) {
      data.forEach((item) => {
        appConfig[item.key_name] = item.value_text;
      });
    }

    // Update Admin UI inputs
    const startInput = document.getElementById("settingLockTime");
    const endInput = document.getElementById("settingLockTimeEnd");
    if (startInput) startInput.value = appConfig.lock_time_start;
    if (endInput) endInput.value = appConfig.lock_time_end;

    const autoInput = document.getElementById("settingAutoTime");
    if (autoInput) autoInput.value = appConfig.auto_entry_time;

    // Update Profile Display
    const lockDisplay = document.getElementById("lockTimeDisplay");
    if (lockDisplay) {
      lockDisplay.textContent = `Restricted: ${convertTo12Hour(appConfig.lock_time_start)} - ${convertTo12Hour(appConfig.lock_time_end)}`;
    }
  } catch (err) {
    console.error("Config Load Error", err);
  }
}

// Admin Form Saver
// Admin Form Saver
document
  .getElementById("adminSettingsForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    // 1. Get Values
    const start = document.getElementById("settingLockTime").value;
    const end = document.getElementById("settingLockTimeEnd").value;
    const autoTime = document.getElementById("settingAutoTime").value; // <--- Make sure this ID exists in HTML

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
      // 2. Upsert All 3 Settings
      const { error } = await supabase.from("app_config").upsert(
        [
          { key_name: "lock_time_start", value_text: start },
          { key_name: "lock_time_end", value_text: end },
          { key_name: "auto_entry_time", value_text: autoTime }, // <--- CRITICAL FIX
        ],
        { onConflict: "key_name" },
      );

      if (error) throw error;

      // 3. Update Local Config State
      appConfig.lock_time_start = start;
      appConfig.lock_time_end = end;
      appConfig.auto_entry_time = autoTime;

      // 4. Update UI
      const lockDisplay = document.getElementById("lockTimeDisplay");
      if (lockDisplay)
        lockDisplay.textContent = `Restricted: ${convertTo12Hour(start)} - ${convertTo12Hour(end)}`;

      showNotification("Settings saved successfully!", "success");
      loadScheduler(); // Refresh UI locks
    } catch (err) {
      console.error("Save Error", err);
      showNotification("Failed to save settings", "error");
    } finally {
      btn.textContent = "Save Settings";
      btn.disabled = false;
    }
  });
// Helper: Convert 17:00 to 5:00 PM
function convertTo12Hour(timeStr) {
  if (!timeStr) return "";
  const [hour, min] = timeStr.split(":");
  const h = parseInt(hour);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${min} ${ampm}`;
}

/**
 * Checks if a specific meal slot is locked based on Bazar Time.
 * Logic: A "Bazar Session" locks Today's Night and Tomorrow's Day.
 */
function isMealLocked(targetDateStr, mealType) {
  // 1. Check Config exists
  if (!appConfig.lock_time_start || !appConfig.lock_time_end) return false;

  // 2. Get Current Time details
  const now = new Date();
  // Use local time comparison
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTimeVal = currentHours * 60 + currentMinutes;

  // Parse Config Range
  const [sH, sM] = appConfig.lock_time_start.split(":").map(Number);
  const [eH, eM] = appConfig.lock_time_end.split(":").map(Number);
  const startVal = sH * 60 + sM;
  const endVal = eH * 60 + eM;

  // 3. Check if NOW is inside the Time Window
  const isTimeLocked = currentTimeVal >= startVal && currentTimeVal <= endVal;

  // If we aren't even in the time window, nothing is locked.
  if (!isTimeLocked) return false;

  // 4. Calculate the "Bazar Date" for the target meal
  // If Night Button (Feb 2) -> Bazar Date is Feb 2
  // If Day Button (Feb 3)   -> Bazar Date is Feb 2 (Previous Day)
  const mealDate = parseLocalDate(targetDateStr);
  let bazarDateForMeal = new Date(mealDate);

  if (mealType === "day") {
    bazarDateForMeal.setDate(mealDate.getDate() - 1);
  }

  // 5. Compare "Bazar Date" with "Today"
  const todayStr = toLocalISO(now);
  const bazarDateStr = toLocalISO(bazarDateForMeal);

  // Lock ONLY if the Bazar Date is TODAY
  return bazarDateStr === todayStr;
}

function initHeader() {
  // 1. Set User Info
  if (currentUser) {
    // Use the 'name' property defined in handleUserSession
    const displayName = currentUser.name || "User";
    const role = currentUser.role || "user";

    // Update header with format: Name (ROLE)
    document.getElementById("headerUserName").textContent =
      `${displayName} (${role.toUpperCase()})`;

    // Clear old secondary role field
    const subRole = document.getElementById("headerUserRole");
    if (subRole) subRole.textContent = "";
  }

  // 2. Start Clock
  updateClock();
  if (!window.clockInterval) {
    window.clockInterval = setInterval(updateClock, 1000);
  }

  // 3. Update Cycle Name Badge
  const cycleSelect = document.getElementById("cycleSelect");
  if (cycleSelect && cycleSelect.options[cycleSelect.selectedIndex]) {
    document.getElementById("headerCycleName").textContent =
      cycleSelect.options[cycleSelect.selectedIndex].text;
  }
}

function updateClock() {
  const now = new Date();

  // Time
  const timeString = now.toLocaleTimeString("en-US", {
    hour12: true,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  document.getElementById("clockTime").textContent = timeString;

  // Date
  const dateString = now.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  document.getElementById("clockDate").textContent = dateString;
}

// ============================================
// NAVIGATION
// ============================================

async function navigateToPage(pageName, addToHistory = true) {
  if (!pageName) return;

  // --- Save current page to sessionStorage for restore after reload ---
  sessionStorage.setItem('last_page', pageName);

  // --- SECURITY CHECK ---
  if (pageName === "admin") {
    if (
      !currentUser ||
      (currentUser.role !== "admin" && currentUser.role !== "manager")
    ) {
      showNotification("⛔ Access Denied: Admin privileges required.", "error");
      if (document.querySelector(".page-content:not(.hidden)") === null) {
        navigateToPage("dashboard", false); // Don't save history if redirecting
      }
      return;
    }
  }

  // --- HISTORY TRACKING (New Logic) ---
  const currentPage = getActivePage();

  // Only add to history if:
  // 1. We are told to (addToHistory is true)
  // 2. We are actually changing pages (currentPage != pageName)
  // 3. There is a current page to remember
  if (addToHistory && currentPage && currentPage !== pageName) {
    navigationHistory.push(currentPage);
  }

  // --- STANDARD NAVIGATION ---
  document
    .querySelectorAll(".page-content")
    .forEach((p) => p.classList.add("hidden"));

  const target = document.getElementById(pageName + "Page");
  if (target) target.classList.remove("hidden");

  // Update Nav UI
  document.querySelectorAll(".bottom-nav-link, .nav-link").forEach((link) => {
    if (link.getAttribute("data-page") === pageName) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });

  // Load Data
  await loadPageData(pageName);

  // Auto-close sidebar on mobile
  if (window.innerWidth <= 768) {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebarOverlay");
    if (sidebar) sidebar.classList.remove("mobile-active");
    if (overlay) overlay.classList.remove("active");
  }
}

function refreshCurrentPage() {
  // Find which page is active (has no 'hidden' class)
  const activePage = document.querySelector(".page-content:not(.hidden)");

  if (activePage) {
    const pageId = activePage.id.replace("Page", "");
    dlog(`🔄 Refreshing view: ${pageId}`);
    loadPageData(pageId);

    // Always refresh dashboard stats if on dashboard
    // (Because dashboard has multiple sub-components)
    if (pageId === "dashboard") {
      loadDashboard();
      loadSystemStatus();
    }
  }
}
// Setup navigation
document.querySelectorAll(".nav-link, .bottom-nav-link").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const pageName = link.getAttribute("data-page");
    if (pageName) {
      navigateToPage(pageName);
    }
  });
});

// --- MOBILE MENU LOGIC ---
// --- UNIFIED MOBILE NAVIGATION & SIDEBAR LOGIC ---
// --- FIX: MOBILE SIDEBAR TRIGGER ---
const mobileMenuBtn = document.getElementById("mobileMenuBtn");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");

// Open Sidebar
if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation(); // Stops click from bubbling up
    sidebar.classList.add("mobile-active");
    sidebarOverlay.classList.add("active");
  });
}

// Close Sidebar when clicking the overlay
if (sidebarOverlay) {
  sidebarOverlay.addEventListener("click", () => {
    sidebar.classList.remove("mobile-active");
    sidebarOverlay.classList.remove("active");
  });
}

// [REMOVED] Duplicate navigateToPage — the correct version with history tracking is defined earlier.
// [REMOVED] Duplicate load/sidebar listeners — already handled elsewhere.
