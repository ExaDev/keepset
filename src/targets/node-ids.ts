import type { z } from "zod";

/**
 * Reports each node whose id an earlier node already has, as an issue on that node's id.
 * @param nodes - The nodes of a target document, in order.
 * @param ctx - The refinement context to report to.
 * @returns The set of ids the nodes carry.
 */
export function addDuplicateIdIssues(nodes: readonly { readonly id: string }[], ctx: z.core.$RefinementCtx): Set<string> {
  const ids = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (ids.has(node.id)) {
      ctx.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `duplicate node id ${JSON.stringify(node.id)}` });
    }
    ids.add(node.id);
  }

  return ids;
}
