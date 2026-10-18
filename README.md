# keepset

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/keepset) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/keepset) [![Release](https://img.shields.io/github/v/release/ExaDev/keepset)](https://github.com/ExaDev/keepset/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/keepset/ci.yml?branch=main)](https://github.com/ExaDev/keepset/actions)

A catalogue of datasets, each with a machine-readable recipe that says how to fetch it and how to normalise it into the shape its category names. The `keepset` package is the consumable library over that catalogue; the CLI and the statically generated site are thin surfaces on top of it. Entries are expressed with [twindex](https://github.com/ExaDev/twindex) crosswalks, so fetching a dataset yields a normalised shape directly in user code.

## Usage

```ts
import { getDataset, listDatasets } from "keepset";
import { fetchDataset } from "keepset/node";

// Every graph dataset whose id, name, description, domain or tags mention "citatio".
const graphs = listDatasets({ kind: "graph", text: "citatio" });

// One dataset's entry: its metadata, recipe and resolved crosswalk.
const { entry } = getDataset("cora");

// Fetch it and resolve it to the category's target shape.
const { data, provenance, warnings } = await fetchDataset("cora");
// data is { meta, nodes, edges }: the graph/v1 target
provenance.fetchedUrl; // the URL the bytes actually came from
provenance.sha256; // the hash of exactly those bytes
```

`listDatasets` and `getDataset` read the catalogue bundled with the package and are browser-safe. `fetchDataset` downloads, extracts and parses, so it lives behind the `keepset/node` subpath: it needs the filesystem and the network, and takes an optional `{ fetch, signal, now }` so a caller can inject a stand-in, abort mid-download and pin the provenance clock.

## The CLI

```sh
npx keepset search citatio --kind graph
npx keepset show cora
npx keepset fetch cora --out cora.json
npx keepset validate cora
npx keepset roundtrip cora
```

`fetch` writes the normalised result with its provenance beside it; `validate` checks the entry against the entry schema and its crosswalk against twindex's validation without the network; `roundtrip` fetches the dataset and checks that decoding the encoded native document gives it back. Exit status is 0 for an answer, 1 for a negative one (an invalid entry, a round trip that does not hold) and 2 for no answer (bad usage, an unknown id, a recipe that failed).

## The entry format

An entry is a JSON document in `catalogue/entries/`: a descriptor (stable id, name, description, domain, tags), the category whose normalisation target the entry resolves to, its sources (each with a retrieval date, and for a dead source a pinned Wayback snapshot that travels with the URL because the snapshot timestamp is part of the recipe's reproducibility), its licence and citations, the recipe that turns downloaded bytes into the dataset's native JSON shape, and a twindex crosswalk mapping that native shape onto the category target. The format is defined by Zod schemas, and the generated JSON Schema is published with the package as `keepset/schemas/entry.schema.json`, with the catalogue manifest's beside it.

The catalogue itself is a manifest (`catalogue/manifest.json`: id, version, repository) plus the entries and their crosswalks. Contribution is by forking with lineage: a fork is its own catalogue, its manifest names the catalogue and version it was forked from, and entry ids stay stable across forks so two catalogues can be compared entry by entry.

## Categories and normalisation targets

A category names a normalisation target: the shape every entry in that category resolves to, whatever its native shape. `graph/v1` is the first, `{ meta, nodes, edges }` with unique node ids and edges whose endpoints name nodes, seeded from 823 graph datasets surveyed from about forty upstream collections (SuiteSparse, Netzschleuder, SNAP, KONECT, OGB and others). A new category starts by defining its target schema in `src/targets/` and registering it in the category registry; an entry cannot name a category that does not exist. The statically generated site renders every entry with schema.org Dataset JSON-LD, so the catalogue surfaces in the dataset discovery layers.

## Licensing

The catalogue's metadata and recipes are repository content under the MIT licence. The datasets they fetch belong to their sources: each entry records its licence as the source states it (an SPDX identifier, a named licence with a URL, or unrecorded where the source states none), and fetching a dataset is subject to that licence, not this repository's. A dead source is fetched from its pinned Wayback snapshot, which serves the bytes as captured.

## Development

Node 22 or later, pnpm, ESM only. See [CONTRIBUTING.md](CONTRIBUTING.md) for adding an entry or a category, the release path, and the constraints a change must preserve.

| Script | |
| --- | --- |
| `pnpm lint` / `pnpm lint:check` | ESLint, fixing and check-only |
| `pnpm typecheck` | `tsc` over the library, CLI and site programs |
| `pnpm test` | Vitest, tests colocated as `*.unit.test.ts` and `*.e2e.test.ts` |
| `pnpm build` | tsdown into `dist` and `dist-cli`, then the JSON Schema generation and the site build |

`CLAUDE.md` and `AGENTS.md` are symlinks to this file.

MIT licensed.
