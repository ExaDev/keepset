import { describe, expect, it } from "vitest";
import { readLicenceRecord } from "./licence-records";

describe("reading a platform's licence record", () => {
  it("reads a Socrata view's licence name, with its terms link when it has one, and treats a null licence as stating none", () => {
    expect(readLicenceRecord("socrata", { license: { name: "UK Open Government Licence v3", termsLink: "http://example.org/ogl" }, licenseId: "UK_OGLV3.0" })).toEqual({ states: true, summary: "UK Open Government Licence v3 (http://example.org/ogl)" });
    expect(readLicenceRecord("socrata", { license: { name: "See Terms of Use" }, licenseId: "SEE_TERMS_OF_USE" })).toEqual({ states: true, summary: "See Terms of Use" });
    expect(readLicenceRecord("socrata", { license: null, licenseId: null, attribution: "A department" }).states).toBe(false);
  });

  it("treats a CKAN licence of notspecified, or none, as stating none", () => {
    expect(readLicenceRecord("ckan", { result: { license_id: "cc-by", license_title: "Creative Commons Attribution" } })).toEqual({ states: true, summary: "Creative Commons Attribution (cc-by)" });
    expect(readLicenceRecord("ckan", { result: { license_id: "notspecified", license_title: "License not specified" } })).toEqual({ states: false, summary: "License not specified" });
    expect(readLicenceRecord("ckan", { result: {} }).states).toBe(false);
  });

  it("reads an ArcGIS item's licence information with its markup removed", () => {
    expect(readLicenceRecord("arcgis", { licenseInfo: "<p>Open <b>Government</b> Licence</p>" })).toEqual({ states: true, summary: "Open Government Licence" });
    expect(readLicenceRecord("arcgis", { licenseInfo: "" }).states).toBe(false);
    expect(readLicenceRecord("arcgis", { licenseInfo: "<p> </p>" }).states).toBe(false);
  });

  it("reads a GitHub repository's SPDX id, and a missing licence file or an unrecognised one as stating none", () => {
    expect(readLicenceRecord("github", { license: { spdx_id: "GPL-2.0" } })).toEqual({ states: true, summary: "GPL-2.0" });
    expect(readLicenceRecord("github", undefined)).toEqual({ states: false, summary: "the repository has no licence file" });
    expect(readLicenceRecord("github", { license: { spdx_id: "NOASSERTION" } }).states).toBe(false);
  });

  it("reads a Hugging Face card's licence, where other and unknown name none", () => {
    expect(readLicenceRecord("huggingface", { cardData: { license: "apache-2.0" } })).toEqual({ states: true, summary: "apache-2.0" });
    expect(readLicenceRecord("huggingface", { cardData: { license: ["mit", "cc0-1.0"] } })).toEqual({ states: true, summary: "mit, cc0-1.0" });
    expect(readLicenceRecord("huggingface", { cardData: { license: "other" } })).toEqual({ states: false, summary: "other (names no licence)" });
    expect(readLicenceRecord("huggingface", { cardData: {} }).states).toBe(false);
  });

  it("reads a Zenodo record's licence id", () => {
    expect(readLicenceRecord("zenodo", { metadata: { license: { id: "cc-by-4.0" } } })).toEqual({ states: true, summary: "cc-by-4.0" });
    expect(readLicenceRecord("zenodo", { metadata: {} }).states).toBe(false);
  });
});
