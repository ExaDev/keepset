import type { Parser } from "../../src/entry";

/* What the graph import read from the downloads the source catalogue records only by URL and format: how each knowledge graph triples download, each Heterogeneous Graph Benchmark zip and its types, are laid out. Every value was read from the file it describes, and a download not listed here has no triples or HGB recipe. */

/** How a triples download is read, found by reading it because the catalogue records only the download: the archive it is and the files in it (one, or a file per split, named for the split it holds), and the parser options its lines need. */
export interface TriplesLayout {
  readonly archive: { readonly kind: "none" | "gzip" } | { readonly kind: "tar.gz" | "zip"; readonly splits: { readonly prefix: string } };
  readonly parser: Omit<Extract<Parser, { format: "kg-triples" }>, "format" | "encoding">;
  readonly what: string;
  /** The reason a download whose layout is read is still given no recipe, when its whole fetch failed. */
  readonly notFetchable?: string;
}

/** The split files of a triples archive, in the order the recipe reads them, named `<prefix><split>.txt`. */
export const SPLITS = ["train", "valid", "test"] as const;

/** Head, relation and tail separated by tabs, with no header and no quotes: the layout of most triples downloads. */
const PLAIN_TRIPLES: TriplesLayout["parser"] = { delimiter: "tab", order: "head-relation-tail", header: "none", quoted: false };

/** Why the largest triples downloads have no recipe: the parser reads them, but a whole fetch does not complete at Node's default heap. */
const TOO_LARGE = "the triples are more edges than one fetch holds: a whole fetch at Node's default heap aborts with an allocation failure, because the crosswalk step copies every edge (ExaDev/crossmap#57)";

/** Each triples download, by its original URL, with its layout. */
export const TRIPLE_FILES: ReadonlyMap<string, TriplesLayout> = new Map([
  ...["kinship", "nations", "umls"].map((name): [string, TriplesLayout] => [`https://github.com/TimDettmers/ConvE/raw/master/${name}.tar.gz`, { archive: { kind: "tar.gz", splits: { prefix: "" } }, parser: PLAIN_TRIPLES, what: "ConvE archive: train.txt, valid.txt and test.txt, head, relation and tail separated by tabs" }]),
  ["https://web.informatik.uni-mannheim.de/pi1/kge-datasets/wnrr.tar.gz", { archive: { kind: "tar.gz", splits: { prefix: "wnrr/" } }, parser: PLAIN_TRIPLES, what: "Mannheim KGE archive: wnrr/train.txt, valid.txt and test.txt, head, relation and tail separated by tabs" }],
  ["https://web.informatik.uni-mannheim.de/pi1/kge-datasets/yago3-10.tar.gz", { archive: { kind: "tar.gz", splits: { prefix: "yago3-10/" } }, parser: PLAIN_TRIPLES, what: "Mannheim KGE archive: yago3-10/train.txt, valid.txt and test.txt, head, relation and tail separated by tabs" }],
  ["https://web.informatik.uni-mannheim.de/pi1/kge-datasets/fb15k-237.tar.gz", { archive: { kind: "tar.gz", splits: { prefix: "fb15k-237/" } }, parser: PLAIN_TRIPLES, what: "Mannheim KGE archive: fb15k-237/train.txt, valid.txt and test.txt, head, relation and tail separated by tabs, CRLF endings" }],
  [
    "https://www.dropbox.com/scl/fi/04itkl1lnxev587n3xkap/wikidata5m_transductive.tar.gz?rlkey=usj1e6dlqgfzruyd7eb58ksht&dl=1",
    { archive: { kind: "tar.gz", splits: { prefix: "wikidata5m_transductive_" } }, parser: PLAIN_TRIPLES, what: "Wikidata5M transductive archive: wikidata5m_transductive_train.txt, _valid.txt and _test.txt, head, relation and tail separated by tabs", notFetchable: TOO_LARGE },
  ],
  ["https://data.dgl.ai/dataset/wikikg2.zip", { archive: { kind: "zip", splits: { prefix: "wikikg2/" } }, parser: { ...PLAIN_TRIPLES, quoted: true }, what: "DGL archive: wikikg2/train.txt, valid.txt and test.txt, head, relation and tail separated by tabs, each in double quotes", notFetchable: TOO_LARGE }],
  ["https://github.com/tsafavi/codex/raw/master/data/triples/codex-s/train.txt", { archive: { kind: "none" }, parser: PLAIN_TRIPLES, what: "CoDEx training split: head, relation and tail separated by tabs" }],
  ["https://raw.githubusercontent.com/thunlp/OpenKE/OpenKE-PyTorch/benchmarks/NELL-995/train2id.txt", { archive: { kind: "none" }, parser: { delimiter: "space", order: "head-tail-relation", header: "count", quoted: false }, what: "OpenKE id triples: the triple count on the first line, then head, tail and relation ids separated by spaces" }],
  ["https://media.githubusercontent.com/media/hetio/hetionet/main/hetnet/tsv/hetionet-v1.0-edges.sif.gz", { archive: { kind: "gzip" }, parser: { ...PLAIN_TRIPLES, header: "names" }, what: "Hetionet SIF: a header line naming source, metaedge and target, then one edge per line separated by tabs" }],
]);

/** An HGB dataset's directory in its zip and its types, read from the dataset's `info.dat`: the node type names in code order, and each link type's name and the node types it runs from and to. */
export interface HgbLayout {
  readonly directory: string;
  readonly nodeTypes: readonly string[];
  readonly linkTypes: readonly { readonly name: string; readonly source: string; readonly target: string }[];
}

const ACM: HgbLayout = {
  directory: "ACM",
  nodeTypes: ["paper", "author", "subject", "term"],
  linkTypes: [
    { name: "paper-cite-paper", source: "paper", target: "paper" },
    { name: "paper-ref-paper", source: "paper", target: "paper" },
    { name: "paper-author", source: "paper", target: "author" },
    { name: "author-paper", source: "author", target: "paper" },
    { name: "paper-subject", source: "paper", target: "subject" },
    { name: "subject-paper", source: "subject", target: "paper" },
    { name: "paper-term", source: "paper", target: "term" },
    { name: "term-paper", source: "term", target: "paper" },
  ],
};

/** Each HGB download, by its original URL, with its layout. The two ACM URLs are the same Drive file. */
export const HGB_FILES: ReadonlyMap<string, HgbLayout> = new Map([
  ["https://drive.google.com/uc?id=1xbJ4QE9pcDJOcALv7dYhHDCPITX2Iddz&export=download", ACM],
  ["https://drive.google.com/uc?export=download&id=1xbJ4QE9pcDJOcALv7dYhHDCPITX2Iddz", ACM],
  [
    "https://drive.google.com/uc?id=1fLLoy559V7jJaQ_9mQEsC06VKd6Qd3SC&export=download",
    {
      directory: "DBLP",
      nodeTypes: ["author", "paper", "term", "venue"],
      linkTypes: [
        { name: "author-paper", source: "author", target: "paper" },
        { name: "paper-term", source: "paper", target: "term" },
        { name: "paper-venue", source: "paper", target: "venue" },
        { name: "paper-author", source: "paper", target: "author" },
        { name: "term-paper", source: "term", target: "paper" },
        { name: "venue-paper", source: "venue", target: "paper" },
      ],
    },
  ],
  [
    "https://drive.google.com/uc?id=1vw-uqbroJZfFsWpriC1CWbtHCJMGdWJ7&export=download",
    {
      directory: "Freebase",
      nodeTypes: ["BOOK", "FILM", "MUSIC", "SPORTS", "PEOPLE", "LOCATION", "ORGANIZATION", "BUSINESS"],
      linkTypes: [
    { name: "BOOK-and-BOOK", source: "BOOK", target: "BOOK" },
    { name: "BOOK-to-FILM", source: "BOOK", target: "FILM" },
    { name: "BOOK-on-SPORTS", source: "BOOK", target: "SPORTS" },
    { name: "BOOK-on-LOCATION", source: "BOOK", target: "LOCATION" },
    { name: "BOOK-about-ORGANIZATION", source: "BOOK", target: "ORGANIZATION" },
    { name: "FILM-and-FILM", source: "FILM", target: "FILM" },
    { name: "MUSIC-in-BOOK", source: "MUSIC", target: "BOOK" },
    { name: "MUSIC-in-FILM", source: "MUSIC", target: "FILM" },
    { name: "MUSIC-and-MUSIC", source: "MUSIC", target: "MUSIC" },
    { name: "MUSIC-for-SPORTS", source: "MUSIC", target: "SPORTS" },
    { name: "MUSIC-on-LOCATION", source: "MUSIC", target: "LOCATION" },
    { name: "SPORTS-in-FILM", source: "SPORTS", target: "FILM" },
    { name: "SPORTS-and-SPORTS", source: "SPORTS", target: "SPORTS" },
    { name: "SPORTS-on-LOCATION", source: "SPORTS", target: "LOCATION" },
    { name: "PEOPLE-to-BOOK", source: "PEOPLE", target: "BOOK" },
    { name: "PEOPLE-to-FILM", source: "PEOPLE", target: "FILM" },
    { name: "PEOPLE-to-MUSIC", source: "PEOPLE", target: "MUSIC" },
    { name: "PEOPLE-to-SPORTS", source: "PEOPLE", target: "SPORTS" },
    { name: "PEOPLE-and-PEOPLE", source: "PEOPLE", target: "PEOPLE" },
    { name: "PEOPLE-on-LOCATION", source: "PEOPLE", target: "LOCATION" },
    { name: "PEOPLE-in-ORGANIZATION", source: "PEOPLE", target: "ORGANIZATION" },
    { name: "PEOPLE-in-BUSINESS", source: "PEOPLE", target: "BUSINESS" },
    { name: "LOCATION-in-FILM", source: "LOCATION", target: "FILM" },
    { name: "LOCATION-and-LOCATION", source: "LOCATION", target: "LOCATION" },
    { name: "ORGANIZATION-in-FILM", source: "ORGANIZATION", target: "FILM" },
    { name: "ORGANIZATION-to-MUSIC", source: "ORGANIZATION", target: "MUSIC" },
    { name: "ORGANIZATION-to-SPORTS", source: "ORGANIZATION", target: "SPORTS" },
    { name: "ORGANIZATION-on-LOCATION", source: "ORGANIZATION", target: "LOCATION" },
    { name: "ORGANIZATION-and-ORGANIZATION", source: "ORGANIZATION", target: "ORGANIZATION" },
    { name: "ORGANIZATION-for-BUSINESS", source: "ORGANIZATION", target: "BUSINESS" },
    { name: "BUSINESS-about-BOOK", source: "BUSINESS", target: "BOOK" },
    { name: "BUSINESS-about-FILM", source: "BUSINESS", target: "FILM" },
    { name: "BUSINESS-about-MUSIC", source: "BUSINESS", target: "MUSIC" },
    { name: "BUSINESS-about-SPORTS", source: "BUSINESS", target: "SPORTS" },
    { name: "BUSINESS-on-LOCATION", source: "BUSINESS", target: "LOCATION" },
    { name: "BUSINESS-and-BUSINESS", source: "BUSINESS", target: "BUSINESS" },
      ],
    },
  ],
  [
    "https://drive.google.com/uc?id=18qXmmwKJBrEJxVQaYwKTL3Ny3fPqJeJ2&export=download",
    {
      directory: "IMDB",
      nodeTypes: ["movie", "director", "actor", "keyword"],
      linkTypes: [
        { name: "movie->director", source: "movie", target: "director" },
        { name: "director->movie", source: "director", target: "movie" },
        { name: "movie->actorh", source: "movie", target: "actor" },
        { name: "actor->movie", source: "actor", target: "movie" },
        { name: "movie->keyword", source: "movie", target: "keyword" },
        { name: "keyword->movie", source: "keyword", target: "movie" },
      ],
    },
  ],
]);

