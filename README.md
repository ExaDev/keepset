# keepset

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/keepset) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/keepset) [![Release](https://img.shields.io/github/v/release/ExaDev/keepset)](https://github.com/ExaDev/keepset/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/keepset/ci.yml?branch=main)](https://github.com/ExaDev/keepset/actions)

A catalogue of datasets, each with a machine-readable recipe that says how to fetch it and how to normalise it into the shape its category names. The `keepset` package is the consumable library over that catalogue; the CLI and the statically generated site are thin surfaces on top of it. Entries are expressed with [twindex](https://github.com/ExaDev/twindex) crosswalks, so fetching a dataset yields a normalised shape directly in user code.
