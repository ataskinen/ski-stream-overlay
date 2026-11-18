import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { SimulatorRace, formatTimingEvent, durationFor } from "./race.mjs";
import { createSimulator } from "./server.mjs";
import { createVolaParser, createLineDecoder } from "../lib/protocol.mjs";

const names = Array.from(
  { length: 9 },
  (_, i) => `Racer ${String(i + 1).padStart(2, "0")}`,
);
const roster = names.map((name, i) => ({
  bib: String(i + 1).padStart(3, "0"),
  name,
  category: "Demo",
}));

test("competition fixture preserves exact names, and the first racer always wins repeated cycles", async () => {
  const csv = await readFile(
    new URL("../examples/competitors.csv", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    csv
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(",")[1]),
    names,
  );
  const race = new SimulatorRace(roster);
  for (let i = 0; i < 27; i++) {
    race.control("next");
    race.control("next");
  }
  assert.equal(race.state().results.length, 9);
  assert.equal(race.state().results[0].name, "Racer 01");
  assert.ok(
    roster.slice(1).every((r) => durationFor(r.bib) > durationFor("001")),
  );
});
test("shared simulation emits inferred VOLA start/finish with correct elapsed duration and deterministic pause/reset", () => {
  const received = [];
  const decode = createLineDecoder(
    createVolaParser((event) => received.push(event)),
  );
  const race = new SimulatorRace(roster, (event) =>
    decode(formatTimingEvent(event)),
  );
  race.control("start", 10);
  race.tick(1000);
  race.control("pause");
  assert.equal(race.current.elapsedMs, 10000);
  assert.equal(race.running, true);
  race.tick(2000);
  assert.equal(race.running, false);
  assert.equal(race.current, null);
  assert.deepEqual(received, [
    { type: "start", bib: "001", timeMs: 0 },
    { type: "finish", bib: "001", timeMs: 30000 },
  ]);
  race.control("reset");
  assert.equal(race.state().results.length, 0);
  assert.equal(race.state().nextBib, "001");
  assert.throws(() => race.control("speed", 0), /Speed/);
});
test("HTTP controls and CSV drive one shared TCP race for multiple clients", async (t) => {
  const simulator = await createSimulator({
    tcpPort: 0,
    httpPort: 0,
    tickMs: 10000,
  }).listen();
  const first = net.createConnection({
    host: "127.0.0.1",
    port: simulator.timing.address().port,
  });
  const second = net.createConnection({
    host: "127.0.0.1",
    port: simulator.timing.address().port,
  });
  t.after(async () => {
    first.destroy();
    second.destroy();
    await simulator.close();
  });
  await Promise.all([once(first, "connect"), once(second, "connect")]);
  const base = `http://127.0.0.1:${simulator.web.address().port}`;
  const control = (action, origin) =>
    fetch(base + "/api/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ action }),
    });
  assert.equal((await control("start", "https://evil.example")).status, 403);
  const a = once(first, "data"),
    b = once(second, "data");
  await control("next");
  assert.equal((await a)[0].toString(), (await b)[0].toString());
  const c = once(first, "data");
  await control("next");
  assert.match((await c)[0].toString(), /^NR;1;;001;;;/);
  assert.match(
    await (await fetch(base + "/competitors.csv")).text(),
    /Racer 09/,
  );
  const state = await (await fetch(base + "/api/state")).json();
  assert.equal(state.clients, 2);
  assert.equal(state.results[0].name, "Racer 01");
});
