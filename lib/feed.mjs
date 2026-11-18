import net from "node:net";
import { createLineDecoder, createVolaParser } from "./protocol.mjs";
import { validateEvent } from "./race.mjs";

export async function readUrl(url, maxBytes = 2_000_000) {
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Use an HTTP(S) URL without embedded credentials.");
  const response = await fetch(parsed, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok)
    throw new Error(`Remote server returned HTTP ${response.status}.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Remote response is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function connectFeed(config, onEvent, onStatus) {
  let stopped = false,
    timer,
    socket,
    failures = 0,
    lastBody;
  const status = (state, message) => {
    if (!stopped) onStatus(state, message);
  };
  const schedule = (fn) => {
    if (!stopped)
      timer = setTimeout(
        fn,
        Math.min(15000, 1000 * 2 ** Math.min(failures++, 4)),
      );
  };
  const accept = (event) => {
    const valid = validateEvent(event);
    onEvent(valid);
    status("connected", "Receiving timing data");
  };
  async function poll() {
    try {
      const text = await readUrl(config.url);
      const body = JSON.parse(text);
      if (stopped) return;
      const events = Array.isArray(body) ? body : (body.events ?? [body]);
      if (!Array.isArray(events) || events.length > 10000)
        throw new Error("Expected an event or event array.");
      const validated = events.map(validateEvent);
      if (lastBody !== text) {
        validated.forEach(accept);
        lastBody = text;
      }
      failures = 0;
      status("connected", "HTTP feed connected");
      timer = setTimeout(poll, config.pollIntervalMs);
    } catch {
      if (!stopped) {
        status("disconnected", "HTTP feed unavailable or invalid; retrying");
        schedule(poll);
      }
    }
  }
  function tcp() {
    status("connecting", "Connecting to timing feed");
    const parse =
      config.protocol === "vola"
        ? createVolaParser(accept, config.volaStatusMap)
        : (line) => accept(JSON.parse(line));
    const decode = createLineDecoder(parse);
    socket = net.createConnection({ host: config.host, port: config.port });
    socket.setEncoding("utf8");
    // VOLA and JSONL may send only a start and a finish, with no packets during a run.
    // Keep the TCP connection alive without interpreting event silence as a failure.
    socket.setKeepAlive(true, 10000);
    socket.on("connect", () => {
      failures = 0;
      status("connected", "TCP feed connected; waiting for events");
    });
    socket.on("data", (chunk) => {
      try {
        decode(chunk);
      } catch {
        status("error", "Invalid timing message received");
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (!stopped) {
        status("disconnected", "TCP feed disconnected; retrying");
        schedule(tcp);
      }
    });
  }
  if (config.mode === "tcp") tcp();
  else if (config.mode === "http-json") {
    status("connecting", "Connecting to HTTP timing feed");
    poll();
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.destroy();
  };
}
