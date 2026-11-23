// MealCal Pro — Shared UI primitives: dialogs (confirm / prompt / alert), action toasts, theme.
// (Classic script; shares global scope. Loaded right after utils.js.)

// ============================================
// DIALOGS — promise based replacements for alert()/confirm()/prompt()
// ============================================
function _uiDialog({ title, message = "", icon = "", tone = "default", confirmText = "OK", cancelText = "Cancel",
                     input = null, showCancel = true, danger = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "ui-dialog-backdrop";
    wrap.innerHTML = `
      <div class="ui-dialog ui-tone-${tone}" role="dialog" aria-modal="true" aria-labelledby="uiDlgTitle">
        ${icon ? `<div class="ui-dialog-icon">${icon}</div>` : ""}
        <h3 class="ui-dialog-title" id="uiDlgTitle">${escapeHtml(title)}</h3>
        ${message ? `<div class="ui-dialog-msg">${escapeHtml(message).replace(/\n/g, "<br>")}</div>` : ""}
        ${input ? `<input class="ui-dialog-input" type="${input.type || "text"}" placeholder="${escapeHtml(input.placeholder || "")}" value="${escapeHtml(input.value || "")}">` : ""}
        <div class="ui-dialog-actions">
          ${showCancel ? `<button type="button" class="ui-btn ui-btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>` : ""}
          <button type="button" class="ui-btn ${danger ? "ui-btn-danger" : "ui-btn-primary"}" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("open"));
    const inputEl = wrap.querySelector(".ui-dialog-input");
    const okBtn = wrap.querySelector('[data-act="ok"]');
    (inputEl || okBtn).focus();

    const close = (val) => {
      wrap.classList.remove("open");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => wrap.remove(), 180);
      if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (_) {}
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(input ? null : false); }
      if (e.key === "Enter" && (inputEl ? document.activeElement === inputEl : true)) { e.preventDefault(); okBtn.click(); }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "ok") close(input ? inputEl.value : true);
      else if (act === "cancel" || e.target === wrap) close(input ? null : false);
    });
    // Let the Android back button close the dialog
    wrap._uiClose = () => close(input ? null : false);
  });
}

/** await uiConfirm("Approve?", "details") → true/false */
function uiConfirm(title, message = "", opts = {}) {
  return _uiDialog({ title, message, icon: opts.icon || (opts.danger ? "⚠️" : "❓"), confirmText: opts.confirmText || "Confirm",
                     cancelText: opts.cancelText || "Cancel", danger: !!opts.danger, tone: opts.danger ? "danger" : "default" });
}
/** await uiPrompt("Reason?", "", {placeholder}) → string or null */
function uiPrompt(title, message = "", opts = {}) {
  return _uiDialog({ title, message, icon: opts.icon || "✏️", confirmText: opts.confirmText || "Save", input: { type: opts.type, placeholder: opts.placeholder, value: opts.value } });
}
/** await uiAlert("Done", "details") */
function uiAlert(title, message = "", opts = {}) {
  return _uiDialog({ title, message, icon: opts.icon || "ℹ️", confirmText: opts.confirmText || "OK", showCancel: false });
}
function closeTopDialog() {
  const all = document.querySelectorAll(".ui-dialog-backdrop.open");
  const top = all[all.length - 1];
  if (top && top._uiClose) { top._uiClose(); return true; }
  return false;
}

// ============================================
// ACTION TOAST — toast with a button (e.g. Undo)
// ============================================
function showActionToast(message, actionLabel, onAction, ms = 6000) {
  const t = document.createElement("div");
  t.className = "ui-action-toast";
  t.innerHTML = `<span class="ui-action-msg">${escapeHtml(message)}</span><button type="button" class="ui-action-btn">${escapeHtml(actionLabel)}</button><span class="ui-action-bar" style="animation-duration:${ms}ms"></span>`;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("open"));
  let done = false;
  const close = () => { if (done) return; done = true; t.classList.remove("open"); setTimeout(() => t.remove(), 250); };
  t.querySelector(".ui-action-btn").addEventListener("click", async () => { close(); try { await onAction(); } catch (e) { showNotification(e.message, "error"); } });
  setTimeout(close, ms);
  return close;
}

// ============================================
// THEME — light / dark / system, remembered per device
// ============================================
function getThemePref() {
  try { return localStorage.getItem("mc_theme") || "system"; } catch (_) { return "system"; }
}
function applyTheme(pref = getThemePref()) {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0b1220" : "#e7eaf0");
  document.querySelectorAll("[data-theme-choice]").forEach((b) => b.classList.toggle("active", b.dataset.themeChoice === pref));
  syncThemeSwitch();
}
function setThemePref(pref) {
  try { localStorage.setItem("mc_theme", pref); } catch (_) {}
  applyTheme(pref);
}
// Sidebar switch: on = dark, off = light (an explicit choice overrides "follow device")
function toggleDarkMode() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  setThemePref(isDark ? "light" : "dark");
}
function syncThemeSwitch() {
  const sw = document.getElementById("themeSwitch");
  if (!sw) return;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  sw.setAttribute("aria-checked", String(dark));
  const icon = document.getElementById("themeSwitchIcon");
  if (icon) icon.textContent = dark ? "🌙" : "☀️";
}
function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  setThemePref(next);
  showNotification(`Theme: ${next === "system" ? "Follow device" : next[0].toUpperCase() + next.slice(1)}`, "info");
}
applyTheme();
try {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (getThemePref() === "system") applyTheme(); });
} catch (_) {}

// Small helpers used across pages
function isStaff() { return currentUser?.role === "admin" || currentUser?.role === "manager"; }
function isAdminUser() { return currentUser?.role === "admin"; }
/** Friendly text for a Supabase / Postgres error */
function niceError(err) {
  const msg = err?.message || String(err || "Something went wrong");
  if (/row-level security|permission denied|42501/i.test(msg)) return "You don't have permission for that.";
  if (/Failed to fetch|NetworkError|timeout/i.test(msg)) return "Network problem — check your connection and try again.";
  return msg.replace(/^.*?ERROR:\s*/i, "");
}
