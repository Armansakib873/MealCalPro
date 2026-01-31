

    const SUPABASE_URL = 'https://bcardtccxcnktkkeszpp.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjYXJkdGNjeGNua3Rra2VzenBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1NzU1NDIsImV4cCI6MjA4MDE1MTU0Mn0.xGxk81ThPGtyQgRCNoOxpvxsnXBUAzgmclrS0ru7g2Q';
    
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // ============================================
    // STATE MANAGEMENT
    // ============================================

    let currentCycleId = null;
    let allMembers = [];
    let allCycles = [];


    // Master Local Mirror of the Database
let appState = {
    members: [],
    meals: [],
    meal_plans: [],
    expenses: [],
    deposits: [],
    notifications: [],
    lastSync: null
};

// Track if a page has been loaded at least once
const pageLoaded = {
    dashboard: false,
    profile: false,
    tracker: false,
    summary: false,
    expenses: false,
    deposits: false,
    admin: false
};

async function syncFullState() {
    console.log("🔄 Syncing local state with database...");
    
    // Fetch everything in parallel for speed
    const [
        { data: members },
        { data: meals },
        { data: plans },
        { data: expenses },
        { data: deposits }
    ] = await Promise.all([
        supabase.from('members').select('*').order('name'),
        supabase.from('meals').select('*').eq('cycle_id', currentCycleId),
        supabase.from('meal_plans').select('*'),
        supabase.from('expenses').select('*').eq('cycle_id', currentCycleId).eq('status', 'approved'),
        supabase.from('deposits').select('*').eq('cycle_id', currentCycleId).neq('status', 'pending')
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
    const bnDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
    return num.toString().replace(/\d/g, d => bnDigits[d]);
}

// Helper to get YYYY-MM-DD in LOCAL time (prevents Dec 31st bug)
function toLocalISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`; // Returns YYYY-MM-DD
}

function parseLocalDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
}



    // ============================================
// NEW SUPABASE AUTHENTICATION LOGIC
// ============================================

let isLoginMode = true; // Toggle between Login and Signup

// 1. Initialize Auth State Listener (Runs automatically on load)
async function initAuth() {
    // 1. Check for current session
    const { data: { session } } = await supabase.auth.getSession();
    
    if (session) {
        // User is logged in: Keep splash visible and load the app
        await handleUserSession(session.user);
    } else {
        // User is logged out:
        // Hide the loader and show the login page simultaneously for a smooth swap
        const authPage = document.getElementById('authPage');
        const mainApp = document.getElementById('mainApp');
        
        mainApp.classList.add('hidden');
        authPage.classList.remove('hidden');
        
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
            document.getElementById('authPage').classList.remove('hidden');
            document.getElementById('mainApp').classList.add('hidden');
            hideSplash(400);
        }
    });
}

// 2. Fetch Member Profile based on Login ID
async function handleUserSession(user) {
    try {
        // 1. Try to fetch the profile from the 'members' table
        let { data: member, error } = await supabase
            .from('members')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

        if (member) {
            // Success: User is a recognized member
            currentUser = { 
                ...user, 
                member_id: member.id,
                name: member.name, 
                role: member.role || 'user'
            };
        } else {
            // New Signup Fallback: Use metadata from the Auth system
            // This ensures the header shows the name immediately after account creation
            currentUser = { 
                ...user, 
                name: user.user_metadata?.display_name || user.email.split('@')[0], 
                role: 'user' 
            };
        }

        // Redirect logic
        showApp();
        
        // Admin Tab Logic
        if (currentUser.role === 'admin' || currentUser.role === 'manager') {
            document.getElementById('adminMenuItem').style.display = 'block';
        } else {
            document.getElementById('adminMenuItem').style.display = 'none';
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
document.getElementById('authToggleBtn').addEventListener('click', (e) => {
    e.preventDefault();
    isLoginMode = !isLoginMode;
    
    const title = isLoginMode ? 'Login to Kitchen' : 'Create Account';
    const subtitle = isLoginMode ? 'Your kitchen, professionally managed.' : 'Join the mess and track your meals.';
    const emailLabel = isLoginMode ? 'Email or Username' : 'Email Address';
    const btnText = isLoginMode ? 'Login to Kitchen' : 'Sign Up Now';
    const toggleText = isLoginMode ? 'New to the mess?' : 'Already have an account?';
    const linkText = isLoginMode ? 'Create Account' : 'Login';

    document.getElementById('authSubtitle').textContent = subtitle;
    document.getElementById('emailLabel').textContent = emailLabel;
    document.getElementById('authBtn').querySelector('span').textContent = btnText;
    document.getElementById('authToggleText').textContent = toggleText;
    document.getElementById('authToggleBtn').textContent = linkText;

    // Show/Hide Full Name field for Signup
    const userField = document.getElementById('usernameField');
    if (isLoginMode) {
        userField.classList.add('hidden');
        document.getElementById('authUsername').removeAttribute('required');
    } else {
        userField.classList.remove('hidden');
        document.getElementById('authUsername').setAttribute('required', 'true');
    }
});

// 2. Handle Submission (Improved with better debugging)
document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // 1. Collect inputs
    const emailOrUser = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const fullName = document.getElementById('authUsername').value.trim(); // Only for Signup
    const errorDiv = document.getElementById('authError');
    
    errorDiv.style.display = 'none';
    
    // Show the splash loader
    showSplash(isLoginMode ? "Securing Kitchen..." : "Setting up your Account...");

    try {
        if (isLoginMode) {
            // ==========================================
            // LOG IN LOGIC
            // ==========================================
            let finalEmail = emailOrUser;

            // Handle Username Login (if no @ is present)
            if (!emailOrUser.includes('@')) {
                const { data: member, error: findError } = await supabase
                    .from('members')
                    .select('email')
                    .eq('name', emailOrUser)
                    .maybeSingle();

                if (findError || !member || !member.email) {
                    throw new Error("Username not found. Please use your email.");
                }
                finalEmail = member.email;
            }

            const { error: loginError } = await supabase.auth.signInWithPassword({ 
                email: finalEmail, 
                password: password 
            });

            if (loginError) throw loginError;
            // Success: supabase.auth.onAuthStateChange will automatically trigger initializeApp()

        } else {
            // ==========================================
            // SIGN UP LOGIC
            // ==========================================
            
            // Validation
            if (!emailOrUser.includes('@')) throw new Error("A valid email is required for registration.");
            if (fullName.length < 2) throw new Error("Please enter your full name.");
            if (password.length < 6) throw new Error("Password must be at least 6 characters.");

            // 1. Create the Auth User
            // ... inside authForm listener, in the 'else' (Signup) block:
const { data: authData, error: signupError } = await supabase.auth.signUp({
    email: emailOrUser,
    password: password,
    options: {
        // This 'display_name' is what currentUser.user_metadata looks for
        data: { display_name: fullName } 
    }
});

            if (signupError) throw signupError;

            // 2. Check if Email Confirmation is required
            // (If session is null, it means the user must click the link in their email)
            if (authData.user && !authData.session) {
                hideSplash(100);
                alert("Signup successful! Please check your email inbox to confirm your account before logging in.");
                // Switch back to login mode automatically
                document.getElementById('authToggleBtn').click(); 
                return;
            }

            // 3. Link Auth User to 'members' table
            // This is the most important part for your app to show the user's name
            if (authData.user) {
                const { error: memberError } = await supabase.from('members').insert({
                    user_id: authData.user.id,
                    name: fullName,
                    email: emailOrUser,
                    role: 'user' // Default role for new signups
                });

                if (memberError) {
                    console.error("Member Link Error:", memberError);
                    throw new Error("Account created but profile sync failed. Please contact Admin.");
                }

                showNotification("Welcome to MealCal Pro!", "success");
            }
        }

    } catch (err) {
        // Hide splash and show error
        hideSplash(100); 
        errorDiv.textContent = err.message;
        errorDiv.style.display = 'block';
        console.error("Auth Failure:", err);
    }
});




// 5. Update Logout
document.getElementById('logoutBtn').addEventListener('click', async () => {
    await supabase.auth.signOut();
    // onAuthStateChange will handle the UI update
});



// Function to populate the login dropdown
async function loadLoginUserDropdown() {
    const dropdown = document.getElementById('authUserDropdown');
    
    // We fetch from 'members' because it's usually public/readable even before login
    // assuming member names match usernames as per your logic
    try {
        const { data, error } = await supabase
            .from('members')
            .select('name')
            .order('name');

        if (error) throw error;

        // Clear and repopulate
        dropdown.innerHTML = '<option value="">Select User ▼</option>';
        
        data.forEach(member => {
            const option = document.createElement('option');
            option.value = member.name;
            option.textContent = member.name;
            dropdown.appendChild(option);
        });

        // Add listener to auto-fill the input
        dropdown.addEventListener('change', (e) => {
            if (e.target.value) {
                document.getElementById('authEmail').value = e.target.value;
            }
        });

    } catch (err) {
        console.error("Error loading user dropdown:", err);
        // If error (e.g., RLS policy prevents reading), just hide the dropdown
        dropdown.style.display = 'none';
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
        switch(pageName) {
            case 'expenses':
                await loadExpenses();
                break;
            case 'profile':
                await Promise.all([loadProfile(), loadScheduler()]);
                break;
            case 'dashboard':
                await loadDashboard();
                break;
            case 'tracker':
                await Promise.all([loadMasterTracker(), loadWeeklyMenuEditor()]);
                break;
            case 'summary':
                await loadSummary();
                break;
            case 'deposits':
                await loadDeposits();
                break;
            case 'admin':
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
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }


function formatCurrency(amount) {
    const isNegative = amount < 0;
    // We get absolute value for the numbers, but keep track of sign
    const val = Math.abs(parseFloat(amount || 0)).toFixed(2);
    const [integerPart, decimalPart] = val.split('.');
    
    // Add the negative sign if needed
    const signPrefix = isNegative ? '-' : '';
    
    return `${signPrefix}৳ <span class="amt-whole">${toBn(integerPart)}</span><span class="amt-decimal">.${toBn(decimalPart)}</span>`;
}

// This function handles both the name 'formatDate' and adds the Time
function formatDate(dateString) {
    if (!dateString) return "-";
    const date = new Date(dateString);
    
    // Formats to: 02 Jan • 10:30 AM
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + 
           ' • ' + 
           date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
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
        .channel('db_changes')
        
        // 1. MEAL PLANS - Watch for schedule changes
        .on('postgres_changes', 
            { event: '*', schema: 'public', table: 'meal_plans' },
            (payload) => {
                console.log("📅 Meal Plan Changed:", payload.eventType);
                handleRealtimeUpdate('meal_plans', payload);
            }
        )
        
        // 2. MEALS (Tracker)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'meals' },
            (payload) => {
                console.log("🍽️ Meal Record Changed:", payload.eventType);
                handleRealtimeUpdate('meals', payload);
            }
        )
        
        // 3. DEPOSITS
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'deposits' },
            (payload) => {
                console.log("💰 Deposit Changed:", payload.eventType);
                handleRealtimeUpdate('deposits', payload);
            }
        )
        
        // 4. EXPENSES
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'expenses' },
            (payload) => {
                console.log("🛒 Expense Changed:", payload.eventType);
                handleRealtimeUpdate('expenses', payload);
            }
        )
        
        // 5. NOTIFICATIONS
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'notifications' },
            (payload) => {
                console.log("🔔 New Notification");
                handleRealtimeUpdate('notifications', payload);
            }
        )
        
        // 6. MEMBERS
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'members' },
            (payload) => {
                console.log("👤 Member Changed:", payload.eventType);
                handleRealtimeUpdate('members', payload);
            }
        )
        
        // 7. CYCLE DUES
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'cycle_dues' },
            (payload) => {
                console.log("💳 Due Changed:", payload.eventType);
                handleRealtimeUpdate('cycle_dues', payload);
            }
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
    realtimeChannels.forEach(channel => {
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
    switch(table) {
        case 'meal_plans':
            handleMealPlanUpdate(activePage, payload);
            break;
        case 'meals':
            handleMealUpdate(activePage, payload);
            break;
        case 'deposits':
            handleDepositUpdate(activePage, payload, newData, oldData);
            break;
        case 'expenses':
            handleExpenseUpdate(activePage, payload, newData);
            break;
        case 'notifications':
            handleNotificationUpdate(payload, newData);
            break;
        case 'members':
            handleMemberUpdate(activePage);
            break;
        case 'cycle_dues':
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
    const isMe = payload.new?.member_id === currentUser?.member_id || 
                 payload.old?.member_id === currentUser?.member_id;

    if (activePage === 'profile' && isMe) {
        loadScheduler(); // Refresh the dots/buttons on profile
    }
    
    if (activePage === 'summary') {
        loadSummary(); // Refresh the table
    }

    updateEntryStatusIndicator();
}


function handleMealUpdate(activePage, payload) {
    const isMe = payload.new?.member_id === currentUser?.member_id || 
                 payload.old?.member_id === currentUser?.member_id;

    // Tracker and Summary need updates for everyone
    if (activePage === 'tracker') {
        debounceRefresh(() => loadMasterTracker(), 'tracker', 800);
    }
    if (activePage === 'summary') {
        debounceRefresh(() => loadSummary(), 'summary', 1000);
    }
    
    // ONLY refresh profile stats if the update belongs to the current user
    if (activePage === 'profile' && isMe) {
        debounceRefresh(() => loadProfile(), 'profile', 800);
        // Also refresh scheduler if actual meal records change
        debounceRefresh(() => loadScheduler(), 'scheduler', 800);
    }
}



function handleDepositUpdate(activePage, payload, newData, oldData) {
    const isCurrentUser = newData?.member_id === currentUser?.member_id || 
                          oldData?.member_id === currentUser?.member_id;
    
    // Update Deposits page
    if (activePage === 'deposits') {
        debounceRefresh(() => loadDeposits(), 'deposits', 500);
    }
    
    // Update Summary
    if (activePage === 'summary') {
        debounceRefresh(() => loadSummary(), 'summary', 1000);
    }
    
    // Update Dashboard
    if (activePage === 'dashboard') {
        debounceRefresh(() => loadDashboard(), 'dashboard', 1000);
    }
    
    // Update Profile if current user
    if (activePage === 'profile' && isCurrentUser) {
        debounceRefresh(() => loadProfile(), 'profile', 800);
    }
    
    // Update balance warning
    if (isCurrentUser) {
        debounceRefresh(() => {
            checkGlobalBalanceWarning();
            updateEntryStatusIndicator();
        }, 'balance-check', 1000);
    }
      updateDashboardBadges(); 
       updatePendingCounts();
    
    // Show toast notification for new deposits (not from current user)
    if (payload.eventType === 'INSERT' && newData && !isCurrentUser) {
        const memberName = allMembers.find(m => m.id === newData.member_id)?.name || 'Someone';
        const amount = Math.abs(newData.amount);
        const type = newData.amount > 0 ? '💰 Deposit' : '📉 Charge';
        showNotification(`${type}: ${memberName} - ৳${amount}`, 'info');
    }
}

function handleExpenseUpdate(activePage, payload, newData) {
    // 1. If we are currently looking at the expenses page, update the list.
    if (activePage === 'expenses') {
        // We set forceRefresh to true here because data actually changed in the DB
        debounceRefresh(() => loadExpenses(), 'expenses-ui', 500);
    }
    
    // 2. Summary needs update because meal rate depends on expenses
    if (activePage === 'summary') {
        debounceRefresh(() => loadSummary(), 'summary-ui', 1000);
    }
    
    // 3. Dashboard stats
    if (activePage === 'dashboard') {
        debounceRefresh(() => loadDashboard(), 'dash-ui', 1000);
    }
      updateDashboardBadges(); 
       updatePendingCounts();
    
    // 4. Show a toast notification for everyone
    if (payload.eventType === 'INSERT' && newData) {
        const memberName = allMembers.find(m => m.id === newData.member_id)?.name || 'Someone';
        showNotification(`🛒 New Bazar: ${newData.description} (৳${newData.amount}) by ${memberName}`, 'info');
    }
}

function handleNotificationUpdate(payload, newData) {
    // Only process if it's for current cycle
    if (newData?.cycle_id != currentCycleId) return;
    
    // Update notification panel if open
    if (document.getElementById('notifPanel').classList.contains('active')) {
        debounceRefresh(() => loadNotifications(), 'notifications', 500);
    }
    
    // Update badge count
    const badge = document.getElementById('notifBadge');
    const currentCount = parseInt(badge.textContent) || 0;
    badge.textContent = currentCount + 1;
    badge.classList.remove('hidden');
    
    // Update recent activity on dashboard
    if (getActivePage() === 'dashboard') {
        debounceRefresh(() => loadRecentActivity(), 'activity', 800);
    }
}

function handleMemberUpdate(activePage) {
    // Reload global members list
    debounceRefresh(() => loadMembers(), 'members-global', 1000);
    
    // Update Admin page
    if (activePage === 'admin') {
        debounceRefresh(() => loadMembersList(), 'members-list', 800);
    }
    
    // Update Summary (member names might have changed)
    if (activePage === 'summary') {
        debounceRefresh(() => loadSummary(), 'summary', 1000);
    }
}

function handleDueUpdate(activePage, newData, oldData) {
    // Only update if it's for current cycle
    if (newData?.to_cycle_id != currentCycleId && oldData?.to_cycle_id != currentCycleId) return;
    
    // Update Summary page dues section
    if (activePage === 'summary') {
        debounceRefresh(() => loadDueSettlement(), 'dues', 800);
    }
    
    // Update balance indicator if it affects current user
    if (newData?.member_id === currentUser?.member_id || oldData?.member_id === currentUser?.member_id) {
        debounceRefresh(() => updateEntryStatusIndicator(), 'status-indicator', 1000);
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
    const activePage = document.querySelector('.page-content:not(.hidden)');
    if (!activePage) return null;
    return activePage.id.replace('Page', '');
}

function updateConnectionStatus(status) {
    const statusEl = document.getElementById('realtimeStatus');
    if (!statusEl) return;
    
    if (status === 'SUBSCRIBED') {
        statusEl.textContent = '🟢 Live';
        statusEl.className = 'realtime-status connected';
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        statusEl.textContent = '🔴 Offline';
        statusEl.className = 'realtime-status disconnected';
    } else if (status === 'CLOSED') {
        statusEl.textContent = '⚫ Disconnected';
        statusEl.className = 'realtime-status disconnected';
    }
}

// ============================================
// VISIBILITY & LIFECYCLE MANAGEMENT
// ============================================

// Pause/Resume real-time when tab visibility changes
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log("⏸️ Tab hidden - keeping realtime active but pausing UI updates");
        // Keep realtime channels active but pause status indicator
        if (statusCycleInterval) {
            clearInterval(statusCycleInterval);
            statusCycleInterval = null;
        }
    } else {
        console.log("▶️ Tab visible - resuming UI updates");
        updateEntryStatusIndicator();
        checkGlobalBalanceWarning();
        
        // Refresh current page to catch up on any missed updates
        const activePage = getActivePage();
        if (activePage) {
            console.log("🔄 Refreshing", activePage, "after tab became visible");
            debounceRefresh(() => loadPageData(activePage), 'visibility-refresh', 500);
        }
    }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    console.log("🧹 Cleaning up realtime connections");
    cleanupRealtimeChannels();
    if (statusCycleInterval) {
        clearInterval(statusCycleInterval);
    }
});

// Reconnect if connection is lost
window.addEventListener('online', () => {
    console.log("🌐 Network reconnected - reinitializing realtime");
    showNotification("Connection restored", "success");
    initRealtimeSync();
});

window.addEventListener('offline', () => {
    console.log("📡 Network lost");
    showNotification("Connection lost - changes won't sync", "warning");
});



// Optional: Keep this as an alias in case you already changed some calls
const formatDateTime = formatDate;


  function showNotification(message, type = 'info') {
    const container = document.getElementById('toast-container');
    
    // Create Toast Element
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    // Determine Icon
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';

    // Set Content
    toast.innerHTML = `
        <div class="toast-icon">${icon}</div>
        <div class="toast-msg">${message}</div>
    `;

    // Add to DOM
    container.appendChild(toast);

    // Click to dismiss immediately
    toast.addEventListener('click', () => {
        removeToast(toast);
    });

    // Auto dismiss after 3 seconds
    setTimeout(() => {
        removeToast(toast);
    }, 2000);
}
function removeToast(toastElement) {
    toastElement.classList.add('hide');
    // Force removal after CSS transition time (300ms)
    setTimeout(() => {
        if (toastElement.parentNode) toastElement.remove();
    }, 300);
}

    // ============================================
    // AUTHENTICATION
    // ============================================
    


    document.getElementById('logoutBtn').addEventListener('click', () => {
        currentUser = null;
        localStorage.removeItem('mealcal_user');
        hideApp();
    });

 function showApp() {
    document.getElementById('authPage').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    
    document.body.style.overflow = "auto";
    document.documentElement.style.overflow = "auto";
    
    // --- UI SECURITY: HIDE/SHOW MENU ITEM ---
    const adminBtn = document.getElementById('adminMenuItem');
    if (adminBtn) {
        if (currentUser.role === 'admin' || currentUser.role === 'manager') {
            adminBtn.style.display = 'block'; // Show for Admin/Manager
        } else {
            adminBtn.style.display = 'none';  // Hide for everyone else
        }
    }
    
    initializeApp();
}

    function hideApp() {
        document.getElementById('authPage').classList.remove('hidden');
        document.getElementById('mainApp').classList.add('hidden');
        document.getElementById('loginForm').reset();
        initLoginPage(); // Reload dropdown
    }

    // Check for saved session
// Check for saved session & Load Dropdown
window.addEventListener('DOMContentLoaded', () => {
    // Start the new Auth System
    initAuth();
    
    // NEW: Load the users into the login dropdown
    loadLoginUserDropdown(); 
});
// ==========================================
// EXPENSE APPROVAL HANDLER (GLOBAL)
// ==========================================

// Explicitly attach to 'window' to ensure HTML buttons can find it
// Attach to window so HTML onClick works
window.handleExpenseApproval = async function(expenseId, newStatus) {
    const userRole = currentUser?.role;
    if (userRole !== 'admin' && userRole !== 'manager') {
        showNotification("Permission Denied", "error");
        return; 
    }

    // Change button text to indicate processing
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = "...";
    btn.disabled = true;

    try {
        // 1. Update Database
        if (newStatus === 'rejected') {
            // Option A: Delete it entirely
            const { error } = await supabase.from('expenses').delete().eq('id', expenseId);
            if (error) throw error;
        } else {
            // Option B: Approve it
            const { error } = await supabase
                .from('expenses')
                .update({ status: 'approved' })
                .eq('id', expenseId);
            if (error) throw error;
        }

        // 2. Fetch details for logging (Optional but good for UX)
        // We can skip fetching if we just want speed, but logging is nice.
        const actorName = currentUser.name || "Admin";
        const actionLabel = newStatus === 'approved' ? 'APPROVED' : 'REJECTED';
        
        await logActivity(
            `Expense Request ${actionLabel} by ${actorName}`, 
            'expense'
        );

        showNotification(`Expense ${newStatus} successfully`, 'success');

        // 3. Refresh Data
        await loadExpenses(); 
        await loadDashboard(); // Update totals

    } catch (err) {
        console.error('Approval Error:', err);
        showNotification(`Failed: ${err.message}`, 'error');
        btn.textContent = originalText;
        btn.disabled = false;
    }
};




window.handleDepositApproval = async function(depositId) {
    if (!confirm("Approve this deposit? This will apply the balance and trigger due settlements.")) return;
    
    const btn = event.target;
    btn.disabled = true;

    try {
        // 1. Get the pending deposit details
        const { data: dep, error: fetchErr } = await supabase
            .from('deposits')
            .select('*')
            .eq('id', depositId)
            .single();
        
        if (fetchErr) throw fetchErr;

        // 2. Delete the pending record (to avoid duplicates, or update status)
        // We update status to 'approved' and THEN run settlement logic
        const { error: updateErr } = await supabase
            .from('deposits')
            .update({ status: 'approved' })
            .eq('id', depositId);
        
        if (updateErr) throw updateErr;

        // 3. Run the Settlement Logic (Crucial!)
        // Since it's already in the DB as 'approved' now, we just need to 
        // trigger the settlement portion of your existing logic.
        // We reuse your client-side settlement function but modify it slightly 
        // OR just call it. For simplicity, we manually run the settlement part:
        
        await logActivity(`Deposit Approved: ${formatCurrency(dep.amount)} for member ID ${dep.member_id}`, 'deposit');
        
        // Refresh page - the settlement logic should ideally be a separate function 
        // but for now, we will re-run the "Approved" flow
        showNotification("Deposit Approved!", "success");
        refreshCurrentPage();

    } catch (err) {
        console.error(err);
        showNotification("Approval failed", "error");
    }
};

window.handleDepositRejection = async function(depositId) {
    if (!confirm("Reject and delete this request?")) return;

    try {
        const { error } = await supabase.from('deposits').delete().eq('id', depositId);
        if (error) throw error;
        showNotification("Request Rejected", "warning");
        refreshCurrentPage();
    } catch (err) {
        showNotification("Error", "error");
    }
};


window.handleDepositAction = async function(depositId, action) {
    // --- SECURITY CHECK ---
    if (currentUser?.role !== 'admin' && currentUser?.role !== 'manager') {
        showNotification("Permission Denied", "error");
        return;
    }
    console.log(`Action: ${action} triggered for ID: ${depositId}`);
    
    // Disable the button to prevent double-clicks
    const btn = event.target;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "...";

    try {
        if (action === 'approve') {
            // 1. Fetch the data of the pending request
            const { data: dep, error: fError } = await supabase
                .from('deposits')
                .select('*')
                .eq('id', depositId)
                .single();

            if (fError || !dep) {
                console.error("Fetch Error:", fError);
                throw new Error("Could not find the pending request.");
            }

            console.log("Pending data found. Attempting to delete request row...");

            // 2. DELETE the pending record FIRST. 
            // If this fails, we stop (prevents duplicates).
            const { error: delError } = await supabase
                .from('deposits')
                .delete()
                .eq('id', depositId);
            
            if (delError) {
                console.error("Delete Error:", delError);
                throw new Error("Permission denied or database error during deletion.");
            }

            console.log("Pending request deleted. Now processing official settlement...");

            // 3. Process the NEW official deposit
            // We pass status: 'approved' explicitly to ensure it hits the history filter
            await processDepositWithClientSideSettlement(
                dep.member_id, 
                dep.cycle_id, 
                dep.amount, 
                dep.label || 'Deposit', 
                dep.notes
            );


            
            const actorName = currentUser.name || "Unknown";
    const actorRole = currentUser.role === 'manager' ? 'Manager' : 'Admin';

    // LOG THE APPROVAL ACT
    await logActivity(
        `Deposit Approved: ${dep.members.name}'s request for ${formatCurrency(dep.amount)} was approved by ${actorRole} (${actorName})`, 
        'deposit'
    );
    showNotification("Request Approved", "success");



        } else if (action === 'reject') {
            const { error: delError } = await supabase
                .from('deposits')
                .delete()
                .eq('id', depositId);
            
            if (delError) throw delError;
            showNotification("Request Rejected", "warning");
        }
        
        // 4. Force UI update
        console.log("Refreshing UI...");
        await loadDeposits(); 
        if (typeof loadDashboard === 'function') loadDashboard();

    } catch (err) {
        console.error("CRITICAL ERROR in handleDepositAction:", err.message);
        showNotification(err.message, "error");
        btn.disabled = false;
        btn.textContent = originalText;
    }
};

async function initializeApp() {
    const progress = document.getElementById('load-progress');
    const setProgress = (p) => { if(progress) progress.style.width = p + '%'; };
function updateRestrictedUI() {
    const badge = document.getElementById('lockTimeDisplay');
    if (!badge || !appConfig.lock_time_start) return;

    const now = new Date();
    const [sH, sM] = appConfig.lock_time_start.split(':').map(Number);
    const [eH, eM] = appConfig.lock_time_end.split(':').map(Number);
    
    const start = new Date(); start.setHours(sH, sM, 0);
    const end = new Date(); end.setHours(eH, eM, 0);

    const isLocked = now >= start && now <= end;

    if (isLocked) {
        badge.classList.add('is-restricted');
        badge.innerHTML = `<span class="dot"></span> RESTRICTED NOW: ${convertTo12Hour(appConfig.lock_time_start)} - ${convertTo12Hour(appConfig.lock_time_end)}`;
    } else {
        badge.classList.remove('is-restricted');
        badge.innerHTML = `<span class="dot"></span> Restricted: ${convertTo12Hour(appConfig.lock_time_start)} - ${convertTo12Hour(appConfig.lock_time_end)}`;
    }
}

// Call it once and set interval
updateRestrictedUI();
setInterval(updateRestrictedUI, 30000); // Check every 30 seconds




    try {
        // Step 1: Initialize DB connection
        setProgress(20);
        await loadCycles();
        
        // Step 2: Load Config and Members
        setProgress(40);
        await loadAppConfig();
        await loadMembers();

        initHeader();
        initNotifications();

        // Step 3: Priority Data Load (Dashboard)
        setProgress(70);
        await loadPageData('dashboard');
        
        // Finalize internal settings
        updateEntryStatusIndicator();
        initRealtimeSync();
        setProgress(100);

             // Final Progress
        const progress = document.getElementById('load-progress');
        if(progress) progress.style.width = '100%';

        // --- HIDE SPLASH ---
        setTimeout(() => {
            hideSplash();
        }, 1000); // Small delay to let the animation be seen

        // --- COORDINATED FADE OUT ---
        // We wait for the animation to feel "complete" (approx 1.5 - 2 seconds total)
        setTimeout(() => {
            const loader = document.getElementById('initial-loader');
            if (loader) {
                loader.classList.add('splash-hidden');
                
                // Remove from DOM to keep it light
                setTimeout(() => loader.remove(), 800);
            }
        }, 1200); // Adjust this delay based on your video length

        // Background loading begins after the app is visible
        setTimeout(() => preLoadAllPages(), 2000);
        
    } catch (err) {
        console.error("Critical Init Error:", err);
        const splashText = document.querySelector('.splash-text');
        if(splashText) splashText.textContent = "Connection Error. Please check internet.";
        if(progress) progress.style.background = "var(--danger-color)";
    }
}

async function preLoadAllPages() {
    // Standard pages for everyone
    const pages = ['profile', 'tracker', 'summary', 'expenses', 'deposits'];

    // Only preload Admin for Admins/Managers
    if (currentUser.role === 'admin' || currentUser.role === 'manager') {
        pages.push('admin');
    }

    for (const page of pages) {
        await loadPageData(page);
    }
    console.log("✅ Pages pre-loaded.");
}

function loadPageData(pageName) {
    // If it's already loaded, we only refresh if the user is actually LOOKING at the page
    // This allows background loading to happen once, but manual refreshes still work.
    const isVisible = !document.getElementById(pageName + 'Page').classList.contains('hidden');
    
    if (pageLoaded[pageName] && !isVisible) {
        return; 
    }

    switch(pageName) {
        case 'dashboard':
            // Returning the promise so initializeApp can await it
            return loadDashboard();
        case 'profile':
            // Combined profile and scheduler into one flow
            return Promise.all([loadProfile(), loadScheduler()]);
        case 'tracker':
            return Promise.all([loadMasterTracker(), loadWeeklyMenuEditor()]);
        case 'summary':
            return loadSummary();
        case 'expenses':
            return loadExpenses();
        case 'deposits':
            return loadDeposits();
        case 'admin':
            return loadAdmin();
    }

    pageLoaded[pageName] = true;
}

// --- SPLASH CONTROL HELPERS ---

function hideSplash(delay = 800) {
    const loader = document.getElementById('initial-loader');
    if (loader) {
        setTimeout(() => {
            loader.classList.add('splash-hidden');
        }, delay);
    }
}

function showSplash(text = "Preparing your kitchen...") {
    const loader = document.getElementById('initial-loader');
    const splashText = document.querySelector('.splash-text');
    const progress = document.getElementById('load-progress');
    
    if (loader) {
        if(splashText) splashText.textContent = text;
        if(progress) progress.style.width = '0%';
        loader.classList.remove('splash-hidden');
    }
}
    // Add Handler for Admin Settings Form
document.getElementById('adminSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const start = document.getElementById('settingLockTime').value;
    const end = document.getElementById('settingLockTimeEnd').value;
    const autoTime = document.getElementById('settingAutoTime').value;
    
    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
        const { error } = await supabase.from('app_config').upsert([
            { key_name: 'lock_time_start', value_text: start },
            { key_name: 'lock_time_end', value_text: end },
            { key_name: 'auto_entry_time', value_text: autoTime }
        ], { onConflict: 'key_name' });

        if (error) throw error;

        appConfig.lock_time_start = start;
        appConfig.lock_time_end = end;
        appConfig.auto_entry_time = autoTime;
        
        const actor = currentUser.members ? currentUser.members.name : "Admin";
        // LOG SETTINGS CHANGE
        await logActivity(`System Config: Bazar lock times and auto-entry schedule were updated by ${actor}`, 'other');

        showNotification("Settings saved successfully!", "success");
        loadScheduler();
    } catch (err) {
        showNotification("Failed to save settings", "error");
    } finally {
        btn.textContent = "Save Settings";
        btn.disabled = false;
    }
});



// Centralized Logic for "Active Session Date"
// Ensures consistency across Profile, Summary, and Dashboard
// Centralized Logic for "Active Session Date" (Timezone Safe)
async function getActiveSessionDate() {
    const today = new Date();
    // Force local date string
    const todayStr = toLocalISO(today);

    try {
        // Check if bazar for today is already done
        const { data: log } = await supabase
            .from('system_logs')
            .select('id')
            .eq('log_date', todayStr)
            .maybeSingle();

        let sessionDate = new Date(today);
        if (log) {
            // If today's automation ran, the "Active" bazar is now tomorrow's
            sessionDate.setDate(today.getDate() + 1);
        }
        return sessionDate;
    } catch (err) {
        return new Date(); 
    }
}

// Global Config
let appConfig = {
    lock_time_start: '17:00',
    lock_time_end: '19:00',
    auto_entry_time: '18:30' // Default
};

async function loadAppConfig() {
    try {
        const { data, error } = await supabase.from('app_config').select('*');
        if (data) {
            data.forEach(item => {
                appConfig[item.key_name] = item.value_text;
            });
        }
        
        // Update Admin UI inputs
        const startInput = document.getElementById('settingLockTime');
        const endInput = document.getElementById('settingLockTimeEnd');
        if(startInput) startInput.value = appConfig.lock_time_start;
        if(endInput) endInput.value = appConfig.lock_time_end;


        const autoInput = document.getElementById('settingAutoTime');
    if(autoInput) autoInput.value = appConfig.auto_entry_time;

        
        // Update Profile Display
        const lockDisplay = document.getElementById('lockTimeDisplay');
        if(lockDisplay) {
            lockDisplay.textContent = `Restricted: ${convertTo12Hour(appConfig.lock_time_start)} - ${convertTo12Hour(appConfig.lock_time_end)}`;
        }
        
    } catch (err) {
        console.error("Config Load Error", err);
    }
}

// Admin Form Saver
// Admin Form Saver
document.getElementById('adminSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // 1. Get Values
    const start = document.getElementById('settingLockTime').value;
    const end = document.getElementById('settingLockTimeEnd').value;
    const autoTime = document.getElementById('settingAutoTime').value; // <--- Make sure this ID exists in HTML
    
    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
        // 2. Upsert All 3 Settings
        const { error } = await supabase.from('app_config').upsert([
            { key_name: 'lock_time_start', value_text: start },
            { key_name: 'lock_time_end', value_text: end },
            { key_name: 'auto_entry_time', value_text: autoTime } // <--- CRITICAL FIX
        ], { onConflict: 'key_name' });

        if (error) throw error;

        // 3. Update Local Config State
        appConfig.lock_time_start = start;
        appConfig.lock_time_end = end;
        appConfig.auto_entry_time = autoTime;
        
        // 4. Update UI
        const lockDisplay = document.getElementById('lockTimeDisplay');
        if(lockDisplay) lockDisplay.textContent = `Restricted: ${convertTo12Hour(start)} - ${convertTo12Hour(end)}`;
        
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
    if(!timeStr) return "";
    const [hour, min] = timeStr.split(':');
    const h = parseInt(hour);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${min} ${ampm}`;
}


/**
 * Checks if a specific meal slot is locked based on Bazar Time.
 * Logic: A "Bazar Session" locks Today's Night and Tomorrow's Day.
 */
function isMealLocked(dateString, mealType) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // 1. Determine "Session Date" (The date the Bazar happens)
    // Night Meal (e.g. 8th Night) -> Bazar is 8th.
    // Day Meal (e.g. 9th Day) -> Bazar is 8th (Previous Day).
    
    let sessionDateStr = dateString;
    if (mealType === 'day') {
        const d = new Date(dateString);
        d.setDate(d.getDate() - 1); // Subtract 1 day
        sessionDateStr = d.toISOString().split('T')[0];
    }

    // 2. Past Session Logic
    // If the bazar day is in the past, it's definitely locked (History).
    if (sessionDateStr < todayStr) return true;

    // 3. Future Session Logic
    // If bazar is tomorrow or later, it's Open.
    if (sessionDateStr > todayStr) return false;

    // 4. TODAY'S Session Logic (sessionDateStr === todayStr)
    // We are on the day of the Bazar. Check the Time Range.
    
    // Parse Config Times
    const [sH, sM] = appConfig.lock_time_start.split(':').map(Number);
    const [eH, eM] = appConfig.lock_time_end.split(':').map(Number);
    
    const startTime = new Date();
    startTime.setHours(sH, sM, 0, 0);
    
    const endTime = new Date();
    endTime.setHours(eH, eM, 0, 0); // e.g., 19:00:00

    // Range Logic: Locked ONLY if Start <= Now <= End
    if (now >= startTime && now <= endTime) {
        return true; // Locked inside range
    }

    return false; // Open before 5pm, Open after 7pm
}


async function loadScheduler() {
    if (!currentUser.member_id || !currentCycleId) return;
    
    const container = document.getElementById('schedulerList');
    
    // 1. CACHE CHECK: If cards exist and we aren't forcing a reload, skip.
    // This prevents the scheduler from re-rendering when you switch tabs.
    if (container.querySelector('.scheduler-card') && pageLoaded.profile) {
        return; 
    }

    // 2. Only show loading text if the container is empty.
    if (!container.innerHTML || container.innerHTML.includes('loading')) {
        container.innerHTML = '<div class="loading">Syncing your schedule...</div>';
    }

    try {
        // Fetch Member Defaults
        const { data: memberData } = await supabase
            .from('members')
            .select('default_day_on, default_night_on')
            .eq('id', currentUser.member_id)
            .maybeSingle();

        if (memberData) updateDefaultButtons(memberData);
        
        const defDay = memberData?.default_day_on || false;
        const defNight = memberData?.default_night_on || false;

        // Calculate 8-day date range (Today + next 7 days)
        const startDate = await getActiveSessionDate();
        const dates = [];
        for(let i=0; i<=8; i++) { 
            const d = new Date(startDate);
            d.setDate(startDate.getDate() + i); 
            dates.push(toLocalISO(d));
        }

        // Fetch user's specific meal plans
        const { data: plans } = await supabase
            .from('meal_plans')
            .select('*')
            .eq('member_id', currentUser.member_id)
            .in('plan_date', dates);

        const planMap = {};
        plans?.forEach(p => planMap[p.plan_date] = p);

        // 3. BUILD HTML STRING (Avoids multiple DOM reflows/flickers)
        let newHTML = '';
        const fmt = (dStr) => {
            const d = parseLocalDate(dStr);
            return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        };

        for (let i = 0; i < 7; i++) {
            const dateSession = dates[i];
            const dateNextDay = dates[i+1];
            
            const sessionLabel = fmt(dateSession);
            const nextDayLabel = fmt(dateNextDay);
            const isFirstCard = (i === 0);
            
            const nightActive = planMap[dateSession] ? planMap[dateSession].night_count > 0 : defNight;
            const dayActive = planMap[dateNextDay] ? planMap[dateNextDay].day_count > 0 : defDay;

          newHTML += `
    <div class="scheduler-card ${isFirstCard ? 'is-today' : ''}">
        <div class="sched-date-main">${sessionLabel}</div>
        <div class="sched-sub-label">${isFirstCard ? 'ACTIVE SESSION' : 'UPCOMING'}</div>
        
        <div class="sched-actions">
            <button class="sched-btn night-btn ${nightActive ? 'active' : ''}" 
                onclick="toggleSchedulerPlan('${dateSession}', 'night', this)">
                <span class="status-text">${nightActive ? 'ON' : 'OFF'}</span>
                <span class="btn-label">🌙 Night</span>
            </button>
            
            <button class="sched-btn day-btn ${dayActive ? 'active' : ''}" 
                onclick="toggleSchedulerPlan('${dateNextDay}', 'day', this)">
                <span class="status-text">${dayActive ? 'ON' : 'OFF'}</span>
                <span class="btn-label">🌞 Day</span>
            </button>
        </div>
    </div>`;
        }
        
        // 4. Update the DOM only once
        container.innerHTML = newHTML;

    } catch (err) {
        console.error("Scheduler Error:", err);
        container.innerHTML = '<div class="loading" style="color:red">Error loading schedule</div>';
    }
}


// Function triggered by clicking scheduler buttons
// Function triggered by clicking scheduler buttons (Profile Page)
async function toggleSchedulerPlan(date, type, btnElement) {
    // 1. IMMEDIATE UI UPDATE (Optimistic)
    const statusLabel = btnElement.querySelector('.status-text');
    const wasActive = btnElement.classList.contains('active');
    
    // Flip classes and text immediately
    if (wasActive) {
        btnElement.classList.remove('active');
        if (statusLabel) statusLabel.textContent = 'OFF';
    } else {
        btnElement.classList.add('active');
        if (statusLabel) statusLabel.textContent = 'ON';
    }

    const newCount = wasActive ? 0 : 1;

    try {
        // 2. DATABASE SYNC
        const { data: existing } = await supabase
            .from('meal_plans')
            .select('*')
            .eq('member_id', currentUser.member_id)
            .eq('plan_date', date)
            .maybeSingle();

        let updateData = {
            member_id: currentUser.member_id,
            plan_date: date,
            day_count: existing ? existing.day_count : 0,
            night_count: existing ? existing.night_count : 0
        };

        if (type === 'day') updateData.day_count = newCount;
        else updateData.night_count = newCount;

        const { error } = await supabase.from('meal_plans').upsert(updateData, { onConflict: 'member_id, plan_date' });
        if (error) throw error;

        // 3. LOG ACTIVITY (New Addition)
        const actorName = currentUser.name || "User";
        const actionText = newCount > 0 ? "turned ON" : "turned OFF";
        const typeLabel = type.charAt(0).toUpperCase() + type.slice(1); // "Day" or "Night"
        
        // Format date to look nice (e.g., "12 Jan")
        const dateObj = new Date(date);
        const niceDate = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

        // Message: "Ayan turned ON his 12 Jan Night meal"
        const logMsg = `${actorName} ${actionText} their ${niceDate} ${typeLabel} meal`;
        
        await logActivity(logMsg, 'meal');

    } catch (err) {
        console.error("Plan update failed", err);
        showNotification("Failed to save plan", "error");
        
        // REVERT UI on error
        btnElement.classList.toggle('active', wasActive);
        if (statusLabel) statusLabel.textContent = wasActive ? 'ON' : 'OFF';
    }
}


// --- Update loadMasterTracker ---
async function loadMasterTracker() {
    if (!currentCycleId) return;
    
    const table = document.getElementById('masterMatrixTable');
    if (!table) return;

    try {
        const cycle = allCycles.find(c => c.id == currentCycleId);
        const { data: meals } = await supabase.from('meals').select('*').eq('cycle_id', currentCycleId);
        
        const matrixData = {};
        meals?.forEach(m => {
            if (!matrixData[m.meal_date]) matrixData[m.meal_date] = {};
            matrixData[m.meal_date][m.member_id] = { d: m.day_count, n: m.night_count };
        });

        let currentIter = parseLocalDate(cycle.start_date);
        let endIter = parseLocalDate(cycle.end_date);
        const todayStr = toLocalISO(new Date());

        // 1. Generate Header Row
        let headerHTML = `
            <thead>
                <tr>
                    <th>BAZAR</th>
                    ${allMembers.map(m => `<th>${m.name.split(' ')[0]}</th>`).join('')}
                </tr>
            </thead>`;


        // 2. Generate Body Rows
        let bodyHTML = '<tbody>';
        while (currentIter.getTime() <= endIter.getTime()) {
            const dateSessionStr = toLocalISO(currentIter);
            const dNext = new Date(currentIter);
            dNext.setDate(currentIter.getDate() + 1);
            const dateNextStr = toLocalISO(dNext);

            const displayDate = currentIter.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
            const isTodayRow = (dateSessionStr === todayStr);

            bodyHTML += `<tr ${isTodayRow ? 'style="background: #f0f9ff;"' : ''}>
                <td>${displayDate}</td>
                ${allMembers.map(m => {
                    const nVal = matrixData[dateSessionStr]?.[m.id]?.n || 0;
                    const dVal = matrixData[dateNextStr]?.[m.id]?.d || 0;
                    return `
                        <td>
                            <div class="cell-split-premium" onclick="openMealModal('${m.id}', '${dateSessionStr}', ${nVal}, ${dVal})">
                                <div class="cell-val-half night ${nVal > 0 ? 'active' : 'zero'}">${nVal > 0 ? nVal : '-'}</div>
                                <div class="cell-val-half ${dVal > 0 ? 'active' : 'zero'}">${dVal > 0 ? dVal : '-'}</div>
                            </div>
                        </td>`;
                }).join('')}
            </tr>`;
            
            currentIter.setDate(currentIter.getDate() + 1);
        }
        bodyHTML += '</tbody>';

        // 3. Update Table
        table.innerHTML = headerHTML + bodyHTML;
        pageLoaded.tracker = true;
    } catch (err) {
        console.error("Tracker Sync Error:", err);
    }
}


// --- Update loadWeeklyMenuEditor ---
async function loadWeeklyMenuEditor() {
    const tbody = document.getElementById('weeklyMenuBody');
    const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');
    
    try {
        const { data, error } = await supabase.from('weekly_menus').select('*').order('day_index', { ascending: true });
        if (error) throw error;

        const order = [6, 0, 1, 2, 3, 4, 5]; 
        const sortedData = order.map(idx => data.find(d => d.day_index === idx));

        tbody.innerHTML = sortedData.map(day => `
            <tr>
                <td class="menu-day-label">${day.day_name}</td>
                <td style="padding-right: 5px;">
                    <input type="text" id="night-${day.day_index}" class="menu-input-pill" 
                        value="${day.night_menu || ''}" ${!isAdmin ? 'disabled' : ''} 
                        onchange="saveDayMenu(${day.day_index})" placeholder="Night...">
                </td>
                <td>
                    <input type="text" id="day-${day.day_index}" class="menu-input-pill" 
                        value="${day.day_menu || ''}" ${!isAdmin ? 'disabled' : ''} 
                        onchange="saveDayMenu(${day.day_index})" placeholder="Day...">
                </td>
            </tr>
        `).join('');
    } catch (err) { console.error(err); }
}


function initHeader() {
    // 1. Set User Info
    if (currentUser) {
        // Use the 'name' property defined in handleUserSession
        const displayName = currentUser.name || "User";
        const role = currentUser.role || 'user';
        
        // Update header with format: Name (ROLE)
        document.getElementById('headerUserName').textContent = `${displayName} (${role.toUpperCase()})`;
        
        // Clear old secondary role field
        const subRole = document.getElementById('headerUserRole');
        if(subRole) subRole.textContent = "";
    }

    // 2. Start Clock
    updateClock();
    if (!window.clockInterval) {
        window.clockInterval = setInterval(updateClock, 1000);
    }

    // 3. Update Cycle Name Badge
    const cycleSelect = document.getElementById('cycleSelect');
    if (cycleSelect && cycleSelect.options[cycleSelect.selectedIndex]) {
        document.getElementById('headerCycleName').textContent = cycleSelect.options[cycleSelect.selectedIndex].text;
    }
}


function updateClock() {
    const now = new Date();
    
    // Time
    const timeString = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('clockTime').textContent = timeString;

    // Date
    const dateString = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    document.getElementById('clockDate').textContent = dateString;
}


// ============================================
// NOTIFICATION LOGIC (FIXED)
// ============================================

let allNotifications = [];
let currentNotifFilter = 'all';

function initNotifications() {
    // 1. Attach Bell Click Listener
    const bellBtn = document.getElementById('notifBellBtn');
    const panel = document.getElementById('notifPanel');
    const closeBtn = document.getElementById('closeNotifPanel');

    // Remove old listeners to prevent duplicates (cloning trick)
    const newBell = bellBtn.cloneNode(true);
    bellBtn.parentNode.replaceChild(newBell, bellBtn);
    
    const newClose = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newClose, closeBtn);

    // Re-attach listeners
// Inside initNotifications() ...

    document.getElementById('notifBellBtn').addEventListener('click', (e) => {
        e.stopPropagation(); // Stop click from bubbling

        // 1. LOG & FORCE REFRESH (Bypassing Cooldown)
        console.log("🔄 Refreshing view: NOTIFICATIONS");
        
        // Show loading state briefly in the list if you want, or just fetch
        const container = document.getElementById('notifListContainer');
        if(container.innerHTML.trim() === '') container.innerHTML = '<div class="loading">Syncing...</div>';
        
        loadNotifications().then(() => {
            console.log("✅ Notifications Synced");
        });

        // 2. TOGGLE UI
        document.getElementById('notifPanel').classList.toggle('active');
        
        // 3. CLEAR BADGE
        document.getElementById('notifBadge').classList.add('hidden');
        // Reset badge count logic if you track it in a variable
        document.getElementById('notifBadge').textContent = '0';
    });

    document.getElementById('closeNotifPanel').addEventListener('click', () => {
        document.getElementById('notifPanel').classList.remove('active');
    });

    // 2. Filter Clicks
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            e.target.classList.add('active');
            currentNotifFilter = e.target.getAttribute('data-filter');
            renderNotifications();
        });
    });

    // 3. Close panel when clicking outside
    document.addEventListener('click', (e) => {
        const p = document.getElementById('notifPanel');
        const b = document.getElementById('notifBellBtn');
        if (p.classList.contains('active') && !p.contains(e.target) && !b.contains(e.target)) {
            p.classList.remove('active');
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
            .from('notifications')
            .select(`
                id, 
                message, 
                type, 
                created_at, 
                member_id,
                members (
                    name, 
                    role
                )
            `)
            .eq('cycle_id', targetCycleId)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;

        allNotifications = data || [];
        console.log("✅ Notifications loaded:", allNotifications.length);
        renderNotifications();
        
    } catch (err) {
        console.error('❌ Notification Fetch Error:', err);
        const container = document.getElementById('notifListContainer');
        if(container) container.innerHTML = `<div class="loading" style="color:red">Failed to load history.</div>`;
    }
}

function renderNotifications() {
    const container = document.getElementById('notifListContainer');
    if (!container) return;

    // Filter logic
    const filtered = allNotifications.filter(n => {
        if (currentNotifFilter === 'all') return true;
        if (currentNotifFilter === 'meal') return n.type && n.type.includes('meal');
        return n.type === currentNotifFilter;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:40px 20px; color:#aaa;">No history found for this cycle.</div>';
        return;
    }

    container.innerHTML = filtered.map(notif => {
        let typeClass = 'type-other';
        let icon = '⚙️';
        if (notif.type === 'deposit') { typeClass = 'type-deposit'; icon = '💰'; }
        if (notif.type === 'expense') { typeClass = 'type-expense'; icon = '🛒'; }
        if (notif.type && notif.type.includes('meal')) { typeClass = 'type-meal'; icon = '🍽️'; }

        const dateObj = new Date(notif.created_at);
        const displayTime = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + 
                          ' • ' + dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

// --- FIXED AUTHOR LOGIC IN renderNotifications ---
let authorMarkup = '<span style="color:var(--text-secondary)">System</span>';

if (notif.members) {
    const role = notif.members.role;
    const name = notif.members.name;

    if (role === 'admin') {
        authorMarkup = `<span style="color:var(--primary-color); font-weight:800;">Admin</span>`;
    } else if (role === 'manager') {
        // Show Manager + their name for clarity
        authorMarkup = `<span style="color:var(--secondary-color); font-weight:800;">Manager (${name.split(' ')[0]})</span>`;
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
    }).join('');
}




// Updated Log Activity (Uses member_id)
async function logActivity(message, type = 'info') {
    if (!currentCycleId) return;
    
    try {
        // Use the member_id from our currentUser object
        const actorMemberId = currentUser?.member_id;

        const { error } = await supabase
            .from('notifications')
            .insert({
                cycle_id: parseInt(currentCycleId),
                message: message,
                type: type,
                member_id: actorMemberId // This links the name/role to the log
            });

        if (error) throw error;
        
        // Refresh local view
        if (document.getElementById('notifPanel').classList.contains('active')) {
            loadNotifications();
        }
    } catch (err) {
        console.error('Logging Error:', err.message);
    }
}


// --- Deep Linking Action ---
function handleNotifClick(type) {
    document.getElementById('notifPanel').classList.remove('active');

    if (type === 'deposit') {
        navigateToPage('deposits');
    } else if (type === 'expense') {
        navigateToPage('expenses');
    } else if (type.includes('meal')) {
        navigateToPage('tracker');
    } else {
        navigateToPage('dashboard');
    }
}



// Helper to keep Dashboard synced
function updateDashboardActivity(data) {
    const container = document.getElementById('recentActivity');
    if (!container) return;
    
    const slice = data.slice(0, 10);
    if (slice.length === 0) {
        container.innerHTML = '<div class="loading">No recent activity</div>';
        return;
    }
    
    container.innerHTML = slice.map(notif => `
        <div class="list-item">
            <div class="list-item-info">
                <div class="list-item-title">${notif.message}</div>
                <div class="list-item-subtitle">${formatDateTime(notif.created_at)}</div>
            </div>
        </div>
    `).join('');
}




    async function loadCycles() {
    try {
        const { data, error } = await supabase
            .from('cycles')
            .select('*')
            .order('start_date', { ascending: false });

        if (error) throw error;

        allCycles = data || [];
        const cycleSelect = document.getElementById('cycleSelect');
        cycleSelect.innerHTML = '';

        if (allCycles.length === 0) {
            cycleSelect.innerHTML = '<option value="">No cycles available</option>';
            return;
        }

        // Locate this in your initialization or loadCycles
document.getElementById('cycleSelect').addEventListener('change', (e) => {
    currentCycleId = e.target.value;
    const selectedOption = e.target.options[e.target.selectedIndex];
    document.getElementById('headerCycleName').textContent = selectedOption.text;
    
    // ✅ Restart real-time for new cycle
    console.log("🔄 Cycle changed, restarting realtime for cycle:", currentCycleId);
    initRealtimeSync();
    
    refreshCurrentPage(); 
     updateEntryStatusIndicator();
    checkGlobalBalanceWarning();
});

        // FIND THE ACTIVE ONE OR FALLBACK TO THE NEWEST
        const activeCycle = allCycles.find(c => c.is_active === true) || allCycles[0];
        currentCycleId = activeCycle.id;

        allCycles.forEach(cycle => {
            const option = document.createElement('option');
            option.value = cycle.id;
            option.textContent = cycle.name;
            if (cycle.id === currentCycleId) {
                option.selected = true;
            }
            cycleSelect.appendChild(option);
        });

        // Update the header badge
        document.getElementById('headerCycleName').textContent = activeCycle.name;

    } catch (err) {
        console.error('Error loading cycles:', err);
    }
}
    async function loadMembers() {
        try {
            const { data, error } = await supabase
                .from('members')
                .select('*')
                .order('name');

            if (error) throw error;

            allMembers = data || [];
            populateMemberSelects();
        } catch (err) {
            console.error('Error loading members:', err);
        }
    }

 function populateMemberSelects() {
    const selects = ['trackerMemberSelect', 'expenseMember', 'depositMember', 'depositLogFilter'];

    selects.forEach(selectId => {
        const select = document.getElementById(selectId);
        if (!select) return;

        // Save current selection if refreshing
        const currentValue = select.value; 
        
        // Clear and add placeholder
        select.innerHTML = '';
        const defaultOption = document.createElement('option');
        defaultOption.value = "";
        defaultOption.textContent = "Select...";
        select.appendChild(defaultOption);
        
        // Populate Members
        allMembers.forEach(member => {
            const option = document.createElement('option');
            option.value = member.id;
            option.textContent = member.name;
            select.appendChild(option);
        });

        // --- SPECIFIC DEFAULTS LOGIC ---

        // 1. Expenses: Always default to Current User initially
        if (selectId === 'expenseMember' && currentUser.member_id) {
             select.value = currentUser.member_id;
        } 
        // 2. Deposits: Always default to Current User
        else if (selectId === 'depositMember' && currentUser.member_id) {
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
    
async function navigateToPage(pageName) {
    if (!pageName) return;

    // --- SECURITY CHECK ---
    // If trying to access Admin, check role immediately
    if (pageName === 'admin') {
        if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'manager')) {
            showNotification("⛔ Access Denied: Admin privileges required.", "error");
            // If they are currently on a different page, stay there. 
            // If they are nowhere (fresh load), send to dashboard.
            if (document.querySelector('.page-content:not(.hidden)') === null) {
                navigateToPage('dashboard');
            }
            return;
        }
    }

    // --- STANDARD NAVIGATION ---
    // Hide all pages
    document.querySelectorAll('.page-content').forEach(p => p.classList.add('hidden'));
    
    // Show target page
    const target = document.getElementById(pageName + 'Page');
    if (target) target.classList.remove('hidden');

    // Update Nav UI (Active State)
    document.querySelectorAll('.bottom-nav-link, .nav-link').forEach(link => {
        link.classList.toggle('active', link.getAttribute('data-page') === pageName);
    });

    // Load Data
    await loadPageData(pageName);

    // Auto-close sidebar on mobile
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if(sidebar) sidebar.classList.remove('mobile-active');
        if(overlay) overlay.classList.remove('active');
    }
}

// Ensure the Menu button (sidebar trigger) works
document.getElementById('mobileMenuBtn').addEventListener('click', (e) => {
    e.preventDefault();
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar.classList.add('mobile-active');
    overlay.classList.add('active');
});

function refreshCurrentPage() {
    // Find which page is active (has no 'hidden' class)
    const activePage = document.querySelector('.page-content:not(.hidden)');
    
    if (activePage) {
        const pageId = activePage.id.replace('Page', '');
        console.log(`🔄 Refreshing view: ${pageId}`);
        loadPageData(pageId);
        
        // Always refresh dashboard stats if on dashboard
        // (Because dashboard has multiple sub-components)
        if (pageId === 'dashboard') {
            loadDashboard();
            loadSystemStatus();
        }
    }
}
    // Setup navigation
    document.querySelectorAll('.nav-link, .bottom-nav-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const pageName = link.getAttribute('data-page');
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
        const [exp, meals, deps] = await Promise.all([
            supabase.from('expenses').select('amount').eq('cycle_id', currentCycleId).eq('status', 'approved'),
            supabase.from('meals').select('day_count, night_count').eq('cycle_id', currentCycleId),
            supabase.from('deposits').select('amount').eq('cycle_id', currentCycleId).neq('status', 'pending')
        ]);

        const totalExp = exp.data?.reduce((s, i) => s + i.amount, 0) || 0;
        const totalMeals = meals.data?.reduce((s, i) => s + (i.day_count + i.night_count), 0) || 0;
        const totalDep = deps.data?.reduce((s, i) => s + i.amount, 0) || 0;
        const rate = totalMeals ? totalExp / totalMeals : 0;
        const liquidity = totalDep - totalExp;

        // Update Text Stats
        document.getElementById('statMealRate').innerHTML = formatCurrency(rate);
        document.getElementById('statTotalExpense').innerHTML = formatCurrency(totalExp);
        document.getElementById('statTotalDeposit').innerHTML = formatCurrency(totalDep);

          // --- NEW: UPDATE TOTAL MEALS CARD ---
        // toBn() converts to Bengali digits. toFixed(1) keeps one decimal place (e.g., 50.5)
        const mealsEl = document.getElementById('statTotalMealsDisplay');
        if (mealsEl) {
            mealsEl.textContent = toBn(totalMeals.toFixed(1).replace(/\.0$/, '')); // Removes .0 if whole number
        }
        
        // ============================================
        // LIQUID CARD LOGIC (NEW)
        // ============================================
      // ============================================
// ENHANCED LIQUID CARD LOGIC
// ============================================
// ============================================
// VERTICAL METER CARD LOGIC - SIMPLE
// ============================================
const balEl = document.getElementById('statMessBalance');
const container = document.getElementById('messBalanceContainer');
const fillBar = document.getElementById('liquidFillBar');
const pill = document.getElementById('balanceStatusPill');
const percentEl = document.getElementById('liquidPercent');

// 1. Update Number
balEl.textContent = typeof toBn === 'function' 
    ? toBn(Math.round(liquidity).toLocaleString()) 
    : Math.round(liquidity).toLocaleString();

// 2. Calculate Percentage (0-10,000 range)
let percent = Math.max(0, Math.min(100, (liquidity / 10000) * 100));

// Minimum visibility for very low amounts
let visualPercent = liquidity <= 0 ? 3 : (percent < 5 ? 5 : percent);

// Update meter fill
fillBar.style.setProperty('--fill-percent', `${visualPercent}%`);

// Update percentage display
percentEl.textContent = `${Math.round(percent)}%`;

// 3. State styling
container.classList.remove('state-healthy-liquid', 'state-critical-liquid', 'state-empty-liquid');

if (liquidity >= 1000) {
    // Healthy
    container.classList.add('state-healthy-liquid');
    pill.textContent = 'HEALTHY';
    pill.style.color = '#047857';
    pill.style.background = '#d1fae5';
    pill.style.border = '1px solid #a7f3d0';
} else if (liquidity > 0) {
    // Low Funds
    container.classList.add('state-critical-liquid');
    pill.textContent = 'LOW FUNDS';
    pill.style.color = '#b91c1c';
    pill.style.background = '#fee2e2';
    pill.style.border = '1px solid #fecaca';
} else {
    // Deficit
    container.classList.add('state-critical-liquid');
    pill.textContent = 'DEFICIT';
    pill.style.color = '#7f1d1d';
    pill.style.background = '#fef2f2';
    pill.style.border = '1px solid #fecaca';
}

        updateDashboardMealPlan();
        loadSystemStatus();
        loadRecentActivity(); 
          updateDashboardBadges(); 
           updatePendingCounts();
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
                .from('deposits')
                .select('*', { count: 'exact', head: true })
                .eq('cycle_id', currentCycleId)
                .eq('status', 'pending'),
            
            supabase
                .from('expenses')
                .select('*', { count: 'exact', head: true })
                .eq('cycle_id', currentCycleId)
                .eq('status', 'pending')
        ]);

        // 2. Update UI
        toggleBadge('badgeDeposit', pendingDep.count);
        toggleBadge('badgeExpense', pendingExp.count);
        
        // 3. Optional: Update Bottom Nav Badges (If you want them there too)
        updateNavBadge('deposits', pendingDep.count);
        updateNavBadge('expenses', pendingExp.count);

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
                .from('deposits')
                .select('*', { count: 'exact', head: true }) // head:true means don't fetch data, just count
                .eq('cycle_id', currentCycleId)
                .eq('status', 'pending'),

            // Count Pending Expenses
            supabase
                .from('expenses')
                .select('*', { count: 'exact', head: true })
                .eq('cycle_id', currentCycleId)
                .eq('status', 'pending')
        ]);

        // Update UI
        toggleBadgeUI('badgeDeposit', depReq.count);
        toggleBadgeUI('badgeExpense', expReq.count);

    } catch (err) {
        console.error("Badge Sync Error:", err);
    }
}

// ==========================================
// BADGE NAVIGATION HANDLER
// ==========================================

async function navigateToPending(page, event) {
    // Prevent bubbling if the card itself has a click listener (optional safety)
    if(event) event.stopPropagation();

    // 1. Navigate to the page
    await navigateToPage(page);

    // 2. Determine target container ID
    let targetId = '';
    if (page === 'expenses') targetId = 'pendingExpensesCard';
    if (page === 'deposits') targetId = 'pendingDepositsCard';

    // 3. Scroll and Highlight
    setTimeout(() => {
        const el = document.getElementById(targetId);
        
        if (el && el.style.display !== 'none') {
            // Smooth Scroll to the pending box
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Visual Pulse Effect to show user "Here it is!"
            const originalTransform = el.style.transform;
            const originalShadow = el.style.boxShadow;
            
            el.style.transition = 'all 0.3s ease';
            el.style.transform = 'scale(1.02)';
            el.style.boxShadow = '0 0 0 4px rgba(245, 158, 11, 0.4)'; // Amber glow ring
            
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
        el.textContent = count > 99 ? '99+' : count;
        
        // Remove hidden class first
        el.classList.remove('hidden');
        
        // Use timeout to allow CSS transition to animate in
        setTimeout(() => {
            el.classList.add('active');
            // Make it pill-shaped if double digits
            if (count > 9) el.classList.add('wide');
            else el.classList.remove('wide');
        }, 10);
    } else {
        el.classList.remove('active');
        // Wait for fade out animation before hiding
        setTimeout(() => el.classList.add('hidden'), 400);
    }
}

// Helper to animate badge
function toggleBadge(elementId, count) {
    const el = document.getElementById(elementId);
    if (!el) return;

    if (count && count > 0) {
        el.textContent = count > 99 ? '99+' : count;
        el.classList.remove('hidden');
        // Small delay to allow 'display:block' to apply before adding 'active' for animation
        requestAnimationFrame(() => {
            el.classList.add('active');
            if(count > 9) el.classList.add('wide');
        });
    } else {
        el.classList.remove('active');
        // Wait for transition to finish before hiding
        setTimeout(() => el.classList.add('hidden'), 300);
    }
}

// Optional Helper: Add red dots to bottom nav icons
function updateNavBadge(pageName, count) {
    const navLink = document.querySelector(`.bottom-nav-link[data-page="${pageName}"]`);
    if(!navLink) return;
    
    // Check if dot exists, else create it
    let dot = navLink.querySelector('.nav-dot');
    if (!dot) {
        dot = document.createElement('div');
        dot.className = 'nav-dot';
        dot.style.cssText = 'position:absolute; top:8px; right:20px; width:8px; height:8px; background:#ef4444; border-radius:50%; border:1px solid white; display:none;';
        navLink.style.position = 'relative';
        navLink.appendChild(dot);
    }
    
    dot.style.display = count > 0 ? 'block' : 'none';
}


// --- Update loadRecentActivity for the new feed style ---
async function loadRecentActivity() {
    const container = document.getElementById('recentActivity');
    if (!container) return;

    try {
        const { data, error } = await supabase
            .from('notifications')
            .select('*')
            .eq('cycle_id', currentCycleId)
            .order('created_at', { ascending: false })
            .limit(8);

        if (error) throw error;

        if (!data || data.length === 0) {
            container.innerHTML = '<div style="font-size:11px; color:gray; text-align:center; padding:20px;">No recent activity found.</div>';
            return;
        }

        container.innerHTML = data.map(notif => {
            let icon = '🔔';
            if(notif.type === 'meal') icon = '🍽️';
            if(notif.type === 'deposit') icon = '💰';
            if(notif.type === 'expense') icon = '🛒';

            return `
            <div class="feed-item">
                <div class="feed-icon">${icon}</div>
                <div class="feed-content">
                    <div class="msg">${notif.message}</div>
                    <div class="time">${formatDate(notif.created_at)}</div>
                </div>
            </div>`;
        }).join('');

    } catch (err) {
        console.error('Activity Feed Error:', err);
    }
}

    // ============================================
    // PROFILE PAGE
    // ============================================
    
async function loadProfile() {
    if (!currentUser || !currentUser.member_id) return;
    if (!currentCycleId) return;

    try {
        const member = allMembers.find(m => m.id === currentUser.member_id);
        if (member) {
            const avatarCircle = document.getElementById('profileAvatar');
            avatarCircle.onclick = changeProfilePicture; 
            
            document.getElementById('profileName').textContent = member.name;
            document.getElementById('profileRoleDisplay').textContent = member.role || 'Member';
            
            if (member.avatar_url && member.avatar_url.trim() !== "") {
                avatarCircle.innerHTML = `
                    <img src="${member.avatar_url}" alt="Profile">
                    <div class="profile-status-online"></div>
                `;
                avatarCircle.classList.add('has-image');
            } else {
                const initials = member.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
                avatarCircle.innerHTML = `${initials}<div class="profile-status-online"></div>`;
                avatarCircle.classList.remove('has-image');
            }
        }

        // Fetch calculation data
        const [userMeals, userDeps, allExp, allMeals] = await Promise.all([
            supabase.from('meals').select('day_count, night_count').eq('member_id', currentUser.member_id).eq('cycle_id', currentCycleId),
            supabase.from('deposits').select('amount').eq('member_id', currentUser.member_id).eq('cycle_id', currentCycleId).neq('status', 'pending'),
            supabase.from('expenses').select('amount').eq('cycle_id', currentCycleId).eq('status', 'approved'),
            supabase.from('meals').select('day_count, night_count').eq('cycle_id', currentCycleId)
        ]);

        // Calculations
        const totalUserMeals = userMeals.data?.reduce((s, m) => s + (parseFloat(m.day_count) + parseFloat(m.night_count)), 0) || 0;
        const totalUserPaid = userDeps.data?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;
        const totalGlobalExp = allExp.data?.reduce((s, e) => s + parseFloat(e.amount), 0) || 0;
        const totalGlobalMeals = allMeals.data?.reduce((s, m) => s + (parseFloat(m.day_count) + parseFloat(m.night_count)), 0) || 1;
        
        const rate = totalGlobalMeals > 0 ? totalGlobalExp / totalGlobalMeals : 0;
        const currentBalance = totalUserPaid - (totalUserMeals * rate);

        // --- UI UPDATES (FIXED) ---

        // 1. Fix Total Meals: Update the text content + Convert to Bengali
        const mealsEl = document.getElementById('profileTotalMeals');
        if (mealsEl) {
            // toBn converts "15" to "১৫"
            mealsEl.textContent = toBn(totalUserMeals); 
        }

        // 2. Fix Total Paid: Convert to Bengali
        const depositEl = document.getElementById('profileTotalDeposit');
        if (depositEl) {
            depositEl.textContent = `৳${toBn(Math.round(totalUserPaid))}`;
        }

        // 3. Fix Main Wallet Balance: Use formatCurrency() for styling + Bengali
        const heroBal = document.getElementById('profileBalance');
        if (heroBal) {
            // Using innerHTML because formatCurrency returns <span> tags for styling
            heroBal.innerHTML = formatCurrency(currentBalance); 
        }

        // 4. Update Color States (Positive/Negative)
        const heroCard = document.getElementById('profileBalanceCard'); 
        
        if (currentBalance < 0) {
            if(heroCard) { heroCard.classList.add('status-neg'); heroCard.classList.remove('status-pos'); }
        } else {
            if(heroCard) { heroCard.classList.add('status-pos'); heroCard.classList.remove('status-neg'); }
        }

        // Cycle Name
        const cycleObj = allCycles.find(c => c.id == currentCycleId);
        document.getElementById('profileCycleName').textContent = cycleObj ? cycleObj.name : 'Unknown';

        await loadProfileDepositHistory();
        pageLoaded.profile = true; 
    } catch (err) {
        console.error('Error loading profile:', err);
    }
}

// Function to update the Avatar Link
async function changeProfilePicture() {
    // 1. Ask the user for the URL
    const currentUrl = allMembers.find(m => m.id === currentUser.member_id)?.avatar_url || "";
    const newUrl = prompt("Enter the direct link to your new profile picture:", currentUrl);

    // 2. If user didn't cancel and entered something (or cleared it)
    if (newUrl !== null) {
        try {
            // Show a loading notification
            showNotification("Updating photo...", "info");

            // 3. Update Supabase
            const { error } = await supabase
                .from('members')
                .update({ avatar_url: newUrl.trim() })
                .eq('id', currentUser.member_id);

            if (error) throw error;

            // 4. Update local state so UI reflects change immediately
            const memberIndex = allMembers.findIndex(m => m.id === currentUser.member_id);
            if (memberIndex !== -1) allMembers[memberIndex].avatar_url = newUrl.trim();

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
        const today = new Date().toISOString().split('T')[0];

        try {
            const { data } = await supabase
                .from('meals')
                .select('*')
                .eq('member_id', currentUser.member_id)
                .eq('meal_date', today)
                .maybeSingle();

            const dayCount = data?.day_count || 0;
            const nightCount = data?.night_count || 0;

            const dayToggle = document.getElementById('dayMealToggle');
            const nightToggle = document.getElementById('nightMealToggle');

            if (dayCount > 0) {
                dayToggle.classList.add('active');
                dayToggle.classList.remove('inactive');
                document.getElementById('dayMealStatus').textContent = 'ON';
            } else {
                dayToggle.classList.add('inactive');
                dayToggle.classList.remove('active');
                document.getElementById('dayMealStatus').textContent = 'OFF';
            }

            if (nightCount > 0) {
                nightToggle.classList.add('active');
                nightToggle.classList.remove('inactive');
                document.getElementById('nightMealStatus').textContent = 'ON';
            } else {
                nightToggle.classList.add('inactive');
                nightToggle.classList.remove('active');
                document.getElementById('nightMealStatus').textContent = 'OFF';
            }

        } catch (err) {
            console.error('Error loading meal status:', err);
        }
    }

    async function loadProfileDepositHistory() {
        if (!currentUser.member_id) return;
        try {
            const { data, error } = await supabase
                .from('deposits')
                .select('*')
                .eq('member_id', currentUser.member_id)
                .eq('cycle_id', currentCycleId)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const container = document.getElementById('profileDepositHistory');

            if (!data || data.length === 0) {
                container.innerHTML = '<div class="loading">No deposits yet</div>';
                return;
            }

            container.innerHTML = data.map(deposit => `
                <div class="list-item">
                    <div class="list-item-info">
                        <div class="list-item-title">${deposit.label || 'Deposit'}</div>
                       <div class="list-item-subtitle">${formatDateTime(deposit.created_at)}</div>
                    </div>
                    <div class="list-item-amount balance-positive">${formatCurrency(deposit.amount)}</div>
                </div>
            `).join('');

        } catch (err) {
            console.error('Error loading deposit history:', err);
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
    const member = allMembers.find(m => m.id === currentUser.member_id);
    if (!member) return;

    // 2. Determine new state (Toggle)
    let updates = {};
    if (type === 'day') {
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
            .from('members')
            .update(updates)
            .eq('id', currentUser.member_id);

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
    const dayBtn = document.getElementById('defDayBtn');
    const nightBtn = document.getElementById('defNightBtn');
    
    if (dayBtn) {
        dayBtn.className = `def-btn ${member.default_day_on ? 'active' : ''}`;
        dayBtn.textContent = `Default Day: ${member.default_day_on ? 'ON' : 'OFF'}`;
    }
    
    if (nightBtn) {
        nightBtn.className = `def-btn ${member.default_night_on ? 'active' : ''}`;
        nightBtn.textContent = `Default Night: ${member.default_night_on ? 'ON' : 'OFF'}`;
    }
}





   async function toggleMeal(mealType) {
    const today = new Date().toISOString().split('T')[0];

    try {
        const { data: existing } = await supabase
            .from('meals')
            .select('*')
            .eq('member_id', currentUser.member_id)
            .eq('meal_date', today)
            .maybeSingle();

        let dayCount = existing?.day_count || 0;
        let nightCount = existing?.night_count || 0;

        if (mealType === 'day') {
            dayCount = dayCount > 0 ? 0 : 1;
        } else {
            nightCount = nightCount > 0 ? 0 : 1;
        }

        if (existing) {
            await supabase
                .from('meals')
                .update({
                    day_count: dayCount,
                    night_count: nightCount,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existing.id);
        } else {
            await supabase
                .from('meals')
                .insert({
                    cycle_id: currentCycleId,
                    member_id: currentUser.member_id,
                    meal_date: today,
                    day_count: dayCount,
                    night_count: nightCount
                });
        }

        // --- CRUCIAL UPDATE HERE ---
        // We get the name of the person performing the action
        const actorName = currentUser.members ? currentUser.members.name : currentUser.username;
        const actionType = mealType === 'day' ? (dayCount > 0 ? 'ON' : 'OFF') : (nightCount > 0 ? 'ON' : 'OFF');
        
        await logActivity(
            `${actorName} turned ${mealType.toUpperCase()} meal ${actionType} for today`, 
            'meal' 
        );
        // ---------------------------

        await loadTodayMealStatus();
        showNotification('Meal status updated', 'success');

    } catch (err) {
        console.error('Error toggling meal:', err);
        showNotification('Failed to update meal status', 'error');
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
            const cycle = allCycles.find(c => c.id === currentCycleId);
            if (!cycle) return;

            const startDate = new Date(cycle.start_date);
            const endDate = new Date(cycle.end_date);
            
            // Fetch meals for this member and cycle
            const { data: meals } = await supabase
                .from('meals')
                .select('*')
                .eq('cycle_id', currentCycleId)
                .eq('member_id', memberId);

            const mealMap = {};
            meals?.forEach(meal => {
                mealMap[meal.meal_date] = meal;
            });

            const calendarGrid = document.getElementById('calendarGrid');
            calendarGrid.innerHTML = '';

            // Generate calendar days
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split('T')[0];
                const meal = mealMap[dateStr];
                const totalMeals = meal ? parseFloat(meal.day_count) + parseFloat(meal.night_count) : 0;

                const dayDiv = document.createElement('div');
                dayDiv.className = 'calendar-day' + (totalMeals > 0 ? ' has-meal' : '');
                dayDiv.innerHTML = `
                    <div class="calendar-day-number">${d.getDate()}</div>
                    <div class="calendar-day-meals">${totalMeals > 0 ? totalMeals.toFixed(1) : '-'}</div>
                `;

                // Only managers and admins can edit
                if (currentUser.role === 'admin' || currentUser.role === 'manager') {
                    dayDiv.addEventListener('click', () => {
                        openMealModal(memberId, dateStr, meal);
                    });
                }

                calendarGrid.appendChild(dayDiv);
            }

        } catch (err) {
            console.error('Error loading calendar:', err);
        }
    }

function openMealModal(memberId, sessionDate, currentNightVal, nextDayVal) {
    const dSession = new Date(sessionDate);
    const dNext = new Date(dSession);
    dNext.setDate(dSession.getDate() + 1);
    const nextDateStr = dNext.toISOString().split('T')[0];
    
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const member = allMembers.find(m => m.id == memberId);

    // Set Hidden Fields
    document.getElementById('mealMemberId').value = memberId;
    document.getElementById('mealDateSession').value = sessionDate;
    document.getElementById('mealDateNext').value = nextDateStr;

    // Set Values
    document.getElementById('mealNightCount').value = currentNightVal;
    document.getElementById('mealDayCount').value = nextDayVal;

    // PERMISSION CHECK
    const isAdminOrManager = (currentUser.role === 'admin' || currentUser.role === 'manager');
    const saveBtn = document.querySelector('#mealForm button[type="submit"]');
    const nightInput = document.getElementById('mealNightCount');
    const dayInput = document.getElementById('mealDayCount');
    const modalTitle = document.getElementById('mealModalTitle');

    if (!isAdminOrManager) {
        // Mode: View Only
        saveBtn.classList.add('hidden'); // Ensure .hidden is in your CSS or use .style.display='none'
        saveBtn.style.display = 'none';
        nightInput.disabled = true;
        dayInput.disabled = true;
        modalTitle.innerHTML = `<div style="color:var(--text-secondary); font-size:14px;">View Session: ${member?.name}</div>
                               <div style="font-size:11px; color:var(--danger-color); font-weight:700;">READ ONLY MODE</div>`;
    } else {
        // Mode: Edit
        saveBtn.classList.remove('hidden');
        saveBtn.style.display = 'block';
        nightInput.disabled = false;
        dayInput.disabled = false;
        modalTitle.innerHTML = `<div style="color:var(--primary-color); font-size:16px;">Edit Session: ${member?.name}</div>
                               <div style="font-size:11px;">Bazar Date: ${fmt(dSession)}</div>`;
    }
    
    document.getElementById('mealNightLabel').innerHTML = `Night (${fmt(dSession)})`;
    document.getElementById('mealDayLabel').innerHTML = `Day (${fmt(dNext)})`;

    document.getElementById('mealModal').classList.add('active');
}

    function closeMealModal() {
        document.getElementById('mealModal').classList.remove('active');
    }

   // ==========================================
// UPDATED MEAL FORM HANDLER
// ==========================================
// ==========================================
// UPDATED MEAL FORM HANDLER (FIXED NOTIFICATION)
// ==========================================
document.getElementById('mealForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    
    const memberId = parseInt(document.getElementById('mealMemberId').value);
    const sessionDate = document.getElementById('mealDateSession').value;
    const nextDate = document.getElementById('mealDateNext').value;
    const nightVal = Math.round(parseFloat(document.getElementById('mealNightCount').value)) || 0;
    const dayVal = Math.round(parseFloat(document.getElementById('mealDayCount').value)) || 0;

    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
        const { data: existingRows } = await supabase.from('meals').select('*').eq('member_id', memberId).in('meal_date', [sessionDate, nextDate]);
        const findRow = (d) => existingRows?.find(r => r.meal_date === d);
        const rowSession = findRow(sessionDate);
        const rowNext = findRow(nextDate);

        const upserts = [
            { cycle_id: currentCycleId, member_id: memberId, meal_date: sessionDate, night_count: nightVal, day_count: rowSession ? rowSession.day_count : 0 },
            { cycle_id: currentCycleId, member_id: memberId, meal_date: nextDate, day_count: dayVal, night_count: rowNext ? rowNext.night_count : 0 }
        ];

        const { error } = await supabase.from('meals').upsert(upserts, { onConflict: 'member_id, meal_date' });
        if (error) throw error;

        const actor = currentUser.members ? currentUser.members.name : "Admin";
        const targetMember = allMembers.find(m => m.id === memberId);
        await logActivity(`Tracker Override: ${targetMember?.name}'s session (${sessionDate}) set to N:${nightVal} D:${dayVal} by ${actor}`, 'meal');

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

    // ============================================
    // SUMMARY PAGE
    // ============================================
    
async function loadSummary() {
    if (!currentCycleId) return;

    const tbody = document.getElementById('summaryTableBody');
    if (!tbody) return;

    try {
        const sessionDate = await getActiveSessionDate();
        const nightDateStr = toLocalISO(sessionDate);

        // Calculate next day properly
        const nextDay = new Date(sessionDate);
        nextDay.setDate(sessionDate.getDate() + 1);
        const dayDateStr = toLocalISO(nextDay);

        const [mealsRes, plansRes, depositsRes, expensesRes] = await Promise.all([
            supabase.from('meals').select('*').eq('cycle_id', currentCycleId),
            supabase.from('meal_plans').select('*').in('plan_date', [nightDateStr, dayDateStr]),
            supabase.from('deposits').select('*').eq('cycle_id', currentCycleId).neq('status', 'pending'),
            supabase.from('expenses').select('*').eq('cycle_id', currentCycleId).eq('status', 'approved')
        ]);

        const meals = mealsRes.data || [];
        const plans = plansRes.data || [];
        const deposits = depositsRes.data || [];
        const expenses = expensesRes.data || [];

        // Update Top Stat Cards
        const totalExpense = expenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
        const allTotalMeals = meals.reduce((sum, m) => sum + (parseFloat(m.day_count || 0) + parseFloat(m.night_count || 0)), 0);
        const mealRate = allTotalMeals > 0 ? totalExpense / allTotalMeals : 0;

        document.getElementById('summaryMealRate').textContent = `৳${mealRate.toFixed(2)}`;
        document.getElementById('summaryTotalCost').textContent = `৳${Math.round(totalExpense)}`;
        document.getElementById('summaryTotalMeals').textContent = allTotalMeals.toFixed(0);

        // Build Table Rows
        const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');
        const bazarCountMap = {};
        expenses.forEach(exp => {
            bazarCountMap[exp.member_id] = (bazarCountMap[exp.member_id] || 0) + 1;
        });

        // --- UPDATE 1: ADD HEADER FOR DEPOSIT ---
        const tableHead = document.querySelector('#summaryTable thead tr');
        if(tableHead) {
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

        tbody.innerHTML = allMembers.map(member => {
            const memMeals = meals.filter(m => m.member_id === member.id).reduce((sum, m) => sum + (parseFloat(m.day_count || 0) + parseFloat(m.night_count || 0)), 0);
            
            // This variable already existed in your code
            const memPaid = deposits.filter(d => d.member_id === member.id).reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
            
            const memBal = memPaid - (memMeals * mealRate);

            const nPlan = plans.find(p => p.member_id === member.id && p.plan_date === nightDateStr);
            const dPlan = plans.find(p => p.member_id === member.id && p.plan_date === dayDateStr);

            const nVal = nPlan ? nPlan.night_count : (member.default_night_on ? 1 : 0);
            const dVal = dPlan ? dPlan.day_count : (member.default_day_on ? 1 : 0);

            // --- UPDATE 2: ADD DATA CELL FOR DEPOSIT ---
            return `
            <tr>
                <td><strong>${member.name.split(' ')[0]}</strong></td>
                <td><button class="summary-status-btn ${nVal > 0 ? 'on' : 'off'}" ${isAdmin ? `onclick="quickToggleSummaryMeal(${member.id}, '${nightDateStr}', 'night', ${nVal})"` : 'disabled'}>${nVal > 0 ? 'ON' : 'OFF'}</button></td>
                <td><button class="summary-status-btn ${dVal > 0 ? 'on' : 'off'}" ${isAdmin ? `onclick="quickToggleSummaryMeal(${member.id}, '${dayDateStr}', 'day', ${dVal})"` : 'disabled'}>${dVal > 0 ? 'ON' : 'OFF'}</button></td>
                <td style="font-weight:700; color:var(--premium-indigo);">${toBn(bazarCountMap[member.id] || 0)}</td>
                <td>${toBn(memMeals.toFixed(1))}</td>
                
                <!-- NEW DEPOSIT CELL -->
                <td style="font-weight:700; color: #059669;">৳${toBn(Math.round(memPaid))}</td>
                
                <td><span class="balance-tag ${memBal >= 0 ? 'pos' : 'neg'}">${toBn(Math.round(memBal))}</span></td>
            </tr>`;
        }).join('');

        await loadDueSettlement();

    } catch (err) {
        console.error('Summary Error:', err);
        tbody.innerHTML = '<tr><td colspan="7" style="color:red">Error loading summary</td></tr>';
    }
}


// Function to instantly toggle meal from Summary Page
async function quickToggleSummaryMeal(memberId, dateStr, type, currentVal) {
    const btn = event.target; // Optimistic UI
    const originalText = btn.textContent;
    btn.textContent = "...";
    btn.disabled = true;

    // 1. Calculate New Value
    const newVal = currentVal > 0 ? 0 : 1;

    try {
        // 2. Fetch existing PLAN to preserve the 'other' side (Day/Night)
        const { data: existingPlan } = await supabase
            .from('meal_plans')
            .select('*')
            .eq('member_id', memberId)
            .eq('plan_date', dateStr)
            .maybeSingle();

        // 3. Prepare Upsert Data
        const upsertPlan = {
            member_id: memberId,
            plan_date: dateStr,
            day_count: existingPlan ? existingPlan.day_count : 0,
            night_count: existingPlan ? existingPlan.night_count : 0
        };

        if (type === 'night') {
            upsertPlan.night_count = newVal;
        } else {
            upsertPlan.day_count = newVal;
        }

        // 4. Send to Database
        const { error } = await supabase
            .from('meal_plans')
            .upsert(upsertPlan, { onConflict: 'member_id, plan_date' });

        if (error) throw error;

        // 5. IMPROVED LOGGING LOGIC
        // Get the target member's name from the global list
        const targetMember = allMembers.find(m => m.id === memberId);
        const targetName = targetMember ? targetMember.name : "Member";
        
        // Get Actor's name
        const actorName = currentUser.members ? currentUser.members.name : currentUser.name;
        
        // Format details
        const actionText = newVal > 0 ? "enabled" : "disabled";
        const typeLabel = type.charAt(0).toUpperCase() + type.slice(1); // "Day" or "Night"
        const dateObj = new Date(dateStr);
        const niceDate = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

        // Message: "Day meal for 12 Jan enabled for John by Admin"
        const logMsg = `${typeLabel} meal for ${niceDate} ${actionText} for "${targetName}" by "${actorName}"`;

        await logActivity(logMsg, 'meal');

        await loadSummary();
        showNotification("Schedule updated successfully", "success");

    } catch (err) {
        console.error("Quick Toggle Error", err);
        showNotification("Update failed", "error");
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

    document.getElementById('exportSummaryBtn').addEventListener('click', () => {
        const table = document.getElementById('summaryTable');
        const wb = XLSX.utils.table_to_book(table);
        XLSX.writeFile(wb, `MealCal_Summary_${new Date().toISOString().split('T')[0]}.xlsx`);
    });





    // ============================================
// FULL CYCLE EXPORT SYSTEM
// ============================================

document.getElementById('exportFullCycleBtn').addEventListener('click', async () => {
    if (!currentCycleId) return;
    
    const btn = document.getElementById('exportFullCycleBtn');
    const originalText = btn.textContent;
    btn.textContent = "Generating...";
    btn.disabled = true;

    try {
        // 1. Fetch ALL Data for the Cycle in Parallel
        const [cycleRes, membersRes, mealsRes, depositsRes, expensesRes] = await Promise.all([
            supabase.from('cycles').select('name, start_date, end_date').eq('id', currentCycleId).single(),
            supabase.from('members').select('id, name').order('name'),
            supabase.from('meals').select('*').eq('cycle_id', currentCycleId),
            supabase.from('deposits').select('*, members(name)').eq('cycle_id', currentCycleId).neq('status', 'pending').order('created_at'),
            supabase.from('expenses').select('*, members(name)').eq('cycle_id', currentCycleId).eq('status', 'approved').order('expense_date')
        ]);

        const cycle = cycleRes.data;
        const members = membersRes.data;
        const meals = mealsRes.data;
        const deposits = depositsRes.data;
        const expenses = expensesRes.data;

        // 2. Perform Calculations
        const totalExpense = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);
        const totalMeals = meals.reduce((sum, m) => sum + (parseFloat(m.day_count) + parseFloat(m.night_count)), 0);
        const totalDeposits = deposits.reduce((sum, d) => sum + parseFloat(d.amount), 0);
        
        // Avoid division by zero
        const mealRate = totalMeals > 0 ? (totalExpense / totalMeals) : 0;
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
        dataRows.push(["Total Meals", "Total Expenses", "Total Deposits", "Meal Rate", "Cash Balance"]);
        dataRows.push([
            totalMeals.toFixed(2), 
            totalExpense.toFixed(2), 
            totalDeposits.toFixed(2), 
            mealRate.toFixed(4), 
            currentBalance.toFixed(2)
        ]);
        dataRows.push([]); // Spacer

        // --- SECTION C: MEMBER SUMMARY TABLE ---
        dataRows.push(["--- MEMBER SUMMARY ---"]);
        dataRows.push(["Member Name", "Total Meals", "Total Deposit", "Actual Cost", "Balance (+Refund/-Due)"]);

        members.forEach(m => {
            const mMeals = meals.filter(x => x.member_id === m.id)
                .reduce((s, x) => s + (parseFloat(x.day_count) + parseFloat(x.night_count)), 0);
            
            const mDep = deposits.filter(x => x.member_id === m.id)
                .reduce((s, x) => s + parseFloat(x.amount), 0);
            
            const mCost = mMeals * mealRate;
            const mBal = mDep - mCost;

            dataRows.push([
                m.name,
                mMeals.toFixed(1),
                mDep.toFixed(2),
                mCost.toFixed(2),
                mBal.toFixed(2)
            ]);
        });
        dataRows.push([]); // Spacer

        // --- SECTION D: EXPENSE LOG (BAZAR LIST) ---
        dataRows.push(["--- EXPENSE / BAZAR LOG ---"]);
        dataRows.push(["Date", "Shopper", "Description", "Amount"]);
        
        expenses.forEach(e => {
            dataRows.push([
                e.expense_date,
                e.members?.name || 'Unknown',
                e.description,
                parseFloat(e.amount).toFixed(2)
            ]);
        });
        dataRows.push([]); // Spacer

        // --- SECTION E: DEPOSIT LOG (WALLET HISTORY) ---
        dataRows.push(["--- DEPOSIT & TRANSACTION LOG ---"]);
        dataRows.push(["Date", "Member", "Label/Type", "Notes", "Amount"]);

        deposits.forEach(d => {
            const dateStr = new Date(d.created_at).toLocaleDateString('en-GB');
            dataRows.push([
                dateStr,
                d.members?.name || 'Unknown',
                d.label,
                d.notes || '-',
                parseFloat(d.amount).toFixed(2)
            ]);
        });

        // 4. Generate File
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(dataRows);

        // Optional: Auto-width columns (Cosmetic)
        ws['!cols'] = [
            { wch: 20 }, { wch: 20 }, { wch: 25 }, { wch: 15 }, { wch: 15 }
        ];

        XLSX.utils.book_append_sheet(wb, ws, "Full Report");
        
        // Filename: MealCal_Report_CycleName_Date.csv
        const safeName = cycle.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
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
    
 window.handleDepositAction = async function(depositId, action) {
    console.log(`Action: ${action} triggered for ID: ${depositId}`);
    const btn = event.target;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "...";

    try {
        const { data: dep, error: fError } = await supabase
            .from('deposits')
            .select('*, members(name)')
            .eq('id', depositId)
            .single();

        if (fError || !dep) throw new Error("Could not find the pending request.");

        const actor = currentUser.members ? currentUser.members.name : "Admin";

        if (action === 'approve') {
            const { error: delError } = await supabase.from('deposits').delete().eq('id', depositId);
            if (delError) throw delError;

            await processDepositWithClientSideSettlement(
                dep.member_id, 
                dep.cycle_id, 
                dep.amount, 
                dep.label || 'Deposit', 
                dep.notes
            );
            
            // LOG THE APPROVAL ACT
            await logActivity(`Deposit Approved: ${dep.members.name}'s request for ${formatCurrency(dep.amount)} was approved by ${actor}`, 'deposit');
            showNotification("Request Approved", "success");

        } else if (action === 'reject') {
            const { error: delError } = await supabase.from('deposits').delete().eq('id', depositId);
            if (delError) throw delError;


            // LOG THE REJECTION ACT
            await logActivity(`Deposit Rejected: ${dep.members.name}'s request for ${formatCurrency(dep.amount)} was rejected by ${actor}`, 'deposit');
            showNotification("Request Rejected", "warning");
        }
        
        await loadDeposits(); 
        if (typeof loadDashboard === 'function') loadDashboard();

    } catch (err) {
        console.error("CRITICAL ERROR:", err.message);
        showNotification(err.message, "error");
        btn.disabled = false;
        btn.textContent = originalText;
    }
};

document.getElementById('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // 1. Grab UI Elements
    const submitBtn = document.getElementById('expenseSubmitBtn');
    const expenseId = document.getElementById('editExpenseId').value;
    
    // 2. Safe Value Extraction
    const date = document.getElementById('expenseDate').value;
    const mid = document.getElementById('expenseMember').value;
    const desc = document.getElementById('expenseDescription').value;
    const amtVal = document.getElementById('expenseAmount').value;
    const amt = parseFloat(amtVal); // Don't round yet if you want decimals, or use Math.round(amtVal)

    // 3. Validations
    if (!currentCycleId) { 
        showNotification("System Error: No active cycle found.", "error"); 
        return; 
    }
    if (!mid) { 
        showNotification("Please select a shopper.", "error"); 
        return; 
    }
    if (isNaN(amt) || amt <= 0) { 
        showNotification("Please enter a valid amount.", "error"); 
        return; 
    }

    // 4. Lock UI
    const isEditMode = !!expenseId;
    const originalText = isEditMode ? "Update ✓" : "ADD +";
    submitBtn.textContent = "Processing...";
    submitBtn.disabled = true;

    try {
        // --- SAFE DATA GATHERING ---
        // Get Shopper Name safely
        const shopperSelect = document.getElementById('expenseMember');
        let shopperName = "Unknown";
        if (shopperSelect.selectedIndex >= 0) {
            shopperName = shopperSelect.options[shopperSelect.selectedIndex].text;
        }

        // Get Actor Name safely
        const actorName = currentUser?.name || "User";

        // ===========================
        // DATABASE OPERATION
        // ===========================
        if (isEditMode) {
            // --- EDIT MODE ---
            // 1. Fetch old data for diff logging (Optional - wrapped to not break flow)
            let oldAmt = 0;
            const { data: oldData } = await supabase.from('expenses').select('amount').eq('id', expenseId).maybeSingle();
            if(oldData) oldAmt = oldData.amount;

            // 2. Update
            const { error: updateError } = await supabase
                .from('expenses')
                .update({ 
                    expense_date: date, 
                    member_id: mid, 
                    description: desc, 
                    amount: amt,
                    is_edited: true 
                })
                .eq('id', expenseId);

            if (updateError) throw updateError;

            // 3. Log (Non-blocking)
            logExpenseActivity(`Expense Edited: ৳${oldAmt} ➔ ৳${amt} (${desc}) by ${actorName}`);
            showNotification('Expense updated!', 'success');

        } else {
            // --- ADD MODE ---
            const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');
            const status = isAdmin ? 'approved' : 'pending';

            const { error: insertError } = await supabase
                .from('expenses')
                .insert({ 
                    cycle_id: parseInt(currentCycleId), 
                    expense_date: date, 
                    member_id: parseInt(mid), 
                    description: desc, 
                    amount: amt,
                    status: status
                });

            if (insertError) throw insertError;

            // 3. Log (Non-blocking)
            const msg = `New Expense: ৳${amt} for "${desc}" by ${shopperName}`;
            logExpenseActivity(msg);

            showNotification(isAdmin ? 'Expense added!' : 'Request sent for approval', 'success');
        }

        // ===========================
        // SUCCESS CLEANUP
        // ===========================
        resetExpenseForm(); // This resets the button text inside it too
        
        // Refresh data in background
        loadExpenses(); 
        loadDashboard(); 

    } catch (err) {
        console.error("Expense Submit Error:", err);
        showNotification(err.message || "Failed to save expense", 'error');
        
        // Manual Reset of button on error because resetExpenseForm() wasn't called
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
        
    } finally {
        // Double Ensure Button is unlocked in case resetExpenseForm failed
        if(submitBtn.disabled) {
           submitBtn.disabled = false;
           // If resetExpenseForm ran, text is "ADD +", if not, we revert to original
           if(document.getElementById('expenseAmount').value !== "") {
               submitBtn.textContent = originalText; 
           }
        }
    }
});

// Helper to log without breaking the main flow
async function logExpenseActivity(message) {
    try {
        // Ensure member_id is valid, or pass null
        const loggerId = currentUser?.member_id ? parseInt(currentUser.member_id) : null;
        
        await supabase.from('notifications').insert({
            cycle_id: parseInt(currentCycleId),
            type: 'expense',
            message: message,
            member_id: loggerId
        });
    } catch (e) {
        console.warn("Logging failed silently:", e);
    }
}

    // ============================================
    // DEPOSITS PAGE
    // ============================================
async function loadDeposits() {
    const filterId = document.getElementById('depositLogFilter').value;
    if (!currentCycleId) return;

    try {
        const { data, error } = await supabase
            .from('deposits')
            .select('*, members(name)')
            .eq('cycle_id', currentCycleId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const pendingCard = document.getElementById('pendingDepositsCard');
        const pendingList = document.getElementById('pendingDepositList');
        const historyContainer = document.getElementById('depositList');

        // STRICT FILTERING
        // Pending: only those explicitly marked 'pending'
        const pendingItems = data.filter(d => d.status === 'pending');
        
        // History: only those marked 'approved' OR legacy records (null status)
        const historyItems = data.filter(d => d.status === 'approved' || !d.status);

        // Render Pending
        if (pendingItems.length > 0) {
            pendingCard.style.display = 'block';
            const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');
            pendingList.innerHTML = pendingItems.map(t => `
                <div class="list-item" style="background: rgba(245, 158, 11, 0.05); padding: 12px; margin-bottom: 8px; border-radius: 8px; border: 1px solid #fed7aa;">
                    <div class="log-main">
                        <div class="log-details">
                            <div class="log-member">${t.members?.name} <span class="due-status-badge due-status-pending">PENDING REQUEST</span></div>
                            <div class="log-meta" style="font-weight:700;">${formatCurrency(t.amount)} • ${t.label || 'Deposit'}</div>
                        </div>
                    </div>
                    ${isAdmin ? `
                    <div style="display:flex; gap:8px;">
                        <button class="btn btn-success btn-sm" onclick="handleDepositAction(${t.id}, 'approve')">Approve</button>
                        <button class="btn btn-danger btn-sm" onclick="handleDepositAction(${t.id}, 'reject')">✕</button>
                    </div>` : ''}
                </div>
            `).join('');
        } else {
            pendingCard.style.display = 'none';
        }

        // Render History
        let filteredHistory = historyItems;
        if (filterId) filteredHistory = historyItems.filter(h => h.member_id == filterId);

        if (filteredHistory.length === 0) {
            historyContainer.innerHTML = '<div class="loading">No transaction history found.</div>';
            return;
        }

        historyContainer.innerHTML = filteredHistory.map(t => {
            const isSettlement = t.label === 'Auto-Settlement' || t.label === 'Reduction';
            const isNegative = t.amount < 0;
            
            // Icon & Style Logic
            let icon = '💰';
            let iconClass = 'deposit';
            let tagClass = 'tag-deposit';
            let typeLabel = 'Deposit';

            if (t.label === 'Auto-Settlement') {
                icon = '🔄';
                iconClass = 'settlement';
                tagClass = 'tag-settle';
                typeLabel = 'Settlement';
            } else if (isNegative) {
                icon = '🔻';
                iconClass = 'charge';
                tagClass = 'tag-settle';
                typeLabel = 'Charge';
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
                    ${t.members?.name || 'Unknown'}
                    <span class="log-type-tag ${tagClass}">
                        ${typeLabel}
                    </span>
                </div>

                <div class="log-meta">
                    ${dateStr} ${t.notes ? `• ${t.notes}` : ''}
                </div>

                ${isSettlement && t.notes
                    ? `<div class="transfer-info">📌 ${t.notes}</div>`
                    : ''}
            </div>
        </div>

        <!-- Right side (balance) -->
        <div class="log-amount
            ${isNegative ? 'balance-negative' : 'balance-positive'}">
            ${isNegative ? '-' : '+'}${formatCurrency(Math.abs(t.amount))}
        </div>
    </div>
</div>

            `;
        }).join('');

    } catch (err) {
        console.error('Error loading deposits:', err);
        historyContainer.innerHTML = '<div class="loading" style="color:red;">Error loading transactions.</div>';
    }
}

async function loadExpenses() {
    const historyContainer = document.getElementById('expenseList');
    const pendingContainer = document.getElementById('pendingExpensesList');
    const pendingCard = document.getElementById('pendingExpensesCard');
    
    if (!currentCycleId) return;

    try {
        // Fetch ALL expenses for this cycle
        const { data: expenses, error } = await supabase
            .from('expenses')
            .select('*, members(name)')
            .eq('cycle_id', currentCycleId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Reset Containers
        historyContainer.innerHTML = '';
        pendingContainer.innerHTML = '';
        pendingCard.style.display = 'none';

        if (!expenses || expenses.length === 0) {
            historyContainer.innerHTML = '<div style="text-align:center; padding:20px; color:#cbd5e1;">No expenses yet.</div>';
            return;
        }

        const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');

        // --- FILTERING ---
        const pendingItems = expenses.filter(e => e.status === 'pending');
        // History shows Approved items OR items marked 'rejected' (optional)
        const historyItems = expenses.filter(e => e.status === 'approved');

        // 1. RENDER PENDING LIST (Mobile Optimized)
if (pendingItems.length > 0) {
    pendingCard.style.display = 'block';
    
    pendingContainer.innerHTML = pendingItems.map(exp => {
        const dateStr = new Date(exp.expense_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const shopperName = exp.members?.name || 'Unknown';
        // Truncate description for mobile if too long
        const shortDesc = (exp.description || 'No details').substring(0, 25) + ((exp.description?.length > 25) ? '...' : '');
        
        // Admin Buttons vs User Label
        const footerContent = isAdmin ? `
            <div class="pending-actions">
                <button class="btn-mobile-action btn-approve" onclick="handleExpenseApproval('${exp.id}', 'approved')">
                    ✓ Approve
                </button>
                <button class="btn-mobile-action btn-reject" onclick="handleExpenseApproval('${exp.id}', 'rejected')">
                    ✕ Reject
                </button>
            </div>
        ` : `<div class="pending-status-label">WAITING FOR ADMIN APPROVAL</div>`;

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
    }).join('');
}
        // 2. RENDER HISTORY LIST (Approved Only)
        if (historyItems.length === 0) {
            historyContainer.innerHTML = '<div style="text-align:center; padding:10px; color:#cbd5e1; font-size:11px;">No approved expenses yet.</div>';
        } else {
            historyItems.forEach(exp => {
                const dateObj = new Date(exp.expense_date);
                const dateStr = dateObj.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                const itemsText = exp.description ? exp.description : 'General Expense';
                const shopperName = exp.members?.name || 'Unknown';
                const editedTag = exp.is_edited ? `<span class="edited-badge">EDITED</span>` : '';

                let actionBtn = '';
                if (isAdmin) {
                    actionBtn = `
                    <button class="btn-icon-edit" 
                        onclick="populateExpenseForm('${exp.id}', '${exp.expense_date}', '${exp.member_id}', '${exp.amount}', this.dataset.desc)"
                        data-desc="${(exp.description || '').replace(/"/g, '&quot;')}"
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
                
                historyContainer.insertAdjacentHTML('beforeend', html);
            });
        }

    } catch (err) {
        console.error("Load Exp Error:", err);
        historyContainer.innerHTML = '<div style="color:red; text-align:center;">Failed to load.</div>';
    }
}


// Function to fill the form with existing data
function populateExpenseForm(id, date, memberId, amount, desc) {
    // 1. Fill Fields
    document.getElementById('editExpenseId').value = id;
    document.getElementById('expenseDate').value = date;
    document.getElementById('expenseMember').value = memberId;
    document.getElementById('expenseAmount').value = amount;
    document.getElementById('expenseDescription').value = desc;

    // 2. Change UI to "Edit Mode"
    document.getElementById('expenseFormTitle').textContent = "Edit Expense Log";
    document.getElementById('expenseFormTitle').style.color = "var(--primary-color)";
    
    const submitBtn = document.getElementById('expenseSubmitBtn');
    submitBtn.textContent = "Update ✓";
    submitBtn.classList.remove('btn-primary');
    submitBtn.classList.add('btn-success'); // You might need to define .btn-success or just leave styled via CSS
    submitBtn.style.backgroundColor = "#059669"; // Force green

    document.getElementById('expenseCancelBtn').classList.remove('hidden');

    // 3. Scroll to top so user sees the form
    document.getElementById('expensesPage').scrollIntoView({ behavior: 'smooth' });
}

// Function to cancel edit and reset form
function resetExpenseForm() {
    const form = document.getElementById('expenseForm');
    if (!form) return;

    // 1. Clear standard inputs
    form.reset();
    document.getElementById('editExpenseId').value = '';
    
    // 2. Reset UI Styling (Title & Buttons)
    const title = document.getElementById('expenseFormTitle');
    const submitBtn = document.getElementById('expenseSubmitBtn');
    const cancelBtn = document.getElementById('expenseCancelBtn');

    title.textContent = "Add Expense";
    title.style.color = "var(--text-primary)";
    
    submitBtn.textContent = "ADD +";
    submitBtn.className = "btn btn-primary"; // Reset classes
    submitBtn.style.backgroundColor = ""; // Reset inline styles

    if (cancelBtn) cancelBtn.classList.add('hidden');

    // 3. SET DEFAULT DATE: TODAY (Local Time)
    // We adjust for timezone offset to get the correct local "YYYY-MM-DD"
    const now = new Date();
    const localDate = new Date(now.getTime() - (now.getTimezoneOffset() * 60000))
                        .toISOString()
                        .split('T')[0];
    
    document.getElementById('expenseDate').value = localDate;
    
    // 4. SET DEFAULT SHOPPER: CURRENT USER
    // This applies to everyone (Admins included) for convenience
    if (currentUser && currentUser.member_id) {
        const memberSelect = document.getElementById('expenseMember');
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
    const type = document.getElementById('depositType').value;
    const labelInput = document.getElementById('depositLabel');
    
    // Only update if the user hasn't typed something custom yet (optional logic, 
    // strictly replacing is usually safer for UX in this context)
    if (type === 'charge') {
        labelInput.value = 'Reduction';
    } else {
        labelInput.value = 'Deposit';
    }
}

async function loadSelectedMemberHistory(memberId) {
    const container = document.getElementById('selectedMemberHistoryList');
    const nameLabel = document.getElementById('historyMemberName');
    
    // Defensive check: If the page isn't loaded yet, stop here.
    if (!container || !nameLabel) return;

    if (!memberId) {
        container.innerHTML = '<div style="font-size:11px; color:gray; text-align:center; padding:10px;">Select a member to view their specific log.</div>';
        nameLabel.textContent = "No member selected";
        return;
    }

    const member = allMembers.find(m => m.id == memberId);
    nameLabel.textContent = member ? member.name.toUpperCase() : 'UNKNOWN';
    container.innerHTML = '<div class="loading" style="font-size:11px;">Loading history...</div>';

    try {
        const { data, error } = await supabase
            .from('deposits')
            .select('*, members(name)')
            .eq('cycle_id', currentCycleId)
            .eq('member_id', memberId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            container.innerHTML = '<div style="font-size:11px; color:gray; text-align:center; padding:10px;">No personal history found.</div>';
            return;
        }

        // Reuse the premium renderHistoryItem function for consistency
        container.innerHTML = data.map(t => renderHistoryItem(t)).join('');

    } catch (err) {
        console.error("Error loading member history:", err);
        container.innerHTML = '<div style="font-size:11px; color:red; text-align:center; padding:10px;">Error loading data.</div>';
    }
}


function renderHistoryItem(t) {
    const isNegative = t.amount < 0;
    const isSettle = t.label === 'Auto-Settlement';
    
    let icon = '💰';
    let iconClass = 'plus';
    if (isSettle) { icon = '🔄'; iconClass = 'settle'; }
    else if (isNegative) { icon = '📉'; iconClass = 'minus'; }

    const dateStr = new Date(t.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

    // --- CHANGED LINE BELOW: toBn(Math.round(t.amount)) ---
    return `
    <div class="history-item-premium">
        <div class="hist-left">
            <div class="hist-icon ${iconClass}">${icon}</div>
            <div class="hist-details">
                <div class="name">${t.members?.name || 'User'}</div>
                <div class="meta">${dateStr} ${t.notes ? `• ${t.notes}` : ''}</div>
            </div>
        </div>
        <div class="hist-amount">
            <div class="val" style="color: ${isNegative ? '#e11d48' : '#059669'}">
                ${isNegative ? '' : '+'}${toBn(Math.round(t.amount))}
            </div>
            <div class="label" style="color: var(--text-muted)">${t.label || 'Entry'}</div>
        </div>
    </div>`;
}


// Add this NEW function BEFORE the depositForm handler
async function processDepositWithClientSideSettlement(memberId, cycleId, amount, label, notes) {
    try {
        const targetCycleId = parseInt(cycleId); 

        // 1. Insert the official REAL cash deposit (Approved)
        const { data: mainDeposit, error: depError } = await supabase
            .from('deposits')
            .insert({
                cycle_id: targetCycleId,
                member_id: memberId,
                amount: amount,
                label: label,
                notes: notes,
                status: 'approved'
            })
            .select().single();

        if (depError) throw depError;

        const memberObj = allMembers.find(m => m.id == memberId);
        
        // GLOBAL LOG
        await logActivity(`Cash Deposit: ${formatCurrency(amount)} added for ${memberObj?.name}`, 'deposit');
        
    

        if (amount <= 0) return { settled: false, deposit_id: mainDeposit.id };

        // 2. Find Debtor Due
        const { data: debtorDue } = await supabase
            .from('cycle_dues')
            .select('*')
            .eq('member_id', memberId)
            .eq('to_cycle_id', targetCycleId)
            .in('status', ['pending', 'settling'])
            .lt('due_amount', 0)
            .maybeSingle();

        if (!debtorDue) return { settled: false, deposit_id: mainDeposit.id };

        // 3. Find Creditors
        const { data: creditors } = await supabase
            .from('cycle_dues')
            .select('*, members(name)')
            .eq('to_cycle_id', targetCycleId)
            .in('status', ['pending', 'settling'])
            .gt('due_amount', 0)
            .order('created_at', { ascending: true });

        if (!creditors || creditors.length === 0) return { settled: false, deposit_id: mainDeposit.id };

        // INITIALIZE POOL (Fixed placement)
        let poolAvailable = Math.min(amount, Math.abs(debtorDue.due_amount) - Math.abs(debtorDue.settled_amount));
        let totalActuallySettled = 0;

        for (const creditor of creditors) {
            if (poolAvailable <= 0) break;

            const creditorOwed = creditor.due_amount - creditor.settled_amount;
            if (creditorOwed <= 0) continue;

            // CALCULATE SETTLEMENT (With Rounding Logic)
            const settleAmountRaw = Math.min(poolAvailable, creditorOwed);
            const settleAmount = Math.round(settleAmountRaw * 100) / 100; // Limits to 2 decimals

            if (settleAmount <= 0) continue;

            // 4. Create Transfer Logs (Auto-Settlements)
            await supabase.from('deposits').insert([
                { 
                    cycle_id: targetCycleId, 
                    member_id: memberId, 
                    amount: -settleAmount, 
                    label: 'Auto-Settlement', 
                    notes: `Paid to ${creditor.members.name}`,
                    status: 'approved'
                },
                { 
                    cycle_id: targetCycleId, 
                    member_id: creditor.member_id, 
                    amount: settleAmount, 
                    label: 'Auto-Settlement', 
                    notes: `Received from ${memberObj.name}`,
                    status: 'approved'
                }
            ]);

         

            // Update Creditor Progress
            const newCreditorSettled = creditor.settled_amount + settleAmount;
            await supabase.from('cycle_dues').update({
                settled_amount: newCreditorSettled,
                status: newCreditorSettled >= creditor.due_amount ? 'settled' : 'settling',
                settled_at: newCreditorSettled >= creditor.due_amount ? new Date().toISOString() : null
            }).eq('id', creditor.id);

            poolAvailable -= settleAmount;
            totalActuallySettled += settleAmount;
        }

        // 5. Update Debtor Progress Record
        if (totalActuallySettled > 0) {
            const newDebtorSettled = Math.abs(debtorDue.settled_amount) + totalActuallySettled;
            const isFullySettled = newDebtorSettled >= Math.abs(debtorDue.due_amount);
            
            await supabase.from('cycle_dues').update({
                settled_amount: -newDebtorSettled,
                status: isFullySettled ? 'settled' : 'settling',
                settled_at: isFullySettled ? new Date().toISOString() : null
            }).eq('id', debtorDue.id);
            
        }

        return {
            settled: totalActuallySettled > 0,
            settled_amount: totalActuallySettled,
            deposit_id: mainDeposit.id
        };

    } catch (err) {
        console.error("Settlement Logic Crash:", err);
        throw err;
    }
}

document.getElementById('depositForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;

    const memberId = parseInt(document.getElementById('depositMember').value);
    const type = document.getElementById('depositType').value;
    const rawAmount = parseFloat(document.getElementById('depositAmount').value);
    const roundedAmount = Math.round(rawAmount); 
    const label = document.getElementById('depositLabel').value;
    const notes = document.getElementById('depositNotes').value;
    
    const finalAmount = type === 'charge' ? -Math.abs(roundedAmount) : Math.abs(roundedAmount);
    const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');
    const actor = currentUser.members ? currentUser.members.name : "User";

    btn.textContent = "Processing...";
    btn.disabled = true;

    try {
        const targetMember = allMembers.find(m => m.id === memberId);

        if (isAdmin) {
            let result;
            try {
                const { data, error } = await supabase.rpc('process_deposit_with_settlement', {
                    p_member_id: memberId,
                    p_cycle_id: parseInt(currentCycleId),
                    p_amount: finalAmount,
                    p_label: label,
                    p_notes: notes
                });
                if (error) throw error;
                result = data;
            } catch (rpcError) {
                result = await processDepositWithClientSideSettlement(memberId, currentCycleId, finalAmount, label, notes);
            }
            
            await logActivity(`Deposit Approved: ${formatCurrency(finalAmount)} added for ${targetMember?.name} by ${actor}`, 'deposit');
            showNotification("Transaction completed", 'success');
        } else {
            const { error } = await supabase.from('deposits').insert({
                cycle_id: parseInt(currentCycleId),
                member_id: memberId,
                amount: finalAmount,
                label: label,
                notes: notes,
                status: 'pending'
            });
            if (error) throw error;

            await logActivity(`Deposit Request: ${targetMember?.name} requested ${formatCurrency(finalAmount)} approval via ${actor}`, 'deposit');
            showNotification("Request submitted", 'info');
        }

        document.getElementById('depositAmount').value = '';
        document.getElementById('depositNotes').value = '';
        await loadDeposits();
    } catch (err) {
        showNotification(err.message, 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

    // ============================================
    // ADMIN PAGE
    // ============================================
    
    async function loadAdmin() {
        await loadMembersList();
    }

   document.getElementById('createCycleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const originalText = btn.textContent;
    const name = document.getElementById('cycleName').value;
    const startDate = document.getElementById('cycleStartDate').value;
    const endDate = document.getElementById('cycleEndDate').value;

    btn.textContent = "Creating...";
    btn.disabled = true;

    try {
        await supabase.from('cycles').update({ is_active: false }).neq('id', 0);
        const { error } = await supabase.from('cycles').insert({ name, start_date: startDate, end_date: endDate, is_active: true });
        if (error) throw error;

        const actor = currentUser.members ? currentUser.members.name : "Admin";
        await logActivity(`System: New cycle "${name}" created and activated by ${actor}`, 'other');

        document.getElementById('createCycleForm').reset();
        await loadCycles();
        showNotification('Cycle created', 'success');
    } catch (err) {
        showNotification(err.message, 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});



    document.getElementById('addMemberForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = document.getElementById('memberName').value;

        try {
            // 1. Insert Member
            const { data: memberData, error: memberError } = await supabase
                .from('members')
                .insert({ name: name })
                .select()
                .maybeSingle();
            
            if (memberError) throw memberError;

            // 2. Automatically create User
            const defaultPass = await hashPassword("123");
            
            await supabase.from('users').insert({
                username: name,
                password: defaultPass,
                role: 'user',
                member_id: memberData.id
            });

            await logActivity(`New member added & user created: ${name}`, 'other');

            document.getElementById('addMemberForm').reset();
            await loadMembers();
            await loadMembersList();
            showNotification('Member added successfully. Default password is "123"', 'success');

        } catch (err) {
            console.error('Error adding member:', err);
            showNotification('Failed to add member', 'error');
        }
    });

 async function loadMembersList() {
    const container = document.getElementById('membersList');
    if (!container) return;
    container.innerHTML = '<div class="loading">Loading members...</div>';

    try {
        const { data: members, error } = await supabase
            .from('members')
            .select('*')
            .order('name');
        
        if (error) throw error;

        if (!members || members.length === 0) {
            container.innerHTML = '<div class="loading">No members yet</div>';
            return;
        }

        container.innerHTML = members.map(member => {
            const isManager = member.role === 'manager';
            const isAdmin = member.role === 'admin';
            const hasLogin = member.user_id !== null;

            // --- FIXED AVATAR LOGIC (Inside the loop) ---
            const avatarHtml = (member.avatar_url && member.avatar_url.trim() !== "") 
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
                        ${isAdmin ? '<span style="font-size:9px; background:#0f172a; color:white; padding:2px 6px; border-radius:6px; margin-left:5px;">ADMIN</span>' : ''}
                        ${isManager ? '<span style="font-size:9px; background:#10b981; color:white; padding:2px 6px; border-radius:6px; margin-left:5px;">MANAGER</span>' : ''}
                    </div>
                    <div class="list-item-subtitle" style="font-size: 11px;">
                        ${hasLogin ? '<span style="color:#10b981">● Active User</span>' : '<span style="color:#f59e0b">○ No Login Linked</span>'}
                    </div>
                </div>
                
                <!-- Actions column -->
                <div style="display: flex; gap: 8px;">
                    ${!isAdmin ? `
                    <button class="btn btn-sm ${isManager ? 'btn-secondary' : 'btn-success'}" 
                            style="font-size: 10px; padding: 6px 10px;"
                            onclick="toggleManagerRole('${member.id}', '${member.role}')">
                        ${isManager ? 'Demote' : 'Promote'}
                    </button>
                    ` : ''}
                    
                    <button class="btn btn-sm btn-primary" 
                            style="font-size: 10px; padding: 6px 10px;"
                            onclick="openEditMemberModal('${member.id}', '${member.name}', '${member.user_id || ''}')">
                        Edit
                    </button>
                </div>
            </div>
            `;
        }).join('');

    } catch (err) {
        console.error('Error loading members list:', err);
        container.innerHTML = '<div class="loading" style="color:red">Error loading list</div>';
    }
}


// --- Action 1: Toggle Manager Role ---
async function toggleManagerRole(memberId, currentRole) {
    const isManager = currentRole === 'manager';
    const newRole = isManager ? 'user' : 'manager';
    if (!confirm(`Change role to ${newRole}?`)) return;

    try {
        const { error } = await supabase.from('members').update({ role: newRole }).eq('id', memberId);
        if (error) throw error;

        const targetMember = allMembers.find(m => m.id == memberId);
        const actor = currentUser.members ? currentUser.members.name : "Admin";
        
        // LOG ROLE CHANGE
        await logActivity(`Access Control: ${targetMember.name} was ${isManager ? 'demoted to User' : 'promoted to Manager'} by ${actor}`, 'other');

        showNotification('Role updated successfully', 'success');
        await loadMembersList();
    } catch (err) {
        showNotification('Failed to update role', 'error');
    }
}

// --- Action 2: Delete Member ---
async function deleteMember(memberId, userId) {
    if (!confirm('WARNING: Deleting a member will remove their user account. If they have existing meal/deposit records, this might fail or cause data issues. Continue?')) return;

    try {
        // 1. Delete User Account first (if exists)
        if (userId) {
            const { error: uError } = await supabase.from('users').delete().eq('id', userId);
            if (uError) throw uError;
        }

        // 2. Delete Member
        const { error: mError } = await supabase.from('members').delete().eq('id', memberId);
        if (mError) {
            // If foreign key constraint fails (has meals/deposits)
            throw new Error("Cannot delete member: They likely have associated meals or deposits.");
        }

        showNotification('Member deleted successfully', 'success');
        await loadMembersList();
        await loadMembers(); // Refresh global list

    } catch (err) {
        console.error('Delete error:', err);
        showNotification(err.message, 'error');
    }
}

// --- Action 3: Edit Member (Modal & Save) ---
function openEditMemberModal(memberId, currentName, userId) {
    document.getElementById('editMemberId').value = memberId;
    document.getElementById('editUserId').value = userId;
    document.getElementById('editMemberName').value = currentName;
    document.getElementById('editMemberPassword').value = ''; // Reset password field
    document.getElementById('editMemberModal').classList.add('active');
}

document.getElementById('editMemberForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    // 1. Get Elements
    const memberId = document.getElementById('editMemberId').value;
    const userId = document.getElementById('editUserId').value; // The Auth User ID
    const newName = document.getElementById('editMemberName').value;
    const newPassword = document.getElementById('editMemberPassword').value;
    
    // Select the button specifically inside this form
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = "Save Changes";

    // 2. Lock UI
    submitBtn.textContent = "Saving...";
    submitBtn.disabled = true;

    try {
        // --- A. Update Display Name ---
        const { error: mError } = await supabase
            .from('members')
            .update({ name: newName })
            .eq('id', memberId);

        if (mError) throw mError;

        // --- B. Handle Password Change ---
        if (newPassword && newPassword.trim() !== "") {
            
            // Check if the user ID exists (some old members might not have logins)
            if (!userId || userId === "null" || userId === "undefined") {
                throw new Error("This member does not have a linked User Account, so password cannot be changed.");
            }

            // SCENARIO 1: Changing MY OWN password
            if (currentUser && currentUser.id === userId) {
                const { error: authError } = await supabase.auth.updateUser({ 
                    password: newPassword 
                });
                if (authError) throw authError;
                console.log("Updated own password via Auth API");
            } 
            
            // SCENARIO 2: Admin changing SOMEONE ELSE'S password
            else {
                // Call the SQL function we created in Step 1
                const { error: rpcError } = await supabase.rpc('admin_reset_password', {
                    target_user_id: userId,
                    new_password: newPassword
                });

                if (rpcError) throw rpcError;
                console.log("Updated user password via Admin RPC");
            }
        }

        // --- C. Log & Notify ---
        const actor = currentUser.members ? currentUser.members.name : "Admin";
        await logActivity(`Profile Update: ${newName}'s details updated by ${actor}`, 'other');

        // Close Modal
        document.getElementById('editMemberModal').classList.remove('active');
        showNotification('Member updated successfully', 'success');

        // Refresh Lists
        await loadMembersList(); // Admin list
        await loadMembers();     // Global dropdowns
        
        // If updating self, update header name immediately
        if (currentUser.member_id == memberId) {
            document.getElementById('profileName').textContent = newName;
            document.getElementById('headerUserName').textContent = `${newName} (${currentUser.role.toUpperCase()})`;
        }

    } catch (err) {
        console.error('Edit error:', err);
        showNotification('Update failed: ' + err.message, 'error');
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
    
async function logActivity(message, type = 'info') {
    if (!currentCycleId) {
        console.error("Cannot log activity: currentCycleId is missing.");
        return;
    }
    
    try {
        const { error } = await supabase
            .from('notifications')
            .insert({
                cycle_id: parseInt(currentCycleId), // Ensure it's an Integer
                message: message,
                type: type,
                member_id: currentUser?.member_id || null // NULL for system logs
            });

        if (error) throw error;
        
        // Refresh local notifications if the panel is open
        if (document.getElementById('notifPanel').classList.contains('active')) {
            loadNotifications();
        }
    } catch (err) {
        console.error('Logging Error:', err.message);
    }
}


async function triggerManualAutoEntry() {
    if (!confirm("⚠️ Are you sure? \n\nThis will FORCE the system to copy all 'Meal Plans' into the 'Tracker' for Today's Night and Tomorrow's Day.\n\nThis overwrites the tracker with the plans immediately.")) {
        return;
    }

    const btn = document.querySelector('button[onclick="triggerManualAutoEntry()"]');
    const originalText = btn.textContent;
    btn.textContent = "Running...";
    btn.disabled = true;

    try {
        // Call the RPC function with force_run = true
        const { error } = await supabase.rpc('handle_auto_meal_entry', { force_run: true });

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

// Global rotation variable
// Global variables for Badge Rotation
let statusCycleInterval = null;
let statusQueue = [];
let currentStatusIndex = 0;

async function updateEntryStatusIndicator() {
    const badge = document.getElementById('entryStatusBadge');
    if (!badge || !currentCycleId || !currentUser?.member_id) return;

    try {
        const today = new Date();
        const sessionDate = await getActiveSessionDate();
        const dateLabel = sessionDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).toUpperCase();
        
        // 1. FETCH DATA
        const [expRes, allMealsRes, myMealsRes, myDepsRes, duesRes] = await Promise.all([
            supabase.from('expenses').select('amount').eq('cycle_id', currentCycleId).eq('status', 'approved'),
            supabase.from('meals').select('day_count, night_count').eq('cycle_id', currentCycleId),
            supabase.from('meals').select('day_count, night_count').eq('member_id', currentUser.member_id).eq('cycle_id', currentCycleId),
            supabase.from('deposits').select('amount').eq('member_id', currentUser.member_id).eq('cycle_id', currentCycleId).neq('status', 'pending'),
            supabase.from('cycle_dues').select('due_amount, settled_amount').eq('member_id', currentUser.member_id).eq('to_cycle_id', currentCycleId).neq('status', 'settled')
        ]);

        // 2. CALCULATE CURRENT BALANCE
        const totalExp = expRes.data?.reduce((s, e) => s + parseFloat(e.amount), 0) || 0;
        const totalGlobalMeals = allMealsRes.data?.reduce((s, m) => s + (parseFloat(m.day_count) + parseFloat(m.night_count)), 0) || 1;
        const mealRate = totalExp / totalGlobalMeals;
        
        const myDeposit = myDepsRes.data?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;
        const myMealCost = (myMealsRes.data?.reduce((s, m) => s + (parseFloat(m.day_count) + parseFloat(m.night_count)), 0) || 0) * mealRate;
        
        // Use Math.ceil to avoid -0.01 issues
        const myBalance = Math.ceil(myDeposit - myMealCost);

        // 3. CALCULATE PREVIOUS DUE (Only negative amounts = Debt)
        const prevDebt = duesRes.data?.filter(d => d.due_amount < 0)
            .reduce((s, d) => s + (Math.abs(d.due_amount) - Math.abs(d.settled_amount)), 0) || 0;

        // 4. BUILD THE ROTATION QUEUE
        const newQueue = [];

      // CONDITION 1: Target
        const isToday = sessionDate.getDate() === today.getDate() && sessionDate.getMonth() === today.getMonth();
        newQueue.push({
            text: `TARGET: ${dateLabel} BAZAR`,
            class: isToday ? 'status-pending' : 'status-done'
        });

        // CONDITION 2 & 4: Add Current Debt Card if negative
        if (myBalance < -1) { 
             const debtAmount = toBn(Math.round(Math.abs(myBalance)));
              newQueue.push({
                text: `DEBT: -৳${debtAmount}`, // Added negative sign here
                class: 'status-debt'
            });
        }

        // CONDITION 3 & 4: Add Past Due Card if exists
         if (prevDebt > 1) {
            const pastDueAmount = toBn(Math.round(prevDebt));
            newQueue.push({
                text: `PAST DUE: -৳${pastDueAmount}`, // Added negative sign here
                class: 'status-due'
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
    const badge = document.getElementById('entryStatusBadge');
    badge.style.opacity = '1';
    badge.style.transform = 'translateY(0)';
    badge.textContent = state.text;
    badge.className = `entry-status-badge ${state.class}`;
}

function rotateStatusBadge() {
    const badge = document.getElementById('entryStatusBadge');
    if (!badge || statusQueue.length <= 1) return;

    // Transition Out
    badge.style.opacity = '0';
    badge.style.transform = 'translateY(-8px)';

    setTimeout(() => {
        currentStatusIndex = (currentStatusIndex + 1) % statusQueue.length;
        const state = statusQueue[currentStatusIndex];
        
        badge.textContent = state.text;
        badge.className = `entry-status-badge ${state.class}`;
        
        // Transition In
        badge.style.opacity = '1';
        badge.style.transform = 'translateY(0)';
    }, 600); // Duration of the "disappeared" state
}


async function loadSystemStatus() {
    const container = document.getElementById('systemStatusContent');
    const dateDisplay = document.getElementById('statusDateDisplay');
    
    // 1. Get Today's Date (Local/BD)
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const niceDate = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    
    if(dateDisplay) dateDisplay.textContent = niceDate;

    try {
        // 2. Fetch Log for Today
        const { data: log, error } = await supabase
            .from('system_logs')
            .select('*')
            .eq('log_date', todayStr)
            .maybeSingle();

        // 3. Render State
        if (log) {
            // === STATE: SUCCESS ===
            const runTime = new Date(log.executed_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            
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
            const targetTime24 = appConfig.auto_entry_time || '18:30';
            const [h, m] = targetTime24.split(':');
            const targetTime12 = new Date(0, 0, 0, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

            container.innerHTML = `
                <div class="status-box pending">
                    <div>
                        <div class="status-title">Waiting for Auto-Entry Meals are editable</div>
                        <div class="status-meta">
                            SCHEDULED TIME: ${targetTime12}
                        </div>
                    </div>
                </div>
            `;
        }

    } catch (err) {
        console.error("Status Load Error", err);
        container.innerHTML = '<div style="color:red; font-size:12px;">Failed to load status.</div>';
    }
}



// --- MOBILE MENU LOGIC ---
// --- UNIFIED MOBILE NAVIGATION & SIDEBAR LOGIC ---
// --- FIX: MOBILE SIDEBAR TRIGGER ---
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');

// Open Sidebar
if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Stops click from bubbling up
        sidebar.classList.add('mobile-active');
        sidebarOverlay.classList.add('active');
    });
}

// Close Sidebar when clicking the overlay
if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
        sidebar.classList.remove('mobile-active');
        sidebarOverlay.classList.remove('active');
    });
}

// Update navigateToPage to handle the 7-item nav correctly
async function navigateToPage(pageName) {
    // 1. Safety check: If pageName is undefined (like when clicking the Menu button), stop.
    if (!pageName) return;

    // 2. Hide all pages
    document.querySelectorAll('.page-content').forEach(p => p.classList.add('hidden'));
    
    // 3. Show target page
    const target = document.getElementById(pageName + 'Page');
    if (target) target.classList.remove('hidden');

    // 4. Update Active Classes on BOTH Navs
    document.querySelectorAll('.bottom-nav-link, .nav-link').forEach(link => {
        if (link.getAttribute('data-page') === pageName) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    // 5. Load Data (Persistence Check)
    loadPageData(pageName);

    // 6. Auto-close sidebar on mobile after selecting a page
    if (window.innerWidth <= 768) {
        sidebar.classList.remove('mobile-active');
        sidebarOverlay.classList.remove('active');
    }
}

// 5. Ensure "Menu" button in bottom nav doesn't stay 'active' permanently 
// and that it actually highlights the current page on load
window.addEventListener('load', () => {
    const activePage = getActivePage() || 'dashboard';
    document.querySelectorAll('.bottom-nav-link').forEach(link => {
        if (link.getAttribute('data-page') === activePage) {
            link.classList.add('active');
        }
    });
});

// 2. Auto-close Sidebar when clicking a link
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
            sidebar.classList.remove('mobile-active');
            const backdrop = document.getElementById('sidebarOverlay');
            if(backdrop) backdrop.classList.remove('active');
        }
    });
});



// ============================================
// CYCLE CLOSING & DUE MANAGEMENT
// ============================================
// ============================================
// REFINED CYCLE CLOSING LOGIC
// ============================================

const monthNames = ["January", "February", "March", "April", "May", "June", 
                    "July", "August", "September", "October", "November", "December"];

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
document.getElementById('closeMonthBtn').addEventListener('click', () => {
    const modal = document.getElementById('cycleCloseModal');
    modal.classList.add('active');
    
    // Reset UI
    document.getElementById('cycleValidationArea').style.display = 'block';
    document.getElementById('cycleCloseForm').style.display = 'none';
    document.getElementById('cycleCloseForm').style.opacity = '0';
    document.getElementById('cycleBlockedMsg').style.display = 'none';
    
    runCycleDiagnostics();
});

// 2. Main Diagnostic Function
async function runCycleDiagnostics() {
    const listEl = document.getElementById('checklistItems');
    const hintEl = document.getElementById('balanceFixHint');
    listEl.innerHTML = '<div class="loading">Calculating financials...</div>';
    hintEl.style.display = 'none';

    try {
        // --- STEP A: FETCH DATA ---
        const [pendDep, pendExp, allExp, allDep, activeDues] = await Promise.all([
            // 1. Pending Deposits Count
            supabase.from('deposits').select('*', { count: 'exact', head: true }).eq('cycle_id', currentCycleId).eq('status', 'pending'),
            // 2. Pending Expenses Count
            supabase.from('expenses').select('*', { count: 'exact', head: true }).eq('cycle_id', currentCycleId).eq('status', 'pending'),
            // 3. Approved Expenses Sum
            supabase.from('expenses').select('amount').eq('cycle_id', currentCycleId).eq('status', 'approved'),
            // 4. Approved Deposits Sum
            supabase.from('deposits').select('amount').eq('cycle_id', currentCycleId).neq('status', 'pending'),
            // 5. Outstanding Dues (From previous cycle into current)
            supabase.from('cycle_dues').select('*', { count: 'exact', head: true }).eq('to_cycle_id', currentCycleId).neq('status', 'settled')
        ]);

        // --- STEP B: CALCULATE ---
        const pendingDepositsCount = pendDep.count || 0;
        const pendingExpensesCount = pendExp.count || 0;
        const outstandingDuesCount = activeDues.count || 0;

        const totalExpenses = allExp.data?.reduce((sum, item) => sum + parseFloat(item.amount), 0) || 0;
        const totalDeposits = allDep.data?.reduce((sum, item) => sum + parseFloat(item.amount), 0) || 0;
        
        // Net Cash in Hand (Must be 0)
        const netBalance = totalDeposits - totalExpenses;
        // Allow a tiny margin for float rounding error (0.1)
        const isBalanceZero = Math.abs(netBalance) < 0.1; 

        // --- STEP C: RENDER CHECKLIST ---
        const checks = [
            { label: "Pending Deposits", val: pendingDepositsCount, pass: pendingDepositsCount === 0, text: pendingDepositsCount === 0 ? "0 (Clean)" : `${pendingDepositsCount} Pending` },
            { label: "Pending Expenses", val: pendingExpensesCount, pass: pendingExpensesCount === 0, text: pendingExpensesCount === 0 ? "0 (Clean)" : `${pendingExpensesCount} Pending` },
            { label: "Unsettled Past Dues", val: outstandingDuesCount, pass: outstandingDuesCount === 0, text: outstandingDuesCount === 0 ? "All Settled" : `${outstandingDuesCount} Unpaid` },
            { label: "Net Cash Balance", val: netBalance, pass: isBalanceZero, text: `৳${parseFloat(netBalance.toFixed(2))}` }
        ];

        let allPassed = true;
        let html = '';

        checks.forEach(c => {
            if (!c.pass) allPassed = false;
            html += `
                <div class="check-item">
                    <span class="check-label">${c.label}</span>
                    <span class="check-status ${c.pass ? 'status-pass' : 'status-fail'}">
                        ${c.pass ? '✔' : '✖'} ${c.text}
                    </span>
                </div>
            `;
        });

        listEl.innerHTML = html;

        // --- STEP D: HANDLE BALANCE FIX HINT ---
        if (!isBalanceZero) {
            hintEl.style.display = 'block';
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
            document.getElementById('cycleBlockedMsg').style.display = 'none';
            initNextCycleForm(); // Pre-fill dates
        } else {
            document.getElementById('cycleBlockedMsg').style.display = 'block';
        }

    } catch (err) {
        console.error("Diagnostic Error:", err);
        listEl.innerHTML = '<div style="color:red">Diagnostics failed. Check console.</div>';
    }
}

// 3. Helper to Show/Init the Form
function initNextCycleForm() {
    const form = document.getElementById('cycleCloseForm');
    form.style.display = 'block';
    
    // Small delay for animation
    setTimeout(() => form.style.opacity = '1', 50);

    // Populate Date Pickers (Same as before)
    const monthNames = ["January", "February", "March", "April", "May", "June", 
                    "July", "August", "September", "October", "November", "December"];
    
    const monthSelect = document.getElementById('newCycleMonth');
    const yearInput = document.getElementById('newCycleYear');
    
    // Fill Month Dropdown if empty
    if(monthSelect.options.length === 0) {
        monthSelect.innerHTML = monthNames.map((m, i) => `<option value="${i}">${m}</option>`).join('');
    }

    // Auto-select based on Old Cycle end date + 1 day
    const currentCycle = allCycles.find(c => c.id == currentCycleId);
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
    const month = parseInt(document.getElementById('newCycleMonth').value);
    const year = parseInt(document.getElementById('newCycleYear').value);
    
    // Calculate first and last day of selected month
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0); // Day 0 of next month is last day of this month
    
    // Format for inputs (YYYY-MM-DD)
    document.getElementById('newCycleStart').value = toLocalISO(firstDay);
    document.getElementById('newCycleEnd').value = toLocalISO(lastDay);
    document.getElementById('newCycleName').value = `${monthNames[month]} ${year}`;
}

// Attach change listeners
document.getElementById('newCycleMonth').addEventListener('change', updateCycleFields);
document.getElementById('newCycleYear').addEventListener('change', updateCycleFields);

// 3. Handle the Final Submission
document.getElementById('cycleCloseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!confirm("Are you sure you want to close the current cycle and create the new one?")) return;

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = "Processing Balances...";
    btn.disabled = true;

    try {
        const name = document.getElementById('newCycleName').value;
        const start = document.getElementById('newCycleStart').value;
        const end = document.getElementById('newCycleEnd').value;

        // A. Calculate final balances of the cycle being closed
        const balances = await calculateMemberBalances(currentCycleId);
        const balancesWithDues = balances.filter(b => b.balance !== 0);

        // B. Deactivate current cycle
        const { error: deacError } = await supabase
            .from('cycles')
            .update({ is_active: false })
            .eq('id', currentCycleId);
        if (deacError) throw deacError;

        // C. Create new cycle
        const { data: newCycle, error: cycError } = await supabase
            .from('cycles')
            .insert({ name, start_date: start, end_date: end, is_active: true })
            .select().single();
        if (cycError) throw cycError;

        // D. Forward Dues (Debt/Credit)
        if (balancesWithDues.length > 0) {
            const dueRecords = balancesWithDues.map(b => ({
                from_cycle_id: currentCycleId,
                to_cycle_id: newCycle.id,
                member_id: b.member_id,
                due_amount: b.balance,
                status: 'pending',
                settled_amount: 0
            }));
            const { error: dueError } = await supabase.from('cycle_dues').insert(dueRecords);
            if (dueError) throw dueError;
        }

        // Success Cleanup
        await logActivity(`Admin finalized cycle and started "${name}" (${start} to ${end})`, 'other');
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
        const { data: meals } = await supabase.from('meals').select('*').eq('cycle_id', cycleId);
      // Find this part in calculateMemberBalances(cycleId)
const { data: expenses } = await supabase
    .from('expenses')
    .select('*')
    .eq('cycle_id', cycleId)
    .eq('status', 'approved'); // <--- ADD THIS FILTER
       // Change the deposit query to:
const { data: deposits } = await supabase
    .from('deposits')
    .select('*')
    .eq('cycle_id', cycleId)
    .neq('status', 'pending'); // <--- ADD THIS FILTER

        // Calculate meal rate
        const totalExpense = expenses?.reduce((sum, e) => sum + parseFloat(e.amount), 0) || 0;
        const totalMeals = meals?.reduce((sum, m) => sum + parseFloat(m.day_count) + parseFloat(m.night_count), 0) || 0;
        const mealRate = totalMeals > 0 ? totalExpense / totalMeals : 0;

        // Calculate per-member balances
        const balances = [];
        allMembers.forEach(member => {
            const memberMeals = meals?.filter(m => m.member_id === member.id)
                .reduce((sum, m) => sum + parseFloat(m.day_count) + parseFloat(m.night_count), 0) || 0;
            
            const memberDeposits = deposits?.filter(d => d.member_id === member.id)
                .reduce((sum, d) => sum + parseFloat(d.amount), 0) || 0;

            const memberCost = memberMeals * mealRate;
            const balance = memberDeposits - memberCost;

            balances.push({
                member_id: member.id,
                member_name: member.name,
                balance: parseFloat(balance.toFixed(2))
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
        const card = document.getElementById('dueSettlementCard');
        if (card) card.style.display = 'none';
        return;
    }

    try {
        // Fetch dues for current cycle
        const { data: dues, error } = await supabase
            .from('cycle_dues')
            .select('*, members(name), from_cycle:cycles!cycle_dues_from_cycle_id_fkey(name)')
            .eq('to_cycle_id', currentCycleId)
            .order('due_amount', { ascending: true });

        if (error) throw error;

        const card = document.getElementById('dueSettlementCard');
        if (!card) return;

        // --- FILTER LOGIC (THE FIX) ---
        const activeDues = dues?.filter(d => {
            // 1. Ignore if explicitly marked 'settled'
            if (d.status === 'settled') return false;

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
            card.style.display = 'none';
            return;
        }

        card.style.display = 'block';

        // Split Data
        const debtors = activeDues.filter(d => d.due_amount < 0);
        const creditors = activeDues.filter(d => d.due_amount > 0);

        // Render Debtors (People who owe money)
        const debtorsList = document.getElementById('debtorsList');
        if (debtors.length === 0) {
            debtorsList.innerHTML = '<div style="text-align:center; padding:15px; font-size:11px; color:var(--text-secondary);">No significant debts</div>';
        } else {
            debtorsList.innerHTML = debtors.map(d => renderDueItem(d, 'debtor')).join('');
        }

        // Render Creditors (People owed money)
        const creditorsList = document.getElementById('creditorsList');
        if (creditors.length === 0) {
            creditorsList.innerHTML = '<div style="text-align:center; padding:15px; font-size:11px; color:var(--text-secondary);">No pending credits</div>';
        } else {
            creditorsList.innerHTML = creditors.map(d => renderDueItem(d, 'creditor')).join('');
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

    const statusClass = due.status === 'pending' ? 'due-status-pending' : 
                       due.status === 'settling' ? 'due-status-settling' : 
                       'due-status-settled';

    return `
    <div class="due-item ${type}">
        <div class="due-item-header">
            <div class="due-item-name">${due.members.name}</div>
            <div class="due-item-amount ${type === 'debtor' ? 'balance-negative' : 'balance-positive'}">
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

// Update loadSummary to include due settlement
const originalLoadSummary = loadSummary;
loadSummary = async function() {
    await originalLoadSummary();
    await loadDueSettlement();
};


async function checkGlobalBalanceWarning() {
    if (!currentUser || !currentUser.member_id || !currentCycleId) return;

    try {
        // 1. Fetch data needed for Meal Rate
        const { data: expenses } = await supabase.from('expenses')
            .select('amount').eq('cycle_id', currentCycleId).eq('status', 'approved');
        
        const { data: allMeals } = await supabase.from('meals')
            .select('day_count, night_count').eq('cycle_id', currentCycleId);

        // 2. Fetch User Specific data
        const { data: userMeals } = await supabase.from('meals')
            .select('day_count, night_count').eq('member_id', currentUser.member_id).eq('cycle_id', currentCycleId);
        
        const { data: userDeposits } = await supabase.from('deposits')
            .select('amount').eq('member_id', currentUser.member_id).eq('cycle_id', currentCycleId).neq('status', 'pending');

        // 3. Perform Calculations
        const totalExp = expenses?.reduce((sum, e) => sum + parseFloat(e.amount), 0) || 0;
        const totalGlobalMeals = allMeals?.reduce((sum, m) => sum + parseFloat(m.day_count) + parseFloat(m.night_count), 0) || 0;
        const mealRate = totalGlobalMeals > 0 ? totalExp / totalGlobalMeals : 0;

        const totalUserMeals = userMeals?.reduce((sum, m) => sum + parseFloat(m.day_count) + parseFloat(m.night_count), 0) || 0;
        const totalUserDeposit = userDeposits?.reduce((sum, d) => sum + parseFloat(d.amount), 0) || 0;
        
        const currentBalance = totalUserDeposit - (totalUserMeals * mealRate);

        // 4. Update Header UI
        const header = document.querySelector('.app-header');
        const nameDisplay = document.getElementById('headerUserName');

        if (currentBalance < 0) {
            header.classList.add('balance-warning');
            // Optional: Add a small warning icon next to the name
            if (!nameDisplay.innerHTML.includes('⚠️')) {
                nameDisplay.innerHTML = '⚠️ ' + nameDisplay.innerHTML;
            }
        } else {
            header.classList.remove('balance-warning');
            // Remove warning icon if balance is recovered
            nameDisplay.innerHTML = nameDisplay.innerHTML.replace('⚠️ ', '');
        }
    } catch (err) {
        console.error("Balance Warning Check Error:", err);
    }
}


// 2. Save logic (triggered on change)
async function saveDayMenu(dayIndex) {
    const night = document.getElementById(`night-${dayIndex}`).value;
    const day = document.getElementById(`day-${dayIndex}`).value;
    
    // Visual feedback: briefly highlight the inputs
    const inputs = [document.getElementById(`night-${dayIndex}`), document.getElementById(`day-${dayIndex}`)];
    
    try {
        const { error } = await supabase
            .from('weekly_menus')
            .update({ night_menu: night, day_menu: day })
            .eq('day_index', dayIndex);

        if (error) throw error;

        // Success: flash green border
        inputs.forEach(i => {
            i.style.borderColor = 'var(--success-color)';
            setTimeout(() => i.style.borderColor = '', 1000);
        });

        // Update dashboard if visible
        if (!document.getElementById('dashboardPage').classList.contains('hidden')) {
            updateDashboardMealPlan();
        }
    } catch (err) {
        // Error: flash red border
        inputs.forEach(i => {
            i.style.borderColor = 'var(--danger-color)';
            setTimeout(() => i.style.borderColor = '', 1000);
        });
        showNotification("Auto-save failed", "error");
    }
}


// --- Helper: Convert Date to Bengali Format ---
// Output: '১২ জানুয়ারি সোমবার'
function formatBengaliDate(dateObj) {
    const bnMonths = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"];
    const bnDays = ["রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার", "শনিবার"];
    
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
            supabase.from('weekly_menus').select('*').eq('day_index', now.getDay()).maybeSingle(),
            supabase.from('members').select('id, default_day_on, default_night_on'),
            supabase.from('meal_plans').select('*').in('plan_date', [todayStr, tomorrowStr])
        ]);

        const members = membersRes.data || [];
        const plans = plansRes.data || [];
        const menu = menuRes.data;

        // 3. Calculate Totals
        let nightSum = 0; // Today Night
        let daySum = 0;   // Tomorrow Day

        members.forEach(m => {
            // Check for tonight's override
            const nPlan = plans.find(p => p.member_id === m.id && p.plan_date === todayStr);
            // Check for tomorrow morning's override
            const dPlan = plans.find(p => p.member_id === m.id && p.plan_date === tomorrowStr);

            nightSum += (nPlan ? Number(nPlan.night_count) : (m.default_night_on ? 1 : 0));
            daySum += (dPlan ? Number(dPlan.day_count) : (m.default_day_on ? 1 : 0));
        });

        // 4. Update Visuals
        
        // Dates (Using the new Bengali Formatter)
        document.getElementById('planNightDate').textContent = formatBengaliDate(now);
        document.getElementById('planDayDate').textContent = formatBengaliDate(tomorrow);

        // Counts (Using toBn for Bengali Digits)
        document.getElementById('planNightTotal').textContent = toBn(nightSum);
        document.getElementById('planDayTotal').textContent = toBn(daySum);

        // Menus
        if (menu) {
            document.getElementById('planNightMenu').textContent = menu.night_menu || "মেনু নেই";
            document.getElementById('planDayMenu').textContent = menu.day_menu || "মেনু নেই";
        }

    } catch (err) {
        console.error("Dashboard calculation failed:", err);
    }
}


/* =========================================
   MOBILE BOTTOM SHEET LOGIC (UPDATED)
   ========================================= */

let activeSheetTab = 'expense';

function openBottomSheet() {
    const overlay = document.getElementById('sheetOverlay');
    const sheet = document.getElementById('sheetModal');
    
    // 1. Populate Members (Keep defaults)
    const select = document.getElementById('sheetMember');
    const existingVal = select.value;
    select.innerHTML = '';
    
    allMembers.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.text = m.name;
        select.appendChild(opt);
    });

    if (currentUser && currentUser.member_id) {
        select.value = currentUser.member_id;
    }

    // 2. Set Date
    const now = new Date();
    const localDate = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    document.getElementById('sheetDate').value = localDate;

    // 3. Open
    overlay.classList.add('active');
    sheet.classList.add('active');
    
    // Default to Expense
    switchSheetTab('expense');
    
    // Auto-focus amount (delayed for animation)
    setTimeout(() => {
        document.getElementById('sheetAmount').focus();
    }, 400);
}

function closeBottomSheet() {
    document.getElementById('sheetOverlay').classList.remove('active');
    document.getElementById('sheetModal').classList.remove('active');
    document.activeElement.blur(); // Close keyboard
    
    setTimeout(() => {
        document.getElementById('sheetAmount').value = '';
        document.getElementById('sheetDesc').value = '';
        document.getElementById('sheetNotes').value = '';
        document.querySelectorAll('.sheet-chip').forEach(c => c.classList.remove('selected'));
    }, 300);
}

// --- NEW: THEME SWITCHER & VISUAL UPDATES ---
function switchSheetTab(tab) {
    activeSheetTab = tab;
    const sheet = document.getElementById('sheetModal');
    const title = document.getElementById('sheetMainTitle');
    const btn = document.getElementById('sheetSubmitBtn');
    
    // Toggle Tab Active Classes
    document.getElementById('tabExpense').className = `sheet-tab ${tab === 'expense' ? 'active' : ''}`;
    document.getElementById('tabDeposit').className = `sheet-tab ${tab === 'deposit' ? 'active' : ''}`;
    
    // Toggle Sheet Theme Class (Handles Colors)
    if (tab === 'expense') {
        sheet.classList.remove('sheet-theme-deposit');
        sheet.classList.add('sheet-theme-expense');
        
        title.textContent = "New Expense";
        btn.textContent = "Save Expense";
        
        document.getElementById('expenseExtras').style.display = 'block';
        document.getElementById('depositExtras').style.display = 'none';
        
    } else {
        sheet.classList.remove('sheet-theme-expense');
        sheet.classList.add('sheet-theme-deposit');
        
        title.textContent = "New Deposit";
        btn.textContent = "Save Deposit";
        
        document.getElementById('expenseExtras').style.display = 'none';
        document.getElementById('depositExtras').style.display = 'block';
    }
}

// --- KEYBOARD FIX: Ensure input is visible when focused ---
function ensureVisible(element) {
    setTimeout(() => {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
}

// Chip Helpers
function selectChip(text) {
    document.getElementById('sheetDesc').value = text;
    document.querySelectorAll('#expenseExtras .sheet-chip').forEach(c => c.classList.remove('selected'));
    event.target.classList.add('selected');
}

function selectDepositType(type) {
    document.getElementById('sheetDepType').value = type;
    document.getElementById('sheetLabel').value = type === 'charge' ? 'Reduction' : 'Deposit';
    
    document.querySelectorAll('#depositExtras .sheet-chip').forEach(c => c.classList.remove('selected'));
    event.target.classList.add('selected');
}

// Submit Logic
async function submitMobileEntry() {
    const btn = document.getElementById('sheetSubmitBtn');
    const originalText = btn.textContent;
    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
        const amountVal = parseFloat(document.getElementById('sheetAmount').value);
        const date = document.getElementById('sheetDate').value;
        const memberId = document.getElementById('sheetMember').value;
        const notes = document.getElementById('sheetNotes').value;

        if (!amountVal || amountVal <= 0) throw new Error("Please enter a valid amount");
        if (!memberId) throw new Error("Please select a member");

        if (activeSheetTab === 'expense') {
            // EXPENSE LOGIC
            const desc = document.getElementById('sheetDesc').value || "General Expense";
            const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');
            const status = isAdmin ? 'approved' : 'pending';

            const { error } = await supabase.from('expenses').insert({
                cycle_id: currentCycleId,
                expense_date: date,
                member_id: memberId,
                description: desc,
                amount: amountVal,
                status: status
            });
            if (error) throw error;
            
            // Log & Refresh
            const actorName = currentUser.members?.name || currentUser.name;
            await logActivity(`New Expense: ৳${amountVal} (${desc}) by ${actorName}`, 'expense');
            showNotification(isAdmin ? "Expense Added" : "Request Sent", "success");
            
            if (typeof loadExpenses === 'function') loadExpenses();

        } else {
            // DEPOSIT LOGIC
            const type = document.getElementById('sheetDepType').value;
            const label = document.getElementById('sheetLabel').value;
            const finalAmount = type === 'charge' ? -Math.abs(amountVal) : Math.abs(amountVal);
            const isAdmin = (currentUser.role === 'admin' || currentUser.role === 'manager');

            if (isAdmin) {
                // Admin Settlement Logic
                try {
                     const { error } = await supabase.rpc('process_deposit_with_settlement', {
                        p_member_id: memberId, p_cycle_id: parseInt(currentCycleId),
                        p_amount: finalAmount, p_label: label, p_notes: notes
                    });
                     if (error) throw error;
                } catch (e) {
                     await processDepositWithClientSideSettlement(memberId, currentCycleId, finalAmount, label, notes);
                }
                showNotification("Transaction Saved", "success");
            } else {
                // User Request
                const { error } = await supabase.from('deposits').insert({
                    cycle_id: parseInt(currentCycleId), member_id: memberId,
                    amount: finalAmount, label: label, notes: notes, status: 'pending'
                });
                if (error) throw error;
                showNotification("Deposit Requested", "info");
            }
            if (typeof loadDeposits === 'function') loadDeposits();
        }

        // Global Refresh & Close
        if (typeof loadDashboard === 'function') loadDashboard();
        closeBottomSheet();

    } catch (err) {
        showNotification(err.message, "error");
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}


// Cleanup intervals when page is hidden to prevent background processing
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Clear intervals when tab is inactive
        if (statusCycleInterval) {
            clearInterval(statusCycleInterval);
            statusCycleInterval = null;
        }
    } else {
        // Restart when tab becomes active
        updateEntryStatusIndicator();
        checkGlobalBalanceWarning();
    }
});

// Clear intervals on page unload
window.addEventListener('beforeunload', () => {
    if (statusCycleInterval) {
        clearInterval(statusCycleInterval);
    }
});

// Open the existing Edit Member modal, but configured for the current user
function openChangePasswordModal() {
    if (!currentUser || !currentUser.member_id) return;

    // Reuse your existing Edit Member Modal logic
    document.getElementById('editMemberId').value = currentUser.member_id;
    document.getElementById('editUserId').value = currentUser.id; // Supabase Auth ID
    document.getElementById('editMemberName').value = currentUser.name;
    document.getElementById('editMemberPassword').value = ''; // Clean field
    
    // Change Title to look like a User Action
    document.querySelector('#editMemberModal .modal-title').textContent = "Change My Password";
    
    document.getElementById('editMemberModal').classList.add('active');
}
