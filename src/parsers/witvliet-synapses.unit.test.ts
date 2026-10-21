import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { parseWitvlietSynapses } from "./witvliet-synapses";

/** The first synapses of Witvliet et al.'s Dataset1_synapses.json, and its one synapse that faces the same partner twice, as the file writes them, with the fields the parser does not read. */
const SYNAPSES = [
  '{"catmaid_id": 6942483, "post": ["AVAR", "RICR"], "post_tid": [6801113, 6745720], "post_weights": [0.3907815631262525, 0.6092184368737475], "pre": "ADAL", "pre_tid": 6719524, "size": 374400.0, "vast_id": 1}',
  '{"catmaid_id": 6945166, "post": ["AVBL", "AVAL", "AVJR"], "post_tid": [6763113, 6661276, 6768999], "pre": "ADAL", "pre_tid": 6719655, "size": 313920.0, "vast_id": 2}',
  '{"catmaid_id": 7051187, "post": ["AIBR", "AIYR", "AIYR"], "pre": "ASER"}',
];
const file = (synapses: readonly string[]): string => `[${synapses.join(", ")}]`;

describe("parseWitvlietSynapses", () => {
  it("gives each partner of a polyadic synapse its own edge from the presynaptic neuron, a repeated partner twice", () => {
    const graph = parseWitvlietSynapses(file(SYNAPSES));
    expect(graph.edges).toEqual([
      { source: "ADAL", target: "AVAR" },
      { source: "ADAL", target: "RICR" },
      { source: "ADAL", target: "AVBL" },
      { source: "ADAL", target: "AVAL" },
      { source: "ADAL", target: "AVJR" },
      { source: "ASER", target: "AIBR" },
      { source: "ASER", target: "AIYR" },
      { source: "ASER", target: "AIYR" },
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["ADAL", "AVAR", "RICR", "AVBL", "AVAL", "AVJR", "ASER", "AIBR", "AIYR"]);
  });

  it("refuses text that is not JSON, a document that is not an array, a synapse without partners and a file with no synapses", () => {
    expect(() => parseWitvlietSynapses("{")).toThrow(/not JSON/);
    expect(() => parseWitvlietSynapses(`{"synapses": ${file(SYNAPSES)}}`)).toThrow(/not a JSON array/);
    expect(() => parseWitvlietSynapses(file([...SYNAPSES, '{"pre": "ADAL", "post": []}']))).toThrow(/line 4: synapse 4/);
    expect(() => parseWitvlietSynapses("[]")).toThrow(NativeParseError);
  });
});
