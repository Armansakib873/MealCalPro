// MealCal Pro — Supabase client, safe-action wrapper, global state, session-date helpers
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

const SUPABASE_URL = "https://bcardtccxcnktkkeszpp.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjYXJkdGNjeGNua3Rra2VzenBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1NzU1NDIsImV4cCI6MjA4MDE1MTU0Mn0.xGxk81ThPGtyQgRCNoOxpvxsnXBUAzgmclrS0ru7g2Q";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Debug logging: silent in production. Turn on from the browser console with  localStorage.mc_debug = "1"
const MC_DEBUG = (() => { try { return localStorage.getItem("mc_debug") === "1"; } catch (_) { return false; } })();
function dlog(...args) { if (MC_DEBUG) console.log(...args); }

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

let currentUser = null; // set in auth.js after login (was an undeclared implicit global)
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
  dlog("🔄 Syncing local state with database...");

  // Fetch everything in parallel for speed
  const [
    { data: members },
    { data: meals },
    { data: plans },
    { data: expenses },
    { data: deposits },
  ] = await Promise.all([
    supabase.from("members").select("*").eq("is_approved", true).order("name"),
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

  dlog("✅ Local state is now current.");
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
    (s, m) => s + parseFloat(m.day_count || 0) + parseFloat(m.night_count || 0)
                + parseFloat(m.guest_day_count || 0) + parseFloat(m.guest_night_count || 0), 0
  );
  const firstDayExcess = cm
    .filter(m => m.meal_date === cycleStartDate)
    .reduce((s, m) => s + parseFloat(m.day_count || 0) + parseFloat(m.guest_day_count || 0), 0);
  const boundaryAdd = bm
    .reduce((s, m) => s + parseFloat(m.day_count || 0) + parseFloat(m.guest_day_count || 0), 0);
  return raw - firstDayExcess + boundaryAdd;
}
