import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseEdgeList } from "./edge-list";
import { parseNative } from "./parse-native";

type EdgeListParser = Extract<Parser, { format: "edge-list" }>;

/** WormAtlas's NeuronConnect sheet as the xls reader writes it: Neuron 1, Neuron 2, the synapse type and the synapse count, the lines taken from the file as they stand (a gap junction is listed from each side, a chemical synapse once as a send from its presynaptic neuron and once as a receive from its postsynaptic one). */
const NEURON_CONNECT = ["Neuron 1,Neuron 2,Type,Nbr", "ADAR,ADAL,EJ,1", "AVDR,ADAL,EJ,2", "ADEL,ADAL,Sp,1", "AIBR,ADAL,Rp,2", "BDUL,ADEL,S,3", "ADAL,ADAR,EJ,1", "ADAL,AIBR,Sp,2", "ADAL,AVDR,EJ,2", "AS02,NMJ,NMJ,11"].join("\n");
const COLUMN = { from: 0, to: 1, type: 2, count: 3 } as const;
const SENDS = ["S", "Sp"];
const EXPECTED = { synapsesFromBdul: 3, synapsesFromAdal: 2 } as const;

const parser = (options: Partial<EdgeListParser> = {}): EdgeListParser => ({ format: "edge-list", encoding: "utf-8", delimiter: "comma", skipLines: 1, commentPrefixes: [], sourceColumn: COLUMN.from, targetColumn: COLUMN.to, ...options });

describe("parseEdgeList on a table of several relations", () => {
  it("keeps only the lines whose type column names a kept relation", () => {
    const graph = parseEdgeList(NEURON_CONNECT, parser({ keep: { column: COLUMN.type, values: SENDS } }));
    expect(graph.edges).toEqual([
      { source: "ADEL", target: "ADAL" },
      { source: "BDUL", target: "ADEL" },
      { source: "ADAL", target: "AIBR" },
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual(["ADEL", "ADAL", "BDUL", "AIBR"]);
  });

  it("emits as many edges for a line as its multiplicity column says", () => {
    const graph = parseEdgeList(NEURON_CONNECT, parser({ keep: { column: COLUMN.type, values: SENDS }, multiplicityColumn: COLUMN.count }));
    expect(graph.edges.filter((edge) => edge.source === "BDUL")).toHaveLength(EXPECTED.synapsesFromBdul);
    expect(graph.edges.filter((edge) => edge.source === "ADAL")).toHaveLength(EXPECTED.synapsesFromAdal);
    expect(graph.edges).toHaveLength(1 + EXPECTED.synapsesFromBdul + EXPECTED.synapsesFromAdal);
  });

  it("emits each pair of a mirrored table once, in the direction it is first listed, keeping self-loops", () => {
    const table = `${NEURON_CONNECT}\nRMEL,RMEL,EJ,1`;
    const graph = parseEdgeList(table, parser({ keep: { column: COLUMN.type, values: ["EJ"] }, mirrored: true }));
    expect(graph.edges).toEqual([
      { source: "ADAR", target: "ADAL" },
      { source: "AVDR", target: "ADAL" },
      { source: "RMEL", target: "RMEL" },
    ]);
  });

  it("reads a line whose count is zero as no edge, adding none of its neurons", () => {
    const graph = parseEdgeList("h\nAVFL,VB01,Sp,0\nFLPR,VB01,Sp,1", parser({ multiplicityColumn: COLUMN.count }));
    expect(graph).toEqual({ nodes: [{ id: "FLPR" }, { id: "VB01" }], edges: [{ source: "FLPR", target: "VB01" }] });
  });

  it("refuses a mirrored line without its mirror, one whose mirror has another count, and a count that is not a whole number", () => {
    const options = parser({ keep: { column: COLUMN.type, values: ["EJ"] }, mirrored: true });
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,1", options)).toThrow(/line 2: the table is mirrored but this line has no mirror image/);
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,1\nADAL,ADAR,EJ,2", { ...options, multiplicityColumn: COLUMN.count })).toThrow(NativeParseError);
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,1.5", parser({ multiplicityColumn: COLUMN.count }))).toThrow(/not a whole number/);
    expect(() => parseEdgeList("h\nADAR,ADAL,EJ,-1", parser({ multiplicityColumn: COLUMN.count }))).toThrow(/not a whole number/);
  });
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const edgeList = (options: Partial<EdgeListParser> = {}): EdgeListParser => ({
  format: "edge-list",
  encoding: "utf-8",
  delimiter: "detect",
  skipLines: 0,
  commentPrefixes: ["#", "%"],
  sourceColumn: 0,
  targetColumn: 1,
  ...options,
});

function parseError(run: () => unknown): NativeParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof NativeParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a NativeParseError");
}

/** The header and rows of BIOGRID-ORGANISM-Homo_sapiens-5.0.262.tab3.txt: two physical interactions between human proteins, a genetic interaction between human genes, and a physical interaction of a human protein with a mouse one. */
const BIOGRID = [
  "#BioGRID Interaction ID\tEntrez Gene Interactor A\tEntrez Gene Interactor B\tBioGRID ID Interactor A\tBioGRID ID Interactor B\tSystematic Name Interactor A\tSystematic Name Interactor B\tOfficial Symbol Interactor A\tOfficial Symbol Interactor B\tSynonyms Interactor A\tSynonyms Interactor B\tExperimental System\tExperimental System Type\tAuthor\tPublication Source\tOrganism ID Interactor A\tOrganism ID Interactor B\tThroughput\tScore\tModification\tQualifications\tTags\tSource Database\tSWISS-PROT Accessions Interactor A\tTREMBL Accessions Interactor A\tREFSEQ Accessions Interactor A\tSWISS-PROT Accessions Interactor B\tTREMBL Accessions Interactor B\tREFSEQ Accessions Interactor B\tOntology Term IDs\tOntology Term Names\tOntology Term Categories\tOntology Term Qualifier IDs\tOntology Term Qualifier Names\tOntology Term Types\tOrganism Name Interactor A\tOrganism Name Interactor B",
  "103\t6416\t2318\t112315\t108607\t-\t-\tMAP2K4\tFLNC\tJNKK|JNKK1|MAPKK4|MEK4|MKK4|PRKMK4|SAPKK-1|SAPKK1|SEK1|SERK1|SKK1\tABP-280|ABP280A|ABPA|ABPL|FLN2|MFM5|MPD4\tTwo-hybrid\tphysical\tMarti A (1997)\tPUBMED:9006895\t9606\t9606\tLow Throughput\t-\t-\t-\t-\tBIOGRID\tP45985\t-\tNP_003001|NP_001268364\tQ14315\tQ59H94\tNP_001120959|NP_001449\t-\t-\t-\t-\t-\t-\tHomo sapiens\tHomo sapiens",
  "244457\t613\t3205\t107083\t109445\t-\t-\tBCR\tHOXA9\tALL|BCR1|CML|D22S11|D22S662|PHL\tABD-B|HOX1|HOX1.7|HOX1G\tPhenotypic Enhancement\tgenetic\tMayotte N (2002)\tPUBMED:12393433\t9606\t9606\tLow Throughput\t-\t-\tin vivo CML model.\t-\tBIOGRID\tP11274\t-\tNP_004318|NP_067585\tP31269\t-\tNP_689952\t-\t-\t-\t-\t-\t-\tHomo sapiens\tHomo sapiens",
  "117015\t4087\t75141\t110262\t217250\t-\t-\tSMAD2\tRasd2\tJV18|JV18-1|MADH2|MADR2|hMAD-2|hSMAD2\t4930526B11Rik|AU045414|Rhes|TEM-2|TEM2\tAffinity Capture-Luminescence\tphysical\tBarrios-Rodiles M (2005)\tPUBMED:15761153\t9606\t10090\tHigh Throughput\t-\t-\t-\t-\tBIOGRID\tQ15796\tB7Z5N5|Q53XR6\tNP_001003652|NP_001129409|NP_005892\tP63032\t-\tNP_083458\t-\t-\t-\t-\t-\t-\tHomo sapiens\tMus musculus",
  "117\t84665\t88\t124185\t106603\t-\t-\tMYPN\tACTN2\tCMD1DD|CMH22|MYOP|RCM4\tCMD1AA\tTwo-hybrid\tphysical\tBang ML (2001)\tPUBMED:11309420\t9606\t9606\tLow Throughput\t-\t-\t-\t-\tBIOGRID\tQ86TC9\tA0A087WX60\tNP_001243197|NP_001243196|NP_115967\tP35609\tQ59FD9|F6THM6\tNP_001094|NP_001265272|NP_001265273\t-\t-\t-\t-\t-\t-\tHomo sapiens\tHomo sapiens",
].join("\n");

/** The data rows of the excerpt, after its header line. */
const BIOGRID_ROWS = BIOGRID.split("\n").length - 1;

/** The number of the line written after the excerpt. */
const AFTER_BIOGRID = BIOGRID.split("\n").length + 1;

/** The recipe the import gives the BioGRID organism archive's Homo sapiens file. */
const biogrid = edgeList({
  delimiter: "tab",
  commentPrefixes: ["#"],
  sourceColumn: 3,
  targetColumn: 4,
  where: [
    { column: 12, equals: "physical" },
    { column: 15, equals: "9606" },
    { column: 16, equals: "9606" },
  ],
});

describe("the edge-list parser's where conditions", () => {
  it("keeps only the lines meeting every condition: physical interactions between two human proteins, by BioGRID id", () => {
    expect(parseNative(utf8(`${BIOGRID}\n`), biogrid)).toEqual({
      nodes: [{ id: "112315" }, { id: "108607" }, { id: "124185" }, { id: "106603" }],
      edges: [
        { source: "112315", target: "108607" },
        { source: "124185", target: "106603" },
      ],
    });
  });

  it("reads every data line as an edge without conditions", () => {
    expect(parseNative(utf8(`${BIOGRID}\n`), edgeList({ delimiter: "tab", commentPrefixes: ["#"], sourceColumn: 3, targetColumn: 4 })).edges).toHaveLength(BIOGRID_ROWS);
  });

  it("still checks a line it does not keep for the fields its conditions name", () => {
    const short = `${BIOGRID}\n1\t2\t3\t4\t5\tgenetic\n`;
    expect(parseError(() => parseNative(utf8(short), biogrid)).line).toBe(AFTER_BIOGRID);
  });

  it("refuses a file in which no line meets the conditions, saying so", () => {
    expect(() => parseNative(utf8(`${BIOGRID}\n`), edgeList({ ...biogrid, where: [{ column: 12, equals: "none" }] }))).toThrow(/no line of the file meets the recipe's where conditions/);
  });
});

describe("the edge-list parser on real downloads", () => {
  it("reads the SNAP signed Epinions list (soc-sign-epinions.txt.gz), dropping the sign", () => {
    const text = "# Directed graph: soc-sign-epinions\n# Epinions signed social network\n# Nodes: 131828 Edges: 841372\n# FromNodeId\tToNodeId\tSign\n0\t1\t-1\n1\t128552\t-1\n2\t3\t1\n";
    expect(parseNative(utf8(text), edgeList({ delimiter: "tab", commentPrefixes: ["#"] }))).toEqual({
      nodes: [{ id: "0" }, { id: "1" }, { id: "128552" }, { id: "2" }, { id: "3" }],
      edges: [
        { source: "0", target: "1" },
        { source: "1", target: "128552" },
        { source: "2", target: "3" },
      ],
    });
  });

  it("reads the STRING protein links (9606.protein.links.v12.0.txt.gz) under their header line", () => {
    const text = "protein1 protein2 combined_score\n9606.ENSP00000000233 9606.ENSP00000356607 173\n9606.ENSP00000000233 9606.ENSP00000427567 154\n";
    expect(parseNative(utf8(text), edgeList({ delimiter: "space", skipLines: 1, commentPrefixes: [] })).edges).toEqual([
      { source: "9606.ENSP00000000233", target: "9606.ENSP00000356607" },
      { source: "9606.ENSP00000000233", target: "9606.ENSP00000427567" },
    ]);
  });

  it("reads OpenFlights routes (routes.dat) from source airport to destination airport, not airline to airline id", () => {
    const text = "2B,410,AER,2965,KZN,2990,,0,CR2\r\n2B,410,ASF,2966,KZN,2990,,0,CR2\r\n2B,410,ASF,2966,MRV,2962,,0,CR2\r\n";
    expect(parseNative(utf8(text), edgeList({ delimiter: "comma", commentPrefixes: [], sourceColumn: 2, targetColumn: 4 }))).toEqual({
      nodes: [{ id: "AER" }, { id: "KZN" }, { id: "ASF" }, { id: "MRV" }],
      edges: [
        { source: "AER", target: "KZN" },
        { source: "ASF", target: "KZN" },
        { source: "ASF", target: "MRV" },
      ],
    });
  });

  it("reads the Arenas e-mail list (email.zip's email.txt), CRLF lines of sender, recipient and weight", () => {
    expect(parseNative(utf8("1   2   1\r\n1   3   1\r\n1   4   1\r\n"), edgeList({ delimiter: "whitespace" })).edges).toEqual([
      { source: "1", target: "2" },
      { source: "1", target: "3" },
      { source: "1", target: "4" },
    ]);
  });
});

describe("the edge-list parser on text in pieces", () => {
  it("reads the same graph and reports the same error line whatever the pieces", () => {
    const text = `${BIOGRID}\n`;
    const whole = parseEdgeList(text, biogrid);
    for (let size = 1; size <= text.length; size *= 2) {
      const pieces = Array.from({ length: Math.ceil(text.length / size) }, (_, piece) => text.slice(piece * size, (piece + 1) * size));
      expect(parseEdgeList(pieces, biogrid)).toEqual(whole);
      expect(parseError(() => parseEdgeList([...pieces, "1\t2\n"], biogrid)).line).toBe(AFTER_BIOGRID);
    }
  });
});
