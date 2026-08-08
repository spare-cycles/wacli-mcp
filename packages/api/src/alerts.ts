/**
 * ntfy alerting, driven by the connection's state changes.
 *
 * This is the retired supervisor's debounce with its input replaced. That process polled a heartbeat
 * file because the connection lived in a *different* process; here `whatsapp/connection.ts` calls
 * `onState` directly, so the state machine is fed by events and the heartbeat file is gone with the
 * process that needed it.
 *
 * The rules it keeps, and why:
 *
 * - A brief drop is not an incident. WhatsApp closes sockets routinely and the backoff reconnects
 *   within seconds, so a non-connected state must survive `graceMs` before anyone is woken up.
 * - While still down it re-publishes on `realertMs`, because a single notification at 03:00 is a
 *   notification nobody sees.
 * - `logged_out` skips the grace entirely and goes out at once. It is terminal: no backoff recovers
 *   it, someone has to re-pair the device, and every second of grace is a second wasted.
 * - Recovery is announced only if a down alert actually went out, so a drop that healed inside the
 *   grace stays silent in both directions.
 * - `pairing` is a down state like any other, but it is not a *disconnection*, and the notice says
 *   so. A deployment that has never been paired sits there forever with nothing to reconnect to,
 *   and paging its operator with "disconnected for ~N min" names the wrong problem and no remedy.
 *
 * Two invariants this module owes the rest of the server. **A publish failure never propagates** —
 * `onState` is called from inside the connection's state machine, so an exception here would climb
 * back into the socket's event handler; every failure is a `warn` and nothing more. And **every
 * timer is unref'd**, so an armed grace or cadence can never be the reason the process refuses to
 * exit.
 *
 * Global Constraint 8: `NTFY_TOKEN` travels in a header and appears in no log line. Nothing here
 * logs the config object, the headers, or the token — not even at debug, and not in an error.
 */

import type { Config, NtfyConfig } from "./config.js";
import type { Logger } from "pino";
import type { ConnectionState } from "./whatsapp/connection.js";

export type Alerter = {
  /** Feed a connection state transition in. Never throws. */
  onState: (s: ConnectionState) => void;
  /**
   * Publish a one-off notice on the alert topic, for an incident this module does not itself watch.
   *
   * Exists so that the transcription budget's hard stop — which is a spending incident, not a
   * connection one — reaches the same phone as everything else instead of growing a second ntfy
   * client with its own copy of the token handling and the same "never let alerting take the socket
   * down" rule. Fire-and-forget and never throws, exactly like `onState`.
   */
  notify: (title: string, message: string) => void;
  /** Publish a startup notice, proving the token and the egress work before the first real incident. */
  selfTest: () => Promise<void>;
  /** Cancel whatever is armed. Safe to call twice. */
  stop: () => void;
};

/**
 * Schedule `fn` after `ms` and return a canceller.
 *
 * A seam rather than a raw `setTimeout` so a test can assert *what was scheduled and for how long*
 * without waiting out a six-minute grace period, and so the production default can own the `unref()`
 * in one place instead of at every call site.
 */
export type Schedule = (fn: () => void, ms: number) => () => void;

export type AlerterDeps = {
  config: Config;
  logger: Logger;
  fetchImpl?: typeof fetch | undefined;
  /** How long a non-connected state must persist before it is an incident. */
  graceMs?: number | undefined;
  /** How often to re-publish while still down. */
  realertMs?: number | undefined;
  schedule?: Schedule | undefined;
};

/** The retired supervisor's `SYNC_STALE_SEC` default, in the milliseconds a timer takes. */
export const DEFAULT_GRACE_MS = 360_000;
/** The retired supervisor's `SYNC_REALERT_SEC` default. */
export const DEFAULT_REALERT_MS = 1_800_000;

/** A publish that cannot complete in this long is a failure; the cadence will try again. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The production timer: armed, then immediately unref'd so it never holds the process open. */
export function unrefSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

/**
 * Which ntfy topic a notice belongs on.
 *
 * `alert` is the incident channel and `info` is the routine one, so the split is by *audience*, not
 * by sentiment: recovery is good news and still goes to `alert`, because a subscriber who sees
 * "disconnected" on that topic and never sees the all-clear is worse off than one who sees neither.
 * The pair belongs together in one thread. Only genuinely routine traffic — the startup self-test —
 * is `info`.
 */
type Channel = "alert" | "info";

type Notice = { title: string; message: string; priority: number; tags: string[]; channel: Channel };

/** What the current non-connected episode is, or `null` when the connection is up. */
type Episode = "down" | "logged_out";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function minutesSince(sec: number | null): number {
  return sec === null ? 0 : Math.max(0, Math.floor((nowSec() - sec) / 60));
}

export function makeAlerter(deps: AlerterDeps): Alerter {
  const { config, logger } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const schedule = deps.schedule ?? unrefSchedule;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const realertMs = deps.realertMs ?? DEFAULT_REALERT_MS;
  const ntfy: NtfyConfig | undefined = config.ntfy;

  let episode: Episode | null = null;
  /**
   * The connection state the notice should describe. Not the same thing as the `Episode`: "down"
   * covers three states that need three different things said about them.
   */
  let episodeState: ConnectionState | null = null;
  let episodeSince: number | null = null;
  /** Whether this episode has already been published, which is what makes recovery worth announcing. */
  let alerted = false;
  let cancel: (() => void) | undefined;

  if (ntfy === undefined) {
    logger.info("alerts: ntfy is not configured; connection alerts are disabled");
  }

  async function publish(notice: Notice): Promise<void> {
    if (ntfy === undefined) return;
    const headers: Record<string, string> = { "content-type": "application/json" };
    // An empty token is the "no auth" spelling `loadConfig` produces; sending `Bearer ` would be a
    // malformed credential rather than none at all.
    if (ntfy.token !== "") headers["authorization"] = `Bearer ${ntfy.token}`;
    const body = JSON.stringify({
      topic: notice.channel === "info" ? ntfy.infoTopic : ntfy.topic,
      title: notice.title,
      message: notice.message,
      priority: notice.priority,
      tags: notice.tags,
    });
    try {
      const res = await fetchImpl(ntfy.baseUrl, {
        method: "POST",
        headers,
        body,
        // Bounded so a black-holed ntfy leaks one socket per alert instead of one per alert forever.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) logger.warn({ status: res.status, title: notice.title }, "alerts: ntfy publish rejected");
    } catch (err) {
      // Deliberately swallowed: `onState` runs inside the connection's own event handler, and an
      // alerting failure must never be the thing that takes the WhatsApp socket down.
      logger.warn({ err, title: notice.title }, "alerts: ntfy publish failed");
    }
  }

  function downNotice(): Notice {
    const mins = minutesSince(episodeSince);
    const since = episodeSince === null ? "an unknown time" : isoOf(episodeSince);
    // A first deployment sits in `pairing` indefinitely and is *not* a disconnection: nothing
    // dropped, nothing is going to reconnect, and the operator is holding a page that names the
    // wrong problem and no remedy. `whatsapp/connection.ts` already logs an error for the missing
    // `WHATSAPP_PHONE_NUMBER`, but nobody reads container logs at 03:00 — the notification is the one
    // place the fix has to be spelled out.
    if (episodeState === "pairing") {
      return {
        title: "🔗 whatsapp-mcp waiting to be paired",
        message: `WhatsApp is not linked: the server has been waiting to be paired for ~${mins} min (since ${since}). Set WHATSAPP_PHONE_NUMBER (E.164 digits, no leading "+") and restart, then enter the pairing code from the logs in WhatsApp → Linked devices. Stored reads still answer; sends and media downloads do not.`,
        priority: 5,
        tags: ["rotating_light", "link"],
        channel: "alert",
      };
    }
    return {
      title: "🚨 whatsapp-mcp disconnected",
      message: `WhatsApp has been disconnected for ~${mins} min (since ${since}). Stored reads still answer; sends and media downloads do not.`,
      priority: 5,
      tags: ["rotating_light"],
      channel: "alert",
    };
  }

  function loggedOutNotice(): Notice {
    return {
      title: "🚨 whatsapp-mcp logged out",
      message:
        "WhatsApp logged this device out. Nothing reconnects on its own: the device has to be paired again (set WHATSAPP_PHONE_NUMBER and restart to get a pairing code).",
      priority: 5,
      tags: ["rotating_light", "no_entry"],
      channel: "alert",
    };
  }

  function recoveryNotice(downFor: number): Notice {
    return {
      title: "✅ whatsapp-mcp reconnected",
      message: `WhatsApp reconnected at ${isoOf(nowSec())} after ~${downFor} min.`,
      priority: 3,
      tags: ["white_check_mark"],
      channel: "alert",
    };
  }

  function disarm(): void {
    if (cancel !== undefined) {
      cancel();
      cancel = undefined;
    }
  }

  function arm(ms: number): void {
    disarm();
    cancel = schedule(fire, ms);
  }

  /** The grace expiring, or the cadence coming round: publish for the episode, then re-arm. */
  function fire(): void {
    cancel = undefined;
    alerted = true;
    void publish(episode === "logged_out" ? loggedOutNotice() : downNotice());
    arm(realertMs);
  }

  function onDown(s: ConnectionState): void {
    if (episode !== null) {
      // An episode already running — armed grace or ongoing cadence — must not be restarted by the
      // next `connecting`/`disconnected` flap, or a connection that never settles would never
      // alert. The *diagnosis* still improves though: a first boot is `connecting` → `pairing`, so
      // the state that opened the episode is the uninformative one and only this upgrade keeps the
      // notice from saying "disconnected" about a server that has simply never been paired. It
      // touches nothing else — same timer, same `episodeSince`, same cadence.
      if (s === "pairing") episodeState = "pairing";
      return;
    }
    episode = "down";
    episodeState = s;
    episodeSince = nowSec();
    alerted = false;
    arm(graceMs);
  }

  function onLoggedOut(): void {
    if (episode === "logged_out") return;
    episode = "logged_out";
    episodeState = "logged_out";
    episodeSince = nowSec();
    alerted = true;
    void publish(loggedOutNotice());
    arm(realertMs);
  }

  function onConnected(): void {
    disarm();
    const recovered = alerted;
    const downFor = minutesSince(episodeSince);
    episode = null;
    episodeState = null;
    episodeSince = null;
    alerted = false;
    if (recovered) void publish(recoveryNotice(downFor));
  }

  function onState(s: ConnectionState): void {
    if (ntfy === undefined) return;
    switch (s) {
      case "connected":
        onConnected();
        break;
      case "logged_out":
        onLoggedOut();
        break;
      // `pairing` joins the down states: it is not serving traffic, and the connection reaches it
      // both on a first pairing and after a logout, so it must not be treated as healthy.
      case "connecting":
      case "disconnected":
      case "pairing":
        onDown(s);
        break;
    }
  }

  /**
   * A one-off notice from elsewhere in the process. See `Alerter.notify`.
   *
   * Priority 4 and the `money_with_wings` tag, matching the down notice's urgency: the only caller
   * today is a spending cap being hit, which is something to see now rather than in the morning.
   * `void`, not awaited, because callers are synchronous paths that must not block on ntfy —
   * `publish` already swallows every failure of its own.
   */
  function notify(title: string, message: string): void {
    void publish({ title, message, priority: 4, tags: ["money_with_wings"], channel: "alert" });
  }

  async function selfTest(): Promise<void> {
    await publish({
      title: "whatsapp-mcp started",
      message: `Server up at ${isoOf(nowSec())}; connecting to WhatsApp…`,
      priority: 2,
      tags: ["information_source"],
      channel: "info",
    });
  }

  /**
   * Cancel what is armed and forget the episode.
   *
   * The reset matters as much as the cancel: without it a stopped alerter that is fed states again
   * sees `episode !== null`, decides an episode is already running, and never arms anything — a
   * silent alerter that looks alive.
   */
  function stop(): void {
    disarm();
    episode = null;
    episodeState = null;
    episodeSince = null;
    alerted = false;
  }

  return { onState, notify, selfTest, stop };
}
