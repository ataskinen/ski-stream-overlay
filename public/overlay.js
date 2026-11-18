import { connectState, element, feedLabel, formatTime } from "./shared.js";

const root = document.getElementById("overlay-root");
const isTop = location.pathname.endsWith("/top10");
const requestedCategory = new URLSearchParams(location.search).get("category");
let state;
let receivedAt = 0;
let serviceConnected = false;
let frozenTime = null;
let timeNode;

function currentTime() {
  const current = state?.current;
  if (!current) return 0;
  if (!serviceConnected || current.stale || !current.running)
    return frozenTime ?? current.timeMs;
  // The interpolation is a visual estimate, never a finish result.
  const serverAge = Math.max(
    0,
    (state.serverNow || Date.now()) -
      (current.updatedAt || state.serverNow || Date.now()),
  );
  return (
    current.timeMs + serverAge + Math.max(0, performance.now() - receivedAt)
  );
}
function badge() {
  const label = feedLabel(state);
  return element(
    "span",
    label === "SKI RACE" ? "overlay-badge" : "overlay-badge demo",
    label,
  );
}
function render(next) {
  state = next;
  receivedAt = performance.now();
  serviceConnected = true;
  frozenTime = null;
  root.replaceChildren();
  timeNode = null;
  const demo = state.mode === "demo";
  if (isTop) {
    const category = requestedCategory || state.categories?.[0];
    const rows = (state.results || [])
      .filter((row) => row.category === category)
      .sort((a, b) => a.timeMs - b.timeMs)
      .slice(0, 10);
    const board = element("section", "leaderboard");
    const head = element("header", "leaderboard-heading");
    head.append(
      badge(),
      element("span", "leaderboard-kicker", "YHDEN LASKUN AJAT"),
      element("h1", "", category || "Sarja puuttuu"),
    );
    board.append(head);
    if (!rows.length)
      board.append(
        element("p", "leaderboard-empty", "Odotetaan sarjan tuloksia"),
      );
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const line = element("div", "leaderboard-row");
      line.append(
        element("span", "position", String(row.rank || i + 1).padStart(2, "0")),
        element("span", "row-bib", `#${row.bib}`),
        element("span", "row-name", row.name || `Kilpailija ${row.bib}`),
        element("span", "row-time", formatTime(row.timeMs)),
      );
      board.append(line);
    }
    board.append(
      element(
        "div",
        "board-footer",
        "Viimeisin maalintulo / kilpailija · ei yhteisaikoja",
      ),
    );
    root.append(board);
    return;
  }
  const current = state.current;
  if (!current) {
    if (demo || state.testFeed)
      root.append(
        element(
          "div",
          "waiting-demo",
          `${feedLabel(state)} · Odotetaan laskijaa`,
        ),
      );
    return;
  }
  const stale =
    current.stale ||
    state.connection?.status === "disconnected" ||
    state.connection?.status === "error";
  const bar = element("section", `lower-third${stale ? " stale" : ""}`);
  const bib = element("div", "bib-block");
  bib.append(
    element("span", "bib-label", "NUMERO"),
    element("strong", "", String(current.bib)),
  );
  const athlete = element("div", "athlete-block");
  athlete.append(
    badge(),
    element("div", "athlete-name", current.name || `Kilpailija ${current.bib}`),
    element("div", "athlete-category", current.category || "Sarja puuttuu"),
  );
  const clock = element("div", "clock-block");
  clock.append(
    element(
      "span",
      "clock-label",
      stale
        ? "YHTEYS KATKENNUT"
        : current.running
          ? "RADALLA · ARVIOITU AIKA"
          : "MAALIAIKA",
    ),
  );
  timeNode = element("strong", "clock-time", formatTime(currentTime()));
  clock.append(timeNode);
  bar.append(bib, athlete, clock);
  root.append(bar);
}
connectState(render, () => {
  if (serviceConnected) frozenTime = currentTime();
  serviceConnected = false;
  const bar = root.querySelector(".lower-third");
  if (bar) {
    bar.classList.add("stale");
    root.querySelector(".clock-label").textContent = "YHTEYS KATKENNUT";
  }
  const footer = root.querySelector(".board-footer");
  if (footer)
    footer.textContent =
      "Yhteys ohjauspalveluun katkesi · viimeksi vastaanotetut tulokset";
});
function frame() {
  if (
    timeNode &&
    state?.current?.running &&
    !state.current.stale &&
    serviceConnected
  )
    timeNode.textContent = formatTime(currentTime());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
