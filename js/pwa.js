// MealCal Pro — Android back button, service worker, install prompt
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

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

    // 0. App dialogs and full-screen panels (statement, archive, audit log)
    if (typeof closeTopDialog === "function" && closeTopDialog()) handled = true;
    if (!handled && typeof closePanel === "function" && closePanel()) handled = true;

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
      dlog("Exiting App...");
    }
  });
}

if ("serviceWorker" in navigator) {
  // When a new version takes over, reload once so everyone runs the code the database expects
  const hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloadedForUpdate) return;
    reloadedForUpdate = true;
    // Don't interrupt someone typing in the entry sheet or a dialog
    const busy = () => document.getElementById("sheetModal")?.classList.contains("active") || document.querySelector(".ui-dialog-backdrop");
    const go = () => (busy() ? setTimeout(go, 3000) : _hardReload());
    showNotification("Updating MealCal Pro to the latest version…", "info");
    setTimeout(go, 1500);
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        reg.update(); // check for a newer version on every launch
        // …and whenever the app comes back to the foreground
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) reg.update().catch(() => {});
        });
      })
      .catch((err) => console.warn("Service worker registration failed:", err));
  });
}

// ============================================
// PWA INSTALL PROMPT SYSTEM
// ============================================

let _pwaInstallEvent = null; // Store the deferred event
let _bannerDismissTimer = null;

// 1. Capture the install event as early as possible
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // Stop the browser mini-bar from showing automatically
  _pwaInstallEvent = e;

  // Show sidebar Install button
  const menuItem = document.getElementById("installAppMenuItem");
  if (menuItem) menuItem.style.display = "block";

  // Auto-show the banner after 2 seconds (non-intrusive)
  setTimeout(() => showInstallBanner(), 2000);

  dlog("✅ PWA install prompt captured and ready.");
});

// 2. Show the floating install banner
function showInstallBanner() {
  const banner = document.getElementById("pwaInstallBanner");
  if (!banner || banner.dataset.dismissed === "true") return;

  banner.style.display = "flex";

  // Auto-dismiss after 12 seconds if user ignores it
  _bannerDismissTimer = setTimeout(() => {
    hideBannerSilently();
  }, 12000);
}

// 3. User clicks "Install ↓" — trigger the native browser prompt
async function triggerPWAInstall() {
  if (_pwaInstallEvent) {
    // Native prompt available (Chrome, Edge, Android)
    _pwaInstallEvent.prompt();
    const { outcome } = await _pwaInstallEvent.userChoice;
    dlog("PWA install outcome:", outcome);

    if (outcome === "accepted") {
      showNotification("🎉 MealCal Pro installed successfully!", "success");
      _pwaInstallEvent = null;
      hideBannerSilently();
      const menuItem = document.getElementById("installAppMenuItem");
      if (menuItem) menuItem.style.display = "none";
    }
  } else {
    // Fallback for iOS Safari / already installed
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.navigator.standalone === true ||
                         window.matchMedia("(display-mode: standalone)").matches;

    if (isStandalone) {
      showNotification("✅ MealCal Pro is already installed!", "info");
    } else if (isIOS) {
      showNotification(
        '📱 To install on iOS: tap the Share icon ⬆️ → "Add to Home Screen"',
        "info",
        6000
      );
    } else {
      showNotification(
        "ℹ️ To install: open browser menu → 'Install App' or 'Add to Home Screen'",
        "info",
        6000
      );
    }
    hideBannerSilently();
  }
}

// 4. User clicks ✕
function dismissInstallBanner() {
  const banner = document.getElementById("pwaInstallBanner");
  if (banner) banner.dataset.dismissed = "true";
  hideBannerSilently();
}

function hideBannerSilently() {
  clearTimeout(_bannerDismissTimer);
  const banner = document.getElementById("pwaInstallBanner");
  if (!banner) return;
  banner.style.opacity = "0";
  banner.style.transition = "opacity 0.3s ease";
  setTimeout(() => { banner.style.display = "none"; banner.style.opacity = ""; }, 320);
}

// 5. Clean up after successful installation
window.addEventListener("appinstalled", () => {
  dlog("✅ App installed via appinstalled event.");
  _pwaInstallEvent = null;
  showNotification("🎉 MealCal Pro has been added to your home screen!", "success");
  hideBannerSilently();
  const menuItem = document.getElementById("installAppMenuItem");
  if (menuItem) menuItem.style.display = "none";
});
