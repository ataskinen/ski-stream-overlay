// Reconcile authoritative bridge state without replaying finish history after reconnect.
const previous = new WeakMap();
export function syncBridgeRace(race, event, settings, now = Date.now()) {
  const state = event.state, prior = previous.get(race);
  const reset = event.reset || !prior;
  const skew = Number.isFinite(event.serverNow) ? now - event.serverNow : 0;
  const results = new Map(Object.values(state.results).map(r => [r.bib, { bib: r.bib, status: r.status, timeMs: r.timeMs }]));
  const active = Object.values(state.active || {}).sort((a,b) => a.startedAtMs - b.startedAtMs || a.bib.localeCompare(b.bib));
  if (reset) {
    race.results = results; race.active.clear(); race.terminalQueue = []; race.lastTerminal = null;
    race.lastStartAt = now - settings.idleRotationMs;
  } else {
    // A removed/corrected result must not remain in the visible finish queue.
    race.terminalQueue = race.terminalQueue.filter(e => results.has(e.racer.bib));
    for (const r of Object.values(state.results)) {
      const old = prior.results[r.id];
      const endedRun = prior.active?.[r.id] && !state.active?.[r.id];
      if (!['finish', 'dnf', 'dsq'].includes(r.status) || (!endedRun && old?.status === r.status && old?.timeMs === r.timeMs)) continue;
      race.apply({ type: r.status, bib: r.bib, timeMs: r.timeMs }, now, settings);
    }
    race.results = results;
  }
  const oldActive = race.active;
  race.active = new Map();
  for (const r of active) {
    const startedAt = r.startedAtMs + skew;
    const sameRun = oldActive.get(r.bib)?.runId === r.runId;
    const anchor = sameRun ? oldActive.get(r.bib).startedAt : startedAt;
    race.active.set(r.bib, { bib: r.bib, runId: r.runId, startedAt: anchor,
      timeMs: r.baseTimeMs + Math.max(0, now - anchor), updatedAt: now,
      running: true, estimated: true, stale: false, finished: false, status: 'running' });
    race.terminalQueue = race.terminalQueue.filter(e => e.racer.bib !== r.bib);
  }
  if (Number.isFinite(state.timing?.lastStartAtMs)) race.lastStartAt = state.timing.lastStartAtMs + skew;
  previous.set(race, state);
}
