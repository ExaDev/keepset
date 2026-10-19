import { z } from "zod";

/** A JSON scalar: the only values a target's metadata may hold, so `meta` stays a flat record any consumer can tabulate. `z.number()` already rejects NaN and the infinities, which JSON cannot carry. */
export const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonScalar = z.infer<typeof JsonScalarSchema>;
