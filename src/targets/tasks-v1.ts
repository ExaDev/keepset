import { z } from "zod";
import { define } from "../define";
import { recordOf } from "../record";
import { JsonScalarSchema } from "./json-scalar";
import { addDuplicateIdIssues } from "./node-ids";

/** The largest latitude and longitude, in degrees, either side of zero. */
const LATITUDE_LIMIT = 90;
const LONGITUDE_LIMIT = 180;

/** A value a node may not have: every field below is optional and nullable, null being what a source's empty cell becomes. */
function maybe<Schema extends z.ZodType>(schema: Schema): z.ZodOptional<z.ZodNullable<Schema>> {
  return schema.nullable().optional();
}

/**
 * A task: a place or case to visit or serve, such as a stop of a route or a case in a register, flat so a twindex crosswalk can map a table's columns onto it (a wildcard path must keep the same shape on both sides). The target fixes only what the datasets share and lets a crosswalk map any further column through under its own name, as graph/v1 does. `lat` and `lon` are WGS84 degrees and `x` and `y` are planar coordinates in the dataset's own system; `duration` and `travelTime` are seconds, `prize` is the dataset's own reward measure, and `prizeProbability` is the chance the reward is collected. `skill` and `territory` name what is needed to serve the node and where it sits, `status` is where it is in its lifecycle, and `opened`, `closed` and `deadline` are its lifecycle times as the source writes them, a deadline being a number where the source gives a time of day.
 */
export const TaskSchema = z.looseObject({
  id: z.string().min(1),
  lat: maybe(z.number().min(-LATITUDE_LIMIT).max(LATITUDE_LIMIT)),
  lon: maybe(z.number().min(-LONGITUDE_LIMIT).max(LONGITUDE_LIMIT)),
  x: maybe(z.number()),
  y: maybe(z.number()),
  prize: maybe(z.number()),
  prizeProbability: maybe(z.number().min(0).max(1)),
  duration: maybe(z.number().min(0)),
  travelTime: maybe(z.number().min(0)),
  skill: maybe(z.string().min(1)),
  territory: maybe(z.string().min(1)),
  status: maybe(z.string().min(1)),
  opened: maybe(z.string().min(1)),
  closed: maybe(z.string().min(1)),
  deadline: maybe(z.union([z.string().min(1), z.number()])),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * The tasks/v1 normalisation target: `{ meta, nodes }`, a set of tasks as the nodes it offers to visit or serve, whether it comes from a routing benchmark or from an open data register of permits and complaints. It describes the result `fetchDataset` resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that node ids are unique. It has no arcs: a source that carries a travel matrix or arc list keeps it out of this version.
 */
export const TasksV1Schema = define(
  z
    .object({
      meta: recordOf(z.string().min(1), JsonScalarSchema),
      nodes: z.array(TaskSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type TasksV1 = z.infer<typeof TasksV1Schema>;
