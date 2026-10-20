import { z } from "zod";
import { define } from "../define";
import { recordOf } from "../record";
import { JsonScalarSchema } from "./json-scalar";
import { OrNodeSchema } from "./or-v1";
import { addDuplicateIdIssues } from "./node-ids";

/** One instance of a set: an or/v1 instance, `{ meta, nodes }`, with the id that names it within the set (for a collection read from an archive, the member's path). */
export const OrInstanceSchema = z
  .object({
    id: z.string().min(1),
    meta: recordOf(z.string().min(1), JsonScalarSchema),
    nodes: z.array(OrNodeSchema),
  })
  .strict();
export type OrInstance = z.infer<typeof OrInstanceSchema>;

/**
 * The or-set/v1 normalisation target: `{ meta, instances }`, a collection of operations-research instances such as a benchmark suite, each instance an or/v1 document (`{ meta, nodes }`) under an id of its own. Beyond the shapes it checks that instance ids are unique in the set and node ids unique within each instance. A node id need not be unique across instances, because every instance numbers its own nodes.
 */
export const OrSetV1Schema = define(
  z
    .object({
      meta: recordOf(z.string().min(1), JsonScalarSchema),
      instances: z.array(OrInstanceSchema),
    })
    .strict()
    .superRefine((set, ctx) => {
      const ids = new Set<string>();
      for (const [index, instance] of set.instances.entries()) {
        if (ids.has(instance.id)) {
          ctx.addIssue({ code: "custom", path: ["instances", index, "id"], message: `duplicate instance id ${JSON.stringify(instance.id)}` });
        }
        ids.add(instance.id);
        addDuplicateIdIssues(instance.nodes, ctx, ["instances", index]);
      }
    }),
);
export type OrSetV1 = z.infer<typeof OrSetV1Schema>;
