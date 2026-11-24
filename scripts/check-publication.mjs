import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const sourceDirectories = new Set([
  "lib",
  "public",
  "native",
  "scripts",
  "examples",
  "simulator",
  "test",
]);
const rootFiles = new Set([
  "README.md",
  "server.mjs",
  "PROTOCOL.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  ".gitignore",
  "publication-files.json",
]);
const textExtensions = new Set([
  ".mjs",
  ".js",
  ".json",
  ".html",
  ".css",
  ".cpp",
  ".hpp",
  ".h",
  ".ps1",
  ".sh",
  ".md",
  ".txt",
  ".yaml",
  ".csv",
  ".plist",
]);
const checks = [
  ["personal absolute path", /\/(?:Users|home)\/[A-Za-z0-9._-]+/],
  [
    "private network address",
    /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/,
  ],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    "credential token",
    /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{15,})/,
  ],
];

export function allowedPublicationPath(file) {
  if (
    typeof file !== "string" ||
    file.includes("\\") ||
    path.posix.isAbsolute(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  )
    return false;
  if (rootFiles.has(file)) return true;
  const parts = file.split("/");
  return (
    parts.length > 1 &&
    sourceDirectories.has(parts[0]) &&
    (textExtensions.has(path.posix.extname(file)) ||
      ["COPYING", "Dockerfile"].includes(parts.at(-1))) &&
    !parts.some(
      (part) =>
        part.startsWith(".") || ["node_modules", "data", "dist"].includes(part),
    )
  );
}

export async function auditPublication(root, files, trackedFiles = null) {
  const errors = [];
  if (
    !Array.isArray(files) ||
    !files.length ||
    new Set(files).size !== files.length
  )
    throw new Error(
      "Publication manifest must be a nonempty unique file list.",
    );
  for (const file of files) {
    if (!allowedPublicationPath(file)) {
      errors.push(`Disallowed publication path: ${file}`);
      continue;
    }
    let invalid = false;
    for (let i = 1; i <= file.split("/").length; i++) {
      const prefix = file.split("/").slice(0, i).join("/");
      try {
        const entry = await lstat(path.join(root, prefix));
        if (entry.isSymbolicLink()) {
          errors.push(`Symlink is not publishable: ${file}`);
          invalid = true;
          break;
        }
        if (i === file.split("/").length && !entry.isFile()) {
          errors.push(`Publication entry is not a file: ${file}`);
          invalid = true;
        }
      } catch {
        errors.push(`Missing publication file: ${file}`);
        invalid = true;
        break;
      }
    }
    if (invalid) continue;
    const bytes = await readFile(path.join(root, file));
    if (bytes.includes(0)) {
      errors.push(`Binary content is not publishable: ${file}`);
      continue;
    }
    const text = bytes.toString("utf8");
    for (const [label, pattern] of checks) {
      const match = pattern.exec(text);
      if (match) {
        const line = text.slice(0, match.index).split("\n").length;
        errors.push(`${label} found at ${file}:${line}`);
      }
    }
  }
  if (trackedFiles) {
    const expected = new Set(files),
      actual = new Set(trackedFiles);
    for (const file of actual)
      if (!expected.has(file))
        errors.push(`Tracked file outside publication manifest: ${file}`);
    for (const file of expected)
      if (!actual.has(file))
        errors.push(`Publication file is not staged/tracked: ${file}`);
  }
  const fixture = "examples/competitors.csv";
  if (files.includes(fixture)) {
    const expected =
      "bib,name,category\n" +
      Array.from(
        { length: 9 },
        (_, i) =>
          `${String(i + 1).padStart(3, "0")},Racer ${String(i + 1).padStart(2, "0")},Demo\n`,
      ).join("");
    try {
      if ((await readFile(path.join(root, fixture), "utf8")) !== expected)
        errors.push(
          "Competitor fixture must contain only the nine generic Racer entries.",
        );
    } catch {}
  }
  return errors;
}

const ownFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === ownFile) {
  const root = path.dirname(path.dirname(ownFile));
  const { files } = JSON.parse(
    await readFile(path.join(root, "publication-files.json"), "utf8"),
  );
  const git = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  let tracked = null;
  // Never use a parent repository's index to determine this project's publication set.
  if (
    git.status === 0 &&
    path.resolve(git.stdout.trim()) === path.resolve(root)
  ) {
    const listed = spawnSync(
      "git",
      ["-C", root, "ls-files", "--cached", "-z"],
      { encoding: "utf8" },
    );
    if (listed.status !== 0)
      throw new Error("Could not inspect the publication index.");
    tracked = listed.stdout.split("\0").filter(Boolean);
  }
  const errors = await auditPublication(root, files, tracked);
  if (errors.length) {
    for (const error of errors) process.stderr.write(error + "\n");
    process.exitCode = 1;
  } else if (process.argv.includes("--print0"))
    process.stdout.write(files.join("\0") + "\0");
  else
    console.log(
      `Publication privacy check passed: ${files.length} text source files${tracked ? " and exact Git index" : ""}. Private local assets were excluded.`,
    );
}
