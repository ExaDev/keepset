/* A polite HTTP client for the scripts that visit every recorded source: it identifies itself, spaces requests out per host and across all hosts, and tries again with backoff when a host is busy or the connection fails. The platform `fetch` is injected, so no unit test touches the network. */

import { HTTP_STATUS } from "./http-status";
import { type Clock, Pacer } from "./pacing";

/** The network port: the platform `fetch`, or a stand-in under test. */
export type FetchPort = (url: string, init: RequestInit) => Promise<Response>;

/** What the scripts say they are, so a server operator can tell where the traffic comes from. */
export const USER_AGENT = "keepset (+https://github.com/Mearman/keepset)";

/** The statuses that mean the host is busy or failing for now and may answer later (RFC 6585 for 429, RFC 9110 for the 5xx): a request answered with one of these is tried again. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set<number>([HTTP_STATUS.tooManyRequests, HTTP_STATUS.internalServerError, HTTP_STATUS.badGateway, HTTP_STATUS.serviceUnavailable, HTTP_STATUS.gatewayTimeout]);

/** The most a wait before a retry may last, whatever `Retry-After` asks. A host that wants longer than this is left to the caller to classify as busy, not waited on for the whole run. */
export const MAX_RETRY_WAIT_MILLISECONDS = 120_000;

/** How the client paces and retries; each field is the caller's, with `DEFAULT_POLITENESS` as the shared starting point. */
export interface Politeness {
  /** The least time between two requests to one host. */
  readonly hostIntervalMilliseconds: number;
  /** The least time between two requests to any host. */
  readonly globalIntervalMilliseconds: number;
  /** How many times a request is made before its last answer or failure is given back. */
  readonly attempts: number;
  /** The wait before the second attempt; each later wait doubles it. */
  readonly backoffMilliseconds: number;
  /** How long one attempt may take before it is abandoned. */
  readonly timeoutMilliseconds: number;
}

/** The pacing the scripts share. A host sees at most one request a second from this client, which is gentle for a single visitor and still gets through a catalogue whose sources cluster on a few hosts; the global interval keeps one process from flooding a shared network link with requests to many hosts at once. Backoff starts at two seconds and doubles over three attempts, which waits out a brief overload without hammering it, and an attempt is abandoned after the stall time the recipe downloader also gives a silent connection. */
export const DEFAULT_POLITENESS: Politeness = {
  hostIntervalMilliseconds: 1000,
  globalIntervalMilliseconds: 100,
  attempts: 3,
  backoffMilliseconds: 2000,
  timeoutMilliseconds: 120_000,
};

const MILLISECONDS_PER_SECOND = 1000;

/** The key the global limit is paced under. A host name is never empty, so it cannot collide with one. */
const GLOBAL_KEY = "";

/** A request that failed on the connection on every attempt: the host did not resolve, refused, reset, timed out or failed its certificate. `code` is the system or undici error code when there is one. */
export class RequestFailure extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RequestFailure";
  }
}

/**
 * The error code a failed `fetch` carries. The platform wraps the cause in a `TypeError("fetch failed")`, and the cause (or its own cause) holds the code.
 * @param error - What `fetch` threw.
 * @returns The code, or undefined when there is none.
 */
export function failureCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  if ("name" in error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "TIMEOUT";
  }

  return "cause" in error ? failureCode(error.cause) : undefined;
}

/**
 * How long a `Retry-After` header asks to wait: seconds, or an HTTP date (RFC 9110, section 10.2.3).
 * @param header - The header's value.
 * @param now - The current instant in milliseconds.
 * @returns The wait in milliseconds, or undefined when the header is absent or unreadable.
 */
export function retryAfterMilliseconds(header: string | null, now: number): number | undefined {
  if (header === null) {
    return undefined;
  }
  if (/^\d+$/.test(header)) {
    return Number(header) * MILLISECONDS_PER_SECOND;
  }
  const date = Date.parse(header);

  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** A client that paces and retries every request it makes. */
export class PoliteClient {
  private readonly pacer: Pacer;

  constructor(
    private readonly fetchPort: FetchPort,
    private readonly clock: Clock,
    private readonly politeness: Politeness,
  ) {
    this.pacer = new Pacer(clock);
  }

  /**
   * Sends a request, paced per host and globally, and sends it again after a busy or failed answer.
   * @param url - The URL.
   * @param init - The request options. The client adds its own `User-Agent`, and the request's abort signal is its own timeout.
   * @returns The last answer: a success, a status that is not worth retrying, or the final busy answer once the attempts are used up.
   * @throws RequestFailure when the connection failed on every attempt.
   */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.attempt(url, init, 1);
  }

  /**
   * One attempt of a request, and the attempts after it while the answer is busy or the connection fails.
   * @param url - The URL.
   * @param init - The request options.
   * @param attempt - Which attempt this is, from 1.
   * @returns The answer to return.
   * @throws RequestFailure when this is the last attempt and the connection failed.
   */
  private async attempt(url: string, init: RequestInit, attempt: number): Promise<Response> {
    const { host } = new URL(url);
    const { attempts, backoffMilliseconds, globalIntervalMilliseconds, hostIntervalMilliseconds, timeoutMilliseconds } = this.politeness;
    await this.pacer.wait(GLOBAL_KEY, globalIntervalMilliseconds);
    await this.pacer.wait(host, hostIntervalMilliseconds);
    const last = attempt === attempts;
    let wait = backoffMilliseconds * 2 ** (attempt - 1);
    try {
      const response = await this.fetchPort(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, ...Object.fromEntries(new Headers(init.headers)) },
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
      if (last || !RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }
      await response.body?.cancel();
      wait = retryAfterMilliseconds(response.headers.get("retry-after"), this.clock.now()) ?? wait;
    } catch (error) {
      if (last) {
        const code = failureCode(error);

        throw new RequestFailure(`${url} could not be reached${code === undefined ? "" : ` (${code})`}`, code, { cause: error });
      }
    }
    await this.clock.sleep(Math.min(wait, MAX_RETRY_WAIT_MILLISECONDS));

    return this.attempt(url, init, attempt + 1);
  }
}
