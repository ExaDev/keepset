import { waybackUrl } from "../entry";

/** A fetchable entry with a live source and an inline crosswalk. */
export const liveEntry = {
  id: "karate",
  name: "Zachary Karate Club",
  description: "Friendships between members of a university karate club.",
  domain: "Social network",
  tags: ["social", "small"],
  category: "graph/v1",
  sources: [{ url: "https://example.org/data/karate.txt", retrieved: "2026-04-19", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [{ text: "W. W. Zachary (1977). An information flow model for conflict and fission in small groups.", doi: "10.1086/jar.33.4.3629752" }],
  recipe: {
    status: "fetchable",
    source: 0,
    archive: { kind: "none" },
    parser: { format: "edge-list", encoding: "utf-8", delimiter: "whitespace", skipLines: 0, commentPrefixes: ["#", "%"], sourceColumn: 0, targetColumn: 1 },
  },
  crosswalk: {
    source: "edge-list",
    target: "graph/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      { op: "move", from: "edges[].source", to: "edges[].source" },
      { op: "move", from: "edges[].target", to: "edges[].target" },
    ],
    oneWay: [],
  },
  expectedCounts: { nodes: 34, edges: 78 },
  properties: { directed: false, weighted: false, density: 0.139 },
};

/** A fetchable entry whose dead source is pinned to a Wayback snapshot, with a crosswalk file reference. */
export const deadEntry = {
  id: "celegans-metabolic",
  name: "C. elegans metabolic network",
  tags: [],
  category: "graph/v1",
  sources: [
    {
      url: "http://example.edu/~lab/data/celegans_metabolic.zip",
      retrieved: "2026-04-19",
      status: "dead",
      snapshot: { url: waybackUrl("20230601", "http://example.edu/~lab/data/celegans_metabolic.zip"), timestamp: "20230601" },
    },
  ],
  licence: { kind: "spdx", id: "CC-BY-4.0" },
  citations: [],
  recipe: { status: "fetchable", source: 0, archive: { kind: "zip", member: { path: "celegans_metabolic.net" } }, parser: { format: "pajek", encoding: "latin1" } },
  crosswalk: { file: "crosswalks/graph-v1/pajek.json" },
  expectedCounts: {},
  properties: {},
};

/** An entry with no declarative recipe yet. */
export const notFetchableEntry = {
  ...deadEntry,
  id: "auth-walled",
  sources: [{ url: "https://example.com/datasets/walled", retrieved: "2026-04-19", status: "live" }],
  licence: { kind: "custom", name: "Example data licence", url: "https://example.com/licence" },
  recipe: { status: "not-fetchable", reason: "the source requires an account to download" },
};

/** One of each entry shape, for round-trip and schema-agreement tests. */
export const representativeEntries = [liveEntry, deadEntry, notFetchableEntry];
