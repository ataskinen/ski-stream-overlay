import {
  connectState,
  decodeRosterText,
  element,
  feedLabel,
  formatTime,
  request,
  resetContext,
  saveEventName,
  saveConnectionConfig,
  savePresentationSettings,
  saveDiscipline,
  saveBroadcastLanguage,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
let toastTimeout;
let activeState;
let eventNameDirty = false;
let eventNameReceived = false;
let broadcastLanguageDirty = false;
let broadcastLanguageReceived = false;
let disciplineDirty = false;
let disciplineReceived = false;
let presentationDirty = false;
let presentationReceived = false;
const presentationInputs = {
  finishHoldMs: "finish-hold",
  idleRotationMs: "idle-rotation",
  categoryRotationMs: "category-rotation",
};
function populatePresentation(settings) {
  if (presentationDirty || !settings) return;
  for (const [key, id] of Object.entries(presentationInputs))
    if (Number.isFinite(settings[key])) $(id).value = settings[key] / 1000;
}
function toast(message, error = false) {
  const node = $("toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    node.hidden = true;
  }, 7000);
}
async function action(task, feedbackId) {
  const feedback = feedbackId && $(feedbackId);
  try {
    if (feedback) feedback.textContent = "Working…";
    await task();
    if (feedback) feedback.textContent = "Saved.";
  } catch (error) {
    if (feedback) feedback.textContent = error.message;
    toast(error.message, true);
  }
}
function updateModeFields() {
  document.querySelectorAll("[data-modes]").forEach((node) => {
    node.hidden = !node.dataset.modes.split(" ").includes($("mode").value);
  });
}
function updateLinks() {
  const category = $("category").value;
  const path = `/overlay/top10${category ? `?category=${encodeURIComponent(category)}` : ""}`;
  $("current-url").value = `${location.origin}/overlay/current`;
  $("auto-url").value = `${location.origin}/overlay/auto`;
  $("top-url").value = `${location.origin}${path}`;
  if ($("top-preview").getAttribute("src") !== path)
    $("top-preview").src = path;
}
function render(state) {
  activeState = state;
  if (typeof state.broadcastLanguage === "string") {
    broadcastLanguageReceived = true;
    if (!broadcastLanguageDirty) $("broadcast-language").value = state.broadcastLanguage;
  }
  if (typeof state.discipline === "string") {
    disciplineReceived = true;
    if (!disciplineDirty) $("discipline").value = state.discipline;
  }
  if (state.presentationSettings) {
    presentationReceived = true;
    populatePresentation(state.presentationSettings);
  }
  if (typeof state.eventName === "string") {
    eventNameReceived = true;
    if (!eventNameDirty) $("event-name").value = state.eventName;
  }
  const reset = resetContext(state);
  $("reset-live").textContent = reset.label;
  $("reset-live").disabled = reset.disabled;
  $("reset-helper").textContent = reset.helper;
  const labels = {
    idle: "Ready",
    connected: "Connected",
    connecting: "Connecting",
    disconnected: "Disconnected",
    error: "Connection error",
    stopped: "Stopped",
    stale: "Data is stale",
    paused: "Demo paused",
    demo: "Demo active",
  };
  $("mode-badge").textContent =
    feedLabel({ ...state, broadcastLanguage: "en" }) === "SKI RACE" ? "TIMING" : feedLabel({ ...state, broadcastLanguage: "en" });
  $("mode-badge").classList.toggle(
    "live",
    state.mode !== "demo" && !state.testFeed,
  );
  $("connection-status").textContent =
    labels[state.connection?.status] ||
    state.connection?.status ||
    "Waiting for data";
  $("connection-message").textContent =
    (state.connection?.message || "") +
    (state.bridgeCompetition?.warnings?.length ? " · " + state.bridgeCompetition.warnings.join(" ") : "");
  const previous = $("category").value;
  const categories = (state.categories || []).filter((category) =>
    category.trim(),
  );
  const existing = Array.from($("category").options)
    .slice(1)
    .map((option) => option.value);
  if (JSON.stringify(existing) !== JSON.stringify(categories)) {
    const blank = element("option", "", "First category");
    blank.value = "";
    $("category").replaceChildren(
      blank,
      ...categories.map((category) => {
        const option = element("option", "", category);
        option.value = category;
        return option;
      }),
    );
    if (categories.includes(previous)) $("category").value = previous;
    updateLinks();
  }
  const roster = state.liveRoster || state.roster || [];
  const rosterKind =
    state.rosterTarget === "test"
      ? "Test roster"
      : state.rosterTarget === "live"
        ? "Live roster"
        : state.mode === "demo"
          ? "Saved imported roster"
          : state.testFeed
            ? "Test roster"
            : "Live roster";
  $("roster-count").textContent =
    `${rosterKind}: ${roster.length} competitors${state.mode === "demo" ? " · overlays use a separate demo roster" : ""}`;
  const results = [...(state.results || [])].sort(
    (a, b) =>
      (a.category || "").localeCompare(b.category || "") ||
      (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity),
  );
  $("results-body").replaceChildren(
    ...results.map((row) => {
      const tr = element("tr");
      for (const value of [
        row.rank || "",
        row.bib,
        row.name || "",
        row.category || "",
        ["dns", "dnf", "dsq"].includes(row.status)
          ? row.status.toUpperCase()
          : formatTime(row.timeMs),
      ])
        tr.append(element("td", "", String(value)));
      return tr;
    }),
  );
  if (!results.length) {
    const tr = element("tr");
    const td = element(
      "td",
      "empty-cell",
      "No results yet. Start the demo or connect timing.",
    );
    td.colSpan = 5;
    tr.append(td);
    $("results-body").append(tr);
  }
}
$("mode").addEventListener("change", updateModeFields);
$("category").addEventListener("change", updateLinks);
$("config-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const config = {
    mode: $("mode").value,
    bridgeKey: $("bridgeKey").value.trim(),
    protocol: $("protocol").value,
    host: $("host").value.trim(),
    port: Number($("port").value),
    url: $("url").value.trim(),
    pollIntervalMs: Number($("pollIntervalMs").value),
    rosterUrl: $("roster-url").value.trim(),
    testFeed: $("test-feed").checked,
  };
  action(async () => {
    try {
      config.volaStatusMap = JSON.parse($("vola-status-map").value);
    } catch {
      throw new Error(
        "VOLA event codes must be a valid JSON object.",
      );
    }
    await saveConnectionConfig(config);
    toast("Timing settings saved.");
  }, "config-feedback");
});
$("presentation-form").addEventListener("input", () => {
  presentationDirty = true;
});
$("presentation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = Object.fromEntries(
    Object.entries(presentationInputs).map(([key, id]) => [
      key,
      Number($(id).value) * 1000,
    ]),
  );
  action(async () => {
    await savePresentationSettings(settings);
    if (
      Object.entries(presentationInputs).every(
        ([key, id]) => Number($(id).value) * 1000 === settings[key],
      )
    )
      presentationDirty = false;
    toast("Automatic display durations saved.");
  }, "presentation-feedback");
});
$("event-name").addEventListener("input", () => {
  eventNameDirty = true;
});
$("discipline").addEventListener("change", () => {
  disciplineDirty = true;
});
$("discipline-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const submitted = $("discipline").value;
  action(async () => {
    await saveDiscipline(submitted);
    if ($("discipline").value === submitted) disciplineDirty = false;
    toast("Discipline saved.");
  }, "discipline-feedback");
});
$("broadcast-language").addEventListener("change", () => {
  broadcastLanguageDirty = true;
});
$("broadcast-language-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const submitted = $("broadcast-language").value;
  action(async () => {
    await saveBroadcastLanguage(submitted);
    if ($("broadcast-language").value === submitted) broadcastLanguageDirty = false;
    toast("Broadcast language saved.");
  }, "broadcast-language-feedback");
});
$("event-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const submitted = $("event-name").value.trim();
  action(async () => {
    await saveEventName(submitted);
    if ($("event-name").value.trim() === submitted) {
      eventNameDirty = false;
      $("event-name").value = submitted;
    }
    toast("Competition name saved.");
  }, "event-feedback");
});
$("simulator-preset").addEventListener("click", () => {
  $("mode").value = "tcp";
  $("protocol").value = "vola";
  $("host").value = "127.0.0.1";
  $("port").value = "5409";
  $("roster-url").value = "http://127.0.0.1:8790/competitors.csv";
  $("test-feed").checked = true;
  updateModeFields();
  $("config-feedback").textContent =
    "Test settings filled in. Click Save and connect, then Fetch roster.";
  toast("Simulator settings filled in. The connection has not changed yet.");
});
$("csv-file").addEventListener("change", () =>
  action(async () => {
    const file = $("csv-file").files[0];
    if (!file) return;
    if (file.size > 2_000_000)
      throw new Error(
        "Roster file is too large (maximum 2 MB).",
      );
    $("csv-text").value = decodeRosterText(await file.arrayBuffer());
    toast("File loaded. Click Import competitors to save the roster.");
  }),
);
$("roster-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    await request("/api/roster", {
      method: "POST",
      body: JSON.stringify({ csv: $("csv-text").value }),
    });
    toast("Roster imported.");
  }, "roster-feedback");
});
$("roster-url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    await request("/api/roster/fetch", {
      method: "POST",
      body: JSON.stringify({ url: $("roster-url").value.trim() }),
    });
    toast("Roster fetched and saved.");
  }, "roster-feedback");
});
document.querySelectorAll("[data-demo]").forEach((button) =>
  button.addEventListener("click", () =>
    action(async () => {
      await request("/api/demo", {
        method: "POST",
        body: JSON.stringify({ action: button.dataset.demo }),
      });
      $("mode").value = "demo";
      updateModeFields();
      toast("Demo updated.");
    }),
  ),
);
document.querySelectorAll("[data-copy]").forEach((button) =>
  button.addEventListener("click", () =>
    action(async () => {
      await navigator.clipboard.writeText($(button.dataset.copy).value);
      toast("URL copied.");
    }),
  ),
);
$("reset-live").addEventListener("click", () => {
  const context = resetContext(activeState);
  if (context.disabled || !confirm(context.confirm)) return;
  action(async () => {
    await request("/api/reset", { method: "POST", body: "{}" });
    toast(context.success);
  });
});
updateModeFields();
updateLinks();
const previews = new ResizeObserver((entries) => {
  for (const entry of entries)
    entry.target.style.setProperty(
      "--preview-scale",
      String(entry.contentRect.width / 1920),
    );
});
document
  .querySelectorAll(".preview-stage")
  .forEach((stage) => previews.observe(stage));
request("/api/config")
  .then((config) => {
    if (!broadcastLanguageDirty && !broadcastLanguageReceived)
      $("broadcast-language").value = config.broadcastLanguage || "fi";
    if (!disciplineDirty && !disciplineReceived)
      $("discipline").value = config.discipline || "Other";
    if (!presentationReceived) populatePresentation(config);
    $("vola-status-map").value = JSON.stringify(
      config.volaStatusMap || { 0: "start", 1: "finish" },
      null,
      2,
    );
    if (!eventNameDirty && !eventNameReceived)
      $("event-name").value = config.eventName || "";
    for (const id of [
      "mode",
      "bridgeKey",
      "protocol",
      "host",
      "port",
      "url",
      "pollIntervalMs",
    ])
      if (config[id] !== undefined) $(id).value = config[id];
    $("roster-url").value = config.rosterUrl || "";
    $("test-feed").checked = Boolean(config.testFeed);
    updateModeFields();
  })
  .catch((error) => toast(error.message, true));
connectState(render, () => {
  $("connection-status").textContent = "Race control disconnected";
  $("connection-message").textContent =
    "Reconnecting automatically…";
});
