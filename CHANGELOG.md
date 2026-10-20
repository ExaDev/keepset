# [0.25.0](https://github.com/Mearman/keepset/compare/v0.24.0...v0.25.0) (2026-10-20)


### Features

* **catalogue:** fetch the KU Leuven orienteering instance collections ([f0b7b1b](https://github.com/Mearman/keepset/commit/f0b7b1bd4a8696aee17df6fb69e42797c06d9d88))
* **parsers:** read TOPTW and team orienteering instance files ([fd947a3](https://github.com/Mearman/keepset/commit/fd947a3feca6fcab3b4927de29c4b30aeb75391d))

# [0.24.0](https://github.com/Mearman/keepset/compare/v0.23.0...v0.24.0) (2026-10-20)


### Features

* **catalogue:** fetch the Solomon and Tenerife vehicle routing collections ([3d6db11](https://github.com/Mearman/keepset/commit/3d6db11b6e744a63ef970b20e9d3b7ee506fa731))
* **categories:** read a collection of instance files as or-set/v1 ([8880ac8](https://github.com/Mearman/keepset/commit/8880ac8fa122b65a95b5d785761eb8f403f032d5))
* **seed:** import a collection of instance files from the or survey ([cf2aca6](https://github.com/Mearman/keepset/commit/cf2aca67113119281a4038134bad1fb660a7c8d6))

# [0.23.0](https://github.com/Mearman/keepset/compare/v0.22.1...v0.23.0) (2026-10-20)


### Features

* **catalogue:** fetch the FEMA flood insurance claims ([216e9bc](https://github.com/Mearman/keepset/commit/216e9bc6f6cdfdc303c156a4ee7ae250ce494bc2))
* **parsers:** page an OpenFEMA entity and check each page ([58d6a57](https://github.com/Mearman/keepset/commit/58d6a575107c5ea97da5b1a1cf390b33e4b85b2d))
* **seed:** page OpenFEMA sources and raise the cell limit to what was measured ([911ada4](https://github.com/Mearman/keepset/commit/911ada44ac75a363b9d13fa425319587bdf42068))

## [0.22.1](https://github.com/Mearman/keepset/compare/v0.22.0...v0.22.1) (2026-10-20)

# [0.22.0](https://github.com/Mearman/keepset/compare/v0.21.0...v0.22.0) (2026-10-20)


### Features

* **catalogue:** fetch more open data tables and correct the reasons left ([d6e3e4a](https://github.com/Mearman/keepset/commit/d6e3e4a8dfb206ee15a12b3a7f2eaa368d9e9b8b))
* **parsers:** page a CKAN datastore dump and read NA as a missing value ([216d9fa](https://github.com/Mearman/keepset/commit/216d9fae6b714584de6ceb1dedc3216e4bb2be61))
* **seed:** import archived and CKAN sources and verify paged ones whole ([60fcb59](https://github.com/Mearman/keepset/commit/60fcb5958397b2d9e5b072f6e77a4b53cf737643))

# [0.21.0](https://github.com/Mearman/keepset/compare/v0.20.0...v0.21.0) (2026-10-20)


### Bug Fixes

* **node:** give up a download whose connection sends nothing ([688e314](https://github.com/Mearman/keepset/commit/688e314590aefa7bd4164c9f3ae63fa934f30dab))


### Features

* **catalogue:** fetch the large operations research tables a page at a time ([5997b36](https://github.com/Mearman/keepset/commit/5997b36c069251db4af0a6aded306b2359fdbd08))
* **node:** try a download again when its connection fails ([8beef2b](https://github.com/Mearman/keepset/commit/8beef2b24978c71f548b2483743231f8104259e2))
* **parsers:** ask a page of a paged download again when it fails ([c151a62](https://github.com/Mearman/keepset/commit/c151a627d5f6c7bfb45642cecb5fcb756eb89199))
* **parsers:** read a Socrata resource a page at a time and check each page ([8d158f1](https://github.com/Mearman/keepset/commit/8d158f1d3b64c2f2f99513ff6d74d4e2a33348ae))
* **seed:** bound a table by its kept cells and page a Socrata resource ([bf13cf5](https://github.com/Mearman/keepset/commit/bf13cf5b4fd4eb3613f6763bae0a40f3f169fe03))

# [0.20.0](https://github.com/Mearman/keepset/compare/v0.19.0...v0.20.0) (2026-10-19)


### Features

* **catalogue:** fetch the Environment Agency prosecutions workbook ([bea8a9f](https://github.com/Mearman/keepset/commit/bea8a9f493a9d3e3e582a1400ff581b3ec35e609))
* **parsers:** read a sheet of an xlsx workbook as a table ([2bfa6ab](https://github.com/Mearman/keepset/commit/2bfa6ab19838e861833fd37e66c25240d9eb59c7))
* **seed:** import a workbook sheet as an operations research recipe ([7740b9e](https://github.com/Mearman/keepset/commit/7740b9ebfe151d4ef5ad2a3cae1ed9169c9998fc))

# [0.19.0](https://github.com/Mearman/keepset/compare/v0.18.0...v0.19.0) (2026-10-19)


### Features

* **catalogue:** fetch the ArcGIS operations research layers ([0c4119c](https://github.com/Mearman/keepset/commit/0c4119c18d5bf5e90928c965fcfe0b96a9a512db))
* **parsers:** read an ArcGIS feature layer, a page at a time, as GeoJSON ([13ddf46](https://github.com/Mearman/keepset/commit/13ddf469160c5bf5ee84bbe56a4b0b78ee6adcbf))
* **seed:** import an ArcGIS layer as an operations research recipe ([e86f6b2](https://github.com/Mearman/keepset/commit/e86f6b22907947aa9b634c43c41fc799c05a2930))

# [0.18.0](https://github.com/Mearman/keepset/compare/v0.17.0...v0.18.0) (2026-10-19)


### Bug Fixes

* **seed:** take the range of a column without spreading it into a call ([4f3fc53](https://github.com/Mearman/keepset/commit/4f3fc53d4f364c2d3483c977ca177478388d241b))


### Features

* **catalogue:** read only the mapped columns of each operations research table ([f55eb68](https://github.com/Mearman/keepset/commit/f55eb68ebe1eed3b33f1377064e82405d044f7ef))
* **parsers:** keep only the listed columns and read a table a piece at a time ([18eb4dc](https://github.com/Mearman/keepset/commit/18eb4dc61802ddd277b0af4c43aaa1a67a7dfdfe))
* **seed:** import each operations research recipe with the columns it maps ([e08d1e8](https://github.com/Mearman/keepset/commit/e08d1e8c253da8a8a7f2edc22a1b548bb206959d))

# [0.17.0](https://github.com/Mearman/keepset/compare/v0.16.1...v0.17.0) (2026-10-19)


### Features

* **catalogue:** record expected counts for the fixed operations research sources ([bb11828](https://github.com/Mearman/keepset/commit/bb118288131846d260607205bd345b728d5b9372))
* **seed:** record a fixed source's node count as the entry's expected count ([16e9efb](https://github.com/Mearman/keepset/commit/16e9efb0d4683da41c9ec0733271ab8cf5a15254))

## [0.16.1](https://github.com/Mearman/keepset/compare/v0.16.0...v0.16.1) (2026-10-19)

# [0.16.0](https://github.com/Mearman/keepset/compare/v0.15.1...v0.16.0) (2026-10-19)


### Features

* **seed:** let or-verify fetch a whole download ([4daeaba](https://github.com/Mearman/keepset/commit/4daeabada3353025e9cdb592686a593b7b8ae67a))

## [0.15.1](https://github.com/Mearman/keepset/compare/v0.15.0...v0.15.1) (2026-10-19)


### Bug Fixes

* **catalogue:** correct the operations research recipes a whole fetch refused ([588f93b](https://github.com/Mearman/keepset/commit/588f93b046281a6f3c52cec0e750d8dd710135a8))
* **seed:** ask a Socrata resource endpoint for the whole table ([85ac53b](https://github.com/Mearman/keepset/commit/85ac53bc4599b4881982a2234b9aa651d506e7d0))

# [0.15.0](https://github.com/Mearman/keepset/compare/v0.14.1...v0.15.0) (2026-10-19)


### Bug Fixes

* name an empty table header cell by its position ([83b14ab](https://github.com/Mearman/keepset/commit/83b14ab488df8377a8c590068f96820c41487904))
* reserve id for the row's id in the table parser ([82f8995](https://github.com/Mearman/keepset/commit/82f8995475654340ec6deebf2e8e8d473188e285))


### Features

* **catalogue:** import the operations research dataset survey ([a7789c9](https://github.com/Mearman/keepset/commit/a7789c9783568cfc6a94c05c89b4802a35efa52e))
* **seed:** add the operations-research survey import ([6684081](https://github.com/Mearman/keepset/commit/6684081ae960bfe0a1b1c19b2a85d5adde46b9ff))

## [0.14.1](https://github.com/Mearman/keepset/compare/v0.14.0...v0.14.1) (2026-10-19)

# [0.14.0](https://github.com/Mearman/keepset/compare/v0.13.1...v0.14.0) (2026-10-19)


### Features

* add the or/v1 category for operations-research instances ([69b2f9a](https://github.com/Mearman/keepset/commit/69b2f9add70124f3ea539c1b34d67787d5ca83ab))
* read delimited tables with a csv-table parser ([9b42a5f](https://github.com/Mearman/keepset/commit/9b42a5ff284f12aa6e90718302d4bc0744c9bb5c))

## [0.13.1](https://github.com/Mearman/keepset/compare/v0.13.0...v0.13.1) (2026-10-19)


### Bug Fixes

* **deps:** bump zod and twindex together ([df88ea7](https://github.com/Mearman/keepset/commit/df88ea7ec993d4b7f9ce661272f48b10c8d66e71))

# [0.13.0](https://github.com/Mearman/keepset/compare/v0.12.0...v0.13.0) (2026-10-19)


### Features

* **cli:** add a namespaces command to browse the namespace tree ([a5e84af](https://github.com/Mearman/keepset/commit/a5e84af788734fd0690fb62aa8d56d618c97627c))
* **site:** add a page for every namespace and link the groups ([9f41789](https://github.com/Mearman/keepset/commit/9f41789612d6b2fd8b0af4b283eee71c44504fd2))

# [0.12.0](https://github.com/Mearman/keepset/compare/v0.11.0...v0.12.0) (2026-10-19)


### Features

* let an alias be a path that files the entry in another group ([151d4b8](https://github.com/Mearman/keepset/commit/151d4b812f9da399b496e9679c44d67e2c2a02d7))
* list namespaces and let the manifest alias their segments ([e236acb](https://github.com/Mearman/keepset/commit/e236acbe29a699ff83907f1119d04d03f0d535c3))
* **seed:** alias the collection namespaces by their id abbreviations ([03fb589](https://github.com/Mearman/keepset/commit/03fb589e82afd9e1fc5285f445cad7cead528378))

# [0.11.0](https://github.com/Mearman/keepset/compare/v0.10.0...v0.11.0) (2026-10-19)


### Features

* **cli:** take a qualified name or alias for any dataset ([f350b85](https://github.com/Mearman/keepset/commit/f350b85ce2ed799f344a285ed0eaabf707fd88df))
* resolve datasets by namespace-qualified name and alias ([bcf9a6e](https://github.com/Mearman/keepset/commit/bcf9a6e792fee5955224120f0375fd53a4bf6b22))
* **seed:** file collection-prefixed ids under namespaces ([d1cde50](https://github.com/Mearman/keepset/commit/d1cde502bf4d3af50376dd1caa1e4bf802951bb8))
* **site:** show namespaces and aliases and search by them ([8238292](https://github.com/Mearman/keepset/commit/8238292d9c429b9b44bf1b87c6af0fd27622026c))

# [0.10.0](https://github.com/Mearman/keepset/compare/v0.9.2...v0.10.0) (2026-10-19)


### Features

* **site:** keep home listing rows on one line ([9a1de89](https://github.com/Mearman/keepset/commit/9a1de898229c1ae487f13548bf10d803c14c223b))

## [0.9.2](https://github.com/Mearman/keepset/compare/v0.9.1...v0.9.2) (2026-10-19)


### Bug Fixes

* **site:** name the service worker cache for the precached bytes ([2628f4a](https://github.com/Mearman/keepset/commit/2628f4a783123d0b626d8a0597f06a551433425c))

## [0.9.1](https://github.com/Mearman/keepset/compare/v0.9.0...v0.9.1) (2026-10-19)


### Bug Fixes

* **site:** make static tables share the island's scale and fix light-mode tokens ([1c5663d](https://github.com/Mearman/keepset/commit/1c5663d0ed10fbde5d12ab973dc1e8fec4e3edaf))

# [0.9.0](https://github.com/Mearman/keepset/compare/v0.8.0...v0.9.0) (2026-10-19)


### Features

* **site:** responsive layout with dark-mode tokens ([d7e797b](https://github.com/Mearman/keepset/commit/d7e797b5604d3dfffcfc41b6630b009eb069e4a1))

# [0.8.0](https://github.com/Mearman/keepset/compare/v0.7.0...v0.8.0) (2026-10-18)


### Features

* rebuild the site island on React, Mantine and vanilla-extract ([3e89847](https://github.com/Mearman/keepset/commit/3e898477a767bf9239455b53c5db86099a1e85ac))

# [0.7.0](https://github.com/Mearman/keepset/compare/v0.6.2...v0.7.0) (2026-10-18)


### Features

* seed the operations-research survey as a catalogue source ([e3b9ec1](https://github.com/Mearman/keepset/commit/e3b9ec173e53e14af7ca23206872f60f4706ec67))

## [0.6.2](https://github.com/Mearman/keepset/compare/v0.6.1...v0.6.2) (2026-10-18)

## [0.6.1](https://github.com/ExaDev/keepset/compare/v0.6.0...v0.6.1) (2026-10-18)

# [0.6.0](https://github.com/ExaDev/keepset/compare/v0.5.0...v0.6.0) (2026-10-18)


### Features

* generate the static catalogue site with schema.org Dataset JSON-LD ([09cef1e](https://github.com/ExaDev/keepset/commit/09cef1ec1144572a29ed725e032b94107118ddd7))

# [0.5.0](https://github.com/ExaDev/keepset/compare/v0.4.0...v0.5.0) (2026-10-18)


### Features

* add the keepset command with search, show, fetch, validate and roundtrip ([26ed58d](https://github.com/ExaDev/keepset/commit/26ed58df237518d9eb63500f391bde5c2cb57468)), closes [#11](https://github.com/ExaDev/keepset/issues/11)
* add validateDataset and roundTripEntry to the library ([ba4f7ed](https://github.com/ExaDev/keepset/commit/ba4f7ed5fe8701446f4866c2843e8b6215b56298))

# [0.4.0](https://github.com/ExaDev/keepset/compare/v0.3.0...v0.4.0) (2026-10-18)


### Bug Fixes

* download recipe sources byte for byte, never undoing a Content-Encoding ([bb10f03](https://github.com/ExaDev/keepset/commit/bb10f03d8b315564f2d6b91e0bc99fc7ef942ef9))


### Features

* add the seed import from the thesis pipeline's graph catalogue ([8909502](https://github.com/ExaDev/keepset/commit/8909502e374d4da26aca94d7131da9be1a6c04f2))
* let an archive member selector name several extensions ([2c13182](https://github.com/ExaDev/keepset/commit/2c131821ca094d1e57c6336358c8340d16248e40))
* read abbreviated Pajek section keywords ([07bd9a9](https://github.com/ExaDev/keepset/commit/07bd9a90ac9a60cadf424db2d5977e1ca8a17232))
* refine the seed import's recipes against real downloads ([9d0ece3](https://github.com/ExaDev/keepset/commit/9d0ece3cefbe114ab6b1e11b0b2dff11b86a4729))
* seed the graph/v1 catalogue from the thesis pipeline's catalogue ([db1145e](https://github.com/ExaDev/keepset/commit/db1145e4375ccd82c665cf43e380b8abf1cf43f0)), closes [#10](https://github.com/ExaDev/keepset/issues/10)

# [0.3.0](https://github.com/ExaDev/keepset/compare/v0.2.0...v0.3.0) (2026-10-18)


### Features

* add the library core with listDatasets, getDataset and fetchDataset ([ff1c7af](https://github.com/ExaDev/keepset/commit/ff1c7afb5d2de939d8ec0f62ffa11937a46430e6))
* let an edge-list recipe detect its delimiter from the data ([092b354](https://github.com/ExaDev/keepset/commit/092b354000b7501abe92c4125928e9968c9c501b))
* parse edge lists, Matrix Market, GML and Pajek into a native graph ([51f0863](https://github.com/ExaDev/keepset/commit/51f0863d9ade3406c93510c209a44306c6a54d84))

# [0.2.0](https://github.com/ExaDev/keepset/compare/v0.1.0...v0.2.0) (2026-10-18)


### Features

* define the catalogue entry and manifest formats ([a4cec69](https://github.com/ExaDev/keepset/commit/a4cec69482f62f4b6d83c67401e2b4382c887215))
* generate JSON Schemas for the entry and manifest formats ([b9bef25](https://github.com/ExaDev/keepset/commit/b9bef25f75f6bd8b57a0c0178f1329eb20199aeb))
* state the text encoding in every parser of a recipe ([801ec32](https://github.com/ExaDev/keepset/commit/801ec32d79dfc0bd10c8dcec0837ec4a1906d0da))

# [0.1.0](https://github.com/ExaDev/keepset/compare/v0.0.4...v0.1.0) (2026-10-18)


### Features

* add the category registry with the graph/v1 target ([a8795d0](https://github.com/ExaDev/keepset/commit/a8795d0eac3fa3e132b2ed63aa8df7b115e93b7d)), closes [#8](https://github.com/ExaDev/keepset/issues/8)

## [0.0.4](https://github.com/ExaDev/keepset/compare/v0.0.3...v0.0.4) (2026-10-18)

## [0.0.3](https://github.com/ExaDev/keepset/compare/v0.0.2...v0.0.3) (2026-10-18)

## [0.0.2](https://github.com/ExaDev/keepset/compare/v0.0.1...v0.0.2) (2026-10-18)

## [0.0.1](https://github.com/ExaDev/keepset/compare/v0.0.0...v0.0.1) (2026-10-18)
