/* The Wayback Machine as the archiver uses it: the availability API to find an existing snapshot, and Save Page Now to request a capture when there is none. Save Page Now documentation: https://docs.google.com/document/d/1Nsv52MvSjbLb2PCpHlat0gkzw0EvtSgpKHu4mk0MnrA/mobilebasic (SPN2 Public API Docs). Availability API: https://archive.org/help/wayback_api.php. */

import { z } from "zod";
import { WaybackTimestampSchema } from "../../src/entry";
import type { ExceptionReason } from "./archive-report";
import { HTTP_STATUS } from "./http-status";
import type { Clock } from "./pacing";
import type { PoliteClient } from "./polite-client";

/** Where the availability API answers. */
export const AVAILABILITY_URL = "https://archive.org/wayback/available";

/** Save Page Now's endpoint: a GET of `<endpoint>/<url>` captures anonymously, a POST of `url=<url>` captures as the holder of an S3-style key pair. */
export const SAVE_URL = "https://web.archive.org/save";

const BYTES_PER_GIBIBYTE = 1_073_741_824;

/** The largest file Save Page Now captures: its documented maximum resource size of 2 GB, taken as binary gigabytes so a file in the gap between the two readings is attempted and refused by the service, which classifies it, rather than skipped on a guess. */
export const ARCHIVE_SIZE_LIMIT_BYTES = 2 * BYTES_PER_GIBIBYTE;

/** How long a client waits between two requests to one of the Wayback Machine's hosts. A request a second kept up for hours got the connection from one machine refused outright (the host answered other addresses throughout), and the Machine documents no rate for replay or the capture index, so this is chosen and not documented: a request every five seconds. */
export const WAYBACK_HOST_INTERVAL_MILLISECONDS = 5000;
export const WAYBACK_HOST_INTERVALS: Readonly<Record<string, number>> = { "web.archive.org": WAYBACK_HOST_INTERVAL_MILLISECONDS, "archive.org": WAYBACK_HOST_INTERVAL_MILLISECONDS };

/** The documented capture limits for a visitor with no account and for one with a key pair: captures a minute and captures a day (SPN2 Public API Docs, "Limitations"). */
export const ANONYMOUS_LIMITS = { capturesPerMinute: 3, capturesPerDay: 200 } as const;
export const AUTHENTICATED_LIMITS = { capturesPerMinute: 7, capturesPerDay: 30_000 } as const;

/** How often a pending capture is asked about, and how long it is waited on in all: the service's documented longest capture is two minutes, so a job still pending after that is not going to finish within the status record's life. */
export const STATUS_POLL_MILLISECONDS = 5000;
export const MAX_CAPTURE_WAIT_MILLISECONDS = 150_000;

/** The failure of the Wayback Machine to answer a question the archiver put to it: an unusable status, a body that is not the documented shape, or credentials it rejects. The archiver stops rather than guess. */
export class WaybackError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WaybackError";
  }
}

/** The availability API answered with a status that says it is busy or failing, which says nothing about the URL asked about. */
export class WaybackBusy extends WaybackError {
  constructor(message: string) {
    super(message);
    this.name = "WaybackBusy";
  }
}

const AvailabilitySchema = z.looseObject({
  archived_snapshots: z.looseObject({
    closest: z.looseObject({ available: z.boolean(), status: z.string(), timestamp: WaybackTimestampSchema }).optional(),
  }),
});

/**
 * The timestamp of the Wayback Machine's closest successful capture of a URL.
 * @param client - The polite client.
 * @param url - The URL.
 * @returns The capture's timestamp, or undefined when the Machine holds none that answered 200.
 * @throws WaybackBusy when the service answers with a failing status; WaybackError when it answers with a body that is not the documented shape.
 */
export async function findSnapshot(client: PoliteClient, url: string): Promise<string | undefined> {
  const response = await client.request(`${AVAILABILITY_URL}?${new URLSearchParams({ url }).toString()}`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new WaybackBusy(`the availability API answered ${String(response.status)} for ${url}`);
  }
  const parsed = AvailabilitySchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new WaybackError(`the availability API answered with an unrecognised body for ${url}`, { cause: parsed.error });
  }
  const { closest } = parsed.data.archived_snapshots;

  return closest?.available === true && closest.status === "200" ? closest.timestamp : undefined;
}

/** What asking for a capture came to. `saved` carries the capture's timestamp. `refused` is the service's or the host's definite no, with the reason it belongs under and what was observed. `retry` is a failure that says nothing about the URL (a busy service, a timeout), so the URL stays unresolved. `exhausted` means the account's own limit is spent, so asking for more captures is pointless for now. */
export type SaveOutcome =
  | { readonly kind: "saved"; readonly timestamp: string }
  | { readonly kind: "refused"; readonly reason: ExceptionReason; readonly evidence: string }
  | { readonly kind: "retry"; readonly evidence: string }
  | { readonly kind: "exhausted"; readonly evidence: string };

/** The `status_ext` codes of Save Page Now that are a definite no, by reason (SPN2 Public API Docs, error codes). Codes that describe the service's or the network's passing trouble are deliberately absent: they are retried. */
const REFUSALS: Readonly<Record<string, ExceptionReason>> = {
  "error:filesize-limit": "size-limit",
  "error:blocked-url": "excluded",
  "error:blocked": "access-wall",
  "error:no-access": "access-wall",
  "error:unauthorized": "access-wall",
  "error:bad-request": "access-wall",
  "error:not-found": "source-error",
  "error:invalid-host-resolution": "source-error",
  "error:invalid-url-syntax": "source-error",
  "error:too-many-redirects": "source-error",
  "error:method-not-allowed": "source-error",
  "error:not-implemented": "source-error",
};

/** The `status_ext` codes that mean the account (or this network address) has used up what Save Page Now allows today. */
const EXHAUSTIONS: ReadonlySet<string> = new Set(["error:too-many-daily-captures", "error:max-daily-bandwidth", "error:max-daily-bandwidth-from-ip", "error:blocked-client-ip"]);

/**
 * Sorts a Save Page Now error into the outcome it stands for.
 * @param statusExt - The error's `status_ext` code, when it has one.
 * @param message - The service's message, kept as the evidence of a retry.
 * @returns The outcome.
 */
export function classifySaveError(statusExt: string | undefined, message: string | undefined): SaveOutcome {
  const evidence = statusExt ?? message ?? "unspecified error";
  if (statusExt !== undefined && EXHAUSTIONS.has(statusExt)) {
    return { kind: "exhausted", evidence };
  }
  const reason = statusExt === undefined ? undefined : REFUSALS[statusExt];

  return reason === undefined ? { kind: "retry", evidence } : { kind: "refused", reason, evidence };
}

/** The timestamp in a `/web/<timestamp>/<url>` path, as a capture's redirect and `Content-Location` give it. */
const CAPTURE_PATH = /\/web\/(\d{14})\//;

/** The exceptions the Wayback Machine raises for a URL it will not capture or replay, as its `x-archive-wayback-runtime-error` header names them: a robots exclusion and an administrative block. */
const EXCLUSION_ERRORS = /RobotAccessControlException|AdministrativeAccessControlException/;

/**
 * Asks for a capture with no account: a GET of `<save endpoint>/<url>`, which captures synchronously and redirects to the new capture.
 * @param client - The polite client; it must not retry, because every request is a capture that counts against the day's limit.
 * @param url - The URL to capture.
 * @returns The outcome.
 */
export async function saveAnonymously(client: PoliteClient, url: string): Promise<SaveOutcome> {
  const response = await client.request(`${SAVE_URL}/${url}`, { redirect: "manual" });
  await response.body?.cancel();
  const timestamp = CAPTURE_PATH.exec(response.headers.get("location") ?? response.headers.get("content-location") ?? "")?.[1];
  if (timestamp !== undefined) {
    return { kind: "saved", timestamp };
  }
  const runtimeError = response.headers.get("x-archive-wayback-runtime-error") ?? "";
  if (EXCLUSION_ERRORS.test(runtimeError)) {
    return { kind: "refused", reason: "excluded", evidence: runtimeError };
  }

  return { kind: "retry", evidence: `HTTP ${String(response.status)}${runtimeError === "" ? "" : ` ${runtimeError}`}` };
}

/** A key pair for authenticated Save Page Now. The secret is only ever put in the `Authorization` header of a request to the save endpoint. */
export interface Credentials {
  readonly accessKey: string;
  readonly secretKey: string;
}

const SaveErrorBodySchema = z.looseObject({ status_ext: z.string().optional(), message: z.string().optional() });
const JobSchema = z.looseObject({ job_id: z.string().min(1) });
const StatusSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("pending") }),
  z.looseObject({ status: z.literal("success"), timestamp: WaybackTimestampSchema }),
  z.looseObject({ status: z.literal("error"), status_ext: z.string().optional(), message: z.string().optional() }),
]);

/**
 * A response's body as JSON. A busy or failing service answers with an HTML page, which is the service's passing trouble and not a malformed answer to the documented API.
 * @param response - The response.
 * @returns The parsed body, or undefined when the body is not JSON.
 */
async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Asks for a capture as the holder of a key pair: a POST that returns a job, then the job's status until it is no longer pending.
 * @param client - The polite client; it must not retry, because every request is a capture that counts against the day's limit.
 * @param clock - Sleeps between status requests.
 * @param credentials - The key pair.
 * @param url - The URL to capture.
 * @returns The outcome.
 * @throws WaybackError when the key pair is rejected or the service answers with an unrecognised body.
 */
export async function saveAuthenticated(client: PoliteClient, clock: Clock, credentials: Credentials, url: string): Promise<SaveOutcome> {
  const headers = { accept: "application/json", authorization: `LOW ${credentials.accessKey}:${credentials.secretKey}` };
  const start = await client.request(SAVE_URL, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url }).toString() });
  const body = await jsonBody(start);
  if (start.status === HTTP_STATUS.unauthorized || start.status === HTTP_STATUS.forbidden) {
    throw new WaybackError(`Save Page Now rejected the Internet Archive key pair (HTTP ${String(start.status)})`);
  }
  if (body === undefined) {
    return { kind: "retry", evidence: `HTTP ${String(start.status)} without a JSON body` };
  }
  const job = JobSchema.safeParse(body);
  if (!job.success) {
    const failure = SaveErrorBodySchema.safeParse(body);
    if (failure.success && (failure.data.status_ext !== undefined || failure.data.message !== undefined)) {
      return classifySaveError(failure.data.status_ext, failure.data.message);
    }
    throw new WaybackError(`Save Page Now answered ${String(start.status)} with an unrecognised body for ${url}`, { cause: job.error });
  }

  return pollJob({ client, clock, headers, jobId: job.data.job_id }, 0);
}

/**
 * Asks about a capture job until it is no longer pending or the wait for it ends.
 * @param job - The polite client, the clock that sleeps between status requests, the request headers with the authorisation, and the job's id.
 * @param waited - How long the job has been waited on, in milliseconds.
 * @returns The outcome.
 * @throws WaybackError when the service answers with a body that is not the documented shape.
 */
async function pollJob(job: Readonly<{ client: PoliteClient; clock: Clock; headers: Readonly<Record<string, string>>; jobId: string }>, waited: number): Promise<SaveOutcome> {
  const { client, clock, headers, jobId } = job;
  if (waited > MAX_CAPTURE_WAIT_MILLISECONDS) {
    return { kind: "retry", evidence: "the capture was still pending when the wait ended" };
  }
  await clock.sleep(STATUS_POLL_MILLISECONDS);
  const poll = await client.request(`${SAVE_URL}/status/${jobId}`, { headers });
  const pollBody = await jsonBody(poll);
  if (pollBody === undefined) {
    return { kind: "retry", evidence: `HTTP ${String(poll.status)} without a JSON body for the job's status` };
  }
  const status = StatusSchema.safeParse(pollBody);
  if (!status.success) {
    throw new WaybackError(`Save Page Now answered the status of job ${jobId} with an unrecognised body`, { cause: status.error });
  }
  if (status.data.status === "success") {
    return { kind: "saved", timestamp: status.data.timestamp };
  }
  if (status.data.status === "error") {
    return classifySaveError(status.data.status_ext, status.data.message);
  }

  return pollJob(job, waited + STATUS_POLL_MILLISECONDS);
}
