import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const THEME_KEY = "gym_tracker_theme_v1";
const DEFAULT_PRIMARY = ["Chest", "Back", "Shoulder", "Leg"];
const DEFAULT_SECONDARY = ["Biceps", "Triceps", "Forearms", "Calves", "Abs"];

const state = {
  supabase: null,
  theme: loadTheme(),
  authUser: null,
  profile: null,
  sessions: [],
  muscles: [],
  currentView: "dashboard",
  workoutDraft: null,
  liftBuilder: null,
  loading: true,
  busy: false,
  setupError: "",
};

await init();

async function init() {
  const config = window.GYM_TRACKER_SUPABASE_CONFIG || {};
  if (!isSupabaseConfigReady(config)) {
    state.setupError = "Supabase is not configured yet. Add your project URL and anon key in supabase.config.js.";
    state.loading = false;
    render();
    return;
  }

  state.supabase = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  const { data } = await state.supabase.auth.getSession();
  state.authUser = data.session?.user || null;

  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    state.authUser = session?.user || null;
    state.currentView = "dashboard";
    state.workoutDraft = null;
    state.liftBuilder = null;
    if (state.authUser) {
      await hydrateUserData();
    } else {
      state.profile = null;
      state.sessions = [];
      state.muscles = [];
    }
    state.loading = false;
    render();
  });

  if (state.authUser) {
    await hydrateUserData();
  }

  state.loading = false;
  render();
}

function isSupabaseConfigReady(config) {
  return Boolean(
    config &&
      typeof config.url === "string" &&
      typeof config.anonKey === "string" &&
      !config.url.includes("PASTE_YOUR_SUPABASE_PROJECT_URL_HERE") &&
      !config.anonKey.includes("PASTE_YOUR_SUPABASE_ANON_KEY_HERE")
  );
}

async function hydrateUserData() {
  if (!state.authUser) return;
  state.busy = true;
  render();

  await ensureProfile();
  await ensureDefaultMuscles();
  await Promise.all([loadProfile(), loadMuscles(), loadSessions()]);

  state.busy = false;
}

async function ensureProfile() {
  const { data } = await state.supabase
    .from("profiles")
    .select("id")
    .eq("id", state.authUser.id)
    .maybeSingle();

  if (!data) {
    await state.supabase.from("profiles").upsert({
      id: state.authUser.id,
      name: state.authUser.user_metadata?.name || "",
    });
  }
}

async function ensureDefaultMuscles() {
  const { data, error } = await state.supabase
    .from("muscle_groups")
    .select("name, category")
    .eq("user_id", state.authUser.id);

  if (error) throw error;

  const existing = new Set((data || []).map((row) => `${row.category}:${row.name.toLowerCase()}`));
  const rows = [];

  DEFAULT_PRIMARY.forEach((name) => {
    const key = `primary:${name.toLowerCase()}`;
    if (!existing.has(key)) rows.push({ user_id: state.authUser.id, name, category: "primary" });
  });

  DEFAULT_SECONDARY.forEach((name) => {
    const key = `secondary:${name.toLowerCase()}`;
    if (!existing.has(key)) rows.push({ user_id: state.authUser.id, name, category: "secondary" });
  });

  if (rows.length) {
    await state.supabase.from("muscle_groups").insert(rows);
  }
}

async function loadProfile() {
  const { data, error } = await state.supabase
    .from("profiles")
    .select("id, name")
    .eq("id", state.authUser.id)
    .single();

  if (error) throw error;
  state.profile = data;
}

async function loadMuscles() {
  const { data, error } = await state.supabase
    .from("muscle_groups")
    .select("id, name, category")
    .eq("user_id", state.authUser.id)
    .order("category", { ascending: true })
    .order("name", { ascending: true });

  if (error) throw error;
  state.muscles = data || [];
}

async function loadSessions() {
  const { data, error } = await state.supabase
    .from("workout_sessions")
    .select("id, workout_date, muscle_groups, lifts, created_at")
    .eq("user_id", state.authUser.id)
    .order("workout_date", { ascending: false });

  if (error) throw error;
  state.sessions = (data || []).map((row) => ({
    id: row.id,
    date: row.workout_date,
    muscleGroupsSnapshot: row.muscle_groups || [],
    lifts: row.lifts || [],
    createdAt: row.created_at,
  }));
}

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return ["dark", "pastel", "royal"].includes(saved) ? saved : "dark";
}

function saveTheme(theme) {
  state.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toIso(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDate(iso) {
  return parseIso(iso).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function weekStartMonday(date) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + offset);
  return copy;
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getAllMuscles() {
  return state.muscles.map((row) => row.name);
}

function getMusclesByCategory(category) {
  return state.muscles.filter((row) => row.category === category);
}

function computeStreak(uniqueDatesAsc) {
  if (!uniqueDatesAsc.length) return { currentStreak: 0, longestStreak: 0 };

  let longest = 1;
  let run = 1;
  let endingRun = 1;

  for (let i = 1; i < uniqueDatesAsc.length; i += 1) {
    const prev = parseIso(uniqueDatesAsc[i - 1]);
    const cur = parseIso(uniqueDatesAsc[i]);
    const gap = Math.floor((cur - prev) / 86400000);
    if (gap < 7) {
      run += 1;
    } else {
      if (run > longest) longest = run;
      run = 1;
    }
    if (i === uniqueDatesAsc.length - 1) endingRun = run;
  }

  if (run > longest) longest = run;

  const lastDate = parseIso(uniqueDatesAsc[uniqueDatesAsc.length - 1]);
  const now = parseIso(todayIso());
  const daysSinceLast = Math.floor((now - lastDate) / 86400000);
  return { currentStreak: daysSinceLast >= 7 ? 0 : endingRun, longestStreak: longest };
}

function computeWeeklyStreak(uniqueDatesAsc) {
  if (!uniqueDatesAsc.length) return 0;

  const activeWeekKeys = new Set(
    uniqueDatesAsc.map((iso) => toIso(weekStartMonday(parseIso(iso))))
  );
  const sortedWeekKeys = [...activeWeekKeys].sort();

  let run = 1;
  let endingRun = 1;
  for (let i = 1; i < sortedWeekKeys.length; i += 1) {
    const prev = parseIso(sortedWeekKeys[i - 1]);
    const cur = parseIso(sortedWeekKeys[i]);
    const gap = Math.floor((cur - prev) / 86400000);
    run = gap === 7 ? run + 1 : 1;
    if (i === sortedWeekKeys.length - 1) endingRun = run;
  }

  const latestWeek = parseIso(sortedWeekKeys[sortedWeekKeys.length - 1]);
  const currentWeek = weekStartMonday(parseIso(todayIso()));
  const gapFromCurrent = Math.floor((currentWeek - latestWeek) / 86400000);
  return gapFromCurrent > 7 ? 0 : endingRun;
}

function computeAnalytics() {
  const uniqueDates = [...new Set(state.sessions.map((row) => row.date))].sort();
  const today = parseIso(todayIso());
  const weekStart = weekStartMonday(today);
  const month = today.getMonth();
  const year = today.getFullYear();

  const weekDays = new Set();
  const monthDays = new Set();
  const weekMuscles = {};
  const monthMuscles = {};

  state.sessions.forEach((session) => {
    const date = parseIso(session.date);
    if (date >= weekStart && date <= today) {
      weekDays.add(session.date);
      session.muscleGroupsSnapshot.forEach((name) => {
        weekMuscles[name] = (weekMuscles[name] || 0) + 1;
      });
    }
    if (date.getMonth() === month && date.getFullYear() === year) {
      monthDays.add(session.date);
      session.muscleGroupsSnapshot.forEach((name) => {
        monthMuscles[name] = (monthMuscles[name] || 0) + 1;
      });
    }
  });

  const xp = uniqueDates.length * 20;
  return {
    sessions: state.sessions,
    weekGymDays: weekDays.size,
    monthGymDays: monthDays.size,
    weekMuscles,
    monthMuscles,
    xp,
    level: Math.floor(xp / 100) + 1,
    xpIntoLevel: xp % 100,
    weeklyStreak: computeWeeklyStreak(uniqueDates),
    ...computeStreak(uniqueDates),
  };
}

function topPair(mapObj) {
  return Object.entries(mapObj).sort((a, b) => b[1] - a[1])[0];
}

function render() {
  document.body.dataset.theme = state.theme;
  const app = document.getElementById("app");

  if (state.loading) {
    app.innerHTML = `
      <main class="shell auth-shell">
        <section class="auth-panel">
          <h1>Gym Tracker</h1>
          <p>Loading your gym data...</p>
        </section>
      </main>
    `;
    return;
  }

  if (state.setupError) {
    app.innerHTML = `
      <main class="shell auth-shell">
        <section class="auth-panel">
          <h1>Gym Tracker</h1>
          <p>${escapeHtml(state.setupError)}</p>
          <p>Open <code>supabase.config.js</code>, paste your Supabase URL and anon key, then refresh.</p>
        </section>
      </main>
    `;
    return;
  }

  app.innerHTML = state.authUser ? renderAuthed() : renderAuth();
  bindEvents();
}

function renderThemePicker() {
  return `
    <div class="theme-picker-wrap">
      <span class="theme-label">Theme:</span>
      <div class="theme-picker" role="group" aria-label="Theme picker">
        <button type="button" class="theme-dot ${state.theme === "dark" ? "active" : ""}" data-theme="dark" title="Current dark-grey"></button>
        <button type="button" class="theme-dot pastel ${state.theme === "pastel" ? "active" : ""}" data-theme="pastel" title="Pastel pink"></button>
        <button type="button" class="theme-dot royal ${state.theme === "royal" ? "active" : ""}" data-theme="royal" title="Purple and brown"></button>
      </div>
    </div>
  `;
}

function renderAuth() {
  return `
    <main class="shell auth-shell">
      <section class="auth-panel">
        <div class="theme-row">${renderThemePicker()}</div>
        <h1>Gym Tracker</h1>
        <p>Track workouts, body-part balance, and streaks.</p>
        <div class="auth-grid">
          <form id="register-form" class="panel">
            <h2>Create account</h2>
            <label>Name<input type="text" name="name" required /></label>
            <label>Email<input type="email" name="email" required /></label>
            <label>Password<input type="password" name="password" required minlength="6" /></label>
            <button type="submit">${state.busy ? "Creating..." : "Register"}</button>
          </form>
          <form id="login-form" class="panel">
            <h2>Login</h2>
            <label>Email<input type="email" name="email" required /></label>
            <label>Password<input type="password" name="password" required /></label>
            <button type="submit">${state.busy ? "Checking..." : "Login"}</button>
          </form>
        </div>
      </section>
    </main>
  `;
}

function renderAuthed() {
  const analytics = computeAnalytics();
  const displayName = state.profile?.name?.trim() || state.authUser.email;
  return `
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>Gym Tracker</h1>
          <p>${escapeHtml(displayName)} (${escapeHtml(state.authUser.email)})</p>
          ${renderThemePicker()}
        </div>
        <button id="logout-btn" class="ghost">${state.busy ? "Working..." : "Logout"}</button>
      </header>
      <nav class="tabs">
        ${tab("dashboard", "Dashboard")}
        ${tab("streak", "Streak")}
        ${tab("muscles", "Muscle Groups")}
      </nav>
      <section class="content">${renderView(analytics)}</section>
    </main>
  `;
}

function tab(id, label) {
  return `<button class="tab ${state.currentView === id ? "active" : ""}" data-tab="${id}">${label}</button>`;
}

function renderView(analytics) {
  if (state.currentView === "dashboard") return renderDashboard(analytics);
  if (state.currentView === "workout") return renderWorkout();
  if (state.currentView === "streak") return renderStreak(analytics);
  return renderMuscles();
}

function metric(label, value) {
  return `<article class="metric"><h3>${label}</h3><p>${value}</p></article>`;
}

function renderDashboard(analytics) {
  const recentWorkoutDate = state.sessions[0]?.date;
  const recentWorkouts = recentWorkoutDate ? state.sessions.filter((session) => session.date === recentWorkoutDate) : [];
  const top = topPair(analytics.weekMuscles);
  const sharePayload = getSharePayload(analytics, top);
  return `
    <div class="metrics">
      ${metric("Current Streak", `${analytics.currentStreak} gym days`)}
      ${metric("Longest Streak", `${analytics.longestStreak} gym days`)}
      ${metric("Gym Days This Week", analytics.weekGymDays)}
      ${metric("Gym Days This Month", analytics.monthGymDays)}
    </div>
    <div class="panel">
      <h2>Streak Game</h2>
      <div class="game-grid">
        <div class="game-stat"><strong>Level</strong><span>${analytics.level}</span></div>
        <div class="game-stat"><strong>Weekly Gym Streak</strong><span>${analytics.weeklyStreak}</span></div>
      </div>
      <p>${analytics.xp} total XP - ${analytics.xpIntoLevel}/100 XP to next level</p>
      <div class="xp-track"><div class="xp-fill" style="width:${analytics.xpIntoLevel}%"></div></div>
      <p>Rule: +20 XP per gym session. Weekly streak counts active weeks from Monday to Sunday.</p>
    </div>
    <div class="dashboard-row">
      <div class="panel">
        <h2>Add Workout Session</h2>
        <button id="go-workout" class="cta-add-workout">+ Add Workout</button>
      </div>
      <div class="panel">
        <h2>Recent Sessions</h2>
        ${renderSessions(recentWorkouts)}
      </div>
    </div>
    <div class="panel">
      <h2>Monthly Gym Calendar</h2>
      ${renderMonthlyCalendar(state.sessions)}
    </div>
    <div class="panel">
      <h2>Share This Week</h2>
      ${renderShareCard(sharePayload)}
      <div class="inline-actions">
        <button id="copy-share-summary">Copy Summary</button>
        <button id="download-share-card" class="cta-add-workout">Download Card</button>
      </div>
    </div>
    <div class="panel">
      <h2>Profile</h2>
      <form id="profile-form">
        <label>Name<input type="text" name="name" value="${escapeHtml(state.profile?.name || "")}" required /></label>
        <button type="submit">${state.busy ? "Saving..." : "Save Name"}</button>
      </form>
    </div>
  `;
}

function getSharePayload(analytics, topMuscle) {
  const name = state.profile?.name?.trim() || state.authUser.email;
  return {
    name,
    currentStreak: analytics.currentStreak,
    weeklyStreak: analytics.weeklyStreak,
    weekGymDays: analytics.weekGymDays,
    topMuscle: topMuscle ? `${topMuscle[0]} (${topMuscle[1]}x)` : "No workouts yet",
    level: analytics.level,
    xp: analytics.xp,
    xpIntoLevel: analytics.xpIntoLevel,
  };
}

function renderShareCard(payload) {
  return `
    <article class="share-card">
      <h3>${escapeHtml(payload.name)} - Weekly Gym Update</h3>
      <div class="share-grid">
        <div><strong>Current Streak</strong><span>${payload.currentStreak} days</span></div>
        <div><strong>Weekly Streak</strong><span>${payload.weeklyStreak} weeks</span></div>
        <div><strong>Gym Days</strong><span>${payload.weekGymDays} this week</span></div>
        <div><strong>Top Muscle</strong><span>${escapeHtml(payload.topMuscle)}</span></div>
        <div><strong>Level</strong><span>${payload.level}</span></div>
        <div><strong>XP</strong><span>${payload.xp} total (${payload.xpIntoLevel}/100)</span></div>
      </div>
    </article>
  `;
}

function renderMonthlyCalendar(sessions) {
  const today = parseIso(todayIso());
  const year = today.getFullYear();
  const month = today.getMonth();
  const totalDays = new Date(year, month + 1, 0).getDate();
  const monthName = today.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const gymDates = new Set(
    sessions
      .filter((session) => {
        const date = parseIso(session.date);
        return date.getFullYear() === year && date.getMonth() === month;
      })
      .map((session) => Number(session.date.slice(8, 10)))
  );

  return `
    <p>${monthName}</p>
    <div class="calendar-grid">
      ${Array.from({ length: totalDays }, (_, index) => {
        const day = index + 1;
        const isGym = gymDates.has(day);
        return `
          <div class="calendar-day ${isGym ? "gym-day" : "rest-day"}">
            <strong>${day}</strong>
            <span>${isGym ? "Gym" : "Rest"}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderSessions(sessions) {
  if (!sessions.length) return "<p>No session submitted yet.</p>";
  return sessions
    .map(
      (session) => `
        <div class="list-item">
          <strong>${formatDate(session.date)}</strong>
          <span>${session.muscleGroupsSnapshot.join(", ")}</span>
          <span>${session.lifts.length} lifts</span>
        </div>
      `
    )
    .join("");
}

function ensureWorkoutState() {
  if (!state.workoutDraft) {
    state.workoutDraft = {
      date: todayIso(),
      muscleGroupsSnapshot: [],
      lifts: [],
    };
  }

  if (!state.liftBuilder) {
    state.liftBuilder = {
      liftName: "",
      setsCount: 1,
      unit: "kg",
      currentSet: 1,
      sets: [],
    };
  }
}

function renderWorkout() {
  ensureWorkoutState();
  const muscles = getAllMuscles();
  const draft = state.workoutDraft;
  const builder = state.liftBuilder;

  return `
    <div class="panel">
      <button id="back-dashboard" class="ghost">Back</button>
    </div>
    <form id="muscle-select-form" class="panel">
      <h2>Workout Tracker</h2>
      <p><strong>Date:</strong> ${formatDate(draft.date)}</p>
      <p>What muscle group do you want to train?</p>
      <div class="muscle-card-grid">
        ${muscles
          .map(
            (name, index) => `
              <label class="muscle-card" for="muscle_${index}">
                <input id="muscle_${index}" type="checkbox" name="muscles" value="${escapeHtml(name)}" ${draft.muscleGroupsSnapshot.includes(name) ? "checked" : ""} />
                <span class="muscle-card-body">${escapeHtml(name)}</span>
              </label>
            `
          )
          .join("")}
      </div>
      <button type="submit">Save Muscle Groups</button>
    </form>
    ${
      draft.muscleGroupsSnapshot.length
        ? `
          <form id="lift-config-form" class="panel">
            <h2>Lift Setup</h2>
            <label>Name of lifts<input type="text" name="liftName" value="${escapeHtml(builder.liftName)}" required /></label>
            <label>How many set<input type="number" name="setsCount" min="1" max="12" value="${builder.setsCount}" required /></label>
            <label>Weight unit
              <select name="unit">
                <option value="kg" ${builder.unit === "kg" ? "selected" : ""}>kg</option>
                <option value="lbs" ${builder.unit === "lbs" ? "selected" : ""}>lbs</option>
              </select>
            </label>
            <button type="submit">Start Set Input</button>
          </form>
          ${
            builder.liftName
              ? `
                <form id="set-form" class="panel">
                  <h2>Set ${builder.currentSet} of ${builder.setsCount}</h2>
                  <label>rep<input type="number" name="reps" min="0" required /></label>
                  <label>weight (${builder.unit})<input type="number" name="weight" min="0" step="0.1" required /></label>
                  <button type="submit">${builder.currentSet === builder.setsCount ? "Submit" : "Next"}</button>
                </form>
              `
              : ""
          }
          <div class="panel">
            <h2>Current Session Lifts</h2>
            ${draft.lifts.length ? renderDraftLifts(draft.lifts) : "<p>No lift added yet.</p>"}
            <button id="submit-session" ${draft.lifts.length ? "" : "disabled"}>${state.busy ? "Saving..." : "Submit Workout Session"}</button>
          </div>
        `
        : ""
    }
    <div class="panel">
      <h2>Submitted Workouts</h2>
      ${renderSubmittedSessions()}
    </div>
  `;
}

function renderDraftLifts(lifts) {
  return lifts
    .map(
      (lift) => `
        <div class="list-item">
          <strong>${escapeHtml(lift.name)} (${lift.unit})</strong>
          <span>${lift.sets.length} sets</span>
          <span>${lift.sets.map((set) => `S${set.setNumber}: ${set.reps} reps @ ${set.weight}`).join(" | ")}</span>
        </div>
      `
    )
    .join("");
}

function renderStreak(analytics) {
  const top = topPair(analytics.weekMuscles);
  return `
    <div class="metrics">
      ${metric("Current Streak", `${analytics.currentStreak} gym days`)}
      ${metric("Longest Streak", `${analytics.longestStreak} gym days`)}
      ${metric("Gym Days This Week", analytics.weekGymDays)}
      ${metric("Gym Days This Month", analytics.monthGymDays)}
    </div>
    <div class="panel"><h2>Most Trained This Week</h2><p>${top ? `${top[0]} (${top[1]} times)` : "No workouts yet"}</p></div>
    <div class="panel"><h2>Weekly Muscle Summary</h2>${renderSummary(analytics.weekMuscles)}</div>
    <div class="panel"><h2>Monthly Muscle Summary</h2>${renderSummary(analytics.monthMuscles)}</div>
    <div class="panel"><h2>Streak Rule</h2><p>Rest days are allowed. Streak ends if you go 7 consecutive days with no workout submitted.</p></div>
  `;
}

function renderSummary(mapObj) {
  const rows = Object.entries(mapObj).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return "<p>No data yet.</p>";
  return rows
    .map(
      ([name, count]) => `
        <div class="list-item">
          <strong>${escapeHtml(name)}</strong>
          <span>${count} time${count > 1 ? "s" : ""}</span>
        </div>
      `
    )
    .join("");
}

function renderMuscles() {
  const primary = getMusclesByCategory("primary");
  const secondary = getMusclesByCategory("secondary");

  return `
    <div class="muscle-management-grid">
      <div class="panel">
        <h2>Primary Muscle</h2>
        ${primary
          .map(
            (row) => `
              <div class="list-item">
                <strong>${escapeHtml(row.name)}</strong>
                <div class="inline-actions">
                  <button class="danger" data-remove-muscle="${row.id}">Remove</button>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
      <div class="panel">
        <h2>Secondary Muscle</h2>
        ${secondary
          .map(
            (row) => `
              <div class="list-item">
                <strong>${escapeHtml(row.name)}</strong>
                <div class="inline-actions">
                  <button class="danger" data-remove-muscle="${row.id}">Remove</button>
                </div>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
    <form id="muscle-add-form" class="panel">
      <h2>Add Muscle Group</h2>
      <label>Muscle name<input type="text" name="muscleName" required /></label>
      <label>Category
        <select name="muscleCategory" required>
          <option value="primary">Primary</option>
          <option value="secondary">Secondary</option>
        </select>
      </label>
      <button type="submit">${state.busy ? "Saving..." : "Add Muscle Group"}</button>
    </form>
  `;
}

function renderSubmittedSessions() {
  if (!state.sessions.length) return "<p>No submitted workouts yet.</p>";
  return state.sessions
    .slice(0, 12)
    .map(
      (session) => `
        <div class="list-item">
          <strong>${formatDate(session.date)}</strong>
          <span>${session.muscleGroupsSnapshot.join(", ")}</span>
          <span>${session.lifts.length} lifts</span>
          <button class="danger" data-delete-session="${session.id}">Delete Workout</button>
        </div>
      `
    )
    .join("");
}

function bindEvents() {
  document.querySelectorAll(".theme-dot[data-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      saveTheme(button.dataset.theme);
      render();
    });
  });

  const registerForm = document.getElementById("register-form");
  if (registerForm) {
    registerForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = event.target.elements.name.value.trim();
      const email = event.target.elements.email.value.trim().toLowerCase();
      const password = event.target.elements.password.value;

      await runBusy(async () => {
        const { data, error } = await state.supabase.auth.signUp({
          email,
          password,
          options: {
            data: { name },
          },
        });

        if (error) throw error;
        if (!data.session) {
          alert("Check your email to confirm your account, then log in.");
          return;
        }
        await ensureProfile();
        await loadProfile();
      });
    });
  }

  const loginForm = document.getElementById("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = event.target.elements.email.value.trim().toLowerCase();
      const password = event.target.elements.password.value;

      await runBusy(async () => {
        const { error } = await state.supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      });
    });
  }

  const logoutButton = document.getElementById("logout-btn");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await runBusy(async () => {
        const { error } = await state.supabase.auth.signOut();
        if (error) throw error;
      });
    });
  }

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.currentView = button.dataset.tab;
      render();
    });
  });

  const goWorkout = document.getElementById("go-workout");
  if (goWorkout) {
    goWorkout.addEventListener("click", () => {
      state.currentView = "workout";
      render();
    });
  }

  const backDashboard = document.getElementById("back-dashboard");
  if (backDashboard) {
    backDashboard.addEventListener("click", () => {
      state.currentView = "dashboard";
      render();
    });
  }

  const muscleSelectForm = document.getElementById("muscle-select-form");
  if (muscleSelectForm) {
    muscleSelectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const selected = [...event.target.querySelectorAll('input[name="muscles"]:checked')].map((input) => input.value);
      if (!selected.length) {
        alert("Select at least one muscle group.");
        return;
      }
      state.workoutDraft.muscleGroupsSnapshot = selected;
      render();
    });
  }

  const liftConfigForm = document.getElementById("lift-config-form");
  if (liftConfigForm) {
    liftConfigForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const liftName = event.target.elements.liftName.value.trim();
      const setsCount = Number(event.target.elements.setsCount.value);
      const unit = event.target.elements.unit.value;
      if (!liftName || setsCount < 1) return;
      state.liftBuilder = { liftName, setsCount, unit, currentSet: 1, sets: [] };
      render();
    });
  }

  const setForm = document.getElementById("set-form");
  if (setForm) {
    setForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const reps = Number(event.target.elements.reps.value);
      const weight = Number(event.target.elements.weight.value);
      if (!Number.isFinite(reps) || !Number.isFinite(weight) || reps < 0 || weight < 0) {
        alert("Please enter valid reps and weight.");
        return;
      }

      state.liftBuilder.sets.push({
        setNumber: state.liftBuilder.currentSet,
        reps,
        weight,
      });

      if (state.liftBuilder.currentSet === state.liftBuilder.setsCount) {
        state.workoutDraft.lifts.push({
          id: crypto.randomUUID(),
          name: state.liftBuilder.liftName,
          unit: state.liftBuilder.unit,
          sets: state.liftBuilder.sets,
        });
        state.liftBuilder = { liftName: "", setsCount: 1, unit: "kg", currentSet: 1, sets: [] };
      } else {
        state.liftBuilder.currentSet += 1;
      }

      render();
    });
  }

  const submitSession = document.getElementById("submit-session");
  if (submitSession) {
    submitSession.addEventListener("click", async () => {
      if (!state.workoutDraft?.lifts.length) return;
      await runBusy(async () => {
        const { error } = await state.supabase.from("workout_sessions").insert({
          user_id: state.authUser.id,
          workout_date: state.workoutDraft.date,
          muscle_groups: state.workoutDraft.muscleGroupsSnapshot,
          lifts: state.workoutDraft.lifts,
        });

        if (error) throw error;

        await loadSessions();
        state.workoutDraft = null;
        state.liftBuilder = null;
        state.currentView = "dashboard";
        alert("Workout session submitted.");
      });
    });
  }

  const profileForm = document.getElementById("profile-form");
  if (profileForm) {
    profileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = event.target.elements.name.value.trim();

      await runBusy(async () => {
        const { error } = await state.supabase
          .from("profiles")
          .update({ name, updated_at: new Date().toISOString() })
          .eq("id", state.authUser.id);

        if (error) throw error;
        await loadProfile();
        alert("Profile name updated.");
      });
    });
  }

  const copyShareSummary = document.getElementById("copy-share-summary");
  if (copyShareSummary) {
    copyShareSummary.addEventListener("click", async () => {
      const analytics = computeAnalytics();
      const payload = getSharePayload(analytics, topPair(analytics.weekMuscles));
      const summary = [
        `${payload.name} - Weekly Gym Update`,
        `Current Streak: ${payload.currentStreak} days`,
        `Weekly Streak: ${payload.weeklyStreak} weeks`,
        `Gym Days This Week: ${payload.weekGymDays}`,
        `Top Muscle: ${payload.topMuscle}`,
        `Level: ${payload.level}`,
        `XP: ${payload.xp} (${payload.xpIntoLevel}/100 to next level)`,
      ].join("\n");

      try {
        await navigator.clipboard.writeText(summary);
        alert("Summary copied.");
      } catch {
        alert("Clipboard blocked by browser. Please copy manually.");
      }
    });
  }

  const downloadShareCard = document.getElementById("download-share-card");
  if (downloadShareCard) {
    downloadShareCard.addEventListener("click", () => {
      const analytics = computeAnalytics();
      downloadShareImage(getSharePayload(analytics, topPair(analytics.weekMuscles)));
    });
  }

  const muscleAddForm = document.getElementById("muscle-add-form");
  if (muscleAddForm) {
    muscleAddForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = event.target.elements.muscleName.value.trim();
      const category = event.target.elements.muscleCategory.value;
      if (!name) return;

      const exists = state.muscles.some((row) => row.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        alert("Muscle group already exists.");
        return;
      }

      await runBusy(async () => {
        const { error } = await state.supabase.from("muscle_groups").insert({
          user_id: state.authUser.id,
          name,
          category,
        });

        if (error) throw error;
        await loadMuscles();
      });
    });
  }

  document.querySelectorAll("[data-remove-muscle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const muscleId = button.dataset.removeMuscle;
      await runBusy(async () => {
        const { error } = await state.supabase.from("muscle_groups").delete().eq("id", muscleId);
        if (error) throw error;
        await loadMuscles();
      });
    });
  });

  document.querySelectorAll("[data-delete-session]").forEach((button) => {
    button.addEventListener("click", async () => {
      const confirmed = confirm("Delete this workout? XP and streak stats will update automatically.");
      if (!confirmed) return;
      await runBusy(async () => {
        const { error } = await state.supabase
          .from("workout_sessions")
          .delete()
          .eq("id", button.dataset.deleteSession)
          .eq("user_id", state.authUser.id);

        if (error) throw error;
        await loadSessions();
        alert("Workout deleted.");
      });
    });
  });
}

async function runBusy(task) {
  try {
    state.busy = true;
    render();
    await task();
  } catch (error) {
    alert(error.message || "Something went wrong.");
  } finally {
    state.busy = false;
    render();
  }
}

function downloadShareImage(payload) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 628;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#1a1d20";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f3a530";
  ctx.fillRect(0, 0, canvas.width, 16);

  ctx.fillStyle = "#f2f3f5";
  ctx.font = "700 48px Arial";
  ctx.fillText("Weekly Gym Update", 60, 90);
  ctx.font = "600 34px Arial";
  ctx.fillText(payload.name, 60, 140);

  const rows = [
    `Current Streak: ${payload.currentStreak} days`,
    `Weekly Streak: ${payload.weeklyStreak} weeks`,
    `Gym Days This Week: ${payload.weekGymDays}`,
    `Top Muscle: ${payload.topMuscle}`,
    `Level: ${payload.level}`,
    `XP: ${payload.xp} (${payload.xpIntoLevel}/100 to next level)`,
  ];

  ctx.font = "500 32px Arial";
  ctx.fillStyle = "#e8edf1";
  rows.forEach((row, index) => {
    ctx.fillText(row, 60, 220 + index * 62);
  });

  ctx.fillStyle = "#a8afb7";
  ctx.font = "500 24px Arial";
  ctx.fillText("Generated from Gym Tracker", 60, 588);

  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = "gym-weekly-share-card.png";
  link.click();
}
