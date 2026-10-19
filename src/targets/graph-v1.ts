import { z } from "zod";
import { define } from "../define";
import { recordOf } from "../record";
import { JsonScalarSchema } from "./json-scalar";
import { addDuplicateIdIssues } from "./node-ids";

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
      const ids = addDuplicateIdIssues(graph.nodes, ctx);
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
