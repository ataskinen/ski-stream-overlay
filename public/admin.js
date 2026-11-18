import {
  connectState,
  element,
  feedLabel,
  formatTime,
  request,
  resetContext,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
let toastTimeout;
let activeState;
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
    if (feedback) feedback.textContent = "Käsitellään…";
    await task();
    if (feedback) feedback.textContent = "Tallennettu.";
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
  $("top-url").value = `${location.origin}${path}`;
  if ($("top-preview").getAttribute("src") !== path)
    $("top-preview").src = path;
}
function render(state) {
  activeState = state;
  const reset = resetContext(state);
  $("reset-live").textContent = reset.label;
  $("reset-live").disabled = reset.disabled;
  $("reset-helper").textContent = reset.helper;
  const labels = {
    idle: "Valmis",
    connected: "Yhteys toimii",
    connecting: "Yhdistetään",
    disconnected: "Ei yhteyttä",
    error: "Yhteysvirhe",
    stopped: "Pysäytetty",
    paused: "Demo pysäytetty",
    demo: "Demo käytössä",
  };
  $("mode-badge").textContent =
    feedLabel(state) === "SKI RACE" ? "AJANOTTO" : feedLabel(state);
  $("mode-badge").classList.toggle(
    "live",
    state.mode !== "demo" && !state.testFeed,
  );
  $("connection-status").textContent =
    labels[state.connection?.status] ||
    state.connection?.status ||
    "Odottaa tietoja";
  const messages = {
    "Demo ready": "Demo valmis",
    "Demo ready — press Next racer or Start demo":
      "Demo valmis — valitse Seuraava laskija tai Käynnistä demo",
    "Simulated data — not live race results":
      "Testidataa · ei kilpailun live-tuloksia",
    "Feed stopped": "Datayhteys pysäytetty",
    "Receiving timing data": "Vastaanotetaan ajanottotietoja",
    "HTTP feed connected": "HTTP-datayhteys toimii",
    "HTTP feed unavailable or invalid; retrying":
      "HTTP-syöte ei vastaa tai data on virheellistä · yritetään uudelleen",
    "Connecting to timing feed": "Yhdistetään ajanottosyötteeseen",
    "TCP feed connected; waiting for events":
      "TCP-yhteys toimii · odotetaan ajanottotapahtumia",
    "Invalid timing message received":
      "Vastaanotettiin virheellinen ajanottoviesti",
    "TCP feed disconnected; retrying":
      "TCP-yhteys katkesi · yritetään uudelleen",
    "Connecting to HTTP timing feed": "Yhdistetään HTTP-ajanottosyötteeseen",
  };
  $("connection-message").textContent =
    messages[state.connection?.message] || state.connection?.message || "";
  const previous = $("category").value;
  const categories = state.categories || [];
  const existing = Array.from($("category").options)
    .slice(1)
    .map((option) => option.value);
  if (JSON.stringify(existing) !== JSON.stringify(categories)) {
    const blank = element("option", "", "Ensimmäinen sarja");
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
      ? "Testikilpailijalista"
      : state.rosterTarget === "live"
        ? "Live-kilpailijalista"
        : state.mode === "demo"
          ? "Tallennettu tuontilista"
          : state.testFeed
            ? "Testikilpailijalista"
            : "Live-kilpailijalista";
  $("roster-count").textContent =
    `${rosterKind}: ${roster.length} kilpailijaa${state.mode === "demo" ? " · näytöissä erillinen demolista" : ""}`;
  const results = [...(state.results || [])].sort(
    (a, b) =>
      (a.category || "").localeCompare(b.category || "") || a.timeMs - b.timeMs,
  );
  $("results-body").replaceChildren(
    ...results.map((row) => {
      const tr = element("tr");
      for (const value of [
        row.rank || "—",
        row.bib,
        row.name || "Nimi puuttuu",
        row.category || "Sarja puuttuu",
        formatTime(row.timeMs),
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
      "Ei vielä tuloksia. Käynnistä demo tai yhdistä ajanottoon.",
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
    protocol: $("protocol").value,
    host: $("host").value.trim(),
    port: Number($("port").value),
    url: $("url").value.trim(),
    pollIntervalMs: Number($("pollIntervalMs").value),
    rosterUrl: $("roster-url").value.trim(),
    testFeed: $("test-feed").checked,
  };
  action(async () => {
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify(config),
    });
    toast("Ajanoton asetukset tallennettu.");
  }, "config-feedback");
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
    "Testiasetukset täytetty. Paina Tallenna ja yhdistä, sitten Hae lista kilpailijalistan kohdalla.";
  toast("Simulaattorin asetukset täytetty. Yhteyttä ei vielä muutettu.");
});
$("csv-file").addEventListener("change", () =>
  action(async () => {
    const file = $("csv-file").files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024)
      throw new Error("CSV-tiedosto on liian suuri (enintään 2 Mt).");
    $("csv-text").value = await file.text();
    toast("Tiedosto luettu. Paina Tuo kilpailijat tallentaaksesi listan.");
  }),
);
$("roster-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    await request("/api/roster", {
      method: "POST",
      body: JSON.stringify({ csv: $("csv-text").value }),
    });
    toast("Kilpailijalista tuotu.");
  }, "roster-feedback");
});
$("roster-url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  action(async () => {
    await request("/api/roster/fetch", {
      method: "POST",
      body: JSON.stringify({ url: $("roster-url").value.trim() }),
    });
    toast("Kilpailijalista haettu ja tallennettu.");
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
      toast("Demon tila päivitetty.");
    }),
  ),
);
document.querySelectorAll("[data-copy]").forEach((button) =>
  button.addEventListener("click", () =>
    action(async () => {
      await navigator.clipboard.writeText($(button.dataset.copy).value);
      toast("Osoite kopioitu.");
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
    for (const id of [
      "mode",
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
  $("connection-status").textContent = "Yhteys ohjauspalveluun katkesi";
  $("connection-message").textContent =
    "Yhdistetään automaattisesti uudelleen…";
});
