// Reconcile authoritative bridge state without replaying finish history after reconnect.
const previous = new WeakMap();
export function syncBridgeRace(race, event, settings, now = Date.now()) {
  const state = event.state, history = previous.get(race);
  const sameSession = history && history.sessionId === event.sessionId;
  const prior = sameSession ? history.state : undefined;
  const reset = event.reset || !prior;
  const runs = sameSession ? history.runs : new Map();
  const results = new Map(Object.values(state.results).map(r => [r.bib, { bib: r.bib, status: r.status, timeMs: r.timeMs }]));
  const active = Object.values(state.active || {}).sort((a,b) => a.startedAtMs - b.startedAtMs || a.bib.localeCompare(b.bib));
  if (reset) {
    race.results = results; race.active.clear(); race.terminalQueue = []; race.lastTerminal = null;
    if (!sameSession) race.lastStartAt = now - settings.idleRotationMs;
  } else {
    if (state.runResults !== undefined) {
      // Individual results drive skier cards only after an observed matching run.
      race.terminalQueue = race.terminalQueue.filter(entry => Object.values(state.runResults).some(r =>
        ['finish', 'dnf', 'dsq'].includes(r.status) && r.bib === entry.racer.bib && r.runId === entry.racer.runId && r.heat === entry.racer.heat));
      if (race.terminalQueue[0]?.shownAt === null) race.terminalQueue[0].shownAt = now;
      for (const r of Object.values(state.runResults)) {
        const observed = prior.active?.[r.id];
        const queued = race.terminalQueue.find(entry => entry.racer.bib === r.bib && entry.racer.runId === r.runId && entry.racer.heat === r.heat);
        const matches = observed && observed.runId === r.runId && observed.heat === r.heat && !state.active?.[r.id];
        const old = prior.runResults?.[r.id];
        if (!['finish', 'dnf', 'dsq'].includes(r.status) || (!matches && !queued) ||
            (!matches && old?.status === r.status && old?.timeMs === r.timeMs && old?.totalTimeMs === r.totalTimeMs)) continue;
        // Race.apply also writes its event time into results. Isolate that write
        // so every finish in this atomic delta compares official combined times.
        race.results = new Map([...results].filter(([bib]) => bib !== r.bib));
        race.apply({ type: r.status, bib: r.bib, timeMs: r.timeMs }, now, settings);
        const terminal = race.terminalQueue.find(entry => entry.racer.bib === r.bib);
        if (terminal) {
          Object.assign(terminal.racer, { runId: r.runId, heat: r.heat, totalEligible: r.totalEligible,
            runTimeMs: r.timeMs, timeMs: r.totalTimeMs });
          race.lastTerminal = terminal.racer;
        }
      }
    } else {
      // Compatibility with bridges that only publish combined results.
      race.terminalQueue = race.terminalQueue.filter(e => results.has(e.racer.bib));
      for (const r of Object.values(state.results)) {
        const old = prior.results[r.id];
        const endedRun = prior.active?.[r.id] && !state.active?.[r.id];
        if (!['finish', 'dnf', 'dsq'].includes(r.status) || (!endedRun && old?.status === r.status && old?.timeMs === r.timeMs)) continue;
        race.apply({ type: r.status, bib: r.bib, timeMs: r.timeMs }, now, settings);
      }
    }
    race.results = results;
  }
  race.active = new Map();
  for (const r of active) {
    const key = JSON.stringify([r.id, r.runId]);
    if (!runs.has(key)) {
      // Only a newly observed delta establishes a local clock. Snapshots and
      // result cancellation can restore an active row without a new start.
      const priorStart = prior?.timing?.lastStartAtMs;
      const oldStart = Number.isFinite(priorStart) && r.startedAtMs <= priorStart;
      const unknownResultRun = !Number.isFinite(priorStart) && prior?.results?.[r.id];
      const newStart = !reset && !event.heartbeat &&
        prior.active?.[r.id]?.runId !== r.runId && !oldStart && !unknownResultRun;
      runs.set(key, newStart ? now : null);
      if (newStart) race.lastStartAt = now;
    }
    const anchor = runs.get(key);
    const elapsed = anchor === null ? null : Math.max(0, now - anchor);
    race.active.set(r.bib, { bib: r.bib, runId: r.runId, startedAt: anchor,
      ...(r.heat === undefined ? {} : { heat: r.heat, totalEligible: r.totalEligible, runTimeMs: elapsed }),
      timeMs: elapsed === null || r.totalEligible === false ? null : r.baseTimeMs + elapsed, updatedAt: now,
      running: true, estimated: true, stale: false, finished: false, status: 'running' });
    race.terminalQueue = race.terminalQueue.filter(e => e.racer.bib !== r.bib);
  }
  previous.set(race, { state, sessionId: event.sessionId, runs });
}
