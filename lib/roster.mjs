function headerName(value) {
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[. _-]/g, "");
  const aliases = {
    bib: "bib",
    number: "bib",
    name: "name",
    category: "category",
    club: "club",
    year: "yearOfBirth",
    yearofbirth: "yearOfBirth",
    birthyear: "yearOfBirth",
  };
  return Object.hasOwn(aliases, key) ? aliases[key] : key;
}

export function parseRoster(csv) {
  if (typeof csv !== "string" || Buffer.byteLength(csv) > 2_000_000)
    throw new Error("CSV must be text smaller than 2 MB.");
  csv = csv.replace(/^\uFEFF/, "");
  const lines = csv.split(/\r?\n/);
  const volaHeader = lines.findIndex((line) => {
    const headers = line.split("\t").map(headerName);
    return (
      headers.includes("bib") &&
      headers.includes("name") &&
      headers.includes("category") &&
      headers.includes("club")
    );
  });
  const isVola = volaHeader >= 0;
  if (isVola) csv = lines.slice(volaHeader).join("\n");
  const first = csv.split(/\r?\n/, 1)[0];
  const separator =
    isVola || first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
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
    if (rows.length > (isVola ? 10002 : 10001) || cell.length > 500)
      throw new Error(
        "CSV exceeds 10,000 rows or a field exceeds 500 characters.",
      );
  }
  if (!rows.length) throw new Error("CSV is empty.");
  const headers = rows.shift().map(headerName);
  const columns = ["bib", "name", "category", "club", "yearOfBirth"].map((h) =>
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
  if (
    isVola &&
    rows.at(-1)?.length === 1 &&
    /^\d+\s+Competitors?$/i.test(rows.at(-1)[0])
  ) {
    const count = Number.parseInt(rows.pop()[0], 10);
    if (count !== rows.length)
      throw new Error("VOLA competitor count does not match its rows.");
  }
  if (rows.length > 10000) throw new Error("CSV exceeds 10,000 rows.");
  const seen = new Set();
  return rows.map((values, index) => {
    if (
      values.length > headers.length ||
      (isVola && values.length !== headers.length)
    )
      throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const [bib, name, category, club, yearOfBirth] = columns.map(
      (i) => values[i] ?? "",
    );
    if (
      !bib ||
      bib.length > 40 ||
      /[\x00-\x1f\x7f]/.test(bib + name + category + club + yearOfBirth)
    )
      throw new Error(
        `CSV row ${index + 2} needs a valid bib and fields without control characters.`,
      );
    if (yearOfBirth && !/^\d{4}$/.test(yearOfBirth))
      throw new Error(`CSV row ${index + 2} needs a four-digit year of birth.`);
    if (seen.has(bib)) throw new Error(`Duplicate bib: ${bib}`);
    seen.add(bib);
    return {
      bib,
      name,
      category,
      club,
      ...(yearOfBirth ? { yearOfBirth } : {}),
    };
  });
}

export function rosterCsv(roster) {
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const includeYear = roster.some((r) => r.yearOfBirth);
  return (
    `bib,name,category,club${includeYear ? ",yearOfBirth" : ""}\n` +
    roster
      .map((r) =>
        [
          r.bib,
          r.name ?? "",
          r.category ?? "",
          r.club ?? "",
          ...(includeYear ? [r.yearOfBirth ?? ""] : []),
        ]
          .map(escape)
          .join(","),
      )
      .join("\n") +
    "\n"
  );
}
