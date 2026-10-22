import { afterEach, describe, expect, it, vi } from "vitest";
import { KeepsetError } from "../errors";
import { downloadRaw } from "./download";

/** The status every answering stub of these tests serves. */
const OK = 200;

/** A fetch stand-in that records the URLs it was asked for, typed without the DOM's names so the library's own node-free build checks it. */
const standIn = (answer: (url: string, attempt: number, init: RequestInit | undefined) => Response | Promise<Response>): { readonly fetch: typeof fetch; readonly urls: string[] } => {
  let attempt = 0;
  const urls: string[] = [];
  const fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    attempt += 1;
    const url = String(input);
    urls.push(url);

    return answer(url, attempt, init);
  };

  return { fetch, urls };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the browser downloader", () => {
  it("returns the platform's answer and follows no redirect itself", async () => {
    const body = "abc";
    const network = standIn(() => new Response(body, { status: OK }));
    vi.stubGlobal("fetch", network.fetch);
    const response = await downloadRaw("https://x.example/file", {});
    expect(response.status).toBe(OK);
    expect(await response.text()).toBe(body);
    expect(network.urls).toEqual(["https://x.example/file"]);
  });

  it("fails at once when the connection fails, with the platform's own error, since a refused read and a dropped connection look alike and a retry cannot help", async () => {
    const network = standIn(() => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", network.fetch);
    await expect(downloadRaw("https://x.example/file", {})).rejects.toBeInstanceOf(TypeError);
    expect(network.urls).toHaveLength(1);
  });

  it("refuses a URL that is not http or https without asking the platform", async () => {
    const network = standIn(() => new Response(null, { status: OK }));
    vi.stubGlobal("fetch", network.fetch);
    await expect(downloadRaw("data:application/json,{}", {})).rejects.toThrow(KeepsetError);
    expect(network.urls).toEqual([]);
  });

  it("gives a request up as dead when it passes its deadline", async () => {
    // A stand-in as silent as a stalled server, which still honours the signal the downloader aborts: the platform's own fetch rejects the same way.
    const silent = async (_input: unknown, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const reason: unknown = init.signal?.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      });
    });
    vi.stubGlobal("fetch", silent);
    await expect(downloadRaw("https://x.example/file", { stallMilliseconds: 50 })).rejects.toThrow("did not finish within 50 milliseconds");
  });
});
