/* ==========================================================
   LEAKLEVEL – Seed data layer
   SEEDED SAMPLE DATA: illustrative values for a 5-floor building.
   These are NOT measurements from a real building. Real baselines
   must be calibrated using installed sensors.

   The dataset is generated with a fixed random seed, so the
   values are identical every time the app is opened. Timestamps
   are placed relative to "now" so the history always looks recent.

   To use real meter data later, replace the generated `hourly`,
   `detail` and `incidents` arrays with records loaded from hardware.
   ========================================================== */
'use strict';

const LEAKLEVEL_DATA = (() => {
  const SEED = 20261104;
  const DAYS = 7;
  const MIN_MS = 60 * 1000;
  const HOUR_MS = 60 * MIN_MS;
  const DAY_MS = 24 * HOUR_MS;

  /* ---------------- A. Baseline data ---------------- */
  const BUILDING = { name: 'Residential Block A', floors: 5 };

  // Normal (peak-hour) flow and pressure per floor. Illustrative values.
  const BASELINES = [
    { floor: 1, flow: 18.5, pressure: 2.8 },
    { floor: 2, flow: 22.0, pressure: 2.6 },
    { floor: 3, flow: 16.5, pressure: 2.9 },
    { floor: 4, flow: 20.0, pressure: 2.7 },
    { floor: 5, flow: 14.0, pressure: 3.0 },
  ];

  // Typical residential demand pattern: share of the peak-hour baseline flow
  // used in each hour of the day (morning and evening peaks, low at night).
  const DEMAND_PROFILE = [
    0.09, 0.07, 0.06, 0.06, 0.09, 0.29, 0.71, 1.00, 0.94, 0.65, 0.41, 0.35,
    0.38, 0.33, 0.24, 0.21, 0.26, 0.41, 0.65, 0.73, 0.59, 0.41, 0.24, 0.14,
  ];
  const PROFILE_SUM = DEMAND_PROFILE.reduce((a, b) => a + b, 0);

  // Rules used to classify the seeded records (same as the default demo rules).
  const RULES = { flowRisePct: 30, pressureDropPct: 20, confirmReadings: 3 };

  /* ---------------- Seeded past incidents ---------------- */
  const INCIDENT_DEFS = [
    {
      id: 'INC-001', daysAgo: 6, hour: 2, minute: 10, floor: 2, kind: 'leak',
      excessFlow: 9.0, pressureDrop: 0.65, durationMin: 150, ackAfterMin: 12,
      cause: 'Leaking compression joint on bathroom supply line',
      action: 'Joint replaced, floor isolation valve reopened',
      team: 'Plumbing Team A', outcome: 'Leak confirmed and repaired',
    },
    {
      id: 'INC-002', daysAgo: 5, hour: 14, minute: 5, floor: 5, kind: 'pressure',
      excessFlow: 0, pressureDrop: 0.7, durationMin: 50, ackAfterMin: 8,
      cause: 'Pressure dip during booster pump servicing',
      action: 'Pump inspected, pressure restored',
      team: 'Pump Maintenance', outcome: 'No leak found (false alarm)',
    },
    {
      id: 'INC-003', daysAgo: 4, hour: 22, minute: 20, floor: 4, kind: 'flow',
      excessFlow: 7.0, pressureDrop: 0, durationMin: 100, ackAfterMin: 15,
      cause: 'Continuously running toilet cistern',
      action: 'Cistern flush valve replaced',
      team: 'Plumbing Team B', outcome: 'Fixture fault fixed',
    },
    {
      id: 'INC-004', daysAgo: 2, hour: 7, minute: 10, floor: 3, kind: 'leak',
      excessFlow: 14.0, pressureDrop: 0.75, durationMin: 95, ackAfterMin: 6,
      cause: 'Cracked CPVC fitting in concealed branch line',
      action: 'Floor 3 valve isolated, fitting replaced',
      team: 'Plumbing Team A', outcome: 'Leak confirmed and repaired',
    },
    {
      id: 'INC-005', daysAgo: 1, hour: 3, minute: 0, floor: 1, kind: 'leak',
      excessFlow: 6.0, pressureDrop: 0.65, durationMin: 130, ackAfterMin: 20,
      cause: 'Seepage at gate valve gland',
      action: 'Valve gland repacked',
      team: 'Plumbing Team B', outcome: 'Leak confirmed and repaired',
    },
  ];

  /* ---------------- Helpers ---------------- */
  function mulberry32(a) {
    return function next() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(SEED);
  const noise = (pct) => 1 + (rand() * 2 - 1) * pct;
  const r2 = (v) => Math.round(v * 100) / 100;

  const expectedFlow = (b, hour) => b.flow * DEMAND_PROFILE[hour];
  // Pressure rises slightly when demand is low (night) and falls at peak demand.
  const expectedPressure = (b, hour) => b.pressure * (1 + 0.06 * (1 - DEMAND_PROFILE[hour]));

  function indicators(b, hour, flow, pressure) {
    return {
      flowAbn: flow > expectedFlow(b, hour) * (1 + RULES.flowRisePct / 100),
      pressAbn: pressure < expectedPressure(b, hour) * (1 - RULES.pressureDropPct / 100),
    };
  }

  /* ---------------- Timeline ---------------- */
  const generatedAt = Date.now();
  const anchorDate = new Date(generatedAt);
  anchorDate.setMinutes(0, 0, 0);
  const anchor = anchorDate.getTime();               // start of the current hour
  const todayDate = new Date(anchor);
  todayDate.setHours(0, 0, 0, 0);
  const today = todayDate.getTime();
  const start = today - DAYS * DAY_MS;               // midnight, 7 days ago

  const incidents = INCIDENT_DEFS.map((d) => {
    const s = today - d.daysAgo * DAY_MS + d.hour * HOUR_MS + d.minute * MIN_MS;
    return { ...d, start: s, end: s + d.durationMin * MIN_MS };
  });

  /* ---------------- B. Historical data: hourly records ---------------- */
  const hourly = [];
  for (let t = start; t < anchor; t += HOUR_MS) {
    const hour = new Date(t).getHours();
    BASELINES.forEach((b) => {
      let flow = expectedFlow(b, hour) * noise(0.04);
      let pressure = expectedPressure(b, hour) * noise(0.015);
      let incident = null;
      incidents.forEach((inc) => {
        if (inc.floor !== b.floor) return;
        const overlap = Math.min(t + HOUR_MS, inc.end) - Math.max(t, inc.start);
        if (overlap <= 0) return;
        const frac = overlap / HOUR_MS;
        flow += inc.excessFlow * frac;
        pressure -= inc.pressureDrop * frac;
        incident = inc.id;
      });
      flow = r2(flow);
      pressure = r2(pressure);
      const ind = indicators(b, hour, flow, pressure);
      hourly.push({
        t,
        floor: b.floor,
        flow,
        pressure,
        expectedFlow: r2(expectedFlow(b, hour)),
        expectedPressure: r2(expectedPressure(b, hour)),
        litres: flow * 60,
        status: ind.flowAbn && ind.pressAbn ? 'Leak Suspected' : ind.flowAbn || ind.pressAbn ? 'Warning' : 'Normal',
        resolution: 'Hourly',
        incident,
      });
    });
  }

  /* ---------------- B. Historical data: 5-minute incident logs ---------------- */
  const detail = [];
  incidents.forEach((inc) => {
    const b = BASELINES[inc.floor - 1];
    let count = 0;
    inc.detectedAt = null;
    inc.confirmedAt = null;
    inc.peakFlow = 0;
    inc.minPressure = Infinity;

    for (let t = inc.start - 10 * MIN_MS; t <= inc.end + 5 * MIN_MS; t += 5 * MIN_MS) {
      const hour = new Date(t).getHours();
      const elapsed = (t - inc.start) / MIN_MS;
      const active = elapsed >= 0 && t < inc.end;
      const frac = !active ? 0 : elapsed < 5 ? 0.5 : elapsed < 10 ? 0.85 : 1;
      const flow = r2(expectedFlow(b, hour) * noise(0.02) + inc.excessFlow * frac);
      const pressure = r2(expectedPressure(b, hour) * noise(0.01) - inc.pressureDrop * frac);
      const ind = indicators(b, hour, flow, pressure);

      let status;
      if (ind.flowAbn && ind.pressAbn) {
        count += 1;
        status = count >= RULES.confirmReadings ? 'Leak Suspected' : 'Warning';
      } else {
        count = 0;
        status = ind.flowAbn || ind.pressAbn ? 'Warning' : 'Normal';
      }
      if (status !== 'Normal' && !inc.detectedAt) inc.detectedAt = t;
      if (status === 'Leak Suspected' && !inc.confirmedAt) inc.confirmedAt = t;
      if (active) {
        inc.peakFlow = Math.max(inc.peakFlow, flow);
        inc.minPressure = Math.min(inc.minPressure, pressure);
      }

      detail.push({
        t,
        floor: inc.floor,
        flow,
        pressure,
        expectedFlow: r2(expectedFlow(b, hour)),
        expectedPressure: r2(expectedPressure(b, hour)),
        status,
        resolution: '5-minute',
        incident: inc.id,
        phase: elapsed < 0 ? 'Before onset' : active ? 'Abnormal period' : 'After repair',
      });
    }

    inc.detectedAt = inc.detectedAt || inc.start;
    inc.ackAt = (inc.confirmedAt || inc.detectedAt) + inc.ackAfterMin * MIN_MS;
    inc.resolvedAt = inc.end;
    inc.lossLitres = Math.round(inc.excessFlow * inc.durationMin);
    inc.alertType = inc.confirmedAt ? 'LEAK SUSPECTED' : 'WARNING';
    inc.priority = inc.kind === 'leak' ? (inc.excessFlow >= 10 ? 'CRITICAL' : 'HIGH') : 'MEDIUM';
  });

  /* ---------------- B. Maintenance records ---------------- */
  const maintenance = incidents.map((inc, i) => ({
    id: `MR-${String(i + 1).padStart(3, '0')}`,
    incident: inc.id,
    floor: inc.floor,
    alertType: inc.alertType,
    priority: inc.priority,
    detectedAt: inc.detectedAt,
    ackAt: inc.ackAt,
    resolvedAt: inc.resolvedAt,
    responseMin: inc.ackAfterMin,
    resolutionMin: Math.round((inc.resolvedAt - inc.detectedAt) / MIN_MS),
    team: inc.team,
    action: inc.action,
    outcome: inc.outcome,
    status: 'Resolved',
    source: 'Seeded',
  }));

  /* ---------------- Sensor inventory (seeded metadata) ---------------- */
  const sensors = [];
  BASELINES.forEach((b) => {
    [
      ['FS', 'Flow sensor', 'Hall-effect flow meter (proposed)'],
      ['PS', 'Pressure sensor', '0–10 bar transducer (proposed)'],
    ].forEach(([code, type, model], i) => {
      const id = `F${b.floor}-${code}`;
      const dropout = id === 'F5-PS';
      sensors.push({
        id,
        floor: b.floor,
        kind: code === 'FS' ? 'flow' : 'pressure',
        type,
        model,
        calibratedAt: today - (14 + b.floor * 9 + i * 3) * DAY_MS,
        signal: -(48 + Math.round(rand() * 18)),
        uptime7d: dropout ? 97.6 : Math.round((99.2 + rand() * 0.8) * 10) / 10,
        note: dropout ? '1 dropout (about 4 h, 3 days ago)' : 'No faults recorded',
      });
    });
  });

  /* ---------------- Aggregates for analytics ---------------- */
  const expectedDaily = BASELINES.map((b) => Math.round(b.flow * 60 * PROFILE_SUM));

  const days = [];
  for (let d = 0; d < DAYS; d++) {
    const dayStart = start + d * DAY_MS;
    const recs = hourly.filter((r) => r.t >= dayStart && r.t < dayStart + DAY_MS);
    const perFloor = BASELINES.map((b) => Math.round(recs.filter((r) => r.floor === b.floor).reduce((s, r) => s + r.litres, 0)));
    days.push({
      start: dayStart,
      perFloor,
      total: perFloor.reduce((a, v) => a + v, 0),
      expected: expectedDaily.reduce((a, v) => a + v, 0),
    });
  }

  const consumption7d = days.reduce((s, d) => s + d.total, 0);
  const perFloor7d = BASELINES.map((b, i) => days.reduce((s, d) => s + d.perFloor[i], 0));
  const loss7d = incidents.reduce((s, inc) => s + inc.lossLitres, 0);
  const lossPerFloor = BASELINES.map((b) => incidents.filter((inc) => inc.floor === b.floor).reduce((s, inc) => s + inc.lossLitres, 0));
  const last24 = hourly.filter((r) => r.t >= anchor - DAY_MS);

  const summary = {
    consumption24h: Math.round(last24.reduce((s, r) => s + r.litres, 0)),
    consumption7d,
    expected7d: days.reduce((s, d) => s + d.expected, 0),
    loss7d,
    leakIncidents: incidents.filter((inc) => inc.kind === 'leak').length,
    warnings: incidents.filter((inc) => inc.kind !== 'leak').length,
    avgResponseMin: Math.round(maintenance.reduce((s, m) => s + m.responseMin, 0) / maintenance.length),
    avgResolutionMin: Math.round(maintenance.reduce((s, m) => s + m.resolutionMin, 0) / maintenance.length),
    perFloor7d,
    lossPerFloor,
    totalRecords: hourly.length + detail.length,
  };

  function toCSV() {
    const rows = [['timestamp', 'floor', 'flow_lpm', 'pressure_bar', 'expected_flow_lpm', 'expected_pressure_bar', 'status', 'resolution', 'incident', 'source']];
    [...hourly, ...detail].sort((a, b) => a.t - b.t).forEach((r) => {
      rows.push([new Date(r.t).toISOString(), r.floor, r.flow, r.pressure, r.expectedFlow, r.expectedPressure, r.status, r.resolution, r.incident || '', 'seeded-sample']);
    });
    return rows.map((r) => r.join(',')).join('\n');
  }

  return {
    BUILDING,
    BASELINES,
    DEMAND_PROFILE,
    RULES,
    expectedDaily,
    generatedAt,
    start,
    today,
    anchor,
    hourly,
    detail,
    incidents,
    maintenance,
    sensors,
    days,
    summary,
    toCSV,
  };
})();
