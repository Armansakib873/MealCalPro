const SUPABASE_URL = "https://bcardtccxcnktkkeszpp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjYXJkdGNjeGNua3Rra2VzenBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1NzU1NDIsImV4cCI6MjA4MDE1MTU0Mn0.xGxk81ThPGtyQgRCNoOxpvxsnXBUAzgmclrS0ru7g2Q";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Instant splash-hide for background auto-reloads (must run before anything else)
(function() {
  if (sessionStorage.getItem('bg_reload')) {
    sessionStorage.removeItem('bg_reload');
    window._isBgReload = true;
    const loader = document.getElementById('initial-loader');
    if (loader) loader.style.display = 'none';
  }
})();

/**
 * Wraps any Promise with a strict timeout to prevent indefinite network hanging.
 */
function withTimeout(promise, ms = 15000, errorMsg = "Network timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ]);
}

/**
 * ROBUST ACTION HANDLER
 * Wraps any async function to handle loading states, errors, and locking automatically.
 *
 * @param {HTMLElement|String} btnElementOrId - The button element or its ID
 * @param {Function} asyncActionFn - The async code to run (must return a Promise)
 * @param {String} loadingText - (Optional) Text to show while loading
 */
async function runSafeAction(
  btnElementOrId,
  asyncActionFn,
  loadingText = "Processing...",
) {
  // 1. Resolve Button
  const btn =
    typeof btnElementOrId === "string"
      ? document.getElementById(btnElementOrId)
      : btnElementOrId;

  if (!btn) {
    console.error("SafeAction: Button not found");
    return;
  }

  // 2. Lock UI & Save State
  const originalContent = btn.innerHTML;
  const originalWidth = btn.offsetWidth; // Keep width to prevent jumping

  // Apply styling
  btn.style.width = `${originalWidth}px`;
  btn.classList.add("btn-processing");
  btn.disabled = true;

  // Show Spinner
  btn.innerHTML = `<span class="action-spinner"></span> ${loadingText}`;

  try {
    // 3. EXECUTE THE ACTUAL CODE WITH TIMEOUT
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Network Timeout: The connection seems broken. Please reload.")), 15000);
    });
    
    // Race the actual function against the 15-second timeout
    await Promise.race([asyncActionFn(), timeoutPromise]);

    // 4. Success State (Optional visual feedback)
    btn.innerHTML = `✓ Done`;
    btn.classList.add("action-success");

    // Short delay to show "Done" before reverting (optional)
    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    // 5. Standardized Error Handling
    console.error("Action Failed:", err);
    showNotification(err.message || "Operation failed", "error");

    // Shake animation for error
    btn.style.animation = "shake 0.4s ease";
    setTimeout(() => (btn.style.animation = ""), 400);
  } finally {
    // 6. ALWAYS UNLOCK (The Anti-Freeze Guarantee)
    // Check if button still exists in DOM (it might have been removed by a re-render)
    if (document.body.contains(btn)) {
      btn.innerHTML = originalContent;
      btn.disabled = false;
      btn.classList.remove("btn-processing", "action-success");
      btn.style.width = ""; // Reset width
    }
  }
}

// ============================================
// STATE MANAGEMENT
// ============================================

let currentCycleId = null;
let allMembers = [];
let allCycles = [];
let navigationHistory = [];
let lastRenderedSessionDate = null;

// Interval tracking (prevents stacking on re-init)
let _restrictedUIInterval = null;
let _sessionSwitchInterval = null;
let statusCycleInterval = null; // Global variables for Badge Rotation
let statusQueue = [];
let currentStatusIndex = 0;

// Master Local Mirror of the Database
let appState = {
  members: [],
  meals: [],
  meal_plans: [],
  expenses: [],
  deposits: [],
  notifications: [],
  lastSync: null,
};

// Track if a page has been loaded at least once
const pageLoaded = {
  dashboard: false,
  profile: false,
  tracker: false,
  summary: false,
  expenses: false,
  deposits: false,
  admin: false,
};

async function syncFullState() {
  console.log("🔄 Syncing local state with database...");

  // Fetch everything in parallel for speed
  const [
    { data: members },
    { data: meals },
    { data: plans },
    { data: expenses },
    { data: deposits },
  ] = await Promise.all([
    supabase.from("members").select("*").order("name"),
    supabase.from("meals").select("*").eq("cycle_id", currentCycleId),
    supabase.from("meal_plans").select("*"),
    supabase
      .from("expenses")
      .select("*")
      .eq("cycle_id", currentCycleId)
      .eq("status", "approved"),
    supabase
      .from("deposits")
      .select("*")
      .eq("cycle_id", currentCycleId)
      .neq("status", "pending"),
  ]);

  // Update the mirror
  appState.members = members || [];
  appState.meals = meals || [];
  appState.meal_plans = plans || [];
  appState.expenses = expenses || [];
  appState.deposits = deposits || [];
  appState.lastSync = Date.now();

  console.log("✅ Local state is now current.");
}

// Helper to convert English numbers to Bengali digits
function toBn(num) {
  if (num === null || num === undefined) return "০";
  const bnDigits = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
  return num.toString().replace(/\d/g, (d) => bnDigits[d]);
}

// Helper to get YYYY-MM-DD in LOCAL time (prevents Dec 31st bug)
function toLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`; // Returns YYYY-MM-DD
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// ============================================
// SESSION-BOUNDARY HELPERS
// Handles the fact that "Day" meal of date X belongs to the Bazar session of date X-1.
// At cycle boundaries, the last session's Day meal lives in the next cycle's first date.
// ============================================

/**
 * Fetches meals for the day AFTER the cycle ends (boundary day).
 * These Day meals belong to the last Bazar session of the cycle.
 */
async function fetchBoundaryDayMeals(cycleId) {
  const cycle = allCycles.find(c => c.id == cycleId);
  if (!cycle) return [];
  const ed = parseLocalDate(cycle.end_date);
  ed.setDate(ed.getDate() + 1);
  const { data } = await supabase
    .from("meals").select("*")
    .eq("meal_date", toLocalISO(ed));
  return data || [];
}

/**
 * Calculates session-corrected meal total.
 * - Subtracts first-day day_count (belongs to previous cycle's last session)
 * - Adds boundary-day day_count (belongs to this cycle's last session)
 * @param {Array} cycleMeals - Meals fetched by cycle_id (must include meal_date field)
 * @param {Array} boundaryMeals - Meals from fetchBoundaryDayMeals
 * @param {string} cycleStartDate - YYYY-MM-DD
 * @param {number|undefined} memberId - Filter to specific member, or undefined for global
 */
function adjustMealTotal(cycleMeals, boundaryMeals, cycleStartDate, memberId) {
  let cm = cycleMeals;
  let bm = boundaryMeals;
  if (memberId !== undefined) {
    cm = cm.filter(m => m.member_id === memberId);
    bm = bm.filter(m => m.member_id === memberId);
  }
  const raw = cm.reduce(
    (s, m) => s + parseFloat(m.day_count || 0) + parseFloat(m.night_count || 0), 0
  );
  const firstDayExcess = cm
    .filter(m => m.meal_date === cycleStartDate)
    .reduce((s, m) => s + parseFloat(m.day_count || 0), 0);
  const boundaryAdd = bm
    .reduce((s, m) => s + parseFloat(m.day_count || 0), 0);
  return raw - firstDayExcess + boundaryAdd;
}

// ============================================
// NEW SUPABASE AUTHENTICATION LOGIC
// ============================================

let isLoginMode = true; // Toggle between Login and Signup

// 1. Initialize Auth State Listener (Runs automatically on load)
async function initAuth() {
  // 1. Check for current session
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session) {
    // User is logged in: Keep splash visible and load the app
    await handleUserSession(session.user);
  } else {
    // User is logged out:
    // Hide the loader and show the login page simultaneously for a smooth swap
    const authPage = document.getElementById("authPage");
    const mainApp = document.getElementById("mainApp");

    mainApp.classList.add("hidden");
    authPage.classList.remove("hidden");

    // Short delay to let the UI render behind the splash before fading it out
    setTimeout(() => {
      hideSplash(600);
      console.log("Unauthenticated: Transitioning to Login.");
    }, 500);
  }

  // Listen for Auth changes (Login/Logout)
  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session) {
      // Transition handled by handleUserSession -> initializeApp
      await handleUserSession(session.user);
    } else {
      // If logged out, reset visibility
      document.getElementById("authPage").classList.remove("hidden");
      document.getElementById("mainApp").classList.add("hidden");
      hideSplash(400);
    }
  });
}

// 2. Fetch Member Profile based on Login ID
async function handleUserSession(user) {
  try {
    // 1. Try to fetch the profile from the 'members' table
    let { data: member, error } = await supabase
      .from("members")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (member) {
      // Success: User is a recognized member
      currentUser = {
        ...user,
        member_id: member.id,
        name: member.name,
        role: member.role || "user",
      };
    } else {
      // New Signup Fallback: Use metadata from the Auth system
      // This ensures the header shows the name immediately after account creation
      currentUser = {
        ...user,
        name: user.user_metadata?.display_name || user.email.split("@")[0],
        role: "user",
      };
    }

    // Redirect logic
    showApp();

    // Admin Tab Logic
    if (currentUser.role === "admin" || currentUser.role === "manager") {
      document.getElementById("adminMenuItem").style.display = "block";
    } else {
      document.getElementById("adminMenuItem").style.display = "none";
    }
  } catch (err) {
    console.error("Session handling error:", err);
  }
}
// 3. Handle Form Submit (Login / Signup)
// --- NEW AUTH LOGIC (Supports Username) ---

// 1. Toggle Login / Sign Up UI
// Add/Update this in your existing toggle listener
// Locate this in your script
document.getElementById("authToggleBtn").addEventListener("click", (e) => {
  e.preventDefault();
  isLoginMode = !isLoginMode;

  const title = isLoginMode ? "Login to Kitchen" : "Create Account";
  const subtitle = isLoginMode
    ? "Your kitchen, professionally managed."
    : "Join the mess and track your meals.";
  const emailLabel = isLoginMode ? "Email or Username" : "Email Address";
  const btnText = isLoginMode ? "Login to Kitchen" : "Sign Up Now";
  const toggleText = isLoginMode
    ? "New to the mess?"
    : "Already have an account?";
  const linkText = isLoginMode ? "Create Account" : "Login";

  document.getElementById("authSubtitle").textContent = subtitle;
  document.getElementById("emailLabel").textContent = emailLabel;
  document.getElementById("authBtn").querySelector("span").textContent =
    btnText;
  document.getElementById("authToggleText").textContent = toggleText;
  document.getElementById("authToggleBtn").textContent = linkText;

  // Show/Hide Full Name field for Signup
  const userField = document.getElementById("usernameField");
  if (isLoginMode) {
    userField.classList.add("hidden");
    document.getElementById("authUsername").removeAttribute("required");
  } else {
    userField.classList.remove("hidden");
    document.getElementById("authUsername").setAttribute("required", "true");
  }
});

// 2. Handle Submission (Improved with better debugging)
document.getElementById("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  // 1. Collect inputs
  const emailOrUser = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const fullName = document.getElementById("authUsername").value.trim(); // Only for Signup
  const errorDiv = document.getElementById("authError");

  errorDiv.style.display = "none";

  // Show the splash loader
  showSplash(
    isLoginMode ? "Securing Kitchen..." : "Setting up your Account...",
  );

  try {
    if (isLoginMode) {
      // ==========================================
      // LOG IN LOGIC
      // ==========================================
      let finalEmail = emailOrUser;

      // Handle Username Login (if no @ is present)
      if (!emailOrUser.includes("@")) {
        const { data: member, error: findError } = await supabase
          .from("members")
          .select("email")
          .eq("name", emailOrUser)
          .maybeSingle();

        if (findError || !member || !member.email) {
          throw new Error("Username not found. Please use your email.");
        }
        finalEmail = member.email;
      }

      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: finalEmail,
        password: password,
      });

      if (loginError) throw loginError;
      // Success: supabase.auth.onAuthStateChange will automatically trigger initializeApp()
    } else {
      // ==========================================
      // SIGN UP LOGIC
      // ==========================================

      // Validation
      if (!emailOrUser.includes("@"))
        throw new Error("A valid email is required for registration.");
      if (fullName.length < 2) throw new Error("Please enter your full name.");
      if (password.length < 6)
        throw new Error("Password must be at least 6 characters.");

      // 1. Create the Auth User
      // ... inside authForm listener, in the 'else' (Signup) block:
      const { data: authData, error: signupError } = await supabase.auth.signUp(
        {
          email: emailOrUser,
          password: password,
          options: {
            // This 'display_name' is what currentUser.user_metadata looks for
            data: { display_name: fullName },
          },
        },
      );

      if (signupError) throw signupError;

      // 2. Check if Email Confirmation is required
      // (If session is null, it means the user must click the link in their email)
      if (authData.user && !authData.session) {
        hideSplash(100);
        alert(
          "Signup successful! Please check your email inbox to confirm your account before logging in.",
        );
        // Switch back to login mode automatically
        document.getElementById("authToggleBtn").click();
        return;
      }

      // 3. Link Auth User to 'members' table
      // This is the most important part for your app to show the user's name
      if (authData.user) {
        const { error: memberError } = await supabase.from("members").insert({
          user_id: authData.user.id,
          name: fullName,
          email: emailOrUser,
          role: "user", // Default role for new signups
        });

        if (memberError) {
          console.error("Member Link Error:", memberError);
          throw new Error(
            "Account created but profile sync failed. Please contact Admin.",
          );
        }

        showNotification("Welcome to MealCal Pro!", "success");
      }
    }
  } catch (err) {
    // Hide splash and show error
    hideSplash(100);
    errorDiv.textContent = err.message;
    errorDiv.style.display = "block";
    console.error("Auth Failure:", err);
  }
});

// --- UPDATED LOGOUT LOGIC ---
document.getElementById("logoutBtn").addEventListener("click", async () => {
  // 1. Show feedback
  const btn = document.getElementById("logoutBtn");
  btn.innerHTML = '<span class="nav-icon">⏳</span> Logging out...';

  try {
    // 2. Sign out from Supabase server
    await supabase.auth.signOut();
  } catch (err) {
    console.warn("SignOut Error (ignoring):", err);
  }

  // 3. Clear Local Storage (clears cached session tokens/preferences)
  localStorage.clear();
  sessionStorage.clear();

  // 4. FORCE RELOAD (The Fix)
  // This clears the JS Heap/Memory so the next login starts fresh
  window.location.reload();
});

// Function to populate the login dropdown
async function loadLoginUserDropdown() {
  const dropdown = document.getElementById("authUserDropdown");

  // We fetch from 'members' because it's usually public/readable even before login
  // assuming member names match usernames as per your logic
  try {
    const { data, error } = await supabase
      .from("members")
      .select("name")
      .order("name");

    if (error) throw error;

    // Clear and repopulate
    dropdown.innerHTML = '<option value="">Select User ▼</option>';

    data.forEach((member) => {
      const option = document.createElement("option");
      option.value = member.name;
      option.textContent = member.name;
      dropdown.appendChild(option);
    });

    // Add listener to auto-fill the input
    dropdown.addEventListener("change", (e) => {
      if (e.target.value) {
        document.getElementById("authEmail").value = e.target.value;
      }
    });
  } catch (err) {
    console.error("Error loading user dropdown:", err);
    // If error (e.g., RLS policy prevents reading), just hide the dropdown
    dropdown.style.display = "none";
  }
}

// --- CORRECTED loadPageData (Async) ---
async function loadPageData(pageName, forceRefresh = false) {
  // 1. If page is already loaded and no force refresh, exit immediately.
  // This makes switching to the page 0-second lag.
  if (pageLoaded[pageName] && !forceRefresh) {
    return;
  }

  try {
    switch (pageName) {
      case "expenses":
        await loadExpenses();
        break;
      case "profile":
        await Promise.all([loadProfile(), loadScheduler()]);
        break;
      case "dashboard":
        await loadDashboard();
        break;
      case "tracker":
        await Promise.all([loadMasterTracker(), loadWeeklyMenuEditor()]);
        break;
      case "summary":
        await loadSummary();
        break;
      case "deposits":
        await loadDeposits();
        break;
      case "admin":
        await loadAdmin();
        break;
    }

    // Mark as loaded
    pageLoaded[pageName] = true;
  } catch (err) {
    console.error(`❌ Failed to load ${pageName}:`, err);
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Simple hash function (for password hashing - in production use bcrypt)
async function hashPassword(password) {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatCurrency(amount) {
  const isNegative = amount < 0;
  // We get absolute value for the numbers, but keep track of sign
  const val = Math.abs(parseFloat(amount || 0)).toFixed(2);
  const [integerPart, decimalPart] = val.split(".");

  // Add the negative sign if needed
  const signPrefix = isNegative ? "-" : "";

  return `${signPrefix}৳ <span class="amt-whole">${toBn(integerPart)}</span><span class="amt-decimal">.${toBn(decimalPart)}</span>`;
}

// This function handles both the name 'formatDate' and adds the Time
function formatDate(dateString) {
  if (!dateString) return "-";
  const date = new Date(dateString);

  // Formats to: 02 Jan • 10:30 AM
  return (
    date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " • " +
    date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
  );
}

// Utility: Prevents a function from running too many times in a short period
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ============================================
// REAL-TIME SYNCHRONIZATION SYSTEM (Free Tier)
// ============================================

let realtimeChannels = [];

// Initialize real-time listeners
function initRealtimeSync() {
  // Clean up existing channels first
  cleanupRealtimeChannels();

  if (!currentCycleId) {
    console.warn("No cycle ID, skipping real-time setup");
    return;
  }

  console.log("🔄 Setting up real-time sync for cycle:", currentCycleId);

  // Create a SINGLE channel for all tables (free tier has channel limits)
  const mainChannel = supabase
    .channel("db_changes")

    // 1. MEAL PLANS - Watch for schedule changes
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "meal_plans" },
      (payload) => {
        console.log("📅 Meal Plan Changed:", payload.eventType);
        handleRealtimeUpdate("meal_plans", payload);
      },
    )

    // 2. MEALS (Tracker)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "meals" },
      (payload) => {
        console.log("🍽️ Meal Record Changed:", payload.eventType);
        handleRealtimeUpdate("meals", payload);
      },
    )

    // 3. DEPOSITS
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "deposits" },
      (payload) => {
        console.log("💰 Deposit Changed:", payload.eventType);
        handleRealtimeUpdate("deposits", payload);
      },
    )

    // 4. EXPENSES
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "expenses" },
      (payload) => {
        console.log("🛒 Expense Changed:", payload.eventType);
        handleRealtimeUpdate("expenses", payload);
      },
    )

    // 5. NOTIFICATIONS
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications" },
      (payload) => {
        console.log("🔔 New Notification");
        handleRealtimeUpdate("notifications", payload);
      },
    )

    // 6. MEMBERS
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "members" },
      (payload) => {
        console.log("👤 Member Changed:", payload.eventType);
        handleRealtimeUpdate("members", payload);
      },
    )

    // 7. CYCLE DUES
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "cycle_dues" },
      (payload) => {
        console.log("💳 Due Changed:", payload.eventType);
        handleRealtimeUpdate("cycle_dues", payload);
      },
    )

    .subscribe((status) => {
      console.log("Realtime status:", status);
      updateConnectionStatus(status);
    });

  realtimeChannels.push(mainChannel);
  console.log("✅ Real-time sync initialized");
}

// Cleanup function
function cleanupRealtimeChannels() {
  realtimeChannels.forEach((channel) => {
    supabase.removeChannel(channel);
  });
  realtimeChannels = [];
}

// ============================================
// UNIFIED REAL-TIME HANDLER
// ============================================

// Debounce timers for each page/component
const refreshTimers = {};

function handleRealtimeUpdate(table, payload) {
  const activePage = getActivePage();
  const eventType = payload.eventType; // INSERT, UPDATE, DELETE
  const newData = payload.new;
  const oldData = payload.old;

  // Filter out updates not related to current cycle (optimization)
  if (newData?.cycle_id && newData.cycle_id != currentCycleId) return;
  if (oldData?.cycle_id && oldData.cycle_id != currentCycleId) return;

  // Route to appropriate handler based on table
  switch (table) {
    case "meal_plans":
      handleMealPlanUpdate(activePage, payload);
      break;
    case "meals":
      handleMealUpdate(activePage, payload);
      break;
    case "deposits":
      handleDepositUpdate(activePage, payload, newData, oldData);
      break;
    case "expenses":
      handleExpenseUpdate(activePage, payload, newData);
      break;
    case "notifications":
      handleNotificationUpdate(payload, newData);
      break;
    case "members":
      handleMemberUpdate(activePage);
      break;
    case "cycle_dues":
      handleDueUpdate(activePage, newData, oldData);
      break;
  }
}

// ============================================
// INDIVIDUAL TABLE HANDLERS
// ============================================

function handleMealPlanUpdate(activePage, payload) {
  console.log("🔄 Real-time Update Received:", payload.eventType);

  // Update Dashboard immediately regardless of current page
  updateDashboardMealPlan();

  // Specific UI updates based on where the user is looking
  const isMe =
    payload.new?.member_id === currentUser?.member_id ||
    payload.old?.member_id === currentUser?.member_id;

  if (activePage === "profile" && isMe) {
    loadScheduler(); // Refresh the dots/buttons on profile
  }

  if (activePage === "summary") {
    loadSummary(); // Refresh the table
  }

  updateEntryStatusIndicator();
}

function handleMealUpdate(activePage, payload) {
  const isMe =
    payload.new?.member_id === currentUser?.member_id ||
    payload.old?.member_id === currentUser?.member_id;

  // Tracker and Summary need updates for everyone
  if (activePage === "tracker") {
    debounceRefresh(() => loadMasterTracker(), "tracker", 800);
  }
  if (activePage === "summary") {
    debounceRefresh(() => loadSummary(), "summary", 1000);
  }

  // ONLY refresh profile stats if the update belongs to the current user
  if (activePage === "profile" && isMe) {
    debounceRefresh(() => loadProfile(), "profile", 800);
    // Also refresh scheduler if actual meal records change
    debounceRefresh(() => loadScheduler(), "scheduler", 800);
  }
}

function handleDepositUpdate(activePage, payload, newData, oldData) {
  const isCurrentUser =
    newData?.member_id === currentUser?.member_id ||
    oldData?.member_id === currentUser?.member_id;

  // Update Deposits page
  if (activePage === "deposits") {
    debounceRefresh(() => loadDeposits(), "deposits", 500);
  }

  // Update Summary
  if (activePage === "summary") {
    debounceRefresh(() => loadSummary(), "summary", 1000);
  }

  // Update Dashboard
  if (activePage === "dashboard") {
    debounceRefresh(() => loadDashboard(), "dashboard", 1000);
  }

  // Update Profile if current user
  if (activePage === "profile" && isCurrentUser) {
    debounceRefresh(() => loadProfile(), "profile", 800);
  }

  // Update balance warning
  if (isCurrentUser) {
    debounceRefresh(
      () => {
        checkGlobalBalanceWarning();
        updateEntryStatusIndicator();
      },
      "balance-check",
      1000,
    );
  }
  updateDashboardBadges();
  updatePendingCounts();

  // Show toast notification for new deposits (not from current user)
  if (payload.eventType === "INSERT" && newData && !isCurrentUser) {
    const memberName =
      allMembers.find((m) => m.id === newData.member_id)?.name || "Someone";
    const amount = Math.abs(newData.amount);
    const type = newData.amount > 0 ? "💰 Deposit" : "📉 Charge";
    showNotification(`${type}: ${memberName} - ৳${amount}`, "info");
  }
}

function handleExpenseUpdate(activePage, payload, newData) {
  // 1. If we are currently looking at the expenses page, update the list.
  if (activePage === "expenses") {
    // We set forceRefresh to true here because data actually changed in the DB
    debounceRefresh(() => loadExpenses(), "expenses-ui", 500);
  }

  // 2. Summary needs update because meal rate depends on expenses
  if (activePage === "summary") {
    debounceRefresh(() => loadSummary(), "summary-ui", 1000);
  }

  // 3. Dashboard stats
  if (activePage === "dashboard") {
    debounceRefresh(() => loadDashboard(), "dash-ui", 1000);
  }
  updateDashboardBadges();
  updatePendingCounts();

  // 4. Show a toast notification for everyone
  if (payload.eventType === "INSERT" && newData) {
    const memberName =
      allMembers.find((m) => m.id === newData.member_id)?.name || "Someone";
    showNotification(
      `🛒 New Bazar: ${newData.description} (৳${newData.amount}) by ${memberName}`,
      "info",
    );
  }
}

function handleNotificationUpdate(payload, newData) {
  // Only process if it's for current cycle
  if (newData?.cycle_id != currentCycleId) return;

  // Update notification panel if open
  if (document.getElementById("notifPanel").classList.contains("active")) {
    debounceRefresh(() => loadNotifications(), "notifications", 500);
  }

  // Update badge count
  const badge = document.getElementById("notifBadge");
  const currentCount = parseInt(badge.textContent) || 0;
  badge.textContent = currentCount + 1;
  badge.classList.remove("hidden");

  // Update recent activity on dashboard
  if (getActivePage() === "dashboard") {
    debounceRefresh(() => loadRecentActivity(), "activity", 800);
  }
}

function handleMemberUpdate(activePage) {
  // Reload global members list
  debounceRefresh(() => loadMembers(), "members-global", 1000);

  // Update Admin page
  if (activePage === "admin") {
    debounceRefresh(() => loadMembersList(), "members-list", 800);
  }

  // Update Summary (member names might have changed)
  if (activePage === "summary") {
    debounceRefresh(() => loadSummary(), "summary", 1000);
  }
}

function handleDueUpdate(activePage, newData, oldData) {
  // Only update if it's for current cycle
  if (
    newData?.to_cycle_id != currentCycleId &&
    oldData?.to_cycle_id != currentCycleId
  )
    return;

  // Update Summary page dues section
  if (activePage === "summary") {
    debounceRefresh(() => loadDueSettlement(), "dues", 800);
  }

  // Update balance indicator if it affects current user
  if (
    newData?.member_id === currentUser?.member_id ||
    oldData?.member_id === currentUser?.member_id
  ) {
    debounceRefresh(
      () => updateEntryStatusIndicator(),
      "status-indicator",
      1000,
    );
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function debounceRefresh(callback, key, delay = 500) {
  // Clear existing timer for this key
  if (refreshTimers[key]) {
    clearTimeout(refreshTimers[key]);
  }

  // Set new timer
  refreshTimers[key] = setTimeout(() => {
    try {
      callback();
    } catch (err) {
      console.error(`Error in debounced refresh for ${key}:`, err);
    }
    delete refreshTimers[key];
  }, delay);
}

function getActivePage() {
  const activePage = document.querySelector(".page-content:not(.hidden)");
  if (!activePage) return null;
  return activePage.id.replace("Page", "");
}

function updateConnectionStatus(status) {
  const statusEl = document.getElementById("realtimeStatus");
  if (!statusEl) return;

  if (status === "SUBSCRIBED") {
    statusEl.textContent = "🟢 Live";
    statusEl.className = "realtime-status connected";
  } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
    statusEl.textContent = "🔴 Offline";
    statusEl.className = "realtime-status disconnected";
  } else if (status === "CLOSED") {
    statusEl.textContent = "⚫ Disconnected";
    statusEl.className = "realtime-status disconnected";
  }
}

// ============================================
// VISIBILITY & LIFECYCLE MANAGEMENT
// (Mobile Background Resume - Production Fix)
// ============================================

// -------------------------------------------------------
// HEARTBEAT: Detects JS freeze INSTANTLY when engine wakes
// setInterval callbacks queued during freeze fire the
// absolute instant JS resumes — often before
// visibilitychange is even dispatched by the browser.
// -------------------------------------------------------
let _lastHeartbeat = Date.now();
let _appHiddenAt = 0;
let _appStartedAt = Date.now();

function _bgReload() {
  sessionStorage.setItem('bg_reload', '1');
  window.location.reload();
}

setInterval(() => {
  const now = Date.now();
  const gap = now - _lastHeartbeat;
  // Only trigger if app has been running for at least 5s (avoid reload loops on slow startup)
  // and if the gap is > 5s (real freeze, not just slow page load)
  if (gap > 5000 && (now - _appStartedAt > 5000)) {
    console.log(`💓 Heartbeat gap: ${Math.round(gap/1000)}s — JS was frozen, reloading`);
    _bgReload();
    return;
  }
  _lastHeartbeat = now;
}, 1000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    _appHiddenAt = Date.now();
    if (statusCycleInterval) {
      clearInterval(statusCycleInterval);
      statusCycleInterval = null;
    }
  } else {
    // IMMEDIATE reload when returning from background - no delay!
    if (_appHiddenAt) {
      _bgReload();
      return;
    }
    // Short background (<5s): soft reconnect
    setTimeout(() => {
      if (!navigator.onLine) return;
      try {
        initRealtimeSync();
        updateEntryStatusIndicator();
        checkGlobalBalanceWarning();
        const activePage = getActivePage();
        if (activePage) {
          debounceRefresh(
            async () => {
              try {
                await withTimeout(loadPageData(activePage, true), 10000, "Sync timeout");
              } catch (e) { _bgReload(); }
            },
            "visibility-refresh",
            500,
          );
        }
      } catch (e) { _bgReload(); }
    }, 1500);
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) _bgReload();
});

window.addEventListener("focus", () => {
  if (_appHiddenAt && (Date.now() - _appHiddenAt > 5000)) _bgReload();
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  console.log("🧹 Cleaning up realtime connections");
  cleanupRealtimeChannels();
  if (statusCycleInterval) {
    clearInterval(statusCycleInterval);
  }
});

// Reconnect if connection is lost
window.addEventListener("online", () => {
  console.log("🌐 Network reconnected - reinitializing realtime");
  showNotification("Connection restored", "success");
  setTimeout(() => initRealtimeSync(), 1000);
});

window.addEventListener("offline", () => {
  console.log("📡 Network lost");
  showNotification("Connection lost - changes won't sync", "warning");
});

// Optional: Keep this as an alias in case you already changed some calls
const formatDateTime = formatDate;

function showNotification(message, type = "info") {
  const container = document.getElementById("toast-container");

  // Create Toast Element
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  // Determine Icon
  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  if (type === "error") icon = "❌";
  if (type === "warning") icon = "⚠️";

  // Set Content
  toast.innerHTML = `
        <div class="toast-icon">${icon}</div>
        <div class="toast-msg">${message}</div>
    `;

  // Add to DOM
  container.appendChild(toast);

  // Click to dismiss immediately
  toast.addEventListener("click", () => {
    removeToast(toast);
  });

  // Auto dismiss after 3 seconds
  setTimeout(() => {
    removeToast(toast);
  }, 2000);
}
function removeToast(toastElement) {
  toastElement.classList.add("hide");
  // Force removal after CSS transition time (300ms)
  setTimeout(() => {
    if (toastElement.parentNode) toastElement.remove();
  }, 300);
}

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
      console.log('🔄 Restoring last page:', lastPage);
      navigateToPage(lastPage, false);
    }
  }, 2000); // Wait for initializeApp to complete
});
// ==========================================
// EXPENSE APPROVAL HANDLER (GLOBAL)
// ==========================================

// Explicitly attach to 'window' to ensure HTML buttons can find it
// Attach to window so HTML onClick works

// Global lock to prevent double clicks on admin actions
let isProcessingApproval = false;

window.handleExpenseApproval = async function (expenseId, newStatus) {
  if (isProcessingApproval) return;

  const userRole = currentUser?.role;
  if (userRole !== "admin" && userRole !== "manager") {
    showNotification("Permission Denied", "error");
    return;
  }

  isProcessingApproval = true;
  const btn = event.target;
  const originalText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  try {
    // 1. FETCH DETAILS FIRST (Before deleting/updating)
    const { data: exp, error: fetchError } = await supabase
      .from("expenses")
      .select("*, members(name)")
      .eq("id", expenseId)
      .single();

    if (fetchError || !exp) throw new Error("Expense not found");

    // Prepare details for the log
    const shopperName = exp.members?.name || "Unknown";
    const amountBn = toBn(exp.amount);
    const dateObj = new Date(exp.expense_date);
    const dateStr = dateObj.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    }); // e.g., 2 Feb
    const actorName = currentUser.name || "Admin";

    // 2. PERFORM ACTION
    if (newStatus === "rejected") {
      // Update the rejected request to preserve audit trail
      const { error } = await supabase
        .from("expenses")
        .update({ status: "rejected" })
        .eq("id", expenseId);
      if (error) throw error;

      // LOG: Detailed Rejection Message
      // "Expense request by Ayan of ৳500 (2 Feb) REJECTED by Sakib"
      await logActivity(
        `Expense request by ${shopperName} of ৳${amountBn} (${dateStr}) REJECTED by ${actorName}`,
        "expense",
      );

      showNotification("Expense Request Rejected", "warning");
    } else {
      // Approve the request
      const { error } = await supabase
        .from("expenses")
        .update({ status: "approved" })
        .eq("id", expenseId);
      if (error) throw error;

      // LOG: Approval
      await logActivity(
        `Expense request by ${shopperName} of ৳${amountBn} APPROVED by ${actorName}`,
        "expense",
      );

      showNotification("Expense Approved", "success");
      triggerMascotReaction('approval-expense');
    }

    // 3. REFRESH UI
    await loadExpenses();
    await loadDashboard();
  } catch (err) {
    console.error("Approval Error:", err);
    showNotification(`Failed: ${err.message}`, "error");
  } finally {
    // Only reset button if it still exists (it won't if row was deleted/re-rendered)
    if (document.body.contains(btn)) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

window.handleDepositApproval = async function (depositId) {
  if (
    !confirm(
      "Approve this deposit? This will apply the balance and trigger due settlements.",
    )
  )
    return;

  const btn = event.target;
  btn.disabled = true;

  try {
    // 1. Get the pending deposit details
    const { data: dep, error: fetchErr } = await supabase
      .from("deposits")
      .select("*")
      .eq("id", depositId)
      .single();

    if (fetchErr) throw fetchErr;

    // 2. Delete the pending record (to avoid duplicates, or update status)
    // We update status to 'approved' and THEN run settlement logic
    const { error: updateErr } = await supabase
      .from("deposits")
      .update({ status: "approved" })
      .eq("id", depositId);

    if (updateErr) throw updateErr;

    // 3. Run the Settlement Logic (Crucial!)
    // Since it's already in the DB as 'approved' now, we just need to
    // trigger the settlement portion of your existing logic.
    // We reuse your client-side settlement function but modify it slightly
    // OR just call it. For simplicity, we manually run the settlement part:

    await logActivity(
      `Deposit Approved: ${formatCurrency(dep.amount)} for member ID ${dep.member_id}`,
      "deposit",
    );

    // Refresh page - the settlement logic should ideally be a separate function
    // but for now, we will re-run the "Approved" flow
    showNotification("Deposit Approved!", "success");
    refreshCurrentPage();
  } catch (err) {
    console.error(err);
    showNotification("Approval failed", "error");
  }
};

window.handleDepositRejection = async function (depositId) {
  if (!confirm("Reject this request?")) return;

  try {
    const { error } = await supabase
      .from("deposits")
      .update({ status: "rejected" })
      .eq("id", depositId);
    if (error) throw error;
    showNotification("Request Rejected", "warning");
    refreshCurrentPage();
  } catch (err) {
    showNotification("Error", "error");
  }
};

window.handleDepositAction = async function (depositId, action) {
  if (currentUser?.role !== "admin" && currentUser?.role !== "manager") {
    showNotification("Permission Denied", "error");
    return;
  }

  const btn = event.target;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "...";

  try {
    // 1. FETCH DETAILS FIRST
    const { data: dep, error: fError } = await supabase
      .from("deposits")
      .select("*, members(name)")
      .eq("id", depositId)
      .single();

    if (fError || !dep) throw new Error("Could not find the pending request.");

    const actorName = currentUser.name || "Admin";
    const memberName = dep.members?.name || "User";
    const amountBn = toBn(dep.amount);
    const dateObj = new Date(dep.created_at);
    const dateStr = dateObj.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    }); // e.g. 2 Feb

    // 2. PERFORM ACTION
    if (action === "approve") {
      // Delete pending, create approved + settlements
      const { error: delError } = await supabase
        .from("deposits")
        .delete()
        .eq("id", depositId);
      if (delError) throw delError;

      // Process Settlement
      await processDepositWithClientSideSettlement(
        dep.member_id,
        dep.cycle_id,
        dep.amount,
        dep.label || "Deposit",
        dep.notes,
      );

      // LOG: Approval
      await logActivity(
        `Deposit Approved: ${memberName}'s request for ৳${amountBn} was approved by ${actorName}`,
        "deposit",
      );
      showNotification("Request Approved", "success");
      triggerMascotReaction('approval-deposit');
    } else if (action === "reject") {
      // Update pending row to preserve audit trail
      const { error: delError } = await supabase
        .from("deposits")
        .update({ status: "rejected" })
        .eq("id", depositId);
      if (delError) throw delError;

      // LOG: Detailed Rejection Message
      // "Deposit request by Ayan of ৳500 (2 Feb) REJECTED by Sakib"
      await logActivity(
        `Deposit request by ${memberName} of ৳${amountBn} (${dateStr}) REJECTED by ${actorName}`,
        "deposit",
      );

      showNotification("Request Rejected", "warning");
    }

    // 3. REFRESH UI
    await loadDeposits();
    if (typeof loadDashboard === "function") loadDashboard();
  } catch (err) {
    console.error("Action Error:", err.message);
    showNotification(err.message, "error");
  } finally {
    isProcessingApproval = false;
    if (document.body.contains(btn)) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
};

window.revertApprovedDeposit = async function (depositId) {
  if (currentUser?.role !== "admin" && currentUser?.role !== "manager") {
    showNotification("Permission Denied", "error");
    return;
  }

  if (!confirm("⚠️ Are you sure you want to REVERT this deposit?\n\nThis will permanently delete the deposit and automatically un-settle any auto-settlements it originally created. This action cannot be undone.")) {
    return;
  }

  const btn = event.target;
  const originalText = btn.innerHTML;
  btn.innerHTML = "Reverting...";
  btn.disabled = true;

  try {
    // 1. Fetch original deposit
    const { data: origDep, error: depError } = await supabase
      .from("deposits")
      .select("*, members(name)")
      .eq("id", depositId)
      .single();

    if (depError || !origDep) throw new Error("Could not find the original deposit.");

    // 3. Find any Auto-Settlements linked to this parent deposit
    const { data: groupDeposits, error: grpError } = await supabase
      .from("deposits")
      .select("*")
      .eq("cycle_id", origDep.cycle_id)
      .eq("label", "Auto-Settlement")
      .eq("parent_deposit_id", origDep.id);

    if (grpError) throw grpError;

    // 4. Reverse the specific cycle_dues updates accurately
    for (const sib of groupDeposits) {
      if (sib.amount > 0) {
        // Creditor
        const { data: creditorDue } = await supabase
            .from("cycle_dues")
            .select("*")
            .eq("to_cycle_id", origDep.cycle_id)
            .eq("member_id", sib.member_id)
            .gt("due_amount", 0)
            .maybeSingle();
            
        if (creditorDue) {
            const newSettledAmount = creditorDue.settled_amount - sib.amount;
            await supabase.from("cycle_dues").update({
                settled_amount: newSettledAmount,
                status: newSettledAmount >= creditorDue.due_amount ? "settled" : (newSettledAmount > 0 ? "settling" : "pending"),
                settled_at: newSettledAmount >= creditorDue.due_amount ? creditorDue.settled_at : null
            }).eq("id", creditorDue.id);
        }
      } else if (sib.amount < 0) {
        // Debtor
        const { data: debtorDue } = await supabase
            .from("cycle_dues")
            .select("*")
            .eq("to_cycle_id", origDep.cycle_id)
            .eq("member_id", sib.member_id)
            .lt("due_amount", 0)
            .maybeSingle();

        if (debtorDue) {
            // debtorDue returns settled_amount as negative (e.g. -500), sib.amount is -500
            const newSettledAmount = debtorDue.settled_amount - sib.amount; // -500 - (-500) = 0
            const isFullySettled = newSettledAmount <= debtorDue.due_amount; 
            await supabase.from("cycle_dues").update({
                settled_amount: newSettledAmount,
                status: isFullySettled ? "settled" : (newSettledAmount < 0 ? "settling" : "pending"),
                settled_at: isFullySettled ? debtorDue.settled_at : null
            }).eq("id", debtorDue.id);
        }
      }
    }

    // 5. Delete all linked Auto-Settlement deposits, and the original deposit
    const idsToDelete = groupDeposits.map(d => d.id);
    idsToDelete.push(origDep.id);

    const { error: delError } = await supabase
      .from("deposits")
      .delete()
      .in("id", idsToDelete);

    if (delError) throw delError;

    // 6. Log Reversal
    const actorName = currentUser.name || "Admin";
    const memName = origDep.members?.name || "Member";
    await logActivity(
      `Reversal: ${actorName} reversed an approved deposit of ৳${origDep.amount} originally made to ${memName}.`,
      "deposit"
    );

    showNotification("Deposit Fully Reverted!", "success");

    // 7. Refresh Data Layer
    await loadDeposits();
    if (typeof loadDashboard === "function") loadDashboard();

  } catch (err) {
    console.error("Revert Error:", err.message);
    showNotification("Cannot revert: " + err.message, "error");
    if (document.body.contains(btn)) {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  }
};

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
    console.log(
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
      console.log("✅ New session cards generated.");
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

    console.log("📅 Active Session determined by DB Log:", sessionDateStr);
    lastRenderedSessionDate = sessionDateStr;

    // --- NEW: FORCE DB SYNC ---
    try {
      const sessionDate = getStrictSessionDate();
      console.log("⚡ Enforcing Schedule for Session:", sessionDate);

      // Call the SQL function we created
      const { error } = await supabase.rpc("manage_meal_plans", {
        target_date: sessionDate,
      });

      if (error) throw error;
      console.log("✅ Database rows synced & cleaned.");
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
  console.log("✅ Pages pre-loaded.");
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
    // 🤖 Mascot Greeting
    if (typeof triggerMascotGreeting === "function") {
        triggerMascotGreeting();
    }
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

async function loadScheduler() {
  if (!currentUser.member_id || !currentCycleId) return;

  const container = document.getElementById("schedulerList");

  try {
    // 1. ASYNC CHECK: Ask DB "What is the active session?"
    const sessionDateObj = await getActiveSessionDate();
    const currentSessionStr = toLocalISO(sessionDateObj); // YYYY-MM-DD

    // 2. STALENESS CHECK: Did the session change since we last drew the cards?
    if (
      lastRenderedSessionDate &&
      lastRenderedSessionDate !== currentSessionStr
    ) {
      console.log(
        `🔄 Session Shift Detected (Log Found). Rolling cards to ${currentSessionStr}...`,
      );

      // A. Update Tracker
      lastRenderedSessionDate = currentSessionStr;

      // B. Force DB to generate the new 7th card immediately
      await supabase.rpc("manage_meal_plans", {
        target_date: currentSessionStr,
      });

      // C. Invalidate Cache to force redraw
      pageLoaded.profile = false;
      if (container)
        container.innerHTML =
          '<div class="loading">Refreshing session...</div>';
    }

    // 3. CACHE CHECK (Standard)
    if (container.querySelector(".scheduler-card") && pageLoaded.profile) {
      return;
    }

    if (!container.innerHTML.includes("scheduler-card")) {
      container.innerHTML =
        '<div class="loading">Syncing your schedule...</div>';
    }

    // 4. FETCH DATA & RENDER (Standard Logic)
    const { data: memberData } = await supabase
      .from("members")
      .select("default_day_on, default_night_on")
      .eq("id", currentUser.member_id)
      .maybeSingle();

    if (memberData) updateDefaultButtons(memberData);

    // Generate 8 Days (Last session + 7 Upcoming)
    const dates = [];
    for (let i = -1; i <= 8; i++) {
      const d = new Date(sessionDateObj);
      d.setDate(sessionDateObj.getDate() + i);
      dates.push(toLocalISO(d));
    }

    const { data: plans } = await supabase
      .from("meal_plans")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .in("plan_date", dates);

    const planMap = {};
    plans?.forEach((p) => (planMap[p.plan_date] = p));

    let newHTML = "";
    const fmt = (dStr) => {
      const d = parseLocalDate(dStr);
      return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    };

    for (let i = -1; i < 7; i++) {
      // Map i (-1 to 6) to the array indices bounds (0 to 8)
      const arrayIndex = i + 1;
      const dateSession = dates[arrayIndex];
      const dateNextDay = dates[arrayIndex + 1];

      const sessionLabel = fmt(dateSession);
      const nextDayLabel = fmt(dateNextDay);

      const isFirstCard = i === 0;
      const isPastCard = i === -1;

      const nPlan = planMap[dateSession];
      const dPlan = planMap[dateNextDay];

      const nightActive = nPlan ? nPlan.night_count > 0 : false;
      const dayActive = dPlan ? dPlan.day_count > 0 : false;

      // Lock Logic (Visual Only - Security is in toggle function)
      const userRole = currentUser?.role;
      const isAdmin = userRole === "admin" || userRole === "manager";
      
      let isNightLocked = !isAdmin && isMealLocked(dateSession, "night");
      let isDayLocked = !isAdmin && isMealLocked(dateNextDay, "day");
      
      if (isPastCard) {
          isNightLocked = true;
          isDayLocked = true;
      }
      
      const lockIcon = `<span style="font-size:10px; margin-left:4px;">🔒</span>`;

      const cardOpacityStyle = isPastCard ? 'style="opacity: 0.6; pointer-events: none; filter: grayscale(1); border-left: 3px solid #6b7280;"' : '';
      const subLabelText = isPastCard ? "LAST SESSION" : (isFirstCard ? "ACTIVE SESSION" : "UPCOMING");

      newHTML += `
            <div class="scheduler-card ${isFirstCard ? "is-today" : ""}" ${cardOpacityStyle}>
                <div class="sched-date-main">${sessionLabel} Bazar</div>
                <div class="sched-sub-label">${subLabelText}</div>
                
                <div class="sched-actions">
                    <button class="sched-btn night-btn ${nightActive ? "active" : ""}" 
                        ${isPastCard ? "" : `onclick="toggleSchedulerPlan('${dateSession}', 'night', this)"`}
                        style="${isNightLocked ? "opacity: 0.6;" : ""}">
                        <span class="status-text">${nightActive ? "ON" : "OFF"}</span>
                        <span class="btn-label"> Night <span class="btn-date-micro">${sessionLabel}</span> ${isNightLocked ? lockIcon : ""}</span>
                    </button>
                    
                    <button class="sched-btn day-btn ${dayActive ? "active" : ""}" 
                        ${isPastCard ? "" : `onclick="toggleSchedulerPlan('${dateNextDay}', 'day', this)"`}
                        style="${isDayLocked ? "opacity: 0.6;" : ""}">
                        <span class="status-text">${dayActive ? "ON" : "OFF"}</span>
                        <span class="btn-label"> Day <span class="btn-date-micro">${nextDayLabel}</span> ${isDayLocked ? lockIcon : ""}</span>
                    </button>
                </div>
            </div>`;
    }

    container.innerHTML = newHTML;

    // Save state
    lastRenderedSessionDate = currentSessionStr;
    pageLoaded.profile = true;
  } catch (err) {
    console.error("Scheduler Error:", err);
  }
}

// Function triggered by clicking scheduler buttons (Optimistic UI Version)
async function toggleSchedulerPlan(date, type, btnElement) {
  // 1. Security Check
  const userRole = currentUser?.role;
  const isAdmin = userRole === "admin" || userRole === "manager";

  if (!isAdmin && isMealLocked(date, type)) {
    btnElement.style.animation = "shake 0.4s ease";
    setTimeout(() => (btnElement.style.animation = ""), 400);
    showNotification(
      `⛔ Locked until ${convertTo12Hour(appConfig.lock_time_end)}`,
      "error",
    );
    return;
  }

  // 2. Prevent Double Clicks
  if (btnElement.dataset.locking === "true") return;
  btnElement.dataset.locking = "true";

  // 3. OPTIMISTIC UPDATE (Instant Visual Change)
  const statusLabel = btnElement.querySelector(".status-text");
  const wasActive = btnElement.classList.contains("active");

  // Toggle visual state immediately
  if (wasActive) {
    btnElement.classList.remove("active");
    if (statusLabel) statusLabel.textContent = "OFF";
  } else {
    btnElement.classList.add("active");
    if (statusLabel) statusLabel.textContent = "ON";
  }

  try {
    // 4. DATABASE UPDATE
    const newCount = wasActive ? 0 : 1;

    // Get existing row ID first to avoid constraint errors if needed, or just upsert by key
    const { data: existing } = await supabase
      .from("meal_plans")
      .select("*")
      .eq("member_id", currentUser.member_id)
      .eq("plan_date", date)
      .maybeSingle();

    const upsertData = {
      member_id: currentUser.member_id,
      plan_date: date,
      day_count: existing ? existing.day_count : 0,
      night_count: existing ? existing.night_count : 0,
    };

    if (type === "day") upsertData.day_count = newCount;
    else upsertData.night_count = newCount;

    const { error } = await supabase
      .from("meal_plans")
      .upsert(upsertData, { onConflict: "member_id, plan_date" });

    if (error) throw error;

    // 5. CONDITIONAL LOGGING (Only log if it's the "Active Session" card)
    const activeSessionStr = getStrictSessionDate();
    const activeDateObj = parseLocalDate(activeSessionStr);
    activeDateObj.setDate(activeDateObj.getDate() + 1);
    const activeNextDayStr = toLocalISO(activeDateObj);

    let isActiveCard = false;
    if (type === "night" && date === activeSessionStr) isActiveCard = true;
    else if (type === "day" && date === activeNextDayStr) isActiveCard = true;

    if (isActiveCard) {
      const actorName = currentUser.name || "User";
      const actionText = newCount > 0 ? "turned ON" : "turned OFF";
      const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
      const dateObj = new Date(date);
      const niceDate = dateObj.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      });

      // Log silently
      logActivity(
        `${actorName} ${actionText} their ${niceDate} ${typeLabel} meal`,
        "meal",
      );
    }

    // Update Dashboard Stats immediately if on Dashboard
    if (
      !document.getElementById("dashboardPage").classList.contains("hidden")
    ) {
      updateDashboardMealPlan();
    }
  } catch (err) {
    console.error("Plan update failed", err);
    showNotification("Failed to save plan. Reverting...", "error");

    // 6. ROLLBACK ON ERROR
    if (wasActive) {
      btnElement.classList.add("active");
      if (statusLabel) statusLabel.textContent = "ON";
    } else {
      btnElement.classList.remove("active");
      if (statusLabel) statusLabel.textContent = "OFF";
    }
  } finally {
    // Unlock
    btnElement.dataset.locking = "false";
  }
}

// --- Update loadMasterTracker ---
async function loadMasterTracker() {
  if (!currentCycleId) return;

  const table = document.getElementById("masterMatrixTable");
  if (!table) return;

  try {
    const cycle = allCycles.find((c) => c.id == currentCycleId);
    const { data: meals } = await supabase
      .from("meals")
      .select("*")
      .eq("cycle_id", currentCycleId);

    const matrixData = {};
    meals?.forEach((m) => {
      if (!matrixData[m.meal_date]) matrixData[m.meal_date] = {};
      matrixData[m.meal_date][m.member_id] = {
        d: m.day_count,
        n: m.night_count,
      };
    });

    // Fetch boundary day meals (next cycle's first date) for the last row's Day column
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    boundaryMeals.forEach((m) => {
      if (!matrixData[m.meal_date]) matrixData[m.meal_date] = {};
      matrixData[m.meal_date][m.member_id] = {
        d: m.day_count,
        n: matrixData[m.meal_date]?.[m.member_id]?.n || 0,
      };
    });

    let currentIter = parseLocalDate(cycle.start_date);
    let endIter = parseLocalDate(cycle.end_date);
    
    // --- THE CRITICAL FIX ---
    // 1. Get the actual Active Bazar Session Date (This accounts for whether auto-entry has run)
    const activeSessionDateObj = await getActiveSessionDate();
    const activeSessionStr = toLocalISO(activeSessionDateObj);

    let headerHTML = `
            <thead>
                <tr>
                    <th style="vertical-align: bottom; padding: 0;">
                        <div style="padding: 12px 8px 6px;">BAZAR</div>
                    </th>
                    ${allMembers.map((m) => `
                    <th style="padding: 0; vertical-align: bottom;">
                        <div style="padding: 12px 8px 6px;">${m.name.split(" ")[0]}</div>
                        <div style="display: flex; width: 100%; border-top: 1px dashed rgba(0,0,0,0.1); background: rgba(0,0,0,0.02);">
                
                        </div>
                    </th>`).join("")}
                </tr>
            </thead>`;

    // 2. Generate Body Rows
    let bodyHTML = "<tbody>";
    while (currentIter.getTime() <= endIter.getTime()) {
      const dateSessionStr = toLocalISO(currentIter);
      const dNext = new Date(currentIter);
      dNext.setDate(currentIter.getDate() + 1);
      const dateNextStr = toLocalISO(dNext);

      // --- UNIFIED PENDING CHECK ---
      // Both Night and Day meals of this row belong to the same "Bazar Session".
      // If this Bazar Session is >= the Active Session, it means auto-entry hasn't finalized it.
      const isPendingSession = dateSessionStr >= activeSessionStr;

      const displayDate = currentIter.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
      });
      
      // Highlight the currently active pending row
      const isTodayRow = dateSessionStr === activeSessionStr;

      bodyHTML += `<tr ${isTodayRow ? 'style="background: #f0f9ff;"' : ""}>
                <td>${displayDate}</td>
                ${allMembers
                  .map((m) => {
                    const nVal = matrixData[dateSessionStr]?.[m.id]?.n || 0;
                    const dVal = matrixData[dateNextStr]?.[m.id]?.d || 0;
                    
                    // Both share the exact same logic based on isPendingSession. No split logic.
                    const nDisplay = nVal > 0 ? nVal : (isPendingSession ? "-" : "0");
                    const dDisplay = dVal > 0 ? dVal : (isPendingSession ? "-" : "0");
                    
                    return `
                        <td>
                            <div class="cell-split-premium" onclick="openMealModal('${m.id}', '${dateSessionStr}', ${nVal}, ${dVal})">
                                <div class="cell-val-half night ${nVal > 0 ? "active" : "zero"}">${nDisplay}</div>
                                <div class="cell-val-half day ${dVal > 0 ? "active" : "zero"}">${dDisplay}</div>
                            </div>
                        </td>`;
                  })
                  .join("")}
            </tr>`;

      currentIter.setDate(currentIter.getDate() + 1);
    }
    bodyHTML += "</tbody>";

    // 3. Update Table
    table.innerHTML = headerHTML + bodyHTML;
    pageLoaded.tracker = true;
  } catch (err) {
    console.error("Tracker Sync Error:", err);
  }
}

// --- Update loadWeeklyMenuEditor ---
async function loadWeeklyMenuEditor() {
  const tbody = document.getElementById("weeklyMenuBody");
  const isAdmin =
    currentUser.role === "admin" || currentUser.role === "manager";

  try {
    const { data, error } = await supabase
      .from("weekly_menus")
      .select("*")
      .order("day_index", { ascending: true });
    if (error) throw error;

    const order = [6, 0, 1, 2, 3, 4, 5];
    const sortedData = order.map((idx) =>
      data.find((d) => d.day_index === idx),
    );

    tbody.innerHTML = sortedData
      .map(
        (day) => `
            <tr>
                <td class="menu-day-label">${day.day_name}</td>
                <td style="padding-right: 5px;">
                    <input type="text" id="night-${day.day_index}" class="menu-input-pill" 
                        value="${day.night_menu || ""}" ${!isAdmin ? "disabled" : ""} 
                        onchange="saveDayMenu(${day.day_index})" placeholder="Night...">
                </td>
                <td>
                    <input type="text" id="day-${day.day_index}" class="menu-input-pill" 
                        value="${day.day_menu || ""}" ${!isAdmin ? "disabled" : ""} 
                        onchange="saveDayMenu(${day.day_index})" placeholder="Day...">
                </td>
            </tr>
        `,
      )
      .join("");
  } catch (err) {
    console.error(err);
  }
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

    // 1. LOG & FORCE REFRESH (Bypassing Cooldown)
    console.log("🔄 Refreshing view: NOTIFICATIONS");

    // Show loading state briefly in the list if you want, or just fetch
    const container = document.getElementById("notifListContainer");
    if (container.innerHTML.trim() === "")
      container.innerHTML = '<div class="loading">Syncing...</div>';

    loadNotifications().then(() => {
      console.log("✅ Notifications Synced");
    });

    // 2. TOGGLE UI
    document.getElementById("notifPanel").classList.toggle("active");

    // 3. CLEAR BADGE
    document.getElementById("notifBadge").classList.add("hidden");
    // Reset badge count logic if you track it in a variable
    document.getElementById("notifBadge").textContent = "0";
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
}

async function loadNotifications() {
  if (!currentCycleId) return;

  try {
    const targetCycleId = parseInt(currentCycleId);
    console.log("🔔 Fetching notifications for cycle:", targetCycleId);

    const { data, error } = await supabase
      .from("notifications")
      .select(
        `
                id, 
                message, 
                type, 
                created_at, 
                member_id,
                members (
                    name, 
                    role
                )
            `,
      )
      .eq("cycle_id", targetCycleId)
      .order("created_at", { ascending: false });
    // REMOVED .limit(50) here to allow unlimited loading

    if (error) throw error;

    allNotifications = data || [];
    renderNotifications();
  } catch (err) {
    console.error("❌ Notification Fetch Error:", err);
    const container = document.getElementById("notifListContainer");
    if (container)
      container.innerHTML = `<div class="loading" style="color:red">Failed to load history.</div>`;
  }
}

function renderNotifications() {
  const container = document.getElementById("notifListContainer");
  if (!container) return;

  // Filter logic
  const filtered = allNotifications.filter((n) => {
    if (currentNotifFilter === "all") return true;
    if (currentNotifFilter === "meal") return n.type && n.type.includes("meal");
    return n.type === currentNotifFilter;
  });

  if (filtered.length === 0) {
    container.innerHTML =
      '<div style="text-align:center; padding:40px 20px; color:#aaa;">No history found for this cycle.</div>';
    return;
  }

  container.innerHTML = filtered
    .map((notif) => {
      let typeClass = "type-other";
      let icon = "⚙️";
      if (notif.type === "deposit") {
        typeClass = "type-deposit";
        icon = "💰";
      }
      if (notif.type === "expense") {
        typeClass = "type-expense";
        icon = "🛒";
      }
      if (notif.type && notif.type.includes("meal")) {
        typeClass = "type-meal";
        icon = "🍽️";
      }

      const dateObj = new Date(notif.created_at);
      const displayTime =
        dateObj.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
        }) +
        " • " +
        dateObj.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });

      // --- FIXED AUTHOR LOGIC IN renderNotifications ---
      let authorMarkup =
        '<span style="color:var(--text-secondary)">System</span>';

      if (notif.members) {
        const role = notif.members.role;
        const name = notif.members.name;

        if (role === "admin") {
          authorMarkup = `<span style="color:var(--primary-color); font-weight:800;">Admin</span>`;
        } else if (role === "manager") {
          // Show Manager + their name for clarity
          authorMarkup = `<span style="color:var(--secondary-color); font-weight:800;">Manager (${name.split(" ")[0]})</span>`;
        } else {
          authorMarkup = `<span style="font-weight:600;">${name}</span>`;
        }
      }
      return `
        <div class="notif-item ${typeClass}" onclick="handleNotifClick('${notif.type}')">
            <div style="display:flex; gap:10px; align-items:flex-start;">
                <div style="font-size:18px;">${icon}</div>
                <div style="flex:1;">
                    <div style="font-size:13px; color:var(--text-primary); line-height:1.4;">${notif.message}</div>
                    <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:10px; color:var(--text-secondary);">
                        <span>${displayTime}</span>
                        <span>By: ${authorMarkup}</span>
                    </div>
                </div>
            </div>
        </div>
        `;
    })
    .join("");
}

// Updated Log Activity (Uses member_id)
async function logActivity(message, type = "info") {
  if (!currentCycleId) return;

  try {
    // Use the member_id from our currentUser object
    const actorMemberId = currentUser?.member_id;

    const { error } = await supabase.from("notifications").insert({
      cycle_id: parseInt(currentCycleId),
      message: message,
      type: type,
      member_id: actorMemberId, // This links the name/role to the log
    });

    if (error) throw error;

    // Refresh local view
    if (document.getElementById("notifPanel").classList.contains("active")) {
      loadNotifications();
    }
  } catch (err) {
    console.error("Logging Error:", err.message);
  }
}

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
                <div class="list-item-title">${notif.message}</div>
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
      console.log(
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
async function loadMembers() {
  try {
    const { data, error } = await supabase
      .from("members")
      .select("*")
      .order("name");

    if (error) throw error;

    allMembers = data || [];
    populateMemberSelects();
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
  ];

  selects.forEach((selectId) => {
    const select = document.getElementById(selectId);
    if (!select) return;

    // Save current selection if refreshing
    const currentValue = select.value;

    // Clear and add placeholder
    select.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Select...";
    select.appendChild(defaultOption);

    // Populate Members
    allMembers.forEach((member) => {
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

// Ensure the Menu button (sidebar trigger) works
document.getElementById("mobileMenuBtn").addEventListener("click", (e) => {
  e.preventDefault();
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  sidebar.classList.add("mobile-active");
  overlay.classList.add("active");
});

function refreshCurrentPage() {
  // Find which page is active (has no 'hidden' class)
  const activePage = document.querySelector(".page-content:not(.hidden)");

  if (activePage) {
    const pageId = activePage.id.replace("Page", "");
    console.log(`🔄 Refreshing view: ${pageId}`);
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
        .select("amount")
        .eq("cycle_id", currentCycleId)
        .neq("status", "pending"),

      // Critical Fix: Summing actual DB rows for the Pulse Card
      supabase
        .from("meal_plans")
        .select("night_count")
        .eq("plan_date", sessionDateStr),
      supabase
        .from("meal_plans")
        .select("day_count")
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

    // 4. CALCULATE PULSE CARD COUNTS (Live Schedule)
    // This is the fix: We sum the rows directly. No guessing.
    const liveNightCount =
      plansNightRes.data?.reduce((sum, row) => sum + row.night_count, 0) || 0;
    const liveDayCount =
      plansDayRes.data?.reduce((sum, row) => sum + row.day_count, 0) || 0;

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

    // C. Update Liquidity Meter (Vertical Bar)
    updateLiquidityMeter(liquidity);

    // D. Trigger Background Updates
    loadSystemStatus();
    loadRecentActivity();
    updateDashboardBadges();
    updatePendingCounts();
  } catch (err) {
    console.error("Dashboard Load Error:", err);
  }
}

function updateLiquidityMeter(liquidity) {
  const balEl = document.getElementById("statMessBalance");
  const container = document.getElementById("messBalanceContainer");
  const fillBar = document.getElementById("liquidFillBar");
  const pill = document.getElementById("balanceStatusPill");
  const percentEl = document.getElementById("liquidPercent");

  if (!balEl || !container) return;

  // Update Number
  balEl.textContent =
    typeof toBn === "function"
      ? toBn(Math.round(liquidity).toLocaleString())
      : Math.round(liquidity).toLocaleString();

  // Calculate Percentage (0-10,000 range cap)
  let percent = Math.max(0, Math.min(100, (liquidity / 10000) * 100));
  let visualPercent = liquidity <= 0 ? 3 : percent < 5 ? 5 : percent;

  // Update Visuals
  fillBar.style.setProperty("--fill-percent", `${visualPercent}%`);
  percentEl.textContent = `${Math.round(percent)}%`;

  // Reset Classes
  container.classList.remove(
    "state-healthy-liquid",
    "state-critical-liquid",
    "state-empty-liquid",
  );

  // Apply State
  if (liquidity >= 1000) {
    container.classList.add("state-healthy-liquid");
    pill.textContent = "HEALTHY";
    pill.style.color = "#047857";
    pill.style.background = "#d1fae5";
    pill.style.border = "1px solid #a7f3d0";
  } else if (liquidity > 0) {
    container.classList.add("state-critical-liquid");
    pill.textContent = "LOW FUNDS";
    pill.style.color = "#b91c1c";
    pill.style.background = "#fee2e2";
    pill.style.border = "1px solid #fecaca";
  } else {
    container.classList.add("state-critical-liquid");
    pill.textContent = "DEFICIT";
    pill.style.color = "#7f1d1d";
    pill.style.background = "#fef2f2";
    pill.style.border = "1px solid #fecaca";
  }

  // 🤖 Update Mr. Taka's mood
  updateMascotMood(liquidity);
}

// ==========================================
// 🤖 MR. TAKA - MASCOT MOOD ENGINE
// ==========================================

const MASCOT_MOODS = ['mood-ecstatic', 'mood-happy', 'mood-neutral', 'mood-worried', 'mood-critical'];
let currentMascotMood = '';
let mascotSpeechTimeout = null;
let mascotIdleInterval = null;
let mascotPhysicalIdleTimeout = null;
let lastLiquidity = null;
let mascotInitialized = false;
let mascotAudioCtx = null;
let userHasInteracted = false;
document.addEventListener('click', () => { userHasInteracted = true; }, { once: true });
document.addEventListener('touchstart', () => { userHasInteracted = true; }, { once: true });

/**
 * Initializes Audio Context on first interaction (required by browsers)
 */
function initMascotAudio() {
    if (mascotAudioCtx) return;
    mascotAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

/**
 * Synthesizes a cartoonish sound effect using Web Audio API
 */
function playMascotSound(type = 'pop') {
    if (!userHasInteracted) return;
    if (!mascotAudioCtx) initMascotAudio();
    if (mascotAudioCtx.state === 'suspended') mascotAudioCtx.resume();

    const osc = mascotAudioCtx.createOscillator();
    const gain = mascotAudioCtx.createGain();
    
    osc.connect(gain);
    gain.connect(mascotAudioCtx.destination);

    const now = mascotAudioCtx.currentTime;

    if (type === 'pop') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
    } else if (type === 'boing') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.2);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
    } else if (type === 'bleep') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.setValueAtTime(1200, now + 0.05);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
    } else if (type === 'tada') {
        // High pitched sparkle sound
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, now);
        osc.frequency.exponentialRampToValueAtTime(2000, now + 0.3);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
    }
}


/**
 * Initializes touch and click interactions for the mascot.
 */
function initMascotInteractions() {
    const mascot = document.getElementById('mascotCharacter');
    if (!mascot || mascotInitialized) return;

    let pressTimer;
    let startX, startY;

    // --- Tap / Click ---
    // Single click handler for standard taps
    mascot.addEventListener('click', (e) => {
        const diffX = Math.abs(e.clientX - startX);
        const diffY = Math.abs(e.clientY - startY);
        // Only trigger if it wasn't a long drag/swipe
        if (diffX < 10 && diffY < 10) {
            triggerTapReaction();
        }
    });
    
    mascot.addEventListener('mousedown', (e) => handleStart(e.clientX, e.clientY));
    mascot.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        handleStart(touch.clientX, touch.clientY);
    }, { passive: true });

    const handleStart = (x, y) => {
        startX = x;
        startY = y;
        mascot.classList.add('tapped');
        
        // Play click/tap sound
        playMascotSound(Math.random() > 0.5 ? 'pop' : 'bleep');

        pressTimer = setTimeout(() => {
            showMascotSpeech("আমাকে চাপ দিয়ে ধরলে  সব ঠিক হয়ে যাবে ভাবছো? এত সহজ না ভাই 😎", 3000);
            mascot.classList.add('long-pressed');
        }, 800);
    };

    const handleEnd = (x, y) => {
        clearTimeout(pressTimer);
        
        // Brief delay for the tap animation to finish
        setTimeout(() => {
            mascot.classList.remove('tapped', 'long-pressed');
        }, 300);


        if (startX === undefined) return; // Guard

        const diffX = x - startX;
        const diffY = y - startY;

        // Swipe Detection - only if dragged significantly
        if (Math.abs(diffX) > 50) {
            const direction = diffX > 0 ? 'right' : 'left';
            mascot.classList.add(`lean-${direction}`);
            showMascotSpeech(direction === 'right' ? "Whoa, tilting right! 🎢" : "Leaning left! 🎡", 1500);
            setTimeout(() => mascot.classList.remove(`lean-${direction}`), 1000);
        }
    };

    mascot.addEventListener('mouseup', (e) => handleEnd(e.clientX, e.clientY));
    mascot.addEventListener('touchend', (e) => {
        const touch = e.changedTouches[0];
        handleEnd(touch.clientX, touch.clientY);
    }, { passive: true });

    mascotInitialized = true;
}

function triggerTapReaction() {
    const phrases = [
        "এই এই, গুঁতাগুঁতি কেন? 😆",
        "জি বলেন, আবার মুরগি হবে নাকি, লালটা না সাদাটা ? 📋",
        "হিসাব খুলে বসি নাকি এখনই? 🧐",
        "ম্যানেজারকে বেশি চাপ দিয়েন না ভাই 👔",
        "কি রে বস, আবার ব্যালেন্স চেক? ব্যাংক না এটা! 😂",
        "ক্লিক করলেই ব্যালেন্স বাড়ে না কিন্তু! 😂",
        "চা খাইতে দাও, তারপর বলো ☕",
        "হিসাব ঠিক আছে, টেনশন নাই 👍"
    ];
    showMascotSpeech(pickRandom(phrases), 2000);

    // Physical Movement: Rapid Shake + Bounce
    const head = document.querySelector('.mascot-head');
    if (head) {
        head.style.animation = "mascotWorryShake 0.2s ease-in-out 2";
        setTimeout(() => {
            head.style.animation = "";
        }, 400);
    }
}


/**
 * Special greeting when app starts or user logins.
 */
function triggerMascotGreeting() {
    const mascot = document.getElementById('mascotCharacter');
    if (!mascot) return;

    // Initialization check
    if (!mascotInitialized) initMascotInteractions();

    setTimeout(() => {
setTimeout(() => {
    const phrases = [
        "আবার ফিরে আসছো নাকি ভাই? 😄",
        "কাজ শুরু করবো নাকি নাকি শুধু ঘুরতে আসছো? 😉",
        "হিসাব দেখার সময় হলো, অলস বসে থাকলে চলবে না 😅",
        "কি অবস্থা? সব ঠিকঠাক তো? 👀",
        "আরে ভাই, আমি তো রেডি — তুমিও রেডি তো?",
        "আজ একটু কাজ করি নাকি, পরে আড্ডা দিবো 😂",
        "ব্যালেন্স চেক করবা নাকি শুধু দেখতে আসছো? 😏",
        "চলো শুরু করি, সময় তো ফাঁকা বসে থাকার না!"
    ];

    showMascotSpeech(pickRandom(phrases), 2000);
}, 1000);
      
        
        // Jump/Dance reaction
        triggerMascotReaction('celebrate');
        playMascotSound('tada');
    }, 1000);
}




/**
 * Updates Mr. Taka's mood based on the current liquidity percentage.
 * Called from updateLiquidityMeter().
 */
function updateMascotMood(liquidity) {
    const mascot = document.getElementById('mascotCharacter');
    if (!mascot) return;

    if (!mascotInitialized) initMascotInteractions();

    const percent = Math.max(0, Math.min(100, (liquidity / 10000) * 100));
    let newMood = '';
    let speechText = '';

    // --- Trend Detection ---
    if (lastLiquidity !== null) {
        const diff = liquidity - lastLiquidity;
        if (diff < -1500) { // Sudden drop > 1500
            triggerMascotReaction('shock');
            showMascotSpeech("WHOA! That was a big drop! 😱", 4000);
        } else if (diff > 1500) { // Sudden growth > 1500
            triggerMascotReaction('celebrate');
            showMascotSpeech("Wow! Big growth! 🚀📈", 4000);
        }
    }
    lastLiquidity = liquidity;

    if (percent >= 85) {
        newMood = 'mood-ecstatic';
        speechText = pickRandom(['WOHOOO! 🕺', 'Rich as a king! 👑', 'Surplus vibes! 💰', 'Party funded! 🥳']);
    } else if (percent >= 60) {
        newMood = 'mood-happy';
        speechText = pickRandom(['Feeling great! 😊', 'Healthy budget! ✅', 'Looking solid! 💪']);
    } else if (percent >= 30) {
        newMood = 'mood-neutral';
        speechText = pickRandom(['Steady as she goes. 🚢', 'Everything\'s normal. 📊', 'Monitoring... 🧐']);
    } else if (percent >= 15) {
        newMood = 'mood-worried';
        speechText = pickRandom(['Budget getting thin... 😰', 'Deposit please? 🙏', 'Careful now! ⚠️']);
    } else {
        newMood = 'mood-critical';
        speechText = pickRandom(['EMERGENCY! 🆘', 'Broken piggy bank! 😭', 'Funds depleted! 💀']);
    }

    if (newMood !== currentMascotMood) {
        MASCOT_MOODS.forEach(m => mascot.classList.remove(m));
        mascot.classList.add(newMood);
        currentMascotMood = newMood;
        showMascotSpeech(speechText);
    }

    if (!mascotIdleInterval) startMascotIdleSpeech();
}


/**
 * Shows a speech bubble above Mr. Taka for a few seconds.
 */
function showMascotSpeech(text, duration = 4000) {
    const mascot = document.getElementById('mascotCharacter');
    const speechEl = document.getElementById('mascotSpeech');
    if (!mascot || !speechEl) return;

    // Clear previous timeout
    if (mascotSpeechTimeout) clearTimeout(mascotSpeechTimeout);

    speechEl.textContent = text;
    mascot.classList.add('show-speech');

    mascotSpeechTimeout = setTimeout(() => {
        mascot.classList.remove('show-speech');
    }, duration);
}

/**
 * Triggers a temporary emotional reaction animation.
 * type: 'deposit' | 'expense'
 */
function triggerMascotReaction(type) {
    const mascot = document.getElementById('mascotCharacter');
    if (!mascot) return;

    const reactClass =
        type === 'approval-deposit' || type === 'deposit' || type === 'celebrate'
            ? 'react-deposit'
            : 'react-expense';

    // Play contextual sound
    if (type === 'deposit' || type === 'celebrate') playMascotSound('boing');
    if (type === 'expense') playMascotSound('pop');
    if (type.startsWith('approval')) playMascotSound('bleep');

    /* ================= DEPOSIT ================= */
    if (type === 'deposit') {
        const phrases = [
            "ওহো টাকা ঢুকলো নাকি? এবার মেসের বিল নিয়ে কথা কম হবে 😂",
            "ডিপোজিট আসছে… এখন আমি একটু খুশি হওয়ার নাটক করি 💰😏",
            "টাকা এলে সবাই ভালো লাগে, আমি তো শুধু হিসাব রাখি ভাই!",
            "আরে বাহ! ওয়ালেট একটু মোটা হলো দেখি 🤑",
            "ডিপোজিট নোটেড… কিন্তু খরচের সময় কাঁপবো না তো? 😆"
        ];
        showMascotSpeech(pickRandom(phrases), 3500);
    }

    /* ================= EXPENSE ================= */
    else if (type === 'expense') {
        const phrases = [
            "আবার খরচ? মেসের বাজার নাকি ভাই? 💸😂",
            "টাকা বের হলো… এখন ব্যালেন্স কাঁদতেছে 😏",
            "এত খরচ করলে আমি কি করবো বলো? 📉",
            "Expense রেকর্ড হলো… কিন্তু রসিদ আছে তো? 🧐",
            "ভাই সাবধানে খরচ করো, ব্যাংক না এটা!"
        ];
        showMascotSpeech(pickRandom(phrases), 3500);
    }

    /* ================= APPROVAL DEPOSIT ================= */
    else if (type === 'approval-deposit') {
        const phrases = [
            "এডমিন বলছে OK… টাকা এখন অফিসিয়ালি ঢুকে গেছে 💰🫡",
            "অনুমোদন মিললো! ব্যালেন্স আপডেট হয়ে গেলো 📈",
            "ম্যানেজার সাইন দিলো — এখন হিসাব ক্লিয়ার!",
            "Approved! Liquidity একটু শান্ত হলো 😌"
        ];
        showMascotSpeech(pickRandom(phrases), 3500);
    }

    /* ================= APPROVAL EXPENSE ================= */
    else if (type === 'approval-expense') {
        const phrases = [
            "Expense Approve! বাজার এখন অফিসিয়ালি শুরু 🥗😂",
            "সাইন হয়ে গেছে… টাকা চলে যাবে এখন 💸",
            "রিসিপ্ট রাখো ভাই, পরে হিসাব লাগবে 😏",
            "Approved… কিন্তু আমি চোখ রাখছি ব্যালেন্সে 👀"
        ];
        showMascotSpeech(pickRandom(phrases), 3500);
    }

    if (reactClass) {
        mascot.classList.add(reactClass);
        setTimeout(() => mascot.classList.remove(reactClass), 2500);
    }
}



/**
 * Starts a random idle speech system so Mr. Taka talks occasionally.
 */
function startMascotIdleSpeech() {
    const scheduleNextSpeech = () => {
        const delay = 10000 + Math.random() * 20000;
        mascotIdleInterval = setTimeout(() => {
const idlePhrases = {
  'mood-ecstatic': [
    'এই মাসে তো রাজা আমি! 👑',
    'আজকে মুরগি এক্সট্রা দাও! 🍗',
    'হিসাব বই দেখে আম্মুও খুশি হতো! 😎',
    'বাজেট দেখে মনটা নাচতেছে 💃'
  ],

  'mood-happy': [
    'চাল ডাল ঠিকঠাক চলছে 👍',
    'এইভাবেই থাকলে বেঁচে যামু 😌',
    'মেসে আজ শান্তি বিরাজ করছে 🏠',
    'হিসাব মিলছে, মনও মিলছে 😄'
  ],

  'mood-neutral': [
    'বাজারের দাম আবার বাড়লো নাকি? 🛒',
    'ক্যালকুলেটরটা গরম হয়ে গেছে 🔢',
    'চা ছাড়া কাজ চলে নাকি ভাই ☕',
    'হিসাব করি, জীবন চলে… 😐'
  ],

 'mood-worried': [
  'ভাই একটু হিসাব টাইট হয়ে গেছে 😰',
  'কে কে এখনো টাকা দেয় নাই? 👀',
  'চাল কম খাইলে চলবে নাকি? ⚠️',
  'এই মাসে টেনশন ফ্রি না 😓',
  'টাকা দেস না কেন ভাই? হিসাব তো আটকে আছে! 💸',
  'বিল তো নিজেরে নিজে পে করবে না 😅',
  'সবাই চুপ… কিন্তু টাকা জমা নাই কেন? 🤨',
  'ভাই আগে দেনা মেটাও, তারপর আরাম করো!'
],

'mood-critical': [
  'ভাই চাঁদা না দিলে গ্যাস বন্ধ! 🔥',
  'ডিম অর্ধেক করে ভাগ করমু নাকি? 🥚',
  'হিসাব বই কাঁদতেছে 😭',
  'এই মাসে শুধু আলু ভর্তা 🥔',
  'টাকা দেস না কেন ভাই? মেস চালানো তো ফ্রি না! 😤',
  'ফান্ড শূন্য… এখন সিরিয়াস হও সময় 😬',
  'ব্যালেন্স লাল হয়ে গেছে, আগে সেটেল করো! 🚨',
  'দায় এড়িয়ে গেলে হিসাব মাফ হয় না ভাই 😏'
]
};

            const phrases = idlePhrases[currentMascotMood] || idlePhrases['mood-neutral'];
            
            // Randomly do a "Dance Break" if balance is good
            if (currentMascotMood === 'mood-ecstatic' && Math.random() > 0.7) {
                showMascotSpeech("DANCE BREAK! 🕺✨", 2000);
            } else {
                showMascotSpeech(pickRandom(phrases), 3500);
            }

            scheduleNextSpeech();

        }, delay);
    };

    const scheduleNextPhysicalMove = () => {
        const delay = 5000 + Math.random() * 10000;
        mascotPhysicalIdleTimeout = setTimeout(() => {
            const mascot = document.getElementById('mascotCharacter');
            if (!mascot) return;

            // Random small physical animations via temporary classes or direct styles
            const head = document.querySelector('.mascot-head');
            if (head) {
                const moves = [
                    () => head.style.transform = "translateX(-50%) rotate(5deg)",
                    () => head.style.transform = "translateX(-50%) rotate(-5deg)",
                    () => head.style.transform = "translateX(-50%) translateY(-3px)",
                    () => triggerMascotReaction('nothing') // Just the bounce
                ];
                pickRandom(moves)();
                setTimeout(() => head.style.transform = "", 1000);
            }
            scheduleNextPhysicalMove();
        }, delay);
    };

    scheduleNextSpeech();
    scheduleNextPhysicalMove();
}


/**
 * Utility: Pick a random element from an array.
 */
function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

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

// --- Update loadRecentActivity for the new feed style ---
async function loadRecentActivity() {
  const container = document.getElementById("recentActivity");
  if (!container) return;

  try {
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("cycle_id", currentCycleId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML =
        '<div style="font-size:11px; color:gray; text-align:center; padding:20px;">No recent activity found.</div>';
      return;
    }

    container.innerHTML = data
      .map((notif) => {
        let icon = "🔔";
        if (notif.type === "meal") icon = "🍽️";
        if (notif.type === "deposit") icon = "💰";
        if (notif.type === "expense") icon = "🛒";

        return `
            <div class="feed-item">
                <div class="feed-icon">${icon}</div>
                <div class="feed-content">
                    <div class="msg">${notif.message}</div>
                    <div class="time">${formatDate(notif.created_at)}</div>
                </div>
            </div>`;
      })
      .join("");
  } catch (err) {
    console.error("Activity Feed Error:", err);
  }
}

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
                    <img src="${member.avatar_url}" alt="Profile">
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
  const newUrl = prompt(
    "Enter the direct link to your new profile picture:",
    currentUrl,
  );

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
      container.innerHTML = '<div class="loading">No deposits yet</div>';
      return;
    }

    container.innerHTML = data
      .map(
        (deposit) => `
                <div class="list-item">
                    <div class="list-item-info">
                        <div class="list-item-title">${deposit.label || "Deposit"}</div>
                       <div class="list-item-subtitle">${formatDateTime(deposit.created_at)}</div>
                    </div>
                    <div class="list-item-amount balance-positive">${formatCurrency(deposit.amount)}</div>
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
    // console.log("Default updated");

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
  const dayBtn = document.getElementById("defDayBtn");
  const nightBtn = document.getElementById("defNightBtn");

  if (dayBtn) {
    dayBtn.className = `def-btn ${member.default_day_on ? "active" : ""}`;
    dayBtn.textContent = `Default Day: ${member.default_day_on ? "ON" : "OFF"}`;
  }

  if (nightBtn) {
    nightBtn.className = `def-btn ${member.default_night_on ? "active" : ""}`;
    nightBtn.textContent = `Default Night: ${member.default_night_on ? "ON" : "OFF"}`;
  }
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

// ============================================
// TRACKER PAGE
// ============================================

function loadTracker() {
  // The old dropdown logic is gone.
  // We simply load the master matrix now.
  loadMasterTracker();
}

async function loadMemberCalendar(memberId) {
  if (!currentCycleId) return;

  try {
    const cycle = allCycles.find((c) => c.id === currentCycleId);
    if (!cycle) return;

    const startDate = new Date(cycle.start_date);
    const endDate = new Date(cycle.end_date);

    // Fetch meals for this member and cycle
    const { data: meals } = await supabase
      .from("meals")
      .select("*")
      .eq("cycle_id", currentCycleId)
      .eq("member_id", memberId);

    const mealMap = {};
    meals?.forEach((meal) => {
      mealMap[meal.meal_date] = meal;
    });

    const calendarGrid = document.getElementById("calendarGrid");
    calendarGrid.innerHTML = "";

    // Generate calendar days
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      const dateStr = toLocalISO(d);
      const meal = mealMap[dateStr];
      const totalMeals = meal
        ? parseFloat(meal.day_count) + parseFloat(meal.night_count)
        : 0;

      const todayStr = toLocalISO(new Date());
      const isFuture = dateStr > todayStr;
      const displayMeals = totalMeals > 0 ? totalMeals.toFixed(1) : (isFuture ? "-" : "0");

      const dayDiv = document.createElement("div");
      dayDiv.className = "calendar-day" + (totalMeals > 0 ? " has-meal" : "");
      dayDiv.innerHTML = `
                    <div class="calendar-day-number">${d.getDate()}</div>
                    <div class="calendar-day-meals">${displayMeals}</div>
                `;

      // Only managers and admins can edit
      if (currentUser.role === "admin" || currentUser.role === "manager") {
        dayDiv.addEventListener("click", () => {
          openMealModal(memberId, dateStr, meal);
        });
      }

      calendarGrid.appendChild(dayDiv);
    }
  } catch (err) {
    console.error("Error loading calendar:", err);
  }
}

function openMealModal(memberId, sessionDate, currentNightVal, nextDayVal) {
  const dSession = new Date(sessionDate);
  const dNext = new Date(dSession);
  dNext.setDate(dSession.getDate() + 1);
  const nextDateStr = toLocalISO(dNext);

  const fmt = (d) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const member = allMembers.find((m) => m.id == memberId);

  // Set Hidden Fields
  document.getElementById("mealMemberId").value = memberId;
  document.getElementById("mealDateSession").value = sessionDate;
  document.getElementById("mealDateNext").value = nextDateStr;

  // Set Values
  document.getElementById("mealNightCount").value = currentNightVal;
  document.getElementById("mealDayCount").value = nextDayVal;

  // PERMISSION CHECK
  const isAdminOrManager =
    currentUser.role === "admin" || currentUser.role === "manager";
  const saveBtn = document.querySelector('#mealForm button[type="submit"]');
  const nightInput = document.getElementById("mealNightCount");
  const dayInput = document.getElementById("mealDayCount");
  const modalTitle = document.getElementById("mealModalTitle");

  if (!isAdminOrManager) {
    // Mode: View Only
    saveBtn.classList.add("hidden"); // Ensure .hidden is in your CSS or use .style.display='none'
    saveBtn.style.display = "none";
    nightInput.disabled = true;
    dayInput.disabled = true;
    modalTitle.innerHTML = `<div style="color:var(--text-secondary); font-size:14px;">View Session: ${member?.name}</div>
                               <div style="font-size:11px; color:var(--danger-color); font-weight:700;">READ ONLY MODE</div>`;
  } else {
    // Mode: Edit
    saveBtn.classList.remove("hidden");
    saveBtn.style.display = "block";
    nightInput.disabled = false;
    dayInput.disabled = false;
    modalTitle.innerHTML = `<div style="color:var(--primary-color); font-size:16px;">Edit Session: ${member?.name}</div>
                               <div style="font-size:11px;">Bazar Date: ${fmt(dSession)}</div>`;
  }

  document.getElementById("mealNightLabel").innerHTML =
    `Night (${fmt(dSession)})`;
  document.getElementById("mealDayLabel").innerHTML = `Day (${fmt(dNext)})`;

  document.getElementById("mealModal").classList.add("active");
}

function closeMealModal() {
  document.getElementById("mealModal").classList.remove("active");
}

// ==========================================
// UPDATED MEAL FORM HANDLER
// ==========================================
// ==========================================
// UPDATED MEAL FORM HANDLER (FIXED NOTIFICATION)
// ==========================================
document.getElementById("mealForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const originalText = btn.textContent;

  const memberId = parseInt(document.getElementById("mealMemberId").value);
  const sessionDate = document.getElementById("mealDateSession").value;
  const nextDate = document.getElementById("mealDateNext").value;
  const nightVal =
    Math.round(parseFloat(document.getElementById("mealNightCount").value)) ||
    0;
  const dayVal =
    Math.round(parseFloat(document.getElementById("mealDayCount").value)) || 0;

  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const { data: existingRows } = await supabase
      .from("meals")
      .select("*")
      .eq("member_id", memberId)
      .in("meal_date", [sessionDate, nextDate]);
    const findRow = (d) => existingRows?.find((r) => r.meal_date === d);
    const rowSession = findRow(sessionDate);
    const rowNext = findRow(nextDate);

    // Determine correct cycle_id for the next-day record (handles cross-cycle boundary)
    const cycle = allCycles.find(c => c.id == currentCycleId);
    const nextDayCycleId = (cycle && nextDate > cycle.end_date)
      ? (rowNext?.cycle_id || allCycles.find(c => c.start_date <= nextDate && c.end_date >= nextDate)?.id || currentCycleId)
      : currentCycleId;

    const upserts = [
      {
        cycle_id: currentCycleId,
        member_id: memberId,
        meal_date: sessionDate,
        night_count: nightVal,
        day_count: rowSession ? rowSession.day_count : 0,
      },
      {
        cycle_id: nextDayCycleId,
        member_id: memberId,
        meal_date: nextDate,
        day_count: dayVal,
        night_count: rowNext ? rowNext.night_count : 0,
      },
    ];

    const { error } = await supabase
      .from("meals")
      .upsert(upserts, { onConflict: "member_id, meal_date" });
    if (error) throw error;

    const actor = currentUser.members ? currentUser.members.name : "Admin";
    const targetMember = allMembers.find((m) => m.id === memberId);
    await logActivity(
      `Tracker Override: ${targetMember?.name}'s session (${sessionDate}) set to N:${nightVal} D:${dayVal} by ${actor}`,
      "meal",
    );

    closeMealModal();
    await loadMasterTracker();
    showNotification("Session updated", "success");
  } catch (err) {
    showNotification(err.message, "error");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
});

// Add this helper function
function getStrictSessionDate() {
  const now = new Date();

  // Parse the Bazar End Time from config (e.g., "19:00")
  const endTimeStr = appConfig.lock_time_end || "19:00";
  const [endH, endM] = endTimeStr.split(":").map(Number);

  const bazarDeadline = new Date();
  bazarDeadline.setHours(endH, endM, 0, 0);

  // If we are PAST the deadline (e.g., it's 8 PM), the "Session" is Tomorrow.
  if (now > bazarDeadline) {
    const tomorrow = new Date();
    tomorrow.setDate(now.getDate() + 1);
    return toLocalISO(tomorrow);
  } else {
    // Otherwise, the Session is Today.
    return toLocalISO(now);
  }
}

// ============================================
// SUMMARY PAGE
// ============================================

async function loadSummary() {
  if (!currentCycleId) return;

  const tbody = document.getElementById("summaryTableBody");
  if (!tbody) return;

  try {
    const sessionDate = await getActiveSessionDate();
    const nightDateStr = toLocalISO(sessionDate);

    // Calculate next day properly
    const nextDay = new Date(sessionDate);
    nextDay.setDate(sessionDate.getDate() + 1);
    const dayDateStr = toLocalISO(nextDay);

    const [mealsRes, plansRes, depositsRes, expensesRes] = await Promise.all([
      supabase.from("meals").select("*").eq("cycle_id", currentCycleId),
      supabase
        .from("meal_plans")
        .select("*")
        .in("plan_date", [nightDateStr, dayDateStr]),
      supabase
        .from("deposits")
        .select("*")
        .eq("cycle_id", currentCycleId)
        .neq("status", "pending"),
      supabase
        .from("expenses")
        .select("*")
        .eq("cycle_id", currentCycleId)
        .eq("status", "approved"),
    ]);

    const meals = mealsRes.data || [];
    const plans = plansRes.data || [];
    const deposits = depositsRes.data || [];
    const expenses = expensesRes.data || [];

    // Fetch boundary meals and cycle start date for session-corrected totals
    const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
    const cycleStartDate = allCycles.find(c => c.id == currentCycleId)?.start_date;

    // Update Top Stat Cards
    const totalExpense = expenses.reduce(
      (sum, e) => sum + parseFloat(e.amount || 0),
      0,
    );
    const allTotalMeals = adjustMealTotal(meals, boundaryMeals, cycleStartDate);
    const mealRate = allTotalMeals > 0 ? totalExpense / allTotalMeals : 0;

    document.getElementById("summaryMealRate").textContent =
      `৳${mealRate.toFixed(2)}`;
    document.getElementById("summaryTotalCost").textContent =
      `৳${Math.round(totalExpense)}`;
    document.getElementById("summaryTotalMeals").textContent =
      allTotalMeals.toFixed(0);

    // Build Table Rows
    const isAdmin =
      currentUser.role === "admin" || currentUser.role === "manager";
    const bazarCountMap = {};
    expenses.forEach((exp) => {
      bazarCountMap[exp.member_id] = (bazarCountMap[exp.member_id] || 0) + 1;
    });

    // --- UPDATE 1: ADD HEADER FOR DEPOSIT ---
    const tableHead = document.querySelector("#summaryTable thead tr");
    if (tableHead) {
      tableHead.innerHTML = `
                <th>Member</th>
                <th>🌙 Night</th>
                <th>🌞 Day</th>
                <th>Bazar</th>
                <th>Meals</th>
                <th>Deposit</th> <!-- NEW COLUMN -->
                <th>Balance</th>
            `;
    }

    tbody.innerHTML = allMembers
      .map((member) => {
        const memMeals = adjustMealTotal(meals, boundaryMeals, cycleStartDate, member.id);

        // This variable already existed in your code
        const memPaid = deposits
          .filter((d) => d.member_id === member.id)
          .reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);

        const memBal = memPaid - memMeals * mealRate;

        const nPlan = plans.find(
          (p) => p.member_id === member.id && p.plan_date === nightDateStr,
        );
        const dPlan = plans.find(
          (p) => p.member_id === member.id && p.plan_date === dayDateStr,
        );

        const nVal = nPlan ? nPlan.night_count : 0;
        const dVal = dPlan ? dPlan.day_count : 0;

        // --- UPDATE 2: ADD DATA CELL FOR DEPOSIT ---
        return `
            <tr>
                <td><strong>${member.name.split(" ")[0]}</strong></td>
                <td><button class="summary-status-btn ${nVal > 0 ? "on" : "off"}" ${isAdmin ? `onclick="quickToggleSummaryMeal(${member.id}, '${nightDateStr}', 'night', ${nVal})"` : "disabled"}>${nVal > 0 ? "ON" : "OFF"}</button></td>
                <td><button class="summary-status-btn ${dVal > 0 ? "on" : "off"}" ${isAdmin ? `onclick="quickToggleSummaryMeal(${member.id}, '${dayDateStr}', 'day', ${dVal})"` : "disabled"}>${dVal > 0 ? "ON" : "OFF"}</button></td>
                <td style="font-weight:700; color:var(--premium-indigo);">${toBn(bazarCountMap[member.id] || 0)}</td>
                <td>${toBn(memMeals.toFixed(1))}</td>
                
                <!-- NEW DEPOSIT CELL -->
                <td style="font-weight:700; color: #059669;">৳${toBn(Math.round(memPaid))}</td>
                
                <td><span class="balance-tag ${memBal >= 0 ? "pos" : "neg"}">${toBn(Math.round(memBal))}</span></td>
            </tr>`;
      })
      .join("");

    await loadDueSettlement();
  } catch (err) {
    console.error("Summary Error:", err);
    tbody.innerHTML =
      '<tr><td colspan="7" style="color:red">Error loading summary</td></tr>';
  }
}

// Function to instantly toggle meal from Summary Page
async function quickToggleSummaryMeal(memberId, dateStr, type, currentVal) {
  // --- PREVENT EDITS TO PAST CYCLES ---
  // Find which cycle this date belongs to
  const targetDateObj = parseLocalDate(dateStr);
  const targetCycle = allCycles.find(c => {
    const sDate = parseLocalDate(c.start_date);
    const eDate = parseLocalDate(c.end_date);
    // Include the boundary day (end_date + 1) which belongs to the final session
    const boundaryDate = new Date(eDate);
    boundaryDate.setDate(boundaryDate.getDate() + 1);
    return targetDateObj >= sDate && targetDateObj <= boundaryDate;
  });

  if (targetCycle && !targetCycle.is_active) {
    showNotification("Cannot edit past cycle data", "error");
    return;
  }

  const btn = event.target; // Optimistic UI
  const originalText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  // 1. Calculate New Value
  const newVal = currentVal > 0 ? 0 : 1;

  try {
    // 2. Fetch existing PLAN
    const { data: existingPlan } = await supabase
      .from("meal_plans")
      .select("*")
      .eq("member_id", memberId)
      .eq("plan_date", dateStr)
      .maybeSingle();

    // 3. Prepare Upsert Data
    const upsertPlan = {
      member_id: memberId,
      plan_date: dateStr,
      day_count: existingPlan ? existingPlan.day_count : 0,
      night_count: existingPlan ? existingPlan.night_count : 0,
    };

    if (type === "night") {
      upsertPlan.night_count = newVal;
    } else {
      upsertPlan.day_count = newVal;
    }

    // 4. Send to Database
    const { error } = await supabase
      .from("meal_plans")
      .upsert(upsertPlan, { onConflict: "member_id, plan_date" });

    if (error) throw error;

    // 5. LOGGING
    const targetMember = allMembers.find((m) => m.id === memberId);
    const targetName = targetMember ? targetMember.name : "Member";
    const actorName = currentUser.members
      ? currentUser.members.name
      : currentUser.name;

    const actionText = newVal > 0 ? "enabled" : "disabled";
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const dateObj = new Date(dateStr);
    const niceDate = dateObj.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });

    const logMsg = `${typeLabel} meal for ${niceDate} ${actionText} for "${targetName}" by "${actorName}"`;

    await logActivity(logMsg, "meal");

    // --- THE FIX STARTS HERE ---

    // A. Refresh Summary Table (Immediate UI feedback)
    await loadSummary();

    // B. Refresh Dashboard Top Card (So totals are correct instantly)
    if (typeof updateDashboardMealPlan === "function") {
      updateDashboardMealPlan();
    }

    // C. Refresh Scheduler Card (CRITICAL FIX)
    // If I changed MY OWN meal, update my scheduler immediately
    if (memberId === currentUser.member_id) {
      // 1. Force the page to reload next time we visit
      pageLoaded.profile = false;

      // 2. Clear the container so it doesn't show stale data
      const container = document.getElementById("schedulerList");
      if (container)
        container.innerHTML = '<div class="loading">Syncing changes...</div>';

      // 3. Actually reload it now in the background
      await loadScheduler();
    }

    showNotification("Schedule updated successfully", "success");
  } catch (err) {
    console.error("Quick Toggle Error", err);
    showNotification("Update failed", "error");
    btn.textContent = originalText;
  } finally {
    btn.disabled = false;
  }
}

// Replace your Export Button Logic with this:
document
  .getElementById("exportSummaryBtn")
  .addEventListener("click", async () => {
    // Check if library exists, if not, load it dynamically
    if (typeof XLSX === "undefined") {
      const btn = document.getElementById("exportSummaryBtn");
      const originalText = btn.textContent;
      btn.textContent = "Loading Library...";

      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src =
          "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.body.appendChild(script);
      });

      btn.textContent = originalText;
    }

    // Now run your existing export logic...
    const table = document.getElementById("summaryTable");
    const wb = XLSX.utils.table_to_book(table);
    XLSX.writeFile(wb, `MealCal_Summary.xlsx`);
  });

// ============================================
// JPG EXPORT SYSTEM FOR SUMMARY TABLE
// ============================================
async function exportToJPG() {
  const btn = document.getElementById("exportJPGBtn");
  const originalText = btn.textContent;
  btn.textContent = "Generating...";
  btn.disabled = true;

  try {
    if (typeof html2canvas === "undefined") {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src =
          "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.body.appendChild(script);
      });
    }

    const tableWrapper = document.querySelector(".summary-table-wrapper");
    if (!tableWrapper) {
      showNotification("No table found to export", "error");
      return;
    }

    const cycleSelect = document.getElementById("cycleSelect");
    const cycleName =
      cycleSelect?.options[cycleSelect.selectedIndex]?.text || "Summary";
    const fileName = `MealCal_${cycleName.replace(/[^a-zA-Z0-9]/g, "_")}_${
      new Date().toISOString().split("T")[0]
    }.jpg`;

    // ── Collect data ──────────────────────────────────────────────────────────
    // Get basic stats from the DOM
    const mealRateEl   = document.getElementById("summaryMealRate");
    const totalCostEl  = document.getElementById("summaryTotalCost");
    const totalMealsEl = document.getElementById("summaryTotalMeals");
    
    const mealRate   = mealRateEl?.textContent  || "৳0.00";
    const totalCost  = totalCostEl?.textContent  || "৳0";
    const totalMeals = totalMealsEl?.textContent || "0";
    const totalCostNum = parseFloat(totalCost.replace(/[৳,]/g, "")) || 0;

    // Get accurate balance from Supabase
    let currentBalance = 0;
    let totalDeposits = 0;
    
    if (currentCycleId) {
      try {
        // Fetch deposits and expenses for current cycle
        const [depositsRes, expensesRes] = await Promise.all([
          supabase
            .from("deposits")
            .select("amount")
            .eq("cycle_id", currentCycleId)
            .neq("status", "pending"),
          supabase
            .from("expenses")
            .select("amount")
            .eq("cycle_id", currentCycleId)
            .eq("status", "approved")
        ]);
        
        totalDeposits = depositsRes.data?.reduce((sum, d) => sum + parseFloat(d.amount), 0) || 0;
        const totalExpenses = expensesRes.data?.reduce((sum, e) => sum + parseFloat(e.amount), 0) || 0;
        currentBalance = totalDeposits - totalExpenses;
      } catch (e) {
        console.warn("Could not fetch balance data:", e);
      }
    }
    
    // Fallback: calculate from table if Supabase query failed
    if (Math.abs(currentBalance) < 0.01 && totalCostNum > 0) {
      const tableBody = document.getElementById("summaryTableBody");
      if (tableBody && tableBody.children.length > 0) {
        const firstRow = tableBody.querySelector("tr");
        if (firstRow && firstRow.cells.length >= 6) {
          let tableBalance = 0;
          tableBody.querySelectorAll("tr").forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 6) {
              let balanceText = cells[5]?.textContent?.trim() || "0";
              balanceText = balanceText.replace(/[৳\-\+\(\)]/g, "").trim();
              const v = parseFloat(balanceText);
              if (!isNaN(v)) {
                tableBalance += v;
              }
            }
          });
          if (Math.abs(tableBalance) > 0.01) {
            currentBalance = tableBalance;
            totalDeposits = totalCostNum + currentBalance;
          }
        }
      }
    } else if (totalDeposits === 0 && totalCostNum > 0) {
      // If still no deposits calculated, use cost as minimum deposits
      totalDeposits = totalCostNum;
    }
    
    const isPositive    = currentBalance >= 0;
    const balanceDisplay = isPositive
      ? `৳${Math.abs(currentBalance).toFixed(2)}`
      : `−৳${Math.abs(currentBalance).toFixed(2)}`;

    let cycleDateRange = "";
    if (typeof allCycles !== "undefined" && allCycles.length > 0) {
      const cur = allCycles.find((c) => c.id === currentCycleId);
      if (cur?.start_date && cur?.end_date) {
        const fmt = (d) =>
          new Date(d).toLocaleDateString("en-BD", {
            day: "numeric", month: "short", year: "numeric",
          });
        cycleDateRange = `${fmt(cur.start_date)} – ${fmt(cur.end_date)}`;
      }
    }

    const currentDate = new Date().toLocaleDateString("en-BD", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });

    // ── Root container ────────────────────────────────────────────────────────
    const wrap = document.createElement("div");
    wrap.style.cssText = `
      position: absolute;
      left: -9999px;
      top: 0;
      width: 880px;
      background: #f7f5f2;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    `;

    // ── TOP STRIPE ────────────────────────────────────────────────────────────
    const topStripe = document.createElement("div");
    topStripe.style.cssText = `
      height: 6px;
      background: linear-gradient(90deg, #4f8ef7 0%, #6c5ce7 40%, #a78bfa 75%, #c084fc 100%);
    `;
    wrap.appendChild(topStripe);

    // ── HEADER ────────────────────────────────────────────────────────────────
    const header = document.createElement("div");
    header.style.cssText = `
      padding: 34px 48px 26px;
      background: #ffffff;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #ede9e4;
    `;
    header.innerHTML = `
      <div style="display:flex; align-items:center; gap:14px;">
        <div style="
          width: 48px; height: 48px;
          background: linear-gradient(135deg, #4f8ef7, #6c5ce7);
          border-radius: 14px;
          display: flex; align-items: center; justify-content: center;
          font-size: 22px;
          box-shadow: 0 4px 14px rgba(108,92,231,0.28);
        ">🍽️</div>
        <div>
          <div style="font-size:22px; font-weight:800; color:#1a1a2e; letter-spacing:-0.6px;">
            MealCal <span style="color:#6c5ce7;">Pro</span>
          </div>
          <div style="font-size:12px; color:#9e9ba8; margin-top:2px; letter-spacing:0.3px;">
            Meal Management & Cost Tracking
          </div>
        </div>
      </div>
      <div style="
        background: #f7f5f2;
        border: 1px solid #ede9e4;
        border-radius: 12px;
        padding: 12px 20px;
        text-align: right;
      ">
        <div style="font-size:10px; color:#b0acba; text-transform:uppercase; letter-spacing:1.3px; font-weight:700; margin-bottom:4px;">
          Report Generated
        </div>
        <div style="font-size:13px; color:#3d3a52; font-weight:600;">${currentDate}</div>
      </div>
    `;
    wrap.appendChild(header);

    // ── CYCLE BANNER ──────────────────────────────────────────────────────────
    const cycleBanner = document.createElement("div");
    cycleBanner.style.cssText = `
      padding: 16px 48px;
      background: linear-gradient(90deg, #faf9ff 0%, #f7f5fe 100%);
      border-bottom: 1px solid #ede9e4;
      display: flex;
      align-items: center;
      gap: 14px;
    `;
    cycleBanner.innerHTML = `
      <div style="
        width: 4px; height: 36px;
        background: linear-gradient(180deg, #6c5ce7, #a78bfa);
        border-radius: 3px;
        flex-shrink: 0;
      "></div>
      <div>
        <div style="font-size:16px; font-weight:700; color:#2d2b45; letter-spacing:-0.3px;">
          ${cycleName}
        </div>
        ${cycleDateRange ? `
        <div style="font-size:12px; color:#9e9ba8; margin-top:3px;">
          📅 ${cycleDateRange}
        </div>` : ""}
      </div>
    `;
    wrap.appendChild(cycleBanner);

    // ── STATS ROW ─────────────────────────────────────────────────────────────
    const statsRow = document.createElement("div");
    statsRow.style.cssText = `
      display: flex;
      background: #ffffff;
      border-bottom: 1px solid #ede9e4;
    `;

    const stats = [
      { emoji:"🍴", label:"Meal Rate",      value: mealRate,                     accent:"#4f8ef7", soft:"#eff5ff" },
      { emoji:"🍱", label:"Total Meals",     value: totalMeals,                   accent:"#6c5ce7", soft:"#f3f0ff" },
      { emoji:"🧾", label:"Total Cost",      value: totalCost,                    accent:"#f59e0b", soft:"#fffbeb" },
      { emoji:"💵", label:"Total Deposits",  value:`৳${totalDeposits.toFixed(2)}`, accent:"#10b981", soft:"#f0fdf8" },
      {
        emoji: isPositive ? "✅" : "⚠️",
        label:"Net Balance",
        value: balanceDisplay,
        accent: isPositive ? "#10b981" : "#ef4444",
        soft:   isPositive ? "#f0fdf8" : "#fff5f5",
        bold: true,
      },
    ];

    stats.forEach((s, i) => {
      const card = document.createElement("div");
      card.style.cssText = `
        flex: 1;
        padding: 20px 14px 18px;
        text-align: center;
        background: ${s.bold ? s.soft : "#ffffff"};
        ${i < stats.length - 1 ? "border-right: 1px solid #ede9e4;" : ""}
        position: relative;
      `;
      card.innerHTML = `
        <div style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 38px; height: 38px;
          background: ${s.soft};
          border-radius: 10px;
          font-size: 18px;
          margin-bottom: 10px;
        ">${s.emoji}</div>
        <div style="
          font-size: 10px;
          color: #b0acba;
          text-transform: uppercase;
          letter-spacing: 1.1px;
          font-weight: 700;
          margin-bottom: 5px;
        ">${s.label}</div>
        <div style="
          font-size: 19px;
          font-weight: 800;
          color: ${s.accent};
          letter-spacing: -0.5px;
        ">${s.value}</div>
        ${s.bold ? `
        <div style="
          position:absolute; bottom:0; left:50%; transform:translateX(-50%);
          width:36px; height:3px;
          background: ${s.accent};
          border-radius: 3px 3px 0 0;
        "></div>` : ""}
      `;
      statsRow.appendChild(card);
    });
    wrap.appendChild(statsRow);

    // ── TABLE SECTION ─────────────────────────────────────────────────────────
    const tableSection = document.createElement("div");
    tableSection.style.cssText = `
      padding: 28px 48px 36px;
      background: #f7f5f2;
    `;

    // Label row
    const labelRow = document.createElement("div");
    labelRow.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    `;
    labelRow.innerHTML = `
      <span style="
        font-size:11px; font-weight:800;
        color: #6c5ce7;
        text-transform: uppercase;
        letter-spacing: 1.8px;
      ">Member Breakdown</span>
      <div style="flex:1; height:1px; background:linear-gradient(90deg,#ddd8f0,transparent);"></div>
    `;
    tableSection.appendChild(labelRow);

    // Clone + restyle table
    const tableClone = tableWrapper.cloneNode(true);
    tableClone.style.cssText = `
      width: 100%;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #e8e4f0;
      box-shadow: 0 4px 24px rgba(108,92,231,0.07), 0 1px 4px rgba(0,0,0,0.05);
    `;

    const innerTable = tableClone.querySelector("table");
    if (innerTable) {
      innerTable.style.cssText = `
        width: 100%;
        border-collapse: collapse;
      `;
    }

    tableClone.querySelectorAll("th").forEach((th) => {
      th.style.cssText = `
        background: linear-gradient(135deg, #6c5ce7 0%, #8b78ea 100%);
        color: rgba(255,255,255,0.95);
        padding: 13px 15px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 1px;
        text-align: left;
        border: none;
        white-space: nowrap;
      `;
    });

    let rowIndex = 0;
    tableClone.querySelectorAll("tbody tr, tr:not(:first-child)").forEach((row) => {
      const isEven = rowIndex % 2 === 0;
      row.style.cssText = `background: ${isEven ? "#ffffff" : "#faf8ff"};`;
      row.querySelectorAll("td").forEach((td, ci) => {
        const raw   = td.textContent.trim();
        const isNeg = raw.includes("−") || raw.includes("-") || raw.startsWith("(");
        let color = "#4a4663";
        if (ci === 0) color = "#2d2b45";
        if (ci === 3) color = "#059669";
        if (ci === 4) color = "#b45309";
        if (ci === 5) color = isNeg ? "#dc2626" : "#059669";

        td.style.cssText = `
          padding: 11px 15px;
          font-size: 13px;
          color: ${color};
          border-bottom: 1px solid #f0edfb;
          border-right: 1px solid #f0edfb;
          font-weight: ${ci === 0 ? "600" : "500"};
          white-space: nowrap;
        `;
      });
      rowIndex++;
    });

    tableSection.appendChild(tableClone);
    wrap.appendChild(tableSection);

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const footer = document.createElement("div");
    footer.style.cssText = `
      padding: 14px 48px;
      background: #ffffff;
      border-top: 1px solid #ede9e4;
      display: flex;
      align-items: center;
      justify-content: space-between;
    `;
    footer.innerHTML = `
      <span style="font-size:11px; color:#c4bfd4; letter-spacing:0.2px;">
        Powered by <strong style="color:#9e99b8;">MealCal Pro</strong> — Meal Management System
      </span>
      <div style="display:flex; align-items:center; gap:5px;">
        <div style="width:7px; height:7px; border-radius:50%; background:#6c5ce7;"></div>
        <div style="width:7px; height:7px; border-radius:50%; background:#a78bfa; opacity:0.6;"></div>
        <div style="width:7px; height:7px; border-radius:50%; background:#c084fc; opacity:0.35;"></div>
      </div>
    `;
    wrap.appendChild(footer);

    // ── BOTTOM STRIPE ─────────────────────────────────────────────────────────
    const bottomStripe = document.createElement("div");
    bottomStripe.style.cssText = `
      height: 4px;
      background: linear-gradient(90deg, #4f8ef7 0%, #6c5ce7 40%, #a78bfa 75%, #c084fc 100%);
      opacity: 0.45;
    `;
    wrap.appendChild(bottomStripe);

    // ── Render ────────────────────────────────────────────────────────────────
    document.body.appendChild(wrap);

    const canvas = await html2canvas(wrap, {
      scale: 2.5,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#f7f5f2",
      logging: false,
    });

    document.body.removeChild(wrap);

    const link = document.createElement("a");
    link.download = fileName;
    link.href = canvas.toDataURL("image/jpeg", 0.97);
    link.click();

    showNotification("JPG exported successfully!", "success");
  } catch (err) {
    console.error("JPG Export Error:", err);
    showNotification("Failed to export JPG", "error");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ============================================
// PROFILE JPG EXPORT SYSTEM (PRO DASHBOARD DESIGN)
// ============================================
async function exportProfileToJPG() {
  const btn = document.getElementById("exportProfileJPGBtn");
  if (!btn) {
    showNotification("Export button not found", "error");
    return;
  }
  
  const originalText = btn.textContent;
  btn.textContent = "Generating...";
  btn.disabled = true;

  try {
    // Helper function to convert Bengali/English numbers to float
    const parseNumber = (val) => {
      if (!val) return 0;
      const str = String(val);
      // Bengali to English digit mapping
      const bnToEn = {'০':'0','১':'1','২':'2','৩':'3','৪':'4','৫':'5','৬':'6','৭':'7','৮':'8','৯':'9'};
      const englishStr = str.replace(/[০-৯]/g, d => bnToEn[d]);
      return parseFloat(englishStr.replace(/[৳,]/g, "")) || 0;
    };
    
    // 1. Get current user info from DOM
    const profileName = document.getElementById("profileName")?.textContent || "Member";
    const profileCycle = document.getElementById("profileCycleName")?.textContent || "Current Cycle";
    const profileTotalMealsEl = document.getElementById("profileTotalMeals");
    const profileTotalDepositEl = document.getElementById("profileTotalDeposit");
    const profileBalanceEl = document.getElementById("profileBalance");
    
    const profileTotalMeals = profileTotalMealsEl?.textContent || "0";
    const profileTotalDeposit = profileTotalDepositEl?.textContent || "৳0";
    const profileBalance = profileBalanceEl?.textContent || "৳0";
    
    // 2. Parse numbers from DOM - convert Bengali numbers to English first
    const totalMealsNum = parseNumber(profileTotalMeals);
    const balanceNum = parseNumber(profileBalance);
    const depositsNum = parseNumber(profileTotalDeposit);
    
    // Get meal rate - need to calculate from data or get from DOM
    let mealRateNum = 0;
    let mealRateStr = "৳0.00";
    
    // First try to get from summary page (most accurate)
    const summaryMealRateEl = document.getElementById("summaryMealRate");
    if (summaryMealRateEl?.textContent) {
      mealRateStr = summaryMealRateEl.textContent;
      mealRateNum = parseNumber(mealRateStr);
    }
    
    // If not found, try to calculate from Supabase with boundary meals
    if (mealRateNum === 0 && currentCycleId) {
      try {
        // Fetch boundary meals and calculate properly like profile page does
        const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
        const cycleStartDate = allCycles?.find(c => c.id == currentCycleId)?.start_date;
        
        const mealsRes = await supabase
          .from("meals")
          .select("*")
          .eq("cycle_id", currentCycleId);
        const expensesRes = await supabase
          .from("expenses")
          .select("amount")
          .eq("cycle_id", currentCycleId)
          .eq("status", "approved");
        
        const allMeals = mealsRes.data || [];
        const totalExp = expensesRes.data?.reduce((s, e) => s + parseFloat(e.amount || 0), 0) || 0;
        
        // Use adjustMealTotal like the profile page does
        const totalMeals = adjustMealTotal(allMeals, boundaryMeals, cycleStartDate) || 1;
        mealRateNum = totalExp / totalMeals;
        mealRateStr = `৳${mealRateNum.toFixed(2)}`;
      } catch (e) {
        console.warn("Could not calculate meal rate:", e);
      }
    }
    
    const totalMealCost = totalMealsNum * mealRateNum;
    
    // 3. Fetch deposits from Supabase
    let allDeposits = [];
    let totalAutoSettlement = 0;
    let totalReductions = 0;
    let totalDepositsActual = 0; // Only positive deposits excluding settlements and reductions
    
    if (typeof currentCycleId !== 'undefined' && typeof currentUser !== 'undefined' && currentUser?.member_id) {
      try {
        const depositsRes = await supabase
          .from("deposits")
          .select("*, members(name)")
          .eq("cycle_id", currentCycleId)
          .eq("member_id", currentUser.member_id)
          .order("created_at", { ascending: false });
        
        if (depositsRes.data) {
          allDeposits = depositsRes.data;
          
          // Calculate totals from fetched data
          allDeposits.forEach(d => {
            const amount = parseFloat(d.amount || 0);
            const label = d.label || "";
            
            if (label === "Auto-Settlement") {
              // Auto settlements can be positive or negative
              totalAutoSettlement += amount;
            } else if (amount < 0) {
              // Negative amounts that are not auto-settlement = reductions
              totalReductions += amount; // keep as negative
            } else if (amount > 0) {
              // Actual deposits (positive, not auto-settlement)
              totalDepositsActual += amount;
            }
          });
        }
      } catch (e) {
        console.warn("Could not fetch profile data:", e);
      }
    }
    
    // Use actual deposits if fetched, otherwise fallback to DOM value
    const totalDepositsNum = totalDepositsActual > 0 ? totalDepositsActual : depositsNum;
    
    // Separate deposits into categories for display
    const regularDeposits = allDeposits.filter(d => d.label !== "Auto-Settlement" && parseFloat(d.amount || 0) > 0);
    const autoSettlements = allDeposits.filter(d => d.label === "Auto-Settlement");
    const reductions = allDeposits.filter(d => d.label !== "Auto-Settlement" && parseFloat(d.amount || 0) < 0);
    
    // Build all transactions sorted by date
    let allTransactions = [];
    
    regularDeposits.forEach(d => {
      allTransactions.push({
        date: new Date(d.created_at),
        type: 'DEPOSIT',
        label: d.label || "Deposit",
        notes: d.notes || d.payment_method || '',
        amount: parseFloat(d.amount || 0)
      });
    });
    
    autoSettlements.forEach(d => {
      allTransactions.push({
        date: new Date(d.created_at),
        type: 'AUTO_SETTLE',
        label: "Auto-Settlement",
        notes: d.notes || '',
        amount: parseFloat(d.amount || 0)
      });
    });
    
    reductions.forEach(d => {
      allTransactions.push({
        date: new Date(d.created_at),
        type: 'REDUCTION',
        label: d.label || "Reduction",
        notes: d.notes || '',
        amount: parseFloat(d.amount || 0)
      });
    });
    
    // Sort by date descending (newest first)
    allTransactions.sort((a, b) => b.date - a.date);

    const finalBalance = totalDepositsNum + totalAutoSettlement + totalReductions - totalMealCost;
    const genDateStr = new Date().toLocaleDateString("en-BD", { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    // 5. Generate Compact Transaction Rows HTML
    let transactionRowsHTML = '';
    if (allTransactions.length === 0) {
      transactionRowsHTML = `<div style="padding: 30px; text-align: center; color: #94a3b8; font-size: 13px;">No transactions recorded yet.</div>`;
    } else {
      allTransactions.forEach((t, i) => {
        const dateStr = t.date.toLocaleDateString("en-BD", { day: '2-digit', month: 'short' });
        const isDeposit = t.type === 'DEPOSIT';
        const isAutoSettle = t.type === 'AUTO_SETTLE';
        const isReduction = t.type === 'REDUCTION';
        
        let badgeBg, badgeColor, badgeText;
        let amtColor;
        let descText;
        
        if (isDeposit) {
          badgeBg = '#d1fae5';
          badgeColor = '#065f46';
          badgeText = 'DEPOSIT';
          amtColor = '#10b981';
          descText = t.notes || 'Deposit';
        } else if (isAutoSettle) {
          badgeBg = '#e0e7ff';
          badgeColor = '#4338ca';
          badgeText = 'AUTO-SETTLE';
          amtColor = t.amount >= 0 ? '#10b981' : '#ef4444';
          descText = t.notes || 'Auto Settlement';
        } else if (isReduction) {
          badgeBg = '#fee2e2';
          badgeColor = '#b91c1c';
          badgeText = 'REDUCTION';
          amtColor = '#ef4444';
          descText = t.notes || t.label || 'Reduction';
        } else {
          badgeBg = '#fef3c7';
          badgeColor = '#92400e';
          badgeText = t.type;
          amtColor = '#f59e0b';
          descText = t.desc || '';
        }
        
        const prefix = t.amount >= 0 ? '+' : '';
        const bgClass = i % 2 === 0 ? '#ffffff' : '#f8fafc';

        transactionRowsHTML += `
        <div style="display: grid; grid-template-columns: 75px 1fr 85px; padding: 10px 16px; background: ${bgClass}; font-size: 12px; color: #334155; align-items: center;">
          <div style="font-weight: 500; color: #64748b;">${dateStr}</div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="background: ${badgeBg}; color: ${badgeColor}; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">${badgeText}</span>
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;" title="${descText}">${descText}</span>
          </div>
          <div style="text-align: right; font-weight: 700; color: ${amtColor}; font-size: 13px;">
            ${prefix}৳${Math.abs(t.amount).toFixed(2)}
          </div>
        </div>`;
      });
    }

    // 6. Build Master Container (Dashboard Layout)
    const wrap = document.createElement("div");
    wrap.style.cssText = `
      position: fixed;
      left: -10000px;
      top: 0;
      width: 900px;
      background: #f1f5f9;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      color: #0f172a;
    `;
    
    wrap.innerHTML = `
      <!-- Premium Header -->
      <div style="background: linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%); padding: 32px 40px; color: white; display: flex; justify-content: space-between; align-items: center; border-bottom: 4px solid #818cf8;">
        <div style="display: flex; gap: 16px; align-items: center;">
          <div style="width: 54px; height: 54px; background: rgba(255,255,255,0.1); backdrop-filter: blur(8px); border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 26px; border: 1px solid rgba(255,255,255,0.2);">🍽️</div>
          <div>
            <div style="font-size: 13px; color: #a5b4fc; font-weight: 600; letter-spacing: 1px; text-transform: uppercase;">MealCal Pro &bull; ${profileCycle}</div>
            <div style="font-size: 28px; font-weight: 800; margin-top: 2px; letter-spacing: -0.5px;">${profileName}</div>
          </div>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 12px; color: #a5b4fc; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">Current Balance</div>
          <div style="font-size: 34px; font-weight: 800; color: ${balanceNum >= 0 ? '#34d399' : '#f87171'}; line-height: 1.1;">${profileBalance}</div>
          <div style="font-size: 11px; color: rgba(255,255,255,0.6); margin-top: 6px;">Generated: ${genDateStr}</div>
        </div>
      </div>

      <!-- Dashboard Grid Layout (Side-by-Side) -->
      <div style="display: grid; grid-template-columns: 280px 1fr; gap: 24px; padding: 32px 40px; align-items: start;">
        
        <!-- LEFT COLUMN: Stats & Summary -->
        <div style="display: flex; flex-direction: column; gap: 24px;">
          
          <!-- 2x2 Stats Grid -->
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div style="background: white; padding: 16px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
              <div style="font-size: 20px; margin-bottom: 6px;">🍽️</div>
              <div style="font-size: 10px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Total Meals</div>
              <div style="font-size: 18px; font-weight: 800; color: #6366f1; margin-top: 2px;">${profileTotalMeals}</div>
            </div>
            <div style="background: white; padding: 16px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
              <div style="font-size: 20px; margin-bottom: 6px;">💰</div>
              <div style="font-size: 10px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Total Paid</div>
              <div style="font-size: 18px; font-weight: 800; color: #10b981; margin-top: 2px;">${profileTotalDeposit}</div>
            </div>
            <div style="background: white; padding: 16px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
              <div style="font-size: 20px; margin-bottom: 6px;">🧾</div>
              <div style="font-size: 10px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Meal Cost</div>
              <div style="font-size: 18px; font-weight: 800; color: #f59e0b; margin-top: 2px;">৳${totalMealCost.toFixed(2)}</div>
            </div>
            <div style="background: white; padding: 16px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
              <div style="font-size: 20px; margin-bottom: 6px;">📊</div>
              <div style="font-size: 10px; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">Meal Rate</div>
              <div style="font-size: 18px; font-weight: 800; color: #3b82f6; margin-top: 2px;">${mealRateStr}</div>
            </div>
          </div>

          <!-- Financial Summary Card -->
          <div style="background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; overflow: hidden;">
            <div style="background: #f8fafc; padding: 14px 20px; font-weight: 800; font-size: 12px; color: #334155; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #e2e8f0;">
              Financial Summary
            </div>
            <div style="padding: 20px; font-size: 13px; color: #475569;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span>Total Deposited</span>
                <span style="font-weight: 600; color: #10b981;">৳${totalDepositsNum.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span>Auto Settlements</span>
                <span style="font-weight: 600; color: ${totalAutoSettlement >= 0 ? '#10b981' : '#ef4444'};">${totalAutoSettlement >= 0 ? '+' : ''}৳${totalAutoSettlement.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span>Total Reductions</span>
                <span style="font-weight: 600; color: #ef4444;">৳${totalReductions.toFixed(2)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
                <span>Total Meal Cost</span>
                <span style="font-weight: 600; color: #ef4444;">-৳${totalMealCost.toFixed(2)}</span>
              </div>
              <div style="height: 1px; background: #e2e8f0; margin-bottom: 16px;"></div>
              <div style="display: flex; justify-content: space-between; font-size: 16px; font-weight: 800; color: #0f172a;">
                <span>Final Balance</span>
                <span>৳${finalBalance.toFixed(2)}</span>
              </div>
            </div>
          </div>

        </div>

        <!-- RIGHT COLUMN: Compact Transaction History -->
        <div style="background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); border: 1px solid #e2e8f0; overflow: hidden; display: flex; flex-direction: column;">
          <div style="background: #f8fafc; padding: 14px 20px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
             <span style="font-weight: 800; font-size: 12px; color: #334155; text-transform: uppercase; letter-spacing: 1px;">Transaction History</span>
             <span style="background: #e2e8f0; color: #475569; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px;">${allTransactions.length} Records</span>
          </div>
          
          <!-- Table Header -->
          <div style="display: grid; grid-template-columns: 75px 1fr 85px; padding: 10px 16px; background: #fdfdfd; border-bottom: 1px solid #f1f5f9; font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px;">
            <div>Date</div>
            <div>Description</div>
            <div style="text-align: right;">Amount</div>
          </div>
          
          <!-- Table Body -->
          <div style="display: flex; flex-direction: column;">
            ${transactionRowsHTML}
          </div>
        </div>

      </div>
      
      <!-- Minimalist Footer -->
      <div style="text-align: center; padding: 0 40px 24px; color: #94a3b8; font-size: 11px; font-weight: 500;">
        Powered by MealCal Pro System &bull; Confidential
      </div>
    `;
    
    // 7. Render and Export
    document.body.appendChild(wrap);
    
    const canvas = await html2canvas(wrap, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#f1f5f9',
      logging: false,
    });
    
    document.body.removeChild(wrap);
    
    const fileName = `MealCal_${profileName.replace(/[^a-zA-Z0-9]/g, "_")}_Statement_${new Date().toISOString().split("T")[0]}.jpg`;
    const link = document.createElement("a");
    link.download = fileName;
    link.href = canvas.toDataURL("image/jpeg", 0.95);
    link.click();
    
    if(typeof showNotification === 'function') {
        showNotification("Professional statement exported successfully!", "success");
    }
  } catch (err) {
    console.error("Profile Export Error:", err);
    if(typeof showNotification === 'function') {
        showNotification("Failed to export profile report", "error");
    }
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ============================================
// FULL CYCLE EXPORT SYSTEM
// ============================================

document
  .getElementById("exportFullCycleBtn")
  .addEventListener("click", async () => {
    if (!currentCycleId) return;

    const btn = document.getElementById("exportFullCycleBtn");
    const originalText = btn.textContent;
    btn.textContent = "Generating...";
    btn.disabled = true;

    try {
      // 1. Fetch ALL Data for the Cycle in Parallel
      const [cycleRes, membersRes, mealsRes, depositsRes, expensesRes] =
        await Promise.all([
          supabase
            .from("cycles")
            .select("name, start_date, end_date")
            .eq("id", currentCycleId)
            .single(),
          supabase.from("members").select("id, name").order("name"),
          supabase.from("meals").select("*").eq("cycle_id", currentCycleId),
          supabase
            .from("deposits")
            .select("*, members(name)")
            .eq("cycle_id", currentCycleId)
            .neq("status", "pending")
            .order("created_at"),
          supabase
            .from("expenses")
            .select("*, members(name)")
            .eq("cycle_id", currentCycleId)
            .eq("status", "approved")
            .order("expense_date"),
        ]);

      const cycle = cycleRes.data;
      const members = membersRes.data;
      const meals = mealsRes.data;
      const deposits = depositsRes.data;
      const expenses = expensesRes.data;

      // 2. Perform Calculations
      const totalExpense = expenses.reduce(
        (sum, e) => sum + parseFloat(e.amount),
        0,
      );
      
      const boundaryMeals = await fetchBoundaryDayMeals(currentCycleId);
      const totalMeals = adjustMealTotal(meals || [], boundaryMeals, cycle.start_date);

      const totalDeposits = deposits.reduce(
        (sum, d) => sum + parseFloat(d.amount),
        0,
      );

      // Avoid division by zero
      const mealRate = totalMeals > 0 ? totalExpense / totalMeals : 0;
      const currentBalance = totalDeposits - totalExpense; // Cash in Hand

      // 3. Construct Data Arrays (Rows for the Excel file)
      let dataRows = [];

      // --- SECTION A: METADATA ---
      dataRows.push(["MEALCAL PRO - FULL CYCLE REPORT"]);
      dataRows.push(["Export Date", new Date().toLocaleString()]);
      dataRows.push(["Cycle Name", cycle.name]);
      dataRows.push(["Duration", `${cycle.start_date} to ${cycle.end_date}`]);
      dataRows.push([]); // Spacer

      // --- SECTION B: OVERALL STATISTICS ---
      dataRows.push(["--- OVERALL STATISTICS ---"]);
      dataRows.push([
        "Total Meals",
        "Total Expenses",
        "Total Deposits",
        "Meal Rate",
        "Cash Balance",
      ]);
      dataRows.push([
        totalMeals.toFixed(2),
        totalExpense.toFixed(2),
        totalDeposits.toFixed(2),
        mealRate.toFixed(4),
        currentBalance.toFixed(2),
      ]);
      dataRows.push([]); // Spacer

      // --- SECTION C: MEMBER SUMMARY TABLE ---
      dataRows.push(["--- MEMBER SUMMARY ---"]);
      dataRows.push([
        "Member Name",
        "Total Meals",
        "Total Deposit",
        "Actual Cost",
        "Balance (+Refund/-Due)",
      ]);

      members.forEach((m) => {
        const mMeals = adjustMealTotal(meals || [], boundaryMeals, cycle.start_date, m.id);

        const mDep = deposits
          .filter((x) => x.member_id === m.id)
          .reduce((s, x) => s + parseFloat(x.amount), 0);

        const mCost = mMeals * mealRate;
        const mBal = mDep - mCost;

        dataRows.push([
          m.name,
          mMeals.toFixed(1),
          mDep.toFixed(2),
          mCost.toFixed(2),
          mBal.toFixed(2),
        ]);
      });
      dataRows.push([]); // Spacer

      // --- SECTION D: EXPENSE LOG (BAZAR LIST) ---
      dataRows.push(["--- EXPENSE / BAZAR LOG ---"]);
      dataRows.push(["Date", "Shopper", "Description", "Amount"]);

      expenses.forEach((e) => {
        dataRows.push([
          e.expense_date,
          e.members?.name || "Unknown",
          e.description,
          parseFloat(e.amount).toFixed(2),
        ]);
      });
      dataRows.push([]); // Spacer

      // --- SECTION E: DEPOSIT LOG (WALLET HISTORY) ---
      dataRows.push(["--- DEPOSIT & TRANSACTION LOG ---"]);
      dataRows.push(["Date", "Member", "Label/Type", "Notes", "Amount"]);

      deposits.forEach((d) => {
        const dateStr = new Date(d.created_at).toLocaleDateString("en-GB");
        dataRows.push([
          dateStr,
          d.members?.name || "Unknown",
          d.label,
          d.notes || "-",
          parseFloat(d.amount).toFixed(2),
        ]);
      });

      // 4. Generate File
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(dataRows);

      // Optional: Auto-width columns (Cosmetic)
      ws["!cols"] = [
        { wch: 20 },
        { wch: 20 },
        { wch: 25 },
        { wch: 15 },
        { wch: 15 },
      ];

      XLSX.utils.book_append_sheet(wb, ws, "Full Report");

      // Filename: MealCal_Report_CycleName_Date.csv
      const safeName = cycle.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const fileName = `MealCal_FullReport_${safeName}.csv`;

      XLSX.writeFile(wb, fileName);

      showNotification("Full Cycle Data Exported!", "success");
    } catch (err) {
      console.error("Export Error:", err);
      showNotification("Failed to export data", "error");
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

// ============================================
// EXPENSES PAGE
// ============================================

window.handleDepositAction = async function (depositId, action) {
  console.log(`Action: ${action} triggered for ID: ${depositId}`);
  const btn = event.target;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "...";

  try {
    const { data: dep, error: fError } = await supabase
      .from("deposits")
      .select("*, members(name)")
      .eq("id", depositId)
      .single();

    if (fError || !dep) throw new Error("Could not find the pending request.");

    const actor = currentUser.members ? currentUser.members.name : "Admin";

    if (action === "approve") {
      const { error: delError } = await supabase
        .from("deposits")
        .delete()
        .eq("id", depositId);
      if (delError) throw delError;

      await processDepositWithClientSideSettlement(
        dep.member_id,
        dep.cycle_id,
        dep.amount,
        dep.label || "Deposit",
        dep.notes,
      );

      // LOG THE APPROVAL ACT
      await logActivity(
        `Deposit Approved: ${dep.members.name}'s request for ${formatCurrency(dep.amount)} was approved by ${actor}`,
        "deposit",
      );
      showNotification("Request Approved", "success");
    } else if (action === "reject") {
      const { error: delError } = await supabase
        .from("deposits")
        .delete()
        .eq("id", depositId);
      if (delError) throw delError;

      // LOG THE REJECTION ACT
      await logActivity(
        `Deposit Rejected: ${dep.members.name}'s request for ${formatCurrency(dep.amount)} was rejected by ${actor}`,
        "deposit",
      );
      showNotification("Request Rejected", "warning");
    }

    await loadDeposits();
    if (typeof loadDashboard === "function") loadDashboard();
  } catch (err) {
    console.error("CRITICAL ERROR:", err.message);
    showNotification(err.message, "error");
    btn.disabled = false;
    btn.textContent = originalText;
  }
};

document.getElementById("expenseForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  // Pass the ID of the submit button, and the async logic
  await runSafeAction(
    "expenseSubmitBtn",
    async () => {
      // 1. GATHER DATA
      const expenseId = document.getElementById("editExpenseId").value;
      const date = document.getElementById("expenseDate").value;
      const mid = document.getElementById("expenseMember").value;
      const desc = document.getElementById("expenseDescription").value;
      const amt = parseFloat(document.getElementById("expenseAmount").value);

      // Validations
      if (!currentCycleId) throw new Error("System Error: No active cycle.");
      if (!mid) throw new Error("Please select a shopper.");
      if (isNaN(amt) || amt <= 0)
        throw new Error("Please enter a valid amount.");

      const isEditMode = !!expenseId;
      const actorName = currentUser.name || "User";
      const shopperSelect = document.getElementById("expenseMember");
      const shopperName =
        shopperSelect.options[shopperSelect.selectedIndex].text;

      // 2. DATABASE OPERATION
      if (isEditMode) {
        const { error } = await supabase
          .from("expenses")
          .update({
            expense_date: date,
            member_id: mid,
            description: desc,
            amount: amt,
            is_edited: true,
          })
          .eq("id", expenseId);
        if (error) throw error;

        // Log silently
        logActivity(
          `Expense Edited: ৳${amt} (${desc}) by ${actorName}`,
          "expense",
        );
        showNotification("Expense updated!", "success");
      } else {
        // All expenses go to pending for approval
        const { error } = await supabase
          .from("expenses")
          .insert({
            cycle_id: parseInt(currentCycleId),
            expense_date: date,
            member_id: mid,
            description: desc,
            amount: amt,
            status: "pending",
          });
        if (error) throw error;

        logActivity(
          `New Expense: ৳${amt} (${desc}) by ${shopperName}`,
          "expense",
        );
        showNotification(
          "Request sent for approval",
          "success",
        );
      }

      // 3. CLEANUP
      resetExpenseForm();

      // Refresh Data (Background)
      loadExpenses();
      loadDashboard();
    },
    "Saving...",
  ); // Custom loading text
});

// Helper to log without breaking the main flow
async function logExpenseActivity(message) {
  try {
    // Ensure member_id is valid, or pass null
    const loggerId = currentUser?.member_id
      ? parseInt(currentUser.member_id)
      : null;

    await supabase.from("notifications").insert({
      cycle_id: parseInt(currentCycleId),
      type: "expense",
      message: message,
      member_id: loggerId,
    });
  } catch (e) {
    console.warn("Logging failed silently:", e);
  }
}

// ============================================
// DEPOSITS PAGE
// ============================================
async function loadDeposits() {
  const filterId = document.getElementById("depositLogFilter").value;
  if (!currentCycleId) return;

  try {
    const { data, error } = await supabase
      .from("deposits")
      .select("*, members(name)")
      .eq("cycle_id", currentCycleId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const pendingCard = document.getElementById("pendingDepositsCard");
    const pendingList = document.getElementById("pendingDepositList");
    const historyContainer = document.getElementById("depositList");

    // STRICT FILTERING
    // Pending: only those explicitly marked 'pending'
    const pendingItems = data.filter((d) => d.status === "pending");

    // History: only those marked 'approved' OR legacy records (null status)
    const historyItems = data.filter(
      (d) => d.status === "approved" || !d.status,
    );

    // Render Pending
    if (pendingItems.length > 0) {
      pendingCard.style.display = "block";
      const isAdmin =
        currentUser.role === "admin" || currentUser.role === "manager";
      pendingList.innerHTML = pendingItems
        .map(
          (t) => `
                <div class="list-item" style="background: rgba(245, 158, 11, 0.05); padding: 12px; margin-bottom: 8px; border-radius: 8px; border: 1px solid #fed7aa;">
                    <div class="log-main">
                        <div class="log-details">
                            <div class="log-member">${t.members?.name} <span class="due-status-badge due-status-pending">PENDING REQUEST</span></div>
                            <div class="log-meta" style="font-weight:700;">${formatCurrency(t.amount)} • ${t.label || "Deposit"}</div>
                        </div>
                    </div>
                    ${
                      isAdmin
                        ? `
                    <div style="display:flex; gap:8px;">
                        <button class="btn btn-success btn-sm" onclick="handleDepositAction(${t.id}, 'approve')">Approve</button>
                        <button class="btn btn-danger btn-sm" onclick="handleDepositAction(${t.id}, 'reject')">✕</button>
                    </div>`
                        : ""
                    }
                </div>
            `,
        )
        .join("");
    } else {
      pendingCard.style.display = "none";
    }

    // Render History
    let filteredHistory = historyItems;
    if (filterId)
      filteredHistory = historyItems.filter((h) => h.member_id == filterId);

    if (filteredHistory.length === 0) {
      historyContainer.innerHTML =
        '<div class="loading">No transaction history found.</div>';
      return;
    }

    historyContainer.innerHTML = filteredHistory
      .map((t) => {
        const isSettlement =
          t.label === "Auto-Settlement" || t.label === "Reduction";
        const isNegative = t.amount < 0;

        // Icon & Style Logic
        let icon = "💰";
        let iconClass = "deposit";
        let tagClass = "tag-deposit";
        let typeLabel = "Deposit";

        if (t.label === "Auto-Settlement") {
          icon = "🔄";
          iconClass = "settlement";
          tagClass = "tag-settle";
          typeLabel = "Settlement";
        } else if (isNegative) {
          icon = "🔻";
          iconClass = "charge";
          tagClass = "tag-settle";
          typeLabel = "Charge";
        }

        const dateStr = formatDateTime(t.created_at);

        return `
           <div class="log-item">
    <div class="log-content">
        <!-- Left side -->
        <div class="log-main">
            <div class="log-icon ${iconClass}">${icon}</div>

            <div class="log-details">
                <div class="log-member">
                    ${t.members?.name || "Unknown"}
                    <span class="log-type-tag ${tagClass}">
                        ${typeLabel}
                    </span>
                </div>

                <div class="log-meta">
                    ${dateStr} ${t.notes ? `• ${t.notes}` : ""}
                </div>

                ${
                  isSettlement && t.notes
                    ? `<div class="transfer-info">📌 ${t.notes}</div>`
                    : ""
                }
                ${
                  (currentUser?.role === "admin" || currentUser?.role === "manager") && t.status === "approved" && !isSettlement
                    ? `<div style="margin-top: 8px;">
                          <button class="btn btn-sm" style="background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.2); padding: 4px 8px; font-size: 12px; border-radius: 4px;" onclick="revertApprovedDeposit(${t.id})">
                             ↩ Revert Transaction
                          </button>
                       </div>`
                    : ""
                }
            </div>
        </div>

        <!-- Right side (balance) -->
        <div class="log-amount
            ${isNegative ? "balance-negative" : "balance-positive"}">
            ${isNegative ? "-" : "+"}${formatCurrency(Math.abs(t.amount))}
        </div>
    </div>
</div>

            `;
      })
      .join("");
  } catch (err) {
    console.error("Error loading deposits:", err);
    historyContainer.innerHTML =
      '<div class="loading" style="color:red;">Error loading transactions.</div>';
  }
}

async function loadExpenses() {
  const historyContainer = document.getElementById("expenseList");
  const pendingContainer = document.getElementById("pendingExpensesList");
  const pendingCard = document.getElementById("pendingExpensesCard");

  if (!currentCycleId) return;

  try {
    // Fetch ALL expenses for this cycle
    const { data: expenses, error } = await supabase
      .from("expenses")
      .select("*, members(name)")
      .eq("cycle_id", currentCycleId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Reset Containers
    historyContainer.innerHTML = "";
    pendingContainer.innerHTML = "";
    pendingCard.style.display = "none";

    if (!expenses || expenses.length === 0) {
      historyContainer.innerHTML =
        '<div style="text-align:center; padding:20px; color:#cbd5e1;">No expenses yet.</div>';
      return;
    }

    const isAdmin =
      currentUser.role === "admin" || currentUser.role === "manager";

    // --- FILTERING ---
    const pendingItems = expenses.filter((e) => e.status === "pending");
    // History shows Approved items OR items marked 'rejected' (optional)
    const historyItems = expenses.filter((e) => e.status === "approved");

    // 1. RENDER PENDING LIST (Mobile Optimized)
    if (pendingItems.length > 0) {
      pendingCard.style.display = "block";

      pendingContainer.innerHTML = pendingItems
        .map((exp) => {
          const dateStr = new Date(exp.expense_date).toLocaleDateString(
            "en-GB",
            { day: "numeric", month: "short" },
          );
          const shopperName = exp.members?.name || "Unknown";
          // Truncate description for mobile if too long
          const shortDesc =
            (exp.description || "No details").substring(0, 25) +
            (exp.description?.length > 25 ? "..." : "");

          // Admin Buttons vs User Label
          const footerContent = isAdmin
            ? `
            <div class="pending-actions">
                <button class="btn-mobile-action btn-approve" onclick="handleExpenseApproval('${exp.id}', 'approved')">
                    ✓ Approve
                </button>
                <button class="btn-mobile-action btn-reject" onclick="handleExpenseApproval('${exp.id}', 'rejected')">
                    ✕ Reject
                </button>
            </div>
        `
            : `<div class="pending-status-label">WAITING FOR ADMIN APPROVAL</div>`;

          return `
        <div class="pending-card-inner">
            <!-- Top Row -->
            <div class="pending-main-row">
                <div class="pending-left-group">
                    <div class="pending-icon-circle">🛒</div>
                    <div>
                        <div class="pending-shopper-name">${shopperName}</div>
                        <div class="pending-desc">${shortDesc}</div>
                    </div>
                </div>
                <div class="pending-right-group">
                    <div class="pending-amt">৳${toBn(exp.amount)}</div>
                    <div class="pending-date">${dateStr}</div>
                </div>
            </div>
            
            <!-- Bottom Row (Buttons or Status) -->
            ${footerContent}
        </div>`;
        })
        .join("");
    }
    // 2. RENDER HISTORY LIST (Approved Only)
    if (historyItems.length === 0) {
      historyContainer.innerHTML =
        '<div style="text-align:center; padding:10px; color:#cbd5e1; font-size:11px;">No approved expenses yet.</div>';
    } else {
      historyItems.forEach((exp) => {
        const dateObj = new Date(exp.expense_date);
        const dateStr = dateObj.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
        });
        const itemsText = exp.description ? exp.description : "General Expense";
        const shopperName = exp.members?.name || "Unknown";
        const editedTag = exp.is_edited
          ? `<span class="edited-badge">EDITED</span>`
          : "";

        let actionBtn = "";
        if (isAdmin) {
          actionBtn = `
                    <button class="btn-icon-edit" 
                        onclick="populateExpenseForm('${exp.id}', '${exp.expense_date}', '${exp.member_id}', '${exp.amount}', this.dataset.desc)"
                        data-desc="${(exp.description || "").replace(/"/g, "&quot;")}"
                    >✎</button>`;
        }

        const html = `
                <div class="expense-card-modern">
                    <div class="exp-info-left">
                        <div class="exp-icon-box">🛒</div>
                        <div class="exp-details">
                            <div class="title">${shopperName} • ${dateStr} ${editedTag}</div>
                            <div class="meta">${itemsText}</div>
                        </div>
                    </div>
                    <div class="exp-info-left" style="gap:0;">
                        <div class="exp-amount-right">
                            <div class="val">৳${toBn(exp.amount)}</div> 
                        </div>
                        ${actionBtn}
                    </div>
                </div>`;

        historyContainer.insertAdjacentHTML("beforeend", html);
      });
    }
  } catch (err) {
    console.error("Load Exp Error:", err);
    historyContainer.innerHTML =
      '<div style="color:red; text-align:center;">Failed to load.</div>';
  }
}

// Function to fill the form with existing data
function populateExpenseForm(id, date, memberId, amount, desc) {
  // --- MOBILE DETECTION: Use bottom sheet on small screens ---
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
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

// document.getElementById('expenseForm').addEventListener('submit', async (e) => {
//     e.preventDefault();

//     // Get form values
//     const expenseId = document.getElementById('editExpenseId').value;
//     const date = document.getElementById('expenseDate').value;
//     const mid = document.getElementById('expenseMember').value;
//     const desc = document.getElementById('expenseDescription').value;
//     const amt = parseFloat(document.getElementById('expenseAmount').value);

//     if (!currentCycleId) { alert("No active cycle"); return; }

//     const submitBtn = document.getElementById('expenseSubmitBtn');
//     const originalText = submitBtn.textContent;
//     submitBtn.textContent = "Processing...";
//     submitBtn.disabled = true;

//     // Get Shopper Name (The person who bought it)
//     const shopperSelect = document.getElementById('expenseMember');
//     const shopperName = shopperSelect.options[shopperSelect.selectedIndex].text;

//     // Get Actor Name (The person currently logged in editing)
//     const actorName = currentUser.members ? currentUser.members.name : currentUser.name;

//     try {
//         if (expenseId) {
//             // ===========================
//             // 1. EDIT MODE
//             // ===========================

//             // A. Fetch OLD data first
//             const { data: oldData, error: fetchError } = await supabase
//                 .from('expenses')
//                 .select('amount, description')
//                 .eq('id', expenseId)
//                 .single();

//             if (fetchError) throw fetchError;

//             // B. Update Database
//             const { error: updateError } = await supabase
//                 .from('expenses')
//                 .update({
//                     expense_date: date,
//                     member_id: mid,
//                     description: desc,
//                     amount: amt,
//                     is_edited: true
//                 })
//                 .eq('id', expenseId);

//             if (updateError) throw updateError;

//             // C. Log Notification (Fixed Bengali Numbers & Linked Actor)
//             // Use toBn() for converting numbers to Bengali
//             const oldAmtBn = toBn(oldData.amount);
//             const newAmtBn = toBn(amt);

//             const msg = `Expense Edited: from ৳${oldAmtBn} to ৳${newAmtBn} for "${desc}" (Shopper: ${shopperName}) - by ${actorName}`;

//             await supabase.from('notifications').insert({
//                 cycle_id: currentCycleId,
//                 type: 'expense',
//                 message: msg,
//                 member_id: currentUser.member_id // <--- THIS FIXES "By: System" to "By: Admin"
//             });

//             showNotification('Expense updated successfully!', 'success');

//         } else {
//             // ===========================
//             // 2. INSERT MODE
//             // ===========================

//             const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');
//             const status = isAdmin ? 'approved' : 'pending';

//             const { error: insertError } = await supabase
//                 .from('expenses')
//                 .insert({
//                     cycle_id: currentCycleId,
//                     expense_date: date,
//                     member_id: mid,
//                     description: desc,
//                     amount: amt,
//                     status: status
//                 });

//             if (insertError) throw insertError;

//             // Log New Entry
//             const amtBn = toBn(amt);
//             const msg = `New Expense: ৳${amtBn} for "${desc}" by ${shopperName}`;

//             await supabase.from('notifications').insert({
//                 cycle_id: currentCycleId,
//                 type: 'expense',
//                 message: msg,
//                 member_id: currentUser.member_id // Link actor here too
//             });

//             showNotification(isAdmin ? 'Expense added successfully!' : 'Request sent to admin', 'success');
//         }

//         resetExpenseForm();
//         await loadExpenses();
//         await loadDashboard();

//     } catch (err) {
//         console.error(err);
//         showNotification(err.message, 'error');
//     } finally {
//         submitBtn.textContent = originalText;
//         submitBtn.disabled = false;
//     }
// });

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
                <div class="name">${t.members?.name || "User"}</div>
                <div class="meta">${dateStr} ${t.notes ? `• ${t.notes}` : ""}</div>
            </div>
        </div>
        <div class="hist-amount">
            <div class="val" style="color: ${isNegative ? "#e11d48" : "#059669"}">
                ${isNegative ? "" : "+"}${toBn(Math.round(t.amount))}
            </div>
            <div class="label" style="color: var(--text-muted)">${t.label || "Entry"}</div>
        </div>
    </div>`;
}

// Global lock for deposits
let isProcessingDepositSettlement = false;

// Add this NEW function BEFORE the depositForm handler
async function processDepositWithClientSideSettlement(
  memberId,
  cycleId,
  amount,
  label,
  notes,
) {
  if (isProcessingDepositSettlement) throw new Error("A settlement is already processing. Please wait.");
  isProcessingDepositSettlement = true;
  try {
    const targetCycleId = parseInt(cycleId);

    // 1. Insert the official REAL cash deposit (Approved)
    const { data: mainDeposit, error: depError } = await supabase
      .from("deposits")
      .insert({
        cycle_id: targetCycleId,
        member_id: memberId,
        amount: amount,
        label: label,
        notes: notes,
        status: "approved",
      })
      .select()
      .single();

    if (depError) throw depError;

    const memberObj = allMembers.find((m) => m.id == memberId);

    // GLOBAL LOG
    await logActivity(
      `Cash Deposit: ${formatCurrency(amount)} added for ${memberObj?.name}`,
      "deposit",
    );

    if (amount <= 0) return { settled: false, deposit_id: mainDeposit.id };

    // 2. Find Debtor Due
    const { data: debtorDue } = await supabase
      .from("cycle_dues")
      .select("*")
      .eq("member_id", memberId)
      .eq("to_cycle_id", targetCycleId)
      .in("status", ["pending", "settling"])
      .lt("due_amount", 0)
      .maybeSingle();

    if (!debtorDue) return { settled: false, deposit_id: mainDeposit.id };

    // 3. Find Creditors
    const { data: creditors } = await supabase
      .from("cycle_dues")
      .select("*, members(name)")
      .eq("to_cycle_id", targetCycleId)
      .in("status", ["pending", "settling"])
      .gt("due_amount", 0)
      .order("created_at", { ascending: true });

    if (!creditors || creditors.length === 0)
      return { settled: false, deposit_id: mainDeposit.id };

    // INITIALIZE POOL (Fixed placement)
    let poolAvailable = Math.min(
      amount,
      Math.abs(debtorDue.due_amount) - Math.abs(debtorDue.settled_amount),
    );
    let totalActuallySettled = 0;

    for (const creditor of creditors) {
      if (poolAvailable <= 0) break;

      const creditorOwed = creditor.due_amount - creditor.settled_amount;
      if (creditorOwed <= 0) continue;

      // CALCULATE SETTLEMENT (With Rounding Logic)
      const settleAmountRaw = Math.min(poolAvailable, creditorOwed);
      const settleAmount = Math.round(settleAmountRaw * 100) / 100; // Limits to 2 decimals

      if (settleAmount <= 0) continue;

      // 4. Create Transfer Logs (Auto-Settlements) WITH parent_deposit_id
      await supabase.from("deposits").insert([
        {
          cycle_id: targetCycleId,
          member_id: memberId,
          amount: -settleAmount,
          label: "Auto-Settlement",
          notes: `Paid to ${creditor.members.name}`,
          status: "approved",
          parent_deposit_id: mainDeposit.id,
        },
        {
          cycle_id: targetCycleId,
          member_id: creditor.member_id,
          amount: settleAmount,
          label: "Auto-Settlement",
          notes: `Received from ${memberObj.name}`,
          status: "approved",
          parent_deposit_id: mainDeposit.id,
        },
      ]);

      // Update Creditor Progress
      const newCreditorSettled = creditor.settled_amount + settleAmount;
      await supabase
        .from("cycle_dues")
        .update({
          settled_amount: newCreditorSettled,
          status:
            newCreditorSettled >= creditor.due_amount ? "settled" : "settling",
          settled_at:
            newCreditorSettled >= creditor.due_amount
              ? new Date().toISOString()
              : null,
        })
        .eq("id", creditor.id);

      poolAvailable -= settleAmount;
      totalActuallySettled += settleAmount;
    }

    // 5. Update Debtor Progress Record
    if (totalActuallySettled > 0) {
      const newDebtorSettled =
        Math.abs(debtorDue.settled_amount) + totalActuallySettled;
      const isFullySettled = newDebtorSettled >= Math.abs(debtorDue.due_amount);

      await supabase
        .from("cycle_dues")
        .update({
          settled_amount: -newDebtorSettled,
          status: isFullySettled ? "settled" : "settling",
          settled_at: isFullySettled ? new Date().toISOString() : null,
        })
        .eq("id", debtorDue.id);
    }

    return {
      settled: totalActuallySettled > 0,
      settled_amount: totalActuallySettled,
      deposit_id: mainDeposit.id,
    };
  } catch (err) {
    console.error("Settlement Logic Crash:", err);
    throw err;
  } finally {
    isProcessingDepositSettlement = false;
  }
}

document.getElementById("depositForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  // Find button dynamically since it has no ID, or add ID="btnDepositSubmit" to HTML
  const submitBtn = e.target.querySelector('button[type="submit"]');

  await runSafeAction(
    submitBtn,
    async () => {
      const memberId = parseInt(document.getElementById("depositMember").value);
      const type = document.getElementById("depositType").value;
      const rawAmount = parseFloat(
        document.getElementById("depositAmount").value,
      );
      const roundedAmount = Math.round(rawAmount);
      const label = document.getElementById("depositLabel").value;
      const notes = document.getElementById("depositNotes").value;

      if (!memberId) throw new Error("Please select a member");
      if (!roundedAmount) throw new Error("Please enter a valid amount");

      const finalAmount =
        type === "charge" ? -Math.abs(roundedAmount) : Math.abs(roundedAmount);
      const actor = currentUser.name || "User";
      const targetMember = allMembers.find((m) => m.id === memberId);

      // All deposits go to pending for approval
      const { error } = await supabase.from("deposits").insert({
        cycle_id: parseInt(currentCycleId),
        member_id: memberId,
        amount: finalAmount,
        label: label,
        notes: notes,
        status: "pending",
      });
      if (error) throw error;

      await logActivity(
        `Deposit Request: ${targetMember?.name} requested ${formatCurrency(finalAmount)} by ${actor}`,
        "deposit",
      );
      showNotification("Request submitted for approval", "info");

      // Reset Inputs
      document.getElementById("depositAmount").value = "";
      document.getElementById("depositNotes").value = "";

      // Refresh
      loadDeposits();
    },
    "Processing...",
  );
});

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

    const name = document.getElementById("memberName").value;

    try {
      // 1. Insert Member
      const { data: memberData, error: memberError } = await supabase
        .from("members")
        .insert({ name: name })
        .select()
        .maybeSingle();

      if (memberError) throw memberError;

      // 2. Automatically create User
      const defaultPass = await hashPassword("123");

      await supabase.from("users").insert({
        username: name,
        password: defaultPass,
        role: "user",
        member_id: memberData.id,
      });

      await logActivity(`New member added & user created: ${name}`, "other");

      document.getElementById("addMemberForm").reset();
      await loadMembers();
      await loadMembersList();
      showNotification(
        'Member added successfully. Default password is "123"',
        "success",
      );
    } catch (err) {
      console.error("Error adding member:", err);
      showNotification("Failed to add member", "error");
    }
  });

async function loadMembersList() {
  const container = document.getElementById("membersList");
  if (!container) return;
  container.innerHTML = '<div class="loading">Loading members...</div>';

  try {
    const { data: members, error } = await supabase
      .from("members")
      .select("*")
      .order("name");

    if (error) throw error;

    if (!members || members.length === 0) {
      container.innerHTML = '<div class="loading">No members yet</div>';
      return;
    }

    container.innerHTML = members
      .map((member) => {
        const isManager = member.role === "manager";
        const isAdmin = member.role === "admin";
        const hasLogin = member.user_id !== null;

        // --- FIXED AVATAR LOGIC (Inside the loop) ---
        const avatarHtml =
          member.avatar_url && member.avatar_url.trim() !== ""
            ? `<img src="${member.avatar_url}" style="width:45px; height:45px; border-radius:50%; object-fit:cover; border: 2px solid #e2e8f0;">`
            : `<div style="width:45px; height:45px; border-radius:50%; background:#f1f5f9; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:16px; color:#64748b; border: 2px solid #cbd5e1;">${member.name[0].toUpperCase()}</div>`;

        return `
            <div class="list-item" style="flex-wrap: wrap; gap: 12px; align-items: center; padding: 15px; background: white; border-radius: 16px; margin-bottom: 10px; border: 1px solid #f1f5f9;">
                
                <!-- Avatar column -->
                <div style="flex-shrink: 0;">
                    ${avatarHtml}
                </div>

                <!-- Info column -->
                <div class="list-item-info" style="flex: 1; min-width: 150px;">
                    <div class="list-item-title" style="font-size: 15px; font-weight: 800;">
                        ${member.name} 
                        ${isAdmin ? '<span style="font-size:9px; background:#0f172a; color:white; padding:2px 6px; border-radius:6px; margin-left:5px;">ADMIN</span>' : ""}
                        ${isManager ? '<span style="font-size:9px; background:#10b981; color:white; padding:2px 6px; border-radius:6px; margin-left:5px;">MANAGER</span>' : ""}
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
                            onclick="openEditMemberModal('${member.id}', '${member.name}', '${member.user_id || ""}')">
                        Edit
                    </button>
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
  if (!confirm(`Change role to ${newRole}?`)) return;

  try {
    const { error } = await supabase
      .from("members")
      .update({ role: newRole })
      .eq("id", memberId);
    if (error) throw error;

    const targetMember = allMembers.find((m) => m.id == memberId);
    const actor = currentUser.members ? currentUser.members.name : "Admin";

    // LOG ROLE CHANGE
    await logActivity(
      `Access Control: ${targetMember.name} was ${isManager ? "demoted to User" : "promoted to Manager"} by ${actor}`,
      "other",
    );

    showNotification("Role updated successfully", "success");
    await loadMembersList();
  } catch (err) {
    showNotification("Failed to update role", "error");
  }
}

// --- Action 2: Delete Member ---
async function deleteMember(memberId, userId) {
  if (
    !confirm(
      "WARNING: Deleting a member will remove their user account. If they have existing meal/deposit records, this might fail or cause data issues. Continue?",
    )
  )
    return;

  try {
    // 1. Delete User Account first (if exists)
    if (userId) {
      const { error: uError } = await supabase
        .from("users")
        .delete()
        .eq("id", userId);
      if (uError) throw uError;
    }

    // 2. Delete Member
    const { error: mError } = await supabase
      .from("members")
      .delete()
      .eq("id", memberId);
    if (mError) {
      // If foreign key constraint fails (has meals/deposits)
      throw new Error(
        "Cannot delete member: They likely have associated meals or deposits.",
      );
    }

    showNotification("Member deleted successfully", "success");
    await loadMembersList();
    await loadMembers(); // Refresh global list
  } catch (err) {
    console.error("Delete error:", err);
    showNotification(err.message, "error");
  }
}

// --- Action 3: Edit Member (Modal & Save) ---
function openEditMemberModal(memberId, currentName, userId) {
  document.getElementById("editMemberId").value = memberId;
  document.getElementById("editUserId").value = userId;
  document.getElementById("editMemberName").value = currentName;
  document.getElementById("editMemberPassword").value = ""; // Reset password field
  document.getElementById("editMemberModal").classList.add("active");
}

document
  .getElementById("editMemberForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();

    // 1. Get Elements
    const memberId = document.getElementById("editMemberId").value;
    const userId = document.getElementById("editUserId").value; // The Auth User ID
    const newName = document.getElementById("editMemberName").value;
    const newPassword = document.getElementById("editMemberPassword").value;

    // Select the button specifically inside this form
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = "Save Changes";

    // 2. Lock UI
    submitBtn.textContent = "Saving...";
    submitBtn.disabled = true;

    try {
      // --- A. Update Display Name ---
      const { error: mError } = await supabase
        .from("members")
        .update({ name: newName })
        .eq("id", memberId);

      if (mError) throw mError;

      // --- B. Handle Password Change ---
      if (newPassword && newPassword.trim() !== "") {
        // Check if the user ID exists (some old members might not have logins)
        if (!userId || userId === "null" || userId === "undefined") {
          throw new Error(
            "This member does not have a linked User Account, so password cannot be changed.",
          );
        }

        // SCENARIO 1: Changing MY OWN password
        if (currentUser && currentUser.id === userId) {
          const { error: authError } = await supabase.auth.updateUser({
            password: newPassword,
          });
          if (authError) throw authError;
          console.log("Updated own password via Auth API");
        }

        // SCENARIO 2: Admin changing SOMEONE ELSE'S password
        else {
          // Call the SQL function we created in Step 1
          const { error: rpcError } = await supabase.rpc(
            "admin_reset_password",
            {
              target_user_id: userId,
              new_password: newPassword,
            },
          );

          if (rpcError) throw rpcError;
          console.log("Updated user password via Admin RPC");
        }
      }

      // --- C. Log & Notify ---
      const actor = currentUser.members ? currentUser.members.name : "Admin";
      await logActivity(
        `Profile Update: ${newName}'s details updated by ${actor}`,
        "other",
      );

      // Close Modal
      document.getElementById("editMemberModal").classList.remove("active");
      showNotification("Member updated successfully", "success");

      // Refresh Lists
      await loadMembersList(); // Admin list
      await loadMembers(); // Global dropdowns

      // If updating self, update header name immediately
      if (currentUser.member_id == memberId) {
        document.getElementById("profileName").textContent = newName;
        document.getElementById("headerUserName").textContent =
          `${newName} (${currentUser.role.toUpperCase()})`;
      }
    } catch (err) {
      console.error("Edit error:", err);
      showNotification("Update failed: " + err.message, "error");
    } finally {
      // --- 3. FIX: Reset Button State Always ---
      submitBtn.textContent = originalText;
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
  if (
    !confirm(
      "⚠️ Are you sure? \n\nThis will FORCE the system to copy all 'Meal Plans' into the 'Tracker' for Today's Night and Tomorrow's Day.\n\nThis overwrites the tracker with the plans immediately.",
    )
  ) {
    return;
  }

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

    showNotification("✅ Auto-entry forced successfully!", "success");
    await updateEntryStatusIndicator(); // <--- REFRESH BADGE IMMEDIATELY
    await loadDashboard(); // Reload logs
    await loadMasterTracker(); // Update tracker view if looking at it
  } catch (err) {
    console.error("Force Run Error", err);
    showNotification("Failed to run automation: " + err.message, "error");
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
      !confirm(
        "Are you sure you want to close the current cycle and create the new one?",
      )
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
      await logActivity(
        `Admin finalized cycle and started "${name}" (${start} to ${end})`,
        "other",
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
  console.log("🔍 Loading due settlement for cycle:", currentCycleId);

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
            <div class="due-item-name">${due.members.name}</div>
            <div class="due-item-amount ${type === "debtor" ? "balance-negative" : "balance-positive"}">
                ${formatCurrency(remaining)}
            </div>
        </div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-bottom: 5px;">
            From: ${due.from_cycle.name} 
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
    } else {
      header.classList.remove("balance-warning");
      // Remove warning icon if balance is recovered
      nameDisplay.innerHTML = nameDisplay.innerHTML.replace("⚠️ ", "");
    }
  } catch (err) {
    console.error("Balance Warning Check Error:", err);
  }
}

// 2. Save logic (triggered on change)
async function saveDayMenu(dayIndex) {
  const night = document.getElementById(`night-${dayIndex}`).value;
  const day = document.getElementById(`day-${dayIndex}`).value;

  // --- PREVENT EDITS IF CURRENT CYCLE IS INACTIVE ---
  // Assuming weekly menu changes apply to the currently viewed cycle logic
  if (currentCycleId) {
    const cycle = allCycles.find(c => c.id == currentCycleId);
    if (cycle && !cycle.is_active) {
      showNotification("Cannot edit menus for past cycles", "error");
      
      // visual reset would be nice but returning is crucial
      return;
    }
  }

  // Visual feedback: briefly highlight the inputs
  const inputs = [
    document.getElementById(`night-${dayIndex}`),
    document.getElementById(`day-${dayIndex}`),
  ];

  try {
    const { error } = await supabase
      .from("weekly_menus")
      .update({ night_menu: night, day_menu: day })
      .eq("day_index", dayIndex);

    if (error) throw error;

    // Success: flash green border
    inputs.forEach((i) => {
      i.style.borderColor = "var(--success-color)";
      setTimeout(() => (i.style.borderColor = ""), 1000);
    });

    // Update dashboard if visible
    if (
      !document.getElementById("dashboardPage").classList.contains("hidden")
    ) {
      updateDashboardMealPlan();
    }
  } catch (err) {
    // Error: flash red border
    inputs.forEach((i) => {
      i.style.borderColor = "var(--danger-color)";
      setTimeout(() => (i.style.borderColor = ""), 1000);
    });
    showNotification("Auto-save failed", "error");
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
      supabase.from("members").select("id, default_day_on, default_night_on"),
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

/* =========================================
   MOBILE BOTTOM SHEET LOGIC (UPDATED)
   ========================================= */

let activeSheetTab = "expense";
let editingExpenseId = null; // Tracks if bottom sheet is in edit mode

function openBottomSheet() {
  const overlay = document.getElementById("sheetOverlay");
  const sheet = document.getElementById("sheetModal");

  // 1. Populate Members (Keep defaults)
  const select = document.getElementById("sheetMember");
  const existingVal = select.value;
  select.innerHTML = "";

  allMembers.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.text = m.name;
    select.appendChild(opt);
  });

  if (currentUser && currentUser.member_id) {
    select.value = currentUser.member_id;
  }

  // 2. Set Date
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .split("T")[0];
  document.getElementById("sheetDate").value = localDate;

  // 3. Open
  overlay.classList.add("active");
  sheet.classList.add("active");

  // Default to Expense
  switchSheetTab("expense");

  // Auto-focus amount (delayed for animation)
  setTimeout(() => {
    document.getElementById("sheetAmount").focus();
  }, 400);
}

function closeBottomSheet() {
  document.getElementById("sheetOverlay").classList.remove("active");
  document.getElementById("sheetModal").classList.remove("active");
  document.activeElement.blur(); // Close keyboard

  // Clear edit state
  editingExpenseId = null;

  setTimeout(() => {
    document.getElementById("sheetAmount").value = "";
    document.getElementById("sheetDesc").value = "";
    document.getElementById("sheetNotes").value = "";
    document
      .querySelectorAll(".sheet-chip")
      .forEach((c) => c.classList.remove("selected"));

    // Reset title/button back to "New" mode
    document.getElementById("sheetMainTitle").textContent = "New Expense";
    document.getElementById("sheetSubmitBtn").textContent = "Save Expense";
    document.getElementById("sheetSubmitBtn").style.background = ""; // Clear edit-mode green
  }, 300);
}

// --- MOBILE EDIT MODE: Open bottom sheet pre-filled for editing ---
function openBottomSheetForEdit(expenseId, date, memberId, amount, desc) {
  const overlay = document.getElementById("sheetOverlay");
  const sheet = document.getElementById("sheetModal");

  // 1. Set edit state
  editingExpenseId = expenseId;

  // 2. Populate Members
  const select = document.getElementById("sheetMember");
  select.innerHTML = "";
  allMembers.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.text = m.name;
    select.appendChild(opt);
  });

  // 3. Pre-fill with existing expense data
  document.getElementById("sheetAmount").value = amount;
  document.getElementById("sheetDate").value = date;
  select.value = memberId;
  document.getElementById("sheetDesc").value = desc || "";
  document.getElementById("sheetNotes").value = "";

  // 4. Force Expense tab and set Edit UI
  switchSheetTab("expense");
  document.getElementById("sheetMainTitle").textContent = "Edit Expense";
  document.getElementById("sheetSubmitBtn").textContent = "Update Expense ✓";

  // 5. Apply edit-mode theme color (green instead of red)
  const btn = document.getElementById("sheetSubmitBtn");
  btn.style.background = "linear-gradient(135deg, #10b981, #059669)";

  // 6. Open
  overlay.classList.add("active");
  sheet.classList.add("active");

  // Auto-focus amount
  setTimeout(() => {
    document.getElementById("sheetAmount").focus();
  }, 400);
}

// --- NEW: THEME SWITCHER & VISUAL UPDATES ---
function switchSheetTab(tab) {
  activeSheetTab = tab;
  const sheet = document.getElementById("sheetModal");
  const title = document.getElementById("sheetMainTitle");
  const btn = document.getElementById("sheetSubmitBtn");

  // Toggle Tab Active Classes
  document.getElementById("tabExpense").className =
    `sheet-tab ${tab === "expense" ? "active" : ""}`;
  document.getElementById("tabDeposit").className =
    `sheet-tab ${tab === "deposit" ? "active" : ""}`;

  // Toggle Sheet Theme Class (Handles Colors)
  if (tab === "expense") {
    sheet.classList.remove("sheet-theme-deposit");
    sheet.classList.add("sheet-theme-expense");

    // Preserve edit mode titles if editing
    if (editingExpenseId) {
      title.textContent = "Edit Expense";
      btn.textContent = "Update Expense ✓";
    } else {
      title.textContent = "New Expense";
      btn.textContent = "Save Expense";
    }

    document.getElementById("expenseExtras").style.display = "block";
    document.getElementById("depositExtras").style.display = "none";
  } else {
    sheet.classList.remove("sheet-theme-expense");
    sheet.classList.add("sheet-theme-deposit");

    // If user switches to deposit tab, clear expense edit state
    editingExpenseId = null;

    title.textContent = "New Deposit";
    btn.textContent = "Save Deposit";

    document.getElementById("expenseExtras").style.display = "none";
    document.getElementById("depositExtras").style.display = "block";
  }
}

// --- KEYBOARD FIX: Ensure input is visible when focused ---
function ensureVisible(element) {
  setTimeout(() => {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 300);
}

// Chip Helpers
function selectChip(text) {
  document.getElementById("sheetDesc").value = text;
  document
    .querySelectorAll("#expenseExtras .sheet-chip")
    .forEach((c) => c.classList.remove("selected"));
  event.target.classList.add("selected");
}

function selectDepositType(type) {
  document.getElementById("sheetDepType").value = type;
  document.getElementById("sheetLabel").value =
    type === "charge" ? "Reduction" : "Deposit";

  document
    .querySelectorAll("#depositExtras .sheet-chip")
    .forEach((c) => c.classList.remove("selected"));
  event.target.classList.add("selected");
}

// Submit Logic
async function submitMobileEntry() {
  const btn = document.getElementById("sheetSubmitBtn");
  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const amountVal = parseFloat(document.getElementById("sheetAmount").value);
    const date = document.getElementById("sheetDate").value;
    const memberId = document.getElementById("sheetMember").value;
    const notes = document.getElementById("sheetNotes").value;

    if (!amountVal || amountVal <= 0)
      throw new Error("Please enter a valid amount");
    if (!memberId) throw new Error("Please select a member");

    if (activeSheetTab === "expense") {
      // EXPENSE LOGIC
      const desc =
        document.getElementById("sheetDesc").value || "General Expense";
      const actorName = currentUser.members?.name || currentUser.name;

      if (editingExpenseId) {
        // --- EDIT MODE: Update existing expense ---
        const { error } = await supabase
          .from("expenses")
          .update({
            expense_date: date,
            member_id: memberId,
            description: desc,
            amount: amountVal,
            is_edited: true,
          })
          .eq("id", editingExpenseId);
        if (error) throw error;

        logActivity(
          `Expense Edited: ৳${amountVal} (${desc}) by ${actorName}`,
          "expense",
        );
        showNotification("Expense Updated!", "success");
        editingExpenseId = null; // Clear edit state
      } else {
        // --- INSERT MODE: Create new expense (always pending) ---
        const { error } = await supabase.from("expenses").insert({
          cycle_id: currentCycleId,
          expense_date: date,
          member_id: memberId,
          description: desc,
          amount: amountVal,
          status: "pending",
        });
        if (error) throw error;

        await logActivity(
          `New Expense: ৳${amountVal} (${desc}) by ${actorName}`,
          "expense",
        );
        showNotification("Request Sent for Approval", "success");
        triggerMascotReaction('expense');
      }

      if (typeof loadExpenses === "function") loadExpenses();
    } else {
      // DEPOSIT LOGIC (always pending for approval)
      const type = document.getElementById("sheetDepType").value;
      const label = document.getElementById("sheetLabel").value;
      const finalAmount =
        type === "charge" ? -Math.abs(amountVal) : Math.abs(amountVal);

      const { error } = await supabase.from("deposits").insert({
        cycle_id: parseInt(currentCycleId),
        member_id: memberId,
        amount: finalAmount,
        label: label,
        notes: notes,
        status: "pending",
      });
      if (error) throw error;
      showNotification("Request Sent for Approval", "info");
      triggerMascotReaction('deposit');

      if (typeof loadDeposits === "function") loadDeposits();
    }

    // Global Refresh & Close
    if (typeof loadDashboard === "function") loadDashboard();
    closeBottomSheet();
  } catch (err) {
    showNotification(err.message, "error");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// [REMOVED] Duplicate visibilitychange and beforeunload — the correct handlers are defined earlier in the file.


// Open the existing Edit Member modal, but configured for the current user
function openChangePasswordModal() {
  if (!currentUser || !currentUser.member_id) return;

  // Reuse your existing Edit Member Modal logic
  document.getElementById("editMemberId").value = currentUser.member_id;
  document.getElementById("editUserId").value = currentUser.id; // Supabase Auth ID
  document.getElementById("editMemberName").value = currentUser.name;
  document.getElementById("editMemberPassword").value = ""; // Clean field

  // Change Title to look like a User Action
  document.querySelector("#editMemberModal .modal-title").textContent =
    "Change My Password";

  document.getElementById("editMemberModal").classList.add("active");
}

// ============================================
// SMART BACK BUTTON LOGIC (Android/PWA)
// ============================================

// ============================================
// SMART BACK BUTTON LOGIC (History + Modals)
// ============================================

function initAndroidBackHandler() {
  // 1. Push a "Guard" state immediately
  window.history.pushState(
    { app: "active" },
    document.title,
    window.location.href,
  );

  // 2. Listen for Back Button
  window.addEventListener("popstate", (event) => {
    let handled = false;

    // --- PRIORITY 1: CLOSE OVERLAYS & MODALS ---

    // A. Sidebar
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebarOverlay");
    if (sidebar && sidebar.classList.contains("mobile-active")) {
      sidebar.classList.remove("mobile-active");
      if (overlay) overlay.classList.remove("active");
      handled = true;
    }

    // B. Bottom Sheet
    const sheet = document.getElementById("sheetModal");
    if (!handled && sheet && sheet.classList.contains("active")) {
      closeBottomSheet();
      handled = true;
    }

    // C. Notification Panel
    const notifPanel = document.getElementById("notifPanel");
    if (!handled && notifPanel && notifPanel.classList.contains("active")) {
      notifPanel.classList.remove("active");
      handled = true;
    }

    // D. Any Standard Modal
    const activeModal = document.querySelector(".modal.active");
    if (!handled && activeModal) {
      activeModal.classList.remove("active");
      handled = true;
    }

    // --- PRIORITY 2: GO BACK IN APP HISTORY ---

    if (!handled && navigationHistory.length > 0) {
      const prevPage = navigationHistory.pop(); // Get last page
      // Navigate there, but FALSE means don't add "Current" to stack (prevent loops)
      navigateToPage(prevPage, false);
      handled = true;
    }

    // --- PRIORITY 3: FALLBACK TO DASHBOARD ---

    if (!handled) {
      const activePage = getActivePage();
      // If we are NOT on dashboard, and have NO history, go to dashboard
      if (activePage && activePage !== "dashboard") {
        navigateToPage("dashboard", false);
        handled = true;
      }
    }

    // --- CONCLUSION ---
    if (handled) {
      // We handled it internally, so we Push State again to "re-arm" the trap
      window.history.pushState(
        { app: "active" },
        document.title,
        window.location.href,
      );
    } else {
      // We did NOT handle it (User is on Dashboard, No Modals, No History).
      // We let the browser's "Back" action complete, which closes/minimizes the app.
      console.log("Exiting App...");
    }
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      reg.onupdatefound = () => {
        const installingWorker = reg.installing;
        installingWorker.onstatechange = () => {
          if (
            installingWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            // New content is available; tell user to refresh
            showNotification("New version available! Please refresh.", "info");
          }
        };
      };
    });
  });
}
