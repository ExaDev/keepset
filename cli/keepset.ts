#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { countTarget, getDataset, listDatasets, validateDataset } from "keepset";
import { fetchDataset, roundTripDataset } from "keepset/node";
import packageJson from "../package.json" with { type: "json" };
import { run } from "./run";

// A reader that closes early (`| head`) makes the next write fail with EPIPE. The output was complete as far as the reader wanted it, so that error is dropped and the exit status the command settled on stands; any other stdout error is still thrown.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

process.exitCode = await run(
  process.argv.slice(2),
  {
    listDatasets,
    getDataset,
    validateDataset,
    fetchDataset: async (id) => fetchDataset(id),
    roundTripDataset: async (id) => roundTripDataset(id),
    countTarget: (fetched) => countTarget(fetched.dataset.entry.category, fetched.data),
  },
  {
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    writeFile: (path, text) => {
      writeFileSync(path, text, "utf8");
    },
    version: packageJson.version,
  },
);
