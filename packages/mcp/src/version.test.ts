import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "./version.js";

/**
 * The one thing that keeps a hard-coded version honest.
 *
 * `version.ts` cannot read the manifest at runtime — the image copies `dist/` without it — so the
 * constant and `package.json` are two copies of one number, and only a test can hold them together.
 * Without this, a release bump lands in the manifest and the server goes on introducing itself as
 * the previous build to every client that connects.
 */
void test("the advertised version is the package's own", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, manifest.version);
});
