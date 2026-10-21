import { z } from "zod";
import { NativeParseError } from "../errors";
import { NodeOrder, type NativeEdge, type NativeGraph } from "./native";

/** One chemical synapse of the file: the presynaptic neuron and every neuron it contacts. The file's other fields (CATMAID and VAST ids, the synapse's size and its partners' shares of it) are not read. */
const SynapseSchema = z.object({ pre: z.string().min(1), post: z.array(z.string().min(1)).min(1) });

/**
 * Parses a Witvliet synapse file: a JSON array of chemical synapses, each a `pre` neuron and its `post` partners. A synapse is polyadic, one presynaptic site facing several partners, and each partner is one edge from `pre` to it, so a synapse with three partners is three edges and a partner listed twice is two. Nodes are the neurons in order of first appearance, `pre` before its partners.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError, numbering the synapse (from 1) in place of a line, when the text is not JSON, not an array, a synapse lacks its `pre` or `post` or names an empty neuron, or the file holds no synapse.
 */
export function parseWitvlietSynapses(text: string): NativeGraph {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new NativeParseError("witvliet-synapses", 1, `the file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(document)) {
    throw new NativeParseError("witvliet-synapses", 1, "the file is not a JSON array of synapses");
  }
  const order = new NodeOrder();
  const edges: NativeEdge[] = [];
  for (const [index, item] of document.entries()) {
    const synapse = SynapseSchema.safeParse(item);
    if (!synapse.success) {
      throw new NativeParseError("witvliet-synapses", index + 1, `synapse ${String(index + 1)} is not a pre neuron with a non-empty list of post neurons: ${synapse.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    }
    order.add(synapse.data.pre);
    for (const post of synapse.data.post) {
      order.add(post);
      edges.push({ source: synapse.data.pre, target: post });
    }
  }
  if (edges.length === 0) {
    throw new NativeParseError("witvliet-synapses", 1, "the file holds no synapses");
  }

  return { nodes: order.nodes(), edges };
}
