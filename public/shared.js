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
