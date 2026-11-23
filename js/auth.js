// MealCal Pro — Login / signup / logout
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

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
      dlog("Unauthenticated: Transitioning to Login.");
    }, 500);
  }

  // Listen for Auth changes (Login/Logout).
  // Token refreshes / tab refocus also fire events — those must NOT restart the app.
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      if (event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION" || event === "USER_UPDATED") return;
      if (_bootedUserId === session.user.id) return; // already running for this user
      // Defer: never await Supabase calls inside this callback (it can deadlock the auth lock)
      setTimeout(() => handleUserSession(session.user), 0);
    } else if (event === "SIGNED_OUT") {
      _bootedUserId = null;
      document.getElementById("pendingApprovalPage")?.remove();
      document.getElementById("authPage").classList.remove("hidden");
      document.getElementById("mainApp").classList.add("hidden");
      hideSplash(400);
    }
  });
}

let _bootedUserId = null; // the user the app is currently initialized for

// 2. Fetch Member Profile based on Login ID
async function handleUserSession(user) {
  try {
    // 1. Try to fetch the profile from the 'members' table
    let { data: member, error } = await supabase
      .from("members")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    // New signups get a member row from the database trigger. Until an admin
    // approves it, the user only sees the waiting screen (and nobody sees them).
    if (!member || !member.is_approved) {
      showPendingApproval(user, member);
      return;
    }

    currentUser = {
      ...user,
      member_id: member.id,
      name: member.name,
      role: member.role || "user",
      members: member,
    };

    if (_bootedUserId === user.id) return; // never boot twice
    _bootedUserId = user.id;

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

      // Handle Username Login (if no @ is present) — looked up through a safe RPC,
      // members are not readable before login.
      if (!emailOrUser.includes("@")) {
        const { data: email, error: findError } = await supabase.rpc("get_login_email", { p_name: emailOrUser });
        if (findError || !email) {
          throw new Error("Username not found. Please use your email.");
        }
        finalEmail = email;
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
        await uiAlert(
          "Check your email",
          "Your account was created. Confirm your email, then log in.\nAn admin must approve you before you can use the app.",
          { icon: "📧" },
        );
        // Switch back to login mode automatically
        document.getElementById("authToggleBtn").click();
        return;
      }
      // With a session, onAuthStateChange shows the "waiting for approval" screen.
      // The member row is created by the database (trigger on auth.users).
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
document.getElementById("logoutBtn").addEventListener("click", () => confirmLogout());

async function confirmLogout() {
  const ok = await uiConfirm("Log out?", "You'll need your email (or name) and password to log back in.", {
    icon: "🚪", confirmText: "Log out", danger: true,
  });
  if (!ok) return;
  await doLogout();
}

async function doLogout() {
  // 1. Show feedback
  const btn = document.getElementById("logoutBtn");
  if (btn) btn.innerHTML = '<span class="nav-icon">⏳</span> Logging out...';
  showSplash("Logging out...");

  try {
    // 2. Sign out from Supabase server
    await supabase.auth.signOut();
  } catch (err) {
    console.warn("SignOut Error (ignoring):", err);
  }

  // 3. Clear stored session data, but keep this device's display preferences
  // Keep device preferences: theme, quick-entry shortcuts, "notifications seen" markers
  const keep = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === "mc_theme" || k.startsWith("mc_qe_") || k.startsWith("mc_notif_seen_")) keep[k] = localStorage.getItem(k);
    }
  } catch (_) {}
  try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
  try { Object.entries(keep).forEach(([k, v]) => localStorage.setItem(k, v)); } catch (_) {}

  // 4. FORCE RELOAD — the next login starts with a clean memory
  window.location.reload();
}

// ============================================
// WAITING FOR APPROVAL SCREEN (new signups)
// ============================================
function showPendingApproval(user, member) {
  hideSplash(200);
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("authPage").classList.add("hidden");
  let screen = document.getElementById("pendingApprovalPage");
  if (!screen) {
    screen = document.createElement("div");
    screen.id = "pendingApprovalPage";
    screen.className = "pending-approval-page";
    document.body.appendChild(screen);
  }
  const name = member?.name || user.user_metadata?.display_name || user.email;
  screen.innerHTML = `
    <div class="pending-approval-card">
      <img src="Mealcal_logo.png" alt="" width="64" height="64" class="pending-approval-logo">
      <div class="pending-approval-pulse"><span></span></div>
      <h1>Waiting for approval</h1>
      <p>Hi <strong>${escapeHtml(name)}</strong>, your account is ready. An admin or manager of the mess needs to approve it before you can see meals, deposits and expenses.</p>
      <p class="pending-approval-hint">This page updates by itself the moment you're approved.</p>
      <div class="pending-approval-actions">
        <button type="button" class="ui-btn ui-btn-primary" id="pendingRecheckBtn">Check again</button>
        <button type="button" class="ui-btn ui-btn-ghost" id="pendingLogoutBtn">Log out</button>
      </div>
    </div>`;
  screen.classList.remove("hidden");
  screen.querySelector("#pendingLogoutBtn").onclick = () => confirmLogout();
  screen.querySelector("#pendingRecheckBtn").onclick = () => recheckApproval(user);

  // Live: get approved without refreshing
  if (window._approvalChannel) supabase.removeChannel(window._approvalChannel);
  if (member?.id) {
    window._approvalChannel = supabase
      .channel("approval-" + member.id)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "members", filter: `id=eq.${member.id}` },
          (p) => { if (p.new?.is_approved) recheckApproval(user); })
      .subscribe();
  }
  clearInterval(window._approvalPoll);
  window._approvalPoll = setInterval(() => recheckApproval(user, true), 30000);
}

async function recheckApproval(user, silent = false) {
  const { data: member } = await supabase.from("members").select("*").eq("user_id", user.id).maybeSingle();
  if (member?.is_approved) {
    clearInterval(window._approvalPoll);
    if (window._approvalChannel) supabase.removeChannel(window._approvalChannel);
    document.getElementById("pendingApprovalPage")?.remove();
    showSplash("Welcome to the mess!");
    await handleUserSession(user);
  } else if (!silent) {
    showNotification("Not approved yet — please ask an admin.", "info");
  }
}

// Function to populate the login dropdown (only approved, active member names)
async function loadLoginUserDropdown() {
  const dropdown = document.getElementById("authUserDropdown");
  if (!dropdown) return;

  try {
    const { data, error } = await supabase.rpc("get_login_names");

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
    if (typeof onPageLoaded === "function") onPageLoaded(pageName);
  } catch (err) {
    console.error(`❌ Failed to load ${pageName}:`, err);
  }
}
