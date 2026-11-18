import test from "node:test";
import assert from "node:assert/strict";
import { connectState, feedLabel, resetContext } from "../public/shared.js";

test("reset controls name the active result set and never clear live data from demo", () => {
  assert.equal(resetContext({ mode: "demo", testFeed: true }).disabled, true);
  assert.equal(resetContext({ mode: "demo", testFeed: false }).disabled, true);
  const testFeed = resetContext({ mode: "tcp", testFeed: true });
  assert.equal(testFeed.disabled, false);
  assert.match(testFeed.label, /testitulokset/);
  assert.match(testFeed.confirm, /testitulokset/);
  const live = resetContext({ mode: "tcp", testFeed: false });
  assert.equal(live.disabled, false);
  assert.match(live.label, /live-tulokset/);
  assert.match(live.confirm, /live-tulokset/);
});

test("simulated TCP and HTTP feeds remain explicitly marked as test data", () => {
  assert.equal(feedLabel({ mode: "tcp", testFeed: true }), "TESTI");
  assert.equal(feedLabel({ mode: "http-json", testFeed: true }), "TESTI");
  assert.equal(feedLabel({ mode: "demo", testFeed: true }), "DEMO");
  assert.equal(feedLabel({ mode: "tcp", testFeed: false }), "SKI RACE");
});

test("SSE owns initial state and preserves finish ordering without a competing HTTP snapshot", async (t) => {
  let source;
  let fetchCalls = 0;
  let disconnected = 0;
  const received = [];
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls++;
    return {
      ok: true,
      json: async () => ({ current: { running: true, timeMs: 1000 } }),
    };
  });
  const previous = globalThis.EventSource;
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url;
      source = this;
    }
    addEventListener() {}
    close() {
      this.closed = true;
    }
    send(state) {
      this.onmessage({ data: JSON.stringify(state) });
    }
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previous;
  });
  const close = connectState(
    (state) => received.push(state),
    () => disconnected++,
  );
  assert.equal(source.url, "/api/events");
  source.send({ current: { running: true, timeMs: 1000 } });
  const finish = {
    current: { running: false, timeMs: 43720 },
    results: [{ rank: 1, timeMs: 43720 }],
  };
  source.send(finish);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    fetchCalls,
    0,
    "An independent HTTP response must never overwrite the SSE stream",
  );
  assert.deepEqual(received.at(-1), finish);
  assert.equal(received.length, 2);
  close();
  assert.equal(source.closed, true);
  source.send({ current: null });
  source.onerror();
  assert.equal(
    received.length,
    2,
    "Queued callbacks after closing must be ignored",
  );
  assert.equal(disconnected, 0);
});
