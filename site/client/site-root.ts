/* The page's path back to the site root, shared by the entry and the lazily loaded preview. */

/** @returns The path back to the site root, which every page's layout sets as data-root. */
export function siteRoot(): string {
  const { root } = document.body.dataset;
  if (root === undefined) {
    throw new Error("the page has no data-root");
  }

  return root;
}
