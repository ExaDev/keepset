/* Time and pacing for the scripts that request recorded sources and the Wayback Machine. Both read the clock and sleep through a `Clock`, so a test drives them with a clock that advances only when they sleep, and no unit test waits. */

/** The two things pacing needs from time: the current instant in milliseconds and a way to wait. */
export interface Clock {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: async (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};

/**
 * Spaces requests out: for each key, no two callers are released less than the interval apart, in the order they asked. A slot is reserved before the caller waits, so any number of concurrent callers on one key line up behind each other and never share an instant. Different keys do not delay one another.
 */
export class Pacer {
  private readonly nextFree = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  /**
   * Waits for the next free slot of a key and reserves the one after it.
   * @param key - What is being protected: a host name, or a constant for a global limit.
   * @param intervalMilliseconds - The least time between two releases for this key.
   * @returns Once the caller may send its request.
   */
  async wait(key: string, intervalMilliseconds: number): Promise<void> {
    const now = this.clock.now();
    const slot = Math.max(now, this.nextFree.get(key) ?? now);
    this.nextFree.set(key, slot + intervalMilliseconds);
    if (slot > now) {
      await this.clock.sleep(slot - now);
    }
  }
}

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * The interval that keeps a request rate at or below a documented limit.
 * @param perMinute - The most requests the service allows in a minute.
 * @returns The least number of milliseconds between two requests.
 */
export function intervalForRate(perMinute: number): number {
  return Math.ceil(MILLISECONDS_PER_MINUTE / perMinute);
}
