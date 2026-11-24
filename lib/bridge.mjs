import WebSocket from 'ws';

const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
const string = (x, max = 512) => typeof x === 'string' && x.length <= max && !/[\x00-\x1f\x7f]/.test(x);
export function validateState(state) {
  if (!object(state) || !object(state.competition) ||
      !string(state.competition.id) || !string(state.competition.name, 120) ||
      typeof state.competition.runningTimersSupported !== 'boolean' ||
      !object(state.competitors) || !object(state.results)) throw Error('Invalid bridge state');
  if (state.competition.categoryStandings !== undefined) {
    const categories = state.competition.categoryStandings;
    if (!Array.isArray(categories) || categories.length > 100000 || categories.some(c => !object(c) || !string(c.category) || !['heat','total'].includes(c.ranking) || !Array.isArray(c.heats) || !c.heats.length || c.heats.length > 9 || c.heats.some(h => !Number.isInteger(h) || h < 1 || h > 9))) throw Error('Invalid category standings');
  }
  const people = Object.entries(state.competitors), results = Object.entries(state.results), bibs = new Set();
  if (people.length > 100000 || results.length > 100000) throw Error('Bridge state too large');
  for (const [id, p] of people) {
    if (!object(p) || id !== p.id || !string(id) || !id ||
        !string(p.bib, 40) || !p.bib || bibs.has(p.bib) ||
        !['name', 'category', 'club', 'yearOfBirth'].every(k => string(p[k]))) throw Error('Invalid competitor');
    bibs.add(p.bib);
  }
  for (const [id, r] of results) {
    if (!object(r) || r.id !== id || r.competitorId !== id ||
        !Object.hasOwn(state.competitors, id) || state.competitors[id].bib !== r.bib ||
        !['finish', 'dns', 'dnf', 'dsq'].includes(r.status) ||
        (r.status === 'finish' ? !Number.isInteger(r.timeMs) || r.timeMs <= 0 || r.timeMs > 86400000 : r.timeMs !== null))
      throw Error('Invalid result');
  }
  if (state.runResults !== undefined && (!object(state.runResults) || Object.keys(state.runResults).length > 100000)) throw Error('Invalid run results');
  for (const [id, r] of Object.entries(state.runResults || {})) {
    if (!object(r) || r.id !== id || r.competitorId !== id ||
        !Object.hasOwn(state.competitors, id) || state.competitors[id].bib !== r.bib ||
        !Number.isInteger(r.heat) || r.heat < 1 || r.heat > 9 ||
        !(r.runId === null || (string(r.runId) && r.runId)) ||
        !['finish', 'dns', 'dnf', 'dsq'].includes(r.status) ||
        (r.status === 'finish' ? !Number.isInteger(r.timeMs) || r.timeMs <= 0 || r.timeMs > 86400000 : r.timeMs !== null) ||
        typeof r.totalEligible !== 'boolean' ||
        (r.totalTimeMs !== null && (!Number.isInteger(r.totalTimeMs) || r.totalTimeMs <= 0 || r.totalTimeMs > 86400000)) ||
        (r.totalEligible && r.status === 'finish' ? r.totalTimeMs === null : r.totalTimeMs !== null))
      throw Error('Invalid run result');
  }
  if (state.active !== undefined && !object(state.active)) throw Error('Invalid active racers');
  if (Object.keys(state.active || {}).length > 1000) throw Error('Too many active racers');
  for (const [id, r] of Object.entries(state.active || {})) {
    if ((r.heat !== undefined && (!Number.isInteger(r.heat) || r.heat < 1 || r.heat > 9)) ||
        (r.totalEligible !== undefined && typeof r.totalEligible !== 'boolean')) throw Error('Invalid active run metadata');
    if (!state.competition.runningTimersSupported || !object(r) || r.id !== id || r.competitorId !== id ||
        !Object.hasOwn(state.competitors, id) || state.competitors[id].bib !== r.bib || !string(r.runId) || !r.runId ||
        !Number.isFinite(r.startedAtMs) || r.startedAtMs < 0 || !Number.isFinite(r.baseTimeMs) || r.baseTimeMs < 0 || r.baseTimeMs > 86400000)
      throw Error('Invalid active racer');
  }
  if (state.timing !== undefined && (!object(state.timing) || (state.timing.lastStartAtMs !== null && (!Number.isFinite(state.timing.lastStartAtMs) || state.timing.lastStartAtMs < 0)))) throw Error('Invalid timing metadata');
  return state;
}
export function applyDelta(state, changes) {
  if (!object(changes)) throw Error('Invalid delta');
  const next = { ...state, competition: changes.competition ?? state.competition, timing: changes.timing ?? state.timing };
  for (const field of ['competitors', 'results', 'active', 'runResults']) {
    if (field === 'runResults' && state[field] === undefined && changes[field] === undefined) continue;
    next[field] = { ...state[field] };
    const change = changes[field];
    if (!change) continue;
    if (!object(change) || !Array.isArray(change.delete) || !Array.isArray(change.upsert)) throw Error('Invalid delta');
    for (const id of change.delete) {
      if (!string(id)) throw Error('Invalid deletion');
      delete next[field][id];
    }
    for (const value of change.upsert) {
      if (!object(value) || !string(value.id) || ['__proto__', 'constructor', 'prototype'].includes(value.id)) throw Error('Invalid upsert');
      next[field][value.id] = value;
    }
  }
  return validateState(next);
}

// All frames are serialized by WebSocket. Any revision gap requests a fresh snapshot.
export function connectBridge(config, onEvent, onStatus) {
  let stopped = false, socket, retry, watchdog, state, session, revision = -1, waiting = true, lastFrame = Date.now();
  const status = (s, m) => { if (!stopped) onStatus(s, m); };
  function health(h) {
    if (!h || typeof h.ok !== 'boolean') throw Error('Missing health');
    status(h.ok && state && !waiting ? 'connected' : 'stale', h.ok ? (state?.competition.runningTimersSupported ? 'VOLA bridge — timing and results' : 'VOLA bridge — results only') : 'VOLA database unavailable; retaining last results');
  }
  function connect() {
    if (stopped) return;
    waiting = true; state = undefined; revision = -1; session = undefined; lastFrame = Date.now();
    status('connecting', 'Connecting to VOLA bridge');
    socket = new WebSocket(`ws://${config.host}:${config.port}/api/v1/events`, {
      headers: { Authorization: `Bearer ${config.bridgeKey}` }, maxPayload: 32 * 1024 * 1024,
      handshakeTimeout: 5000, perMessageDeflate: false,
    });
    socket.on('message', raw => {
      if (stopped) return;
      try {
        const m = JSON.parse(raw.toString());
        if (m.apiVersion !== 1 || !string(m.sessionId) || !Number.isSafeInteger(m.revision) || m.revision < 0) throw Error('Invalid envelope');
        lastFrame = Date.now();
        if (m.type === 'state.snapshot') {
          if (m.state === null) { health(m.health); return; }
          const next = validateState(m.state);
          state = next; session = m.sessionId; revision = m.revision; waiting = false;
          onEvent({ type: 'bridge-state', sessionId: session, state, reset: true, serverNow: m.serverNow });
        } else if (m.type === 'state.delta') {
          if (waiting) return;
          if (session !== m.sessionId || revision !== m.baseRevision || m.revision !== revision + 1) {
            waiting = true; status('stale', 'Resynchronizing VOLA bridge');
            socket.send(JSON.stringify({ type: 'state.request' })); return;
          }
          const next = applyDelta(state, m.changes);
          state = next; revision = m.revision;
          onEvent({ type: 'bridge-state', sessionId: session, state, reset: false, serverNow: m.serverNow });
        } else if (m.type === 'health') {
          if (!waiting && (session !== m.sessionId || revision !== m.revision)) {
            waiting = true; socket.send(JSON.stringify({ type: 'state.request' }));
          }
        } else throw Error('Unknown message');
        if (m.type === 'health' && !waiting && state && m.health?.ok)
          onEvent({ type: 'bridge-state', sessionId: session, state, reset: false, heartbeat: true, serverNow: m.serverNow });
        health(m.health);
      } catch {
        status('error', 'Invalid bridge data; reconnecting'); socket.terminate();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (stopped) return;
      status('disconnected', 'Bridge disconnected; retrying');
      retry = setTimeout(connect, 1000);
    });
  }
  watchdog = setInterval(() => {
    if (!stopped && Date.now() - lastFrame > 8000) socket?.terminate();
  }, 1000);
  connect();
  return () => { stopped = true; clearTimeout(retry); clearInterval(watchdog); socket?.terminate(); };
}
