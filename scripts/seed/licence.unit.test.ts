import { describe, expect, it } from "vitest";
import { assertMachineReadableRead, EM_DASH, GraphLicencesSchema, graphLicenceResolver, licenceMetadata, licenceOf, LicenceTermsSchema, prose } from "./licence";

const cc = { licence: { kind: "spdx", id: "CC-BY-4.0" }, statedAt: "https://example.org/terms", statement: "Licensed under CC BY 4.0" };
const none = { readAt: ["https://example.org/about"], reason: "The about page states no terms" };

describe("licence terms", () => {
  it("accepts stated terms and a record of reading a source that states none, and nothing between", () => {
    expect(LicenceTermsSchema.safeParse(cc).success).toBe(true);
    expect(LicenceTermsSchema.safeParse(none).success).toBe(true);
    expect(LicenceTermsSchema.safeParse({ ...cc, ...none }).success).toBe(false);
    expect(LicenceTermsSchema.safeParse({ licence: cc.licence }).success).toBe(false);
    expect(LicenceTermsSchema.safeParse({ readAt: [], reason: none.reason }).success).toBe(false);
  });

  it("will not record unrecorded as a stated licence, so an unread source cannot pass as a read one", () => {
    expect(LicenceTermsSchema.safeParse({ ...cc, licence: { kind: "unrecorded" } }).success).toBe(false);
  });

  it("maps stated terms to their licence and a source that states none to unrecorded", () => {
    expect(licenceOf(LicenceTermsSchema.parse(cc))).toEqual({ kind: "spdx", id: "CC-BY-4.0" });
    expect(licenceOf(LicenceTermsSchema.parse(none))).toEqual({ kind: "unrecorded" });
  });

  it("refuses prose that uses a dash as punctuation", () => {
    expect(prose().safeParse("one - two").success).toBe(true);
    expect(prose().safeParse(`one ${EM_DASH} two`).success).toBe(false);
    expect(prose().safeParse(`one ${"-".repeat(2)} two`).success).toBe(false);
  });
});

describe("the graph licence curation", () => {
  const curation = (publishers: readonly unknown[], datasets: Record<string, unknown> = {}) => GraphLicencesSchema.parse({ readOn: "2026-10-20", publishers, datasets });
  const collection = { id: "collection", name: "Collection", prefixes: ["https://example.org/data/"], terms: cc };
  const nested = { id: "nested", name: "Nested", prefixes: ["https://example.org/data/nested/"], terms: none };
  const perDataset = { id: "per-dataset", name: "Per dataset", prefixes: ["https://hub.example/"], perDataset: true };

  it("resolves a dataset by the longest publisher prefix its source URL starts with", () => {
    const resolver = graphLicenceResolver(curation([collection, nested]));
    expect(resolver.resolve("a", "https://example.org/data/a.zip")).toEqual({ kind: "spdx", id: "CC-BY-4.0" });
    expect(resolver.resolve("b", "https://example.org/data/nested/b.zip")).toEqual({ kind: "unrecorded" });
  });

  it("lets a dataset record win over its publisher", () => {
    const resolver = graphLicenceResolver(curation([collection], { a: none }));
    expect(resolver.resolve("a", "https://example.org/data/a.zip")).toEqual({ kind: "unrecorded" });
  });

  it("refuses a dataset whose source falls under no publisher, naming it", () => {
    expect(() => {
      graphLicenceResolver(curation([collection])).resolve("lost", "https://elsewhere.example/lost.zip");
    }).toThrow(/no licence curation covers lost/);
  });

  it("refuses a dataset of a publisher that states terms per dataset until the dataset has a record", () => {
    expect(() => {
      graphLicenceResolver(curation([perDataset])).resolve("d", "https://hub.example/d");
    }).toThrow(/states terms per dataset.*no record for d/);
    expect(graphLicenceResolver(curation([perDataset], { d: cc })).resolve("d", "https://hub.example/d")).toEqual({ kind: "spdx", id: "CC-BY-4.0" });
  });

  it("refuses curation nothing used, whether a publisher or a dataset record", () => {
    const resolver = graphLicenceResolver(curation([collection, nested], { gone: none }));
    resolver.resolve("a", "https://example.org/data/a.zip");
    expect(() => {
      resolver.assertAllUsed();
    }).toThrow(/dataset records.*gone/);
    const second = graphLicenceResolver(curation([collection, nested]));
    second.resolve("a", "https://example.org/data/a.zip");
    expect(() => {
      second.assertAllUsed();
    }).toThrow(/publishers.*nested/);
  });

  it("refuses a publisher listed twice or a prefix shared by two", () => {
    expect(() => {
      curation([collection, collection]);
    }).toThrow(/listed twice/);
    expect(() => {
      curation([collection, { ...nested, prefixes: collection.prefixes }]);
    }).toThrow(/belongs to two publishers/);
  });
});

describe("machine-readable licence records", () => {
  it("finds the licence record of a Socrata dataset from its page, resource or view URL", () => {
    const record = { platform: "socrata", url: "https://data.example.gov/api/views/abcd-1234.json" };
    expect(licenceMetadata("https://data.example.gov/Housing/Evictions/abcd-1234")).toEqual(record);
    expect(licenceMetadata("https://data.example.gov/resource/abcd-1234.csv")).toEqual(record);
    expect(licenceMetadata("https://data.example.gov/api/views/abcd-1234/rows.csv?accessType=DOWNLOAD")).toEqual(record);
  });

  it("finds the records of the other platforms that keep one", () => {
    expect(licenceMetadata("https://hub.arcgis.com/datasets/0123456789abcdef0123456789abcdef_0")).toEqual({ platform: "arcgis", url: "https://www.arcgis.com/sharing/rest/content/items/0123456789abcdef0123456789abcdef?f=json" });
    expect(licenceMetadata("https://ckan0.example.ca/dataset/permits")).toEqual({ platform: "ckan", url: "https://ckan0.example.ca/api/3/action/package_show?id=permits" });
    expect(licenceMetadata("https://github.com/owner/repo")).toEqual({ platform: "github", url: "https://api.github.com/repos/owner/repo/license" });
    expect(licenceMetadata("https://huggingface.co/datasets/owner/name")).toEqual({ platform: "huggingface", url: "https://huggingface.co/api/datasets/owner/name" });
    expect(licenceMetadata("https://zenodo.org/records/12345")).toEqual({ platform: "zenodo", url: "https://zenodo.org/api/records/12345" });
  });

  it("does not take a page of a platform without such a record for one that has it", () => {
    expect(licenceMetadata("https://www.revenue.example/list-of-defaulters/index.aspx")).toBeUndefined();
    expect(licenceMetadata("https://github.com/owner/repo/blob/main/file.csv")).toBeUndefined();
    expect(licenceMetadata("https://services.arcgis.com/abc/arcgis/rest/services/Layer/FeatureServer/0")).toBeUndefined();
  });

  it("fails an entry recorded without a licence on a platform whose licence record the curation has not read", () => {
    const page = "https://data.example.gov/Housing/Evictions/abcd-1234";
    expect(() => {
      assertMachineReadableRead("evictions", page, LicenceTermsSchema.parse(none));
    }).toThrow(/socrata keeps each dataset's licence.*abcd-1234\.json/);
    const read = { readAt: ["https://data.example.gov/api/views/abcd-1234.json"], reason: "The licence field is empty" };
    expect(() => {
      assertMachineReadableRead("evictions", page, LicenceTermsSchema.parse(read));
    }).not.toThrow();
  });

  it("does not ask for a licence record when the entry states a licence, or the platform keeps none", () => {
    expect(() => {
      assertMachineReadableRead("evictions", "https://data.example.gov/Housing/Evictions/abcd-1234", LicenceTermsSchema.parse(cc));
    }).not.toThrow();
    expect(() => {
      assertMachineReadableRead("page", "https://www.revenue.example/index.aspx", LicenceTermsSchema.parse(none));
    }).not.toThrow();
  });
});
