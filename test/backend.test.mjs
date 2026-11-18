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
import { parseRoster } from "../lib/roster.mjs";
import { Race } from "../lib/race.mjs";
import {
  createLineDecoder,
  createVolaParser,
  volaTimestamp,
} from "../lib/protocol.mjs";
import { createApp } from "../server.mjs";

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
      assert.equal(race.current.stale, true);
    } finally {
      stop();
      connection.mock.restore();
    }
  }
});

test("CSV preserves bibs and quoted Unicode names and rejects duplicates or malformed input", () => {
  assert.deepEqual(
    parseRoster('\uFEFFbib;name;category\r\n001;"Testilaskija Ä, Ö";U12\r\n'),
    [{ bib: "001", name: "Testilaskija Ä, Ö", category: "U12" }],
  );
  assert.throws(
    () => parseRoster("bib,name,category\n1,A,U12\n1,B,U14"),
    /Duplicate/,
  );
  assert.throws(() => parseRoster('bib,name,category\n1,"A,U12'), /Unclosed/);
  assert.throws(() => parseRoster("bib,name\n1,A"), /headers/);
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
  assert.equal(view.current.bib, "3");
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
    { type: "finish", bib: "001", timeMs: 45123.456000000006 },
  ]);
  assert.equal(volaTimestamp("1000000000"), 1000000);
  assert.throws(() => volaTimestamp("12abc"), /timestamp/);
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
