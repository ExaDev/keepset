/* The HTTP statuses the source scripts act on, named, and the status classes (RFC 9110, section 15) they test against. */

/** The statuses the scripts treat specially. 999 is not a standard status: LinkedIn and a few other hosts answer an automated client with it, and the Save Page Now documentation lists it as its blocked-target code. */
export const HTTP_STATUS = {
  ok: 200,
  partialContent: 206,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  gone: 410,
  tooManyRequests: 429,
  internalServerError: 500,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
  automatedClientBlocked: 999,
} as const;

/** A status's class is its hundreds digit. */
const CLASS_DIVISOR = 100;
const SUCCESS_CLASS = 2;
const CLIENT_ERROR_CLASS = 4;

/**
 * Whether a status is a success (2xx).
 * @param status - An HTTP status.
 * @returns True for 200 to 299.
 */
export function isSuccess(status: number): boolean {
  return Math.trunc(status / CLASS_DIVISOR) === SUCCESS_CLASS;
}

/**
 * Whether a status is a client error (4xx).
 * @param status - An HTTP status.
 * @returns True for 400 to 499.
 */
export function isClientError(status: number): boolean {
  return Math.trunc(status / CLASS_DIVISOR) === CLIENT_ERROR_CLASS;
}

/**
 * Whether a status says the host refuses this client rather than that the file is missing: unauthorised, forbidden, or the automated-client block.
 * @param status - An HTTP status.
 * @returns True for 401, 403 and 999.
 */
export function isRefusal(status: number): boolean {
  return status === HTTP_STATUS.unauthorized || status === HTTP_STATUS.forbidden || status === HTTP_STATUS.automatedClientBlocked;
}
