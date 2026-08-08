import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const base = { WHATSAPP_API_URL: "http://api:8080" } satisfies NodeJS.ProcessEnv;

void test("defaults are applied", () => {
  const c = loadConfig({ ...base });
  assert.equal(c.apiUrl, "http://api:8080");
  assert.equal(c.apiToken, undefined);
  assert.equal(c.mcpToken, undefined);
  assert.equal(c.httpPath, "/mcp");
  assert.equal(c.port, 8080);
  // The API's fixed 30 minutes, in milliseconds.
  assert.equal(c.sessionTtlMs, 1_800_000);
  assert.equal(c.maxResultChars, 200_000);
  assert.equal(c.maxUploadBytes, 64 * 1024 * 1024);
  assert.equal(c.requestTimeoutMs, 30_000);
  assert.equal(c.transcribeTimeoutMs, 960_000);
});

void test("this process is configured with ten values and knows nothing about WhatsApp", () => {
  // The split, as an assertion. A field named after the account, the store, a transcription backend
  // or an alerting channel appearing here means responsibility has leaked back across the boundary,
  // and the tool that would read it should be growing an SDK call instead (spec §9).
  assert.deepEqual(Object.keys(loadConfig({ ...base })).sort(), [
    "apiToken",
    "apiUrl",
    "httpPath",
    "maxResultChars",
    "maxUploadBytes",
    "mcpToken",
    "port",
    "requestTimeoutMs",
    "sessionTtlMs",
    "transcribeTimeoutMs",
  ]);
});

void test("the API URL is required, and absent is a boot failure rather than a default", () => {
  // A default of `http://api:8080` — the value the shipped compose file uses — would turn a missing
  // variable into a DNS failure reported once per tool call as an unreachable API.
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ WHATSAPP_API_URL: "" }), ConfigError);
  assert.throws(() => loadConfig({ WHATSAPP_API_URL: "   " }), ConfigError);
});

void test("the API URL must be an absolute http(s) URL", () => {
  assert.equal(loadConfig({ WHATSAPP_API_URL: "https://api.example/" }).apiUrl, "https://api.example");
  assert.equal(loadConfig({ WHATSAPP_API_URL: "  http://api:8080///  " }).apiUrl, "http://api:8080");
  // A relative path, or a scheme `fetch` cannot speak, is a mistake worth naming at boot rather
  // than a `TypeError` from inside a tool call.
  assert.throws(() => loadConfig({ WHATSAPP_API_URL: "api:8080" }), ConfigError);
  assert.throws(() => loadConfig({ WHATSAPP_API_URL: "/v1" }), ConfigError);
  assert.throws(() => loadConfig({ WHATSAPP_API_URL: "ws://api:8080" }), ConfigError);
  assert.throws(() => loadConfig({ WHATSAPP_API_URL: "file:///tmp/api" }), ConfigError);
});

void test("a credential in the API URL is refused, and the refusal does not repeat it", () => {
  // `fetch` refuses a URL carrying userinfo outright, so stripping it silently would leave a
  // deployment believing it authenticates that way while every request failed. And the value must
  // never reach the message: a base URL's password is a secret (Global Constraint 8).
  assert.throws(
    () => loadConfig({ WHATSAPP_API_URL: "http://mcp:hunter2@api:8080" }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, `expected a ConfigError, got ${String(err)}`);
      assert.doesNotMatch(err.message, /hunter2/);
      assert.match(err.message, /WHATSAPP_API_TOKEN/, "and it says what to use instead");
      return true;
    },
  );
  assert.throws(() => loadConfig({ WHATSAPP_API_URL: "http://mcp@api:8080" }), ConfigError);
});

void test("an empty API token is absent, so the empty string is never presented as a bearer", () => {
  assert.equal(loadConfig({ ...base, WHATSAPP_API_TOKEN: "" }).apiToken, undefined);
  assert.equal(loadConfig({ ...base, WHATSAPP_API_TOKEN: "tok" }).apiToken, "tok");
});

void test("the MCP token is read raw, because http.ts already treats empty as absent", () => {
  // Normalising it here would hide the one place that decides whether the MCP path is gated at all.
  assert.equal(loadConfig({ ...base, WHATSAPP_MCP_TOKEN: "" }).mcpToken, "");
  assert.equal(loadConfig({ ...base, WHATSAPP_MCP_TOKEN: "s3cret" }).mcpToken, "s3cret");
});

void test("numeric vars fall back on garbage and clamp on range", () => {
  const c = (env: NodeJS.ProcessEnv) => loadConfig({ ...base, ...env });
  assert.equal(c({ PORT: "not-a-number" }).port, 8080);
  assert.equal(c({ PORT: "0" }).port, 8080);
  assert.equal(c({ PORT: "70000" }).port, 65535);
  assert.equal(c({ WHATSAPP_MCP_MAX_RESULT_CHARS: "-5" }).maxResultChars, 200_000);
  assert.equal(c({ WHATSAPP_MCP_MAX_RESULT_CHARS: "10" }).maxResultChars, 1_000);
  assert.equal(c({ WHATSAPP_MAX_UPLOAD_BYTES: "999999999999" }).maxUploadBytes, 256 * 1024 * 1024);
  assert.equal(c({ WHATSAPP_MAX_UPLOAD_BYTES: "2048" }).maxUploadBytes, 2048);
});

void test("the session TTL is seconds in and milliseconds out", () => {
  const ttl = (v: string): number => loadConfig({ ...base, WHATSAPP_MCP_SESSION_TTL: v }).sessionTtlMs;
  assert.equal(ttl("60"), 60_000);
  assert.equal(ttl("5"), 60_000, "shorter than a client's own poll interval would evict a live session");
  assert.equal(ttl("999999"), 86_400_000);
  assert.equal(ttl("nonsense"), 1_800_000);
});

void test("the transcribe deadline is its own knob, with bounds set above the shared one", () => {
  const c = (env: NodeJS.ProcessEnv) => loadConfig({ ...base, ...env });
  assert.equal(c({ WHATSAPP_MCP_REQUEST_TIMEOUT_MS: "999999" }).requestTimeoutMs, 300_000);
  assert.equal(c({ WHATSAPP_MCP_REQUEST_TIMEOUT_MS: "10" }).requestTimeoutMs, 1_000);
  assert.equal(c({ WHATSAPP_MCP_TRANSCRIBE_TIMEOUT_MS: "1" }).transcribeTimeoutMs, 60_000);
  assert.equal(c({ WHATSAPP_MCP_TRANSCRIBE_TIMEOUT_MS: "99999999" }).transcribeTimeoutMs, 3_900_000);
  // The two comparisons that make one shared deadline wrong. The API's own transcribe timeout
  // defaults to 900_000 and clamps to an hour; both of this knob's bounds clear those, so the SDK is
  // never the component that abandons a transcription the other side is still working on — while a
  // `requestTimeoutMs` stretched that far would give every ordinary read a fifteen-minute rope.
  assert.ok(c({}).transcribeTimeoutMs > 900_000, "the default clears the API's default");
  assert.ok(
    c({ WHATSAPP_MCP_TRANSCRIBE_TIMEOUT_MS: "99999999" }).transcribeTimeoutMs > 3_600_000,
    "and the ceiling clears the API's ceiling",
  );
});

// Every variable is read by its exact, fully spelled name. A near miss — a shorter prefix, a
// plausible abbreviation — must be ignored rather than quietly honoured, because a config that
// answers to more than one spelling makes the deployment's real settings unreadable from its
// manifest: two variables would appear to set the same thing and nothing would say which won.
void test("only the exact documented variable names are consulted", () => {
  const c = loadConfig({ ...base, API_URL: "http://elsewhere", WHATSAPP_MCP_URL: "http://elsewhere", MCP_TOKEN: "x" });
  assert.equal(c.apiUrl, "http://api:8080");
  assert.equal(c.mcpToken, undefined);
});
