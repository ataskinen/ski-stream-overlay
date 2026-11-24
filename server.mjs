import { syncBridgeRace } from "./lib/bridge-race.mjs";
import { connectBridge } from "./lib/bridge.mjs";
import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Race, presentationDefaults } from "./lib/race.mjs";
import { defaultVolaStatusMap } from "./lib/protocol.mjs";
import { parseRoster, rosterCsv } from "./lib/roster.mjs";
import { connectFeed, readRosterUrl } from "./lib/feed.mjs";
import { attachParentControl } from "./lib/parent-control.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
export const defaultConfig = {
  mode: "demo",
  bridgeKey: "",
  protocol: "jsonl",
  host: "127.0.0.1",
  port: 5409,
  url: "",
  pollIntervalMs: 500,
  rosterUrl: "",
  testFeed: false,
  eventName: "",
  discipline: "Other",
  ...presentationDefaults,
  volaStatusMap: defaultVolaStatusMap,
};
function configFor(input) {
  const c = { ...defaultConfig, ...input };
  if (!["GS", "SL", "TAITO", "SG", "SUP", "DH", "Other"].includes(c.discipline))
    throw new Error("Discipline must be GS, SL, TAITO, SG, SUP, DH or Other.");
  for (const [key, min, max] of [
    ["finishHoldMs", 500, 30000],
    ["idleRotationMs", 10000, 3600000],
    ["categoryRotationMs", 1000, 60000],
  ]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  if (
    !c.volaStatusMap ||
    typeof c.volaStatusMap !== "object" ||
    Array.isArray(c.volaStatusMap)
  )
    throw new Error("VOLA status mapping must be a JSON object.");
  const mappings = Object.entries(c.volaStatusMap);
  if (
    !mappings.length ||
    mappings.length > 32 ||
    mappings.some(
      ([key, value]) =>
        !/^(0|[1-9]\d{0,2})$/.test(key) ||
        !["start", "finish", "dnf", "dsq"].includes(value),
    ) ||
    !mappings.some(([, value]) => value === "start") ||
    !mappings.some(([, value]) => value === "finish")
  )
    throw new Error(
      "VOLA mapping needs start and finish entries; use up to 32 numeric codes (0–999) mapped to start, finish, dnf or dsq.",
    );
  c.volaStatusMap = Object.fromEntries(mappings);
  if (typeof c.eventName !== "string" || /[\x00-\x1f\x7f]/.test(c.eventName))
    throw new Error(
      "Event name must be text up to 120 characters without control characters.",
    );
  c.eventName = c.eventName.trim();
  if (c.eventName.length > 120)
    throw new Error(
      "Event name must be text up to 120 characters without control characters.",
    );
  if (typeof c.testFeed !== "boolean")
    throw new Error("Test feed must be true or false.");
  if (
    !["demo", "tcp", "http-json", "bridge"].includes(c.mode) ||
    !["jsonl", "vola"].includes(c.protocol)
  )
    throw new Error("Choose a supported mode and protocol.");
  if (
    typeof c.host !== "string" ||
    !c.host.trim() ||
    c.host.length > 253 ||
    /[\s/:]/.test(c.host)
  )
    throw new Error(
      "Enter a hostname or IPv4 address without a scheme or port.",
    );
  if (typeof c.bridgeKey !== "string" || c.bridgeKey.length > 512 || /[\s\x00-\x1f]/.test(c.bridgeKey) || (c.mode === "bridge" && c.bridgeKey.length < 24))
    throw new Error("Enter the bridge connection key (at least 24 characters).");
  c.port = Number(c.port);
  c.pollIntervalMs = Number(c.pollIntervalMs);
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw new Error("Port must be between 1 and 65535.");
  if (
    !Number.isInteger(c.pollIntervalMs) ||
    c.pollIntervalMs < 250 ||
    c.pollIntervalMs > 60000
  )
    throw new Error("Polling interval must be 250–60000 ms.");
  for (const key of ["url", "rosterUrl"]) {
    if (typeof c[key] !== "string" || c[key].length > 2048)
      throw new Error("Invalid URL.");
    if (c[key]) {
      const u = new URL(c[key]);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw new Error("Use HTTP(S) URLs without embedded credentials.");
    }
  }
  if (c.mode === "http-json" && !c.url)
    throw new Error("HTTP mode needs a feed URL.");
  return Object.fromEntries(Object.keys(defaultConfig).map((k) => [k, c[k]]));
}

export async function createApp({
  dataDir = process.env.DATA_DIR ?? path.join(root, "data"),
  publicDir = path.join(root, "public"),
  saveState = async (data) => {
    const tmp = path.join(dataDir, "state.tmp");
    await writeFile(tmp, data);
    await rename(tmp, path.join(dataDir, "state.json"));
  },
  downloadRoster = readRosterUrl,
  feedConnector = connectFeed,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  let saved = {};
  try {
    saved = JSON.parse(
      await readFile(path.join(dataDir, "state.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Saved state is invalid; restore or rename data/state.json.",
      );
  }
  let config = configFor(saved.config ?? {}),
    roster = saved.roster ?? [],
    live = new Race(saved.race),
    testRace = new Race(saved.testRace),
    testRoster = saved.testRoster ?? [],
    demo = new Race();
  const demoRoster = parseRoster(
    await readFile(path.join(root, "examples/competitors.csv"), "utf8"),
  );
  let connection = {
      status: "idle",
      message: "Demo ready",
      lastReceivedAt: null,
    },
    stopFeed = () => {},
    feedGeneration = 0,
    demoTimer,
    demoStep = 0;
  let bridgeCompetition = null;
  const clients = new Set();
  let writeQueue = Promise.resolve();
  function persist() {
    const data = JSON.stringify(
      {
        config,
        roster,
        race: live.save(),
        testRoster,
        testRace: testRace.save(),
      },
      null,
      2,
    );
    writeQueue = writeQueue.catch(() => {}).then(() => saveState(data));
    return writeQueue;
  }
  function state() {
    const activeRoster =
      config.mode === "demo"
        ? demoRoster
        : config.testFeed
          ? testRoster
          : roster;
    return {
      mode: config.mode,
      eventName: bridgeCompetition?.name ?? config.eventName,
      bridgeCompetition,
      discipline: config.discipline,
      presentationSettings: Object.fromEntries(
        Object.keys(presentationDefaults).map((key) => [key, config[key]]),
      ),
      testFeed: config.mode === "demo" || config.testFeed,
      rosterTarget: config.testFeed ? "test" : "live",
      connection,
      roster: activeRoster,
      liveRoster: config.testFeed ? testRoster : roster,
      ...(config.mode === "demo"
        ? demo
        : config.testFeed
          ? testRace
          : live
      ).view(activeRoster, Date.now(), config),
      serverNow: Date.now(),
    };
  }
  function broadcast() {
    const payload = `data: ${JSON.stringify(state())}\n\n`;
    for (const client of clients) client.write(payload);
  }
  function stopActiveFeed() {
    feedGeneration++;
    stopFeed();
    stopFeed = () => {};
    clearInterval(demoTimer);
    demoTimer = undefined;
  }
  function setupFeed(nextConfig = config) {
    stopActiveFeed();
    config = nextConfig;
    bridgeCompetition = null;
    const generation = feedGeneration;
    const destination = config.testFeed ? testRace : live;
    live.stale();
    testRace.stale();
    if (config.mode === "bridge") {
      destination.results.clear();
      destination.active.clear();
      destination.terminalQueue = [];
      destination.lastTerminal = null;
      if (config.testFeed) testRoster = [];
      else roster = [];
    }
    connection = {
      status: "idle",
      message:
        config.mode === "demo"
          ? "Demo ready — press Next racer or Start demo"
          : "Feed stopped",
      lastReceivedAt: null,
    };
    if (config.mode !== "demo")
      stopFeed = (config.mode === "bridge" ? connectBridge : feedConnector)(
        config,
        (event) => {
          if (generation !== feedGeneration) return;
          if (event.type === "bridge-state") {
            bridgeCompetition = event.state.competition;
            const people = Object.values(event.state.competitors);
            if (config.testFeed) testRoster = people;
            else roster = people;
            syncBridgeRace(destination, event, config);
          } else destination.apply(event, Date.now(), config);
          connection.lastReceivedAt = Date.now();
          if (!event.heartbeat) persist().catch(() => {
            if (generation !== feedGeneration) return;
            connection.status = "error";
            connection.message = "Could not save results";
            broadcast();
          });
          broadcast();
        },
        (status, message) => {
          if (generation !== feedGeneration) return;
          connection = { ...connection, status, message };
          if (["disconnected", "error", "stale"].includes(status))
            destination.stale();
          broadcast();
        },
      );
    broadcast();
  }
  function nextDemo() {
    const bib = demoRoster[demoStep++ % demoRoster.length].bib;
    demo.apply(
      {
        type: "finish",
        bib,
        timeMs: bib === "001" ? 30000 : 31000 + Number(bib) * 1300,
      },
      Date.now(),
      config,
    );
    connection = {
      status: "demo",
      message: "Simulated data — not live race results",
      lastReceivedAt: Date.now(),
    };
    broadcast();
  }
  function startDemo() {
    clearInterval(demoTimer);
    let tick = 0,
      bib;
    demoTimer = setInterval(() => {
      if (tick === 0) {
        bib = demoRoster[demoStep++ % demoRoster.length].bib;
        demo.apply({ type: "start", bib }, Date.now(), config);
      } else if (tick < 10)
        demo.apply(
          { type: "time", bib, timeMs: tick * 1000 },
          Date.now(),
          config,
        );
      else
        demo.apply(
          {
            type: "finish",
            bib,
            timeMs: bib === "001" ? 30000 : 31000 + Number(bib) * 1300,
          },
          Date.now(),
          config,
        );
      tick = (tick + 1) % 13;
      connection = {
        status: "demo",
        message: "Simulated data — not live race results",
        lastReceivedAt: Date.now(),
      };
      broadcast();
    }, 1000);
  }
  function json(response, status, body) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(body));
  }
  async function body(request) {
    if (!request.headers["content-type"]?.startsWith("application/json"))
      throw new Error("Use Content-Type: application/json.");
    let text = "";
    for await (const chunk of request) {
      text += chunk;
      if (Buffer.byteLength(text) > 2_100_000)
        throw new Error("Request is too large.");
    }
    return JSON.parse(text || "{}");
  }
  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
        return json(response, 403, {
          error: "Only localhost requests are allowed.",
        });
      if (
        request.headers.origin &&
        ![`http://${host}`, `https://${host}`].includes(request.headers.origin)
      )
        return json(response, 403, {
          error: "Cross-origin requests are not allowed.",
        });
      const url = new URL(request.url, `http://${host}`),
        route = url.pathname;
      if (request.method === "GET" && route === "/api/health")
        return json(response, 200, {
          app: "ski-stream-overlay",
          version: "0.1.0",
        });
      if (request.method === "GET" && route === "/api/state")
        return json(response, 200, state());
      if (request.method === "GET" && route === "/api/config")
        return json(response, 200, config);
      if (request.method === "GET" && route === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.write(`data: ${JSON.stringify(state())}\n\n`);
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "GET" && route === "/api/roster.csv") {
        response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
        response.end(rosterCsv(config.testFeed ? testRoster : roster));
        return;
      }
      if (request.method === "PUT" && route === "/api/config") {
        const input = await body(request);
        const next = configFor({ ...config, ...input });
        const feedSettings = [
          "mode",
          "bridgeKey",
          "protocol",
          "host",
          "port",
          "url",
          "pollIntervalMs",
          "testFeed",
          "volaStatusMap",
        ];
        if (
          feedSettings.some((key) =>
            key === "volaStatusMap"
              ? JSON.stringify(next[key]) !== JSON.stringify(config[key])
              : next[key] !== config[key],
          )
        )
          setupFeed(next);
        else {
          config = next;
          broadcast();
        }
        await persist();
        return json(response, 200, next);
      }
      if (request.method === "POST" && ["/api/roster", "/api/roster/fetch"].includes(route) && config.mode === "bridge")
        throw new Error("The bridge provides the competitor list. Edit it in VOLA.");
      if (request.method === "POST" && route === "/api/roster") {
        const generation = feedGeneration;
        const destinationIsTest = config.testFeed;
        const input = await body(request);
        const next = parseRoster(input.csv);
        if (generation !== feedGeneration)
          throw new Error(
            "Feed settings changed during roster import. Please retry.",
          );
        if (destinationIsTest) testRoster = next;
        else roster = next;
        await persist();
        broadcast();
        return json(response, 200, { count: next.length });
      }
      if (request.method === "POST" && route === "/api/roster/fetch") {
        const generation = feedGeneration;
        const destinationIsTest = config.testFeed;
        const configuredUrl = config.rosterUrl;
        const input = await body(request);
        const source = input.url || configuredUrl;
        const next = parseRoster(await downloadRoster(source));
        if (generation !== feedGeneration)
          throw new Error(
            "Feed settings changed during roster download. Please retry.",
          );
        if (destinationIsTest) testRoster = next;
        else roster = next;
        config.rosterUrl = source;
        await persist();
        broadcast();
        return json(response, 200, { count: next.length });
      }
      if (request.method === "POST" && route === "/api/demo") {
        const input = await body(request);
        if (config.mode !== "demo")
          throw new Error("Switch to Demo mode first.");
        if (!["start", "stop", "next", "reset"].includes(input.action))
          throw new Error("Unknown demo action.");
        if (input.action === "start") startDemo();
        if (input.action === "stop") {
          clearInterval(demoTimer);
          demo.stale();
          connection.status = "idle";
          connection.message = "Demo paused";
        }
        if (input.action === "next") {
          clearInterval(demoTimer);
          nextDemo();
        }
        if (input.action === "reset") {
          clearInterval(demoTimer);
          demo = new Race();
          demoStep = 0;
          connection.status = "idle";
          connection.message = "Demo reset";
        }
        broadcast();
        return json(response, 200, state());
      }
      if (request.method === "POST" && route === "/api/reset") {
        const generation = feedGeneration;
        await body(request);
        if (generation !== feedGeneration)
          throw new Error("Feed settings changed before reset. Please retry.");
        if (config.testFeed) testRace = new Race();
        else live = new Race();
        setupFeed();
        await persist();
        return json(response, 200, state());
      }
      if (route.startsWith("/api/"))
        return json(response, 404, { error: "API route not found." });
      if (request.method !== "GET")
        return json(response, 405, { error: "Method not allowed." });
      const mappedRoute = [
        "/overlay/current",
        "/overlay/top10",
        "/overlay/auto",
      ].includes(route)
        ? "/overlay.html"
        : route;
      const file = path.resolve(
        publicDir,
        "." +
          (mappedRoute === "/"
            ? "/index.html"
            : decodeURIComponent(mappedRoute)),
      );
      if (!file.startsWith(path.resolve(publicDir) + path.sep))
        return json(response, 403, { error: "Invalid path." });
      const contents = await readFile(file);
      const mime =
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        }[path.extname(file)] ?? "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(contents);
    } catch (error) {
      json(response, error.code === "ENOENT" ? 404 : 400, {
        error: error.message,
      });
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  let presentationKey = "";
  const presentationTimer = setInterval(() => {
    const race =
      config.mode === "demo" ? demo : config.testFeed ? testRace : live;
    const now = Date.now();
    race.advance(now, config);
    const idleStep =
      !race.active.size &&
      !race.terminalQueue.length &&
      now - race.lastStartAt >= config.idleRotationMs
        ? Math.floor(
            (now - race.lastStartAt - config.idleRotationMs) /
              config.categoryRotationMs,
          )
        : -1;
    const key = JSON.stringify([
      config.mode,
      config.testFeed,
      [...race.active.keys()],
      race.terminalQueue.map((entry) => [entry.racer.bib, entry.racer.status]),
      idleStep,
    ]);
    if (key !== presentationKey) {
      presentationKey = key;
      broadcast();
    }
  }, 100);
  presentationTimer.unref();
  setupFeed();
  return {
    server,
    state,
    close: async () => {
      stopActiveFeed();
      clearInterval(demoTimer);
      clearInterval(heartbeat);
      clearInterval(presentationTimer);
      for (const client of clients) client.end();
      await writeQueue;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 8787);
  app.server.listen(port, "127.0.0.1", () =>
    console.log(`Ski Stream Overlay: http://127.0.0.1:${port}`),
  );
  let shuttingDown;
  const shutdown = () =>
    (shuttingDown ??= (async () => {
      await app.close();
      process.exit(0);
    })());
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
  if (process.env.SKI_PARENT_CONTROL === "1")
    attachParentControl(process.stdin, shutdown);
}
