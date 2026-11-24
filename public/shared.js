export function decodeRosterText(bytes) {
  if (bytes.byteLength > 2_000_000)
    throw new Error("Competitor file must be smaller than 2 MB.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Some Node builds decode the C1 range as Latin-1; normalize it to Windows-1252.
    const c1 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
    return new TextDecoder("windows-1252")
      .decode(bytes)
      .replace(
        /[\u0080-\u009f]/g,
        (character) => c1[character.charCodeAt(0) - 0x80],
      );
  }
}

export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  const hundredths = Math.floor(value / 10);
  const seconds = Math.floor(hundredths / 100);
  const fraction = String(hundredths % 100).padStart(2, "0");
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${fraction}`
    : `${seconds}.${fraction}`;
}
export function feedLabel(state) {
  if (state.mode === "demo") return "DEMO";
  return state.testFeed ? "TESTI" : "SKI RACE";
}
export const DISCIPLINES = ["GS", "SL", "TAITO", "SG", "SUP", "DH", "Other"];
export function disciplineLabel(discipline) {
  return DISCIPLINES.includes(discipline) && discipline !== "Other"
    ? discipline
    : "";
}
export function formatGap(value) {
  if (!Number.isFinite(value)) return "";
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  return `${sign}${formatTime(Math.abs(value))}`;
}
export function finishSummary(current) {
  if (
    !current?.finished ||
    ["dnf", "dsq"].includes(String(current.status || "").toLowerCase()) ||
    current.running ||
    !current.category ||
    !Number.isFinite(current.rank)
  )
    return null;
  const delta = current.leadDeltaMs;
  const comparison = Number.isFinite(delta) ? delta : current.gapToLeaderMs;
  return {
    rank: String(current.rank),
    gap: Number.isFinite(delta)
      ? formatGap(delta)
      : current.isLeader
        ? "JOHDOSSA"
        : formatGap(current.gapToLeaderMs),
    tone:
      Number.isFinite(comparison) && comparison < 0
        ? "ahead"
        : Number.isFinite(comparison) && comparison > 0
          ? "behind"
          : "level",
  };
}
export function estimatedTime(
  racer,
  serverNow,
  receivedAt,
  now,
  connected = true,
) {
  if (!racer || !Number.isFinite(racer.timeMs)) return null;
  if (!connected || racer.stale || !racer.running) return racer.timeMs;
  const age = Math.max(
    0,
    (serverNow || 0) - (racer.updatedAt || serverNow || 0),
  );
  return racer.timeMs + age + Math.max(0, now - receivedAt);
}
export function overlaySelection(state, automatic = false) {
  const presentation = automatic ? state.presentation : null;
  const current = presentation?.current ?? state.current ?? null;
  const others = presentation?.otherRacers ?? state.activeRacers ?? [];
  return {
    mode: ["top10", "cycle"].includes(presentation?.mode) ? "top10" : "racer",
    current,
    category: presentation?.category || "",
    others: others.filter((racer) => racer.bib !== current?.bib),
  };
}
export function categoryResults(state, requestedCategory) {
  const category =
    requestedCategory === "auto"
      ? state.current
        ? typeof state.current.category === "string" &&
          state.current.category.trim()
          ? state.current.category
          : ""
        : typeof state.presentation?.category === "string" &&
            state.presentation.category.trim()
          ? state.presentation.category
          : ""
      : requestedCategory ||
        (state.categories || []).find(
          (value) => typeof value === "string" && value.trim(),
        );
  return {
    category: category || "",
    rows: category
      ? (state.results || [])
          .filter(
            (row) =>
              row.category === category &&
              (!row.status || row.status === "finish") &&
              Number.isFinite(row.timeMs),
          )
          .sort((a, b) => a.timeMs - b.timeMs)
          .slice(0, 10)
      : [],
  };
}
export function resetContext(state) {
  if (!state || state.mode === "demo")
    return {
      disabled: true,
      label: "Demo nollataan yllä olevasta painikkeesta",
      helper:
        "Demo on käytössä. Nollaa sen tulokset Nollaa demo -painikkeella. Live- ja testitulokset säilyvät.",
    };
  const kind = state.testFeed ? "testi" : "live";
  return {
    disabled: false,
    label: state.testFeed ? "Nollaa testitulokset…" : "Nollaa live-tulokset…",
    helper: state.testFeed
      ? "Nollaa testisyötteen tulokset ennen uutta testikierrosta. Oikean kilpailun live-tulokset säilyvät."
      : "Nollaa live-tulokset ennen uutta kilpailua tai laskukierrosta.",
    confirm: `Nollataanko kaikki ${kind === "live" ? "live-" : "testi"}tulokset ja tämän syötteen radalla olevan laskijan tila? Kilpailijalista säilytetään.`,
    success: state.testFeed
      ? "Testitulokset nollattu."
      : "Live-tulokset nollattu.",
  };
}
export async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error || data.message || `Pyyntö epäonnistui (${response.status}).`,
    );
  return data;
}
export function saveEventName(eventName) {
  const value = eventName.trim();
  if (value.length > 120)
    throw new Error("Kilpailun nimi saa olla enintään 120 merkkiä.");
  return request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ eventName: value }),
  });
}
export function saveDiscipline(discipline) {
  if (!DISCIPLINES.includes(discipline))
    throw new Error("Valitse laji luettelosta.");
  return request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ discipline }),
  });
}
export function savePresentationSettings(settings) {
  const fields = {
    finishHoldMs: [500, 30000],
    idleRotationMs: [10000, 3600000],
    categoryRotationMs: [1000, 60000],
  };
  const values = {};
  for (const [key, [minimum, maximum]] of Object.entries(fields)) {
    const value = settings[key];
    if (!Number.isFinite(value) || value < minimum || value > maximum)
      throw new Error("Tarkista näytön vaihtumisen ajat ja sallitut rajat.");
    values[key] = Math.round(value);
  }
  return request("/api/config", {
    method: "PUT",
    body: JSON.stringify(values),
  });
}
export function saveConnectionConfig(config) {
  const fields = [
    "mode",
    "protocol",
    "host",
    "port",
    "url",
    "pollIntervalMs",
    "rosterUrl",
    "testFeed",
    "volaStatusMap",
    "bridgeKey",
  ];
  const connection = Object.fromEntries(
    fields
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
  return request("/api/config", {
    method: "PUT",
    body: JSON.stringify(connection),
  });
}
export function connectState(onState, onDisconnect) {
  let closed = false;
  // SSE includes the initial snapshot, keeping every update in one ordered stream.
  const events = new EventSource("/api/events");
  const accept = (event) => {
    if (closed) return;
    try {
      onState(JSON.parse(event.data));
    } catch {
      onDisconnect?.();
    }
  };
  events.addEventListener("state", accept);
  events.onmessage = accept;
  events.onerror = () => {
    if (!closed) onDisconnect?.();
  };
  return () => {
    closed = true;
    events.close();
  };
}
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
