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
  assert.equal(v.activeRacers.length,3); assert.equal(v.otherRacers.length,2); assert.equal(v.presentation.mode,'racers'); assert.equal(v.current.timeMs,3000);
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
  sync(s,127000);assert.equal(race.current.running,true);assert.equal(race.current.timeMs,3000);
  sync(s,130000,true);assert.equal(race.current.timeMs,6000);assert.equal(race.terminalQueue.length,0);
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
