// MealCal Pro — JPG / CSV exports
// (Loaded as a classic script; shares global scope with the other js/*.js files. Load order is set in index.html.)

// ============================================
// EXPORT HELPERS — work the same on phones (incl. installed PWA) and PC
// ============================================
let _xlsxLoading = null;
/** Loads SheetJS once, on demand. */
function ensureXLSX() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    s.onload = resolve;
    s.onerror = () => { _xlsxLoading = null; reject(new Error("Could not load the Excel library — check your internet.")); };
    document.head.appendChild(s);
  });
  return _xlsxLoading;
}

const _isTouchDevice = () => matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

/**
 * Save / share a generated file. Phones get the native share sheet (Save to Files, WhatsApp, Drive…),
 * PCs get a normal download. Falls back to opening the file in a new tab.
 */
async function deliverFile(blob, fileName) {
  const file = new File([blob], fileName, { type: blob.type });
  if (_isTouchDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return "shared";
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  // iOS standalone ignores download links → open the file so the user can save it
  if (window.navigator.standalone) window.open(url, "_blank");
  return "downloaded";
}

/** Render an element to a canvas at the best scale the device allows (avoids blank images on phones). */
async function renderToCanvas(el, background = "#ffffff") {
  const w = el.scrollWidth || el.offsetWidth || 800;
  const h = el.scrollHeight || el.offsetHeight || 600;
  const maxSide = _isTouchDevice() ? 4096 : 8192;
  const maxArea = _isTouchDevice() ? 16_000_000 : 40_000_000;
  let scale = Math.min(2.5, window.devicePixelRatio * 1.5 || 2);
  scale = Math.min(scale, maxSide / w, maxSide / h, Math.sqrt(maxArea / (w * h)));
  scale = Math.max(1, scale);
  if (typeof html2canvas === "undefined") throw new Error("Image library not loaded — check your internet.");
  return html2canvas(el, { scale, useCORS: true, allowTaint: false, backgroundColor: background, logging: false, windowWidth: Math.max(w, 400) });
}

async function canvasToJpegBlob(canvas, quality = 0.93) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image too large for this device"))), "image/jpeg", quality));
}

async function deliverCanvasAsJpg(canvas, fileName) {
  const blob = await canvasToJpegBlob(canvas);
  return deliverFile(blob, fileName);
}

/** Write a SheetJS workbook as a real .xlsx file through deliverFile() */
async function deliverWorkbook(wb, fileName) {
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true });
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return deliverFile(blob, fileName);
}

// ============================================
// JPG EXPORT SYSTEM FOR SUMMARY TABLE
// ============================================
async function exportToJPG() {
  const btn = document.getElementById("exportJPGBtn");
  const originalText = btn.innerHTML;
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
          ${escapeHtml(cycleName)}
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

    let canvas;
    try {
      canvas = await renderToCanvas(wrap, "#f7f5f2");
    } finally {
      wrap.remove();
    }
    const how = await deliverCanvasAsJpg(canvas, fileName);
    if (how !== "cancelled") showNotification(how === "shared" ? "Summary image ready to share" : "Summary image downloaded", "success");
  } catch (err) {
    console.error("JPG Export Error:", err);
    showNotification("Failed to export JPG", "error");
  } finally {
    btn.innerHTML = originalText;
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
            <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px;" title="${escapeHtml(descText)}">${escapeHtml(descText)}</span>
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
            <div style="font-size: 28px; font-weight: 800; margin-top: 2px; letter-spacing: -0.5px;">${escapeHtml(profileName)}</div>
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
    
    let canvas;
    try {
      canvas = await renderToCanvas(wrap, "#f1f5f9");
    } finally {
      wrap.remove();
    }

    const fileName = `MealCal_${profileName.replace(/[^a-zA-Z0-9]/g, "_")}_Statement_${new Date().toISOString().split("T")[0]}.jpg`;
    const how = await deliverCanvasAsJpg(canvas, fileName);
    if (how !== "cancelled") showNotification(how === "shared" ? "Statement ready to share" : "Statement downloaded", "success");
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
    const originalText = btn.innerHTML;
    btn.textContent = "Generating...";
    btn.disabled = true;

    try {
      await ensureXLSX();
      // 1. Fetch ALL Data for the Cycle in Parallel
      const [cycleRes, membersRes, mealsRes, depositsRes, expensesRes] =
        await Promise.all([
          supabase
            .from("cycles")
            .select("name, start_date, end_date")
            .eq("id", currentCycleId)
            .single(),
          supabase.from("members").select("id, name, is_approved").eq("is_approved", true).order("name"),
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

      // Extra sheets: one clean table per topic (easy to sort/filter in Excel)
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expenses.map((e) => ({
        Date: e.expense_date, Shopper: e.members?.name || "", Category: e.category || "Bazar", Items: e.description || "", Amount: Number(e.amount) }))), "Expenses");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(deposits.map((d) => ({
        Date: new Date(d.created_at).toLocaleString("en-GB"), Member: d.members?.name || "", Type: d.label || "", Notes: d.notes || "", Amount: Number(d.amount) }))), "Deposits");
      const nameOf = Object.fromEntries((members || []).map((m) => [m.id, m.name]));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((meals || []).slice().sort((a, b) => a.meal_date.localeCompare(b.meal_date)).map((m) => ({
        Date: m.meal_date, Member: nameOf[m.member_id] || m.member_id, Day: Number(m.day_count || 0), Night: Number(m.night_count || 0),
        "Guest day": Number(m.guest_day_count || 0), "Guest night": Number(m.guest_night_count || 0) }))), "Meals");

      const safeName = cycle.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const fileName = `MealCal_FullReport_${safeName}.xlsx`;
      const how = await deliverWorkbook(wb, fileName);
      if (how !== "cancelled") showNotification("Full cycle report exported (Excel)", "success");
    } catch (err) {
      console.error("Export Error:", err);
      showNotification("Failed to export: " + niceError(err), "error");
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  });
