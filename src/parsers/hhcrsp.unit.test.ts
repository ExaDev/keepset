import { describe, expect, it } from "vitest";
import { parseHhcrsp } from "./hhcrsp";

const SERVICES = ["Service 1", "Service 2", "Service 3", "Service 4", "Service 5", "Service 6"];
const NO_SERVICES = ["", "", "", "", "", ""];
/** A caregiver's window row: its label, ETW and LTW. */
const CAREGIVER_WINDOW_CELLS = ["label", "ETW", "LTW"].length;

/** The rows of the side-by-side blocks below the positions, as the workbook lays them out: requests and their count, then durations, caregivers' skills, caregivers' windows and patients' windows, each block separated from the next by an empty column. */
interface SideBySide {
  readonly requests: readonly (readonly string[])[];
  readonly times: readonly (readonly string[])[];
  readonly skills: readonly (readonly string[])[];
  readonly caregiverWindows: readonly (readonly string[])[];
  readonly windows: readonly (readonly string[])[];
  readonly windowHeader?: readonly string[];
}

/**
 * Writes a sheet's CSV in the workbook's layout: the positions block with the travel time block beside it, an empty row, then the other blocks side by side, an empty row and the requests' column totals, which the parser must not take for a patient.
 * @param positions - The positions block's rows: node number, X and Y.
 * @param blocks - The side-by-side blocks' rows, by block, each without its label column's padding.
 * @returns The CSV text.
 */
function sheet(positions: readonly (readonly string[])[], blocks: SideBySide): string {
  const rows = Math.max(blocks.requests.length, blocks.times.length, blocks.skills.length, blocks.caregiverWindows.length, blocks.windows.length);
  const cell = (block: readonly (readonly string[])[], row: number, width: number): readonly string[] => block[row] ?? Array.from({ length: width }, () => "");
  const lines = [
    [" Patients ", "X", "Y", "", "Travel time", "0"].join(","),
    ...positions.map((row) => [...row, "", row[0] ?? "", "0"].join(",")),
    "",
    [" Pat / Ser", ...SERVICES, "", " P/SerTime", ...SERVICES, "", " CgSkills", ...SERVICES, "", " TwCaregivers", "ETW", "LTW", "", " Tw Patients", ...(blocks.windowHeader ?? ["ETW 1", "LTW 1"])].join(","),
    ...Array.from({ length: rows }, (_row, row) => [...cell(blocks.requests, row, SERVICES.length + 2), ...cell(blocks.times, row, SERVICES.length + 1), "", ...cell(blocks.skills, row, SERVICES.length + 1), "", ...cell(blocks.caregiverWindows, row, CAREGIVER_WINDOW_CELLS), "", ...cell(blocks.windows, row, (blocks.windowHeader ?? ["", ""]).length + 1)].join(",")),
    "",
    ["", "1", "1", "0", "0", "0", "0", "2"].join(","),
  ];

  return `${lines.join("\n")}\n`;
}

/** Instance A1 of the single-service, single-window set, cut to its first two patients and two caregivers, with the route's closing row at the centre as the sheet has it. */
const POSITIONS = [
  ["0", "34", "53"],
  ["1", "42", "57"],
  ["2", "5", "55"],
  ["3", "34", "53"],
];
const A1: SideBySide = {
  requests: [
    ["Patient 1", "0", "1", "0", "0", "0", "0", "1"],
    ["Patient 2", "0", "0", "1", "0", "0", "0", "1"],
  ],
  times: [
    [" Center", "0", "0", "0", "0", "0", "0"],
    [" Patient 1", "17", "19", "18", "17", "20", "18"],
    [" Patient 2", "18", "16", "18", "19", "17", "20"],
  ],
  skills: [
    [" Caregiver 1", "1", "1", "1", "0", "0", "0"],
    [" Caregiver 2", "0", "0", "0", "0", "1", "1"],
  ],
  caregiverWindows: [
    [" Caregiver 1", "0", "600"],
    [" Caregiver 2", "0", "600"],
  ],
  windows: [
    [" Patient 1", "207", "327"],
    [" Patient 2", "352", "472"],
  ],
};

describe("parseHhcrsp", () => {
  it("reads the centre and each patient's position, required service, its duration and time window, and counts the instance", () => {
    expect(parseHhcrsp(sheet(POSITIONS, A1))).toEqual({
      meta: { patients: 2, caregivers: 2, serviceKinds: SERVICES.length },
      nodes: [
        { id: "0", role: "centre", x: 34, y: 53, services: null, duration1: null, duration2: null, earliest1: null, latest1: null, earliest2: null, latest2: null },
        { id: "1", role: "patient", x: 42, y: 57, services: "Service 2", duration1: 19, duration2: null, earliest1: 207, latest1: 327, earliest2: null, latest2: null },
        { id: "2", role: "patient", x: 5, y: 55, services: "Service 3", duration1: 18, duration2: null, earliest1: 352, latest1: 472, earliest2: null, latest2: null },
      ],
    });
  });

  it("reads two synchronised services in order and two windows by their headers, an unlabelled centre row and an empty mark the count confirms (instance K6's layout)", () => {
    const parsed = parseHhcrsp(
      sheet(POSITIONS, {
        ...A1,
        requests: [
          ["Patient 1", "1", "", "0", "0", "1", "0", "2"],
          ["Patient 2", "0", "1", "0", "0", "0", "0", "1"],
        ],
        times: [["", "0", "0", "0", "0", "0", "0"], ...A1.times.slice(1)],
        windowHeader: ["ETW 1", "ETW 2", "LTW 1", "LTW 2"],
        windows: [
          [" Patient 1", "77", "369", "197", "489"],
          [" Patient 2", "36", "368", "156", "488"],
        ],
      }),
    );
    expect(parsed.nodes[1]).toEqual({ id: "1", role: "patient", x: 42, y: 57, services: "Service 1, Service 5", duration1: 17, duration2: 20, earliest1: 77, latest1: 197, earliest2: 369, latest2: 489 });
  });

  it("refuses marks the count disagrees with, three services, a misnumbered patient, a closing row away from the centre, a header naming one window over four values, and a missing block", () => {
    expect(() => parseHhcrsp(sheet(POSITIONS, { ...A1, requests: [["Patient 1", "0", "1", "0", "0", "0", "0", "2"], A1.requests[1] ?? NO_SERVICES] }))).toThrow(/requires 1 services by its marks, and the count beside them is "2"/);
    expect(() => parseHhcrsp(sheet(POSITIONS, { ...A1, requests: [["Patient 1", "1", "1", "1", "0", "0", "0", "3"], A1.requests[1] ?? NO_SERVICES] }))).toThrow(/requires 3 services, and a patient requires one or two/);
    expect(() => parseHhcrsp(sheet(POSITIONS, { ...A1, windows: [A1.windows[0] ?? NO_SERVICES, [" Patient 3", "352", "472"]] }))).toThrow(/row 2 is labelled "Patient 3", not Patient 2/);
    expect(() => parseHhcrsp(sheet([...POSITIONS.slice(0, -1), ["3", "35", "53"]], A1))).toThrow(/not at the centre's position/);
    expect(() =>
      parseHhcrsp(
        sheet(POSITIONS, {
          ...A1,
          windows: [
            [" Patient 1", "163", "357", "283", "477"],
            [" Patient 2", "108", "408", "228", "528"],
          ],
        }).replace("ETW 1,LTW 1", "ETW 1,LTW 1,,"),
      ),
    ).toThrow(/holds "283" past its header/);
    expect(() => parseHhcrsp(sheet(POSITIONS, A1).replace(" CgSkills", " Skills"))).toThrow(/one block labelled "CgSkills", found 0/);
  });
});
