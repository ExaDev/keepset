/* `process` for the browser bundle. The stream packages the bzip2 reader depends on (an old readable-stream among them) read `process.nextTick`, `process.browser` and `process.version` as Node globals, and a browser has no `process`, so the preview worker died on start with "process is not defined". The shim provides exactly those and nothing else: it has no `emit`, so the unhandled-rejection hook that other code looks for stays off. esbuild injects it wherever the bundle names the global. */

/** The subset of Node's `process` the bundled stream code reads. */
export const process = {
  browser: true,
  env: {},
  version: "",
  versions: {},
  nextTick: (callback: (...args: readonly unknown[]) => void, ...args: readonly unknown[]): void => {
    queueMicrotask(() => {
      callback(...args);
    });
  },
};
