// MealCal Pro — Formatting + HTML-escaping helpers
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Escape user-supplied text before putting it inside innerHTML / attributes.
 * Data is stored raw in the database; escaping happens only at render time.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape text used as a single-quoted JS string inside an inline onclick="" attribute. */
function escapeJsArg(value) {
  return escapeHtml(String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
}

/** Plain-text money: "৳1,250" / "৳1,250.50" / "−৳40". Safe for textContent, toasts and dialogs. */
function formatTk(amount) {
  const n = Number(amount || 0);
  const abs = Math.abs(n);
  const whole = Math.round(abs * 100) % 100 === 0;
  const s = abs.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return (n < 0 ? "−৳" : "৳") + s;
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
