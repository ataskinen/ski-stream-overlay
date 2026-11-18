export function parseRoster(csv) {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 2_000_000)
    throw new Error("CSV must be text smaller than 2 MB.");
  csv = csv.replace(/^\uFEFF/, "");
  const first = csv.split(/\r?\n/, 1)[0];
  const separator = first.includes(";") ? ";" : ",";
  const rows = [];
  let row = [],
    cell = "",
    quoted = false,
    closed = false;
  for (let i = 0; i <= csv.length; i++) {
    const c = csv[i] ?? "\n";
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else {
        if (i === csv.length) throw new Error("Unclosed CSV quote.");
        cell += c;
      }
    } else if (c === separator || c === "\n" || c === "\r") {
      row.push(cell.trim());
      cell = "";
      closed = false;
      if (c !== separator) {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (c === "\r" && csv[i + 1] === "\n") i++;
      }
    } else if (c === '"' && cell === "" && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new Error("Invalid CSV quoting.");
      cell += c;
    }
    if (rows.length > 10001 || cell.length > 500)
      throw new Error(
        "CSV exceeds 10,000 rows or a field exceeds 500 characters.",
      );
  }
  if (!rows.length) throw new Error("CSV is empty.");
  const headers = rows.shift().map((x) => x.toLowerCase());
  const columns = ["bib", "name", "category", "club"].map((h) =>
    headers.indexOf(h),
  );
  if (
    columns[0] < 0 ||
    headers.some((header) => !header) ||
    new Set(headers).size !== headers.length
  )
    throw new Error(
      "CSV needs a bib header and nonempty, unique column headers.",
    );
  const seen = new Set();
  return rows.map((values, index) => {
    if (values.length > headers.length)
      throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const [bib, name, category, club] = columns.map((i) => values[i] ?? "");
    if (
      !bib ||
      bib.length > 40 ||
      /[\x00-\x1f\x7f]/.test(bib + name + category + club)
    )
      throw new Error(
        `CSV row ${index + 2} needs a valid bib and fields without control characters.`,
      );
    if (seen.has(bib)) throw new Error(`Duplicate bib: ${bib}`);
    seen.add(bib);
    return { bib, name, category, club };
  });
}

export function rosterCsv(roster) {
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return (
    "bib,name,category,club\n" +
    roster
      .map((r) =>
        [r.bib, r.name ?? "", r.category ?? "", r.club ?? ""]
          .map(escape)
          .join(","),
      )
      .join("\n") +
    "\n"
  );
}
