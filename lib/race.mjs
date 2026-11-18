export function validateEvent(event) {
  if (!event || !["start", "time", "finish", "clear"].includes(event.type))
    throw new Error("Unknown timing event type.");
  if (event.type === "clear") return { type: "clear" };
  const bib = String(event.bib ?? "").trim();
  if (!bib || bib.length > 40 || /[\x00-\x1f]/.test(bib))
    throw new Error("Timing event needs a valid bib.");
  const timeMs = event.timeMs ?? (event.type === "start" ? 0 : NaN);
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 86_400_000)
    throw new Error(
      "timeMs must be an elapsed duration between 0 and 86400000.",
    );
  return { type: event.type, bib, timeMs };
}

export class Race {
  constructor(saved = {}) {
    this.current = null;
    this.results = new Map(
      (saved.results ?? []).map((r) => [
        r.bib,
        { bib: r.bib, timeMs: r.timeMs },
      ]),
    );
  }
  apply(raw, now = Date.now()) {
    const event = validateEvent(raw);
    if (event.type === "clear") {
      this.current = null;
      return;
    }
    if (event.type === "finish") {
      this.results.set(event.bib, { bib: event.bib, timeMs: event.timeMs });
      if (this.current?.running && this.current.bib !== event.bib) return;
    }
    this.current = {
      bib: event.bib,
      timeMs: event.timeMs,
      running: event.type !== "finish",
      updatedAt: now,
      estimated: event.type !== "finish",
      stale: false,
    };
  }
  stale(now = Date.now()) {
    if (this.current)
      this.current = {
        ...this.current,
        timeMs:
          this.current.timeMs +
          (this.current.running
            ? Math.max(0, now - this.current.updatedAt)
            : 0),
        updatedAt: now,
        running: false,
        stale: true,
      };
  }
  view(roster) {
    const people = new Map(roster.map((r) => [r.bib, r]));
    const enrich = (r) => ({
      ...r,
      name: people.get(r.bib)?.name ?? "",
      category: people.get(r.bib)?.category ?? "Unknown",
    });
    const results = [...this.results.values()]
      .map(enrich)
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          a.timeMs - b.timeMs ||
          a.bib.localeCompare(b.bib),
      );
    let previousCategory,
      previousTime,
      rank = 0,
      position = 0;
    for (const result of results) {
      if (result.category !== previousCategory) {
        position = 0;
        previousTime = undefined;
      }
      position++;
      if (result.timeMs !== previousTime) rank = position;
      result.rank = rank;
      previousCategory = result.category;
      previousTime = result.timeMs;
    }
    return {
      current: this.current ? enrich(this.current) : null,
      results,
      categories: [
        ...new Set(
          roster.map((r) => r.category).concat(results.map((r) => r.category)),
        ),
      ].sort(),
    };
  }
  save() {
    return { results: [...this.results.values()] };
  }
}
