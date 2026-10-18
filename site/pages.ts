import type { Dataset, Manifest } from "keepset";
import { escapeHtml as e, scriptJson, slug } from "./html";
import { datasetJsonLd, describe } from "./jsonld";

/** What every page needs to know about the site: where it is published, which catalogue and package built it, and how deep the page sits, so its links stay relative and the site works from any base path. */
export interface PageContext {
  readonly siteUrl: string;
  readonly manifest: Manifest;
  readonly packageVersion: string;
  /** The path from the page to the site root: "" at the root, "../../" two levels down. */
  readonly root: string;
}

/** One page's own content: its title and meta description as text, its main content and any extra head content (a JSON-LD script) as HTML. */
export interface PageContent {
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly head?: string;
}

/** One row of a listing table. */
function row(dataset: Dataset, root: string): string {
  const { entry } = dataset;

  return `<tr data-id="${e(entry.id)}"><td><a href="${root}datasets/${e(entry.id)}/">${e(entry.name)}</a></td><td><code>${e(entry.id)}</code></td><td>${e(dataset.kind)}</td><td>${e(entry.domain ?? "")}</td><td>${entry.recipe.status === "fetchable" ? "fetchable" : "not fetchable yet"}</td></tr>`;
}

/** A table listing datasets. */
function listing(datasets: readonly Dataset[], root: string): string {
  return `<table class="listing"><thead><tr><th>Name</th><th>Id</th><th>Kind</th><th>Domain</th><th>Recipe</th></tr></thead><tbody>${datasets.map((dataset) => row(dataset, root)).join("")}</tbody></table>`;
}

/** A two-column table of labelled values; each value is already HTML. */
function facts(rows: readonly (readonly [string, string])[]): string {
  return `<table class="facts"><tbody>${rows.map(([label, value]) => `<tr><th scope="row">${e(label)}</th><td>${value}</td></tr>`).join("")}</tbody></table>`;
}

/** A link whose text is its URL. */
function link(url: string): string {
  return `<a href="${e(url)}">${e(url)}</a>`;
}

/**
 * Wraps page content in the shared layout: head with the web app manifest and styles, the site header, and the client island's script.
 * @param context - The page context.
 * @param page - The page's own content.
 * @returns The whole document.
 */
export function layout(context: PageContext, page: PageContent): string {
  const { root, manifest } = context;
  const { title, description, body, head = "" } = page;

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
<link rel="manifest" href="${root}manifest.webmanifest">
<link rel="icon" href="${root}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${root}styles.css">
<meta name="theme-color" content="#1f4e79">
${head}</head>
<body data-root="${root}">
<header><a class="home" href="${root}">keepset</a><nav><a href="${root}">All datasets</a><a href="${root}domains/">Domains</a><a href="${root}kinds/">Kinds</a><a href="https://github.com/Mearman/keepset">Source</a></nav></header>
<main>
${body}
</main>
<footer>Catalogue <code>${e(manifest.id)}</code> ${e(manifest.version)}, built by keepset ${e(context.packageVersion)}.</footer>
<script type="module" src="${root}app.js"></script>
</body>
</html>
`;
}

/**
 * The home page: every dataset in a static table, with a search box and filters the client island wires to the search index.
 * @param context - The page context.
 * @param datasets - Every dataset.
 * @returns The document.
 */
export function homePage(context: PageContext, datasets: readonly Dataset[]): string {
  const kinds = [...new Set(datasets.map((dataset) => dataset.kind))].sort();
  const domains = [...new Set(datasets.map((dataset) => dataset.entry.domain).filter((domain) => domain !== undefined))].sort();
  const options = (values: readonly string[]): string => values.map((value) => `<option value="${e(value)}">${e(value)}</option>`).join("");
  const body = `<h1>keepset</h1>
<p>${e(context.manifest.description)} Each entry's page shows its sources, licence, recipe and crosswalk, and the command that fetches it.</p>
<form class="search" role="search" hidden>
<label>Search <input type="search" name="text" autocomplete="off"></label>
<label>Kind <select name="kind"><option value="">any</option>${options(kinds)}</select></label>
<label>Domain <select name="domain"><option value="">any</option>${options(domains)}</select></label>
<output name="count"></output>
</form>
${listing(datasets, context.root)}`;

  return layout(context, { title: "keepset: dataset catalogue", description: context.manifest.description, body });
}

/**
 * An entry's page: the descriptor, the copyable fetch command, and tables of sources and provenance, licence and citations, recipe, crosswalk rules, expected counts and properties, with the schema.org Dataset JSON-LD in the head.
 * @param context - The page context (`root` is two levels up).
 * @param dataset - The dataset.
 * @returns The document.
 */
export function entryPage(context: PageContext, dataset: Dataset): string {
  const { entry, crosswalk } = dataset;
  const pageUrl = `${context.siteUrl}datasets/${entry.id}/`;
  const jsonLd = datasetJsonLd(dataset, pageUrl, context.siteUrl);
  const command = `npx keepset fetch ${entry.id}`;
  const { licence, recipe } = entry;
  const licenceHtml = licence.kind === "spdx" ? `<a href="https://spdx.org/licenses/${e(licence.id)}.html">${e(licence.id)}</a>` : licence.kind === "custom" ? `<a href="${e(licence.url)}">${e(licence.name)}</a>` : "not recorded by the source";

  const sections = [
    `<h1>${e(entry.name)}</h1>`,
    entry.description === undefined ? "" : `<p class="description">${e(entry.description)}</p>`,
    `<p class="command"><code>${e(command)}</code> <button type="button" data-copy="${e(command)}" hidden>Copy</button></p>`,
    recipe.status === "fetchable" ? "" : `<p class="warning">This entry has no fetchable recipe yet: ${e(recipe.reason)}</p>`,
    "<h2>Overview</h2>",
    facts([
      ["Id", `<code>${e(entry.id)}</code>`],
      ["Category", `<code>${e(entry.category)}</code>`],
      ["Kind", `<a href="../../kinds/${e(slug(dataset.kind))}/">${e(dataset.kind)}</a>`],
      ...(entry.domain === undefined ? [] : [["Domain", `<a href="../../domains/${e(slug(entry.domain))}/">${e(entry.domain)}</a>`] as const]),
      ...(entry.tags.length === 0 ? [] : [["Tags", entry.tags.map((tag) => e(tag)).join(", ")] as const]),
      ["Licence", licenceHtml],
      ["Catalogue", `<code>${e(dataset.catalogue.id)}</code> ${e(dataset.catalogue.version)}`],
    ]),
    "<h2>Sources and provenance</h2>",
    `<table class="sources"><thead><tr><th>#</th><th>URL</th><th>Status</th><th>Retrieved</th><th>Pinned snapshot</th></tr></thead><tbody>${entry.sources
      .map((source, index) => `<tr><td>${String(index)}</td><td>${link(source.url)}</td><td>${e(source.status)}</td><td>${e(source.retrieved)}</td><td>${source.snapshot === undefined ? "" : `<a href="${e(source.snapshot.url)}">${e(source.snapshot.timestamp)}</a>`}</td></tr>`)
      .join("")}</tbody></table>`,
    entry.citations.length === 0
      ? ""
      : `<h2>Citations</h2><ul class="citations">${entry.citations.map((cited) => `<li>${e(cited.text)}${cited.doi === undefined ? "" : ` <a href="https://doi.org/${e(cited.doi)}">doi:${e(cited.doi)}</a>`}${cited.url === undefined ? "" : ` ${link(cited.url)}`}</li>`).join("")}</ul>`,
    "<h2>Recipe</h2>",
    recipe.status === "not-fetchable"
      ? facts([["Status", `not fetchable: ${e(recipe.reason)}`]])
      : facts([
          ["Source", `#${String(recipe.source)}`],
          ["Archive", e(recipe.archive.kind)],
          ...("member" in recipe.archive ? [["Member", "path" in recipe.archive.member ? `<code>${e(recipe.archive.member.path)}</code>` : `ending ${recipe.archive.member.extensions.map((extension) => `<code>${e(extension)}</code>`).join(" or ")}`] as const] : []),
          ...Object.entries(recipe.parser).map(([option, value]) => [`Parser ${option}`, `<code>${e(JSON.stringify(value))}</code>`] as const),
        ]),
    "<h2>Crosswalk</h2>",
    `<p><code>${e(crosswalk.source)}</code> to <code>${e(crosswalk.target)}</code>, as a twindex crosswalk.</p>`,
    `<table class="crosswalk"><thead><tr><th>Rule</th><th>From</th><th>To</th><th>Direction</th></tr></thead><tbody>${[
      ...crosswalk.rules.map((rule) => `<tr><td>${e(rule.op)}</td><td><code>${e(rule.from)}</code></td><td><code>${e(rule.to)}</code></td><td>both</td></tr>`),
      ...crosswalk.oneWay.map((rule) =>
        rule.op === "drop" ? `<tr><td>drop</td><td><code>${e(rule.from)}</code></td><td></td><td>${e(rule.direction)}</td></tr>` : `<tr><td>default</td><td><code>${e(JSON.stringify(rule.value))}</code></td><td><code>${e(rule.to)}</code></td><td>${e(rule.direction)}</td></tr>`,
      ),
    ].join("")}</tbody></table>`,
    Object.keys(entry.expectedCounts).length === 0 ? "" : `<h2>Expected counts</h2>${facts(Object.entries(entry.expectedCounts).map(([key, count]) => [key, e(count.toLocaleString("en-GB"))]))}`,
    Object.keys(entry.properties).length === 0 ? "" : `<h2>Properties</h2>${facts(Object.entries(entry.properties).map(([key, value]) => [key, `<code>${e(JSON.stringify(value))}</code>`]))}`,
  ];

  return layout(context, {
    title: `${entry.name}: keepset`,
    description: describe(dataset),
    body: sections.filter((section) => section !== "").join("\n"),
    head: `<link rel="canonical" href="${e(pageUrl)}">\n<script type="application/ld+json">${scriptJson(jsonLd)}</script>\n`,
  });
}

/**
 * A listing page: the datasets of one domain or one kind.
 * @param context - The page context (`root` is two levels up).
 * @param title - What the datasets share, such as "Domain: Social network".
 * @param datasets - The datasets.
 * @returns The document.
 */
export function listingPage(context: PageContext, title: string, datasets: readonly Dataset[]): string {
  return layout(context, { title: `${title}: keepset`, description: `${title}: datasets in the keepset catalogue.`, body: `<h1>${e(title)}</h1>\n${listing(datasets, context.root)}` });
}

/**
 * An index of listing pages: every domain or kind, with how many datasets each holds.
 * @param context - The page context (`root` is one level up).
 * @param title - "Domains" or "Kinds".
 * @param groups - Each group's label and datasets.
 * @returns The document.
 */
export function groupsPage(context: PageContext, title: string, groups: readonly { readonly label: string; readonly count: number }[]): string {
  const items = groups.map((group) => `<li><a href="${e(slug(group.label))}/">${e(group.label)}</a> (${String(group.count)})</li>`).join("");

  return layout(context, { title: `${title}: keepset`, description: `${title} of the datasets in the keepset catalogue.`, body: `<h1>${e(title)}</h1>\n<ul class="groups">${items}</ul>` });
}
