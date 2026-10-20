import { NativeParseError } from "../errors";
import { type NativeInstance, type NativeRow } from "./native";
import { readXml, type XmlElement } from "./xml";

/** The columns of a node of a VRP-REP instance, as the parser names them: the position, the node's `type` as the file writes it, the skills its requests need (`skill`), the skills of the drivers based there (`skills`) and the resources its requests need (`resources`). Each skill or resource list is the ids joined by commas, or null for none. */
export const VRP_REP_COLUMNS = ["x", "y", "type", "skill", "skills", "resources"] as const;

/** The columns whose values are text; the others are numbers. */
export const VRP_REP_TEXT_COLUMNS = ["type", "skill", "skills", "resources"] as const;

/** The metadata keys the parser reads: the instance's dataset and name from its `info`. */
export const VRP_REP_META = ["dataset", "name"] as const;

const FORMAT = "vrp-rep";

/**
 * The child elements of an element with a name.
 * @param element - The parent.
 * @param name - The child element name.
 * @returns Them, in document order.
 */
function childrenOf(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

/**
 * The one child element of an element with a name.
 * @param element - The parent.
 * @param name - The child element name.
 * @returns It.
 * @throws NativeParseError when the parent has none or several.
 */
function childOf(element: XmlElement, name: string): XmlElement {
  const found = childrenOf(element, name);
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new NativeParseError(FORMAT, 1, `expected one <${name}> in <${element.name}>, found ${String(found.length)}`);
  }

  return only;
}

/**
 * Reads an attribute that must be there.
 * @param element - The element.
 * @param name - The attribute name.
 * @returns Its value.
 * @throws NativeParseError when the element has no such attribute.
 */
function attributeOf(element: XmlElement, name: string): string {
  const value = Object.hasOwn(element.attributes, name) ? element.attributes[name] : undefined;
  if (value === undefined) {
    throw new NativeParseError(FORMAT, 1, `expected <${element.name}> to have the attribute ${name}`);
  }

  return value;
}

/**
 * Reads the text of an element as a finite number.
 * @param element - The element.
 * @returns The number.
 * @throws NativeParseError when the text is not a decimal number.
 */
function numberOf(element: XmlElement): number {
  const text = element.text.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw new NativeParseError(FORMAT, 1, `expected <${element.name}> to hold a number, found ${JSON.stringify(text)}`);
  }

  return Number(text);
}

/**
 * Joins ids into the list text a column holds.
 * @param ids - The ids, in document order.
 * @returns The distinct ids joined by commas, or null when there are none.
 */
function listOf(ids: readonly string[]): string | null {
  const distinct = [...new Set(ids)];

  return distinct.length === 0 ? null : distinct.join(",");
}

/**
 * Parses a VRP-REP instance (the XML format of the VRP-REP repository) in the layout its technician routing instances use: an `instance` with `info`, a `network` of `node` elements with `cx` and `cy`, a `fleet` of vehicle profiles that each depart from a node, `requests` that each sit at a node and name the skill and resources they need, and `drivers` whose profiles list the skills a vehicle type's driver has. Each node becomes a row with its position and `type`; a node's request skills and resources, and the skills of the drivers whose vehicles depart from it, are attached to it. Fleet costs and resource stocks are not read, as or/v1 has no place for them.
 * @param text - The file text.
 * @returns The instance: its dataset and name as `meta`, and its nodes in document order.
 * @throws NativeParseError for malformed XML, a root that is not `instance`, a missing element or attribute, a coordinate that is not a number, a repeated node id, or a request or vehicle that names a node the network lacks.
 */
export function parseVrpRep(text: string): NativeInstance {
  const root = readXml(text, FORMAT);
  if (root.name !== "instance") {
    throw new NativeParseError(FORMAT, 1, `expected the root element <instance>, found <${root.name}>`);
  }
  const info = childOf(root, "info");
  const nodeElements = childrenOf(childOf(childOf(root, "network"), "nodes"), "node");
  const known = new Set<string>();
  for (const node of nodeElements) {
    const id = attributeOf(node, "id");
    if (known.has(id)) {
      throw new NativeParseError(FORMAT, 1, `node ${id} appears twice`);
    }
    known.add(id);
  }
  const needs = new Map<string, { skills: string[]; resources: string[] }>();
  for (const request of childrenOf(childOf(root, "requests"), "request")) {
    const node = attributeOf(request, "node");
    if (!known.has(node)) {
      throw new NativeParseError(FORMAT, 1, `request ${attributeOf(request, "id")} is at node ${node}, which the network lacks`);
    }
    const entry = needs.get(node) ?? { skills: [], resources: [] };
    entry.skills.push(...childrenOf(request, "skill").map((skill) => skill.text.trim()));
    entry.resources.push(...childrenOf(request, "resource").map((resource) => attributeOf(resource, "id")));
    needs.set(node, entry);
  }
  const driverSkills = new Map<string, string[]>();
  for (const profile of childrenOf(childOf(root, "drivers"), "driver_profile")) {
    driverSkills.set(
      attributeOf(profile, "type"),
      childrenOf(profile, "skill").map((skill) => attributeOf(skill, "id")),
    );
  }
  const offered = new Map<string, string[]>();
  for (const vehicle of childrenOf(childOf(root, "fleet"), "vehicle_profile")) {
    const home = childOf(vehicle, "departure_node").text.trim();
    if (!known.has(home)) {
      throw new NativeParseError(FORMAT, 1, `vehicle type ${attributeOf(vehicle, "type")} departs from node ${home}, which the network lacks`);
    }
    offered.set(home, [...(offered.get(home) ?? []), ...(driverSkills.get(attributeOf(vehicle, "type")) ?? [])]);
  }
  const nodes: NativeRow[] = nodeElements.map((node) => {
    const id = attributeOf(node, "id");
    const need = needs.get(id);

    return {
      id,
      x: numberOf(childOf(node, "cx")),
      y: numberOf(childOf(node, "cy")),
      type: attributeOf(node, "type"),
      skill: listOf(need?.skills ?? []),
      skills: listOf(offered.get(id) ?? []),
      resources: listOf(need?.resources ?? []),
    };
  });

  return { meta: { dataset: childOf(info, "dataset").text.trim(), name: childOf(info, "name").text.trim() }, nodes };
}
