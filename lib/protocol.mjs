// This adapter follows Kiril's public v11 parser. Real hardware compatibility is unverified.
function volaMicroseconds(value) {
  if (!/^\d{7,12}$/.test(value ?? ""))
    throw new Error("Invalid VOLA timestamp.");
  return Number(value);
}

export function volaTimestamp(value) {
  return volaMicroseconds(value) / 1000;
}

export function createLineDecoder(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    if (buffer.length > 262144) {
      buffer = "";
      throw new Error("Timing frame is too large.");
    }
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  };
}

export const defaultVolaStatusMap = { 0: "start", 1: "finish" };

export function createVolaParser(onEvent, statusMap = defaultVolaStatusMap) {
  const starts = new Map();
  return (line) => {
    if (!line.startsWith("NR;")) return;
    const fields = line.split(";");
    const status = fields[1],
      bib = fields[3]?.trim();
    if (!bib || !/^\d+$/.test(status ?? "")) return;
    const action = Object.hasOwn(statusMap, status) ? statusMap[status] : null;
    // Unknown wire statuses are never silently converted into valid finish times.
    if (!action) return;
    if (action === "dnf" || action === "dsq") {
      starts.delete(bib);
      onEvent({ type: action, bib, timeMs: null });
      return;
    }
    const stamp = volaMicroseconds(fields[6]);
    if (action === "start") {
      starts.set(bib, stamp);
      onEvent({ type: "start", bib, timeMs: 0 });
    } else if (starts.has(bib)) {
      // Subtract exact integer microseconds before converting to milliseconds:
      // subtracting fractional absolute timestamps can make identical runs unequal.
      let elapsedMicroseconds = stamp - starts.get(bib);
      if (elapsedMicroseconds < 0) elapsedMicroseconds += 86_400_000_000;
      const timeMs = elapsedMicroseconds / 1000;
      // Finish codes must be explicitly configured; the upstream nonzero assumption is unsafe for DNF/DSQ.
      onEvent({ type: "finish", bib, timeMs });
    }
  };
}
