import { NativeParseError } from "../errors";
import { forEachLine, type NativeInstance, type NativeRow } from "./native";

/** The columns of a task of a technician dispatch file, as the parser names them: the skills it needs (joined by spaces), how many minutes it takes, its time window's opening and closing, its priority and the penalty for leaving it unserved, when it was created and last modified, and whether it was cancelled (`true` or `false`). */
export const TDC_COLUMNS = ["skills", "durationMinutes", "earliest", "latest", "priority", "penalty", "created", "modified", "cancelled"] as const;

/** The columns whose values are text; the others are numbers. */
export const TDC_TEXT_COLUMNS = ["skills", "earliest", "latest", "created", "modified", "cancelled"] as const;

/** The metadata keys the parser reads: how many technicians the instance has. */
export const TDC_META = ["technicians"] as const;

const FORMAT = "tdc";

/** A technician line: its id, skills, time window and whether it is an investment option. */
const TECHNICIAN = /^Technician id \d+, skills \[[^\]]*\], time window \[[^\]]*\], investment option (?:true|false)$/;

/** A task line, with the fields the parser keeps captured: id, skills, duration, window opening and closing, priority, penalty, creation, modification (or `nothing`) and cancellation; its relevant technicians follow and are not kept. */
const TASK = /^Task id (\d+), skills \[([^\]]*)\], duration (\d+), time window \[([^,\]]+), ([^\]]+)\], priority (\d+), penalty (-?\d+(?:\.\d+)?), created ([^,]+), modified ([^,]+), cancelled (true|false), relevant technician ids (?:Int64)?\[[\d, ]*\]$/;

/** A travel time line, between two tasks or between a technician and a task, in either direction. */
const TRAVEL = /^(?:task|technician)\d+(?:task|technician)\d+: -?\d+(?:\.\d+)?$/;

/** The section headings, in the order the file gives them. */
const HEADINGS = ["Technicians:", "Tasks:", "Travel time:"] as const;

/** What a line before any heading and a line of each section is, for errors: indexed by the section's position plus one, so the lines before the first heading are first. */
const SECTION_NOUNS = ["heading", "technician", "task", "travel time"] as const;

/**
 * Names what a position's lines are, for an error.
 * @param position - A section's position plus one.
 * @returns The noun.
 */
function nounOf(position: number): string {
  return SECTION_NOUNS[position] ?? `section ${String(position)}`;
}

/** Where the task pattern captures each field it keeps. */
const TASK_AT = { id: 1, skills: 2, duration: 3, earliest: 4, latest: 5, priority: 6, penalty: 7, created: 8, modified: 9, cancelled: 10 } as const;

/** How much of a refused line an error shows. */
const SHOWN = 120;

/**
 * Parses a technician routing and scheduling instance in the sectioned text format of Gamst and Pisinger (2024): a `Technicians:` heading and a line per technician, a `Tasks:` heading and a line per task (`Task id <n>, skills ["<skill>", ...], duration <minutes>, time window [<opening>, <closing>], priority <n>, penalty <n>, created <time>, modified <time or nothing>, cancelled <true or false>, relevant technician ids [<ids>]`), then a `Travel time:` heading and a line per pair, the travel minutes between two tasks or between a technician and a task. The file is read a line at a time and the travel time lines, almost all of a file, are checked and let go, as the tasks/v1 target has no arcs; a technician's line is counted. A task's id is its id, and a modification of `nothing` is null. Times are as the file writes them.
 * @param pieces - The file's text, in pieces.
 * @returns The instance: its technician count as `meta`, and its tasks in file order.
 * @throws NativeParseError naming the line for a heading out of order or missing, a line that is not of its section's shape, or a task id given twice.
 */
export function parseTdc(pieces: Readonly<Iterable<string>>): NativeInstance {
  let section = -1;
  let technicians = 0;
  const nodes: NativeRow[] = [];
  const ids = new Set<string>();
  forEachLine(pieces, (raw, line) => {
    const text = raw.trim();
    if (text === "") {
      return;
    }
    const heading = HEADINGS.findIndex((candidate) => candidate === text);
    if (heading !== -1) {
      if (heading !== section + 1) {
        throw new NativeParseError(FORMAT, line, `the heading ${text} is out of order`);
      }
      section = heading;

      return;
    }
    if (section === 0 && TECHNICIAN.test(text)) {
      technicians += 1;

      return;
    }
    if (section === 2 && TRAVEL.test(text)) {
      return;
    }
    const task = section === 1 ? TASK.exec(text) : null;
    if (task === null) {
      throw new NativeParseError(FORMAT, line, `the line is not a ${nounOf(section + 1)} line: ${JSON.stringify(text.slice(0, SHOWN))}`);
    }
    const field = (index: number): string => {
      const value = task[index];
      if (value === undefined) {
        throw new NativeParseError(FORMAT, line, `the task line has no field ${String(index)}`);
      }

      return value;
    };
    const id = field(TASK_AT.id);
    if (ids.has(id)) {
      throw new NativeParseError(FORMAT, line, `the task ${id} is given twice`);
    }
    ids.add(id);
    const skills = field(TASK_AT.skills)
      .split(",")
      .map((skill) => skill.trim().replace(/^"|"$/g, ""))
      .filter((skill) => skill !== "");
    const modified = field(TASK_AT.modified);
    nodes.push({
      id,
      skills: skills.length === 0 ? null : skills.join(" "),
      durationMinutes: Number(field(TASK_AT.duration)),
      earliest: field(TASK_AT.earliest).trim(),
      latest: field(TASK_AT.latest).trim(),
      priority: Number(field(TASK_AT.priority)),
      penalty: Number(field(TASK_AT.penalty)),
      created: field(TASK_AT.created),
      modified: modified === "nothing" ? null : modified,
      cancelled: field(TASK_AT.cancelled),
    });
  });
  if (section !== HEADINGS.length - 1) {
    throw new NativeParseError(FORMAT, 1, `the file has no ${nounOf(section + 2)} heading`);
  }

  return { meta: { technicians }, nodes };
}
