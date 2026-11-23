// MealCal Pro — Insights: reminders, budget alerts, charts, personal statement,
// cycle archive and the admin audit log.
// (Classic script; shares global scope. All maths matches the Summary page:
//  balance = approved deposits − (meals incl. guests × meal rate).)

// ============================================
// DATA: one cycle, fully calculated
// ============================================
async function getCycleData(cycleId) {
  cycleId = parseInt(cycleId);
  const cycle = allCycles.find((c) => c.id == cycleId);
  const [mealsRes, expRes, depRes, memRes, duesRes] = await Promise.all([
    supabase.from("meals").select("member_id, meal_date, day_count, night_count, guest_day_count, guest_night_count").eq("cycle_id", cycleId),
    supabase.from("expenses").select("id, member_id, amount, expense_date, category, description").eq("cycle_id", cycleId).eq("status", "approved"),
    supabase.from("deposits").select("id, member_id, amount, label, notes, created_at, parent_deposit_id").eq("cycle_id", cycleId).neq("status", "pending"),
    supabase.from("members").select("id, name, archived_from_cycle_id, is_approved").eq("is_approved", true).order("name"),
    supabase.from("cycle_dues").select("member_id, due_amount, settled_amount, status, from_cycle_id").eq("to_cycle_id", cycleId),
  ]);
  const meals = mealsRes.data || [], expenses = expRes.data || [], deposits = depRes.data || [], dues = duesRes.data || [];
  const boundary = await fetchBoundaryDayMeals(cycleId);
  const start = cycle?.start_date;
  const totalExpense = expenses.reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalMeals = adjustMealTotal(meals, boundary, start);
  const rate = totalMeals > 0 ? totalExpense / totalMeals : 0;

  const members = (memRes.data || [])
    .map((m) => {
      const mm = meals.filter((x) => x.member_id === m.id);
      const total = adjustMealTotal(meals, boundary, start, m.id);
      const guest = mm.reduce((s, x) => s + Number(x.guest_day_count || 0) + Number(x.guest_night_count || 0), 0);
      const dep = deposits.filter((d) => d.member_id === m.id).reduce((s, d) => s + Number(d.amount || 0), 0);
      const bazar = expenses.filter((e) => e.member_id === m.id).reduce((s, e) => s + Number(e.amount || 0), 0);
      const due = dues.find((d) => d.member_id === m.id);
      return {
        id: m.id, name: m.name,
        day: mm.reduce((s, x) => s + Number(x.day_count || 0), 0),
        night: mm.reduce((s, x) => s + Number(x.night_count || 0), 0),
        guest, meals: total, ownMeals: total - guest,
        deposits: dep, cost: total * rate, guestCost: guest * rate, balance: dep - total * rate, bazar,
        carriedDue: due ? Number(due.due_amount) : 0,
        active: !m.archived_from_cycle_id || cycleId < m.archived_from_cycle_id,
      };
    })
    .filter((m) => m.active || m.meals > 0 || Math.abs(m.deposits) > 0.01);

  return { cycleId, cycle, meals, expenses, deposits, dues, totalExpense, totalMeals, rate, members };
}

// ============================================
// 1. DASHBOARD — reminders + budget alerts
// ============================================
async function renderDashInsights() {
  const box = document.getElementById("dashInsights");
  if (!box || !currentCycleId) return;
  try {
    const d = await getCycleData(currentCycleId);
    const tips = [];
    const me = d.members.find((m) => m.id === currentUser?.member_id);
    const meRow = (allMembers || []).find((m) => m.id === currentUser?.member_id);

    // Reminders
    if (meRow?.meal_shutdown_at) {
      tips.push({ tone: "danger", icon: "⛔", text: `Your meals are OFF since ${formatDateTimeFull(meRow.meal_shutdown_at)}.`, action: ["Start meals", `toggleMealPower(${meRow.id}, true)`] });
    }
    if (me && me.balance < -1) {
      tips.push({ tone: "warn", icon: "💸", text: `Your balance is ${formatTk(me.balance)}. Please deposit to keep the mess running.`, action: ["Add deposit", "openBottomSheet('deposit')"] });
    }
    const lockMsg = lockReminder();
    if (lockMsg) tips.push(lockMsg);
    if (isStaff()) {
      const pendDep = (window._depositCache || []).filter((x) => x.status === "pending").length;
      const pendExp = (window._expenseCache || []).filter((x) => x.status === "pending").length;
      if (pendingMembers?.length) tips.push({ tone: "info", icon: "🙋", text: `${pendingMembers.length} new signup${pendingMembers.length > 1 ? "s" : ""} waiting for approval.`, action: ["Review", "document.getElementById('dashPendingApprovals').scrollIntoView({behavior:'smooth'})"] });
      if (pendDep + pendExp) tips.push({ tone: "info", icon: "⏳", text: `${pendDep} deposit and ${pendExp} expense request${pendDep + pendExp > 1 ? "s" : ""} to review.`, action: ["Open", pendDep ? "navigateToPage('deposits')" : "navigateToPage('expenses')"] });
    }

    // Budget: last 7 days vs the 7 before
    const today = toLocalISO(new Date());
    const daysAgo = (n) => toLocalISO(new Date(Date.now() - n * 86400000));
    const sumRange = (from, to) => d.expenses.filter((e) => e.expense_date > from && e.expense_date <= to).reduce((s, e) => s + Number(e.amount), 0);
    const last7 = sumRange(daysAgo(7), today), prev7 = sumRange(daysAgo(14), daysAgo(7));
    if (prev7 > 0 && last7 > prev7 * 1.25) {
      tips.push({ tone: "warn", icon: "📈", text: `Bazar this week is ${Math.round((last7 / prev7 - 1) * 100)}% higher than last week (${formatCurrencyRound(last7)} vs ${formatCurrencyRound(prev7)}).` });
    }

    // Projection to the end of the cycle
    let projection = "";
    if (d.cycle) {
      const start = parseLocalDate(d.cycle.start_date), end = parseLocalDate(d.cycle.end_date);
      const totalDays = Math.round((end - start) / 86400000) + 1;
      const elapsed = Math.min(totalDays, Math.max(1, Math.round((parseLocalDate(today) - start) / 86400000) + 1));
      const projSpend = (d.totalExpense / elapsed) * totalDays;
      const daily = d.totalExpense / elapsed;
      projection = `
        <div class="ins-stats">
          <div class="ins-stat"><div class="ins-k">Meal rate now</div><div class="ins-v">${formatTk(d.rate)}</div></div>
          <div class="ins-stat"><div class="ins-k">Avg bazar / day</div><div class="ins-v">${formatCurrencyRound(daily)}</div></div>
          <div class="ins-stat"><div class="ins-k">Projected cycle spend</div><div class="ins-v">${formatCurrencyRound(projSpend)}</div></div>
          <div class="ins-stat"><div class="ins-k">Day of cycle</div><div class="ins-v">${elapsed}/${totalDays}</div></div>
        </div>`;
    }

    box.innerHTML = `
      <section class="mc-card ins-card">
        <div class="mc-card-head">
          <h3 class="mc-card-title">💡 Today</h3>
          <button type="button" class="ui-btn ui-btn-ghost ui-btn-sm" onclick="openStatement()">📄 My statement</button>
        </div>
        ${tips.length ? `<div class="ins-tips">${tips.map((t) => `
          <div class="ins-tip tone-${t.tone}">
            <span class="ins-tip-icon">${t.icon}</span><span class="ins-tip-text">${escapeHtml(t.text)}</span>
            ${t.action ? `<button type="button" class="ui-btn ui-btn-sm ${t.tone === "danger" ? "ui-btn-primary" : "ui-btn-ghost"}" onclick="${t.action[1]}">${escapeHtml(t.action[0])}</button>` : ""}
          </div>`).join("")}</div>` : `<div class="ins-allgood">✅ All good — nothing needs your attention.</div>`}
        ${projection}
      </section>`;
  } catch (e) {
    console.warn("insights", e);
  }
}

function lockReminder() {
  if (!appConfig?.lock_time_start || !appConfig?.lock_time_end) return null;
  const now = new Date();
  const toDate = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  const start = toDate(appConfig.lock_time_start), end = toDate(appConfig.lock_time_end);
  if (now >= start && now <= end) {
    return { tone: "info", icon: "🔒", text: `Bazar time — tonight's meals are locked until ${convertTo12Hour(appConfig.lock_time_end)}.` };
  }
  const mins = Math.round((start - now) / 60000);
  if (mins > 0 && mins <= 90) {
    return { tone: "warn", icon: "⏰", text: `Meal changes for tonight lock at ${convertTo12Hour(appConfig.lock_time_start)} (in ${mins} min).`, action: ["My schedule", "navigateToPage('profile')"] };
  }
  return null;
}
// Re-check reminders every minute while the dashboard is open
// (The dashboard "Today" card was removed; renderDashInsights() stays available but is no longer scheduled.)

// ============================================
// 2. CHARTS (Summary page) — lightweight inline SVG
// ============================================
let _chartTab = "daily";

async function renderSummaryInsights(cycleId = currentCycleId) {
  let box = document.getElementById("summaryInsights");
  if (!box) {
    const page = document.getElementById("summaryPage");
    if (!page) return;
    box = document.createElement("div");
    box.id = "summaryInsights";
    const anchor = page.querySelector(".table-container, .summary-table-wrap, #summaryTable")?.closest("div");
    page.insertBefore(box, anchor || null);
  }
  const d = await getCycleData(cycleId);
  box.innerHTML = `
    <section class="mc-card">
      <div class="mc-card-head">
        <h3 class="mc-card-title">📊 Insights</h3>
        <div class="seg" role="tablist">
          ${[["daily", "Daily spend"], ["cat", "Categories"], ["rate", "Meal rate"], ["members", "Members"]]
            .map(([k, l]) => `<button type="button" role="tab" class="seg-btn${_chartTab === k ? " active" : ""}" onclick="_chartTab='${k}';renderSummaryInsights()">${l}</button>`).join("")}
        </div>
      </div>
      <div class="chart-box">${chartFor(_chartTab, d)}</div>
    </section>`;
}

function chartFor(tab, d) {
  if (tab === "daily") {
    const byDay = {};
    d.expenses.forEach((e) => (byDay[e.expense_date] = (byDay[e.expense_date] || 0) + Number(e.amount)));
    const days = Object.keys(byDay).sort();
    if (!days.length) return emptyChart("No approved expenses yet.");
    return barChartSVG(days.map((k) => ({ label: parseLocalDate(k).getDate(), title: `${_dLabel(k)}: ${formatCurrencyRound(byDay[k])}`, value: byDay[k] })), { money: true });
  }
  if (tab === "cat") {
    const byCat = {};
    d.expenses.forEach((e) => { const c = e.category || "Bazar"; byCat[c] = (byCat[c] || 0) + Number(e.amount); });
    const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return emptyChart("No approved expenses yet.");
    const max = rows[0][1];
    return `<div class="hbars">${rows.map(([c, v]) => `
      <div class="hbar"><span class="hbar-label">${escapeHtml((EXP_CAT_ICON?.[c] || "") + " " + c)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(v / max) * 100}%"></span></span>
      <span class="hbar-val">${formatCurrencyRound(v)} · ${Math.round((v / d.totalExpense) * 100)}%</span></div>`).join("")}</div>`;
  }
  if (tab === "rate") {
    const dates = [...new Set([...d.expenses.map((e) => e.expense_date), ...d.meals.map((m) => m.meal_date)])].sort();
    let exp = 0, meals = 0;
    const pts = [];
    dates.forEach((dt) => {
      exp += d.expenses.filter((e) => e.expense_date === dt).reduce((s, e) => s + Number(e.amount), 0);
      meals += d.meals.filter((m) => m.meal_date === dt).reduce((s, m) => s + Number(m.day_count || 0) + Number(m.night_count || 0) + Number(m.guest_day_count || 0) + Number(m.guest_night_count || 0), 0);
      if (meals > 0) pts.push({ label: parseLocalDate(dt).getDate(), title: `${_dLabel(dt)}: ${formatTk(exp / meals)}`, value: exp / meals });
    });
    if (pts.length < 2) return emptyChart("Not enough data for a trend yet.");
    return lineChartSVG(pts);
  }
  // members: meals vs paid
  const rows = d.members.slice().sort((a, b) => a.balance - b.balance);
  return `
    <div class="mc-table-wrap"><table class="mc-table mc-table-num">
      <thead><tr><th>Member</th><th>Meals</th><th>Guests</th><th>Cost</th><th>Paid</th><th>Balance</th></tr></thead>
      <tbody>${rows.map((m) => `<tr>
        <td>${escapeHtml(m.name)}</td><td>${fmtNum(m.ownMeals)}</td><td>${m.guest ? `${fmtNum(m.guest)} <small>(${formatCurrencyRound(m.guestCost)})</small>` : "–"}</td>
        <td>${formatCurrencyRound(m.cost)}</td><td>${formatCurrencyRound(m.deposits)}</td>
        <td class="${m.balance < -0.5 ? "neg" : "pos"}">${formatTk(m.balance)}</td></tr>`).join("")}</tbody>
    </table></div>
    <div class="chart-note">Guest meals are billed to the host at the same meal rate and are included in Cost.</div>`;
}

const fmtNum = (n) => (Math.round(n * 10) / 10).toString();
const _dLabel = (iso) => parseLocalDate(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const emptyChart = (t) => `<div class="mc-empty">${escapeHtml(t)}</div>`;

function barChartSVG(points, { money } = {}) {
  const W = 640, H = 220, pad = 28, max = Math.max(...points.map((p) => p.value)) || 1;
  const bw = (W - pad * 2) / points.length;
  const bars = points.map((p, i) => {
    const h = (p.value / max) * (H - pad * 2);
    const x = pad + i * bw + bw * 0.15, y = H - pad - h;
    return `<g><title>${escapeHtml(p.title)}</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" class="bar"/>
      ${points.length <= 31 ? `<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - pad + 14}" class="axis" text-anchor="middle">${p.label}</text>` : ""}</g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="svg-chart" role="img" aria-label="Spending per day">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="gridline"/>
    <text x="${pad}" y="${pad - 8}" class="axis">${money ? formatCurrencyRound(max) : max}</text>${bars}</svg>`;
}

function lineChartSVG(points) {
  const W = 640, H = 220, pad = 30;
  const vals = points.map((p) => p.value), max = Math.max(...vals), min = Math.min(...vals);
  const span = max - min || 1;
  const xy = points.map((p, i) => [pad + (i * (W - pad * 2)) / (points.length - 1), H - pad - ((p.value - min) / span) * (H - pad * 2)]);
  const path = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" class="svg-chart" role="img" aria-label="Meal rate over the cycle">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="gridline"/>
    <text x="${pad}" y="${pad - 10}" class="axis">${formatTk(max)}</text>
    <text x="${pad}" y="${H - pad - 4}" class="axis">${formatTk(min)}</text>
    <path d="${path}" class="line"/>
    ${xy.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="dot"><title>${escapeHtml(points[i].title)}</title></circle>`).join("")}
  </svg>`;
}

// ============================================
// 3. PANEL (full-screen sheet for statement / archive / audit)
// ============================================
function openPanel(title, html, { wide } = {}) {
  closePanel();
  const wrap = document.createElement("div");
  wrap.className = "ui-panel-backdrop";
  wrap.id = "uiPanel";
  wrap.innerHTML = `
    <div class="ui-panel${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="ui-panel-head"><h3>${escapeHtml(title)}</h3><button type="button" class="sheet-close" onclick="closePanel()" aria-label="Close">✕</button></div>
      <div class="ui-panel-body">${html}</div>
    </div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closePanel(); });
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("open"));
  return wrap.querySelector(".ui-panel-body");
}
function closePanel() {
  const p = document.getElementById("uiPanel");
  if (!p) return false;
  p.classList.remove("open");
  setTimeout(() => p.remove(), 200);
  return true;
}

// ============================================
// 4. PERSONAL STATEMENT (+ WhatsApp / copy / image)
// ============================================
async function openStatement(memberId = currentUser?.member_id, cycleId = currentCycleId) {
  const body = openPanel("Statement", `<div class="loading">Calculating…</div>`);
  try {
    const d = await getCycleData(cycleId);
    const m = d.members.find((x) => x.id === memberId) || { id: memberId, name: getMemberName(memberId), day: 0, night: 0, guest: 0, meals: 0, ownMeals: 0, deposits: 0, cost: 0, guestCost: 0, balance: 0, carriedDue: 0, bazar: 0 };
    const deps = d.deposits.filter((x) => x.member_id === memberId).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const owe = m.balance < -0.5;
    const staffPicker = isStaff()
      ? `<select class="list-select" onchange="openStatement(parseInt(this.value), ${d.cycleId})" aria-label="Member">
           ${d.members.map((x) => `<option value="${x.id}" ${x.id === memberId ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}</select>`
      : "";
    const range = d.cycle ? `${_dLabel(d.cycle.start_date)} – ${_dLabel(d.cycle.end_date)}` : "";
    const row = (label, value, cls = "") => `<div class="st-row"><span>${label}</span><b class="${cls}">${value}</b></div>`;

    body.innerHTML = `
      <div class="stmt-actions">${staffPicker}
        <button type="button" class="ui-btn ui-btn-primary ui-btn-sm" onclick="shareStatementWhatsApp()">WhatsApp</button>
        <button type="button" class="ui-btn ui-btn-ghost ui-btn-sm" onclick="copyStatementText()">Copy text</button>
        <button type="button" class="ui-btn ui-btn-ghost ui-btn-sm" onclick="saveStatementImage()">Save image</button>
      </div>

      <article class="st" id="stmtSheet">
        <header class="st-head">
          <div class="st-brand">MealCal Pro · Statement</div>
          <div class="st-who">
            <div>
              <div class="st-name">${escapeHtml(m.name)}</div>
              <div class="st-cycle">${escapeHtml(d.cycle?.name || "")}${range ? " · " + escapeHtml(range) : ""}</div>
            </div>
            <div class="st-balance ${owe ? "neg" : "pos"}">
              <small>Balance</small>
              <span>${formatTk(m.balance)}</span>
              <em>${owe ? "Please deposit" : "In credit"}</em>
            </div>
          </div>
        </header>

        <section class="st-sum" aria-label="How the balance is calculated">
          <div class="st-term"><small>Paid</small><b>${formatTk(m.deposits)}</b></div>
          <div class="st-op">−</div>
          <div class="st-term"><small>Meal cost</small><b>${formatTk(m.cost)}</b></div>
          <div class="st-op">=</div>
          <div class="st-term st-term-result ${owe ? "neg" : "pos"}"><small>Balance</small><b>${formatTk(m.balance)}</b></div>
        </section>

        <section class="st-block">
          <h4>Meals</h4>
          <div class="st-meals">
            <div><small>দুপুর</small><b>${fmtNum(m.day)}</b></div>
            <div><small>রাত</small><b>${fmtNum(m.night)}</b></div>
            <div><small>Guests</small><b>${fmtNum(m.guest)}</b></div>
            <div class="st-meals-total"><small>Total</small><b>${fmtNum(m.meals)}</b></div>
          </div>
          <div class="st-note">${fmtNum(m.meals)} meals × meal rate ${formatTk(d.rate)} = <b>${formatTk(m.cost)}</b>${m.guest ? ` (guests: ${formatTk(m.guestCost)})` : ""}</div>
        </section>

        <section class="st-block">
          <h4>Details</h4>
          ${row("Meal rate this cycle", formatTk(d.rate))}
          ${row("Money paid (incl. settlements)", formatTk(m.deposits))}
          ${row("Bazar done by you", formatTk(m.bazar || 0))}
          ${m.carriedDue ? row(m.carriedDue < 0 ? "Debt carried from last cycle" : "Credit carried from last cycle", formatTk(m.carriedDue), m.carriedDue < 0 ? "neg" : "pos") : ""}
        </section>

        <section class="st-block">
          <h4>Money in / out</h4>
          ${deps.length
            ? `<div class="st-tx">${deps.map((x) => `
                <div class="st-tx-row">
                  <span class="st-tx-date">${escapeHtml(new Date(x.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</span>
                  <span class="st-tx-what">${escapeHtml(x.label === "Auto-Settlement" ? x.notes || "Settlement" : x.label || "Deposit")}</span>
                  <span class="st-tx-amt ${x.amount < 0 ? "neg" : "pos"}">${x.amount < 0 ? "−" : "+"}${formatTk(Math.abs(x.amount))}</span>
                </div>`).join("")}</div>`
            : `<div class="st-empty">No deposits this cycle.</div>`}
        </section>

        <footer class="st-foot">Generated ${escapeHtml(new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }))}</footer>
      </article>`;
    window._stmt = { m, d };
  } catch (e) {
    body.innerHTML = `<div class="mc-empty">Could not build the statement: ${escapeHtml(niceError(e))}</div>`;
  }
}

function statementText() {
  const s = window._stmt;
  if (!s) return "";
  const { m, d } = s;
  return [
    `*MealCal Pro — ${m.name}*`,
    `${d.cycle?.name || ""}`,
    `Meal rate: ${formatTk(d.rate)}`,
    `Meals: ${fmtNum(m.ownMeals)}${m.guest ? ` + ${fmtNum(m.guest)} guest` : ""} = ${fmtNum(m.meals)}`,
    `Meal cost: ${formatTk(m.cost)}`,
    `Paid: ${formatTk(m.deposits)}`,
    `*Balance: ${formatTk(m.balance)}*${m.balance < -0.5 ? " (please deposit)" : ""}`,
  ].join("\n");
}
function shareStatementWhatsApp() {
  const text = statementText();
  if (!text) return;
  // Opens WhatsApp with the text ready; the user chooses who to send it to
  window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
}
async function copyStatementText() {
  try { await navigator.clipboard.writeText(statementText()); showNotification("Statement copied", "success"); }
  catch (_) { showNotification("Copy not available on this device", "error"); }
}
async function saveStatementImage() {
  const el = document.getElementById("stmtSheet");
  if (!el) return;
  try {
    // Flat, print-clean version for the image (soft shadows render badly in images)
    el.classList.add("st-export");
    let canvas;
    try { canvas = await renderToCanvas(el, "#ffffff"); } finally { el.classList.remove("st-export"); }
    const name = (window._stmt?.m?.name || "member").replace(/[^a-z0-9]/gi, "_");
    const how = await deliverCanvasAsJpg(canvas, `MealCal_Statement_${name}.jpg`);
    if (how !== "cancelled") showNotification("Statement image ready", "success");
  } catch (e) {
    showNotification("Could not save image: " + niceError(e), "error");
  }
}

// ============================================
// 5. CYCLE ARCHIVE — browse any past cycle (read-only) + Excel
// ============================================
async function openCycleArchive(cycleId) {
  const cycles = (allCycles || []).slice().sort((a, b) => b.id - a.id);
  const sel = cycleId || cycles.find((c) => !c.is_active)?.id || currentCycleId;
  const body = openPanel("Cycle archive", `<div class="loading">Loading…</div>`, { wide: true });
  try {
    const d = await getCycleData(sel);
    body.innerHTML = `
      <div class="stmt-actions">
        <select class="list-select" onchange="openCycleArchive(parseInt(this.value))" aria-label="Cycle">
          ${cycles.map((c) => `<option value="${c.id}" ${c.id == sel ? "selected" : ""}>${escapeHtml(c.name)}${c.is_active ? " (current)" : ""}</option>`).join("")}
        </select>
        <button type="button" class="ui-btn ui-btn-primary ui-btn-sm" onclick="exportCycleExcel(${sel})">Excel</button>
      </div>
      <div class="ins-stats">
        <div class="ins-stat"><div class="ins-k">Meal rate</div><div class="ins-v">${formatTk(d.rate)}</div></div>
        <div class="ins-stat"><div class="ins-k">Total bazar</div><div class="ins-v">${formatCurrencyRound(d.totalExpense)}</div></div>
        <div class="ins-stat"><div class="ins-k">Total meals</div><div class="ins-v">${fmtNum(d.totalMeals)}</div></div>
        <div class="ins-stat"><div class="ins-k">Members</div><div class="ins-v">${d.members.length}</div></div>
      </div>
      ${chartFor("members", d)}
      <p class="chart-note">Read-only view. Balances use this cycle's approved expenses and deposits.</p>`;
  } catch (e) {
    body.innerHTML = `<div class="mc-empty">${escapeHtml(niceError(e))}</div>`;
  }
}

async function exportCycleExcel(cycleId) {
  try {
    await ensureXLSX();
    const d = await getCycleData(cycleId);
    const wb = XLSX.utils.book_new();
    const nameOf = Object.fromEntries(d.members.map((m) => [m.id, m.name]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.members.map((m) => ({
      Member: m.name, "Day meals": m.day, "Night meals": m.night, "Guest meals": m.guest, "Total meals": +m.meals.toFixed(2),
      "Meal cost": +m.cost.toFixed(2), Paid: +m.deposits.toFixed(2), Balance: +m.balance.toFixed(2) }))), "Balances");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.expenses.map((e) => ({ Date: e.expense_date, Shopper: nameOf[e.member_id] || e.member_id, Category: e.category || "Bazar", Items: e.description || "", Amount: Number(e.amount) }))), "Expenses");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.deposits.map((x) => ({ Date: new Date(x.created_at).toLocaleString("en-GB"), Member: nameOf[x.member_id] || x.member_id, Type: x.label || "", Notes: x.notes || "", Amount: Number(x.amount) }))), "Deposits");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.meals.slice().sort((a, b) => a.meal_date.localeCompare(b.meal_date)).map((x) => ({ Date: x.meal_date, Member: nameOf[x.member_id] || x.member_id, Day: Number(x.day_count || 0), Night: Number(x.night_count || 0), "Guest day": Number(x.guest_day_count || 0), "Guest night": Number(x.guest_night_count || 0) }))), "Meals");
    const how = await deliverWorkbook(wb, `MealCal_${(d.cycle?.name || "cycle").replace(/[^a-z0-9]/gi, "_")}.xlsx`);
    if (how !== "cancelled") showNotification("Cycle exported (Excel)", "success");
  } catch (e) {
    showNotification("Export failed: " + niceError(e), "error");
  }
}

// ============================================
// 6. AUDIT LOG (staff) — every change with old → new values
// ============================================
let _auditPage = 0;
async function openAuditLog(table = "", page = 0) {
  if (!isStaff()) return;
  _auditPage = page;
  const body = openPanel("Audit log", `<div class="loading">Loading…</div>`, { wide: true });
  let q = supabase.from("audit_log").select("*").order("created_at", { ascending: false }).range(page * 50, page * 50 + 49);
  if (table) q = q.eq("table_name", table);
  const { data, error } = await q;
  if (error) { body.innerHTML = `<div class="mc-empty">${escapeHtml(niceError(error))}</div>`; return; }
  const tables = ["", "deposits", "expenses", "meals", "meal_plans", "members", "cycle_dues", "cycles", "app_config", "weekly_menus"];
  body.innerHTML = `
    <div class="stmt-actions">
      <select class="list-select" onchange="openAuditLog(this.value, 0)" aria-label="Table">
        ${tables.map((t) => `<option value="${t}" ${t === table ? "selected" : ""}>${t ? t.replace("_", " ") : "All tables"}</option>`).join("")}
      </select>
      <span class="chart-note">Newest first · 50 per page</span>
    </div>
    <div class="audit-list">${(data || []).map(auditRow).join("") || `<div class="mc-empty">No changes recorded yet.</div>`}</div>
    <div class="stmt-actions">
      ${page > 0 ? `<button type="button" class="ui-btn ui-btn-ghost ui-btn-sm" onclick="openAuditLog('${table}', ${page - 1})">← Newer</button>` : ""}
      ${(data || []).length === 50 ? `<button type="button" class="ui-btn ui-btn-ghost ui-btn-sm" onclick="openAuditLog('${table}', ${page + 1})">Older →</button>` : ""}
    </div>`;
}

function auditRow(r) {
  const who = r.actor_member_id ? getMemberName(r.actor_member_id) : "System";
  const skip = new Set(["updated_at", "created_at"]);
  let changes = "";
  if (r.action === "UPDATE" && r.old_data && r.new_data) {
    changes = Object.keys(r.new_data)
      .filter((k) => !skip.has(k) && JSON.stringify(r.old_data[k]) !== JSON.stringify(r.new_data[k]))
      .map((k) => `<span class="audit-chg"><b>${escapeHtml(k)}</b>: ${escapeHtml(String(r.old_data[k] ?? "∅"))} → ${escapeHtml(String(r.new_data[k] ?? "∅"))}</span>`)
      .join("");
  } else {
    const row = r.new_data || r.old_data || {};
    const keys = ["member_id", "amount", "label", "description", "status", "meal_date", "plan_date", "name", "key_name", "value_text"].filter((k) => row[k] !== undefined && row[k] !== null);
    changes = keys.map((k) => `<span class="audit-chg"><b>${escapeHtml(k)}</b>: ${escapeHtml(k === "member_id" ? getMemberName(row[k]) : String(row[k]))}</span>`).join("");
  }
  return `
    <div class="audit-row act-${r.action.toLowerCase()}">
      <div class="audit-top"><span class="audit-act">${r.action}</span> <b>${escapeHtml(r.table_name)}</b> #${escapeHtml(r.row_id || "")}
        <span class="audit-meta">${escapeHtml(who)} · ${escapeHtml(new Date(r.created_at).toLocaleString("en-GB"))}</span></div>
      <div class="audit-changes">${changes}</div>
    </div>`;
}
