import { z } from "zod";
import { define } from "../define";
import { recordOf } from "../record";

/** A JSON scalar: the only values graph/v1 metadata may hold, so `meta` stays a flat record any consumer can tabulate. `z.number()` already rejects NaN and the infinities, which JSON cannot carry. */
export const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonScalar = z.infer<typeof JsonScalarSchema>;

/** A node: an id, an optional type, and whatever else the dataset carries. The target fixes only what every graph consumer needs, so extra fields pass through untouched. */
export const GraphNodeSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1).optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

/** An edge: source and target node ids, an optional type, and whatever else the dataset carries. Direction is the dataset's own: graph/v1 records it in `meta`, never by duplicating edges. */
export const GraphEdgeSchema = z.looseObject({
  source: z.string().min(1),
  target: z.string().min(1),
  type: z.string().min(1).optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/**
 * The graph/v1 normalisation target: `{ meta, nodes, edges }`, the shape the thesis pipeline's benchmark cache already uses. It describes the result `fetchDataset` resolves a graph entry to, not what a source file may contain. Beyond the field shapes it checks the two properties every consumer relies on: node ids are unique, and every edge endpoint names a node.
 */
export const GraphV1Schema = define(
  z
    .object({
      meta: recordOf(z.string().min(1), JsonScalarSchema),
      nodes: z.array(GraphNodeSchema),
      edges: z.array(GraphEdgeSchema),
    })
    .strict()
    .superRefine((graph, ctx) => {
      const ids = new Set<string>();
      for (const [index, node] of graph.nodes.entries()) {
        if (ids.has(node.id)) {
          ctx.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `duplicate node id ${JSON.stringify(node.id)}` });
        }
        ids.add(node.id);
      }
      for (const [index, edge] of graph.edges.entries()) {
        for (const end of ["source", "target"] as const) {
          if (!ids.has(edge[end])) {
            ctx.addIssue({ code: "custom", path: ["edges", index, end], message: `edge ${end} ${JSON.stringify(edge[end])} names no node` });
          }
        }
      }
    }),
);
export type GraphV1 = z.infer<typeof GraphV1Schema>;
