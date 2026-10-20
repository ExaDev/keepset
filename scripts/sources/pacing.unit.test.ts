import { describe, expect, it } from "vitest";
import { intervalForRate, Pacer } from "./pacing";
import { at, FakeClock, MINUTE, SECOND } from "./test-support";

const HALF_SECOND = SECOND / 2;
const CALLERS = 4;
const SLOW_RATE = 3;

describe("Pacer", () => {
  it("releases the first caller of a key at once and spaces the next ones by the interval", async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(clock);
    await pacer.wait("host", SECOND);
    expect(clock.sleeps).toEqual([]);
    await pacer.wait("host", SECOND);
    await pacer.wait("host", SECOND);
    expect(clock.sleeps).toEqual([SECOND, SECOND]);
  });

  it("lines up concurrent callers behind each other instead of releasing them together", async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(clock);
    await Promise.all(Array.from({ length: CALLERS }, async () => pacer.wait("host", HALF_SECOND)));
    // Four callers, three gaps of one interval: each caller reserved its slot before any waited, so none shared another's.
    expect(clock.sleeps).toEqual([HALF_SECOND, HALF_SECOND, HALF_SECOND]);
  });

  it("does not make one key wait for another", async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(clock);
    await pacer.wait("a", MINUTE);
    await pacer.wait("b", MINUTE);
    expect(clock.sleeps).toEqual([]);
  });

  it("does not sleep when the interval has already passed", async () => {
    const clock = new FakeClock();
    const pacer = new Pacer(clock);
    await pacer.wait("host", SECOND);
    await clock.sleep(2 * SECOND);
    clock.sleeps.length = 0;
    await pacer.wait("host", SECOND);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("intervalForRate", () => {
  const perMinute = 7;

  it("is the least spacing that keeps a per-minute rate", () => {
    expect(intervalForRate(SLOW_RATE)).toBe(MINUTE / SLOW_RATE);
    expect(intervalForRate(perMinute) * perMinute).toBeGreaterThanOrEqual(MINUTE);
    expect((intervalForRate(perMinute) - 1) * perMinute).toBeLessThan(MINUTE);
    expect(at([intervalForRate(1)], 0)).toBe(MINUTE);
  });
});
