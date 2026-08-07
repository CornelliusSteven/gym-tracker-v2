import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const THEME_KEY = "gym_tracker_theme_v1";
const WORKOUT_DRAFT_STORAGE_PREFIX = "gym_tracker_workout_draft_v1";
const WORKOUT_DRAFT_VERSION = 1;
const DRAFT_SYNC_DELAY_MS = 900;
const DEFAULT_PRIMARY = ["Chest", "Back", "Shoulder", "Leg"];
const DEFAULT_SECONDARY = ["Biceps", "Triceps", "Forearms", "Calves", "Abs"];
let draftSyncTimer = null;
let draftSyncInFlight = null;
let lastServerDraftSavedAt = null;
let draftLifecycleRegistered = false;

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
  selectedCalendarDate: null,
  trackRange: "allTime",
  loading: true,
  busy: false,
  setupError: "",
  draftStatus: "idle",
  draftUpdatedAt: null,
  draftId: null,
  draftBackendAvailable: true,
};

await init();

async function init() {
  registerDraftLifecycleHandlers();
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
    const previousUserId = state.authUser?.id || null;
    const nextUser = session?.user || null;
    const nextUserId = nextUser?.id || null;

    state.authUser = nextUser;
    if (previousUserId === nextUserId) return;

    clearTimeout(draftSyncTimer);
    state.currentView = "dashboard";
    state.workoutDraft = null;
    state.liftBuilder = null;
    state.draftStatus = "idle";
    state.draftUpdatedAt = null;
    state.draftId = null;
    lastServerDraftSavedAt = null;
    state.draftBackendAvailable = true;
    state.selectedCalendarDate = null;
    if (state.authUser) {
      await hydrateUserData();
      await restoreWorkoutDraft();
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
    await restoreWorkoutDraft();
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

function createLiftBuilder(overrides = {}) {
  return {
    liftName: "",
    setsCount: 1,
    unit: "kg",
    currentSet: 1,
    sets: [],
    editingLiftId: null,
    isConfigured: false,
    pendingRepsChoice: "1",
    pendingCustomReps: 21,
    pendingWeight: "",
    ...overrides,
  };
}

function normalizeLiftBuilder(raw) {
  const builder = createLiftBuilder(raw && typeof raw === "object" ? raw : {});
  builder.setsCount = Math.max(1, Number.parseInt(builder.setsCount, 10) || 1);
  builder.currentSet = Math.min(builder.setsCount, Math.max(1, Number.parseInt(builder.currentSet, 10) || 1));
  builder.sets = Array.isArray(builder.sets) ? builder.sets : [];
  builder.unit = builder.unit === "lbs" ? "lbs" : "kg";
  builder.pendingRepsChoice =
    builder.pendingRepsChoice === "custom" ||
    (Number(builder.pendingRepsChoice) >= 1 && Number(builder.pendingRepsChoice) <= 20)
      ? String(builder.pendingRepsChoice)
      : "1";
  builder.pendingCustomReps = Math.max(21, Number.parseInt(builder.pendingCustomReps, 10) || 21);
  builder.pendingWeight = builder.pendingWeight === "" ? "" : String(builder.pendingWeight ?? "");
  builder.isConfigured = Boolean(builder.isConfigured);
  return builder;
}

function normalizeWorkoutDraft(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.date !== "string") return null;
  return {
    date: raw.date,
    muscleGroupsSnapshot: Array.isArray(raw.muscleGroupsSnapshot) ? raw.muscleGroupsSnapshot : [],
    lifts: Array.isArray(raw.lifts) ? raw.lifts : [],
  };
}

function workoutDraftStorageKey(userId = state.authUser?.id) {
  return userId ? `${WORKOUT_DRAFT_STORAGE_PREFIX}:${userId}` : "";
}

function readLocalWorkoutDraft(userId = state.authUser?.id) {
  const key = workoutDraftStorageKey(userId);
  if (!key) return null;
  try {
    const record = JSON.parse(localStorage.getItem(key) || "null");
    if (!record || record.version !== WORKOUT_DRAFT_VERSION || record.userId !== userId) return null;
    return record;
  } catch {
    return null;
  }
}

function writeLocalWorkoutDraft(record) {
  const key = workoutDraftStorageKey(record?.userId);
  if (!key) return false;
  try {
    localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    setDraftStatus("error");
    return false;
  }
}

function removeLocalWorkoutDraft(userId = state.authUser?.id) {
  const key = workoutDraftStorageKey(userId);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage cleanup is best-effort; the server draft remains authoritative.
  }
}

function activeDraftRecord(savedAt = state.draftUpdatedAt || new Date().toISOString()) {
  if (!state.authUser || !state.workoutDraft) return null;
  if (!state.draftId) state.draftId = crypto.randomUUID();
  return {
    version: WORKOUT_DRAFT_VERSION,
    userId: state.authUser.id,
    savedAt,
    discarded: false,
    draftId: state.draftId,
    currentView: state.currentView === "workout" ? "workout" : "dashboard",
    workoutDraft: state.workoutDraft,
    liftBuilder: normalizeLiftBuilder(state.liftBuilder),
  };
}

function setDraftStatus(status) {
  state.draftStatus = status;
  const indicator = document.getElementById("draft-save-status");
  if (!indicator) return;
  indicator.className = `draft-save-status ${status}`;
  indicator.textContent = draftStatusLabel(status);
}

function draftStatusLabel(status = state.draftStatus) {
  const labels = {
    idle: "Auto-save ready",
    saving: "Saving...",
    saved: "Saved",
    device: "Saved on this device",
    offline: "Offline - saved on this device",
    error: "Save needs attention",
  };
  return labels[status] || labels.idle;
}

function saveWorkoutDraftLocally() {
  if (!state.authUser || !state.workoutDraft) return false;
  state.draftUpdatedAt = new Date().toISOString();
  return writeLocalWorkoutDraft(activeDraftRecord(state.draftUpdatedAt));
}

function queueWorkoutDraftSave() {
  if (!state.authUser || !state.workoutDraft) return;
  saveWorkoutDraftLocally();
  clearTimeout(draftSyncTimer);

  if (!navigator.onLine) {
    setDraftStatus("offline");
    return;
  }
  if (!state.draftBackendAvailable) {
    setDraftStatus("device");
    return;
  }

  setDraftStatus("saving");
  draftSyncTimer = setTimeout(() => {
    syncWorkoutDraftToServer().catch(() => setDraftStatus(navigator.onLine ? "error" : "offline"));
  }, DRAFT_SYNC_DELAY_MS);
}

function isDraftBackendUnavailable(error) {
  const code = error?.code || "";
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return ["42P01", "42883", "PGRST202", "PGRST205"].includes(code) || message.includes("workout_drafts");
}

async function syncWorkoutDraftToServer({ throwOnError = false } = {}) {
  if (!state.authUser || !state.workoutDraft || !state.supabase) return false;
  if (!navigator.onLine) {
    setDraftStatus("offline");
    return false;
  }
  if (!state.draftBackendAvailable) {
    setDraftStatus("device");
    return false;
  }

  if (draftSyncInFlight) {
    await draftSyncInFlight;
    if (!state.draftBackendAvailable) return false;
    if (lastServerDraftSavedAt === state.draftUpdatedAt) return true;
    return syncWorkoutDraftToServer({ throwOnError });
  }

  clearTimeout(draftSyncTimer);
  const record = activeDraftRecord();
  draftSyncInFlight = Promise.resolve(state.supabase.from("workout_drafts").upsert(
    {
      user_id: state.authUser.id,
      id: record.draftId,
      workout_date: record.workoutDraft.date,
      muscle_groups: record.workoutDraft.muscleGroupsSnapshot,
      lifts: record.workoutDraft.lifts,
      lift_builder: record.liftBuilder,
      current_view: record.currentView,
      updated_at: record.savedAt,
    },
    { onConflict: "user_id" }
  ));

  let error;
  try {
    ({ error } = await draftSyncInFlight);
  } finally {
    draftSyncInFlight = null;
  }

  if (error) {
    if (isDraftBackendUnavailable(error)) {
      state.draftBackendAvailable = false;
      setDraftStatus("device");
      return false;
    }
    setDraftStatus(navigator.onLine ? "error" : "offline");
    if (throwOnError) throw error;
    return false;
  }

  lastServerDraftSavedAt = record.savedAt;
  state.draftBackendAvailable = true;
  setDraftStatus("saved");
  return true;
}

async function loadServerWorkoutDraft() {
  if (!state.authUser || !state.supabase || !navigator.onLine) return null;
  const { data, error } = await state.supabase
    .from("workout_drafts")
    .select("id, workout_date, muscle_groups, lifts, lift_builder, current_view, updated_at")
    .eq("user_id", state.authUser.id)
    .maybeSingle();

  if (error) {
    if (isDraftBackendUnavailable(error)) state.draftBackendAvailable = false;
    return null;
  }
  if (!data) return null;

  state.draftBackendAvailable = true;
  return {
    version: WORKOUT_DRAFT_VERSION,
    userId: state.authUser.id,
    savedAt: data.updated_at,
    discarded: false,
    draftId: data.id,
    currentView: data.current_view,
    workoutDraft: {
      date: data.workout_date,
      muscleGroupsSnapshot: data.muscle_groups || [],
      lifts: data.lifts || [],
    },
    liftBuilder: data.lift_builder || {},
  };
}

async function deleteServerWorkoutDraft() {
  if (!state.authUser || !state.supabase || !navigator.onLine || !state.draftBackendAvailable) return false;
  const { error } = await state.supabase.from("workout_drafts").delete().eq("user_id", state.authUser.id);
  if (error) {
    if (isDraftBackendUnavailable(error)) state.draftBackendAvailable = false;
    return false;
  }
  return true;
}

async function restoreWorkoutDraft() {
  if (!state.authUser) return;
  const localRecord = readLocalWorkoutDraft();
  const serverRecord = await loadServerWorkoutDraft();
  const localTime = Date.parse(localRecord?.savedAt || "") || 0;
  const serverTime = Date.parse(serverRecord?.savedAt || "") || 0;

  if (localRecord?.discarded && localTime >= serverTime) {
    if (await deleteServerWorkoutDraft()) removeLocalWorkoutDraft();
    return;
  }

  const record = serverTime > localTime ? serverRecord : localRecord || serverRecord;
  const draft = normalizeWorkoutDraft(record?.workoutDraft);
  if (!record || !draft) return;

  state.workoutDraft = draft;
  state.liftBuilder = normalizeLiftBuilder(record.liftBuilder);
  state.draftId = record.draftId || crypto.randomUUID();
  state.currentView = record.currentView === "dashboard" ? "dashboard" : "workout";
  state.draftUpdatedAt = record.savedAt || new Date().toISOString();
  lastServerDraftSavedAt = serverRecord && serverTime >= localTime ? serverRecord.savedAt : null;
  state.draftStatus = serverTime >= localTime && serverRecord ? "saved" : navigator.onLine ? "saving" : "offline";
  writeLocalWorkoutDraft(activeDraftRecord(state.draftUpdatedAt));

  if (record === localRecord && navigator.onLine && state.draftBackendAvailable) {
    syncWorkoutDraftToServer().catch(() => setDraftStatus("error"));
  }
}

async function discardWorkoutDraft() {
  if (!state.authUser) return;
  clearTimeout(draftSyncTimer);
  const userId = state.authUser.id;
  const discardedAt = new Date().toISOString();
  writeLocalWorkoutDraft({
    version: WORKOUT_DRAFT_VERSION,
    userId,
    savedAt: discardedAt,
    discarded: true,
  });

  state.workoutDraft = null;
  state.liftBuilder = null;
  state.draftUpdatedAt = null;
  state.draftId = null;
  lastServerDraftSavedAt = null;
  state.draftStatus = "idle";
  state.currentView = "dashboard";
  render();

  if (await deleteServerWorkoutDraft()) removeLocalWorkoutDraft(userId);
}

async function clearWorkoutDraftPersistence({ deleteServer = true } = {}) {
  clearTimeout(draftSyncTimer);
  const userId = state.authUser?.id;
  if (deleteServer) await deleteServerWorkoutDraft();
  removeLocalWorkoutDraft(userId);
  state.draftUpdatedAt = null;
  state.draftId = null;
  lastServerDraftSavedAt = null;
  state.draftStatus = "idle";
}

function registerDraftLifecycleHandlers() {
  if (draftLifecycleRegistered) return;
  draftLifecycleRegistered = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden" || !state.workoutDraft) return;
    saveWorkoutDraftLocally();
    syncWorkoutDraftToServer().catch(() => setDraftStatus(navigator.onLine ? "error" : "offline"));
  });

  window.addEventListener("beforeunload", () => {
    if (state.workoutDraft) saveWorkoutDraftLocally();
  });

  window.addEventListener("online", async () => {
    if (!state.workoutDraft) {
      const localRecord = readLocalWorkoutDraft();
      if (localRecord?.discarded) {
        state.draftBackendAvailable = true;
        if (await deleteServerWorkoutDraft()) removeLocalWorkoutDraft();
      }
      return;
    }
    state.draftBackendAvailable = true;
    setDraftStatus("saving");
    syncWorkoutDraftToServer().catch(() => setDraftStatus("error"));
  });

  window.addEventListener("offline", () => {
    if (state.workoutDraft) setDraftStatus("offline");
  });
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
  const last30Start = new Date(today);
  last30Start.setDate(today.getDate() - 29);
  const month = today.getMonth();
  const year = today.getFullYear();

  const last30Days = new Set();
  const monthDays = new Set();
  const last30Muscles = {};
  const monthMuscles = {};

  state.sessions.forEach((session) => {
    const date = parseIso(session.date);
    if (date >= last30Start && date <= today) {
      last30Days.add(session.date);
      session.muscleGroupsSnapshot.forEach((name) => {
        last30Muscles[name] = (last30Muscles[name] || 0) + 1;
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
    last30GymDays: last30Days.size,
    monthGymDays: monthDays.size,
    last30Muscles,
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
  const displayName = state.profile?.name?.trim() || "Gym Athlete";
  return `
    <main class="shell">
      <header class="topbar">
        <div>
          <h1>Gym Tracker</h1>
          <p>${escapeHtml(displayName)}</p>
          <div class="header-actions">
            ${renderThemePicker()}
            <button id="go-settings" class="ghost settings-button">Settings</button>
          </div>
        </div>
        <button id="logout-btn" class="ghost">${state.busy ? "Working..." : "Logout"}</button>
      </header>
      <nav class="tabs">
        ${tab("dashboard", "Dashboard")}
        ${tab("streak", "Analytics")}
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
  if (state.currentView === "calendarDay") return renderCalendarDayPage();
  if (state.currentView === "streak") return renderStreak(analytics);
  if (state.currentView === "settings") return renderSettings();
  return renderMuscles();
}

function metric(label, value) {
  return `<article class="metric"><h3>${label}</h3><p>${value}</p></article>`;
}

function fireIcon(isLit) {
  return `
    <span class="fire-icon ${isLit ? "fire-lit" : "fire-dim"}" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="img">
        <path d="M12.2 22c-4.4 0-7.5-2.9-7.5-7 0-2.8 1.5-5 3.4-6.8.7-.7 1.6-1.7 1.7-3.3 0-.6.7-.9 1.2-.5 1.9 1.4 3 3.2 3.2 5.5.8-.7 1.3-1.7 1.5-2.8.1-.7.9-1 1.4-.5 1.6 1.5 2.3 3.4 2.3 5.7 0 5.7-3.9 9.7-7.2 9.7Z" />
        <path class="fire-core" d="M12 20c-2.1 0-3.6-1.4-3.6-3.3 0-1.5.9-2.8 2.1-3.8.5-.4.9-.9 1-1.7 0-.4.5-.6.8-.3 1.3 1 2.1 2.4 2.1 4 0 3-1.4 5.1-2.4 5.1Z" />
      </svg>
    </span>
  `;
}

function streakMetric(label, value, isLit) {
  return `<article class="metric streak-metric">${fireIcon(isLit)}<h3>${label}</h3><p>${value}</p></article>`;
}

function renderDashboard(analytics) {
  const recentWorkoutDate = state.sessions[0]?.date;
  const recentWorkouts = recentWorkoutDate ? state.sessions.filter((session) => session.date === recentWorkoutDate) : [];
  const top = topPair(analytics.last30Muscles);
  const sharePayload = getSharePayload(analytics, top);
  const displayName = state.profile?.name?.trim() || "Gym Athlete";
  return `
    <div class="metrics">
      ${streakMetric("Current Streak", `${analytics.currentStreak} gym days`, analytics.currentStreak > 0)}
      ${streakMetric("Longest Streak", `${analytics.longestStreak} gym days`, analytics.longestStreak > 0)}
      ${metric("Gym Days Last 30 Days", analytics.last30GymDays)}
      ${metric("Gym Days This Month", analytics.monthGymDays)}
    </div>
    <div class="dashboard-cta-row">
      <p class="grind-welcome">Welcome to the Grind, ${escapeHtml(displayName)}</p>
      <button id="go-workout" class="cta-add-workout">+ Add Workout</button>
    </div>
    ${state.workoutDraft ? renderWorkoutResumeCard() : ""}
    <div class="panel">
      <div class="panel-heading-row">
        <h2>Streak Game</h2>
        <button class="rule-button" type="button" aria-label="Show streak rule">?</button>
        <div class="rule-popover">
          <p>Rest days are allowed.</p>
          <p>Gym-day streak ends after 7 days with no workout.</p>
          <p>Weekly streak counts active weeks from Monday to Sunday.</p>
        </div>
      </div>
      <div class="game-grid">
        <div class="game-stat"><strong>Level</strong><span>${analytics.level}</span></div>
        <div class="game-stat streak-game-stat">${fireIcon(analytics.weeklyStreak > 0)}<strong>Weekly Gym Streak</strong><span>${analytics.weeklyStreak}</span></div>
      </div>
      <p>${analytics.xp} total XP - ${analytics.xpIntoLevel}/100 XP to next level</p>
      <div class="xp-track"><div class="xp-fill" style="width:${analytics.xpIntoLevel}%"></div></div>
      <p>Rule: +20 XP per gym session.</p>
    </div>
    <div class="panel">
      <h2>Recent Sessions</h2>
      ${renderSessions(recentWorkouts)}
    </div>
    <div class="panel">
      <h2>Monthly Gym Calendar</h2>
      ${renderMonthlyCalendar(state.sessions)}
    </div>
    <div class="panel">
      <h2>Share My Personal Gym Card</h2>
      ${renderShareCard(sharePayload)}
      <div class="inline-actions">
        <button id="copy-share-summary">Copy Summary</button>
        <button id="download-share-card">Download Card</button>
      </div>
    </div>
  `;
}

function getSharePayload(analytics, topMuscle) {
  const name = state.profile?.name?.trim() || "Gym Athlete";
  return {
    name,
    currentStreak: analytics.currentStreak,
    weeklyStreak: analytics.weeklyStreak,
    last30GymDays: analytics.last30GymDays,
    topMuscle: topMuscle ? `${topMuscle[0]} (${topMuscle[1]}x)` : "No workouts yet",
    level: analytics.level,
    xp: analytics.xp,
    xpIntoLevel: analytics.xpIntoLevel,
  };
}

function renderShareCard(payload) {
  return `
    <article class="share-card">
      <h3>${escapeHtml(payload.name)} - Personal Gym Update</h3>
      <div class="share-grid">
        <div><strong>Current Streak</strong><span>${payload.currentStreak} days</span></div>
        <div><strong>Weekly Streak</strong><span>${payload.weeklyStreak} weeks</span></div>
        <div><strong>Gym Days</strong><span>${payload.last30GymDays} in the last 30 days</span></div>
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
  const primaryNames = new Set(getMusclesByCategory("primary").map((muscle) => muscle.name));
  const sessionsByDate = new Map();

  sessions.forEach((session) => {
    const date = parseIso(session.date);
    if (date.getFullYear() !== year || date.getMonth() !== month) return;
    if (!sessionsByDate.has(session.date)) sessionsByDate.set(session.date, []);
    sessionsByDate.get(session.date).push(session);
  });

  return `
    <p>${monthName}</p>
    <div class="calendar-grid">
      ${Array.from({ length: totalDays }, (_, index) => {
        const day = index + 1;
        const iso = `${year}-${`${month + 1}`.padStart(2, "0")}-${`${day}`.padStart(2, "0")}`;
        const daySessions = sessionsByDate.get(iso) || [];
        const isGym = daySessions.length > 0;
        const trainedPrimaryMuscles = [
          ...new Set(
            daySessions.flatMap((session) =>
              (session.muscleGroupsSnapshot || []).filter((name) => primaryNames.has(name))
            )
          ),
        ];
        const dayLabel = isGym ? trainedPrimaryMuscles.join(", ") || "Workout" : "Rest";
        return `
          <button class="calendar-day ${isGym ? "gym-day" : "rest-day"} ${state.selectedCalendarDate === iso ? "selected-day" : ""}" data-calendar-date="${iso}">
            <strong>${day}</strong>
            <span>${escapeHtml(dayLabel)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderCalendarDayPage() {
  const selectedDate = state.selectedCalendarDate || todayIso();
  const daySessions = state.sessions.filter((session) => session.date === selectedDate);
  const muscleGroups = [...new Set(daySessions.flatMap((session) => session.muscleGroupsSnapshot || []))];
  const lifts = daySessions.flatMap((session) => session.lifts || []);
  const totalSets = lifts.reduce((sum, lift) => sum + (lift.sets?.length || 0), 0);
  const totalReps = lifts.reduce(
    (sum, lift) => sum + (lift.sets || []).reduce((setSum, set) => setSum + Number(set.reps || 0), 0),
    0
  );

  if (!daySessions.length) {
    return `
      <div class="panel calendar-page">
        <div class="page-top-row">
          <button id="back-dashboard" class="ghost">Back</button>
          <span class="calendar-page-label">Monthly Gym Calendar detail</span>
        </div>
        <div class="calendar-detail hero-detail">
          <h2>${formatDate(selectedDate)}</h2>
          <p>Rest day. No workout submitted on this date.</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="panel calendar-page">
      <div class="page-top-row">
        <button id="back-dashboard" class="ghost">Back</button>
        <span class="calendar-page-label">Monthly Gym Calendar detail</span>
      </div>
      <div class="calendar-detail hero-detail">
        <h2>${formatDate(selectedDate)}</h2>
        <p>Complete workout detail from your saved gym session.</p>
        <div class="detail-summary-grid">
          <div><strong>Status</strong><span>Gym day</span></div>
          <div><strong>Sessions</strong><span>${daySessions.length}</span></div>
          <div><strong>Muscle Groups</strong><span>${muscleGroups.map(escapeHtml).join(", ")}</span></div>
          <div><strong>Total Lifts</strong><span>${lifts.length}</span></div>
          <div><strong>Total Sets</strong><span>${totalSets}</span></div>
          <div><strong>Total Reps</strong><span>${totalReps}</span></div>
        </div>
      </div>
      ${daySessions
        .map(
          (session, sessionIndex) => `
            <div class="day-session-detail">
              <div class="session-detail-heading">
                <strong>Workout Session ${sessionIndex + 1}</strong>
                <span>${session.createdAt ? new Date(session.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Saved session"}</span>
              </div>
              <span>Muscle groups: ${session.muscleGroupsSnapshot.map(escapeHtml).join(", ")}</span>
              ${session.lifts
                .map(
                  (lift, liftIndex) => `
                    <div class="lift-detail">
                      <strong>Lift ${liftIndex + 1}: ${escapeHtml(lift.name)} (${escapeHtml(lift.unit)})</strong>
                      <span>${lift.sets.length} sets</span>
                      <div class="set-detail-grid">
                        ${lift.sets
                          .map(
                            (set) => `
                              <div>
                                <strong>Set ${set.setNumber}</strong>
                                <span>${set.reps} reps</span>
                                <span>${set.weight} ${escapeHtml(lift.unit)}</span>
                              </div>
                            `
                          )
                          .join("")}
                      </div>
                    </div>
                  `
                )
                .join("")}
            </div>
          `
        )
        .join("")}
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
    state.liftBuilder = createLiftBuilder();
  }
}

function renderWorkout() {
  ensureWorkoutState();
  const primaryMuscles = getMusclesByCategory("primary");
  const secondaryMuscles = getMusclesByCategory("secondary");
  const draft = state.workoutDraft;
  const builder = state.liftBuilder;
  const usesCustomSetCount = builder.setsCount > 10;
  const usesCustomReps = builder.pendingRepsChoice === "custom";

  return `
    <div class="workout-nav">
      <button id="back-dashboard" class="back-button" type="button" aria-label="Back to dashboard">
        <span aria-hidden="true">&larr;</span>
        Back
      </button>
      <div class="draft-save-controls">
        <span id="draft-save-status" class="draft-save-status ${state.draftStatus}">${draftStatusLabel()}</span>
        <button class="danger compact-button" type="button" data-discard-workout>Discard</button>
      </div>
    </div>
    <form id="muscle-select-form" class="panel">
      <h2>Choose Muscle to Train</h2>
      <p><strong>Date:</strong> ${formatDate(draft.date)}</p>
      ${renderWorkoutMuscleGroup("Primary", "Main muscle focus", primaryMuscles, draft)}
      ${renderWorkoutMuscleGroup("Secondary", "Supporting muscle focus", secondaryMuscles, draft)}
      <button type="submit">Save Muscle Groups</button>
    </form>
    ${
      draft.muscleGroupsSnapshot.length
        ? `
          <form id="lift-config-form" class="panel">
            <h2>Lift Setup</h2>
            <label>Name of lifts<input type="text" name="liftName" value="${escapeHtml(builder.liftName)}" required /></label>
            <label>How many sets
              <select id="sets-count-select" name="setsCount" required>
                ${Array.from({ length: 10 }, (_, index) => index + 1)
                  .map((count) => `<option value="${count}" ${!usesCustomSetCount && builder.setsCount === count ? "selected" : ""}>${count}</option>`)
                  .join("")}
                <option value="custom" ${usesCustomSetCount ? "selected" : ""}>More than 10...</option>
              </select>
            </label>
            <label id="custom-sets-field" class="manual-input-field ${usesCustomSetCount ? "is-enabled" : "is-disabled"}">Enter number of sets (11+)
              <input type="number" name="customSetsCount" min="11" step="1" value="${usesCustomSetCount ? builder.setsCount : 11}" ${usesCustomSetCount ? "required" : "disabled"} />
            </label>
            <label>Weight unit
              <select name="unit">
                <option value="kg" ${builder.unit === "kg" ? "selected" : ""}>kg</option>
                <option value="lbs" ${builder.unit === "lbs" ? "selected" : ""}>lbs</option>
              </select>
            </label>
            <button type="submit">${builder.editingLiftId ? "Restart Set Input" : "Start Set Input"}</button>
          </form>
          ${
            builder.isConfigured
              ? `
                <form id="set-form" class="panel">
                  <h2>Set ${builder.currentSet} of ${builder.setsCount}</h2>
                  <label>Reps
                    <select id="reps-count-select" name="reps" required>
                      ${Array.from({ length: 20 }, (_, index) => index + 1)
                        .map((count) => `<option value="${count}" ${builder.pendingRepsChoice === String(count) ? "selected" : ""}>${count}</option>`)
                        .join("")}
                      <option value="custom" ${usesCustomReps ? "selected" : ""}>More than 20...</option>
                    </select>
                  </label>
                  <label id="custom-reps-field" class="manual-input-field ${usesCustomReps ? "is-enabled" : "is-disabled"}">Enter number of reps (21+)
                    <input type="number" name="customReps" min="21" step="1" value="${builder.pendingCustomReps}" ${usesCustomReps ? "required" : "disabled"} />
                  </label>
                  <label>Weight (${builder.unit})<input type="number" name="weight" min="0" step="0.1" value="${escapeHtml(builder.pendingWeight)}" required /></label>
                  <button type="submit">${builder.currentSet === builder.setsCount ? "Submit" : "Next"}</button>
                </form>
              `
              : ""
          }
          <div class="panel">
            <h2>Current Session Lifts</h2>
            ${draft.lifts.length ? renderDraftLifts(draft.lifts) : "<p>No lift added yet.</p>"}
            <button id="submit-session" class="submit-workout-button" type="button" ${draft.lifts.length ? "" : "disabled"}>${state.busy ? "Saving..." : "Submit Workout Session"}</button>
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

function renderWorkoutResumeCard() {
  const builder = normalizeLiftBuilder(state.liftBuilder);
  const progress = builder.isConfigured
    ? `Set ${builder.currentSet} of ${builder.setsCount} - ${builder.liftName}`
    : `${state.workoutDraft.lifts.length} completed lift${state.workoutDraft.lifts.length === 1 ? "" : "s"}`;
  return `
    <section class="panel workout-resume-card">
      <div>
        <span class="resume-eyebrow">Workout in progress</span>
        <h2>Continue ${formatDate(state.workoutDraft.date)}</h2>
        <p>${escapeHtml(progress)}</p>
      </div>
      <div class="inline-actions">
        <button id="resume-workout" type="button">Resume Workout</button>
        <button class="danger" type="button" data-discard-workout>Discard</button>
      </div>
    </section>
  `;
}

function renderWorkoutMuscleGroup(title, description, muscles, draft) {
  return `
    <section class="workout-muscle-section" aria-labelledby="${title.toLowerCase()}-muscle-title">
      <div class="workout-muscle-heading">
        <h3 id="${title.toLowerCase()}-muscle-title">${title}</h3>
        <span>${description}</span>
      </div>
      <div class="muscle-card-grid">
        ${muscles.length
          ? muscles
              .map(
                (muscle, index) => `
                  <label class="muscle-card" for="muscle_${muscle.category}_${index}">
                    <input id="muscle_${muscle.category}_${index}" type="checkbox" name="muscles" value="${escapeHtml(muscle.name)}" ${draft.muscleGroupsSnapshot.includes(muscle.name) ? "checked" : ""} />
                    <span class="muscle-card-body">${escapeHtml(muscle.name)}</span>
                  </label>
                `
              )
              .join("")
          : `<p class="hint">No ${title.toLowerCase()} muscle groups available.</p>`}
      </div>
    </section>
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
          ${state.liftBuilder?.editingLiftId === lift.id ? `<span class="draft-lift-editing">Editing from Set 1</span>` : ""}
          <div class="inline-actions draft-lift-actions">
            <button type="button" class="ghost" data-edit-draft-lift="${escapeHtml(lift.id)}">Edit</button>
            <button type="button" class="danger" data-delete-draft-lift="${escapeHtml(lift.id)}">Delete</button>
          </div>
        </div>
      `
    )
    .join("");
}

function renderStreak() {
  return `
    <div class="panel track-panel">
      <div>
        <h2>Analytics</h2>
        <p>See how many different gym days each muscle has been trained.</p>
      </div>
      <div class="track-filter-row" aria-label="Analytics time filter">
        ${trackRangeButton("allTime", "All time")}
        ${trackRangeButton("thisMonth", "This month")}
        ${trackRangeButton("last30", "Last 30 days")}
      </div>
      ${renderMuscleDayChart(state.trackRange, "primary", "Primary Muscle Chart")}
      ${renderMuscleDayChart(state.trackRange, "secondary", "Secondary Muscle Chart")}
    </div>
  `;
}

function trackRangeButton(range, label) {
  return `<button class="track-filter ${state.trackRange === range ? "active" : ""}" data-track-range="${range}">${label}</button>`;
}

function renderMuscleDayChart(range, category, title) {
  const rows = getMuscleDayCounts(range, category);
  if (!rows.length) {
    return `
      <section class="analytics-chart-section ${category}">
        <h3>${title}</h3>
        <p>No ${category} muscle groups available.</p>
      </section>
    `;
  }

  const maxCount = Math.max(...rows.map((row) => row.count));
  return `
    <section class="analytics-chart-section ${category}">
      <div class="analytics-chart-heading">
        <h3>${title}</h3>
        <span>${rows.reduce((sum, row) => sum + row.count, 0)} total muscle days</span>
      </div>
      <div class="track-chart">
        ${rows
          .map((row) => {
            const height = maxCount > 0 && row.count > 0 ? Math.max((row.count / maxCount) * 100, 8) : 0;
            return `
              <div class="chart-column">
                <span class="chart-value">${row.count} day${row.count === 1 ? "" : "s"}</span>
                <div class="chart-track" aria-label="${escapeHtml(row.name)} trained ${row.count} day${row.count === 1 ? "" : "s"}">
                  <div class="chart-bar" style="height:${height}%"></div>
                </div>
                <strong class="chart-label">${escapeHtml(row.name)}</strong>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function getMuscleDayCounts(range, category) {
  const today = parseIso(todayIso());
  const month = today.getMonth();
  const year = today.getFullYear();
  const last30Start = new Date(today);
  last30Start.setDate(today.getDate() - 29);
  const muscleDays = new Map();

  state.sessions.forEach((session) => {
    const date = parseIso(session.date);
    const include =
      range === "allTime" ||
      (range === "thisMonth" && date.getMonth() === month && date.getFullYear() === year) ||
      (range === "last30" && date >= last30Start && date <= today);

    if (!include) return;

    [...new Set(session.muscleGroupsSnapshot || [])].forEach((name) => {
      if (!muscleDays.has(name)) muscleDays.set(name, new Set());
      muscleDays.get(name).add(session.date);
    });
  });

  return getMusclesByCategory(category)
    .map((muscle) => ({ name: muscle.name, count: muscleDays.get(muscle.name)?.size || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

function renderSettings() {
  return `
    <div class="panel">
      <h2>Settings</h2>
      <div class="account-email">
        <strong>Email</strong>
        <span>${escapeHtml(state.authUser.email)}</span>
      </div>
      <form id="profile-form">
        <label>Name<input type="text" name="name" value="${escapeHtml(state.profile?.name || "")}" required /></label>
        <button type="submit">${state.busy ? "Saving..." : "Save Name"}</button>
      </form>
    </div>
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
        state.selectedCalendarDate = null;
        if (state.workoutDraft) {
          saveWorkoutDraftLocally();
          await syncWorkoutDraftToServer();
        }
        const { error } = await state.supabase.auth.signOut();
        if (error) throw error;
      });
    });
  }

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.currentView = button.dataset.tab;
      if (state.workoutDraft) queueWorkoutDraftSave();
      render();
    });
  });

  document.querySelectorAll("[data-track-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.trackRange = button.dataset.trackRange;
      render();
    });
  });

  const goWorkout = document.getElementById("go-workout");
  if (goWorkout) {
    goWorkout.addEventListener("click", () => {
      state.currentView = "workout";
      ensureWorkoutState();
      queueWorkoutDraftSave();
      render();
    });
  }

  const resumeWorkout = document.getElementById("resume-workout");
  if (resumeWorkout) {
    resumeWorkout.addEventListener("click", () => {
      state.currentView = "workout";
      queueWorkoutDraftSave();
      render();
    });
  }

  document.querySelectorAll("[data-discard-workout]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Discard this unfinished workout? This cannot be undone.")) return;
      await discardWorkoutDraft();
    });
  });

  const goSettings = document.getElementById("go-settings");
  if (goSettings) {
    goSettings.addEventListener("click", () => {
      state.currentView = "settings";
      if (state.workoutDraft) queueWorkoutDraftSave();
      render();
    });
  }

  document.querySelectorAll("[data-calendar-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCalendarDate = button.dataset.calendarDate;
      state.currentView = "calendarDay";
      if (state.workoutDraft) queueWorkoutDraftSave();
      render();
    });
  });

  const backDashboard = document.getElementById("back-dashboard");
  if (backDashboard) {
    backDashboard.addEventListener("click", () => {
      state.currentView = "dashboard";
      if (state.workoutDraft) queueWorkoutDraftSave();
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
      queueWorkoutDraftSave();
      render();
    });

    muscleSelectForm.querySelectorAll('input[name="muscles"]').forEach((input) => {
      input.addEventListener("change", () => {
        state.workoutDraft.muscleGroupsSnapshot = [
          ...muscleSelectForm.querySelectorAll('input[name="muscles"]:checked'),
        ].map((item) => item.value);
        queueWorkoutDraftSave();
      });
    });
  }

  const liftConfigForm = document.getElementById("lift-config-form");
  if (liftConfigForm) {
    liftConfigForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const liftName = event.target.elements.liftName.value.trim();
      const usesCustomSetCount = event.target.elements.setsCount.value === "custom";
      const setsCount = Number(
        usesCustomSetCount ? event.target.elements.customSetsCount.value : event.target.elements.setsCount.value
      );
      const unit = event.target.elements.unit.value;
      if (!liftName || !Number.isInteger(setsCount) || setsCount < 1 || (usesCustomSetCount && setsCount <= 10)) {
        alert("Choose 1-10 sets, or enter a whole number greater than 10.");
        return;
      }
      state.liftBuilder = createLiftBuilder({
        liftName,
        setsCount,
        unit,
        currentSet: 1,
        sets: [],
        editingLiftId: state.liftBuilder.editingLiftId || null,
        isConfigured: true,
      });
      queueWorkoutDraftSave();
      render();
    });

    liftConfigForm.elements.liftName.addEventListener("input", (event) => {
      state.liftBuilder.liftName = event.target.value;
      queueWorkoutDraftSave();
    });

    liftConfigForm.elements.unit.addEventListener("change", (event) => {
      state.liftBuilder.unit = event.target.value;
      queueWorkoutDraftSave();
    });
  }

  const setsCountSelect = document.getElementById("sets-count-select");
  if (setsCountSelect) {
    setsCountSelect.addEventListener("change", () => {
      const customSetsField = document.getElementById("custom-sets-field");
      const customSetsInput = customSetsField?.querySelector("input");
      const isCustom = setsCountSelect.value === "custom";
      if (!customSetsField || !customSetsInput) return;
      customSetsField.classList.toggle("is-enabled", isCustom);
      customSetsField.classList.toggle("is-disabled", !isCustom);
      customSetsInput.required = isCustom;
      customSetsInput.disabled = !isCustom;
      state.liftBuilder.setsCount = isCustom
        ? Math.max(11, Number.parseInt(customSetsInput.value, 10) || 11)
        : Number.parseInt(setsCountSelect.value, 10);
      queueWorkoutDraftSave();
      if (isCustom) customSetsInput.focus();
    });

    const customSetsInput = document.querySelector('input[name="customSetsCount"]');
    if (customSetsInput) {
      customSetsInput.addEventListener("input", () => {
        state.liftBuilder.setsCount = Math.max(11, Number.parseInt(customSetsInput.value, 10) || 11);
        queueWorkoutDraftSave();
      });
    }
  }

  const repsCountSelect = document.getElementById("reps-count-select");
  if (repsCountSelect) {
    repsCountSelect.addEventListener("change", () => {
      const customRepsField = document.getElementById("custom-reps-field");
      const customRepsInput = customRepsField?.querySelector("input");
      const isCustom = repsCountSelect.value === "custom";
      if (!customRepsField || !customRepsInput) return;
      customRepsField.classList.toggle("is-enabled", isCustom);
      customRepsField.classList.toggle("is-disabled", !isCustom);
      customRepsInput.required = isCustom;
      customRepsInput.disabled = !isCustom;
      state.liftBuilder.pendingRepsChoice = repsCountSelect.value;
      queueWorkoutDraftSave();
      if (isCustom) customRepsInput.focus();
    });


    const customRepsInput = document.querySelector('input[name="customReps"]');
    if (customRepsInput) {
      customRepsInput.addEventListener("input", () => {
        state.liftBuilder.pendingCustomReps = Math.max(21, Number.parseInt(customRepsInput.value, 10) || 21);
        queueWorkoutDraftSave();
      });
    }
  }

  const setForm = document.getElementById("set-form");
  if (setForm) {
    setForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const usesCustomReps = event.target.elements.reps.value === "custom";
      const reps = Number(usesCustomReps ? event.target.elements.customReps.value : event.target.elements.reps.value);
      const weight = Number(event.target.elements.weight.value);
      if (
        !Number.isInteger(reps) ||
        reps < 1 ||
        (usesCustomReps && reps <= 20) ||
        !Number.isFinite(weight) ||
        weight < 0
      ) {
        alert("Choose 1-20 reps, or enter a whole number greater than 20. Weight must be zero or higher.");
        return;
      }

      state.liftBuilder.sets.push({
        setNumber: state.liftBuilder.currentSet,
        reps,
        weight,
      });

      if (state.liftBuilder.currentSet === state.liftBuilder.setsCount) {
        const completedLift = {
          id: state.liftBuilder.editingLiftId || crypto.randomUUID(),
          name: state.liftBuilder.liftName,
          unit: state.liftBuilder.unit,
          sets: state.liftBuilder.sets,
        };
        const editingIndex = state.workoutDraft.lifts.findIndex((lift) => lift.id === state.liftBuilder.editingLiftId);
        if (editingIndex >= 0) {
          state.workoutDraft.lifts.splice(editingIndex, 1, completedLift);
        } else {
          state.workoutDraft.lifts.push(completedLift);
        }
        state.liftBuilder = createLiftBuilder();
      } else {
        state.liftBuilder.currentSet += 1;
        state.liftBuilder.pendingRepsChoice = "1";
        state.liftBuilder.pendingCustomReps = 21;
        state.liftBuilder.pendingWeight = "";
      }

      queueWorkoutDraftSave();
      render();
    });

    setForm.elements.weight.addEventListener("input", (event) => {
      state.liftBuilder.pendingWeight = event.target.value;
      queueWorkoutDraftSave();
    });
  }

  document.querySelectorAll("[data-edit-draft-lift]").forEach((button) => {
    button.addEventListener("click", () => {
      const lift = state.workoutDraft?.lifts.find((item) => item.id === button.dataset.editDraftLift);
      if (!lift) return;
      state.liftBuilder = createLiftBuilder({
        liftName: lift.name,
        setsCount: Math.max(1, lift.sets?.length || 1),
        unit: lift.unit,
        currentSet: 1,
        sets: [],
        editingLiftId: lift.id,
        isConfigured: true,
      });
      queueWorkoutDraftSave();
      render();
    });
  });

  document.querySelectorAll("[data-delete-draft-lift]").forEach((button) => {
    button.addEventListener("click", () => {
      const liftId = button.dataset.deleteDraftLift;
      const lift = state.workoutDraft?.lifts.find((item) => item.id === liftId);
      if (!lift || !confirm(`Delete ${lift.name} from this workout session?`)) return;
      state.workoutDraft.lifts = state.workoutDraft.lifts.filter((item) => item.id !== liftId);
      if (state.liftBuilder?.editingLiftId === liftId) {
        state.liftBuilder = createLiftBuilder();
      }
      queueWorkoutDraftSave();
      render();
    });
  });

  const submitSession = document.getElementById("submit-session");
  if (submitSession) {
    submitSession.addEventListener("click", async () => {
      if (!state.workoutDraft?.lifts.length) return;
      await runBusy(async () => {
        const draftSynced = await syncWorkoutDraftToServer({ throwOnError: true });
        let finalizedFromDraft = false;

        if (draftSynced) {
          const { error: finalizeError } = await state.supabase.rpc("finalize_workout_draft");
          if (!finalizeError) {
            finalizedFromDraft = true;
          } else if (!isDraftBackendUnavailable(finalizeError)) {
            throw finalizeError;
          }
        }

        if (!finalizedFromDraft) {
          const { error } = await state.supabase.from("workout_sessions").insert({
            user_id: state.authUser.id,
            workout_date: state.workoutDraft.date,
            muscle_groups: state.workoutDraft.muscleGroupsSnapshot,
            lifts: state.workoutDraft.lifts,
          });
          if (error) throw error;
        }

        await loadSessions();
        await clearWorkoutDraftPersistence({ deleteServer: !finalizedFromDraft });
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
      const payload = getSharePayload(analytics, topPair(analytics.last30Muscles));
      const summary = [
        `${payload.name} - Personal Gym Update`,
        `Current Streak: ${payload.currentStreak} days`,
        `Weekly Streak: ${payload.weeklyStreak} weeks`,
        `Gym Days Last 30 Days: ${payload.last30GymDays}`,
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
      downloadShareImage(getSharePayload(analytics, topPair(analytics.last30Muscles)));
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
  const theme = getCanvasTheme();
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 628;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = theme.panel;
  roundRect(ctx, 78, 66, 1044, 496, 18);
  ctx.fill();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 3;
  roundRect(ctx, 78, 66, 1044, 496, 18);
  ctx.stroke();

  ctx.fillStyle = theme.ink;
  ctx.font = "700 48px Arial";
  ctx.fillText("The Gym Grind", 118, 140);
  ctx.font = "600 34px Arial";
  ctx.fillStyle = theme.muted;
  ctx.fillText(`${payload.name} - Personal Gym Update`, 118, 188, 964);

  const stats = [
    ["Current Streak", `${payload.currentStreak} days`],
    ["Weekly Streak", `${payload.weeklyStreak} weeks`],
    ["Gym Days (30D)", `${payload.last30GymDays} days`],
    ["Top Muscle", payload.topMuscle],
    ["Level", `${payload.level}`],
    ["XP", `${payload.xp} total (${payload.xpIntoLevel}/100)`],
  ];

  stats.forEach(([label, value], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 118 + col * 500;
    const y = 240 + row * 96;

    ctx.fillStyle = theme.card;
    roundRect(ctx, x, y, 450, 72, 14);
    ctx.fill();
    ctx.fillStyle = theme.muted;
    ctx.font = "600 21px Arial";
    ctx.fillText(label, x + 24, y + 28);
    ctx.fillStyle = theme.ink;
    ctx.font = "700 27px Arial";
    ctx.fillText(value, x + 24, y + 58);
  });

  ctx.fillStyle = theme.muted;
  ctx.font = "500 19px Arial";
  ctx.fillText("Generated from Gym Tracker", 118, 526);

  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = "gym-personal-share-card.png";
  link.click();
}

function getCanvasTheme() {
  const themes = {
    dark: {
      bg: "#111315",
      panel: "#1a1d20",
      card: "#252a2f",
      ink: "#f2f3f5",
      muted: "#a8afb7",
      accent: "#f3a530",
      accent2: "#f2b650",
    },
    pastel: {
      bg: "#ffeef4",
      panel: "#fff7fb",
      card: "#fbe5ee",
      ink: "#5a2c42",
      muted: "#8e5f78",
      accent: "#ec7da8",
      accent2: "#f09dbf",
    },
    royal: {
      bg: "#1f1730",
      panel: "#2d203b",
      card: "#3c2b4d",
      ink: "#f3e8d6",
      muted: "#cdbda6",
      accent: "#a35ce0",
      accent2: "#b98255",
    },
  };
  return themes[state.theme] || themes.dark;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
