# MealCal Pro — Developer & AI Guide

This document is designed to give human developers and AI coding assistants a complete, page-by-page understanding of the "MealCal Pro" application. It covers architecture, state management, complex database logic, and UI behaviors so that new features and upgrades can be implemented safely without breaking existing logic.

---

## 🏗 1. Core Architecture & Tech Stack

- **Frontend Engine**: Vanilla HTML5, CSS3, and JavaScript (`app.js`). No heavy frameworks (React/Vue).
- **Backend & Database**: Supabase (PostgreSQL).
- **Authentication**: Supabase Auth (Email/Password).
- **State Management**: The app maintains a mirrored local state in `app.js` (`appState` and caching markers like `pageLoaded`) to minimize database reads and keep the UI lightning fast.
- **Routing**: Single Page Application (SPA). All logical "pages" are just `<div>` containers with the `.page-content` class. Navigation toggles the `.hidden` class on these containers via `navigateToPage()`.

---

## 🗄 2. Database Schema (Supabase)

The app relies on several deeply linked tables:

- `cycles`: Represents a specific month/period (e.g., "Feb 2026"). Tracks total members, total meals, and total bazar cost.
- `members`: User profiles linked to Supabase Auth UUIDs. Has roles: `admin`, `manager`, `user`.
- `meal_plans`: The _future/intended_ schedule (Day/Night toggles).
- `meals`: The _actual/finalized_ historical consumption of meals.
- `expenses`: Bazar/Shopping costs input by users. Have `pending` and `approved` states.
- `deposits`: Cash payments made by members. Have `pending` and `approved` states. Includes pseudo-deposits like "Auto-Settlements".
- `cycle_dues`: Tracks debt carries between cycles. If a user ended January at -500 Tk, a record here carries that debt into February.
- `app_config`: Global settings like `lock_time_start` and `lock_time_end`.

---

## 🧠 3. Crucial System Logics (Must Read)

### A. The "Session" vs "Calendar Day" Concept

MealCal Pro does **not** map 1:1 with midnight-to-midnight calendar days. Because bazar shopping happens in the evening for the _next_ day, the system operates on a "Session" that shifts at a specific time (configurable by Admins, e.g., 19:00 / 7:00 PM).

- If it is 6:00 PM on Feb 2nd, the "Active Session" is Feb 2nd.
- If it is 8:00 PM on Feb 2nd, the "Active Session" is mathematically shifted to **Feb 3rd**.
- **The Function**: `getStrictSessionDate()` dynamically computes this. All UI components (Dashboard, Scheduler) strictly rely on this, _not_ `new Date()`.

### B. Auto-Settlement Engine

When a member with a negative balance from a previous cycle makes a new Deposit in the current cycle:

1. The system accepts the real cash deposit.
2. It automatically creates hidden "Auto-Settlement" deposits (negative for the debtor, positive for the creditor) to balance out the old `cycle_dues` record in the background.
3. **Reversal feature (`revertApprovedDeposit`)**: If an Admin made a mistake, they can click "Revert". The system hunts down the exact millisecond burst of those auto-settlements, un-settles the `cycle_dues`, and deletes the footprints safely.

### C. Interval Safety

The app relies on `setInterval` for checking global balance warnings and automatic session switching (so the UI updates at exactly 7:00 PM without refreshing).

- Always use guarded intervals (e.g., `if (_sessionSwitchInterval) clearInterval(_sessionSwitchInterval);`) to prevent memory leaks during hot-reloads or re-logins.

---

## 📱 4. Page-by-Page Breakdown

### 🏠 Dashboard (`#dashboardPage`)

- **Purpose**: A quick overview for the user.
- **Features**:
  - Shows their current Balance, total deposited, and current meal rate.
  - An "Active Session" card that allows them to quickly toggle their Day/Night meals for the _immediate_ upcoming cutoff.
  - A mini-feed of recent notifications.

### 📅 Profile & Scheduler (`#profilePage`)

- **Purpose**: Where users manage their 7-day upcoming meal schedule.
- **Features**:
  - **The 8-Card System**: It generates an array of dates starting from `-1` (Yesterday/Last Session) up to `+6` (Next week).
  - The first card (Last Session) is mathematically locked, dimmed (`opacity: 0.6`), and unclickable.
  - The second card is the "Active Session" (urgent).
  - If a user tries to toggle a meal _after_ the admin's globally configured `lock_time_start`, the button shakes, turns red, and rejects the click unless they are an Admin.

### 🎛 Master Tracker (`#trackerPage`)

- **Purpose**: Admin view of everyone's historical/actual consumption.
- **Features**:
  - Displays a massive grid of Members vs Dates.
  - Only Admins and Managers can click the cells to forcefully override a user's Day/Night meal count.
  - Edits here directly affect the `meals` table (final data), not just `meal_plans`.

### 📊 Summary (`#summaryPage`)

- **Purpose**: The live financial heartbeat of the cycle.
- **Features**:
  - **The Math**: Calculates the `Total Bazar Cost` / `Total Meals Consumed` to generate the exact `Meal Rate` per floating decimal.
  - Multiplies the `Meal Rate` by each member's specific consumed meals, subtracts their specific Bazar expenses, compares it to their assigned Deposits + carryover cycle dues, and outputs their live Net Balance (Green = Good, Red = Debt).
  - Admins can export this exact view to a `.jpg` downloaded image using the html2canvas plugin.

### 🛒 Expenses (`#expensesPage`)

- **Purpose**: Tracking who bought the Bazar.
- **Features**:
  - Anyone can submit an Expense.
  - All expenses default to `status: "pending"` (even if an Admin submits it).
  - Admins must explicitly click "Approve" to move the expense money into the active math total.
  - **Mobile UI**: Because the desktop table is too wide, mobile users interact with a sleek "Bottom Sheet" (`#sheetOverlay`) that slides up for creating and editing expenses.

### 💵 Deposits (`#depositsPage`)

- **Purpose**: Tracking cash inflow to the meal manager.
- **Features**:
  - Users submit requests (`pending`).
  - Admins click "Approve" which finalizes the money and triggers the Complex Auto-Settlement Engine if they owed past debt.
  - Includes a history log with smart badging (Money Icon for pure deposits, Red Arrow for reductions, Refresh Icon for auto-settlements).
  - Admins have a specialized `↩ Revert Transaction` button here.

### ⚙️ Admin Panel (`#adminPage`)

- **Purpose**: Application lifecycle management.
- **Features**:
  - Ability to change users passwords and roles.
  - Dynamic configuration of the locking times (e.g., 07:00 to 19:00).
  - The "Finalize Cycle" button: Closes the current month, calculates all exact final debts, generates `cycle_dues` rows for the next month, creates a fresh Cycle, and migrates the app forward effortlessly.

---

## 🛠 5. Developer Rules & Best Practices

1. **Never Duplicate Functions**: Because of how `app.js` is hoisted in the browser, defining a function twice will silently overwrite the first one and cause catastrophic UI freezing. Keep files clean.
2. **Clear UI State Before Data Fetching**: When loading a page, always show a loading skeleton or string (`<div class="loading">...</div>`) inside the container before executing the `supabase.from(...)` await.
3. **Buttons Must Unlock (`finally`)**: Any function attached to a button click _must_ wrap its logic in a `try...catch...finally` block where `btn.disabled = false;` is inside the `finally`. If a Supabase network error occurs, the button must not permanently freeze.
4. **Mobile First**: Always test modals in the Mobile View context. If a desktop modal (`<dialog>`) breaks mobile UX, utilize the Bottom Sheet architecture (`sheetOverlay`).
