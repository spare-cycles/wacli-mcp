import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const base = { WA_DATA_DIR: "/tmp/wa" } satisfies NodeJS.ProcessEnv;

void test("defaults are applied", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.dataDir, "/tmp/wa");
  assert.equal(c.dbPath, "/tmp/wa/wa.db");
  assert.equal(c.mediaDir, "/tmp/wa/media");
  assert.equal(c.port, 8080);
  assert.equal(c.httpPath, "/mcp");
  assert.equal(c.readOnly, false);
  assert.equal(c.whisperModel, "large-v3-turbo-q5_0");
  assert.equal(c.videoKeyframes, 4);
  assert.equal(c.maxResultChars, 200_000);
  assert.equal(c.ntfy, undefined);
  assert.equal(c.phoneNumber, undefined);
});

void test("readOnly accepts wacli-era truthy spellings", () => {
  for (const v of ["1", "true", "YES", "on"]) {
    assert.equal(loadConfig({ ...base, WA_MCP_READONLY: v }).readOnly, true, v);
  }
  for (const v of ["0", "false", "", "no"]) {
    assert.equal(loadConfig({ ...base, WA_MCP_READONLY: v }).readOnly, false, v);
  }
});

void test("phone number must be E.164 digits without +", () => {
  assert.equal(loadConfig({ ...base, WA_PHONE_NUMBER: "33612345678" }).phoneNumber, "33612345678");
  assert.throws(() => loadConfig({ ...base, WA_PHONE_NUMBER: "+33612345678" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, WA_PHONE_NUMBER: "33 6 12" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, WA_PHONE_NUMBER: "123" }), ConfigError);
});

void test("numeric vars fall back on garbage and clamp on range", () => {
  assert.equal(loadConfig({ ...base, PORT: "not-a-number" }).port, 8080);
  assert.equal(loadConfig({ ...base, PORT: "0" }).port, 8080);
  assert.equal(loadConfig({ ...base, WA_VIDEO_KEYFRAMES: "999" }).videoKeyframes, 16);
  assert.equal(loadConfig({ ...base, WA_VIDEO_KEYFRAMES: "2" }).videoKeyframes, 2);
});

void test("ntfy is all-or-nothing", () => {
  assert.equal(loadConfig({ ...base, NTFY_BASE_URL: "https://n.example" }).ntfy, undefined);
  const c = loadConfig({ ...base, NTFY_BASE_URL: "https://n.example", NTFY_TOPIC: "alerts" });
  assert.deepEqual(c.ntfy, { baseUrl: "https://n.example", topic: "alerts", token: "" });
});

void test("no WACLI_ variable is consulted", () => {
  const c = loadConfig({ ...base, WACLI_MCP_READONLY: "1", WACLI_STORE_DIR: "/old" });
  assert.equal(c.readOnly, false);
  assert.equal(c.dataDir, "/tmp/wa");
});
