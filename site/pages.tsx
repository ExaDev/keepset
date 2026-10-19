/* @jsxRuntime automatic */
/** The site's page templates as React components, rendered to static markup in the generator: JSX makes escaping structural (React escapes every text node and attribute value, so catalogue data can never become markup) and lets the facts table take typed nodes instead of pre-escaped HTML strings. These components run only at build time; nothing here reaches the browser. The runtime pragma is a plain block comment because tsx, which runs the generator, transpiles JSX from pragmas rather than the tsconfig the typechecker reads, and a JSDoc-shaped one fails the tag-name lint. */

import { Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dataset, Manifest } from "keepset";
import { scriptJson, slug } from "./html";
import { datasetJsonLd, describe } from "./jsonld";

/** What every page needs to know about the site: where it is published, which catalogue and package built it, and how deep the page sits, so its links stay relative and the site works from any base path. */
export interface PageContext {
  readonly siteUrl: string;
  readonly manifest: Manifest;
  readonly packageVersion: string;
  /** The path from the page to the site root: "" at the root, "../../" two levels down. */
  readonly root: string;
}

/** One page's own content: its title and meta description as text, its main content and any extra head content (a JSON-LD script) as nodes. */
export interface PageContent {
  readonly title: string;
  readonly description: string;
  readonly body: ReactNode;
  readonly head?: ReactNode;
}

/** One row of a listing table. */
function Row({ dataset, root }: { readonly dataset: Dataset; readonly root: string }): ReactNode {
  const { entry } = dataset;

  return (
    <tr data-id={entry.id}><td><a href={`${root}datasets/${entry.id}/`}>{entry.name}</a></td><td><code>{entry.id}</code></td><td>{dataset.kind}</td><td>{entry.domain ?? ""}</td><td>{entry.recipe.status === "fetchable" ? "fetchable" : "not fetchable yet"}</td></tr>
  );
}

/** A table listing datasets, inside the wrapper that scrolls it sideways on narrow screens; the class pairs with the stylesheet's sticky desktop header. */
function Listing({ datasets, root }: { readonly datasets: readonly Dataset[]; readonly root: string }): ReactNode {
  return (
    <div className="table-wrap listing"><table className="listing"><thead><tr><th scope="col">Name</th><th scope="col">Id</th><th scope="col">Kind</th><th scope="col">Domain</th><th scope="col">Recipe</th></tr></thead><tbody>{datasets.map((dataset) => <Row key={dataset.entry.id} dataset={dataset} root={root} />)}</tbody></table></div>
  );
}

/** A two-column table of labelled values. */
function Facts({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }): ReactNode {
  return (
    <table className="facts"><tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody></table>
  );
}

/** A link whose text is its URL. */
function Link({ url }: { readonly url: string }): ReactNode {
  return <a href={url}>{url}</a>;
}

/**
 * Wraps page content in the shared layout: head with the web app manifest and styles, the site header, and the client island's script.
 * @param context - The page context.
 * @param page - The page's own content.
 * @returns The whole document.
 */
function Layout(context: PageContext, page: PageContent): string {
  const { root, manifest } = context;
  const { title, description, body, head } = page;

  return `<!doctype html>
${renderToStaticMarkup(
  <html lang="en-GB"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{title}</title><meta name="description" content={description} /><link rel="manifest" href={`${root}manifest.webmanifest`} /><link rel="icon" href={`${root}icon.svg`} type="image/svg+xml" /><link rel="stylesheet" href={`${root}app.css`} /><meta name="theme-color" content="#1f4e79" />{head}</head><body data-root={root}><header><a className="home" href={root}>keepset</a><nav><a href={root}>All datasets</a><a href={`${root}domains/`}>Domains</a><a href={`${root}kinds/`}>Kinds</a><a href="https://github.com/Mearman/keepset">Source</a></nav></header><main>{body}</main><footer>Catalogue <code>{manifest.id}</code> {manifest.version}, built by keepset {context.packageVersion}.</footer><script type="module" src={`${root}app.js`} /></body></html>,
)}
`;
}

/**
 * The home page: every dataset in a static table, with a search box and filters the client island wires to the search index.
 * @param context - The page context.
 * @param datasets - Every dataset.
 * @returns The document.
 */
export function homePage(context: PageContext, datasets: readonly Dataset[]): string {
  const body = (
    <Fragment><h1>keepset</h1><p>{context.manifest.description} Each entry's page shows its sources, licence, recipe and crosswalk, and the command that fetches it.</p><div id="island-root" /><Listing datasets={datasets} root={context.root} /></Fragment>
  );

  return Layout(context, { title: "keepset: dataset catalogue", description: context.manifest.description, body });
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
  const licenceNode: ReactNode = licence.kind === "spdx" ? <a href={`https://spdx.org/licenses/${licence.id}.html`}>{licence.id}</a> : licence.kind === "custom" ? <a href={licence.url}>{licence.name}</a> : "not recorded by the source";

  const sections: ReactNode[] = [
    <h1 key="name">{entry.name}</h1>,
    entry.description === undefined ? null : <p className="description" key="description">{entry.description}</p>,
    <p className="command" key="command"><code>{command}</code> <span data-copy-command={command} /></p>,
    recipe.status === "fetchable" ? null : <p className="warning" key="warning">This entry has no fetchable recipe yet: {recipe.reason}</p>,
    <h2 key="overview">Overview</h2>,
    <Facts key="overview" rows={[
      ["Id", <code key="id">{entry.id}</code>],
      ["Category", <code key="category">{entry.category}</code>],
      ["Kind", <a key="kind" href={`../../kinds/${slug(dataset.kind)}/`}>{dataset.kind}</a>],
      ...(entry.domain === undefined ? [] : [["Domain", <a key="domain" href={`../../domains/${slug(entry.domain)}/`}>{entry.domain}</a>] as const]),
      ...(entry.tags.length === 0 ? [] : [["Tags", entry.tags.join(", ")] as const]),
      ["Licence", licenceNode],
      ["Catalogue", <Fragment key="catalogue"><code>{dataset.catalogue.id}</code> {dataset.catalogue.version}</Fragment>],
    ]} />,
    <h2 key="sources">Sources and provenance</h2>,
    <div className="table-wrap" key="sources"><table className="sources"><thead><tr><th scope="col">#</th><th scope="col">URL</th><th scope="col">Status</th><th scope="col">Retrieved</th><th scope="col">Pinned snapshot</th></tr></thead><tbody>{entry.sources.map((source, index) => <tr key={String(index)}><td>{String(index)}</td><td><Link url={source.url} /></td><td>{source.status}</td><td>{source.retrieved}</td><td>{source.snapshot === undefined ? "" : <a href={source.snapshot.url}>{source.snapshot.timestamp}</a>}</td></tr>)}</tbody></table></div>,
    entry.citations.length === 0 ? null : <h2 key="citations">Citations</h2>,
    entry.citations.length === 0 ? null : (
      <ul className="citations" key="citations-list">{entry.citations.map((cited, index) => (
        <li key={String(index)}>{cited.text}{cited.doi === undefined ? null : <Fragment>{" "}<a href={`https://doi.org/${cited.doi}`}>doi:{cited.doi}</a></Fragment>}{cited.url === undefined ? null : <Fragment>{" "}<Link url={cited.url} /></Fragment>}</li>
      ))}</ul>
    ),
    <h2 key="recipe">Recipe</h2>,
    recipe.status === "not-fetchable" ? (
      <Facts key="recipe-facts" rows={[["Status", `not fetchable: ${recipe.reason}`]]} />
    ) : (
      <Facts key="recipe-facts" rows={[
        ["Source", `#${String(recipe.source)}`],
        ["Archive", recipe.archive.kind],
        ...("member" in recipe.archive ? [["Member", "path" in recipe.archive.member ? <code key="member-path">{recipe.archive.member.path}</code> : <Fragment key="member-extensions">ending {recipe.archive.member.extensions.flatMap((extension, index) => index === 0 ? [<code key={extension}>{extension}</code>] : [" or ", <code key={extension}>{extension}</code>])}</Fragment>] as const] : []),
        ...Object.entries(recipe.parser).map(([option, value]) => [`Parser ${option}`, <code key={option}>{JSON.stringify(value)}</code>] as const),
      ]} />
    ),
    <h2 key="crosswalk">Crosswalk</h2>,
    <p key="crosswalk-note"><code>{crosswalk.source}</code> to <code>{crosswalk.target}</code>, as a twindex crosswalk.</p>,
    <div className="table-wrap" key="crosswalk"><table className="crosswalk"><thead><tr><th scope="col">Rule</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Direction</th></tr></thead><tbody>{[
      ...crosswalk.rules.map((rule) => <tr key={`${rule.op}-${rule.from}-${rule.to}`}><td>{rule.op}</td><td><code>{rule.from}</code></td><td><code>{rule.to}</code></td><td>both</td></tr>),
      ...crosswalk.oneWay.map((rule, index) => rule.op === "drop" ? <tr key={`drop-${String(index)}`}><td>drop</td><td><code>{rule.from}</code></td><td /><td>{rule.direction}</td></tr> : <tr key={`default-${String(index)}`}><td>default</td><td><code>{JSON.stringify(rule.value)}</code></td><td><code>{rule.to}</code></td><td>{rule.direction}</td></tr>),
    ]}</tbody></table></div>,
    Object.keys(entry.expectedCounts).length === 0 ? null : <h2 key="counts">Expected counts</h2>,
    Object.keys(entry.expectedCounts).length === 0 ? null : <Facts key="counts-facts" rows={Object.entries(entry.expectedCounts).map(([key, count]) => [key, count.toLocaleString("en-GB")] as const)} />,
    Object.keys(entry.properties).length === 0 ? null : <h2 key="properties">Properties</h2>,
    Object.keys(entry.properties).length === 0 ? null : <Facts key="properties-facts" rows={Object.entries(entry.properties).map(([key, value]) => [key, <code key={key}>{JSON.stringify(value)}</code>] as const)} />,
  ];

  return Layout(context, {
    title: `${entry.name}: keepset`,
    description: describe(dataset),
    body: sections.filter((section) => section !== null),
    head: <Fragment><link rel="canonical" href={pageUrl} /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: scriptJson(jsonLd) }} /></Fragment>,
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
  return Layout(context, { title: `${title}: keepset`, description: `${title}: datasets in the keepset catalogue.`, body: <Fragment><h1>{title}</h1><Listing datasets={datasets} root={context.root} /></Fragment> });
}

/**
 * An index of listing pages: every domain or kind, with how many datasets each holds.
 * @param context - The page context (`root` is one level up).
 * @param title - "Domains" or "Kinds".
 * @param groups - Each group's label and datasets.
 * @returns The document.
 */
export function groupsPage(context: PageContext, title: string, groups: readonly { readonly label: string; readonly count: number }[]): string {
  return Layout(context, { title: `${title}: keepset`, description: `${title} of the datasets in the keepset catalogue.`, body: <Fragment><h1>{title}</h1><ul className="groups">{groups.map((group) => <li key={group.label}><a href={`${slug(group.label)}/`}>{group.label}</a> ({group.count})</li>)}</ul></Fragment> });
}
