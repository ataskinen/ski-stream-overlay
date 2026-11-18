import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { SimulatorRace, formatTimingEvent } from "./race.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const csv = await readFile(
  path.join(directory, "../examples/competitors.csv"),
  "utf8",
);
const roster = csv
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [bib, name, category] = line.split(",");
    return { bib, name, category };
  });

export function createSimulator({
  host = process.env.HOST ?? "127.0.0.1",
  tcpPort = Number(process.env.TCP_PORT ?? 5409),
  httpPort = Number(process.env.HTTP_PORT ?? 8790),
  format = process.env.FORMAT ?? "vola",
  tickMs = 100,
} = {}) {
  if (!["vola", "jsonl"].includes(format))
    throw new Error("FORMAT must be vola or jsonl.");
  const clients = new Set();
  const race = new SimulatorRace(roster, (event) => {
    const message = formatTimingEvent(event, format);
    for (const socket of clients) socket.write(message);
  });
  const timing = net.createServer((socket) => {
    clients.add(socket);
    socket.setKeepAlive(true, 10000);
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    // No synthetic start on connect: every client sees the same shared competition.
  });
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const web = http.createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host ?? "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(hostHeader))
        return json(res, 403, { error: "Use the local simulator address." });
      if (req.headers.origin && req.headers.origin !== `http://${hostHeader}`)
        return json(res, 403, {
          error: "Cross-origin controls are not allowed.",
        });
      if (req.method === "GET" && req.url === "/api/state")
        return json(res, 200, {
          ...race.state(),
          format,
          clients: clients.size,
          tcpPort: timing.address()?.port,
        });
      if (req.method === "GET" && req.url === "/competitors.csv") {
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
        res.end(csv);
        return;
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await readFile(path.join(directory, "index.html")));
        return;
      }
      if (req.method === "POST" && req.url === "/api/control") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw new Error("Use JSON controls.");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 2048)
            throw new Error("Control request is too large.");
        }
        const { action, speed } = JSON.parse(body);
        race.control(action, speed);
        if (action === "reset") for (const socket of clients) socket.destroy();
        return json(res, 200, race.state());
      }
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  });
  web.requestTimeout = 5000;
  web.headersTimeout = 5000;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    race.tick(now - previous);
    previous = now;
  }, tickMs);
  timer.unref();
  return {
    race,
    timing,
    web,
    async listen() {
      await new Promise((resolve, reject) => {
        timing.once("error", reject);
        timing.listen(tcpPort, host, resolve);
      });
      try {
        await new Promise((resolve, reject) => {
          web.once("error", reject);
          web.listen(httpPort, host, resolve);
        });
      } catch (error) {
        timing.close();
        throw error;
      }
      return this;
    },
    async close() {
      clearInterval(timer);
      for (const socket of clients) socket.destroy();
      await Promise.all([
        new Promise((resolve) => timing.close(resolve)),
        new Promise((resolve) => web.close(resolve)),
      ]);
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const simulator = await createSimulator().listen();
  console.log(
    `TEST timing simulator: http://127.0.0.1:${simulator.web.address().port} — ${process.env.FORMAT ?? "vola"} TCP:${simulator.timing.address().port}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await simulator.close();
      process.exit(0);
    });
}
