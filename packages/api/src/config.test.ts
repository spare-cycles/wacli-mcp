import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const base = { WHATSAPP_DATA_DIR: "/tmp/whatsapp" } satisfies NodeJS.ProcessEnv;

void test("defaults are applied", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.dataDir, "/tmp/whatsapp");
  assert.equal(c.dbPath, "/tmp/whatsapp/whatsapp.db");
  assert.equal(c.mediaDir, "/tmp/whatsapp/media");
  assert.equal(c.port, 8080);
  assert.equal(c.readOnly, false);
  assert.deepEqual(c.transcribeBackends, ["runpod", "mistral"]);
  assert.equal(c.transcribeMaxSeconds, 900);
  // Off in code, on in the deployment: a fresh checkout must never start spending on a GPU.
  assert.equal(c.autoTranscribe.enabled, false);
  assert.equal(c.videoKeyframes, 4);
  assert.equal(c.maxResultChars, 200_000);
  assert.equal(c.ntfy, undefined);
  assert.equal(c.phoneNumber, undefined);
  assert.equal(c.maxUploadBytes, 64 * 1024 * 1024);
  assert.equal(c.mediaLinkTtlSec, 900);
});

void test("the media link TTL is clamped: an unauthenticated capability gets neither forever nor a blink", () => {
  const ttl = (v: string): number => loadConfig({ ...base, WHATSAPP_MEDIA_LINK_TTL: v }).mediaLinkTtlSec;
  assert.equal(ttl("60"), 60);
  assert.equal(ttl("5"), 60);
  assert.equal(ttl("604800"), 86_400);
  assert.equal(ttl("nonsense"), 900);
});

void test("path-based file sending is off unless a directory is named", () => {
  assert.equal(loadConfig({ ...base }).sendFileDir, undefined);
  assert.equal(loadConfig({ ...base, WHATSAPP_SEND_FILE_DIR: "" }).sendFileDir, undefined);
  assert.equal(loadConfig({ ...base, WHATSAPP_SEND_FILE_DIR: "/data/uploads" }).sendFileDir, "/data/uploads");
});

void test("readOnly accepts every documented truthy spelling", () => {
  for (const v of ["1", "true", "YES", "on"]) {
    assert.equal(loadConfig({ ...base, WHATSAPP_MCP_READONLY: v }).readOnly, true, v);
  }
  for (const v of ["0", "false", "", "no"]) {
    assert.equal(loadConfig({ ...base, WHATSAPP_MCP_READONLY: v }).readOnly, false, v);
  }
});

void test("phone number must be E.164 digits without +", () => {
  assert.equal(loadConfig({ ...base, WHATSAPP_PHONE_NUMBER: "33612345678" }).phoneNumber, "33612345678");
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PHONE_NUMBER: "+33612345678" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PHONE_NUMBER: "33 6 12" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, WHATSAPP_PHONE_NUMBER: "123" }), ConfigError);
});

void test("numeric vars fall back on garbage and clamp on range", () => {
  assert.equal(loadConfig({ ...base, PORT: "not-a-number" }).port, 8080);
  assert.equal(loadConfig({ ...base, PORT: "0" }).port, 8080);
  assert.equal(loadConfig({ ...base, WHATSAPP_VIDEO_KEYFRAMES: "999" }).videoKeyframes, 16);
  assert.equal(loadConfig({ ...base, WHATSAPP_VIDEO_KEYFRAMES: "2" }).videoKeyframes, 2);
  assert.equal(loadConfig({ ...base, WHATSAPP_MAX_UPLOAD_BYTES: "-1" }).maxUploadBytes, 64 * 1024 * 1024);
  assert.equal(loadConfig({ ...base, WHATSAPP_MAX_UPLOAD_BYTES: "999999999999" }).maxUploadBytes, 256 * 1024 * 1024);
  assert.equal(loadConfig({ ...base, WHATSAPP_MAX_UPLOAD_BYTES: "2048" }).maxUploadBytes, 2048);
});

void test("ntfy is all-or-nothing", () => {
  assert.equal(loadConfig({ ...base, NTFY_BASE_URL: "https://n.example" }).ntfy, undefined);
  assert.equal(loadConfig({ ...base, NTFY_TOPIC: "alerts" }).ntfy, undefined);
  // The info topic is *not* part of the all-or-nothing rule: it is optional, and its absence falls
  // back to the alert topic rather than disabling alerting or dropping routine notices on the floor.
  const c = loadConfig({ ...base, NTFY_BASE_URL: "https://n.example", NTFY_TOPIC: "alerts" });
  assert.deepEqual(c.ntfy, { baseUrl: "https://n.example", topic: "alerts", infoTopic: "alerts", token: "" });
});

void test("NTFY_TOPIC_INFO splits routine notices off the alert topic", () => {
  const c = loadConfig({
    ...base,
    NTFY_BASE_URL: "https://n.example",
    NTFY_TOPIC: "alerts",
    NTFY_TOPIC_INFO: "infos",
    NTFY_TOKEN: "tk_x",
  });
  assert.deepEqual(c.ntfy, { baseUrl: "https://n.example", topic: "alerts", infoTopic: "infos", token: "tk_x" });
  // An empty value is the unset spelling, not a topic named "".
  const blank = loadConfig({ ...base, NTFY_BASE_URL: "https://n.example", NTFY_TOPIC: "alerts", NTFY_TOPIC_INFO: "" });
  assert.equal(blank.ntfy?.infoTopic, "alerts");
});

// Every variable is read by its exact, fully spelled name. A near miss — a shorter prefix, a
// plausible abbreviation — must be ignored rather than quietly honoured, because a config that
// answers to more than one spelling makes the deployment's real settings unreadable from its
// manifest: two variables would appear to set the same thing and nothing would say which won.
void test("only the exact documented variable names are consulted", () => {
  const c = loadConfig({ ...base, MCP_READONLY: "1", WHATSAPP_STORE_DIR: "/elsewhere", DATA_DIR: "/elsewhere" });
  assert.equal(c.readOnly, false);
  assert.equal(c.dataDir, "/tmp/whatsapp");
});
