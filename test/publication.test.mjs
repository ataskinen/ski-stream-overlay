import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  auditPublication,
  allowedPublicationPath,
} from "../scripts/check-publication.mjs";

test("publication allowlist excludes private assets and rejects indexed extras or missing sources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "README.md"), "Public documentation.");
  await mkdir(path.join(root, "demo"));
  await writeFile(
    path.join(root, "demo", "private.txt"),
    "private local asset",
  );
  assert.deepEqual(await auditPublication(root, ["README.md"]), []);
  assert.equal(allowedPublicationPath("demo/private.txt"), false);
  assert.equal(allowedPublicationPath("docs/map.pdf"), false);
  assert.equal(allowedPublicationPath("data/state.json"), false);
  assert.equal(allowedPublicationPath("native/../../private.txt"), false);
  assert.match(
    (
      await auditPublication(
        root,
        ["README.md"],
        ["README.md", "demo/private.txt"],
      )
    ).join("\n"),
    /outside publication manifest/,
  );
  assert.match(
    (await auditPublication(root, ["server.mjs"])).join("\n"),
    /Missing publication file/,
  );
  assert.match(
    (await auditPublication(root, ["README.md"], [])).join("\n"),
    /not staged/,
  );
});
test("privacy scan rejects personal home paths, credential-shaped data and symlinks without echoing values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publication-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privatePath = ["", "Users", "PrivateFixture", "workspace"].join("/");
  const syntheticToken = "gh" + "p_" + "0".repeat(30);
  await writeFile(
    path.join(root, "README.md"),
    privatePath + "\n" + syntheticToken,
  );
  const errors = await auditPublication(root, ["README.md"]);
  assert.equal(errors.length, 2);
  assert.ok(
    errors.every(
      (e) => !e.includes(privatePath) && !e.includes(syntheticToken),
    ),
  );
  await mkdir(path.join(root, "public"));
  await symlink(
    path.join(root, "README.md"),
    path.join(root, "public", "linked.md"),
  );
  assert.match(
    (await auditPublication(root, ["public/linked.md"])).join("\n"),
    /Symlink/,
  );
});
