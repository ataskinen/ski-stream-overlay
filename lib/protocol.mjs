// This adapter follows Kiril's public v11 parser. Real hardware compatibility is unverified.
export function volaTimestamp(value) {
  if (!/^\d{7,12}$/.test(value ?? ""))
    throw new Error("Invalid VOLA timestamp.");
  return Number(value.slice(0, -6)) * 1000 + Number(value.slice(-6)) / 1000;
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

export function createVolaParser(onEvent) {
  const starts = new Map();
  return (line) => {
    if (!line.startsWith("NR;")) return;
    const fields = line.split(";");
    const status = fields[1],
      bib = fields[3]?.trim();
    if (!bib || !/^\d+$/.test(status ?? "")) return;
    const stamp = volaTimestamp(fields[6]);
    if (status === "0") {
      starts.set(bib, stamp);
      onEvent({ type: "start", bib, timeMs: 0 });
    } else if (starts.has(bib)) {
      let timeMs = stamp - starts.get(bib);
      if (timeMs < 0) timeMs += 86_400_000;
      // Upstream treats every nonzero NR status as finish. Confirm this with Kiril before a race.
      onEvent({ type: "finish", bib, timeMs });
    }
  };
}
