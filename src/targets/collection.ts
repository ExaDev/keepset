import { z } from "zod";
import { define } from "../define";
import { recordOf } from "../record";
import { JsonScalarSchema, type JsonScalar } from "./json-scalar";

/** One member of a collection: the id that names it within the set (for a collection read from an archive, the path of the member it came from) beside the fields of the category's own document, which are the instance's `meta`, nodes and so on. */
export type Instance<Document extends object> = { readonly id: string } & Document;

/** A collection of documents of one category: `{ meta, instances }`, where `meta` is the entry's own metadata and each instance is a document of the category under an id. */
export interface Collection<Document extends object> {
  readonly meta: Readonly<Record<string, JsonScalar>>;
  readonly instances: readonly Instance<Document>[];
}

/** The count a collection entry may record: how many instances it holds. */
export const COLLECTION_COUNTED = ["instances"] as const;

/**
 * Whether a value is an object with a non-empty string `id`, which is what a member must have before the rest of it is held to the category's document schema.
 * @param value - Anything a collection's `instances` array holds.
 * @returns True for an object with such an id.
 */
function hasId(value: unknown): value is { readonly id: string } {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && value.id !== "";
}

/**
 * The schema of one member: a non-empty string `id` and, in the rest of the object, a document of the category. Issues from the document's own schema keep their paths, so a failure names the field of the instance.
 * @param document - The category's document schema.
 * @returns The member schema.
 */
function instanceOf<Document extends object>(document: z.ZodType<Document>): z.ZodType<Instance<Document>> {
  return z.custom<Instance<Document>>().superRefine((given, ctx) => {
    if (!hasId(given)) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "an instance has a non-empty string id" });

      return;
    }
    const result = document.safeParse(Object.fromEntries(Object.entries(given).filter(([key]) => key !== "id")));
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
    }
  });
}

/**
 * The schema of a collection of documents of a category, derived from the category's own document schema, so a category needs nothing of its own to be collected. Beyond each instance being a valid document, the instance ids must be unique in the set; node ids and the like stay unique only within an instance, because every instance numbers its own.
 * @param document - The category's document schema.
 * @returns The collection schema, with the attached type guard.
 */
export function collectionOf<Document extends object>(document: z.ZodType<Document>): z.ZodType<Collection<Document>> & { is: (value: unknown) => value is Collection<Document> } {
  return define(
    z
      .object({
        meta: recordOf(z.string().min(1), JsonScalarSchema),
        instances: z.array(instanceOf(document)),
      })
      .strict()
      .superRefine((collection, ctx) => {
        const ids = new Set<string>();
        for (const [index, instance] of collection.instances.entries()) {
          if (ids.has(instance.id)) {
            ctx.addIssue({ code: "custom", path: ["instances", index, "id"], message: `duplicate instance id ${JSON.stringify(instance.id)}` });
          }
          ids.add(instance.id);
        }
      }),
  );
}
