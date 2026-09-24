/**
 * Builds a small, entirely invented Serato DJ 4.x library for trying the
 * server without a real one -- for a directory reviewer, or anyone curious.
 *
 *   npm run demo-library -- <dir>
 *
 * writes <dir>/Library (master.sqlite and root.sqlite, the folder to give
 * the server as its library) and <dir>/Music (short silent WAV files the
 * tracks point at). Every name is made up; a resemblance to a real artist,
 * title or label is accidental. The same <dir> always gets the same library.
 *
 * The databases come from the test suite's own fixture builder
 * (tests/fixtures/make.ts), which reproduces the schema of a real Serato DJ
 * Lite 4.0.9 library, so this is the shape the server is tested against.
 * Nothing here is shipped: not in the npm package, not in the .mcpb bundle.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type CrateSeed, makeLibraryFixture, type TrackSeed } from "../tests/fixtures/make.js";

/** Left in <dir> so a later run knows the folder is its own to replace. */
const MARKER = ".serato-dj-mcp-demo";

const MINOR = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "Dbm"];
const MAJOR = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];

/** Camelot "8A" -> the key_value Serato stores and the text it shows. */
function camelotKey(camelot: string): { keyValue: number; keyText: string } {
  const n = Number(camelot.slice(0, -1));
  return camelot.endsWith("A")
    ? { keyValue: n - 1, keyText: MINOR[n - 1] }
    : { keyValue: 12 + n - 1, keyText: MAJOR[n - 1] };
}

/** mulberry32: a fixed seed gives the same library on every run. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ARTISTS = [
  "Lumenhaus",
  "Quillmoor",
  "Saltwire",
  "Oxbow Static",
  "Tallgrass Relay",
  "Cinder Arcade",
  "Harbor Sine",
  "Kitefall",
  "Mossglass",
  "Juniper Ohm",
  "Sable Current",
  "Velvet Orrery",
];
const LABELS = ["Brindlewax Records", "Lowtide Tapes", "Fernhollow Audio", "Parhelion Discs"];
const WORDS_A = [
  "Night",
  "Glass",
  "Low",
  "Amber",
  "Paper",
  "Silver",
  "Hollow",
  "Velvet",
  "Salt",
  "Quiet",
];
const WORDS_B = [
  "Drive",
  "Steps",
  "Sun",
  "Signal",
  "Harbor",
  "Engine",
  "Garden",
  "Circuit",
  "Tide",
  "Lantern",
];

/** Genre, BPM range and a leaning towards minor keys, per style. */
const STYLES = [
  { genre: "House", bpm: [120, 126] },
  { genre: "Deep House", bpm: [118, 124] },
  { genre: "Techno", bpm: [126, 134] },
  { genre: "Disco", bpm: [112, 122] },
  { genre: "Hip-Hop", bpm: [85, 98] },
  { genre: "Drum & Bass", bpm: [170, 176] },
] as const;

/** 2025-01-01 and 2026-09-01 (UTC): "added this year" has answers. */
const ADDED_FROM = 1_735_689_600;
const ADDED_TO = 1_788_220_800;

export type DemoTrack = TrackSeed & {
  /** false: the WAV is not written, so the file is really missing. */
  hasFile: boolean;
  label: string;
};

export type DemoLibrary = {
  libraryDir: string;
  musicDir: string;
  tracks: DemoTrack[];
  crates: CrateSeed[];
};

/**
 * The library as data, independent of where it is written: every field but
 * portableId is the same for every <dir>. Exported so the test can state
 * what the audit must find without re-deriving it.
 */
export function demoTracks(musicDir: string): DemoTrack[] {
  const rand = prng(0x5e7a70);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const tracks: DemoTrack[] = [];
  const titles = new Set<string>();

  for (let i = 0; i < 56; i++) {
    const style = STYLES[i % STYLES.length];
    let title: string;
    do title = `${pick(WORDS_A)} ${pick(WORDS_B)}`;
    while (titles.has(title));
    titles.add(title);
    const artist = pick(ARTISTS);
    const bpm = style.bpm[0] + Math.floor(rand() * (style.bpm[1] - style.bpm[0] + 1));
    // Half the library sits around 8A on the wheel, as a DJ's collection
    // tends to cluster, so a harmonic question has more than one answer.
    const camelot =
      rand() < 0.5
        ? pick(["7A", "8A", "9A", "8B"])
        : `${1 + Math.floor(rand() * 12)}${rand() < 0.65 ? "A" : "B"}`;
    tracks.push({
      externalId: i + 1,
      portableId: "",
      name: title,
      artist,
      album: `${title} EP`,
      comments: "",
      label: pick(LABELS),
      genre: style.genre,
      bpm,
      ...camelotKey(camelot),
      timeAdded: ADDED_FROM + Math.floor(rand() * (ADDED_TO - ADDED_FROM)),
      lengthMs: 180_000 + Math.floor(rand() * 240_000),
      // Distinct per track, so only the pair below is a size-and-length
      // duplicate; the stubs on disk have their own, real size.
      fileSize: 6_000_000 + i * 104_729,
      rating: null,
      hasFile: true,
    });
  }

  // What the audit is there to find. Each change below is one finding.
  const at = (id: number) => tracks[id - 1];
  for (const id of [7, 19, 33]) {
    // No BPM: never analysed.
    at(id).bpm = null;
    at(id).analysisFlags = 0;
  }
  for (const id of [11, 27, 45]) {
    // No key at all.
    at(id).keyValue = -1;
    at(id).keyText = "";
  }
  // A key typed in Open Key notation, which Serato itself cannot parse but
  // this server can: reported as unreadable by Serato, still searchable.
  at(14).keyValue = -1;
  at(14).keyText = "6m";
  at(38).keyValue = -1;
  at(38).keyText = "3d";
  for (const id of [9, 29, 50]) {
    // Missing, and Serato knows it.
    at(id).isMissing = 1;
    at(id).hasFile = false;
  }
  // Missing, but Serato has not noticed yet: only a check of the disk finds it.
  at(41).hasFile = false;

  // Duplicates: the same track imported twice (same artist and title), and
  // the same file under another name (same size and length).
  const dupOf = (source: number, externalId: number, over: Partial<DemoTrack> = {}) => {
    tracks.push({ ...at(source), externalId, ...over });
  };
  dupOf(2, 57);
  dupOf(16, 58);
  dupOf(23, 59, { name: `${at(23).name} (Extended Mix)`, album: `${at(23).name} (Extended Mix)` });

  for (const t of tracks) {
    t.comments = `Label: ${t.label}`;
    t.portableId = resolve(
      musicDir,
      `${String(t.externalId).padStart(2, "0")} ${t.artist} - ${t.name}.wav`,
    ).slice(1);
  }
  return tracks;
}

/** Crates of the Serato Library, each in a DJ's running order. */
export function demoCrates(tracks: DemoTrack[]): CrateSeed[] {
  const ids = (pred: (t: DemoTrack) => boolean, limit: number) =>
    tracks
      .filter((t) => t.externalId <= 56 && pred(t))
      .sort((a, b) => (a.bpm ?? 0) - (b.bpm ?? 0))
      .slice(0, limit)
      .map((t) => t.externalId);
  return [
    {
      id: 20,
      name: "Warm Up",
      trackExternalIds: ids((t) => t.genre === "Deep House" || t.genre === "Disco", 10),
    },
    {
      id: 21,
      name: "Peak Time",
      trackExternalIds: ids((t) => t.genre === "Techno" || t.genre === "House", 12),
    },
    { id: 22, name: "Hip-Hop Set", trackExternalIds: ids((t) => t.genre === "Hip-Hop", 8) },
    { id: 23, name: "Liquid DnB", trackExternalIds: ids((t) => t.genre === "Drum & Bass", 6) },
  ];
}

/** 0.25 s of 8 kHz mono silence: a real, playable WAV of 4 044 bytes. */
function silentWav(): Buffer {
  const samples = 2000;
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}

/**
 * Writes the demo library into `dir`, replacing an earlier demo there.
 * Refuses a folder that holds anything else, so it can never overwrite a
 * real library or unrelated files.
 */
export function makeDemoLibrary(dir: string): DemoLibrary {
  const root = resolve(dir);
  if (existsSync(root) && readdirSync(root).length > 0) {
    if (!existsSync(join(root, MARKER))) {
      throw new Error(
        `${root} is not empty and is not an earlier demo library; choose an empty folder`,
      );
    }
    for (const entry of ["Library", "Music", MARKER])
      rmSync(join(root, entry), { recursive: true, force: true });
  }
  const libraryDir = join(root, "Library");
  const musicDir = join(root, "Music");
  mkdirSync(libraryDir, { recursive: true });
  mkdirSync(musicDir, { recursive: true });
  writeFileSync(
    join(root, MARKER),
    "Demo library written by serato-dj-mcp's scripts/make-demo-library.ts\n",
  );

  const tracks = demoTracks(musicDir);
  const crates = demoCrates(tracks);
  makeLibraryFixture(libraryDir, { tracks, crates });
  const wav = silentWav();
  for (const t of tracks) if (t.hasFile) writeFileSync(`/${t.portableId}`, wav);
  return { libraryDir, musicDir, tracks, crates };
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write("usage: npm run demo-library -- <dir>\n");
    process.exit(2);
  }
  const lib = makeDemoLibrary(dir);
  const files = lib.tracks.filter((t) => t.hasFile).length;
  process.stdout.write(
    `Demo library: ${lib.tracks.length} tracks, ${lib.crates.length} crates, ${files} audio files.\n` +
      `Point the server at:\n  ${lib.libraryDir}\n`,
  );
}
