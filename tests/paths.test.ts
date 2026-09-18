import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  expandHome,
  isStreamingPortableId,
  portableIdToAbsolute,
  redactPath,
  volumeRootFromDatabaseUri,
} from "../src/paths.js";

describe("paths", () => {
  it("expands a leading tilde and leaves other paths alone", () => {
    expect(expandHome("~/Music")).toBe(`${homedir()}/Music`);
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("/Volumes/USB")).toBe("/Volumes/USB");
    expect(expandHome("~notauser/x")).toBe("~notauser/x");
  });

  it("redacts only the home prefix", () => {
    expect(redactPath(`${homedir()}/Music/a.flac`)).toBe("~/Music/a.flac");
    expect(redactPath("/Volumes/USB/a.flac")).toBe("/Volumes/USB/a.flac");
  });

  // Measured 2026-09-03 on Serato DJ Lite 4.0.9: location.path is SQL NULL
  // in every observed row, so the volume root is only recoverable from
  // connection.database_uri.
  it("recovers the volume root from a connection uri", () => {
    expect(
      volumeRootFromDatabaseUri("/Users/v/Library/Application Support/Serato/Library/root.sqlite"),
    ).toBe("/");
    expect(volumeRootFromDatabaseUri("/Volumes/USB/_Serato_/Library/location.sqlite")).toBe(
      "/Volumes/USB",
    );
  });

  // portable_id is relative to the volume root and carries no leading slash.
  it("joins a portable id onto its volume root", () => {
    expect(portableIdToAbsolute("/", "Users/v/Music/a.flac")).toBe("/Users/v/Music/a.flac");
    expect(portableIdToAbsolute("/Volumes/USB", "DNB/a.aif")).toBe("/Volumes/USB/DNB/a.aif");
  });

  it("spots streaming ids, which have no file on disk", () => {
    expect(isStreamingPortableId("streaming://beatport/12345678")).toBe(true);
    expect(isStreamingPortableId("Users/v/Music/a.flac")).toBe(false);
  });

  it("throws for unrecognised database uris", () => {
    expect(() => volumeRootFromDatabaseUri("/tmp/library.db")).toThrow(
      /unrecognised database_uri: \/tmp\/library\.db/,
    );
    expect(() => volumeRootFromDatabaseUri("/Volumes/X/_Serato_/Library/other.sqlite")).toThrow(
      /unrecognised database_uri: \/Volumes\/X\/_Serato_\/Library\/other\.sqlite/,
    );
  });
});
