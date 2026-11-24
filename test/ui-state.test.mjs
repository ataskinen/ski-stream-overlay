import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryResults,
  decodeRosterText,
  connectState,
  feedLabel,
  finishSummary,
  formatGap,
  resetContext,
  saveEventName,
  saveConnectionConfig,
  estimatedTime,
  overlaySelection,
  savePresentationSettings,
  DISCIPLINES,
  disciplineLabel,
  saveDiscipline,
} from "../public/shared.js";

test("discipline saves only its own metadata and accepts only the offered values", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({
      url,
      method: options.method,
      body: JSON.parse(options.body),
    });
    return { ok: true, json: async () => ({}) };
  });
  for (const discipline of DISCIPLINES) await saveDiscipline(discipline);
  assert.deepEqual(
    requests.map((item) => item.body),
    DISCIPLINES.map((discipline) => ({ discipline })),
  );
  assert.ok(
    requests.every(
      (item) => item.url === "/api/config" && item.method === "PUT",
    ),
  );
  assert.equal(disciplineLabel("Other"), "");
  assert.equal(disciplineLabel(undefined), "");
  assert.equal(disciplineLabel("<script>"), "");
  assert.throws(() => saveDiscipline("gs"));
  assert.equal(requests.length, DISCIPLINES.length);
});

test("each active racer clock uses its own timing anchor and freezes stale values", () => {
  const oldest = { timeMs: 10000, updatedAt: 1000, running: true };
  const newest = { timeMs: 1000, updatedAt: 5000, running: true };
  assert.equal(estimatedTime(oldest, 6000, 100, 1100), 16000);
  assert.equal(estimatedTime(newest, 6000, 100, 1100), 3000);
  assert.equal(
    estimatedTime({ ...newest, stale: true }, 6000, 100, 1100),
    1000,
  );
  assert.equal(estimatedTime(newest, 6000, 100, 1100, false), 1000);
  assert.equal(
    estimatedTime({ ...newest, running: false }, 6000, 100, 1100),
    1000,
  );
});

test("presentation settings save only timing metadata and validate seconds-derived ranges", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({}) };
  });
  await savePresentationSettings({
    finishHoldMs: 2000,
    idleRotationMs: 180000,
    categoryRotationMs: 10000,
    eventName: "Not part of this form",
  });
  assert.deepEqual(requests, [
    { finishHoldMs: 2000, idleRotationMs: 180000, categoryRotationMs: 10000 },
  ]);
  assert.throws(() =>
    savePresentationSettings({
      finishHoldMs: 0,
      idleRotationMs: 180000,
      categoryRotationMs: 10000,
    }),
  );
  assert.equal(requests.length, 1);
});

test("saving connection fields cannot overwrite a concurrently edited event name", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({
      url,
      method: options.method,
      body: JSON.parse(options.body),
    });
    return { ok: true, json: async () => ({}) };
  });
  await saveConnectionConfig({
    mode: "tcp",
    host: "127.0.0.1",
    port: 5409,
    testFeed: true,
    eventName: "Stale event name",
  });
  assert.deepEqual(requests, [
    {
      url: "/api/config",
      method: "PUT",
      body: { mode: "tcp", host: "127.0.0.1", port: 5409, testFeed: true },
    },
  ]);
});

test("saving event name sends only metadata and never sends connection settings", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({
      url,
      method: options.method,
      body: JSON.parse(options.body),
    });
    return { ok: true, json: async () => ({ eventName: "Race" }) };
  });
  await saveEventName("  Race  ");
  assert.deepEqual(requests, [
    { url: "/api/config", method: "PUT", body: { eventName: "Race" } },
  ]);
  assert.throws(() => saveEventName("X".repeat(121)), /120/);
  assert.equal(requests.length, 1);
});

test("finish summaries distinguish new leaders, ties and missing category", () => {
  const finished = {
    finished: true,
    running: false,
    category: "U12",
    rank: 1,
    isLeader: true,
    gapToLeaderMs: 0,
  };
  assert.deepEqual(finishSummary({ ...finished, leadDeltaMs: -1350 }), {
    rank: "1",
    gap: "−1.35",
    tone: "ahead",
  });
  assert.equal(
    finishSummary({ ...finished, leadDeltaMs: null }).gap,
    "JOHDOSSA",
  );
  assert.deepEqual(finishSummary({ ...finished, leadDeltaMs: 0 }), {
    rank: "1",
    gap: "0.00",
    tone: "level",
  });
  assert.deepEqual(
    finishSummary({ ...finished, rank: 3, isLeader: false, leadDeltaMs: 1250 }),
    { rank: "3", gap: "+1.25", tone: "behind" },
  );
  assert.equal(finishSummary({ ...finished, running: true }), null);
  assert.equal(finishSummary({ ...finished, finished: false }), null);
  assert.equal(finishSummary({ ...finished, category: "" }), null);
  assert.equal(formatGap(62100), "+1:02.10");
});

test("queued first finisher turns red when a faster finisher takes the lead", () => {
  const firstFinisher = {
    finished: true,
    running: false,
    category: "U12",
    rank: 1,
    isLeader: true,
    leadDeltaMs: null,
    gapToLeaderMs: 0,
  };
  assert.equal(finishSummary(firstFinisher).gap, "JOHDOSSA");
  assert.deepEqual(
    finishSummary({
      ...firstFinisher,
      rank: 2,
      isLeader: false,
      gapToLeaderMs: 750,
    }),
    { rank: "2", gap: "+0.75", tone: "behind" },
  );
});

test("top 10 never merges unassigned categories and preserves backend tie ranks", () => {
  const state = {
    categories: ["", "U12", "U14"],
    results: [
      { bib: "0", category: "", timeMs: 1 },
      { bib: "1", category: "U12", timeMs: 40000, rank: 1, gapToLeaderMs: 0 },
      { bib: "2", category: "U12", timeMs: 40000, rank: 1, gapToLeaderMs: 0 },
      { bib: "3", category: "U14", timeMs: 39000, rank: 1 },
      { bib: "4", category: "U12", timeMs: null, rank: null, status: "dnf" },
      { bib: "5", category: "U12", timeMs: null, rank: null, status: "dsq" },
    ],
  };
  assert.deepEqual(
    categoryResults(state).rows.map((row) => row.bib),
    ["1", "2"],
  );
  assert.deepEqual(
    categoryResults(state).rows.map((row) => row.rank),
    [1, 1],
  );
  assert.equal(formatGap(categoryResults(state).rows[1].gapToLeaderMs), "0.00");
  assert.deepEqual(
    categoryResults({ categories: [], results: state.results }).rows,
    [],
  );
});

async function overlayHarness(t, pathname, search = "") {
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.className = "";
      this.children = [];
      this.textContent = "";
      this.classList = {
        add: (value) => {
          this.className += ` ${value}`;
        },
      };
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    querySelector(selector) {
      const matches = (child) =>
        child.className.split(" ").includes(selector.slice(1));
      for (const child of this.children) {
        if (matches(child)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
  }
  const root = new Node("main");
  let source;
  let sources = 0;
  let elapsed = 0;
  let frame;
  const values = {
    document: {
      getElementById: () => root,
      createElement: (tag) => new Node(tag),
    },
    location: { pathname, search },
    requestAnimationFrame: (callback) => {
      frame = callback;
    },
    performance: { now: () => elapsed },
    EventSource: class {
      constructor() {
        source = this;
        sources++;
      }
      addEventListener() {}
      close() {}
    },
  };
  const originals = Object.fromEntries(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  t.after(() => {
    for (const key of Object.keys(values)) {
      if (originals[key])
        Object.defineProperty(globalThis, key, originals[key]);
      else delete globalThis[key];
    }
  });
  await import(
    `../public/overlay.js?test=${encodeURIComponent(pathname + search)}`
  );
  return {
    root,
    getSourceCount: () => sources,
    send: (state) => source.onmessage({ data: JSON.stringify(state) }),
    tick: (now) => {
      elapsed = now;
      frame();
    },
    disconnect: () => source.onerror(),
  };
}

test("lower third shows each discipline literally, hides Other and keeps category and test markers", async (t) => {
  const { root, send } = await overlayHarness(
    t,
    "/overlay/current",
    "?scenario=discipline",
  );
  const current = {
    bib: "1",
    name: "Racer",
    category: "U12",
    timeMs: 1234,
    running: true,
  };
  for (const discipline of DISCIPLINES) {
    send({ mode: "tcp", testFeed: true, discipline, current });
    const badge = root.querySelector(".discipline-badge");
    if (discipline === "Other") assert.equal(badge, null);
    else assert.equal(badge.textContent, discipline);
    assert.ok(root.querySelector(".lower-third"));
    assert.equal(root.querySelector(".category-badge").textContent, "U12");
    assert.equal(root.querySelector(".overlay-badge").textContent, "TESTI");
    assert.ok(root.querySelector(".clock-gap-slot"));
  }
  send({ mode: "demo", discipline: "SL", current });
  assert.equal(root.querySelector(".discipline-badge").textContent, "SL");
  assert.equal(root.querySelector(".overlay-badge").textContent, "DEMO");
});

test("top 10 uses the same discipline badge and retains the separate demo or test marker", async (t) => {
  const { root, send } = await overlayHarness(
    t,
    "/overlay/top10",
    "?scenario=discipline",
  );
  const base = {
    categories: ["U12"],
    results: [
      { bib: "1", name: "Racer", category: "U12", timeMs: 40000, rank: 1 },
    ],
  };
  for (const discipline of DISCIPLINES) {
    send({ ...base, mode: "tcp", testFeed: true, discipline });
    const badge = root.querySelector(".discipline-badge");
    if (discipline === "Other") assert.equal(badge, null);
    else assert.equal(badge.textContent, discipline);
    assert.ok(root.querySelector(".leaderboard"));
    assert.equal(root.querySelector(".overlay-badge").textContent, "TESTI");
    assert.equal(root.querySelector(".row-name").textContent, "Racer");
  }
  send({ ...base, mode: "demo", discipline: "Other" });
  assert.equal(root.querySelector(".discipline-badge"), null);
  assert.equal(root.querySelector(".overlay-badge").textContent, "DEMO");
});

test("clock gap space is reserved without placeholder text in running, finish, DNF and DSQ cards", async (t) => {
  const { root, send } = await overlayHarness(
    t,
    "/overlay/current",
    "?scenario=stable-clock-space",
  );
  const racer = {
    bib: "1",
    name: "Racer",
    category: "U12",
    timeMs: 42000,
    rank: 1,
    isLeader: true,
    leadDeltaMs: null,
  };
  for (const status of ["running", "finish", "dnf", "dsq"]) {
    send({
      mode: "tcp",
      testFeed: true,
      current: {
        ...racer,
        status,
        running: status === "running",
        finished: status !== "running",
      },
    });
    const clock = root.querySelector(".clock-block");
    const slot = clock.querySelector(".clock-gap-slot");
    assert.ok(slot, `${status} must retain the same reserved gap container`);
    assert.equal(clock.children.at(-1), slot);
    assert.equal(slot.textContent, "", "No visible placeholder text is used");
    assert.equal(slot.children.length, status === "finish" ? 1 : 0);
  }
});

test("automatic overlay keeps three racers independent and handles terminal results before category boards", async (t) => {
  const { root, send, tick, disconnect, getSourceCount } = await overlayHarness(
    t,
    "/overlay/auto",
    "?scenario=multi",
  );
  const first = {
    bib: "1",
    name: "First",
    category: "U12",
    club: "Club 1",
    timeMs: 10000,
    updatedAt: 1000,
    running: true,
    status: "running",
  };
  const second = {
    bib: "2",
    name: "Second",
    category: "U14",
    club: "Club 2",
    timeMs: 1000,
    updatedAt: 5000,
    running: true,
    status: "running",
  };
  const third = {
    bib: "3",
    name: "",
    category: "U16",
    timeMs: 500,
    updatedAt: 5500,
    running: true,
    status: "running",
  };
  const base = {
    mode: "tcp",
    testFeed: true,
    serverNow: 6000,
    current: first,
    activeRacers: [first, second, third],
    categories: ["U12", "U14"],
    results: [
      { bib: "4", name: "Previous", category: "U12", timeMs: 40000, rank: 1 },
      { bib: "5", name: "Other", category: "U14", timeMs: 42000, rank: 1 },
    ],
  };
  send({
    ...base,
    presentation: {
      mode: "racers",
      current: first,
      otherRacers: [second, third],
    },
  });
  const stack = root.querySelector(".racer-stack");
  assert.equal(stack.children.length, 2);
  assert.equal(root.querySelector(".athlete-name").textContent, "First");
  assert.equal(
    stack.children[0].querySelector(".compact-name").textContent,
    "Second",
  );
  assert.equal(
    stack.children[1].querySelector(".compact-name").textContent,
    "",
  );
  assert.equal(stack.querySelector(".athlete-club"), null);
  assert.equal(stack.querySelector(".category-badge"), null);
  tick(1000);
  assert.equal(root.querySelector(".clock-time").textContent, "16.00");
  assert.equal(
    stack.children[0].querySelector(".compact-time").textContent,
    "3.00",
  );
  assert.equal(
    stack.children[1].querySelector(".compact-time").textContent,
    "2.00",
  );
  disconnect();
  tick(2000);
  assert.equal(root.querySelector(".clock-time").textContent, "16.00");
  assert.equal(
    stack.children[0].querySelector(".compact-time").textContent,
    "3.00",
  );
  for (const status of ["dnf", "dsq"]) {
    send({
      ...base,
      presentation: {
        mode: "racers",
        current: {
          ...second,
          running: false,
          status,
          finished: true,
          timeMs: null,
          rank: 1,
        },
        otherRacers: [first, third],
      },
    });
    assert.equal(
      root.querySelector(".terminal-status").textContent,
      status.toUpperCase(),
    );
    assert.equal(root.querySelector(".finish-rank"), null);
    assert.equal(root.querySelector(".finish-gap"), null);
    assert.equal(root.querySelector(".racer-stack").children.length, 2);
  }
  for (const [mode, category, name] of [
    ["top10", "U12", "Previous"],
    ["cycle", "U14", "Other"],
  ]) {
    send({
      ...base,
      current: null,
      activeRacers: [],
      presentation: { mode, current: null, otherRacers: [], category },
    });
    assert.equal(root.querySelector(".lower-third"), null);
    assert.equal(root.querySelector(".row-name").textContent, name);
    assert.equal(root.querySelector(".overlay-badge").textContent, "TESTI");
  }
  send({
    ...base,
    presentation: { mode: "racers", current: third, otherRacers: [] },
  });
  assert.equal(root.querySelector(".leaderboard"), null);
  assert.equal(root.querySelector(".bib-block").children[1].textContent, "3");
  assert.equal(getSourceCount(), 1);
  assert.equal(
    overlaySelection(
      { ...base, presentation: { mode: "top10", category: "U12" } },
      false,
    ).mode,
    "racer",
    "Manual current source must not switch into a board",
  );
});

test("lower third omits missing roster fields while keeping separate event and test labels", async (t) => {
  const { root, send } = await overlayHarness(t, "/overlay/current");
  const current = {
    bib: "12",
    name: "",
    category: "",
    club: "",
    timeMs: 43720,
    finished: true,
    running: false,
  };
  send({
    mode: "tcp",
    testFeed: true,
    eventName: "Joulupukkipujottelu",
    current,
  });
  assert.equal(root.querySelector(".athlete-name"), null);
  assert.equal(root.querySelector(".athlete-club"), null);
  assert.equal(root.querySelector(".category-badge"), null);
  assert.equal(root.querySelector(".finish-rank"), null);
  assert.equal(root.querySelector(".overlay-badge").textContent, "TESTI");
  assert.equal(
    root.querySelector(".event-name").textContent,
    "Joulupukkipujottelu",
  );
  const name = "<script>unsafe</script>";
  send({
    mode: "tcp",
    testFeed: true,
    eventName: "Race",
    current: {
      ...current,
      name,
      category: "U12",
      club: "Helsinki Ski Club",
      rank: 1,
      isLeader: true,
      leadDeltaMs: -1500,
    },
  });
  assert.equal(root.querySelector(".athlete-name").textContent, name);
  assert.equal(root.querySelector(".athlete-name").children.length, 0);
  assert.equal(root.querySelector(".category-badge").textContent, "U12");
  assert.equal(
    root.querySelector(".athlete-club").textContent,
    "Helsinki Ski Club",
  );
  assert.equal(root.querySelector(".finish-gap").textContent, "−1.50");
});

test("automatic top 10 changes its rendered heading and racers with each finishing category without reloading", async (t) => {
  const { root, send, getSourceCount } = await overlayHarness(
    t,
    "/overlay/top10",
    "?category=auto",
  );
  const groups = ["U10 Girls", "U12 Girls", "U14 Boys"];
  const results = groups.map((category, index) => ({
    bib: String(index + 1),
    name: `Racer ${index + 1}`,
    category,
    timeMs: 15000,
    rank: 1,
    gapToLeaderMs: 0,
  }));
  for (const [index, category] of groups.entries()) {
    send({
      mode: "tcp",
      testFeed: true,
      current: {
        bib: String(index + 1),
        category,
        finished: true,
        running: false,
      },
      categories: groups,
      results,
    });
    const heading = root
      .querySelector(".leaderboard-heading")
      .children.find((node) => node.tagName === "h1");
    assert.equal(heading.textContent, category);
    const rows = root
      .querySelector(".leaderboard")
      .children.filter((node) => node.className === "leaderboard-row");
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].querySelector(".row-name").textContent,
      `Racer ${index + 1}`,
    );
  }
  assert.equal(getSourceCount(), 1);
  send({
    mode: "tcp",
    testFeed: true,
    current: null,
    presentation: { mode: "top10", category: "U12 Girls" },
    categories: groups,
    results,
  });
  assert.equal(
    root.querySelector(".row-name").textContent,
    "Racer 2",
    "Manual automatic-category source retains the latest category after the terminal queue empties",
  );
  send({
    mode: "tcp",
    testFeed: true,
    current: { category: "", finished: true },
    presentation: { mode: "top10", category: "U12 Girls" },
    categories: groups,
    results,
  });
  assert.equal(
    root
      .querySelector(".leaderboard-heading")
      .children.some((node) => node.tagName === "h1"),
    false,
  );
  assert.equal(root.querySelector(".leaderboard-row"), null);
  assert.equal(
    categoryResults({ categories: groups, results }, "U12 Girls").category,
    "U12 Girls",
  );
});

test("top 10 renders own times and zero gap for a tied second row", async (t) => {
  const { root, send } = await overlayHarness(t, "/overlay/top10");
  send({
    mode: "tcp",
    testFeed: true,
    eventName: "Race",
    categories: ["U12"],
    results: [
      {
        bib: "1",
        name: "A",
        category: "U12",
        timeMs: 40000,
        rank: 1,
        gapToLeaderMs: 0,
      },
      {
        bib: "2",
        name: "",
        category: "U12",
        timeMs: 40000,
        rank: 1,
        gapToLeaderMs: 0,
      },
    ],
  });
  const board = root.querySelector(".leaderboard");
  const rows = board.children.filter(
    (child) => child.className === "leaderboard-row",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector(".row-time").textContent, "40.00");
  assert.equal(rows[0].querySelector(".row-gap"), null);
  assert.equal(rows[1].querySelector(".row-gap").textContent, "0.00");
  assert.equal(rows[1].querySelector(".position").textContent, "01");
  assert.equal(rows[1].querySelector(".row-name").textContent, "");
  assert.equal(root.querySelector(".overlay-badge").textContent, "TESTI");
});

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

test("roster file decoding preserves UTF-8 BOM and Windows-1252 accents", () => {
  const text = "Bib.\tName\r\n1\tÄsa Örn Åke €\r\n";
  assert.equal(decodeRosterText(new TextEncoder().encode(text)), text);
  assert.equal(
    decodeRosterText(new TextEncoder().encode("\uFEFF" + text)),
    text,
  );
  assert.equal(
    decodeRosterText(Uint8Array.from([0xc4, 0xf6, 0xe5, 0x20, 0x80])),
    "Äöå €",
  );
  assert.throws(() => decodeRosterText(new Uint8Array(2_000_001)), /2 MB/);
});

test("birth year joins club below the skier name without empty separators", async (t) => {
  const { root, send } = await overlayHarness(
    t,
    "/overlay/current",
    "?birth-year",
  );
  for (const [club, yearOfBirth, expected] of [
    ["Example Club", "2016", "Example Club · 2016"],
    ["", "2016", "2016"],
    ["Example Club", undefined, "Example Club"],
    ["", undefined, null],
  ]) {
    send({
      mode: "tcp",
      current: {
        bib: "001",
        name: "Racer",
        club,
        yearOfBirth,
        running: true,
        timeMs: 1000,
      },
    });
    assert.equal(root.querySelector(".athlete-name").textContent, "Racer");
    assert.equal(
      root.querySelector(".athlete-club")?.textContent ?? null,
      expected,
    );
  }
});

test("bridge standings label total vs single heat and mark retained stale results", async t => {
  const { root, send } = await overlayHarness(t, "/overlay/top10", "?category=U12&scenario=bridge-total");
  const base = { mode: "bridge", categories: ["U12"], results: [], connection: { status: "connected" }, bridgeCompetition: { heats: [1, 2], ranking: "total" } };
  send(base);
  assert.equal(root.querySelector(".leaderboard-kicker").textContent, "YHTEISAJAT");
  assert.match(root.querySelector(".board-footer").textContent, /1 \+ 2 · yhteisajat/);
  send({ ...base, bridgeCompetition: { heats: [2], ranking: "heat" } });
  assert.equal(root.querySelector(".leaderboard-kicker").textContent, "YHDEN LASKUN AJAT");
  assert.match(root.querySelector(".board-footer").textContent, /Laskut 2 · laskuajat/);
  send({ ...base, connection: { status: "stale" } });
  assert.match(root.querySelector(".board-footer").textContent, /viimeksi vastaanotetut tulokset/);
});


test("automatic category standings label the selected category rather than the event's latest heat", async t => {
 const {root,send}=await overlayHarness(t,"/overlay/top10","?category=U12&scenario=category-auto");
 const base={mode:"bridge",categories:["U10","U12"],results:[],connection:{status:"connected"},bridgeCompetition:{heats:[1,2],ranking:"total",categoryStandings:[{category:"U10",heats:[1,2],ranking:"total"},{category:"U12",heats:[1],ranking:"heat"}]}};
 send(base);assert.equal(root.querySelector(".leaderboard-kicker").textContent,"YHDEN LASKUN AJAT");assert.match(root.querySelector(".board-footer").textContent,/Laskut 1 · laskuajat/);
 base.bridgeCompetition.categoryStandings[1]={category:"U12",heats:[1,2],ranking:"total"};send(base);assert.equal(root.querySelector(".leaderboard-kicker").textContent,"YHTEISAJAT");
});
