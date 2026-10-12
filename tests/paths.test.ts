import { homedir } from "node:os";
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandHome,
  isRootStoreUri,
  isStreamingPortableId,
  type PathEnv,
  portableIdToAbsolute,
  redactPath,
  volumeRootFromDatabaseUri,
} from "../src/paths.js";

// Both hosts are stated outright, so each platform's rules are checked on
// every machine the suite runs on, not only on its own.
const POSIX: PathEnv = { platform: "darwin", home: "/Users/v" };
const WINDOWS: PathEnv = { platform: "win32", home: "C:\\Users\\v" };

describe("paths", () => {
  it("expands a leading tilde and leaves other paths alone", () => {
    expect(expandHome("~/Music", POSIX)).toBe("/Users/v/Music");
    expect(expandHome("~", POSIX)).toBe("/Users/v");
    expect(expandHome("/Volumes/USB", POSIX)).toBe("/Volumes/USB");
    expect(expandHome("~notauser/x", POSIX)).toBe("~notauser/x");
    // A backslash is an ordinary filename character on POSIX.
    expect(expandHome("~\\Music", POSIX)).toBe("~\\Music");
  });

  it("reads the home directory from the host when none is given", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/Music")).toBe(
      process.platform === "win32" ? win32.join(homedir(), "Music") : `${homedir()}/Music`,
    );
    expect(redactPath(expandHome("~/Music"))).toBe(
      process.platform === "win32" ? "~\\Music" : "~/Music",
    );
  });

  it("expands a leading tilde on Windows with either separator, into backslashes", () => {
    expect(expandHome("~/Music/Sets", WINDOWS)).toBe("C:\\Users\\v\\Music\\Sets");
    expect(expandHome("~\\Music", WINDOWS)).toBe("C:\\Users\\v\\Music");
    expect(expandHome("~", WINDOWS)).toBe("C:\\Users\\v");
    expect(expandHome("D:\\Music", WINDOWS)).toBe("D:\\Music");
    expect(expandHome("~notauser\\x", WINDOWS)).toBe("~notauser\\x");
  });

  it("redacts only the home prefix", () => {
    expect(redactPath("/Users/v/Music/a.flac", POSIX)).toBe("~/Music/a.flac");
    expect(redactPath("/Users/v", POSIX)).toBe("~");
    expect(redactPath("/Volumes/USB/a.flac", POSIX)).toBe("/Volumes/USB/a.flac");
    // Another user whose name merely starts the same way is not under home.
    expect(redactPath("/Users/vv/Music/a.flac", POSIX)).toBe("/Users/vv/Music/a.flac");
    // POSIX paths are case-sensitive and know one separator.
    expect(redactPath("/users/v/Music/a.flac", POSIX)).toBe("/users/v/Music/a.flac");
    expect(redactPath("/Users/v\\Music", POSIX)).toBe("/Users/v\\Music");
  });

  // Windows compares paths without regard to case and accepts both
  // separators; a home prefix that differs only in those must not leak.
  it("redacts the home prefix on Windows across separators and case", () => {
    expect(redactPath("C:\\Users\\v\\Music\\a.flac", WINDOWS)).toBe("~\\Music\\a.flac");
    expect(redactPath("c:\\users\\V\\Music\\a.flac", WINDOWS)).toBe("~\\Music\\a.flac");
    expect(redactPath("C:\\Users\\v/Music/a.flac", WINDOWS)).toBe("~/Music/a.flac");
    expect(redactPath("C:\\Users\\v", WINDOWS)).toBe("~");
    expect(redactPath("C:\\Users\\vv\\Music\\a.flac", WINDOWS)).toBe(
      "C:\\Users\\vv\\Music\\a.flac",
    );
    expect(redactPath("D:\\Music\\a.flac", WINDOWS)).toBe("D:\\Music\\a.flac");
  });

  it("gives back on Windows what it redacted", () => {
    const path = "C:\\Users\\v\\Music\\a.flac";
    expect(expandHome(redactPath(path, WINDOWS), WINDOWS)).toBe(path);
  });

  // Measured 2026-09-03 on Serato DJ Lite 4.0.9: location.path is SQL NULL
  // in every observed row, so the volume root is only recoverable from
  // connection.database_uri.
  it("recovers the volume root from a connection uri", () => {
    expect(
      volumeRootFromDatabaseUri("/Users/v/Library/Application Support/Serato/Library/root.sqlite"),
    ).toBe("/");
    expect(volumeRootFromDatabaseUri("/Volumes/EXTDISK/_Serato_/Library/location.sqlite")).toBe(
      "/Volumes/EXTDISK",
    );
  });

  // ASSUMED, not measured: no master.sqlite written by Serato on Windows has
  // been examined, so these are the forms a plain Windows path would take.
  // A drive root must come back as "D:\" -- "D:" alone means the current
  // directory on that drive.
  it("recovers a Windows volume root from a drive-letter uri, with either separator", () => {
    expect(volumeRootFromDatabaseUri("D:\\_Serato_\\Library\\location.sqlite")).toBe("D:\\");
    expect(volumeRootFromDatabaseUri("D:/_Serato_/Library/location.sqlite")).toBe("D:\\");
    expect(volumeRootFromDatabaseUri("e:\\Sets\\_Serato_\\Library\\location.sqlite")).toBe(
      "e:\\Sets",
    );
    expect(
      volumeRootFromDatabaseUri("C:\\Users\\v\\AppData\\Local\\Serato\\Library\\root.sqlite"),
    ).toBe("C:\\");
    expect(volumeRootFromDatabaseUri("C:/Users/v/AppData/Local/Serato/Library/root.sqlite")).toBe(
      "C:\\",
    );
    expect(volumeRootFromDatabaseUri("\\\\nas\\music\\_Serato_\\Library\\location.sqlite")).toBe(
      "\\\\nas\\music",
    );
  });

  it("names root.sqlite as the boot disk's store in either form", () => {
    expect(isRootStoreUri("/Users/v/Library/Application Support/Serato/Library/root.sqlite")).toBe(
      true,
    );
    expect(isRootStoreUri("C:\\Users\\v\\AppData\\Local\\Serato\\Library\\root.sqlite")).toBe(true);
    expect(isRootStoreUri("/Volumes/USB/_Serato_/Library/location.sqlite")).toBe(false);
    expect(isRootStoreUri("D:\\_Serato_\\Library\\location.sqlite")).toBe(false);
    expect(isRootStoreUri("/Users/v/notroot.sqlite")).toBe(false);
  });

  // portable_id is relative to the volume root and carries no leading slash.
  it("joins a portable id onto its volume root", () => {
    expect(portableIdToAbsolute("/", "Users/v/Music/a.flac")).toBe("/Users/v/Music/a.flac");
    expect(portableIdToAbsolute("/Volumes/USB", "DNB/a.aif")).toBe("/Volumes/USB/DNB/a.aif");
  });

  // Measured 2026-10-12 in a location.sqlite Serato created on a Windows
  // drive: portable_id is relative to the drive root, with forward slashes
  // and no leading slash, for a file Windows itself names with backslashes.
  it("joins a portable id onto a Windows volume root with backslashes", () => {
    expect(portableIdToAbsolute("D:\\", "Some Folder/Artist - Title.mp3")).toBe(
      "D:\\Some Folder\\Artist - Title.mp3",
    );
    expect(portableIdToAbsolute("e:\\Sets", "DNB/a.aif")).toBe("e:\\Sets\\DNB\\a.aif");
    expect(portableIdToAbsolute("\\\\nas\\music", "DNB/a.aif")).toBe("\\\\nas\\music\\DNB\\a.aif");
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

  // Windows forms nothing is known about are refused, not guessed at:
  // another filename, a drive-relative path, and a root.sqlite on a network
  // share, which has no drive to be the root of.
  it("throws for Windows uris in a form it does not know", () => {
    for (const uri of [
      "D:\\_Serato_\\Library\\other.sqlite",
      "D:root.sqlite",
      "\\\\nas\\home\\AppData\\Local\\Serato\\Library\\root.sqlite",
    ]) {
      expect(() => volumeRootFromDatabaseUri(uri), uri).toThrow(/unrecognised database_uri/);
    }
  });
});
