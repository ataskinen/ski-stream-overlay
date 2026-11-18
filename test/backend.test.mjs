import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { attachParentControl } from "../lib/parent-control.mjs";
import { connectFeed } from "../lib/feed.mjs";
import { parseRoster, rosterCsv } from "../lib/roster.mjs";
import { Race } from "../lib/race.mjs";
import {
  createLineDecoder,
  createVolaParser,
  volaTimestamp,
} from "../lib/protocol.mjs";
import { createApp } from "../server.mjs";

test("discipline metadata validates exact values and persists in snapshots without reconnecting or freezing racers", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "ski-overlay-discipline-"),
  );
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({ config: { mode: "tcp", eventName: "Demo event" } }),
  );
  const feeds = [];
  const connector = (config, event) => {
    feeds.push({ config, event });
    return () => {};
  };
  let app = await createApp({ dataDir, feedConnector: connector });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(
    (await directRequest(app, "/api/config")).body.discipline,
    "Other",
  );
  const request = new PassThrough();
  request.url = "/api/events";
  request.method = "GET";
  request.headers = { host: "127.0.0.1:8787" };
  const messages = [];
  app.server.emit("request", request, {
    writeHead() {},
    write(chunk) {
      messages.push(chunk);
      return true;
    },
    end() {},
  });
  feeds[0].event({ type: "start", bib: "001" });
  feeds[0].event({ type: "start", bib: "002" });
  for (const discipline of ["GS", "SL", "TAITO", "SG", "SUP", "DH", "Other"]) {
    const response = await directRequest(app, "/api/config", "PUT", {
      discipline,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.discipline, discipline);
    const state = (await directRequest(app, "/api/state")).body;
    assert.equal(state.discipline, discipline);
    assert.equal(state.eventName, "Demo event");
    assert.deepEqual(
      state.activeRacers.map((r) => r.running),
      [true, true],
    );
    assert.equal(feeds.length, 1);
    const latestSnapshot = messages
      .filter((chunk) => chunk.startsWith("data: "))
      .at(-1);
    assert.equal(
      JSON.parse(latestSnapshot.slice(6).trim()).discipline,
      discipline,
    );
  }
  for (const discipline of ["gs", "OTHER", "", null, 123, {}, ["SL"]])
    assert.equal(
      (await directRequest(app, "/api/config", "PUT", { discipline })).status,
      400,
    );
  await directRequest(app, "/api/config", "PUT", { discipline: "SL" });
  request.emit("close");
  await app.close();
  app = await createApp({ dataDir, feedConnector: connector });
  assert.equal((await directRequest(app, "/api/state")).body.discipline, "SL");
  assert.equal(
    (await directRequest(app, "/api/config")).body.eventName,
    "Demo event",
  );
});

test("overlapping racers retain independent clocks and ordered finish DNF DSQ holds", () => {
  const race = new Race({}, 0);
  const roster = parseRoster("bib,category\n1,A\n2,A\n3,B");
  race.apply({ type: "start", bib: "1" }, 0);
  race.apply({ type: "start", bib: "2" }, 100);
  race.apply({ type: "start", bib: "3" }, 200);
  race.apply({ type: "time", bib: "2", timeMs: 400 }, 500);
  let view = race.view(roster, 500);
  assert.deepEqual(
    view.activeRacers.map((r) => r.bib),
    ["1", "2", "3"],
  );
  assert.equal(view.activeRacers[1].timeMs, 400);
  assert.equal(view.activeRacers[0].timeMs, 0);
  race.apply({ type: "finish", bib: "2", timeMs: 1000 }, 1100);
  race.apply({ type: "dnf", bib: "1" }, 1200);
  race.apply({ type: "dsq", bib: "3" }, 1300);
  view = race.view(roster, 1300);
  assert.deepEqual(
    view.terminalQueue.map((r) => r.bib),
    ["2", "1", "3"],
  );
  assert.equal(view.activeRacers.length, 0);
  assert.equal(view.current.status, "finish");
  assert.equal(view.presentation.mode, "racers");
  assert.equal(race.view(roster, 3099).current.bib, "2");
  assert.equal(race.view(roster, 3100).current.status, "dnf");
  assert.equal(race.view(roster, 5100).current.status, "dsq");
  view = race.view(roster, 7100);
  assert.equal(view.current, null);
  assert.equal(view.presentation.mode, "top10");
  assert.equal(view.presentation.category, "B");
  assert.deepEqual(
    view.results.filter((r) => r.rank !== null).map((r) => r.bib),
    ["2"],
  );
  assert.equal(view.results.find((r) => r.bib === "1").timeMs, null);
});
test("terminal queue does not hide other active racers and duplicate corrections or late ticks cannot resurrect them", () => {
  const race = new Race({}, 0);
  const roster = parseRoster("bib,category\n1,A\n2,A");
  race.apply({ type: "start", bib: "1" }, 0);
  race.apply({ type: "start", bib: "2" }, 100);
  race.apply({ type: "finish", bib: "1", timeMs: 1000 }, 1000);
  let view = race.view(roster, 1000);
  assert.equal(view.current.bib, "1");
  assert.deepEqual(
    view.otherRacers.map((r) => r.bib),
    ["2"],
  );
  race.apply({ type: "finish", bib: "1", timeMs: 1000 }, 1100);
  assert.equal(race.terminalQueue.length, 1);
  race.apply({ type: "finish", bib: "1", timeMs: 900 }, 1200);
  assert.equal(race.terminalQueue.length, 1);
  assert.equal(race.terminalQueue[0].racer.timeMs, 900);
  race.apply({ type: "time", bib: "1", timeMs: 1200 }, 1300);
  assert.equal(race.active.has("1"), false);
  race.stale(1500);
  view = race.view(roster, 3000);
  assert.equal(view.current.bib, "2");
  assert.equal(view.current.stale, true);
  assert.equal(view.presentation.mode, "racers");
  const restored = new Race(race.save(), 4000);
  assert.equal(restored.active.size, 0);
  assert.equal(restored.terminalQueue.length, 0);
  assert.equal(restored.results.get("1").timeMs, 900);
});
test("idle rotation waits for active and terminal rows and cycles only categories with ranked results", () => {
  const race = new Race({}, 0);
  const roster = parseRoster("bib,category\n1,A\n2,B\n3,C");
  const settings = {
    finishHoldMs: 2000,
    idleRotationMs: 10000,
    categoryRotationMs: 1000,
  };
  race.apply({ type: "start", bib: "1" }, 0, settings);
  race.apply({ type: "finish", bib: "1", timeMs: 500 }, 500, settings);
  race.apply({ type: "finish", bib: "2", timeMs: 600 }, 1000, settings);
  race.apply({ type: "dnf", bib: "3" }, 1100, settings);
  assert.equal(race.view(roster, 6500, settings).presentation.mode, "top10");
  assert.equal(race.view(roster, 9999, settings).presentation.mode, "top10");
  assert.equal(race.view(roster, 10000, settings).presentation.category, "A");
  assert.equal(race.view(roster, 11000, settings).presentation.category, "B");
  assert.equal(race.view(roster, 12000, settings).presentation.category, "A");
  race.apply({ type: "start", bib: "3" }, 12001, settings);
  let view = race.view(roster, 50000, settings);
  assert.equal(view.presentation.mode, "racers");
  assert.equal(view.current.bib, "3");
  race.apply({ type: "dsq", bib: "3" }, 50000, settings);
  assert.equal(race.view(roster, 51999, settings).presentation.mode, "racers");
  assert.equal(race.view(roster, 52000, settings).presentation.mode, "cycle");
});
test("raw VOLA requires explicit DNF DSQ mappings and unknown codes never become finishes", () => {
  const events = [];
  const parser = createVolaParser((event) => events.push(event), {
    0: "start",
    1: "finish",
    90: "dnf",
    91: "dsq",
  });
  parser("NR;0;;1;;;1000000000");
  parser("NR;7;;1;;;1001000000");
  assert.equal(events.length, 1);
  parser("NR;90;;1");
  assert.deepEqual(events[1], { type: "dnf", bib: "1", timeMs: null });
  parser("NR;91;;2");
  assert.deepEqual(events[2], { type: "dsq", bib: "2", timeMs: null });
  const defaults = [];
  const legacy = createVolaParser((event) => defaults.push(event));
  legacy("NR;0;;3;;;1000000000");
  legacy("NR;90;;3;;;1001000000");
  assert.equal(defaults.length, 1);
  legacy("NR;1;;3;;;1001000000");
  assert.equal(defaults[1].timeMs, 1000);
});
test("presentation config validates and persists without reconnecting the timing feed", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ski-overlay-present-"));
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({ config: { mode: "tcp" } }),
  );
  let connections = 0;
  let app = await createApp({
    dataDir,
    feedConnector: () => {
      connections++;
      return () => {};
    },
  });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const response = await directRequest(app, "/api/config", "PUT", {
    finishHoldMs: 1500,
    idleRotationMs: 20000,
    categoryRotationMs: 3000,
  });
  assert.equal(response.status, 200);
  assert.equal(connections, 1);
  assert.deepEqual(
    (await directRequest(app, "/api/state")).body.presentationSettings,
    { finishHoldMs: 1500, idleRotationMs: 20000, categoryRotationMs: 3000 },
  );
  for (const value of [
    { finishHoldMs: 0 },
    { idleRotationMs: 9999 },
    { categoryRotationMs: 60001 },
    { volaStatusMap: { 0: "start", 90: "dnf" } },
    { volaStatusMap: { 0: "start", 1: "invented" } },
  ])
    assert.equal(
      (await directRequest(app, "/api/config", "PUT", value)).status,
      400,
    );
  await app.close();
  app = await createApp({ dataDir, feedConnector: () => () => {} });
  assert.equal(
    (await directRequest(app, "/api/config")).body.finishHoldMs,
    1500,
  );
});

test("private parent pipe accepts a split shutdown command once and closes on owner EOF", async () => {
  let shutdowns = 0;
  const input = new PassThrough();
  attachParentControl(input, () => shutdowns++);
  input.write("not-shutdown\nshut");
  assert.equal(shutdowns, 0);
  input.write("down\nshutdown\n");
  assert.equal(shutdowns, 1);
  input.end();
  await new Promise((resolve) => input.on("end", resolve));
  assert.equal(shutdowns, 1);
  let eof = 0;
  const owned = new PassThrough();
  attachParentControl(owned, () => eof++);
  owned.end();
  await new Promise((resolve) => owned.on("end", resolve));
  assert.equal(eof, 1);
});

function latestTerminalView(race, roster) {
  const view = race.view(roster);
  return {
    ...view,
    current:
      view.terminalQueue.find((r) => r.bib === race.lastTerminal?.bib) ??
      view.current,
  };
}

function directRequest(app, route, method = "GET", value) {
  const request = Readable.from(
    value === undefined ? [] : [JSON.stringify(value)],
  );
  request.url = route;
  request.method = method;
  request.headers = {
    host: "127.0.0.1:8787",
    "content-type": "application/json",
  };
  return new Promise((resolve) => {
    let status;
    app.server.emit("request", request, {
      writeHead(code) {
        status = code;
      },
      end(text) {
        resolve({ status, body: JSON.parse(text) });
      },
    });
  });
}

test("late simulator events cannot enter live results during deferred config persistence", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "ski-overlay-generation-"),
  );
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({
      config: { mode: "tcp", testFeed: true },
      roster: [],
      testRoster: [],
    }),
  );
  const feeds = [];
  let releaseSave, saving;
  const saveEntered = new Promise((resolve) => {
    saving = resolve;
  });
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  let firstSave = true;
  const app = await createApp({
    dataDir,
    saveState: async () => {
      if (firstSave) {
        firstSave = false;
        saving();
        await saveGate;
      }
    },
    feedConnector: (config, event, status) => {
      const feed = { config, event, status, stopped: false };
      feeds.push(feed);
      return () => {
        feed.stopped = true;
      };
    },
  });
  t.after(async () => {
    releaseSave();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const oldFeed = feeds[0];
  const switching = directRequest(app, "/api/config", "PUT", {
    mode: "tcp",
    testFeed: false,
  });
  await saveEntered;
  assert.equal(oldFeed.stopped, true);
  oldFeed.event({ type: "finish", bib: "001", timeMs: 30000 });
  oldFeed.status("disconnected", "old simulator disconnected");
  let state = (await directRequest(app, "/api/state")).body;
  assert.equal(state.testFeed, false);
  assert.equal(state.results.length, 0);
  assert.notEqual(state.connection.message, "old simulator disconnected");
  releaseSave();
  assert.equal((await switching).status, 200);
  await directRequest(app, "/api/config", "PUT", {
    mode: "tcp",
    testFeed: true,
  });
  state = (await directRequest(app, "/api/state")).body;
  assert.equal(state.results.length, 0);
});

test("deferred test roster download is rejected after feed changes and cannot replace live roster", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "ski-overlay-download-"),
  );
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({
      config: { mode: "tcp", testFeed: true },
      roster: [{ bib: "001", name: "Real racer", category: "Real" }],
      testRoster: [
        { bib: "001", name: "Original test racer", category: "Test" },
      ],
    }),
  );
  let releaseDownload, downloading;
  const downloadEntered = new Promise((resolve) => {
    downloading = resolve;
  });
  const downloadGate = new Promise((resolve) => {
    releaseDownload = resolve;
  });
  const app = await createApp({
    dataDir,
    feedConnector: () => () => {},
    downloadRoster: async () => {
      downloading();
      return downloadGate;
    },
  });
  t.after(async () => {
    releaseDownload("bib,name,category\n001,Late test racer,Test");
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const downloadingRequest = directRequest(app, "/api/roster/fetch", "POST", {
    url: "http://127.0.0.1:8790/competitors.csv",
  });
  await downloadEntered;
  await directRequest(app, "/api/config", "PUT", {
    mode: "tcp",
    testFeed: false,
  });
  releaseDownload("bib,name,category\n001,Late test racer,Test");
  const rejected = await downloadingRequest;
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /settings changed/);
  let state = (await directRequest(app, "/api/state")).body;
  assert.equal(state.liveRoster[0].name, "Real racer");
  assert.equal((await directRequest(app, "/api/config")).body.rosterUrl, "");
  await directRequest(app, "/api/config", "PUT", {
    mode: "tcp",
    testFeed: true,
  });
  state = (await directRequest(app, "/api/state")).body;
  assert.equal(state.liveRoster[0].name, "Original test racer");
});

test("start-finish-only TCP feeds remain running during event silence", async (t) => {
  for (const protocol of ["vola", "jsonl"]) {
    const socket = new EventEmitter();
    let idleTimer;
    let keepAlive;
    socket.setEncoding = () => socket;
    socket.setKeepAlive = (...args) => {
      keepAlive = args;
      return socket;
    };
    // Accelerate the former ten-second idle timeout: old code would freeze this run.
    socket.setTimeout = (milliseconds) => {
      idleTimer = setTimeout(
        () => socket.emit("timeout"),
        milliseconds / 10000,
      );
      return socket;
    };
    socket.destroy = () => {
      clearTimeout(idleTimer);
      socket.emit("close");
    };
    const connection = t.mock.method(net, "createConnection", () => socket);
    const race = new Race();
    const statuses = [];
    const stop = connectFeed(
      { mode: "tcp", protocol, host: "127.0.0.1", port: 5409 },
      (event) => race.apply(event),
      (status) => {
        statuses.push(status);
        if (["disconnected", "error", "stale"].includes(status)) race.stale();
      },
    );
    try {
      socket.emit("connect");
      socket.emit(
        "data",
        protocol === "vola"
          ? "NR;0;;001;;;1000000000\n"
          : '{"type":"start","bib":"001"}\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(race.current.running, true);
      assert.equal(statuses.includes("stale"), false);
      assert.deepEqual(keepAlive, [true, 10000]);
      socket.emit(
        "data",
        protocol === "vola"
          ? "NR;1;;001;;;1045000000\n"
          : '{"type":"finish","bib":"001","timeMs":45000}\n',
      );
      assert.equal(race.results.get("001").timeMs, 45000);
      assert.equal(race.current.running, false);
      socket.emit(
        "data",
        protocol === "vola"
          ? "NR;0;;002;;;1050000000\n"
          : '{"type":"start","bib":"002"}\n',
      );
      socket.emit("close");
      assert.equal(race.current.running, false);
      assert.equal(race.active.get("002").stale, true);
    } finally {
      stop();
      connection.mock.restore();
    }
  }
});

test("CSV preserves bibs and quoted Unicode names and rejects duplicates or malformed input", () => {
  assert.deepEqual(
    parseRoster('\uFEFFbib;name;category\r\n001;"Testilaskija Ä, Ö";U12\r\n'),
    [{ bib: "001", name: "Testilaskija Ä, Ö", category: "U12", club: "" }],
  );
  assert.throws(
    () => parseRoster("bib,name,category\n1,A,U12\n1,B,U14"),
    /Duplicate/,
  );
  assert.throws(() => parseRoster('bib,name,category\n1,"A,U12'), /Unclosed/);
  assert.throws(() => parseRoster("name,category\nA,U12"), /header/);
});

test("optional roster fields stay blank and club survives quoted Unicode CSV export/import", () => {
  assert.deepEqual(parseRoster("bib\n001\n002"), [
    { bib: "001", name: "", category: "", club: "" },
    { bib: "002", name: "", category: "", club: "" },
  ]);
  const roster = parseRoster(
    'bib,name,category,club\n001,,,"Club Ä, Ö"\n002,Racer 02\n003,Racer 03,Demo,',
  );
  assert.equal(roster[0].club, "Club Ä, Ö");
  assert.equal(roster[1].category, "");
  assert.equal(roster[2].club, "");
  assert.deepEqual(parseRoster(rosterCsv(roster)), roster);
  assert.match(
    rosterCsv([{ bib: "004" }]),
    /^bib,name,category,club\n"004","","",""/,
  );
  assert.throws(() => parseRoster("bib,bib\n001,002"), /unique/);
  assert.throws(() => parseRoster('bib,club\n001,"Club\nName"'), /control/);
});

test("finished racer shows own-category rank, leader gap, signed prior leader margin and club", () => {
  const roster = parseRoster(
    "bib,name,category,club\n001,Racer 01,A,Club Ä\n002,Racer 02,A,\n003,Racer 03,B,Other\n004,,,\n005,Racer 05,A,",
  );
  const race = new Race();
  race.apply({ type: "finish", bib: "001", timeMs: 1000 });
  let view = latestTerminalView(race, roster);
  assert.equal(view.current.finished, true);
  assert.equal(view.current.rank, 1);
  assert.equal(view.current.isLeader, true);
  assert.equal(view.current.gapToLeaderMs, 0);
  assert.equal(view.current.leadDeltaMs, null);
  assert.equal(view.current.club, "Club Ä");
  race.apply({ type: "finish", bib: "002", timeMs: 1200 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.rank, 2);
  assert.equal(view.current.gapToLeaderMs, 200);
  assert.equal(view.current.leadDeltaMs, 200);
  race.apply({ type: "finish", bib: "003", timeMs: 500 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.rank, 1);
  assert.equal(view.current.leadDeltaMs, null);
  race.apply({ type: "finish", bib: "001", timeMs: 800 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.rank, 1);
  assert.equal(view.current.leadDeltaMs, -400);
  race.apply({ type: "finish", bib: "002", timeMs: 800 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.rank, 1);
  assert.equal(view.current.leadDeltaMs, 0);
  assert.equal(view.current.gapToLeaderMs, 0);
  race.apply({ type: "finish", bib: "005", timeMs: 900 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.rank, 3);
  assert.equal(view.current.gapToLeaderMs, 100);
  assert.deepEqual(
    view.results.filter((r) => r.category === "A").map((r) => r.rank),
    [1, 1, 3],
  );
  race.apply({ type: "finish", bib: "004", timeMs: 100 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.category, "");
  assert.equal(view.current.rank, null);
  assert.equal(view.current.gapToLeaderMs, null);
  assert.equal(view.current.leadDeltaMs, null);
  assert.equal(view.current.isLeader, false);
  assert.deepEqual(view.categories, ["A", "B"]);
  race.apply({ type: "finish", bib: "999", timeMs: 50 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.name, "");
  assert.equal(view.current.club, "");
  assert.equal(view.current.category, "");
  assert.equal(view.current.rank, null);
});

test("rank metadata follows roster remapping and corrections but never turns stale running clocks into finishes", () => {
  const race = new Race();
  let roster = parseRoster("bib,category\n001,A\n002,B\n003,A");
  race.apply({ type: "finish", bib: "001", timeMs: 1000 });
  race.apply({ type: "finish", bib: "002", timeMs: 900 });
  assert.equal(latestTerminalView(race, roster).current.leadDeltaMs, null);
  roster = parseRoster("bib,category,club\n001,A,\n002,A,New club\n003,A,");
  let view = latestTerminalView(race, roster);
  assert.equal(view.current.rank, 1);
  assert.equal(view.current.leadDeltaMs, -100);
  assert.equal(view.current.club, "New club");
  race.apply({ type: "finish", bib: "002", timeMs: 1100 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.rank, 2);
  assert.equal(view.current.leadDeltaMs, 100);
  race.apply({ type: "start", bib: "003" }, 1000);
  race.apply({ type: "finish", bib: "001", timeMs: 800 }, 1000);
  view = latestTerminalView(race, roster);
  assert.equal(view.activeRacers[0].bib, "003");
  assert.equal(view.activeRacers[0].finished, false);
  assert.equal(view.activeRacers[0].rank, null);
  race.stale(2000);
  view = latestTerminalView(race, roster);
  assert.equal(view.activeRacers[0].running, false);
  assert.equal(view.activeRacers[0].finished, false);
  assert.equal(view.activeRacers[0].rank, null);
  assert.equal(view.activeRacers[0].gapToLeaderMs, null);
  assert.equal(view.activeRacers[0].isLeader, false);
  assert.equal(new Race(race.save()).view(roster).current, null);
});

test("fractional millisecond leader differences retain exact positive and negative gaps", () => {
  const race = new Race();
  const roster = parseRoster("bib,category\n001,A\n002,A\n003,A");
  race.apply({ type: "finish", bib: "001", timeMs: 30000.2 });
  race.apply({ type: "finish", bib: "002", timeMs: 60000.2 });
  let view = latestTerminalView(race, roster);
  assert.equal(view.current.gapToLeaderMs, 30000);
  assert.equal(view.current.leadDeltaMs, 30000);
  race.apply({ type: "finish", bib: "003", timeMs: 0.2 });
  view = latestTerminalView(race, roster);
  assert.equal(view.current.leadDeltaMs, -30000);
  assert.equal(view.current.gapToLeaderMs, 0);
  assert.equal(view.results.find((r) => r.bib === "001").gapToLeaderMs, 30000);
  assert.equal(view.results.find((r) => r.bib === "002").gapToLeaderMs, 60000);
});

test("event name validates, trims and persists without reconnecting or freezing an active racer", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "ski-overlay-event-name-"),
  );
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({ config: { mode: "tcp", testFeed: true } }),
  );
  const feeds = [];
  const connector = (config, event) => {
    feeds.push({ config, event });
    return () => {};
  };
  let app = await createApp({ dataDir, feedConnector: connector });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  feeds[0].event({ type: "start", bib: "001" });
  let response = await directRequest(app, "/api/config", "PUT", {
    eventName: "  Demo ÄÖ  ",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.eventName, "Demo ÄÖ");
  assert.equal(feeds.length, 1);
  let state = (await directRequest(app, "/api/state")).body;
  assert.equal(state.eventName, "Demo ÄÖ");
  assert.equal(state.current.running, true);
  for (const eventName of [null, 123, "Bad\nName", "x".repeat(121)])
    assert.equal(
      (await directRequest(app, "/api/config", "PUT", { eventName })).status,
      400,
    );
  assert.equal(
    (await directRequest(app, "/api/state")).body.eventName,
    "Demo ÄÖ",
  );
  await app.close();
  app = await createApp({ dataDir, feedConnector: connector });
  assert.equal(
    (await directRequest(app, "/api/state")).body.eventName,
    "Demo ÄÖ",
  );
  response = await directRequest(app, "/api/config", "PUT", {
    eventName: "   ",
  });
  assert.equal(response.body.eventName, "");
});
test("finish corrections replace results, tied ranks work, and another finish leaves current skier", () => {
  const race = new Race();
  const roster = parseRoster("bib,name,category\n1,A,U12\n2,B,U12\n3,C,U14");
  race.apply({ type: "finish", bib: "1", timeMs: 1200 });
  race.apply({ type: "finish", bib: "2", timeMs: 1300 });
  race.apply({ type: "finish", bib: "2", timeMs: 1200 });
  race.apply({ type: "start", bib: "3" });
  race.apply({ type: "finish", bib: "1", timeMs: 1200 });
  const view = race.view(roster);
  assert.equal(view.activeRacers[0].bib, "3");
  assert.deepEqual(
    view.results.map((x) => x.rank),
    [1, 1],
  );
  race.stale();
  assert.equal(race.view(roster).current.running, false);
  assert.equal(new Race(race.save()).current, null);
});
test("a disconnected running clock freezes at its estimated elapsed time", () => {
  const race = new Race();
  race.apply({ type: "start", bib: "1" }, 1000);
  race.stale(3500);
  assert.equal(race.current.timeMs, 2500);
  assert.equal(race.current.running, false);
  race.stale(8000);
  assert.equal(race.current.timeMs, 2500);
});
test("TCP line assembly and inferred VOLA timestamp adapter tolerate split packets", () => {
  const events = [];
  const decode = createLineDecoder(createVolaParser((e) => events.push(e)));
  decode("NR;0;;001;;;1000");
  decode("000000\r\nIR;ignored\nNR;1;;001;;;1045123456\n");
  assert.deepEqual(events, [
    { type: "start", bib: "001", timeMs: 0 },
    { type: "finish", bib: "001", timeMs: 45123.456 },
  ]);
  assert.equal(volaTimestamp("1000000000"), 1000000);
  assert.throws(() => volaTimestamp("12abc"), /timestamp/);
});

test("equal VOLA elapsed microseconds stay tied across different start timestamps and midnight", () => {
  const race = new Race();
  const parse = createVolaParser((event) => race.apply(event));
  parse("NR;0;;001;;;1000000000");
  parse("NR;1;;001;;;1045123456");
  parse("NR;0;;002;;;4000000000");
  parse("NR;1;;002;;;4045123456");
  const roster = parseRoster("bib,category\n001,A\n002,A");
  const view = latestTerminalView(race, roster);
  assert.deepEqual(
    view.results.map((r) => r.timeMs),
    [45123.456, 45123.456],
  );
  assert.deepEqual(
    view.results.map((r) => r.rank),
    [1, 1],
  );
  assert.deepEqual(
    view.results.map((r) => r.gapToLeaderMs),
    [0, 0],
  );
  assert.equal(view.current.leadDeltaMs, 0);
  const events = [];
  const midnight = createVolaParser((event) => events.push(event));
  midnight("NR;0;;003;;;86399900000");
  midnight("NR;1;;003;;;0000100000");
  assert.equal(events[1].timeMs, 200);
});

test("delayed event name request merges the newest connection settings after its body arrives", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "ski-overlay-delayed-config-"),
  );
  const app = await createApp({ dataDir, feedConnector: () => () => {} });
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const pendingBody = new PassThrough();
  pendingBody.url = "/api/config";
  pendingBody.method = "PUT";
  pendingBody.headers = {
    host: "127.0.0.1:8787",
    "content-type": "application/json",
  };
  const pendingResponse = new Promise((resolve) => {
    let status;
    app.server.emit("request", pendingBody, {
      writeHead(value) {
        status = value;
      },
      end(text) {
        resolve({ status, body: JSON.parse(text) });
      },
    });
  });
  assert.equal(
    (
      await directRequest(app, "/api/config", "PUT", {
        mode: "tcp",
        testFeed: true,
        port: 5409,
      })
    ).status,
    200,
  );
  pendingBody.end(JSON.stringify({ eventName: "Demo event" }));
  assert.equal((await pendingResponse).status, 200);
  const config = (await directRequest(app, "/api/config")).body;
  assert.equal(config.mode, "tcp");
  assert.equal(config.testFeed, true);
  assert.equal(config.eventName, "Demo event");
});
test("HTTP API persists roster/config/results, rejects cross-origin writes and invalid roster atomically", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ski-overlay-test-"));
  const timing = net.createServer();
  await new Promise((resolve) => timing.listen(0, "127.0.0.1", resolve));
  let client;
  timing.on("connection", (socket) => {
    client = socket;
  });
  let app = await createApp({ dataDir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    client?.destroy();
    await app.close();
    await new Promise((resolve) => timing.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (route, method, value, headers = {}) =>
    fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  assert.equal(
    (
      await request("/api/roster", "POST", {
        csv: "bib,name,category\n001,Racer 01,U12",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/roster", "POST", {
        csv: "bib,name,category\n1,A,U12\n1,B,U12",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/api/reset",
        "POST",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).liveRoster[0].bib,
    "001",
  );
  await request("/api/config", "PUT", {
    mode: "tcp",
    protocol: "jsonl",
    host: "127.0.0.1",
    port: timing.address().port,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.write('{"type":"finish","bib":"001","timeMs":42000}\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await (await fetch(base + "/api/state")).json()).results[0].name,
    "Racer 01",
  );
  await app.close();
  app = await createApp({ dataDir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const restored = await (await fetch(base + "/api/state")).json();
  assert.equal(restored.results[0].timeMs, 42000);
  assert.equal(restored.current, null);
});

test("HTTP demo, live and simulator rosters and results remain isolated across imports and restart", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "ski-overlay-isolation-"),
  );
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({
      roster: [{ bib: "001", name: "Real racer", category: "Real" }],
      race: { results: [{ bib: "001", timeMs: 60000 }] },
      testRoster: [{ bib: "001", name: "Test racer", category: "Test" }],
      testRace: { results: [{ bib: "001", timeMs: 30000 }] },
    }),
  );
  let app = await createApp({ dataDir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const api = async (route, method, value) => {
    const response = await fetch(base + route, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await api("/api/demo", "POST", { action: "next" });
  assert.equal((await api("/api/state", "GET")).results[0].name, "Racer 01");
  await api("/api/config", "PUT", { mode: "tcp", testFeed: true, port: 9 });
  assert.equal((await api("/api/state", "GET")).results[0].timeMs, 30000);
  await api("/api/roster", "POST", {
    csv: "bib,name,category\n001,Updated test racer,Test",
  });
  assert.equal(
    (await api("/api/state", "GET")).results[0].name,
    "Updated test racer",
  );
  await api("/api/config", "PUT", { mode: "tcp", testFeed: false, port: 9 });
  let state = await api("/api/state", "GET");
  assert.equal(state.results[0].name, "Real racer");
  assert.equal(state.results[0].timeMs, 60000);
  assert.equal(state.testFeed, false);
  await api("/api/config", "PUT", { mode: "tcp", testFeed: true, port: 9 });
  await app.close();
  app = await createApp({ dataDir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  state = await api("/api/state", "GET");
  assert.equal(state.testFeed, true);
  assert.equal(state.results[0].name, "Updated test racer");
  assert.equal(state.current, null);
  await api("/api/reset", "POST", {});
  assert.equal((await api("/api/state", "GET")).results.length, 0);
  await api("/api/config", "PUT", { mode: "tcp", testFeed: false, port: 9 });
  assert.equal((await api("/api/state", "GET")).results[0].name, "Real racer");
});
