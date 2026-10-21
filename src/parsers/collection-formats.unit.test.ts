import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { parseMankowska } from "./mankowska";
import { parseNative } from "./parse-native";
import { parseTdc } from "./tdc";
import { parseVerolog2017 } from "./verolog-2017";

/** A four-node instance: the depot copies 0 and 3, patient 1 needing service 2, patient 2 (number 3 in `DS`, which counts from one) a double service of services 1 and 2. */
const mankowska = (overrides: Readonly<Record<string, string>> = {}): string => {
  const sections: Record<string, string> = {
    nbNodes: "4",
    nbVehi: "2",
    nbServi: "2",
    r: "1 1\n0 1\n1 1\n1 1",
    DS: "3",
    a: "1 1\n0 1",
    x: "-30.1 -30.2 -30.3 -30.1",
    y: "-51.1 -51.2 -51.3 -51.1",
    d: "0 1 2 0\n1 0 1 1\n2 1 0 2\n0 1 2 0",
    p: "0 0\n0 0\n0 12\n0 12\n30 40\n30 40\n0 0\n0 0",
    mind: "0 0 5 0",
    maxd: "0 0 9 0",
    e: "0 100 200 0",
    l: "999 150 260 999",
    ...overrides,
  };

  return Object.entries(sections)
    .map(([name, values]) => `${name}\n${values}\n`)
    .join("");
};

describe("the mankowska parser", () => {
  it("reads each node's role, position, required services, processing times, window and double-service gaps", () => {
    const { meta, nodes } = parseMankowska(mankowska());
    expect(meta).toEqual({ patients: 2, caregivers: 2, serviceKinds: 2 });
    expect(nodes).toEqual([
      { id: "0", role: "depot", x: -30.1, y: -51.1, services: null, duration1: null, duration2: null, earliest: 0, latest: 999, minGap: null, maxGap: null },
      { id: "1", role: "patient", x: -30.2, y: -51.2, services: "2", duration1: 12, duration2: null, earliest: 100, latest: 150, minGap: null, maxGap: null },
      { id: "2", role: "patient", x: -30.3, y: -51.3, services: "1 2", duration1: 30, duration2: 40, earliest: 200, latest: 260, minGap: 5, maxGap: 9 },
      { id: "3", role: "depot", x: -30.1, y: -51.1, services: null, duration1: null, duration2: null, earliest: 0, latest: 999, minGap: null, maxGap: null },
    ]);
  });

  it("refuses processing times that differ between caregivers, a section of the wrong size, an unknown section and a double service node with one service", () => {
    expect(() => parseMankowska(mankowska({ p: "0 0\n0 0\n0 12\n0 13\n30 40\n30 40\n0 0\n0 0" }))).toThrow(/node 1 has processing times for service 2 that differ between caregivers \(12, 13\)/);
    expect(() => parseMankowska(mankowska({ x: "1 2 3" }))).toThrow(/the x section holds 3 numbers where 4 are due/);
    expect(() => parseMankowska(`${mankowska()}zz\n1\n`)).toThrow(/the section "zz" is not one of/);
    expect(() => parseMankowska(mankowska({ DS: "2" }))).toThrow(/node 1 requires 1 services but is a double service node/);
    expect(() => parseMankowska(mankowska({ r: "1 1\n0 2\n1 1\n1 1" }))).toThrow(NativeParseError);
  });
});

/** A VeRoLog 2017 file of the challenge's layout, tab separated as the published files are. */
const verolog = ["DATASET = ORTEC Test Set", "NAME = Instance 01", "", "DAYS = 5", "CAPACITY = 77", "MAX_TRIP_DISTANCE = 29446", "DEPOT_COORDINATE = 0", "", "VEHICLE_COST = 10", "VEHICLE_DAY_COST = 100", "DISTANCE_COST = 1", "", "TOOLS = 2", "1\t2\t280\t10000", "2\t14\t135\t10000", "", "COORDINATES = 3", "0\t5445\t2890", "1\t4275\t6176", "2\t7543\t6232", "", "REQUESTS = 2", "1\t2\t2\t3\t1\t1\t2", "2\t1\t3\t4\t1\t2\t3", ""].join("\n");

describe("the verolog-2017 parser", () => {
  it("reads the header into the meta, and the depot and each request at its location's position", () => {
    const { meta, nodes } = parseVerolog2017(verolog);
    expect(meta).toEqual({ dataset: "ORTEC Test Set", name: "Instance 01", days: 5, capacity: 77, maxTripDistance: 29446, depotCoordinate: 0, vehicleCost: 10, vehicleDayCost: 100, distanceCost: 1, tools: 2 });
    expect(nodes).toEqual([
      { id: "depot", x: 5445, y: 2890, kind: "depot", location: 0, fromDay: null, toDay: null, stayDays: null, tool: null, amount: null },
      { id: "1", x: 7543, y: 6232, kind: "request", location: 2, fromDay: 2, toDay: 3, stayDays: 1, tool: "1", amount: 2 },
      { id: "2", x: 4275, y: 6176, kind: "request", location: 1, fromDay: 3, toDay: 4, stayDays: 1, tool: "2", amount: 3 },
    ]);
  });

  it("refuses a section with fewer rows than it says, a request at an unknown location, an unknown key and a missing header line", () => {
    expect(() => parseVerolog2017(verolog.replace("REQUESTS = 2", "REQUESTS = 3"))).toThrow(/the REQUESTS section says 3 rows and has 2/);
    expect(() => parseVerolog2017(verolog.replace("1\t2\t2\t3\t1\t1\t2", "1\t9\t2\t3\t1\t1\t2"))).toThrow(/the location 9 is not among the coordinates/);
    expect(() => parseVerolog2017(verolog.replace("DAYS = 5", "WEEKS = 5"))).toThrow(/the key WEEKS is not one this format has/);
    expect(() => parseVerolog2017(verolog.replace("CAPACITY = 77\n", ""))).toThrow(/the file has no CAPACITY line/);
  });
});

/** How many characters each piece of a cut file holds: few enough that pieces end inside lines and between a line and its terminator. */
const PIECE = 7;

const tdc = [
  "Technicians:",
  'Technician id 1, skills ["1", "2"], time window [2020-02-01T09:00:00, 2020-02-01T17:00:00], investment option false',
  'Technician id 2, skills ["2"], time window [2020-02-01T09:00:00, 2020-02-01T17:00:00], investment option true',
  "Tasks:",
  'Task id 1, skills ["1"], duration 33, time window [2020-02-01T09:22:00, 2020-02-01T10:39:00], priority 1, penalty 5000.0, created 2020-02-01T00:00:00, modified nothing, cancelled false, relevant technician ids [2, 1]',
  'Task id 2, skills ["KABEL.U", "X-FELT"], duration 204, time window [2020-02-28T14:44:00, 2020-03-04T11:31:22], priority 3, penalty 9021.0, created 2020-02-28T14:43:32, modified 2020-03-01T10:00:00, cancelled true, relevant technician ids Int64[]',
  "Travel time: ",
  "task1task2: 9.17563",
  "technician1task2: 0.0",
  "task2technician1: 39.521",
  "",
].join("\n");

describe("the tdc parser", () => {
  const expected = {
    meta: { technicians: 2 },
    nodes: [
      { id: "1", skills: "1", durationMinutes: 33, earliest: "2020-02-01T09:22:00", latest: "2020-02-01T10:39:00", priority: 1, penalty: 5000, created: "2020-02-01T00:00:00", modified: null, cancelled: "false" },
      { id: "2", skills: "KABEL.U X-FELT", durationMinutes: 204, earliest: "2020-02-28T14:44:00", latest: "2020-03-04T11:31:22", priority: 3, penalty: 9021, created: "2020-02-28T14:43:32", modified: "2020-03-01T10:00:00", cancelled: "true" },
    ],
  };

  it("keeps a node per task and counts the technicians, letting the travel time lines go", () => {
    expect(parseTdc([tdc])).toEqual(expected);
  });

  it("reads the same instance however the text is cut into pieces, through parseNative", () => {
    const bytes = new TextEncoder().encode(tdc);
    expect(parseNative(bytes, { format: "tdc", encoding: "utf-8" })).toEqual(expected);
    const cuts = Array.from({ length: Math.ceil(tdc.length / PIECE) }, (_, index) => tdc.slice(index * PIECE, (index + 1) * PIECE));
    expect(parseTdc(cuts)).toEqual(expected);
  });

  it("refuses a line of the wrong shape for its section, a heading out of order, a repeated task and a missing section", () => {
    expect(() => parseTdc([tdc.replace("task1task2: 9.17563", "task1task2 9.17563")])).toThrow(/line 8: .*not a travel time line/);
    expect(() => parseTdc([tdc.replace("Tasks:", "Travel time:")])).toThrow(/out of order/);
    expect(() => parseTdc([tdc.replace("Task id 2,", "Task id 1,")])).toThrow(/the task 1 is given twice/);
    expect(() => parseTdc([tdc.slice(0, tdc.indexOf("Travel time"))])).toThrow(/the file has no travel time heading/);
  });
});
