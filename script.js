/* ==========================================================
   LEAKLEVEL – Simulation, leak detection and dashboard logic
   Live readings are SIMULATED. Historical records come from the
   seeded sample dataset in data.js. No hardware is connected.
   ========================================================== */
'use strict';

/* ---------------- Configuration ---------------- */
const SEED = LEAKLEVEL_DATA;      // seeded sample dataset (data.js)
const FLOOR_COUNT = SEED.BASELINES.length;
const SIM_MINUTES_PER_TICK = 1;   // each live reading represents 1 simulated minute
const TREND_POINTS = 30;          // readings kept on the live trend charts
const HISTORY_LIMIT = 200;
const EXPLORER_ROWS = 100;
const MESSAGE_LIMIT = 10;
const ISOLATE_AFTER_READINGS = 4; // confirmed-leak readings before the auto valve closes
const MINUTES_PER_MONTH = 60 * 24 * 30;
const DAY_MS = 24 * 3600 * 1000;

// Demonstration thresholds – NOT validated engineering limits.
const DEFAULT_SETTINGS = {
  flowRisePct: SEED.RULES.flowRisePct,         // flow abnormal if > baseline + 30%
  pressureDropPct: SEED.RULES.pressureDropPct, // pressure abnormal if < baseline - 20%
  confirmReadings: SEED.RULES.confirmReadings, // consecutive abnormal readings to confirm a leak
  intervalSec: 2,                              // seconds between live readings
  autoIsolate: true,                           // close a floor's valve after a confirmed leak
  waterCostPerKL: 50,                          // illustrative water cost (Rs per kilolitre)
  electricityPerKWh: 8,                        // illustrative electricity tariff (Rs per kWh)
  baselines: SEED.BASELINES.map((b) => ({ flow: b.flow, pressure: b.pressure })),
};

// Illustrative impact factors: pumping + treatment energy, approximate Indian grid emissions.
const IMPACT = { kwhPerKL: 0.3, co2PerKWh: 0.71 };

// How a simulated leak changes readings (multiplier of baseline).
const LEAK_PROFILES = {
  major:    { flow: 1.6, pressure: 0.65, label: 'Major' },
  moderate: { flow: 1.4, pressure: 0.75, label: 'Moderate' },
};

// Leak in the shared riser between Floor 3 and Floor 4: water escapes before any floor meter,
// and floors above the leak see slightly lower pressure (not enough to trip floor alarms).
const RISER_LEAK = { excess: 15, aboveFloor: 4, pressureFactor: 0.9 };
// Booster pump problem: pressure falls on every floor and flow falls slightly.
const PUMP_FAULT = { flowFactor: 0.85, pressureFactor: 0.7 };
// Water balance: unaccounted water above max(2 L/min, 5% of main meter) is abnormal.
const BALANCE_RULE = { minLpm: 2, minPct: 5 };
// Building-wide pressure drop on at least this many floors = supply issue, not a floor leak.
const SUPPLY_MIN_FLOORS = 3;

// Small fluctuations so readings look alive but never cross thresholds by accident.
const NOISE = { normal: 0.02, leak: 0.01, meter: 0.005 };

const STORAGE = { history: 'leaklevel_history_v1', settings: 'leaklevel_settings_v2' };
const FLOOR_COLORS = ['#22d3ee', '#3b82f6', '#a78bfa', '#34d399', '#f472b6'];
const STATUS_COLORS = { NORMAL: '#22d3ee', WARNING: '#f59e0b', LEAK: '#ef4444', OFFLINE: '#64748b', ISOLATED: '#8b5cf6' };
const STATUS_LABEL = {
  NORMAL: 'NORMAL', WARNING: 'WARNING', LEAK: 'LEAK SUSPECTED', OFFLINE: 'SENSOR OFFLINE',
  ISOLATED: 'VALVE CLOSED', SUPPLY: 'SUPPLY ISSUE',
};
const PILL_CLASS = { Normal: 'pill-normal', Warning: 'pill-warning', 'Leak Suspected': 'pill-leak' };
const ACTIONABLE_TYPES = ['LEAK SUSPECTED', 'RISER LEAK SUSPECTED', 'SUPPLY ISSUE'];

/* ---------------- Helpers ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const clone = (obj) => JSON.parse(JSON.stringify(obj));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const jitter = (v, pct) => v * (1 + (Math.random() * 2 - 1) * pct);
const sum = (arr) => arr.reduce((s, v) => s + v, 0);
const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);
const fmtTime = (t) => new Date(t).toLocaleString();
const fmtShort = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLitres = (v) => `${Math.round(v).toLocaleString()} L`;
const fmtRupees = (v) => `\u20B9${Math.round(v).toLocaleString('en-IN')}`;
const fmtNum = (v, d) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : Number(v).toFixed(d));
const fmtDuration = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* storage unavailable – app still works without persistence */
  }
}

function loadSettings() {
  const saved = loadJSON(STORAGE.settings, null);
  const s = clone(DEFAULT_SETTINGS);
  if (saved && typeof saved === 'object') {
    ['flowRisePct', 'pressureDropPct', 'confirmReadings', 'intervalSec', 'waterCostPerKL', 'electricityPerKWh'].forEach((k) => {
      if (Number.isFinite(saved[k])) s[k] = saved[k];
    });
    if (typeof saved.autoIsolate === 'boolean') s.autoIsolate = saved.autoIsolate;
    if (Array.isArray(saved.baselines) && saved.baselines.length === FLOOR_COUNT) {
      saved.baselines.forEach((b, i) => {
        if (b && Number.isFinite(b.flow) && Number.isFinite(b.pressure)) s.baselines[i] = { flow: b.flow, pressure: b.pressure };
      });
    }
  }
  return s;
}

function loadHistory() {
  const h = loadJSON(STORAGE.history, []);
  if (!Array.isArray(h)) return [];
  // Alerts that were open when the page closed can no longer be acted on.
  h.forEach((a) => {
    if (a.status === 'Active' || a.status === 'Acknowledged') a.status = 'Closed – page reloaded';
  });
  return h;
}

/* ---------------- State ---------------- */
function freshBuildingState() {
  return {
    riser: { leak: false, count: 0, status: 'NORMAL', lost: 0, location: null, detectedAt: null },
    pump: false,
    supply: { suspect: false, count: 0, confirmed: false, floors: [] },
    meter: { main: 0, floors: 0, unaccounted: 0, pct: 0, available: true },
    mainConsumed: 0,
    waterSaved: 0,
    messages: [],
  };
}

const state = {
  settings: loadSettings(),
  running: true,
  timer: null,
  tick: 0,
  liveReadings: 0,    // total simulated readings this page session
  floors: [],
  history: loadHistory(),
  activeAlerts: [],   // ids of open actionable alerts
  trend: { labels: [], flow: [], pressure: [] },
  scenario: null,
  lastReadingAt: Date.now(),
  ...freshBuildingState(),
};
saveJSON(STORAGE.history, state.history);
let messageSeq = 0;

const baselineOf = (f) => state.settings.baselines[f.id - 1];
const findAlert = (id) => state.history.find((a) => a.id === id);
const saveHistory = () => saveJSON(STORAGE.history, state.history);
const openAlerts = (pred) => state.activeAlerts.map(findAlert).filter((a) => a && pred(a));
const isFloorLeak = (floorId) => (a) => a.type === 'LEAK SUSPECTED' && a.floor === floorId;
const isType = (type) => (a) => a.type === type;
const locLabel = (a) => a.location || `Floor ${a.floor}`;

function closeAlerts(pred, status) {
  let changed = false;
  state.activeAlerts = state.activeAlerts.filter((id) => {
    const a = findAlert(id);
    if (!a) return false;
    if (pred(a)) {
      a.status = status;
      changed = true;
      return false;
    }
    return true;
  });
  if (changed) saveHistory();
}

function createFloors() {
  state.floors = state.settings.baselines.map((b, i) => ({
    id: i + 1,
    flow: b.flow,
    pressure: b.pressure,
    mode: 'normal',        // 'normal' | 'leak' | 'manual'
    severity: 'major',
    manual: null,
    offline: false,        // simulated sensor link fault
    valveClosed: false,    // simulated floor shut-off valve
    isolatedBy: null,
    isolatedAt: null,
    savedEstimate: 0,
    leakTicks: 0,
    status: 'NORMAL',      // 'NORMAL' | 'WARNING' | 'LEAK' | 'OFFLINE' | 'ISOLATED'
    abnormalCount: 0,
    flowAbn: false,
    pressAbn: false,
    reason: 'Readings within expected limits',
    detectedAt: null,
    consumed: 0,
    lost: 0,
  }));
}

/* ---------------- Simulation ---------------- */
function generateReading(f) {
  if (f.offline) return;   // no new data arrives from an offline sensor node
  if (f.valveClosed) {
    f.flow = 0;
    f.pressure = 0;
    return;
  }
  const b = baselineOf(f);
  if (f.mode === 'manual' && f.manual) {
    f.flow = f.manual.flow;
    f.pressure = f.manual.pressure;
    return;
  }
  let flow;
  let pressure;
  if (f.mode === 'leak') {
    const p = LEAK_PROFILES[f.severity] || LEAK_PROFILES.major;
    flow = jitter(b.flow * p.flow, NOISE.leak);
    pressure = jitter(b.pressure * p.pressure, NOISE.leak);
  } else {
    flow = jitter(b.flow, NOISE.normal);
    pressure = jitter(b.pressure, NOISE.normal);
  }
  if (state.pump) {
    flow *= PUMP_FAULT.flowFactor;
    pressure *= PUMP_FAULT.pressureFactor;
  }
  if (state.riser.leak && f.id >= RISER_LEAK.aboveFloor) pressure *= RISER_LEAK.pressureFactor;
  f.flow = round(flow);
  f.pressure = round(pressure);
}

/* ---------------- Leak detection (rule-based) ----------------
   Floor level:
   1. Flow abnormal     -> flow     > baseline * (1 + flowRisePct%)
   2. Pressure abnormal -> pressure < baseline * (1 - pressureDropPct%)
   NORMAL         : neither abnormal
   WARNING        : one abnormal, or both abnormal but not yet confirmed
   LEAK SUSPECTED : both abnormal for N consecutive readings
   SENSOR OFFLINE : no data, so detection is paused for that floor
   VALVE CLOSED   : floor isolated after a confirmed leak
   Building level:
   - Supply issue : pressure low on many floors with no flow rise anywhere
   - Riser leak   : main meter exceeds the sum of floor meters
---------------------------------------------------------------- */
function computeIndicators(f) {
  if (f.offline || f.valveClosed) {
    f.flowAbn = false;
    f.pressAbn = false;
    return;
  }
  const s = state.settings;
  const b = baselineOf(f);
  f.flowAbn = f.flow > b.flow * (1 + s.flowRisePct / 100);
  f.pressAbn = f.pressure < b.pressure * (1 - s.pressureDropPct / 100);
}

function describe(f) {
  const b = baselineOf(f);
  const rise = (f.flow / b.flow - 1) * 100;
  const drop = (1 - f.pressure / b.pressure) * 100;
  const parts = [];
  if (f.flowAbn) parts.push(`Flow ${rise.toFixed(0)}% above baseline (${b.flow} L/min)`);
  if (f.pressAbn) parts.push(`Pressure ${drop.toFixed(0)}% below baseline (${b.pressure} bar)`);
  return { rise, drop, text: parts.length ? parts.join(' + ') : 'Readings within expected limits' };
}

function diagnoseSupply() {
  const live = state.floors.filter((f) => !f.offline && !f.valveClosed);
  const low = live.filter((f) => f.pressAbn && !f.flowAbn);
  const suspect = low.length >= SUPPLY_MIN_FLOORS && live.every((f) => !f.flowAbn);
  const sup = state.supply;
  const was = sup.confirmed;
  sup.suspect = suspect;
  sup.count = suspect ? sup.count + 1 : 0;
  sup.confirmed = suspect && sup.count >= state.settings.confirmReadings;
  sup.floors = low.map((f) => f.id);

  if (sup.confirmed && !was && !openAlerts(isType('SUPPLY ISSUE')).length) {
    const avgP = mean(low.map((f) => f.pressure));
    const avgDrop = mean(low.map((f) => (1 - f.pressure / baselineOf(f).pressure) * 100));
    const a = createAlert({
      floor: 0,
      location: 'Main supply / pump',
      flow: null,
      pressure: round(avgP),
      type: 'SUPPLY ISSUE',
      reason: `Pressure low on ${low.length} floors at once with no flow increase on any floor. A floor leak would lower pressure on one floor only.`,
      readingsText: `Average pressure ${avgP.toFixed(2)} bar (${avgDrop.toFixed(0)}% below normal) on ${low.length} floors`,
      priority: 'HIGH',
      action: 'Check the booster pump, its power supply and the overhead tank level. No floor-level leak inspection needed.',
      status: 'Active',
    });
    toast('Pump / supply issue diagnosed (not a floor leak)', 'warn');
    pushMessage('Pump maintenance', `LEAKLEVEL [HIGH]: Building-wide pressure drop at ${fmtClock(a.time)}, ${SEED.BUILDING.name}. Pressure low on ${low.length} floors, no extra flow anywhere: likely pump or supply fault, not a leak. Please check the booster pump.`, a.id);
  }
  if (!suspect && openAlerts(isType('SUPPLY ISSUE')).length) {
    closeAlerts(isType('SUPPLY ISSUE'), 'Auto-cleared – supply pressure restored');
  }
}

function evaluateFloor(f) {
  const s = state.settings;
  const prev = f.status;

  if (f.offline) {
    f.status = 'OFFLINE';
    f.abnormalCount = 0;
    f.reason = 'No data from floor sensor node – leak detection paused for this floor';
    return;
  }
  if (f.valveClosed) {
    f.status = 'ISOLATED';
    f.abnormalCount = 0;
    f.reason = `Floor valve closed${f.isolatedBy === 'auto' ? ' automatically' : ''} – leak contained, awaiting inspection`;
    return;
  }

  if (f.flowAbn && f.pressAbn) {
    f.abnormalCount += 1;
    f.status = f.abnormalCount >= s.confirmReadings ? 'LEAK' : 'WARNING';
  } else if (f.flowAbn || f.pressAbn) {
    f.abnormalCount = 0;
    f.status = 'WARNING';
  } else {
    f.abnormalCount = 0;
    f.status = 'NORMAL';
  }

  const d = describe(f);
  const supplyRelated = state.supply.suspect && f.pressAbn && !f.flowAbn;
  if (supplyRelated) {
    f.reason = `Pressure low on ${state.supply.floors.length} floors at once – likely pump/supply issue, not a floor leak`;
  } else if (f.status === 'WARNING' && f.flowAbn && f.pressAbn) {
    f.reason = `${d.text} – confirming (${f.abnormalCount}/${s.confirmReadings})`;
  } else {
    f.reason = d.text;
  }

  if (f.status === 'LEAK' && prev !== 'LEAK') {
    f.detectedAt = f.detectedAt || Date.now();
    if (!openAlerts(isFloorLeak(f.id)).length) raiseAlert(f, 'LEAK SUSPECTED');
  } else if (f.status === 'WARNING' && (prev === 'NORMAL' || prev === 'OFFLINE') && !(f.flowAbn && f.pressAbn) && !supplyRelated) {
    raiseAlert(f, 'WARNING');
  }

  // Readings back to normal: close any open leak alert for this floor.
  const cleared = f.status === 'NORMAL' || (f.status === 'WARNING' && !(f.flowAbn && f.pressAbn));
  if (cleared) {
    f.detectedAt = null;
    if (openAlerts(isFloorLeak(f.id)).length) closeAlerts(isFloorLeak(f.id), 'Auto-cleared – readings normalised');
  }
}

function estimateRiserLocation() {
  if (state.supply.suspect) return { above: null, text: 'Shared riser / common pipeline (segment unknown during supply issue)' };
  const deficit = (f) => !f.offline && !f.valveClosed && f.mode !== 'manual' && (1 - f.pressure / baselineOf(f).pressure) > 0.05;
  let lowest = null;
  for (let i = state.floors.length - 1; i >= 0; i--) {
    if (deficit(state.floors[i])) lowest = state.floors[i].id;
    else break;
  }
  if (!lowest) return { above: null, text: 'Shared riser / common pipeline (exact segment unknown)' };
  if (lowest === 1) return { above: 1, text: 'Likely in the riser near the main supply, below Floor 1' };
  return { above: lowest, text: `Likely in the riser between Floor ${lowest - 1} and Floor ${lowest} (pressure slightly low on Floor ${lowest} and above)` };
}

function evaluateBalance() {
  const m = state.meter;
  const r = state.riser;
  const allOnline = state.floors.every((f) => !f.offline);
  const trueFloors = sum(state.floors.map((f) => (f.valveClosed ? 0 : f.flow)));
  const measured = sum(state.floors.map((f) => (f.offline || f.valveClosed ? 0 : f.flow)));
  const riserFlow = r.leak ? jitter(RISER_LEAK.excess, NOISE.normal) : 0;
  m.main = round(jitter(trueFloors + riserFlow, NOISE.meter));
  m.floors = round(measured);
  m.unaccounted = round(m.main - m.floors);
  m.pct = m.main ? (m.unaccounted / m.main) * 100 : 0;
  m.available = allOnline;

  if (!allOnline) {
    r.status = 'UNKNOWN';
    r.count = 0;
    return;
  }

  const abnormal = m.unaccounted > Math.max(BALANCE_RULE.minLpm, (m.main * BALANCE_RULE.minPct) / 100);
  const prev = r.status;
  if (abnormal) {
    r.count += 1;
    r.status = r.count >= state.settings.confirmReadings ? 'LEAK' : 'WARNING';
    r.lost += m.unaccounted * SIM_MINUTES_PER_TICK;
    r.location = estimateRiserLocation();
  } else {
    r.count = 0;
    r.status = 'NORMAL';
  }

  if (r.status === 'LEAK' && prev !== 'LEAK' && !openAlerts(isType('RISER LEAK SUSPECTED')).length) {
    r.detectedAt = Date.now();
    const a = createAlert({
      floor: 0,
      location: 'Shared riser',
      flow: m.unaccounted,
      pressure: null,
      type: 'RISER LEAK SUSPECTED',
      reason: `Main meter ${m.main.toFixed(1)} L/min vs floor meters ${m.floors.toFixed(1)} L/min: ${m.unaccounted.toFixed(1)} L/min (${m.pct.toFixed(0)}%) unaccounted. All floor sensors read normal.`,
      readingsText: `${m.unaccounted.toFixed(1)} L/min unaccounted (${m.pct.toFixed(0)}% of inflow)`,
      priority: 'HIGH',
      action: `${r.location.text}. Inspect the shared riser and common pipeline: the water is escaping before it reaches any floor meter.`,
      status: 'Active',
    });
    toast('Hidden riser leak suspected (water balance mismatch)', 'danger');
    pushMessage('Maintenance team', `LEAKLEVEL ALERT [HIGH]: Possible leak in the shared riser, ${SEED.BUILDING.name}. ${m.unaccounted.toFixed(1)} L/min entering the building is not reaching any floor. ${r.location.text}. Detected ${fmtClock(a.time)}.`, a.id);
  }
  if (r.status === 'NORMAL') {
    r.detectedAt = null;
    if (openAlerts(isType('RISER LEAK SUSPECTED')).length) closeAlerts(isType('RISER LEAK SUSPECTED'), 'Auto-cleared – water balance restored');
  }
}

function recommendAction(f) {
  const n = f.id;
  if (f.flowAbn && f.pressAbn) {
    return `Inspect Floor ${n} branch line: check joints, valves, fittings and concealed pipe sections for seepage or wet patches. Close the Floor ${n} isolation valve if water loss continues.`;
  }
  if (f.flowAbn) return `Check Floor ${n} for open taps, running cisterns or unusually high consumption.`;
  if (f.pressAbn) return `Check the pump and Floor ${n} pressure-reducing valve, and verify the pressure sensor.`;
  if (f.offline) return `Check power and wiring of the Floor ${n} sensor node, then restore the data link.`;
  return 'No action required.';
}

function createAlert(fields) {
  const alert = {
    id: `${Date.now()}-${fields.floor}-${Math.random().toString(36).slice(2, 7)}`,
    time: Date.now(),
    status: 'Logged',
    ...fields,
  };
  state.history.unshift(alert);
  if (state.history.length > HISTORY_LIMIT) state.history.length = HISTORY_LIMIT;
  saveHistory();
  if (alert.status === 'Active') state.activeAlerts.push(alert.id);
  return alert;
}

function raiseAlert(f, type) {
  const d = describe(f);
  const isLeak = type === 'LEAK SUSPECTED';
  const isOffline = type === 'SENSOR OFFLINE';
  const a = createAlert({
    floor: f.id,
    flow: isOffline ? null : f.flow,
    pressure: isOffline ? null : f.pressure,
    type,
    reason: isOffline ? f.reason : d.text,
    priority: isLeak ? (d.rise >= 50 || d.drop >= 30 ? 'CRITICAL' : 'HIGH') : 'MEDIUM',
    action: recommendAction(f),
    status: isLeak ? 'Active' : 'Logged',
  });

  if (isLeak) {
    toast(`Leak suspected on Floor ${f.id}`, 'danger');
    pushMessage('Maintenance team', `LEAKLEVEL ALERT [${a.priority}]: Leak suspected on Floor ${f.id}, ${SEED.BUILDING.name}. Flow ${f.flow.toFixed(1)} L/min (+${d.rise.toFixed(0)}%), pressure ${f.pressure.toFixed(2)} bar (-${d.drop.toFixed(0)}%). Detected ${fmtClock(a.time)}.`, a.id);
  } else if (isOffline) {
    toast(`Floor ${f.id} sensor node offline – detection paused`, 'warn');
    pushMessage('Maintenance team', `LEAKLEVEL: Floor ${f.id} sensor node went offline at ${fmtClock(a.time)}. Leak detection is paused for this floor. Please check the sensor power and wiring.`);
  } else {
    toast(`Warning on Floor ${f.id}: ${d.text}`, 'warn');
  }
}

function pushMessage(to, text, alertId = null, dir = 'in') {
  messageSeq += 1;
  state.messages.push({ id: messageSeq, t: Date.now(), to, text, alertId, dir });
  if (state.messages.length > MESSAGE_LIMIT) state.messages.shift();
}

/* ---------------- Automatic shut-off valve ---------------- */
function isolateFloor(f, by) {
  if (f.valveClosed || f.offline) return;
  const b = baselineOf(f);
  const excess = Math.max(0, f.flow - b.flow);
  Object.assign(f, {
    valveClosed: true,
    isolatedBy: by,
    isolatedAt: Date.now(),
    leakTicks: 0,
    savedEstimate: Math.round(excess * SEED.summary.avgResolutionMin),
    status: 'ISOLATED',
    flow: 0,
    pressure: 0,
    flowAbn: false,
    pressAbn: false,
    abnormalCount: 0,
    reason: `Floor valve closed${by === 'auto' ? ' automatically' : ''} – leak contained, awaiting inspection`,
  });
  state.waterSaved += f.savedEstimate;
  openAlerts(isFloorLeak(f.id)).forEach((a) => {
    a.isolated = true;
    a.isolatedBy = by;
    a.isolatedAt = f.isolatedAt;
  });
  saveHistory();
  pushMessage('Maintenance team', `LEAKLEVEL: Floor ${f.id} valve closed ${by === 'auto' ? 'automatically' : 'by maintenance'} at ${fmtClock(f.isolatedAt)}. Leak contained. Est. ${f.savedEstimate.toLocaleString()} L saved vs the average manual response (${SEED.summary.avgResolutionMin} min). Inspection still required.`);
  pushMessage(`Residents, Floor ${f.id}`, `LEAKLEVEL: Water supply to Floor ${f.id} is temporarily shut off because of a suspected leak. Maintenance has been notified. Sorry for the inconvenience.`);
  toast(`Floor ${f.id} valve closed ${by === 'auto' ? 'automatically' : ''} – leak contained`, 'ok');
}

function handleAutoIsolation() {
  state.floors.forEach((f) => {
    f.leakTicks = f.status === 'LEAK' ? f.leakTicks + 1 : 0;
    if (state.settings.autoIsolate && f.status === 'LEAK' && f.leakTicks >= ISOLATE_AFTER_READINGS) isolateFloor(f, 'auto');
  });
}

/* ---------------- Main loop ---------------- */
function tick() {
  state.tick += 1;
  state.lastReadingAt = Date.now();
  state.floors.forEach(generateReading);
  state.floors.forEach(computeIndicators);
  diagnoseSupply();
  state.floors.forEach(evaluateFloor);
  evaluateBalance();
  handleAutoIsolation();
  state.mainConsumed += state.meter.main * SIM_MINUTES_PER_TICK;
  state.floors.forEach((f) => {
    if (f.offline) return;
    state.liveReadings += 1;
    f.consumed += f.flow * SIM_MINUTES_PER_TICK;
    if (f.flowAbn) f.lost += Math.max(0, f.flow - baselineOf(f).flow) * SIM_MINUTES_PER_TICK;
  });
  pushTrend();
  render();
}

function pushTrend() {
  const t = state.trend;
  t.labels.push(`T+${state.tick * SIM_MINUTES_PER_TICK}m`);
  state.floors.forEach((f, i) => {
    t.flow[i].push(f.offline ? null : f.flow);
    t.pressure[i].push(f.offline ? null : f.pressure);
  });
  if (t.labels.length > TREND_POINTS) {
    t.labels.shift();
    t.flow.forEach((arr) => arr.shift());
    t.pressure.forEach((arr) => arr.shift());
  }
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(tick, state.settings.intervalSec * 1000);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function setRunning(running) {
  state.running = running;
  if (running) startTimer(); else stopTimer();
  render();
}

// Apply a change immediately: take a reading now and restart the interval.
function advanceNow() {
  if (state.running) startTimer();
  tick();
}

/* ---------------- Actions ---------------- */
function resetBuilding(showToast = true) {
  state.activeAlerts.forEach((id) => {
    const a = findAlert(id);
    if (a) a.status = 'Closed – system reset';
  });
  state.activeAlerts = [];
  saveHistory();

  state.tick = 0;
  state.scenario = null;
  Object.assign(state, freshBuildingState());
  createFloors();
  state.trend = {
    labels: [],
    flow: state.floors.map(() => []),
    pressure: state.floors.map(() => []),
  };
  pushTrend();
  evaluateBalance();
  render();
  if (showToast) toast('Building reset to default readings', 'ok');
}

function setLeak(floorId, severity) {
  const f = state.floors[floorId - 1];
  f.mode = 'leak';
  f.severity = severity;
  f.manual = null;
}

function stopLeak(floorId) {
  const f = state.floors[floorId - 1];
  if (f.mode === 'normal') return false;
  f.mode = 'normal';
  f.manual = null;
  return true;
}

function toggleSensor(floorId) {
  const f = state.floors[floorId - 1];
  f.offline = !f.offline;
  if (f.offline) {
    f.status = 'OFFLINE';
    f.reason = 'No data from floor sensor node – leak detection paused for this floor';
    raiseAlert(f, 'SENSOR OFFLINE');
  } else {
    toast(`Floor ${floorId} sensor link restored`, 'ok');
  }
  state.scenario = null;
  advanceNow();
}

function runScenario(n) {
  resetBuilding(false);
  if (n === 2) setLeak(3, 'major');
  if (n === 3) {
    setLeak(2, 'major');
    setLeak(4, 'moderate');
  }
  if (n === 4) state.riser.leak = true;
  if (n === 5) state.pump = true;
  state.scenario = n;
  state.running = true;
  startTimer();
  tick();
  const names = { 1: 'Normal Building', 2: 'Single Floor Leakage', 3: 'Multiple Floor Abnormality', 4: 'Hidden Riser Leak', 5: 'Pump Failure' };
  toast(`Scenario ${n}: ${names[n]} started`, 'ok');
}

function acknowledgeAlert(id) {
  const a = findAlert(id);
  if (!a || a.status !== 'Active') return;
  a.status = 'Acknowledged';
  a.ackTime = Date.now();
  saveHistory();
  pushMessage('LEAKLEVEL', `ACK – ${locLabel(a)} alert received, team on the way.`, null, 'out');
  render();
  toast(`${locLabel(a)} alert acknowledged by maintenance`, 'ok');
}

function markInspected(id) {
  const a = findAlert(id);
  if (!a) return;
  a.status = 'Inspected – resolved';
  a.inspectedTime = Date.now();
  state.activeAlerts = state.activeAlerts.filter((x) => x !== id);
  saveHistory();

  if (a.type === 'LEAK SUSPECTED') {
    // Simulate the repair: the floor returns to normal operation and the valve reopens.
    const f = state.floors[a.floor - 1];
    Object.assign(f, {
      mode: 'normal', manual: null, valveClosed: false, isolatedBy: null, isolatedAt: null,
      abnormalCount: 0, leakTicks: 0, detectedAt: null, status: f.offline ? 'OFFLINE' : 'NORMAL',
    });
  } else if (a.type === 'RISER LEAK SUSPECTED') {
    Object.assign(state.riser, { leak: false, count: 0, status: 'NORMAL', detectedAt: null });
  } else if (a.type === 'SUPPLY ISSUE') {
    state.pump = false;
    state.supply = { suspect: false, count: 0, confirmed: false, floors: [] };
  }
  pushMessage('Maintenance team', `LEAKLEVEL: ${locLabel(a)} issue marked as inspected and resolved at ${fmtClock(a.inspectedTime)}.${a.type === 'LEAK SUSPECTED' ? ' Floor valve reopened.' : ''}`);
  toast(`${locLabel(a)} marked as inspected and resolved`, 'ok');
  advanceNow();
}

/* ---------------- Rendering (live) ---------------- */
const lastHtml = {};
function setHtml(el, key, html) {
  if (lastHtml[key] === html) return;   // avoid re-creating buttons while user clicks
  lastHtml[key] = html;
  el.innerHTML = html;
}

function overallStatus() {
  if (state.floors.some((f) => f.status === 'LEAK') || state.riser.status === 'LEAK') return 'LEAK';
  if (state.supply.confirmed) return 'SUPPLY';
  if (state.floors.some((f) => f.status === 'ISOLATED')) return 'ISOLATED';
  if (state.floors.some((f) => f.status === 'WARNING') || state.riser.status === 'WARNING') return 'WARNING';
  if (state.floors.some((f) => f.status === 'OFFLINE')) return 'OFFLINE';
  return 'NORMAL';
}

function render() {
  renderOverview();
  renderFloors();
  renderBanner();
  renderBuilding();
  renderMaintenance();
  renderBalance();
  renderMessages();
  renderDemoStatus();
  renderWater();
  renderHistory();
  renderSensorHealth();
  renderMaintenanceRecords();
  renderRisk();
  renderCost();
  updateCharts();
}

function renderOverview() {
  const status = overallStatus();
  const leakFloors = state.floors.filter((f) => f.status === 'LEAK');
  const leakNames = [...leakFloors.map((f) => `Floor ${f.id}`), ...(state.riser.status === 'LEAK' ? ['Riser'] : [])];
  const isoFloors = state.floors.filter((f) => f.status === 'ISOLATED');
  const warnFloors = state.floors.filter((f) => f.status === 'WARNING');
  const offFloors = state.floors.filter((f) => f.offline);

  const sys = $('#sysStatus');
  const sysText = $('#sysStatusText');
  sys.className = 'sys-status';
  if (!state.running) {
    sys.classList.add('status-paused');
    sysText.textContent = 'Simulation Paused';
  } else if (status === 'LEAK') {
    sys.classList.add('status-leak');
    sysText.textContent = `Leak Suspected: ${leakNames.join(', ')}`;
  } else if (status === 'SUPPLY') {
    sys.classList.add('status-supply');
    sysText.textContent = 'Pump / Supply Issue';
  } else if (status === 'ISOLATED') {
    sys.classList.add('status-isolated');
    sysText.textContent = `Leak Contained: Floor ${isoFloors.map((f) => f.id).join(', ')}`;
  } else if (status === 'WARNING') {
    sys.classList.add('status-warning');
    sysText.textContent = 'Warning';
  } else if (status === 'OFFLINE') {
    sys.classList.add('status-offline');
    sysText.textContent = 'Sensor Fault';
  } else {
    sys.classList.add('status-normal');
    sysText.textContent = 'System Normal';
  }

  const statStatus = $('#statStatus');
  statStatus.textContent = STATUS_LABEL[status];
  statStatus.className = `stat-value small text-${status.toLowerCase()}`;
  const subs = {
    LEAK: `${leakNames.join(', ')} suspected`,
    SUPPLY: 'Pump / supply, not a leak',
    ISOLATED: `${isoFloors.length} floor valve(s) closed`,
    WARNING: `${warnFloors.length + (state.riser.status === 'WARNING' ? 1 : 0)} item(s) under watch`,
    OFFLINE: `${offFloors.length} sensor node(s) offline`,
    NORMAL: 'All floors within limits',
  };
  $('#statStatusSub').textContent = subs[status];

  const online = (FLOOR_COUNT - offFloors.length) * 2;
  const statSensors = $('#statSensors');
  statSensors.textContent = `${online} / ${FLOOR_COUNT * 2}`;
  statSensors.className = `stat-value ${offFloors.length ? 'text-warning' : ''}`;

  const statEvents = $('#statEvents');
  statEvents.textContent = leakNames.length;
  statEvents.className = `stat-value ${leakNames.length ? 'text-leak' : ''}`;
  const logged = state.history.filter((a) => a.type === 'LEAK SUSPECTED' || a.type === 'RISER LEAK SUSPECTED').length;
  $('#statEventsSub').textContent = `${logged} logged this session · ${SEED.summary.leakIncidents} in 7-day history`;

  $('#statLoss').textContent = fmtLitres(totalLiveLoss());

  $('#simTime').textContent = `${state.tick * SIM_MINUTES_PER_TICK} min`;
  $('#simState').textContent = state.running ? 'Running' : 'Paused';
  $('#btnPause').innerHTML = state.running ? '&#10074;&#10074; Pause' : '&#9654; Resume';
  $('#btnRiser').classList.toggle('btn-active', state.riser.leak);
  $('#btnPump').classList.toggle('btn-active', state.pump);
  $('#srcSimCount').textContent = `${state.liveReadings.toLocaleString()} readings`;

  const s = state.settings;
  $('#demoConfirmText').textContent = s.confirmReadings;
  $('#ruleFlow').textContent = s.flowRisePct;
  $('#rulePressure').textContent = s.pressureDropPct;
  $('#ruleConfirm').textContent = s.confirmReadings;
}

function totalLiveLoss() {
  return sum(state.floors.map((f) => f.lost)) + state.riser.lost;
}

function buildFloorCards() {
  $('#floorGrid').innerHTML = state.floors.map((f) => `
    <div class="floor-card" id="floor-${f.id}">
      <div class="fc-head">
        <div>
          <div class="fc-title">Floor ${f.id}</div>
          <div class="fc-sub">Branch line F${f.id}</div>
        </div>
        <span class="badge badge-normal" data-role="badge">NORMAL</span>
      </div>
      <div class="metric flow" data-role="flowMetric">
        <span class="m-label">Flow rate</span>
        <span class="m-value"><b data-role="flow">0</b>L/min</span>
        <div class="m-base" data-role="flowBase"></div>
        <div class="bar"><span data-role="flowBar"></span></div>
      </div>
      <div class="metric pressure" data-role="pressMetric">
        <span class="m-label">Pressure</span>
        <span class="m-value"><b data-role="pressure">0</b>bar</span>
        <div class="m-base" data-role="pressBase"></div>
        <div class="bar"><span data-role="pressBar"></span></div>
      </div>
      <div class="fc-foot">
        <span class="conn"><span class="dot"></span><span data-role="conn"></span></span>
        <span class="fc-mode" data-role="mode"></span>
      </div>
      <div class="fc-reason" data-role="reason"></div>
    </div>`).join('');
}

function renderFloors() {
  state.floors.forEach((f) => {
    const card = $(`#floor-${f.id}`);
    if (!card) return;
    const q = (role) => card.querySelector(`[data-role="${role}"]`);
    const b = baselineOf(f);
    const key = f.status.toLowerCase();

    card.className = `floor-card status-${key}`;
    const badge = q('badge');
    badge.className = `badge badge-${key}`;
    badge.textContent = STATUS_LABEL[f.status];

    q('flow').textContent = f.offline ? '--' : f.flow.toFixed(1);
    q('pressure').textContent = f.offline ? '--' : f.pressure.toFixed(2);
    q('flowBase').textContent = `Baseline ${b.flow.toFixed(1)} L/min`;
    q('pressBase').textContent = `Baseline ${b.pressure.toFixed(2)} bar`;
    q('flowBar').style.width = f.offline ? '0%' : `${Math.min(100, (f.flow / (b.flow * 2)) * 100)}%`;
    q('pressBar').style.width = f.offline ? '0%' : `${Math.min(100, (f.pressure / (b.pressure * 1.5)) * 100)}%`;
    q('flowMetric').classList.toggle('abn', f.flowAbn);
    q('pressMetric').classList.toggle('abn', f.pressAbn);
    q('conn').textContent = f.offline ? 'Sensor node offline (simulated fault)'
      : f.valveClosed ? 'Floor valve closed (simulated actuator)' : 'Flow & pressure sensors online (simulated)';

    q('mode').textContent = f.valveClosed ? `Est. ${f.savedEstimate.toLocaleString()} L saved by shut-off`
      : f.mode === 'leak' ? `Leak simulation active (${LEAK_PROFILES[f.severity].label})`
        : f.mode === 'manual' ? 'Manual test values applied' : '';
    q('reason').textContent = f.status === 'NORMAL' ? '' : f.reason;
  });
}

function renderBanner() {
  const banner = $('#alertBanner');
  const r = state.riser;
  const m = state.meter;
  const leaks = state.floors.filter((f) => f.status === 'LEAK');
  const isolated = state.floors.filter((f) => f.status === 'ISOLATED');
  const warns = state.floors.filter((f) => f.status === 'WARNING');
  const offline = state.floors.filter((f) => f.status === 'OFFLINE');
  const riserLeak = r.status === 'LEAK';

  if (leaks.length || riserLeak) {
    banner.className = 'alert-banner';
    const names = [...leaks.map((f) => `Floor ${f.id}`), ...(riserLeak ? ['Shared Riser'] : [])];
    const floorCards = leaks.map((f) => {
      const b = baselineOf(f);
      const autoNote = state.settings.autoIsolate
        ? `<div><strong>Auto shut-off:</strong> valve closes in ${Math.max(0, ISOLATE_AFTER_READINGS - f.leakTicks)} reading(s)</div>` : '';
      return `
        <div class="banner-floor">
          <div class="big">Floor<b>${f.id}</b>suspected</div>
          <div class="info">
            <div><strong>Reason:</strong> ${escapeHtml(f.reason)}</div>
            <div><strong>Flow:</strong> ${f.flow.toFixed(1)} L/min (baseline ${b.flow.toFixed(1)})</div>
            <div><strong>Pressure:</strong> ${f.pressure.toFixed(2)} bar (baseline ${b.pressure.toFixed(2)})</div>
            <div><strong>Detected:</strong> ${f.detectedAt ? fmtTime(f.detectedAt) : '-'}</div>
            ${autoNote}
          </div>
        </div>`;
    });
    if (riserLeak) {
      floorCards.push(`
        <div class="banner-floor">
          <div class="big riser"><b>RISER</b>shared pipe</div>
          <div class="info">
            <div><strong>Reason:</strong> ${m.unaccounted.toFixed(1)} L/min (${m.pct.toFixed(0)}%) enters the building but reaches no floor meter</div>
            <div><strong>Main meter:</strong> ${m.main.toFixed(1)} L/min &middot; <strong>Floors:</strong> ${m.floors.toFixed(1)} L/min</div>
            <div><strong>Location estimate:</strong> ${escapeHtml(r.location ? r.location.text : 'Shared riser')}</div>
            <div><strong>Detected:</strong> ${r.detectedAt ? fmtTime(r.detectedAt) : '-'}</div>
          </div>
        </div>`);
    }
    banner.innerHTML = `
      <div class="banner-title"><span class="banner-icon">&#9888;</span>LEAK SUSPECTED – ${names.join(' & ')}</div>
      <div class="banner-floors">${floorCards.join('')}</div>
      <p class="banner-note">Suspected location based on simulated readings. Physical inspection is required to confirm the exact leak location.${isolated.length ? ` Floor ${isolated.map((f) => f.id).join(', ')} valve already closed.` : ''}</p>`;
  } else if (isolated.length) {
    banner.className = 'alert-banner contained';
    banner.innerHTML = `
      <div class="banner-title"><span class="banner-icon">&#10004;</span>LEAK CONTAINED – Floor ${isolated.map((f) => f.id).join(' & ')} valve closed</div>
      <div class="banner-floors">
        ${isolated.map((f) => `
          <div class="banner-floor">
            <div class="big">Floor<b>${f.id}</b>isolated</div>
            <div class="info">
              <div><strong>Valve closed:</strong> ${f.isolatedBy === 'auto' ? 'automatically' : 'by maintenance'} at ${fmtClock(f.isolatedAt)}</div>
              <div><strong>Est. water saved:</strong> ${f.savedEstimate.toLocaleString()} L vs average manual response (${SEED.summary.avgResolutionMin} min, from history)</div>
              <div><strong>Next step:</strong> inspect and repair, then click "Mark as Inspected" to reopen the valve</div>
            </div>
          </div>`).join('')}
      </div>
      <p class="banner-note">Residents of the isolated floor have been notified (simulated message).</p>`;
  } else if (state.supply.confirmed) {
    banner.className = 'alert-banner supply';
    banner.innerHTML = `
      <div class="banner-title"><span class="banner-icon">&#9888;</span>PUMP / SUPPLY ISSUE – not a floor leak</div>
      <p class="banner-note">Pressure is low on ${state.supply.floors.length} floors at the same time and no floor shows extra flow. A leak would lower pressure on one floor only, so LEAKLEVEL sends the pump team instead of plumbers to every floor.</p>`;
  } else if (warns.length || r.status === 'WARNING' || state.supply.suspect) {
    banner.className = 'alert-banner warning';
    const items = warns.map((f) => `<div class="banner-floor"><div class="big">Floor<b>${f.id}</b>watch</div><div class="info">${escapeHtml(f.reason)}</div></div>`);
    if (r.status === 'WARNING') {
      items.push(`<div class="banner-floor"><div class="big riser"><b>RISER</b>watch</div><div class="info">${m.unaccounted.toFixed(1)} L/min unaccounted water – confirming (${r.count}/${state.settings.confirmReadings})</div></div>`);
    }
    banner.innerHTML = `
      <div class="banner-title"><span class="banner-icon">&#9888;</span>WARNING – Abnormal readings under watch</div>
      <div class="banner-floors">${items.join('')}</div>`;
  } else if (offline.length) {
    banner.className = 'alert-banner offline';
    banner.innerHTML = `
      <div class="banner-title"><span class="banner-icon">&#9888;</span>SENSOR FAULT – Floor ${offline.map((f) => f.id).join(', ')} offline</div>
      <p class="banner-note">No data is arriving from the sensor node, so leaks on this floor cannot be detected until the link is restored. The water balance check is also paused. (Simulated fault.)</p>`;
  } else {
    banner.className = 'alert-banner hidden';
    banner.innerHTML = '';
  }
}

function renderBuilding() {
  const r = state.riser;
  const showRiser = (r.status === 'LEAK' || r.status === 'WARNING') && r.location && r.location.above;
  const rows = [...state.floors].reverse().map((f) => {
    const row = `
      <div class="b-floor status-${f.status.toLowerCase()}">
        <span class="b-label">F${f.id}</span>
        <span class="b-pipe"></span>
        <span class="b-state text-${f.status.toLowerCase()}">${STATUS_LABEL[f.status]}</span>
      </div>`;
    const marker = showRiser && f.id === r.location.above
      ? `<div class="b-riser-leak ${r.status === 'LEAK' ? '' : 'confirming'}">&#9888; Riser leak suspected ${f.id === 1 ? 'below Floor 1' : `between F${f.id - 1} and F${f.id}`}</div>` : '';
    return row + marker;
  }).join('');
  const m = state.meter;
  const ground = state.pump
    ? 'Ground level &middot; Pump: <strong class="text-supply">pressure fault</strong>'
    : 'Ground level &middot; Main supply &amp; pump &rarr; shared riser pipeline';
  setHtml($('#buildingDiagram'), 'building',
    `<div class="b-roof"></div>${rows}<div class="b-ground">${ground}<br>Main meter ${m.main.toFixed(1)} L/min &middot; Floors ${m.floors.toFixed(1)} L/min &middot; Unaccounted ${m.available ? `${m.unaccounted.toFixed(1)} L/min` : 'n/a'}</div>`);
}

function renderMaintenance() {
  const items = state.activeAlerts.map(findAlert).filter(Boolean);
  const titles = { 'LEAK SUSPECTED': 'Suspected Leak', 'RISER LEAK SUSPECTED': 'Suspected Riser Leak', 'SUPPLY ISSUE': 'Pump / Supply Issue' };
  let html;
  if (!items.length) {
    html = `<div class="empty-state"><div class="ok-icon">&#10004;</div>No open alerts. All maintenance tasks are clear.<br><small>Past resolved work is listed in Records &rarr; Maintenance Records.</small></div>`;
  } else {
    html = items.map((a) => {
      const f = a.type === 'LEAK SUSPECTED' ? state.floors[a.floor - 1] : null;
      const canIsolate = f && !f.valveClosed && !f.offline;
      const valveText = a.isolated ? ` · valve closed ${a.isolatedBy === 'auto' ? 'automatically' : 'manually'}` : '';
      return `
      <div class="maint-item ${a.status === 'Acknowledged' ? 'acked' : ''}">
        <div class="maint-top">
          <h3>${escapeHtml(locLabel(a))} – ${titles[a.type] || a.type}</h3>
          <span class="priority priority-${a.priority}">${a.priority}</span>
        </div>
        <dl>
          <dt>Location</dt><dd>${a.floor ? `Floor ${a.floor} branch line` : escapeHtml(a.location)}</dd>
          <dt>Priority</dt><dd>${a.priority}</dd>
          <dt>Reason</dt><dd>${escapeHtml(a.reason)}</dd>
          <dt>Readings</dt><dd>${escapeHtml(a.readingsText || `${fmtNum(a.flow, 1)} L/min · ${fmtNum(a.pressure, 2)} bar`)}</dd>
          <dt>Detected</dt><dd>${fmtTime(a.time)}</dd>
          <dt>Recommended</dt><dd>${escapeHtml(a.action)}</dd>
          <dt>Status</dt><dd>${a.status}${valveText}</dd>
        </dl>
        <div class="btn-row">
          ${a.status === 'Active' ? `<button class="btn btn-primary btn-sm" data-action="ack" data-id="${a.id}">Acknowledge Alert</button>` : ''}
          ${canIsolate ? `<button class="btn btn-outline btn-sm" data-action="isolate" data-id="${a.id}">Close Floor Valve</button>` : ''}
          <button class="btn btn-success btn-sm" data-action="inspect" data-id="${a.id}">Mark as Inspected</button>
        </div>
      </div>`;
    }).join('');
  }
  setHtml($('#maintenanceList'), 'maint', html);
}

function renderBalance() {
  const m = state.meter;
  const r = state.riser;
  const confirm = state.settings.confirmReadings;
  const bad = m.available && r.status !== 'NORMAL';
  const floorsPct = m.main ? Math.max(0, Math.min(100, (m.floors / m.main) * 100)) : 100;
  let statusClass;
  let statusText;
  if (!m.available) {
    statusClass = 'unknown';
    statusText = 'Balance check paused: a floor sensor is offline, so floor usage cannot be fully measured.';
  } else if (r.status === 'LEAK') {
    statusClass = 'bad';
    statusText = `Riser leak suspected: water is escaping from the shared pipe before reaching any floor meter. ${r.location ? r.location.text : ''}.`;
  } else if (r.status === 'WARNING') {
    statusClass = 'warn';
    statusText = `Unaccounted water detected – confirming (${r.count}/${confirm}).`;
  } else {
    statusClass = 'ok';
    statusText = 'Balanced: all water entering the building is measured by the floor meters.';
  }
  setHtml($('#balanceBody'), 'balance', `
    <div class="balance-grid">
      <div><span class="stat-label">Main meter (inlet)</span><span class="stat-value">${m.main.toFixed(1)}<span class="unit">L/min</span></span></div>
      <div><span class="stat-label">Sum of floor meters</span><span class="stat-value">${m.floors.toFixed(1)}<span class="unit">L/min</span></span></div>
      <div class="unacc ${bad ? 'bad' : ''}"><span class="stat-label">Unaccounted</span><span class="stat-value">${m.available ? m.unaccounted.toFixed(1) : '--'}<span class="unit">L/min ${m.available ? `(${m.pct.toFixed(1)}%)` : ''}</span></span></div>
    </div>
    <div class="balance-bar" title="Blue: measured by floor meters. Red: unaccounted.">
      <span class="bb-floors" style="width:${floorsPct}%"></span>
      <span class="bb-unacc" style="width:${m.available ? 100 - floorsPct : 0}%"></span>
    </div>
    <div class="balance-status ${statusClass}">${escapeHtml(statusText)}</div>
    <p class="disclaimer">Rule: unaccounted water above ${BALANCE_RULE.minLpm} L/min or ${BALANCE_RULE.minPct}% of inflow for ${confirm} readings means a riser leak is suspected. Main meter is simulated.</p>`);
}

const SEEDED_MESSAGES = LEAKLEVEL_DATA.incidents.flatMap((inc) => {
  const where = `Floor ${inc.floor}, ${LEAKLEVEL_DATA.BUILDING.name}`;
  const alertText = inc.alertType === 'LEAK SUSPECTED'
    ? `LEAKLEVEL ALERT [${inc.priority}]: Leak suspected on ${where}. Flow ${inc.peakFlow.toFixed(1)} L/min, pressure ${inc.minPressure.toFixed(2)} bar. Please inspect.`
    : `LEAKLEVEL WARNING [${inc.priority}]: ${inc.kind === 'pressure' ? `Low pressure (${inc.minPressure.toFixed(2)} bar)` : `High flow (${inc.peakFlow.toFixed(1)} L/min)`} on ${where}. Please check.`;
  return [
    { t: inc.confirmedAt || inc.detectedAt, to: 'Maintenance team', text: alertText, dir: 'in', alert: true },
    { t: inc.ackAt, to: inc.team, text: `ACK ${inc.id}. ${inc.team} on the way to Floor ${inc.floor}.`, dir: 'out' },
    { t: inc.resolvedAt, to: 'Maintenance team', text: `LEAKLEVEL: ${inc.id} on Floor ${inc.floor} resolved. ${inc.action}. Outcome: ${inc.outcome}.`, dir: 'in' },
  ];
}).sort((a, b) => b.t - a.t);

function messageHtml(msg, seeded) {
  const a = msg.alertId ? findAlert(msg.alertId) : null;
  const quick = a && a.status === 'Active' ? `<button class="quick-btn" data-action="ack" data-id="${a.id}">Reply ACK</button>` : '';
  const from = msg.dir === 'out' ? `From: ${seeded ? escapeHtml(msg.to) : 'Maintenance'}` : `To: ${escapeHtml(msg.to)}`;
  return `
    <div class="msg ${msg.dir} ${msg.alertId || msg.alert ? 'alert' : ''} ${seeded ? 'seeded' : ''}">
      <div class="msg-meta"><span class="msg-to">${from}</span><span>${seeded ? fmtShort(msg.t) : fmtClock(msg.t)}</span></div>
      <div class="msg-text">${escapeHtml(msg.text)}</div>
      ${quick}
    </div>`;
}

function renderMessages() {
  const live = [...state.messages].reverse().map((msg) => messageHtml(msg, false)).join('');
  const html = (live || '<div class="phone-empty">No live notifications yet. Run a demo scenario to see new alerts here.</div>')
    + '<div class="msg-divider">Seeded sample messages · past 7 days</div>'
    + SEEDED_MESSAGES.map((msg) => messageHtml(msg, true)).join('');
  setHtml($('#phoneMessages'), 'messages', html);
}

function renderDemoStatus() {
  $$('.demo-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.scenario) === state.scenario));
  const el = $('#demoStatus');
  const n = state.scenario;
  if (!n) {
    el.textContent = 'No scenario active. Choose a scenario above.';
    return;
  }
  const s = state.settings;
  const progress = (f) => (f.status === 'ISOLATED' ? `leak confirmed and valve closed automatically (est. ${f.savedEstimate.toLocaleString()} L saved)`
    : f.status === 'LEAK' ? `identified as suspected leak location${s.autoIsolate ? `, auto shut-off in ${Math.max(0, ISOLATE_AFTER_READINGS - f.leakTicks)} reading(s)` : ''}`
      : f.abnormalCount > 0 ? `abnormal readings, confirming (${f.abnormalCount}/${s.confirmReadings})`
        : 'waiting for readings');
  if (n === 1) {
    el.innerHTML = `<strong>Scenario 1 – Normal Building:</strong> all floors are operating normally and the water balance matches. ${overallStatus() === 'NORMAL' ? 'No alerts.' : ''}`;
  } else if (n === 2) {
    el.innerHTML = `<strong>Scenario 2 – Single Floor Leakage:</strong> flow rising and pressure dropping on Floor 3. Floor 3: ${progress(state.floors[2])}.`;
  } else if (n === 3) {
    el.innerHTML = `<strong>Scenario 3 – Multiple Floor Abnormality:</strong> Floor 2 (major) and Floor 4 (moderate). Floor 2: ${progress(state.floors[1])}. Floor 4: ${progress(state.floors[3])}.`;
  } else if (n === 4) {
    const r = state.riser;
    const stage = r.status === 'LEAK' ? `riser leak suspected. ${r.location ? r.location.text : ''}`
      : r.count > 0 ? `confirming (${r.count}/${s.confirmReadings})` : 'checking the water balance';
    el.innerHTML = `<strong>Scenario 4 – Hidden Riser Leak:</strong> every floor meter reads normal, but the main meter shows ${state.meter.unaccounted.toFixed(1)} L/min more than the floors use. Status: ${escapeHtml(stage)}.`;
  } else {
    const sup = state.supply;
    const stage = sup.confirmed ? 'diagnosed as a pump / supply issue, NOT a floor leak. No plumbers are sent to the floors.'
      : sup.count > 0 ? `checking (${sup.count}/${s.confirmReadings})` : 'waiting for readings';
    el.innerHTML = `<strong>Scenario 5 – Pump Failure:</strong> pressure is low on every floor and no floor shows extra flow. Status: ${stage}`;
  }
}

function renderWater() {
  const total = state.mainConsumed;
  const loss = totalLiveLoss();
  $('#waterTotal').textContent = fmtLitres(total);
  $('#waterLoss').textContent = fmtLitres(loss);
  $('#waterShare').textContent = total ? `${((loss / total) * 100).toFixed(1)}%` : '0%';

  const max = Math.max(1, ...state.floors.map((f) => f.consumed));
  setHtml($('#consumptionBars'), 'water', state.floors.map((f) => {
    const w = (f.consumed / max) * 100;
    const lw = (f.lost / max) * 100;
    return `
      <div class="cb-row">
        <span>Floor ${f.id}</span>
        <div class="cb-track">
          <div class="cb-fill" style="width:${w}%"></div>
          <div class="cb-loss" style="left:${w - lw}%;width:${lw}%" title="Estimated loss"></div>
        </div>
        <span class="cb-val">${fmtLitres(f.consumed)}${f.lost ? ` <span class="text-leak">(-${Math.round(f.lost)})</span>` : ''}</span>
      </div>`;
  }).join('') + (state.riser.lost ? `
      <div class="cb-row">
        <span>Riser</span>
        <div class="cb-track"><div class="cb-loss" style="left:0;width:${Math.min(100, (state.riser.lost / max) * 100)}%"></div></div>
        <span class="cb-val text-leak">-${Math.round(state.riser.lost)} L</span>
      </div>` : ''));
}

function renderHistory() {
  const body = $('#historyBody');
  if (!state.history.length) {
    setHtml(body, 'history', '<tr class="empty"><td colspan="6">No live alerts recorded yet. Run a demo scenario to generate alerts.</td></tr>');
    return;
  }
  const statusClass = (s) => (s === 'Active' ? 'Active' : s === 'Acknowledged' ? 'Acknowledged' : s.startsWith('Inspected') ? 'Inspected' : 'Other');
  const typeBadge = (t) => (t.includes('LEAK') ? 'badge-leak' : t === 'SENSOR OFFLINE' ? 'badge-offline' : 'badge-warning');
  setHtml(body, 'history', state.history.map((a) => `
    <tr>
      <td>${fmtTime(a.time)}</td>
      <td>${escapeHtml(locLabel(a))}</td>
      <td>${fmtNum(a.flow, 1)}</td>
      <td>${fmtNum(a.pressure, 2)}</td>
      <td><span class="badge ${typeBadge(a.type)}">${escapeHtml(a.type)}</span></td>
      <td><span class="st st-${statusClass(a.status)}">${escapeHtml(a.status)}${a.isolated ? ' · valve closed' : ''}</span></td>
    </tr>`).join(''));
}

function renderSensorHealth() {
  const html = SEED.sensors.map((s) => {
    const f = state.floors[s.floor - 1];
    const online = !f.offline;
    const value = !online ? '--' : s.kind === 'flow' ? `${f.flow.toFixed(1)} L/min` : `${f.pressure.toFixed(2)} bar`;
    return `
      <tr>
        <td><strong>${s.id}</strong><span class="small-muted">${escapeHtml(s.model)}</span></td>
        <td>Floor ${s.floor}</td>
        <td>${s.type}</td>
        <td><span class="pill ${online ? 'pill-online' : 'pill-offline'}">${online ? 'ONLINE' : 'OFFLINE'}</span></td>
        <td>${value}<span class="small-muted">${online ? `at ${fmtClock(state.lastReadingAt)}` : 'no data'}</span></td>
        <td>${online ? `${s.signal} dBm` : '--'}</td>
        <td>${s.uptime7d}%</td>
        <td>${new Date(s.calibratedAt).toLocaleDateString()}</td>
        <td>${online ? escapeHtml(s.note) : 'Link lost (simulated fault)'}</td>
      </tr>`;
  }).join('');
  setHtml($('#sensorBody'), 'sensors', html);
}

function renderMaintenanceRecords() {
  const live = state.history
    .filter((a) => ACTIONABLE_TYPES.includes(a.type) && (a.ackTime || a.inspectedTime))
    .map((a) => ({
      id: 'LIVE',
      location: locLabel(a),
      alertType: a.type,
      detectedAt: a.time,
      ackAt: a.ackTime || null,
      resolvedAt: a.inspectedTime || null,
      responseMin: a.ackTime ? Math.max(0, Math.round((a.ackTime - a.time) / 60000)) : null,
      team: 'Maintenance (demo)',
      action: `${a.isolated ? 'Valve closed, ' : ''}${a.inspectedTime ? 'marked as inspected in dashboard' : 'acknowledged, inspection pending'}`,
      outcome: a.status,
      source: 'Simulated live',
    }));
  const rows = [...live, ...SEED.maintenance].sort((a, b) => b.detectedAt - a.detectedAt);
  const html = rows.map((m) => `
    <tr>
      <td><strong>${m.id}</strong>${m.incident ? `<span class="small-muted">${m.incident}</span>` : ''}</td>
      <td>${escapeHtml(m.location || `Floor ${m.floor}`)}</td>
      <td><span class="pill ${m.alertType.includes('LEAK') ? 'pill-leak' : 'pill-warning'}">${m.alertType}</span></td>
      <td>${fmtShort(m.detectedAt)}</td>
      <td>${m.ackAt ? fmtShort(m.ackAt) : '--'}</td>
      <td>${m.resolvedAt ? fmtShort(m.resolvedAt) : '--'}</td>
      <td>${m.responseMin !== null && m.responseMin !== undefined ? `${m.responseMin} min` : '--'}</td>
      <td class="wrap-cell"><strong>${escapeHtml(m.team)}</strong><span class="small-muted">${escapeHtml(m.action)}</span></td>
      <td class="wrap-cell">${escapeHtml(m.outcome)}</td>
      <td><span class="pill ${m.source === 'Seeded' ? 'pill-seed' : 'pill-sim'}">${m.source}</span></td>
    </tr>`).join('');
  setHtml($('#maintRecordsBody'), 'maintRecords', html);
}

/* ---------------- Smart analytics (learned from seeded history) ---------------- */

// Self-learning baseline: average normal flow/pressure for each floor at each hour of day,
// learned only from normal records (incident hours excluded).
const LEARNED = (() => {
  const buckets = SEED.BASELINES.map(() => Array.from({ length: 24 }, () => ({ f: [], p: [] })));
  SEED.hourly.forEach((r) => {
    if (r.incident || r.status !== 'Normal') return;
    const b = buckets[r.floor - 1][new Date(r.t).getHours()];
    b.f.push(r.flow);
    b.p.push(r.pressure);
  });
  return buckets.map((hours) => hours.map((x) => ({ flow: mean(x.f), pressure: mean(x.p), samples: x.f.length })));
})();

const adaptiveLimit = (floor, hour) => {
  const L = LEARNED[floor - 1][hour];
  return {
    flow: L.flow * (1 + SEED.RULES.flowRisePct / 100) + 0.3,
    pressure: L.pressure * (1 - SEED.RULES.pressureDropPct / 100),
  };
};

// Replays the 7-day hourly history through both methods.
const DETECTION_COMPARISON = (() => {
  const res = { incidentHours: 0, normalHours: 0, fixedHit: 0, adaptHit: 0, fixedFalse: 0, adaptFalse: 0 };
  SEED.hourly.forEach((r) => {
    const b = SEED.BASELINES[r.floor - 1];
    const lim = adaptiveLimit(r.floor, new Date(r.t).getHours());
    const fixed = r.flow > b.flow * (1 + SEED.RULES.flowRisePct / 100) || r.pressure < b.pressure * (1 - SEED.RULES.pressureDropPct / 100);
    const adapt = r.flow > lim.flow || r.pressure < lim.pressure;
    if (r.incident) {
      res.incidentHours += 1;
      if (fixed) res.fixedHit += 1;
      if (adapt) res.adaptHit += 1;
    } else {
      res.normalHours += 1;
      if (fixed) res.fixedFalse += 1;
      if (adapt) res.adaptFalse += 1;
    }
  });
  return res;
})();

// Night-flow check: average flow 02:00–04:00 for every night, compared with the floor's typical night.
const NIGHT = (() => {
  const nights = SEED.days.map((d) => d.start);
  if (SEED.anchor >= SEED.today + 4 * 3600 * 1000) nights.push(SEED.today);
  const rows = SEED.BASELINES.map((b) => {
    const values = nights.map((ns) => {
      const recs = SEED.hourly.filter((r) => r.floor === b.floor && r.t >= ns + 2 * 3600 * 1000 && r.t < ns + 4 * 3600 * 1000);
      return recs.length ? mean(recs.map((r) => r.flow)) : null;
    });
    const sorted = values.filter((v) => v !== null).sort((x, y) => x - y);
    const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const flags = values.map((v) => v !== null && v > typical * 2 && v - typical > 1);
    return { floor: b.floor, values, typical, flags, flagged: flags.filter(Boolean).length };
  });
  return { nights, rows };
})();

function renderAdaptiveCompare() {
  const c = DETECTION_COMPARISON;
  const pct = (v, t) => (t ? Math.round((v / t) * 100) : 0);
  $('#adaptCompare').innerHTML = `
    <div class="compare-card">
      <h4>Replay of 7-day history (${c.incidentHours} incident hours, ${c.normalHours.toLocaleString()} normal hours)</h4>
      <div class="compare-row cmp-fixed">
        <span>Fixed peak threshold: incident hours caught</span><strong>${c.fixedHit} / ${c.incidentHours}</strong>
        <div class="cmp-bar"><span style="width:${pct(c.fixedHit, c.incidentHours)}%"></span></div>
      </div>
      <div class="compare-row cmp-adapt">
        <span>Self-learning baseline: incident hours caught</span><strong>${c.adaptHit} / ${c.incidentHours}</strong>
        <div class="cmp-bar"><span style="width:${pct(c.adaptHit, c.incidentHours)}%"></span></div>
      </div>
      <div class="compare-row">
        <span>False alarms on normal hours</span><strong>${c.fixedFalse} vs ${c.adaptFalse}</strong>
      </div>
      <p>A fixed limit set for peak demand cannot see a small leak at 3 AM, when normal flow is only about 1 L/min. Learning what is normal for each floor at each hour catches it without extra false alarms.</p>
    </div>`;
}

function adaptiveChartData(floor) {
  const b = SEED.BASELINES[floor - 1];
  const incs = SEED.incidents.filter((x) => x.floor === floor);
  const latest = incs.length ? incs[incs.length - 1] : null;
  const dayFrom = latest ? new Date(latest.start).setHours(0, 0, 0, 0) : SEED.today - DAY_MS;
  const actual = Array.from({ length: 24 }, (_, h) => {
    const rec = SEED.hourly.find((r) => r.floor === floor && r.t === dayFrom + h * 3600 * 1000);
    return rec ? rec.flow : null;
  });
  return {
    cfg: {
      type: 'line',
      labels: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`),
      datasets: [
        { label: 'Learned normal', data: LEARNED[floor - 1].map((x) => round(x.flow)), color: '#22d3ee' },
        { label: 'Adaptive limit', data: LEARNED[floor - 1].map((x, h) => round(adaptiveLimit(floor, h).flow)), color: 'rgba(34,211,238,0.6)', dashed: true },
        { label: 'Fixed limit', data: Array(24).fill(round(b.flow * (1 + SEED.RULES.flowRisePct / 100))), color: '#f87171', dashed: true },
        { label: `Actual ${fmtDay(dayFrom)}`, data: actual, color: '#f59e0b' },
      ],
    },
    note: latest
      ? `Actual readings shown for ${fmtDay(dayFrom)} (${latest.id}: ${latest.cause.toLowerCase()}). Wherever the amber line rises above the dashed cyan limit, the self-learning baseline flags it.`
      : `Actual readings shown for ${fmtDay(dayFrom)}. No incidents on this floor in the last 7 days.`,
  };
}

function renderNight() {
  const head = `<thead><tr><th>Floor</th>${NIGHT.nights.map((t) => `<th>${new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric' })}</th>`).join('')}<th>Typical</th></tr></thead>`;
  const body = NIGHT.rows.map((r) => `
    <tr>
      <td>Floor ${r.floor}</td>
      ${r.values.map((v, i) => `<td class="hm ${r.flags[i] ? 'hm-high' : 'hm-normal'}">${fmtNum(v, 1)}</td>`).join('')}
      <td class="muted">${r.typical.toFixed(1)}</td>
    </tr>`).join('');
  $('#nightTable').innerHTML = head + `<tbody>${body}</tbody>`;
  const flagged = [];
  NIGHT.rows.forEach((r) => r.flags.forEach((fl, i) => {
    if (fl) flagged.push(`Floor ${r.floor} on ${fmtDay(NIGHT.nights[i])} (${r.values[i].toFixed(1)} L/min vs typical ${r.typical.toFixed(1)})`);
  }));
  $('#nightNote').textContent = flagged.length
    ? `Abnormal nights: ${flagged.join('; ')}. Values are average L/min between 02:00 and 04:00.`
    : 'No abnormal nights found. Values are average L/min between 02:00 and 04:00.';
}

function riskScores() {
  return SEED.BASELINES.map((b, i) => {
    const incs = SEED.incidents.filter((x) => x.floor === b.floor);
    const leaks = incs.filter((x) => x.kind === 'leak').length;
    const warns = incs.length - leaks;
    const nights = NIGHT.rows[i].flagged;
    const live = Math.min(2, state.history.filter((a) => a.type === 'LEAK SUSPECTED' && a.floor === b.floor).length);
    const recent = incs.some((x) => SEED.anchor - x.start < 2.5 * DAY_MS);
    const usage = SEED.summary.perFloor7d[i] / (SEED.expectedDaily[i] * SEED.days.length);
    const over = Math.max(0, usage - 1);
    const score = Math.min(100, leaks * 35 + warns * 12 + nights * 15 + live * 20 + (recent ? 10 : 0) + Math.round(over * 200));
    const why = [];
    if (leaks) why.push(`${leaks} leak${leaks > 1 ? 's' : ''} in 7 days`);
    if (warns) why.push(`${warns} warning${warns > 1 ? 's' : ''}`);
    if (nights) why.push(`${nights} abnormal night${nights > 1 ? 's' : ''}`);
    if (live) why.push(`${live} live leak alert${live > 1 ? 's' : ''}`);
    if (recent) why.push('incident in last 48 h');
    if (over > 0.01) why.push(`usage ${(over * 100).toFixed(1)}% above expected`);
    const level = score >= 60 ? 'High' : score >= 30 ? 'Medium' : 'Low';
    const action = level === 'High' ? 'Schedule preventive inspection this week'
      : level === 'Medium' ? 'Inspect at next routine visit' : 'Routine monitoring';
    return { floor: b.floor, score, level, why: why.length ? why.join(', ') : 'No issues recorded', action };
  }).sort((x, y) => y.score - x.score);
}

function renderRisk() {
  const html = riskScores().map((r) => `
    <div class="risk-row risk-${r.level}">
      <span class="risk-floor">Floor ${r.floor}</span>
      <div class="risk-track"><span style="width:${Math.max(3, r.score)}%"></span></div>
      <span class="risk-score"><b>${r.score}</b> ${r.level}</span>
      <span class="risk-why">${escapeHtml(r.why)} &middot; <strong>${r.action}</strong></span>
    </div>`).join('');
  setHtml($('#riskList'), 'risk', html);
}

function impactOf(litres) {
  const s = state.settings;
  const kl = litres / 1000;
  const kwh = kl * IMPACT.kwhPerKL;
  return { rupees: kl * s.waterCostPerKL + kwh * s.electricityPerKWh, kwh, co2: kwh * IMPACT.co2PerKWh };
}

function currentExcessFlow() {
  const floors = sum(state.floors.map((f) => (f.flowAbn && !f.valveClosed ? Math.max(0, f.flow - baselineOf(f).flow) : 0)));
  const riser = state.meter.available && state.riser.status !== 'NORMAL' ? Math.max(0, state.meter.unaccounted) : 0;
  return floors + riser;
}

function renderCost() {
  const seeded = impactOf(SEED.summary.loss7d);
  const monthlySeeded = impactOf((SEED.summary.loss7d * 30) / 7);
  const live = impactOf(totalLiveLoss());
  const excess = currentExcessFlow();
  const projLitres = excess * MINUTES_PER_MONTH;
  const proj = impactOf(projLitres);
  const saved = impactOf(state.waterSaved);
  setHtml($('#costBody'), 'cost', `
    <div class="cost-grid">
      <div class="cost-card">
        <span class="stat-label">Past 7 days (seeded)</span>
        <span class="stat-value">${fmtRupees(seeded.rupees)}</span>
        <small>${fmtLitres(SEED.summary.loss7d)} lost &middot; ${seeded.kwh.toFixed(1)} kWh &middot; ${seeded.co2.toFixed(1)} kg CO&#8322;</small>
        <small>At this rate: ${fmtRupees(monthlySeeded.rupees)} per month</small>
      </div>
      <div class="cost-card ${excess > 0 ? 'warn' : ''}">
        <span class="stat-label">If the current leak is not fixed</span>
        <span class="stat-value">${excess > 0 ? `${fmtRupees(proj.rupees)}/month` : 'No active leak'}</span>
        <small>${excess > 0 ? `${excess.toFixed(1)} L/min excess = ${Math.round(projLitres / 1000).toLocaleString()} kL per month &middot; ${Math.round(proj.co2).toLocaleString()} kg CO&#8322;` : 'Projection appears when a leak is running'}</small>
      </div>
      <div class="cost-card">
        <span class="stat-label">Live session loss</span>
        <span class="stat-value">${fmtRupees(live.rupees)}</span>
        <small>${fmtLitres(totalLiveLoss())} lost (simulated)</small>
      </div>
      <div class="cost-card good">
        <span class="stat-label">Saved by auto shut-off</span>
        <span class="stat-value">${fmtRupees(saved.rupees)}</span>
        <small>${fmtLitres(state.waterSaved)} saved vs average manual response this session</small>
      </div>
    </div>`);
}

/* ---------------- Rendering (seeded historical) ---------------- */
function renderSeedSummary() {
  const s = SEED.summary;
  const lossShare = s.consumption7d ? ((s.loss7d / s.consumption7d) * 100).toFixed(1) : '0';
  const vsExpected = ((s.consumption7d / s.expected7d - 1) * 100).toFixed(1);
  $('#histStats').innerHTML = [
    ['Consumption – Last 24 h', fmtLitres(s.consumption24h), 'All 5 floors'],
    ['Consumption – 7 Days', fmtLitres(s.consumption7d), `${vsExpected > 0 ? '+' : ''}${vsExpected}% vs expected`],
    ['Leak Incidents – 7 Days', s.leakIncidents, `${s.warnings} other warnings`],
    ['Est. Water Lost – 7 Days', fmtLitres(s.loss7d), `${lossShare}% of consumption`],
    ['Avg Response Time', `${s.avgResponseMin} min`, 'Alert to acknowledgement'],
    ['Avg Resolution Time', fmtDuration(s.avgResolutionMin), 'Detection to repair'],
  ].map(([label, value, sub]) => `
    <div class="stat-card">
      <span class="stat-label">${label}</span>
      <span class="stat-value">${value}</span>
      <span class="stat-sub">${sub}</span>
    </div>`).join('');
  $('#srcSeedCount').textContent = `${s.totalRecords.toLocaleString()} records`;
}

function renderBaselineTable() {
  $('#baselineBody').innerHTML = SEED.BASELINES.map((b, i) => `
    <tr>
      <td>Floor ${b.floor}</td>
      <td>${b.flow.toFixed(1)}</td>
      <td>${b.pressure.toFixed(1)}</td>
      <td>${SEED.expectedDaily[i].toLocaleString()}</td>
      <td>${Math.round(SEED.summary.perFloor7d[i] / SEED.days.length).toLocaleString()}</td>
      <td><span class="pill pill-normal">Normal</span></td>
    </tr>`).join('');
}

function renderIncidents() {
  const kindLabel = { leak: 'Leak', flow: 'High flow', pressure: 'Pressure drop' };
  $('#incidentBody').innerHTML = [...SEED.incidents].reverse().map((inc) => `
    <tr class="${inc.alertType === 'LEAK SUSPECTED' ? 'row-leak' : 'row-warning'}">
      <td><strong>${inc.id}</strong><span class="small-muted">${kindLabel[inc.kind]}</span></td>
      <td>${fmtShort(inc.detectedAt)}</td>
      <td>Floor ${inc.floor}</td>
      <td><span class="pill ${inc.alertType === 'LEAK SUSPECTED' ? 'pill-leak' : 'pill-warning'}">${inc.alertType}</span></td>
      <td>${inc.peakFlow.toFixed(1)} L/min</td>
      <td>${inc.minPressure.toFixed(2)} bar</td>
      <td>${fmtDuration(inc.durationMin)}</td>
      <td>${inc.lossLitres ? fmtLitres(inc.lossLitres) : '0 L'}</td>
      <td class="wrap-cell">${escapeHtml(inc.cause)}</td>
    </tr>`).join('');

  $('#incidentSelect').innerHTML = [...SEED.incidents].reverse()
    .map((inc) => `<option value="${inc.id}">${inc.id} · Floor ${inc.floor} · ${fmtDay(inc.start)}</option>`).join('');
  const featured = SEED.incidents.find((inc) => inc.floor === 3 && inc.kind === 'leak') || SEED.incidents[0];
  $('#incidentSelect').value = featured.id;
  renderIncidentDetail(featured.id);
}

function renderIncidentDetail(id) {
  const inc = SEED.incidents.find((x) => x.id === id);
  if (!inc) return;
  $('#incidentSummary').innerHTML = `
    <div><span>Floor</span>Floor ${inc.floor}</div>
    <div><span>First abnormal reading</span>${fmtShort(inc.detectedAt)}</div>
    <div><span>Leak confirmed</span>${inc.confirmedAt ? fmtShort(inc.confirmedAt) : 'Not a leak (warning only)'}</div>
    <div><span>Acknowledged</span>${fmtShort(inc.ackAt)} (${inc.ackAfterMin} min after alert)</div>
    <div><span>Resolved</span>${fmtShort(inc.resolvedAt)}</div>
    <div><span>Est. loss</span>${fmtLitres(inc.lossLitres)}</div>
    <div><span>Cause found</span>${escapeHtml(inc.cause)}</div>
    <div><span>Action</span>${escapeHtml(inc.action)}</div>`;
  const rows = SEED.detail.filter((r) => r.incident === id);
  $('#incidentDetailBody').innerHTML = rows.map((r) => `
    <tr class="${r.status === 'Leak Suspected' ? 'row-leak' : r.status === 'Warning' ? 'row-warning' : ''}">
      <td>${fmtClock(r.t)}</td>
      <td>${r.floor}</td>
      <td>${r.flow.toFixed(1)}</td>
      <td>${r.pressure.toFixed(2)}</td>
      <td class="muted">${r.expectedFlow.toFixed(1)} L/min · ${r.expectedPressure.toFixed(2)} bar</td>
      <td><span class="pill ${PILL_CLASS[r.status]}">${r.status}</span></td>
      <td class="muted">${r.phase}</td>
    </tr>`).join('');
}

function renderExplorer() {
  const floor = $('#fltFloor').value;
  const status = $('#fltStatus').value;
  const res = $('#fltRes').value;
  const all = [...SEED.hourly, ...SEED.detail]
    .filter((r) => (floor === 'all' || r.floor === Number(floor))
      && (status === 'all' || r.status === status)
      && (res === 'all' || r.resolution === res))
    .sort((a, b) => b.t - a.t);
  $('#explorerCount').textContent = `Showing ${Math.min(EXPLORER_ROWS, all.length)} of ${all.length.toLocaleString()} matching seeded records (newest first). Download the CSV for the full dataset.`;
  $('#explorerBody').innerHTML = all.length
    ? all.slice(0, EXPLORER_ROWS).map((r) => `
      <tr class="${r.status === 'Leak Suspected' ? 'row-leak' : r.status === 'Warning' ? 'row-warning' : ''}">
        <td>${fmtShort(r.t)}</td>
        <td>Floor ${r.floor}</td>
        <td>${r.flow.toFixed(2)}</td>
        <td>${r.pressure.toFixed(2)}</td>
        <td><span class="pill ${PILL_CLASS[r.status]}">${r.status}</span></td>
        <td>${r.resolution}</td>
        <td>${r.incident || '--'}</td>
      </tr>`).join('')
    : '<tr class="empty"><td colspan="7">No records match these filters.</td></tr>';
}

function downloadCsv() {
  const blob = new Blob([SEED.toCSV()], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'leaklevel_seeded_sensor_records.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Seeded dataset downloaded as CSV', 'ok');
}

/* ---------------- Charts ---------------- */
const charts = {};
const useChartJs = typeof window.Chart !== 'undefined';

const LIVE_CANVAS = {
  flowBar: 'chartFlowBar',
  pressureBar: 'chartPressureBar',
  flowTrend: 'chartFlowTrend',
  pressureTrend: 'chartPressureTrend',
};
const HIST_CANVAS = {
  histDay: 'chartHistDay',
  histWeek: 'chartHistWeek',
  histFloors: 'chartHistFloors',
};

function liveChartData() {
  const labels = state.floors.map((f) => `Floor ${f.id}`);
  const statusColors = state.floors.map((f) => STATUS_COLORS[f.status]);
  return {
    flowBar: {
      type: 'bar', labels,
      datasets: [
        { label: 'Current flow', data: state.floors.map((f) => (f.offline ? null : f.flow)), color: statusColors },
        { label: 'Baseline', data: state.settings.baselines.map((b) => b.flow), color: 'rgba(148,163,184,0.35)' },
      ],
    },
    pressureBar: {
      type: 'bar', labels,
      datasets: [
        { label: 'Current pressure', data: state.floors.map((f) => (f.offline ? null : f.pressure)), color: statusColors },
        { label: 'Baseline', data: state.settings.baselines.map((b) => b.pressure), color: 'rgba(148,163,184,0.35)' },
      ],
    },
    flowTrend: {
      type: 'line', labels: [...state.trend.labels],
      datasets: state.floors.map((f, i) => ({ label: `Floor ${f.id}`, data: [...state.trend.flow[i]], color: FLOOR_COLORS[i] })),
    },
    pressureTrend: {
      type: 'line', labels: [...state.trend.labels],
      datasets: state.floors.map((f, i) => ({ label: `Floor ${f.id}`, data: [...state.trend.pressure[i]], color: FLOOR_COLORS[i] })),
    },
  };
}

// Day index: 0..6 = past full days, 7 = today so far.
function dayStart(index) {
  return SEED.start + index * DAY_MS;
}

function histDayData(index) {
  const from = dayStart(index);
  const to = from + DAY_MS;
  const recs = SEED.hourly.filter((r) => r.t >= from && r.t < to);
  const hours = [];
  for (let t = from; t < Math.min(to, SEED.anchor); t += 3600 * 1000) hours.push(t);
  const total = (t, key) => recs.filter((r) => r.t === t).reduce((s, r) => s + (key === 'actual' ? r.litres : r.expectedFlow * 60), 0);
  return {
    type: 'line',
    labels: hours.map((t) => fmtClock(t)),
    datasets: [
      { label: 'Actual (L/hour)', data: hours.map((t) => Math.round(total(t, 'actual'))), color: '#22d3ee', fill: true },
      { label: 'Expected (L/hour)', data: hours.map((t) => Math.round(total(t, 'expected'))), color: 'rgba(148,163,184,0.8)', dashed: true },
    ],
  };
}

function histChartData() {
  return {
    histDay: histDayData(Number($('#histDay').value)),
    histWeek: {
      type: 'bar',
      stacked: true,
      labels: SEED.days.map((d) => fmtDay(d.start)),
      datasets: [
        ...SEED.BASELINES.map((b, i) => ({ label: `Floor ${b.floor}`, data: SEED.days.map((d) => d.perFloor[i]), color: FLOOR_COLORS[i] })),
        { label: 'Expected total', data: SEED.days.map((d) => d.expected), color: 'rgba(226,232,240,0.85)', line: true, dashed: true },
      ],
    },
    histFloors: {
      type: 'bar',
      horizontal: true,
      labels: SEED.BASELINES.map((b) => `Floor ${b.floor}`),
      datasets: [
        { label: '7-day consumption (L)', data: SEED.summary.perFloor7d, color: FLOOR_COLORS },
        { label: 'Est. leak loss (L)', data: SEED.summary.lossPerFloor, color: '#ef4444' },
      ],
    },
  };
}

function toChartJsDatasets(cfg) {
  return cfg.datasets.map((d) => {
    if (cfg.type === 'bar' && !d.line) {
      return { label: d.label, data: d.data, backgroundColor: d.color, borderRadius: 6, maxBarThickness: 36 };
    }
    return {
      type: 'line',
      label: d.label,
      data: d.data,
      borderColor: d.color,
      backgroundColor: d.fill ? 'rgba(34,211,238,0.12)' : d.color,
      fill: Boolean(d.fill),
      borderDash: d.dashed ? [6, 4] : [],
      tension: 0.35,
      pointRadius: d.line ? 3 : 0,
      borderWidth: 2,
      stack: d.line ? 'overlay' : undefined,
    };
  });
}

function chartJsOptions(cfg) {
  const scales = cfg.horizontal
    ? { x: { beginAtZero: true } }
    : { y: { beginAtZero: cfg.type === 'bar' || cfg.stacked } };
  if (cfg.stacked) {
    scales.x = { stacked: true };
    scales.y = { stacked: true, beginAtZero: true };
  }
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    indexAxis: cfg.horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: 12, usePointStyle: true } } },
    scales,
  };
}

function createChart(key, canvasId, cfg) {
  charts[key] = new Chart(document.getElementById(canvasId), {
    type: cfg.type,
    data: { labels: cfg.labels, datasets: toChartJsDatasets(cfg) },
    options: chartJsOptions(cfg),
  });
}

function initCharts() {
  if (!useChartJs) {
    $('#chartFallbackNote').classList.remove('hidden');
    drawStaticCharts();
    return;
  }
  Chart.defaults.color = '#8ba0bb';
  Chart.defaults.borderColor = 'rgba(148,163,184,0.12)';
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const live = liveChartData();
  Object.keys(LIVE_CANVAS).forEach((key) => createChart(key, LIVE_CANVAS[key], live[key]));
  const hist = histChartData();
  Object.keys(HIST_CANVAS).forEach((key) => createChart(key, HIST_CANVAS[key], hist[key]));
  createChart('adaptive', 'chartAdaptive', adaptiveChartData(Number($('#adaptFloor').value)).cfg);
}

function updateCharts() {
  const data = liveChartData();
  Object.keys(LIVE_CANVAS).forEach((key) => {
    const cfg = data[key];
    if (useChartJs) {
      const chart = charts[key];
      if (!chart) return;
      chart.data.labels = cfg.labels;
      const fresh = toChartJsDatasets(cfg);
      chart.data.datasets.forEach((ds, i) => {
        ds.data = fresh[i].data;
        ds.backgroundColor = fresh[i].backgroundColor;
      });
      chart.update('none');
    } else {
      drawFallbackChart(document.getElementById(LIVE_CANVAS[key]), cfg);
    }
  });
}

function updateHistDayChart() {
  const index = Number($('#histDay').value);
  const cfg = histDayData(index);
  if (useChartJs && charts.histDay) {
    charts.histDay.data.labels = cfg.labels;
    const fresh = toChartJsDatasets(cfg);
    charts.histDay.data.datasets.forEach((ds, i) => { ds.data = fresh[i].data; });
    charts.histDay.update();
  } else if (!useChartJs) {
    drawFallbackChart(document.getElementById(HIST_CANVAS.histDay), cfg);
  }
  const from = dayStart(index);
  const incs = SEED.incidents.filter((inc) => inc.start >= from && inc.start < from + DAY_MS);
  $('#histDayNote').textContent = incs.length
    ? `Incidents on this day: ${incs.map((inc) => `${inc.id} (Floor ${inc.floor}, ${fmtClock(inc.start)}, ${inc.alertType.toLowerCase()})`).join('; ')}. Look for usage above the expected line, especially at night.`
    : 'No incidents on this day. Actual usage follows the expected demand pattern.';
}

function updateAdaptiveChart() {
  const { cfg, note } = adaptiveChartData(Number($('#adaptFloor').value));
  if (useChartJs && charts.adaptive) {
    const fresh = toChartJsDatasets(cfg);
    charts.adaptive.data.datasets.forEach((ds, i) => {
      ds.data = fresh[i].data;
      ds.label = fresh[i].label;
    });
    charts.adaptive.update();
  } else if (!useChartJs) {
    drawFallbackChart(document.getElementById('chartAdaptive'), cfg);
  }
  $('#adaptNote').textContent = note;
}

function drawStaticCharts() {
  const hist = histChartData();
  Object.keys(HIST_CANVAS).forEach((key) => drawFallbackChart(document.getElementById(HIST_CANVAS[key]), hist[key]));
  drawFallbackChart(document.getElementById('chartAdaptive'), adaptiveChartData(Number($('#adaptFloor').value)).cfg);
}

// Very small chart renderer used only when Chart.js cannot be loaded (offline).
function drawFallbackChart(canvas, cfg) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth;
  const h = canvas.parentElement.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 52, r: 10, t: 28, b: 26 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const bars = cfg.datasets.filter((d) => cfg.type === 'bar' && !d.line);
  const lines = cfg.datasets.filter((d) => !(cfg.type === 'bar' && !d.line));
  const values = cfg.datasets.flatMap((d) => d.data).filter(Number.isFinite);
  const max = Math.max(1, ...values) * 1.15;
  const n = cfg.labels.length;
  ctx.font = '11px sans-serif';

  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ph - (ph * i) / 4;
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = '#8ba0bb';
    ctx.textAlign = 'left';
    const v = (max * i) / 4;
    ctx.fillText(v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1), 4, y + 4);
  }

  const groupW = pw / Math.max(1, n);
  if (bars.length) {
    const bw = (groupW * 0.7) / bars.length;
    cfg.labels.forEach((label, i) => {
      bars.forEach((ds, j) => {
        const v = ds.data[i];
        if (!Number.isFinite(v)) return;
        const bh = (ph * v) / max;
        const x = pad.l + i * groupW + groupW * 0.15 + j * bw;
        ctx.fillStyle = Array.isArray(ds.color) ? ds.color[i] : ds.color;
        ctx.fillRect(x, pad.t + ph - bh, Math.max(1, bw - 2), bh);
      });
    });
  }

  lines.forEach((ds) => {
    ctx.strokeStyle = Array.isArray(ds.color) ? ds.color[0] : ds.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(ds.dashed ? [6, 4] : []);
    ctx.beginPath();
    let started = false;
    ds.data.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        started = false;
        return;
      }
      const x = bars.length ? pad.l + i * groupW + groupW / 2 : pad.l + (n <= 1 ? 0 : (pw * i) / (n - 1));
      const y = pad.t + ph - (ph * v) / max;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);
  });

  const step = Math.ceil(n / 8);
  ctx.fillStyle = '#8ba0bb';
  ctx.textAlign = 'center';
  cfg.labels.forEach((label, i) => {
    if (i % step !== 0) return;
    const x = bars.length ? pad.l + i * groupW + groupW / 2 : pad.l + (n <= 1 ? 0 : (pw * i) / (n - 1));
    ctx.fillText(label, x, h - 8);
  });

  let lx = pad.l;
  ctx.textAlign = 'left';
  cfg.datasets.forEach((ds) => {
    ctx.fillStyle = Array.isArray(ds.color) ? ds.color[0] : ds.color;
    ctx.fillRect(lx, 8, 10, 10);
    ctx.fillStyle = '#8ba0bb';
    ctx.fillText(ds.label, lx + 14, 17);
    lx += ctx.measureText(ds.label).width + 28;
  });
}

/* ---------------- Toasts ---------------- */
function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('hide'), 3200);
  setTimeout(() => el.remove(), 3600);
}

/* ---------------- Forms ---------------- */
function fillFloorSelects() {
  const opts = state.floors.map((f) => `<option value="${f.id}">Floor ${f.id}</option>`).join('');
  $('#leakFloor').innerHTML = opts;
  $('#manualFloor').innerHTML = opts;
  $('#leakFloor').value = '3';
}

function fillHistDaySelect() {
  const opts = SEED.days.map((d, i) => `<option value="${i}">${fmtDay(d.start)}</option>`);
  opts.push(`<option value="${SEED.days.length}">Today (so far)</option>`);
  $('#histDay').innerHTML = opts.join('');
  $('#histDay').value = String(SEED.days.length - 1);   // yesterday
}

function fillSettingsForm() {
  const s = state.settings;
  $('#setFlowRise').value = s.flowRisePct;
  $('#setPressureDrop').value = s.pressureDropPct;
  $('#setConfirm').value = s.confirmReadings;
  $('#setInterval').value = s.intervalSec;
  $('#setAutoIsolate').checked = s.autoIsolate;
  $('#costWater').value = s.waterCostPerKL;
  $('#costPower').value = s.electricityPerKWh;
  $('#baselineTable').innerHTML = `
    <span class="bt-head">Floor</span><span class="bt-head">Flow (L/min)</span><span class="bt-head">Pressure (bar)</span>
    ${s.baselines.map((b, i) => `
      <span>Floor ${i + 1}</span>
      <input type="number" step="0.1" min="1" max="100" data-baseline-flow="${i}" value="${b.flow}">
      <input type="number" step="0.05" min="0.5" max="10" data-baseline-pressure="${i}" value="${b.pressure}">`).join('')}`;
}

function readNumber(input, min, max, label) {
  const v = parseFloat(input.value);
  if (!Number.isFinite(v) || v < min || v > max) {
    input.focus();
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return v;
}

function persistSettings() {
  saveJSON(STORAGE.settings, state.settings);
}

function saveSettings() {
  try {
    const next = {
      ...state.settings,
      flowRisePct: readNumber($('#setFlowRise'), 5, 100, 'Flow rise'),
      pressureDropPct: readNumber($('#setPressureDrop'), 5, 60, 'Pressure drop'),
      confirmReadings: Math.round(readNumber($('#setConfirm'), 1, 10, 'Confirmation readings')),
      intervalSec: readNumber($('#setInterval'), 1, 10, 'Update interval'),
      autoIsolate: $('#setAutoIsolate').checked,
      baselines: state.settings.baselines.map((b, i) => ({
        flow: readNumber($(`[data-baseline-flow="${i}"]`), 1, 100, `Floor ${i + 1} baseline flow`),
        pressure: readNumber($(`[data-baseline-pressure="${i}"]`), 0.5, 10, `Floor ${i + 1} baseline pressure`),
      })),
    };
    state.settings = next;
    persistSettings();
    fillSettingsForm();
    if (state.running) startTimer();
    render();
    toast('Settings saved', 'ok');
  } catch (e) {
    toast(e.message, 'warn');
  }
}

function restoreDefaultSettings() {
  state.settings = clone(DEFAULT_SETTINGS);
  persistSettings();
  fillSettingsForm();
  if (state.running) startTimer();
  render();
  toast('Default settings restored', 'ok');
}

/* ---------------- Event wiring ---------------- */
function handleAlertAction(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  if (action === 'ack') acknowledgeAlert(id);
  if (action === 'inspect') markInspected(id);
  if (action === 'isolate') {
    const a = findAlert(id);
    if (a && a.floor) {
      isolateFloor(state.floors[a.floor - 1], 'manual');
      render();
    }
  }
}

function bindEvents() {
  // Navigation
  const nav = $('#nav');
  $('#navToggle').addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    $('#navToggle').setAttribute('aria-expanded', String(open));
  });
  $$('.nav-link').forEach((link) => link.addEventListener('click', () => nav.classList.remove('open')));

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          $$('.nav-link').forEach((l) => l.classList.toggle('active', l.getAttribute('href') === `#${entry.target.id}`));
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    $$('main .section').forEach((s) => observer.observe(s));
  }

  // Demo mode
  $$('.demo-btn').forEach((btn) => btn.addEventListener('click', () => runScenario(Number(btn.dataset.scenario))));
  $('#demoReset').addEventListener('click', () => resetBuilding());

  // Simulation controls
  $('#btnPause').addEventListener('click', () => {
    setRunning(!state.running);
    toast(state.running ? 'Simulation resumed' : 'Simulation paused', 'info');
  });
  $('#btnReset').addEventListener('click', () => resetBuilding());

  $('#btnLeak').addEventListener('click', () => {
    const id = Number($('#leakFloor').value);
    const f = state.floors[id - 1];
    if (f.valveClosed) {
      toast(`Floor ${id} valve is closed. Mark its alert as inspected first.`, 'info');
      return;
    }
    const sev = $('#leakSeverity').value;
    setLeak(id, sev);
    state.scenario = null;
    advanceNow();
    toast(`${LEAK_PROFILES[sev].label} leak simulation started on Floor ${id}`, 'info');
  });

  $('#btnStopLeak').addEventListener('click', () => {
    const id = Number($('#leakFloor').value);
    if (stopLeak(id)) {
      advanceNow();
      toast(`Floor ${id} returned to normal operation`, 'ok');
    } else {
      toast(`Floor ${id} has no active leak simulation`, 'info');
    }
  });

  $('#btnSensor').addEventListener('click', () => toggleSensor(Number($('#leakFloor').value)));

  $('#btnRiser').addEventListener('click', () => {
    state.riser.leak = !state.riser.leak;
    state.scenario = null;
    advanceNow();
    toast(state.riser.leak ? 'Riser leak simulation started (between Floor 3 and Floor 4)' : 'Riser leak simulation stopped', 'info');
  });

  $('#btnPump').addEventListener('click', () => {
    state.pump = !state.pump;
    state.scenario = null;
    advanceNow();
    toast(state.pump ? 'Pump fault simulation started' : 'Pump fault simulation stopped', 'info');
  });

  // Manual sensor test
  $('#manualFloor').addEventListener('change', () => {
    const f = state.floors[Number($('#manualFloor').value) - 1];
    $('#manualFlow').value = f.flow.toFixed(1);
    $('#manualPressure').value = f.pressure.toFixed(2);
  });

  $('#btnApplyManual').addEventListener('click', () => {
    try {
      const id = Number($('#manualFloor').value);
      const flow = readNumber($('#manualFlow'), 0, 100, 'Flow');
      const pressure = readNumber($('#manualPressure'), 0, 10, 'Pressure');
      const f = state.floors[id - 1];
      f.mode = 'manual';
      f.manual = { flow: round(flow), pressure: round(pressure) };
      state.scenario = null;
      advanceNow();
      toast(`Manual values applied to Floor ${id}`, 'info');
    } catch (e) {
      toast(e.message, 'warn');
    }
  });

  $('#btnReleaseManual').addEventListener('click', () => {
    const id = Number($('#manualFloor').value);
    const f = state.floors[id - 1];
    if (f.mode !== 'manual') {
      toast(`Floor ${id} has no manual override`, 'info');
      return;
    }
    f.mode = 'normal';
    f.manual = null;
    advanceNow();
    toast(`Floor ${id} returned to simulated readings`, 'ok');
  });

  // Settings
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnDefaultSettings').addEventListener('click', restoreDefaultSettings);
  $('#setAutoIsolate').addEventListener('change', (e) => {
    state.settings.autoIsolate = e.target.checked;
    persistSettings();
    render();
    toast(`Auto shut-off valve ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
  });
  [['#costWater', 'waterCostPerKL', 1, 1000], ['#costPower', 'electricityPerKWh', 1, 100]].forEach(([sel, key, min, max]) => {
    $(sel).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v) || v < min || v > max) {
        e.target.value = state.settings[key];
        toast(`Enter a value between ${min} and ${max}`, 'warn');
        return;
      }
      state.settings[key] = v;
      persistSettings();
      renderCost();
    });
  });

  // Alert actions (maintenance panel and phone quick replies)
  $('#maintenanceList').addEventListener('click', handleAlertAction);
  $('#phoneMessages').addEventListener('click', handleAlertAction);

  // Historical analytics & records
  $('#histDay').addEventListener('change', updateHistDayChart);
  $('#adaptFloor').addEventListener('change', updateAdaptiveChart);
  $('#incidentSelect').addEventListener('change', (e) => renderIncidentDetail(e.target.value));
  ['#fltFloor', '#fltStatus', '#fltRes'].forEach((sel) => $(sel).addEventListener('change', renderExplorer));
  $('#btnCsv').addEventListener('click', downloadCsv);

  // Alert history
  $('#btnClearHistory').addEventListener('click', () => {
    if (!state.history.length) {
      toast('Alert history is already empty', 'info');
      return;
    }
    if (!window.confirm('Clear all live alert history? Open alerts that still need maintenance will be kept. Seeded records are not affected.')) return;
    state.history = state.history.filter((a) => state.activeAlerts.includes(a.id));
    saveHistory();
    render();
    toast('Alert history cleared', 'ok');
  });

  // Redraw fallback charts on resize
  if (!useChartJs) {
    let t;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        updateCharts();
        drawStaticCharts();
      }, 150);
    });
  }
}

/* ---------------- Start ---------------- */
function init() {
  createFloors();
  state.trend = { labels: [], flow: state.floors.map(() => []), pressure: state.floors.map(() => []) };
  pushTrend();
  buildFloorCards();
  fillFloorSelects();
  fillHistDaySelect();
  fillSettingsForm();
  renderSeedSummary();
  renderBaselineTable();
  renderIncidents();
  renderExplorer();
  renderAdaptiveCompare();
  renderNight();
  initCharts();
  updateHistDayChart();
  updateAdaptiveChart();
  bindEvents();
  $('#manualFloor').dispatchEvent(new Event('change'));
  evaluateBalance();
  render();
  startTimer();
}

document.addEventListener('DOMContentLoaded', init);
