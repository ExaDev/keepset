# Contributing

`pnpm install` sets up the git hooks (`prepare: husky`). From then on:

- **Pre-commit** lints and fixes staged TypeScript (`lint-staged`).
- **commit-msg** checks the message against [Conventional Commits](https://www.conventionalcommits.org/) with commitlint, whose type list `release.config.ts` also owns. Describe the code change in the subject, not the review that prompted it.
- **Pre-push** runs typecheck, tests and the build, so a push that CI would reject fails locally first.

## Before opening a PR

`pnpm run prepublishOnly` runs the gate CI enforces: lint, build, typecheck, tests, `publint` and `attw --pack --profile esm-only`. Build before lint's type-aware pass and typecheck: both read the built `dist` and the generated schema. CI also packs the tarball and installs it into a clean project on each supported Node line, runs the CLI from it and builds the site, which is the check that the exports map and the bin work for a consumer.

## Adding an entry

An entry is one JSON document in `catalogue/entries/<id>.json` and, where the crosswalk is not inline, a crosswalk file in `catalogue/crosswalks/<category>/`. Write the entry against the Zod schemas in `src/entry.ts` (the generated `schemas/entry.schema.json` documents the same shape), then check it three ways before committing: `npx keepset validate <id>` for the schema and the crosswalk, `npx keepset fetch <id>` into a scratch file for the recipe, and `npx keepset roundtrip <id>` for the crosswalk's inverse. Record the licence exactly as the source states it, and a dead source's snapshot date with its URL. Never edit an upstream catalogue source, and never modify a source repository to make an entry work: the recipe adapts to the source, not the reverse. Entry ids are stable across forks, so an id is never renamed once published. An entry may also carry a `namespace` (the collection it comes from, outermost segment first) and `aliases` (other names for it). Each namespace segment is an id, and an alias is an id or ids joined by `/`: a bare alias is a name inside the entry's own namespace, and an alias that is a path is a name of its own that files the entry in the group its leading segments name. Every fully qualified name (the whole path of an id or alias) must identify one entry and must not be another entry's id, and an entry's own id and aliases must not give the same fully qualified name twice. The manifest's `namespaceAliases` gives a namespace segment other names; a segment named there must be some entry's segment, and an alias must not itself be one. The catalogue refuses each of these when it is built.

## Adding a category

A category names a normalisation target. Define the target as a Zod schema in `src/targets/`, register it in the category registry with its id (`<kind>/v<n>`), and give `countTarget` a counting of the target's work. The category lands with at least one entry that resolves to it, and the site's listing pages pick it up on the next build.

## Constraints a change must preserve

- **The site consumes the package, never a parallel copy.** `site/build.ts` reads the catalogue through the package's own exports, so the site cannot drift from the library.
- **Upstream catalogue sources are read-only.** The PhD pipeline's catalogue and every other upstream source are surveyed, never modified; the seed import emits keepset entries from them.
- **A fetched dataset's licence is its source's**, recorded as the source states it. The catalogue's metadata and recipes are repository content under MIT.
- **Recipes fail loudly.** A recipe that cannot parse, a crosswalk that does not validate and a count that disagrees with the entry's recorded expectation are errors or warnings, never silent adjustments. No fallback parsers, no per-source overrides outside the entry document.
- **Own-property access for data-controlled keys** (see `src/own.ts`): catalogue entries and parsed documents are untrusted input, and `__proto__` never reaches a record write.
- **Generated files are never hand-edited or committed.** `schemas/`, `dist/`, `dist-cli/` and `site-dist/` come from `pnpm build` and are gitignored. Fix the Zod schema or the generator, not the output.
- **No wall-clock figures in tests or docs.** Assert structure and counts of work.

## Releases

A push to `main` runs semantic-release in CI (the `release` job in `ci.yml`, whose filename the npm trusted publisher is registered against). It reads the conventional commits since the last tag, bumps the version, publishes to npm through OIDC trusted publishing with provenance, tags the release, writes `CHANGELOG.md` and commits it back to `main`. Never hand-bump the `package.json` version or edit `CHANGELOG.md`: both are overwritten by the next release. The release job needs a GitHub-hosted runner, and its release commit is pushed with the workflow's own token, which works only while `main` has no ruleset; adding one needs a bypass identity for that push first.
