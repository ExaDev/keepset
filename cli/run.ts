import { parseArgs } from "node:util";
// Through the package's own name, as cli/keepset.ts imports the library: an `instanceof` check needs the very class the library throws, not a second copy bundled into the command.
import { KeepsetError, NAME_SEPARATOR, type ArchiveMember, type Dataset, type DatasetQuery, type NamespaceNode, type SyntaxIssue } from "keepset";
import type { FetchedDataset, RoundTripReport } from "keepset/node";

/**
 * Says which archive file or files a recipe reads, for the `info` output.
 * @param selector - The recipe's member selector.
 * @returns The path, the extensions a name ends with, or the pattern a path matches.
 */
function selectorText(selector: ArchiveMember): string {
  if ("path" in selector) {
    return selector.path;
  }

  return "pattern" in selector ? `matching ${selector.pattern}` : `ending ${selector.extensions.join(" or ")}`;
}

/** The library calls the command delegates to: every command is one of these plus argument parsing and output formatting, injected so the command's own layer is tested alone. */
export interface CliLibrary {
  readonly listDatasets: (query: DatasetQuery) => readonly Dataset[];
  readonly getDataset: (id: string) => Dataset;
  readonly listNamespaces: (path?: string) => readonly NamespaceNode[];
  readonly validateDataset: (dataset: Dataset) => readonly SyntaxIssue[];
  readonly fetchDataset: (id: string) => Promise<FetchedDataset>;
  readonly roundTripDataset: (id: string) => Promise<RoundTripReport>;
  readonly countTarget: (dataset: FetchedDataset) => ReadonlyMap<string, number>;
}

/** Everything the command touches outside its arguments and the library. */
export interface CliIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly writeFile: (path: string, text: string) => void;
  readonly version: string;
}

/** The command finished and its answer is yes: a result was printed, an entry is valid, a round trip holds. */
export const EXIT_OK = 0;
/** The command ran and its answer is no: an entry is invalid, or a round trip does not hold. */
export const EXIT_NO = 1;
/** No answer: bad usage, an unknown or ambiguous dataset, or a recipe that failed. */
export const EXIT_FAILED = 2;

const usage = `Usage: keepset <command> [options]

Commands:
  search [text] [--kind <kind>] [--domain <domain>] [--namespace <path>]
         [--category <id>] [--json]
                      list the datasets whose id, alias, namespace, name,
                      description, domain or tags contain the text, filtered by
                      kind, domain, namespace (and every namespace beneath it,
                      segment aliases allowed) or category
  namespaces [path] [--json]
                      list the namespaces directly beneath a path, or the
                      outermost ones, each with how many datasets it holds,
                      tab-separated
  show <dataset> [--json]
                      print a dataset's metadata, recipe and crosswalk
  fetch <dataset> [--out <file>]
                      run the dataset's recipe and write the normalised result
                      to <file> (default <id>.json), with its provenance beside
                      it in <file without .json>.provenance.json
  validate <dataset>  check the entry against the entry schema and its
                      crosswalk against twindex's validation
  roundtrip <dataset> fetch the dataset and check that decoding the encoded
                      native document gives it back

A <dataset> is an entry id, an alias, or a qualified name such as
suitesparse/gset/g53, written with / between the namespace and the name. Any
leading part of the namespace may be dropped (gset/g53, g53) while the name
still means one dataset; an entry's own id always means that entry.

Options:
  --help, -h          print this help
  --version, -v       print the version

Exit status: 0 for a result, a valid entry or a round trip that holds; 1 for an
invalid entry or a round trip that does not hold; 2 when there is no answer:
bad usage, an unknown or ambiguous dataset or namespace or a recipe that failed.
`;

/** The parsed command line. */
interface CommandLine {
  readonly values: { readonly kind?: string; readonly domain?: string; readonly namespace?: string; readonly category?: string; readonly json?: boolean; readonly out?: string; readonly help?: boolean; readonly version?: boolean };
  readonly positionals: readonly string[];
}

function parseCommandLine(args: readonly string[]): CommandLine {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      kind: { type: "string" },
      domain: { type: "string" },
      namespace: { type: "string" },
      category: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

/**
 * JSON as the command prints it: two-space indented, with a trailing newline.
 * @param value - The value.
 * @returns The text.
 */
function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

/**
 * One line per dataset for `search`: id, name, category and whether its recipe can run, tab-separated so the output pipes into other tools.
 * @param datasets - The datasets.
 * @returns The text.
 */
export function formatSearch(datasets: readonly Dataset[]): string {
  return datasets.map(({ entry }) => `${entry.id}\t${entry.name}\t${entry.category}\t${entry.recipe.status}\n`).join("");
}

/**
 * One line per namespace for `namespaces`: path and the number of datasets it holds, tab-separated so the output pipes into other tools.
 * @param nodes - The namespaces.
 * @returns The text.
 */
export function formatNamespaces(nodes: readonly NamespaceNode[]): string {
  return nodes.map((node) => `${node.path}\t${String(node.count)}\n`).join("");
}

/**
 * The human-readable form of `show`: the descriptor, sources, licence, citations, recipe and crosswalk rules, one labelled section after another.
 * @param dataset - The dataset.
 * @returns The text.
 */
export function formatShow(dataset: Dataset): string {
  const { entry, crosswalk } = dataset;
  const lines = [`${entry.name} (${entry.id})`];
  if (entry.description !== undefined) {
    lines.push("", entry.description);
  }
  lines.push("", `category: ${entry.category} (kind ${dataset.kind})`, `catalogue: ${dataset.catalogue.id} ${dataset.catalogue.version}`);
  if (entry.namespace !== undefined) {
    lines.push(`namespace: ${entry.namespace.join(NAME_SEPARATOR)}`);
  }
  if (entry.aliases !== undefined) {
    lines.push(`aliases: ${entry.aliases.join(", ")}`);
  }
  if (entry.domain !== undefined) {
    lines.push(`domain: ${entry.domain}`);
  }
  if (entry.tags.length > 0) {
    lines.push(`tags: ${entry.tags.join(", ")}`);
  }
  const { licence } = entry;
  lines.push(`licence: ${licence.kind === "spdx" ? licence.id : licence.kind === "custom" ? `${licence.name} <${licence.url}>` : "not recorded by the source"}`);
  lines.push("", "sources:");
  for (const [index, source] of entry.sources.entries()) {
    const snapshot = source.snapshot === undefined ? "" : `, snapshot ${source.snapshot.timestamp}`;
    lines.push(`  [${String(index)}] ${source.url} (${source.status}, retrieved ${source.retrieved}${snapshot})`);
  }
  if (entry.citations.length > 0) {
    lines.push("", "citations:");
    for (const citation of entry.citations) {
      const link = citation.doi === undefined ? (citation.url === undefined ? "" : ` <${citation.url}>`) : ` doi:${citation.doi}`;
      lines.push(`  ${citation.text}${link}`);
    }
  }
  const { recipe } = entry;
  lines.push("", "recipe:");
  if (recipe.status === "not-fetchable") {
    lines.push(`  not fetchable: ${recipe.reason}`);
  } else {
    const memberText = "member" in recipe.archive ? `, member ${selectorText(recipe.archive.member)}` : "members" in recipe.archive ? `, members ${selectorText(recipe.archive.members)}` : "";
    const { format, ...options } = recipe.parser;
    lines.push(`  source: [${String(recipe.source)}]`, `  archive: ${recipe.archive.kind}${memberText}`, `  parser: ${format} ${JSON.stringify(options)}`);
  }
  lines.push("", `crosswalk: ${crosswalk.source} -> ${crosswalk.target}`);
  for (const rule of crosswalk.rules) {
    lines.push(`  ${rule.op} ${rule.from} -> ${rule.to}`);
  }
  for (const rule of crosswalk.oneWay) {
    lines.push(rule.op === "drop" ? `  drop ${rule.from} (encode)` : `  default ${rule.to} = ${JSON.stringify(rule.value)} (${rule.direction})`);
  }
  const counts = Object.entries(entry.expectedCounts);
  if (counts.length > 0) {
    lines.push("", `expected counts: ${counts.map(([key, count]) => `${key} ${String(count)}`).join(", ")}`);
  }
  const properties = Object.entries(entry.properties);
  if (properties.length > 0) {
    lines.push("", "properties:", ...properties.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`));
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Where `fetch` writes provenance: beside the result, `.json` replaced by `.provenance.json` (or the suffix appended to a path without one).
 * @param out - The result path.
 * @returns The provenance path.
 */
export function provenancePath(out: string): string {
  return out.endsWith(".json") ? `${out.slice(0, -".json".length)}.provenance.json` : `${out}.provenance.json`;
}

/**
 * Formats a list of validation issues, one per line.
 * @param issues - The issues.
 * @returns The text.
 */
function formatIssues(issues: readonly SyntaxIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}\n`).join("");
}

/**
 * Runs the command. A KeepsetError from the library (an unknown dataset, a failing recipe) is the command's failure to answer and becomes exit status 2 with its message; anything else is a bug and propagates.
 * @param args - The arguments after the command name.
 * @param library - The library calls.
 * @param io - Output.
 * @returns The exit status.
 */
export async function run(args: readonly string[], library: CliLibrary, io: CliIo): Promise<number> {
  let parsed: CommandLine;
  try {
    parsed = parseCommandLine(args);
  } catch (error) {
    // parseArgs reports an unknown option or a missing option value as a TypeError carrying the reason; that is bad usage, not a failure of the command.
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);

    return EXIT_FAILED;
  }
  const { values, positionals } = parsed;
  if (values.version === true) {
    io.writeStdout(`${io.version}\n`);

    return EXIT_OK;
  }
  if (values.help === true) {
    io.writeStdout(usage);

    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  const reject = (message: string): number => {
    io.writeStderr(`${message}\n\n${usage}`);

    return EXIT_FAILED;
  };
  try {
    if (command === "search") {
      if (rest.length > 1) {
        return reject("search takes at most one text argument; quote a phrase");
      }
      const [text] = rest;
      const query: DatasetQuery = {
        ...(text === undefined ? {} : { text }),
        ...(values.kind === undefined ? {} : { kind: values.kind }),
        ...(values.domain === undefined ? {} : { domain: values.domain }),
        ...(values.namespace === undefined ? {} : { namespace: values.namespace }),
        ...(values.category === undefined ? {} : { category: values.category }),
      };
      const datasets = library.listDatasets(query);
      io.writeStdout(values.json === true ? json(datasets.map((dataset) => dataset.entry)) : formatSearch(datasets));

      return EXIT_OK;
    }
    if (command === "namespaces") {
      if (rest.length > 1) {
        return reject("namespaces takes at most one path");
      }
      const [path] = rest;
      if (path !== undefined && library.listDatasets({ namespace: path }).length === 0) {
        io.writeStderr(`no namespace ${JSON.stringify(path)} in the catalogue\n`);

        return EXIT_FAILED;
      }
      const nodes = library.listNamespaces(path);
      io.writeStdout(values.json === true ? json(nodes) : formatNamespaces(nodes));

      return EXIT_OK;
    }
    const [name, ...extra] = rest;
    if (command === undefined) {
      return reject("expected a command");
    }
    if (!["show", "fetch", "validate", "roundtrip"].includes(command)) {
      return reject(`unknown command ${command}`);
    }
    if (name === undefined || extra.length > 0) {
      return reject(`${command} takes exactly one dataset`);
    }
    // The name typed may be an alias or a qualified name; everything the command prints or writes uses the entry's own id, so a name containing / never becomes part of a file path.
    const dataset = library.getDataset(name);
    const { id } = dataset.entry;
    if (command === "show") {
      io.writeStdout(values.json === true ? json(dataset) : formatShow(dataset));

      return EXIT_OK;
    }
    if (command === "validate") {
      const issues = library.validateDataset(dataset);
      if (issues.length > 0) {
        io.writeStdout(formatIssues(issues));

        return EXIT_NO;
      }
      io.writeStdout(`${id} is valid\n`);

      return EXIT_OK;
    }
    if (command === "fetch") {
      const fetched = await library.fetchDataset(id);
      const out = values.out ?? `${id}.json`;
      io.writeFile(out, json(fetched.data));
      io.writeFile(provenancePath(out), json(fetched.provenance));
      for (const warning of fetched.warnings) {
        io.writeStderr(`warning: ${warning}\n`);
      }
      const counts = [...library.countTarget(fetched)].map(([key, count]) => `${key} ${String(count)}`).join(", ");
      io.writeStdout(`wrote ${out} (${counts}) and ${provenancePath(out)}\n`);

      return EXIT_OK;
    }
    const report = await library.roundTripDataset(id);
    if (report.holds) {
      io.writeStdout(`${id}: the round trip holds\n`);

      return EXIT_OK;
    }
    io.writeStdout(`${id}: the round trip does not hold at ${report.path === "" ? "(root)" : report.path}: ${report.message}\n`);

    return EXIT_NO;
  } catch (error) {
    if (error instanceof KeepsetError) {
      io.writeStderr(`${error.message}\n`);

      return EXIT_FAILED;
    }
    throw error;
  }
}
