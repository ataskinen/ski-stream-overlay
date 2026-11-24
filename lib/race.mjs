export const presentationDefaults = {
  finishHoldMs: 2000,
  idleRotationMs: 180000,
  categoryRotationMs: 10000,
};

export function validateEvent(event) {
  if (
    !event ||
    !["start", "time", "finish", "dnf", "dsq", "clear"].includes(event.type)
  )
    throw new Error("Unknown timing event type.");
  if (event.type === "clear") return { type: "clear" };
  const bib = String(event.bib ?? "").trim();
  if (!bib || bib.length > 40 || /[\x00-\x1f\x7f]/.test(bib))
    throw new Error("Timing event needs a valid bib.");
  if (["dnf", "dsq"].includes(event.type))
    return { type: event.type, bib, timeMs: null };
  const timeMs = event.timeMs ?? (event.type === "start" ? 0 : NaN);
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 86_400_000)
    throw new Error(
      "timeMs must be an elapsed duration between 0 and 86400000.",
    );
  return { type: event.type, bib, timeMs };
}
function difference(timeMs, referenceMs) {
  return (Math.round(timeMs * 1000) - Math.round(referenceMs * 1000)) / 1000;
}

export class Race {
  constructor(saved = {}, now = Date.now()) {
    this.active = new Map();
    this.terminalQueue = [];
    this.results = new Map(
      (saved.results ?? []).map((r) => [
        r.bib,
        {
          bib: r.bib,
          timeMs: r.status === "dnf" || r.status === "dsq" ? null : r.timeMs,
          status: r.status ?? "finish",
        },
      ]),
    );
    this.lastTerminal = saved.lastTerminal ?? null;
    this.lastStartAt = saved.lastStartAt ?? now;
  }
  get current() {
    return (
      this.terminalQueue[0]?.racer ?? this.active.values().next().value ?? null
    );
  }
  advance(now, settings = {}) {
    const hold = settings.finishHoldMs ?? presentationDefaults.finishHoldMs;
    while (
      this.terminalQueue.length &&
      now >= this.terminalQueue[0].shownAt + hold
    ) {
      const expired = this.terminalQueue.shift();
      if (this.terminalQueue.length)
        this.terminalQueue[0].shownAt = expired.shownAt + hold;
    }
  }
  apply(raw, now = Date.now(), settings = {}) {
    const event = validateEvent(raw);
    this.advance(now, settings);
    if (event.type === "clear") {
      this.active.clear();
      this.terminalQueue = [];
      this.lastTerminal = null;
      return;
    }
    if (event.type === "start" || event.type === "time") {
      const existing = this.active.get(event.bib);
      // A delayed time tick must not resurrect a completed racer. A new start is explicit.
      if (event.type === "time" && !existing && this.results.has(event.bib))
        return;
      if (event.type === "start" || !existing) {
        this.lastStartAt = now;
        this.active.delete(event.bib);
      }
      this.active.set(event.bib, {
        bib: event.bib,
        timeMs: event.timeMs,
        running: true,
        updatedAt: now,
        startedAt: event.type === "start" ? now : (existing?.startedAt ?? now),
        estimated: true,
        stale: false,
        finished: false,
        status: "running",
      });
      return;
    }
    const prior = this.results.get(event.bib);
    if (
      !this.active.has(event.bib) &&
      prior?.status === event.type &&
      prior?.timeMs === event.timeMs
    )
      return;
    const reference = [...this.results.values()]
      .filter((r) => r.bib !== event.bib && r.status === "finish")
      .map((r) => ({ ...r }));
    const racer = {
      bib: event.bib,
      timeMs: event.timeMs,
      running: false,
      updatedAt: now,
      estimated: false,
      stale: false,
      finished: event.type === "finish",
      status: event.type,
    };
    this.active.delete(event.bib);
    this.results.set(event.bib, {
      bib: event.bib,
      timeMs: event.timeMs,
      status: event.type,
    });
    this.lastTerminal = racer;
    const queued = this.terminalQueue.find(
      (entry) => entry.racer.bib === event.bib,
    );
    if (queued) {
      queued.racer = racer;
      queued.reference = reference;
    } else
      this.terminalQueue.push({
        racer,
        reference,
        shownAt: this.terminalQueue.length ? null : now,
      });
  }
  stale(now = Date.now()) {
    for (const [bib, racer] of this.active)
      this.active.set(bib, {
        ...racer,
        timeMs:
          Number.isFinite(racer.timeMs)
            ? racer.timeMs + (racer.running ? Math.max(0, now - racer.updatedAt) : 0)
            : null,
        ...(Object.hasOwn(racer, "runTimeMs") ? {
          runTimeMs: Number.isFinite(racer.runTimeMs)
            ? racer.runTimeMs + (racer.running ? Math.max(0, now - racer.updatedAt) : 0)
            : null,
        } : {}),
        updatedAt: now,
        running: false,
        stale: true,
      });
  }
  view(roster, now = Date.now(), settings = {}) {
    this.advance(now, settings);
    const timing = { ...presentationDefaults, ...settings };
    const people = new Map(roster.map((r) => [r.bib, r]));
    const enrich = (r) => ({
      ...r,
      name: people.get(r.bib)?.name ?? "",
      category: people.get(r.bib)?.category ?? "",
      club: people.get(r.bib)?.club ?? "",
      ...(people.get(r.bib)?.yearOfBirth
        ? { yearOfBirth: people.get(r.bib).yearOfBirth }
        : {}),
    });
    const results = [...this.results.values()]
      .map(enrich)
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity) ||
          a.bib.localeCompare(b.bib),
      );
    const groups = new Map();
    for (const result of results) {
      result.rank = null;
      result.gapToLeaderMs = null;
      if (result.category && result.status === "finish") {
        const group = groups.get(result.category) ?? {
          position: 0,
          rank: 0,
          time: null,
          leader: result.timeMs,
        };
        group.position++;
        if (group.time !== result.timeMs) group.rank = group.position;
        result.rank = group.rank;
        result.gapToLeaderMs = difference(result.timeMs, group.leader);
        group.time = result.timeMs;
        groups.set(result.category, group);
      }
    }
    const categories = [
      ...new Set(
        roster
          .map((r) => r.category ?? "")
          .concat(results.map((r) => r.category))
          .filter(Boolean),
      ),
    ].sort();
    const ranked = (racer, reference = []) => {
      const current = {
        ...enrich(racer),
        rank: null,
        gapToLeaderMs: null,
        leadDeltaMs: null,
        isLeader: false,
      };
      if (current.finished && current.category && current.totalEligible !== false && Number.isFinite(current.timeMs)) {
        const result = results.find(
          (r) => r.bib === current.bib && r.status === "finish",
        );
        current.rank = result?.rank ?? null;
        current.gapToLeaderMs = result?.gapToLeaderMs ?? null;
        current.isLeader = current.rank === 1;
        const peers = reference
          .map(enrich)
          .filter((r) => r.category === current.category);
        if (peers.length)
          current.leadDeltaMs = difference(
            current.timeMs,
            Math.min(...peers.map((r) => r.timeMs)),
          );
      }
      return current;
    };
    const activeRacers = [...this.active.values()].map((r) => ranked(r));
    const terminalQueue = this.terminalQueue.map((entry) => ({
      ...ranked(entry.racer, entry.reference),
      shownAt: entry.shownAt,
    }));
    const current = terminalQueue[0] ?? activeRacers[0] ?? null;
    const otherRacers = current
      ? activeRacers.filter((r) => r.bib !== current.bib)
      : [];
    const idle = now - this.lastStartAt >= timing.idleRotationMs;
    const cycleCategories = [...groups.keys()].sort();
    let mode = current
      ? "racers"
      : idle && cycleCategories.length
        ? "cycle"
        : "top10";
    let category = this.lastTerminal
      ? enrich(this.lastTerminal).category
      : (categories[0] ?? "");
    if (mode === "cycle")
      category =
        cycleCategories[
          Math.floor(
            (now - this.lastStartAt - timing.idleRotationMs) /
              timing.categoryRotationMs,
          ) % cycleCategories.length
        ];
    return {
      current,
      otherRacers,
      activeRacers,
      terminalQueue,
      results,
      categories,
      lastStartAt: this.lastStartAt,
      presentation: { mode, current, otherRacers, category },
    };
  }
  save() {
    return {
      results: [...this.results.values()],
      lastTerminal: this.lastTerminal,
      lastStartAt: this.lastStartAt,
    };
  }
}
