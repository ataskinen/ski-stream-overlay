import {
  categoryResults,
  connectState,
  element,
  feedLabel,
  finishSummary,
  formatGap,
  formatTime,
  estimatedTime,
  overlaySelection,
  disciplineLabel,
} from "./shared.js";

const root = document.getElementById("overlay-root");
const isTop = location.pathname.endsWith("/top10");
const isAutomatic = location.pathname.endsWith("/auto");
const requestedCategory = new URLSearchParams(location.search).get("category");
let state;
let receivedAt = 0;
let serviceConnected = false;
let clocks = [];

function raceClock(racer, className = "clock-time", field = "timeMs") {
  const clockRacer = field === "timeMs" ? racer : { ...racer, timeMs: racer[field] };
  const node = element(
    "strong",
    className,
    clockRacer.status === "running" && !Number.isFinite(clockRacer.timeMs) && !(field === "timeMs" && racer.totalEligible === false)
      ? "RADALLA"
      : formatTime(
          estimatedTime(
            clockRacer,
            state.serverNow,
            receivedAt,
            performance.now(),
            serviceConnected,
          ),
        ),
  );
  clocks.push({ node, racer: clockRacer });
  return node;
}
function badge() {
  const label = feedLabel(state);
  return element(
    "span",
    label === "SKI RACE" ? "overlay-badge" : "overlay-badge demo",
    label,
  );
}
function disciplineBadge() {
  const label = disciplineLabel(state.discipline);
  return label ? element("span", "discipline-badge", label) : null;
}
function render(next) {
  state = next;
  receivedAt = performance.now();
  serviceConnected = true;
  root.replaceChildren();
  clocks = [];
  const selected = overlaySelection(state, isAutomatic);
  const demo = state.mode === "demo";
  if (isTop || selected.mode === "top10") {
    const selectedCategory = isTop ? requestedCategory : selected.category;
    const { category, rows } =
      selectedCategory || isTop
        ? categoryResults(state, selectedCategory)
        : { category: "", rows: [] };
    const standings = state.bridgeCompetition?.categoryStandings?.find(s => s.category === category) || state.bridgeCompetition;
    const board = element("section", "leaderboard");
    const head = element("header", "leaderboard-heading");
    const metadata = element("div", "board-metadata");
    const discipline = disciplineBadge();
    if (discipline) metadata.append(discipline);
    metadata.append(
      badge(),
      element("span", "leaderboard-kicker", standings?.ranking === "total" ? "YHTEISAJAT" : "YHDEN LASKUN AJAT"),
    );
    head.append(metadata);
    if (state.eventName)
      head.append(element("div", "board-event-name", state.eventName));
    if (category) head.append(element("h1", "", category));
    board.append(head);
    if (!rows.length)
      board.append(
        element(
          "p",
          "leaderboard-empty",
          category
            ? "Odotetaan sarjan tuloksia"
            : "Valitse sarja kilpailijalistasta",
        ),
      );
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const line = element("div", "leaderboard-row");
      line.append(
        element(
          "span",
          "position",
          Number.isFinite(row.rank) ? String(row.rank).padStart(2, "0") : "",
        ),
        element("span", "row-bib", `#${row.bib}`),
        element("span", "row-name", row.name || ""),
      );
      const times = element("span", "row-timing");
      times.append(element("span", "row-time", formatTime(row.timeMs)));
      if (i > 0 && Number.isFinite(row.gapToLeaderMs))
        times.append(element("span", "row-gap", formatGap(row.gapToLeaderMs)));
      line.append(times);
      board.append(line);
    }
    board.append(
      element(
        "div",
        "board-footer",
        ["stale", "disconnected", "error", "connecting"].includes(state.connection?.status)
          ? "Yhteys katkennut · viimeksi vastaanotetut tulokset"
          : state.bridgeCompetition
            ? `VOLA · Laskut ${standings.heats.join(" + ")} · ${standings.ranking === "total" ? "yhteisajat" : "laskuajat"}`
            : "Viimeisin maalintulo / kilpailija · ei yhteisaikoja",
      ),
    );
    root.append(board);
    return;
  }
  const current = selected.current;
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
  const terminalStatus = String(current.status || "").toLowerCase();
  const isUnfinishedTerminal =
    terminalStatus === "dnf" || terminalStatus === "dsq";
  const bar = element("section", `lower-third${stale ? " stale" : ""}`);
  if (selected.others.length) {
    const stack = element("div", "racer-stack");
    for (const racer of selected.others) {
      const line = element(
        "div",
        `compact-racer${racer.stale ? " stale" : ""}`,
      );
      line.append(
        element("span", "compact-bib", `#${racer.bib}`),
        element("span", "compact-name", racer.name || ""),
        raceClock(racer, "compact-time"),
      );
      stack.append(line);
    }
    bar.append(stack);
  }
  if (
    state.eventName ||
    demo ||
    state.testFeed ||
    disciplineLabel(state.discipline)
  ) {
    const context = element("div", "broadcast-context");
    if (state.eventName)
      context.append(element("span", "event-name", state.eventName));
    const markers = element("div", "context-markers");
    const discipline = disciplineBadge();
    if (discipline) markers.append(discipline);
    if (demo || state.testFeed) markers.append(badge());
    if (markers.children.length) context.append(markers);
    bar.append(context);
  }
  const bib = element("div", "bib-block");
  bib.append(
    element("span", "bib-label", "NUMERO"),
    element("strong", "", String(current.bib)),
  );
  const athlete = element("div", "athlete-block");
  if (current.category)
    athlete.append(element("span", "category-badge", current.category));
  if (current.name)
    athlete.append(element("div", "athlete-name", current.name));
  const details = [current.club, current.yearOfBirth]
    .filter(Boolean)
    .join(" · ");
  if (details) athlete.append(element("div", "athlete-club", details));
  const clock = element("div", "clock-block");
  const separateRun = current.heat > 1 && Object.hasOwn(current, "runTimeMs");
  clock.append(
    element(
      "span",
      "clock-label",
      stale
        ? "YHTEYS KATKENNUT"
        : current.running
          ? separateRun
            ? Number.isFinite(current.timeMs) ? "YHTEISAIKA · ARVIO" : "YHTEISAIKA"
            : Number.isFinite(current.timeMs)
              ? "RADALLA · ARVIOITU AIKA"
              : "RADALLA"
          : terminalStatus === "dnf"
            ? "KESKEYTTI"
            : terminalStatus === "dsq"
              ? "HYLÄTTY"
              : separateRun ? "YHTEISAIKA" : "MAALIAIKA",
    ),
  );
  const timeRow = element("div", "clock-time-row");
  const summary = finishSummary(current);
  if (summary) {
    const rank = element("div", "finish-rank");
    rank.append(
      element("span", "rank-label", "SIJA"),
      element("strong", "", summary.rank),
    );
    timeRow.append(rank);
  }
  timeRow.append(
    isUnfinishedTerminal
      ? element(
          "strong",
          "clock-time terminal-status",
          terminalStatus.toUpperCase(),
        )
      : raceClock(current),
  );
  clock.append(timeRow);
  const gapSlot = element("div", "clock-gap-slot");
  if (separateRun) {
    const run = element("div", "run-time-row");
    run.append(element("span", "run-time-label", `LASKU ${current.heat}`), raceClock(current, "run-time", "runTimeMs"));
    gapSlot.append(run);
  }
  if (summary?.gap)
    gapSlot.append(element("span", `finish-gap ${summary.tone}`, summary.gap));
  clock.append(gapSlot);
  bar.append(bib, athlete, clock);
  root.append(bar);
}
connectState(render, () => {
  // Leave all displayed clocks at their last rendered value until a fresh snapshot.
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
  if (serviceConnected)
    for (const { node, racer } of clocks) {
      if (racer.running && !racer.stale && Number.isFinite(racer.timeMs))
        node.textContent = formatTime(
          estimatedTime(racer, state.serverNow, receivedAt, performance.now()),
        );
    }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
