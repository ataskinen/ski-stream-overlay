import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { applyDelta, validateState, connectBridge } from '../lib/bridge.mjs';
import { createApp } from '../server.mjs';

const key = 'test-key-not-a-real-secret';
const person = (id, bib, category) => ({ id, bib, category, name: `Example ${bib}`, club: 'Example Club', yearOfBirth: '2016' });
const state = () => ({
  competition: { id: 'event-1', name: 'Example Cup', runningTimersSupported: false },
  competitors: { a: person('a', '1', 'U10'), b: person('b', '2', 'U12') },
  results: { a: { id: 'a', competitorId: 'a', bib: '1', status: 'finish', timeMs: 15000 }, b: { id: 'b', competitorId: 'b', bib: '2', status: 'finish', timeMs: 16000 } },
});
const frame = (type, revision, extra = {}) => ({ apiVersion: 1, type, revision, sessionId: 'session-one', health: { ok: true }, ...extra });
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await delay(20); }
  assert.fail('Expected condition not reached');
}
async function server(t) {
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(r => ws.once('listening', r));
  t.after(async () => { for (const c of ws.clients) c.terminate(); await new Promise(r => ws.close(r)); });
  return ws;
}

test('bridge deltas apply atomically, including removal; invalid references leave state intact', () => {
  const old = state();
  const result = applyDelta(old, { competitors: { upsert: [], delete: ['a'] }, results: { upsert: [], delete: ['a'] } });
  assert.equal(Object.keys(result.competitors).length, 1);
  assert.equal(Object.keys(old.competitors).length, 2);
  assert.throws(() => applyDelta(old, { competitors: { upsert: [], delete: ['a'] } }));
  assert.throws(() => validateState({ ...old, results: { a: { ...old.results.a, timeMs: -1 } } }));
  assert.throws(() => applyDelta(old, { competitors: { upsert: [{ id: '__proto__' }], delete: [] } }));
});

test('bridge client authenticates, requests snapshot after gap, reconnects without replaying history', async t => {
  const ws = await server(t); const events = []; const statuses = []; let peer, requests = 0, connections = 0;
  ws.on('connection', (c, req) => {
    assert.equal(req.headers.authorization, `Bearer ${key}`); peer = c; connections++;
    c.send(JSON.stringify(frame('state.snapshot', 1, { state: state() })));
    c.on('message', raw => { assert.equal(JSON.parse(raw).type, 'state.request'); requests++; c.send(JSON.stringify(frame('state.snapshot', 4, { state: state() }))); });
  });
  const stop = connectBridge({ host: '127.0.0.1', port: ws.address().port, bridgeKey: key }, e => events.push(e), s => statuses.push(s));
  t.after(stop);
  await until(() => events.length === 1);
  peer.send(JSON.stringify(frame('state.delta', 2, { baseRevision: 1, changes: { results: { upsert: [{ ...state().results.a, timeMs: 14000 }], delete: [] } } })));
  await until(() => events.length === 2);
  assert.equal(events[1].state.results.a.timeMs, 14000);
  assert.equal(events[1].reset, false);
  assert.equal(events[1].sessionId, 'session-one');
  peer.send(JSON.stringify(frame('state.delta', 4, { baseRevision: 3, changes: {} })));
  await until(() => events.length === 3);
  assert.equal(requests, 1); assert.equal(events[2].reset, true);
  peer.terminate();
  await until(() => connections === 2 && events.length === 4);
  assert.equal(events[3].reset, true); assert.ok(statuses.includes('disconnected'));
});

test('OBS receives names, results and automatic category rotation; stale reads retain standings', async t => {
  const ws = await server(t); let peer;
  ws.on('connection', c => { peer = c; c.send(JSON.stringify(frame('state.snapshot', 1, { state: state() }))); });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'bridge-overlay-'));
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ config: { mode: 'bridge', host: '127.0.0.1', port: ws.address().port, bridgeKey: key, categoryRotationMs: 1000 } }));
  const app = await createApp({ dataDir });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await until(() => app.state().results.length === 2);
  assert.equal(app.state().eventName, 'Example Cup');
  assert.equal(app.state().results[0].yearOfBirth, '2016');
  assert.equal(app.state().presentation.mode, 'cycle');
  assert.equal(app.state().current, null);
  const category = app.state().presentation.category;
  await until(() => app.state().presentation.category !== category);
  peer.send(JSON.stringify(frame('health', 1, { health: { ok: false } })));
  await until(() => app.state().connection.status === 'stale');
  assert.equal(app.state().results.length, 2);
  peer.send(JSON.stringify(frame('state.snapshot', 1, { state: { ...state(), results: {} }, sessionId: 'restarted' })));
  await until(() => app.state().results.length === 0);
});

test('bridge clocks stack, finish/DNF/DSQ hold, reconnect silently, and idle cycling yields to new starts', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  const race = new Race({}, 100000), s = state(); s.competition.runningTimersSupported = true;
  s.competitors.c = person('c', '3', 'U12'); s.results = {}; s.active = {}; s.timing = {lastStartAtMs:null};
  const sync = (value, now, reset=false) => syncBridgeRace(race, {state:structuredClone(value),reset,serverNow:now}, settings, now);
  sync(s,100000,true);
  for (const [i,id] of ['a','b','c'].entries()) s.active[id]={id,competitorId:id,bib:String(i+1),runId:id,startedAtMs:100000+i*1000,baseTimeMs:0};
  s.timing.lastStartAtMs=102000; sync(s,103000);
  let v=race.view(Object.values(s.competitors),103000,settings);
  assert.equal(v.activeRacers.length,3); assert.equal(v.otherRacers.length,2); assert.equal(v.presentation.mode,'racers'); assert.equal(v.current.timeMs,0);
  delete s.active.a;s.results.a={id:'a',competitorId:'a',bib:'1',status:'finish',timeMs:15000};sync(s,115000);
  v=race.view(Object.values(s.competitors),115000,settings);assert.equal(v.current.status,'finish');assert.equal(v.otherRacers.length,2);
  v=race.view(Object.values(s.competitors),117001,settings);assert.equal(v.current.bib,'2');assert.equal(v.presentation.mode,'racers');
  delete s.active.b;s.results.b={id:'b',competitorId:'b',bib:'2',status:'dnf',timeMs:null};sync(s,118000);
  assert.equal(race.current.status,'dnf');
  delete s.active.c;s.results.c={id:'c',competitorId:'c',bib:'3',status:'dsq',timeMs:null};sync(s,118500);
  assert.equal(race.terminalQueue.length,2);
  assert.equal(race.view(Object.values(s.competitors),120001,settings).current.status,'dsq');
  assert.equal(race.view(Object.values(s.competitors),122001,settings).presentation.mode,'cycle');
  sync(s,123000,true);assert.equal(race.terminalQueue.length,0);
  s.active.a={id:'a',competitorId:'a',bib:'1',runId:'again',startedAtMs:124000,baseTimeMs:0};s.timing.lastStartAtMs=124000;delete s.results.a;sync(s,125000);
  assert.equal(race.view(Object.values(s.competitors),125000,settings).presentation.mode,'racers');
  race.stale(126000);assert.equal(race.current.running,false);
  sync(s,127000);assert.equal(race.current.running,true);assert.equal(race.current.timeMs,2000);
  sync(s,130000,true);assert.equal(race.current.timeMs,5000);assert.equal(race.terminalQueue.length,0);
});

test('a new heat ending with an unchanged cumulative DNF still shows its terminal hold', async () => {
 const {Race}=await import('../lib/race.mjs');
 const {syncBridgeRace}=await import('../lib/bridge-race.mjs');
 const settings={finishHoldMs:2000,idleRotationMs:10000,categoryRotationMs:1000};
 const race=new Race({},100000),s=state();
 s.results={a:{id:'a',competitorId:'a',bib:'1',status:'dnf',timeMs:null}};
 s.active={a:{id:'a',competitorId:'a',bib:'1',runId:'heat2',startedAtMs:100000,baseTimeMs:0}};
 syncBridgeRace(race,{state:structuredClone(s),reset:true,serverNow:101000},settings,101000);
 s.active={};syncBridgeRace(race,{state:structuredClone(s),serverNow:115000},settings,115000);
 assert.equal(race.current.status,'dnf');assert.equal(race.terminalQueue.length,1);
});


test('arrival clocks ignore VOLA time, retain session anchors, and never infer snapshot or cancelled starts', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  const race = new Race({}, 0), s = state();
  s.results = {}; s.active = {};
  const active = (id, bib, runId, baseTimeMs = 0) => ({ id, competitorId: id, bib, runId, baseTimeMs, startedAtMs: 900000000 });
  const sync = (now, extra = {}) => syncBridgeRace(race, {
    state: structuredClone(s), sessionId: 'one', serverNow: 42, ...extra,
  }, settings, now);
  sync(1000, { reset: true });
  s.active.a = active('a', '1', 'run1');
  sync(2000);
  assert.equal(race.current.timeMs, 0);
  s.active.b = active('b', '2', 'run2', 30000);
  sync(3000);
  assert.equal(race.active.get('1').timeMs, 1000);
  assert.equal(race.active.get('2').timeMs, 30000);
  sync(4000, { heartbeat: true });
  assert.equal(race.active.get('1').timeMs, 2000);
  race.stale(4500);
  assert.equal(race.active.get('1').timeMs, 2500);
  race.stale(5000);
  assert.equal(race.active.get('1').timeMs, 2500);
  sync(6000, { reset: true });
  assert.equal(race.active.get('1').timeMs, 4000);
  assert.equal(race.active.get('2').timeMs, 33000);
  delete s.active.a;
  s.results.a = { id: 'a', competitorId: 'a', bib: '1', status: 'finish', timeMs: 43210 };
  sync(7000);
  assert.equal(race.current.timeMs, 43210);
  assert.equal(race.current.estimated, false);
  delete s.results.a; s.active.a = active('a', '1', 'run1');
  sync(8000);
  assert.equal(race.active.get('1').startedAt, 2000);
  assert.equal(race.active.get('1').timeMs, 6000);
  sync(9000, { reset: true, sessionId: 'two' });
  assert.equal(race.active.get('1').timeMs, null);
  race.stale(9500);
  assert.equal(race.active.get('1').timeMs, null);
  sync(10000, { sessionId: 'two', heartbeat: true });
  assert.equal(race.active.get('1').timeMs, null);
  s.active.a = active('a', '1', 'next-run', 43210);
  sync(11000, { sessionId: 'two' });
  assert.equal(race.active.get('1').timeMs, 43210);

  const initial = new Race({}, 0);
  const initialState = state(); initialState.active = {};
  initialState.timing = { lastStartAtMs: 900000000 };
  syncBridgeRace(initial, { state: structuredClone(initialState), sessionId: 'one', reset: true }, settings, 1000);
  delete initialState.results.a;
  initialState.active.a = active('a', '1', 'unobserved');
  syncBridgeRace(initial, { state: initialState, sessionId: 'one' }, settings, 2000);
  assert.equal(initial.current.timeMs, null);
});


test('a new heat start after a results-only snapshot establishes an arrival clock when cumulative results disappear', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  const race = new Race({}, 0), s = state();
  s.active = {}; s.timing = { lastStartAtMs: 900000000 };
  syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset: true }, settings, 1000);
  delete s.results.a;
  s.active.a = { id: 'a', competitorId: 'a', bib: '1', runId: 'heat2', startedAtMs: 900001000, baseTimeMs: 15000 };
  s.timing.lastStartAtMs = 900001000;
  syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one' }, settings, 2000);
  assert.equal(race.current.timeMs, 15000);
  assert.equal(race.current.startedAt, 2000);
  syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', heartbeat: true }, settings, 3000);
  assert.equal(race.current.timeMs, 16000);
});


test('unobserved cancelled finishes never invent a start after reconnect or without timing metadata', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  const race = new Race({}, 0), s = state();
  s.results = {}; s.active = {}; s.timing = { lastStartAtMs: null };
  const sync = (now, reset = false) => syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset }, settings, now);
  sync(1000, true);
  s.active.a = { id: 'a', competitorId: 'a', bib: '1', runId: 'heat1', startedAtMs: 100, baseTimeMs: 0 };
  s.timing.lastStartAtMs = 100;
  sync(2000);
  assert.equal(race.current.timeMs, 0);
  // A second run starts and finishes while disconnected; its result is seeded silently.
  s.active = {}; s.timing.lastStartAtMs = 200;
  s.results.a = { id: 'a', competitorId: 'a', bib: '1', status: 'finish', timeMs: 30000 };
  sync(3000, true);
  delete s.results.a;
  s.active.a = { id: 'a', competitorId: 'a', bib: '1', runId: 'heat2', startedAtMs: 200, baseTimeMs: 15000 };
  sync(4000);
  assert.equal(race.current.timeMs, null);
  assert.equal(race.current.startedAt, null);

  const unknown = new Race({}, 0), initial = state(); initial.active = {};
  syncBridgeRace(unknown, { state: structuredClone(initial), sessionId: 'one', reset: true }, settings, 1000);
  delete initial.results.a;
  initial.active.a = { ...s.active.a };
  syncBridgeRace(unknown, { state: initial, sessionId: 'one' }, settings, 2000);
  assert.equal(unknown.current.timeMs, null);
});


test('restoring an unobserved run with a fallback earlier-heat result never starts an estimate', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  const race = new Race({}, 0), s = state();
  s.active = {}; s.timing = { lastStartAtMs: 200 };
  s.results.a.timeMs = 30000;
  syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset: true }, settings, 1000);
  s.results.a.timeMs = 15000;
  s.active.a = { id: 'a', competitorId: 'a', bib: '1', runId: 'heat2', startedAtMs: 200, baseTimeMs: 15000 };
  syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one' }, settings, 2000);
  assert.equal(race.active.get('1').timeMs, null);
  assert.equal(race.active.get('1').startedAt, null);
  syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', heartbeat: true }, settings, 3000);
  assert.equal(race.active.get('1').timeMs, null);
});


test('optional individual results validate and delta atomically without changing combined standings', () => {
  const s = state();
  const run = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'heat2', status: 'finish', timeMs: 14000, totalEligible: true, totalTimeMs: 29000 };
  const next = applyDelta(s, { runResults: { upsert: [run], delete: [] } });
  assert.deepEqual(next.results, s.results);
  assert.equal(next.runResults.a.timeMs, 14000);
  assert.equal(s.runResults, undefined);
  assert.equal(applyDelta(next, { runResults: { upsert: [], delete: ['a'] } }).runResults.a, undefined);
  for (const invalid of [{ heat: 0 }, { runId: 1 }, { timeMs: null }, { totalEligible: false }, { totalTimeMs: -1 }, { competitorId: 'b' }]) {
    assert.throws(() => applyDelta(s, { runResults: { upsert: [{ ...run, ...invalid }], delete: [] } }));
  }
  assert.equal(validateState({ ...s, runResults: { a: { ...run, totalEligible: false, totalTimeMs: null } } }).runResults.a.totalTimeMs, null);
});

test('run2 cards keep individual estimates and official finishes separate from combined standings', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  for (const eligible of [true, false]) {
    const race = new Race({}, 0), s = state();
    s.active = {}; s.runResults = {}; s.timing = { lastStartAtMs: 50 };
    if (!eligible) delete s.results.a;
    const sync = (now, reset = false) => syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset }, settings, now);
    sync(1000, true);
    s.active.a = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'heat2', startedAtMs: 100, baseTimeMs: eligible ? 15000 : 0, totalEligible: eligible };
    s.timing.lastStartAtMs = 100;
    sync(2000);
    assert.equal(race.current.runTimeMs, 0);
    assert.equal(race.current.timeMs, eligible ? 15000 : null);
    sync(3000);
    assert.equal(race.current.runTimeMs, 1000);
    assert.equal(race.current.timeMs, eligible ? 16000 : null);
    race.stale(3500);
    assert.equal(race.current.runTimeMs, 1500);
    assert.equal(race.current.timeMs, eligible ? 16500 : null);
    race.stale(4000);
    assert.equal(race.current.runTimeMs, 1500);
    sync(5000, true);
    assert.equal(race.current.runTimeMs, 3000);
    delete s.active.a;
    s.runResults.a = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'heat2', status: 'finish', timeMs: 14000, totalEligible: eligible, totalTimeMs: eligible ? 29000 : null };
    if (eligible) s.results.a.timeMs = 29000;
    sync(6000);
    const v = race.view(Object.values(s.competitors), 6000, settings);
    assert.equal(v.current.timeMs, eligible ? 29000 : null);
    assert.equal(v.current.runTimeMs, 14000);
    assert.equal(v.current.estimated, false);
    assert.equal(v.current.rank, eligible ? 1 : null);
    assert.equal(v.results.some(r => r.bib === '1'), eligible);
    sync(6500);
    assert.equal(race.terminalQueue.length, 1);
    sync(7000, true);
    assert.equal(race.terminalQueue.length, 0);
  }
});

test('individual archived results and mismatched run identities never create finish holds', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  const race = new Race({}, 0), s = state();
  s.active = {}; s.runResults = { a: { id: 'a', competitorId: 'a', bib: '1', heat: 1, runId: 'old', status: 'finish', timeMs: 15000, totalEligible: true, totalTimeMs: 15000 } };
  const sync = (now, reset = false) => syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset }, settings, now);
  sync(1000, true);
  assert.equal(race.current, null);
  s.runResults.a.timeMs = 14000; s.runResults.a.totalTimeMs = 14000;
  sync(2000);
  assert.equal(race.current, null);
  s.active.a = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'new', startedAtMs: 200, baseTimeMs: 15000, totalEligible: true };
  s.timing = { lastStartAtMs: 200 };
  sync(3000);
  delete s.active.a;
  s.runResults.a = { ...s.runResults.a, heat: 2, runId: 'wrong' };
  sync(4000);
  assert.equal(race.terminalQueue.length, 0);
});


test('matching individual DNF and DSQ end the observed run without adding combined finishes', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  for (const status of ['dnf', 'dsq']) {
    const race = new Race({}, 0), s = state();
    s.results = {}; s.runResults = {}; s.active = {}; s.timing = { lastStartAtMs: null };
    const sync = (now, reset = false) => syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset }, settings, now);
    sync(1000, true);
    s.active.a = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'run2', startedAtMs: 100, baseTimeMs: 0, totalEligible: false };
    s.timing.lastStartAtMs = 100;
    sync(2000);
    delete s.active.a;
    s.runResults.a = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'run2', status, timeMs: null, totalEligible: false, totalTimeMs: null };
    sync(3000);
    assert.equal(race.current.status, status);
    assert.equal(race.current.timeMs, null);
    assert.equal(race.current.runTimeMs, null);
    assert.equal(race.results.size, 0);
    assert.equal(race.terminalQueue.length, 1);
  }
});


test('simultaneous individual finishes compare combined standings and DNS corrections clear holds', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  const race = new Race({}, 0), s = state();
  s.competitors.a.category = s.competitors.b.category = 'U12';
  s.active = {}; s.runResults = {}; s.results = {}; s.timing = { lastStartAtMs: null };
  const sync = (now, reset = false) => syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset }, settings, now);
  sync(1000, true);
  for (const [id, bib] of [['a', '1'], ['b', '2']]) {
    s.active[id] = { id, competitorId: id, bib, heat: 2, runId: id + '-run2', startedAtMs: 100, baseTimeMs: 15000, totalEligible: true };
  }
  s.timing.lastStartAtMs = 100;
  sync(2000);
  s.active = {};
  for (const [id, bib, timeMs, totalTimeMs] of [['a', '1', 15000, 30000], ['b', '2', 16000, 31000]]) {
    s.results[id] = { id, competitorId: id, bib, status: 'finish', timeMs: totalTimeMs };
    s.runResults[id] = { id, competitorId: id, bib, heat: 2, runId: id + '-run2', status: 'finish', timeMs, totalEligible: true, totalTimeMs };
  }
  sync(3000);
  let view = race.view(Object.values(s.competitors), 3000, settings);
  assert.equal(view.terminalQueue.length, 2);
  assert.equal(view.terminalQueue[1].leadDeltaMs, 1000);
  assert.equal(view.terminalQueue[1].gapToLeaderMs, 1000);
  assert.deepEqual(view.results.map(r => r.timeMs), [30000, 31000]);
  assert.equal(race.terminalQueue[1].reference.find(r => r.bib === '1').timeMs, 30000);
  s.runResults.a = { ...s.runResults.a, status: 'dns', timeMs: null, totalEligible: false, totalTimeMs: null };
  delete s.results.a;
  sync(3500);
  view = race.view(Object.values(s.competitors), 3500, settings);
  assert.equal(view.terminalQueue.some(r => r.bib === '1'), false);
  assert.equal(view.current.bib, '2');
});


test('held individual finishes correct to DNF or DSQ and back to official finishes', async () => {
  const { Race } = await import('../lib/race.mjs');
  const { syncBridgeRace } = await import('../lib/bridge-race.mjs');
  const settings = { finishHoldMs: 2000, idleRotationMs: 10000, categoryRotationMs: 1000 };
  for (const status of ['dnf', 'dsq']) {
    const race = new Race({}, 0), s = state();
    s.results = {}; s.runResults = {}; s.active = {}; s.timing = { lastStartAtMs: null };
    const sync = (now, reset = false) => syncBridgeRace(race, { state: structuredClone(s), sessionId: 'one', reset }, settings, now);
    sync(1000, true);
    s.active.a = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'run2', startedAtMs: 100, baseTimeMs: 15000, totalEligible: true };
    s.timing.lastStartAtMs = 100;
    sync(2000);
    delete s.active.a;
    s.results.a = { id: 'a', competitorId: 'a', bib: '1', status: 'finish', timeMs: 30000 };
    s.runResults.a = { id: 'a', competitorId: 'a', bib: '1', heat: 2, runId: 'run2', status: 'finish', timeMs: 15000, totalEligible: true, totalTimeMs: 30000 };
    sync(3000);
    assert.equal(race.current.status, 'finish');
    s.results.a = { ...s.results.a, status, timeMs: null };
    s.runResults.a = { ...s.runResults.a, status, timeMs: null, totalEligible: false, totalTimeMs: null };
    sync(3200);
    assert.equal(race.current.status, status);
    assert.equal(race.current.finished, false);
    assert.equal(race.current.timeMs, null);
    assert.equal(race.current.runTimeMs, null);
    assert.equal(race.terminalQueue.length, 1);
    s.results.a = { ...s.results.a, status: 'finish', timeMs: 31000 };
    s.runResults.a = { ...s.runResults.a, status: 'finish', timeMs: 16000, totalEligible: true, totalTimeMs: 31000 };
    sync(3400);
    assert.equal(race.current.status, 'finish');
    assert.equal(race.current.finished, true);
    assert.equal(race.current.timeMs, 31000);
    assert.equal(race.current.runTimeMs, 16000);
    assert.equal(race.terminalQueue.length, 1);
    assert.equal(race.results.get('1').timeMs, 31000);
  }
});
