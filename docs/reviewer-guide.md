# Trying the Claude Desktop extension on a demo library

This page is for anyone who wants to check `serato-dj-mcp` without a Serato library of their own,
such as a reviewer of an extension directory. It takes about five minutes on a Mac.

**macOS only.** The extension is built for macOS and was tested there; it does not install on
Windows or Linux.

The demo library is invented from start to finish: 59 tracks, 4 crates, made-up artists, titles and
labels. Any resemblance to a real artist, title or label is accidental. It is built on your Mac by
a script from this repository, because a Serato library records each track by its absolute path,
and those paths have to point into your own home folder.

## 1. Build the demo library

You need `git` and [Node.js](https://nodejs.org) 22.16 or newer for this step only; the extension
itself runs on the Node.js built into Claude Desktop.

```sh
git clone https://github.com/Venut-Technologies/serato-dj-mcp.git
cd serato-dj-mcp
npm ci
npm run demo-library -- ~/serato-demo
```

It prints the folder to use in the next step, `~/serato-demo/Library` (spelled out as a full
path). The script writes two folders and nothing else:

- `~/serato-demo/Library` — the library: `master.sqlite` and `root.sqlite`, the two databases of a
  Serato DJ 4.x library;
- `~/serato-demo/Music` — 55 silent WAV files the tracks point at. Four tracks have no file, on
  purpose, for the audit to find.

Running it again replaces the demo in that folder with an identical one. It refuses any folder that
is not empty and was not made by it.

## 2. Install the extension and point it at the demo

1. Download `serato-dj-mcp-<version>.mcpb` from the
   [latest release](https://github.com/Venut-Technologies/serato-dj-mcp/releases/latest) and open
   it. Claude Desktop shows the extension; choose **Install**.
2. In the extension's settings (Settings → Extensions → Serato DJ library), set **Serato library
   folder** to the `Library` folder printed in step 1. Leave **Allow writing crates** and
   **Allow raw SQL** off for now.

   Set the folder even if you have Serato installed: without it the extension uses the real
   library on this Mac.
3. In a new chat, check that **Serato DJ library** is switched on in the tools menu.

## 3. Ask these questions

The answers below are what the demo library holds; the assistant's wording will vary. These results
are checked by `tests/demo-library.test.ts` on every change to the repository.

| Ask | Expect |
|---|---|
| "What crates do I have in Serato?" | Four crates: **Warm Up** (10 tracks), **Peak Time** (12), **Hip-Hop Set** (8), **Liquid DnB** (6). |
| "Find tracks between 118 and 126 BPM in 8A or 9A." | Three tracks: Harbor Sine – *Paper Lantern* (120, 8A), Velvet Orrery – *Hollow Signal* (118, 8A), Saltwire – *Paper Garden* (125, 8A). |
| "What mixes harmonically out of 8A, around 124 BPM?" | Twelve tracks, every one in 7A, 8A, 9A or 8B, the keys next to 8A on the Camelot wheel. |
| "Show me my Warm Up crate, in order." | Ten Disco and Deep House tracks from 112 to 118 BPM, starting with Kitefall – *Paper Engine* (112, 9A). |
| "Audit my library." | Three groups of duplicates: Lumenhaus – *Silver Circuit* twice, Cinder Arcade – *Quiet Tide* twice, and Kitefall – *Quiet Garden* with its *(Extended Mix)*, which is the same file under another name. Also: 3 tracks with no BPM, 3 with no key, 2 whose key Serato itself cannot read (typed in Open Key notation; this server reads them as 1A and 10B), 3 tracks Serato has marked missing, and 23 tracks in no crate. |
| "Check the disk for missing files too." | Four missing files: the three Serato marked, plus Lumenhaus – *Hollow Steps*, whose file is gone although Serato has not noticed yet. |

## 4. Optional: write a crate

Writing is off by default and is what the extension's safety design is about, so it is worth
seeing. It changes only the demo library.

1. In the extension's settings, switch **Allow writing crates** on, then start a new chat. If the
   four write tools (`stage_crate`, `preview_changes`, `apply_changes`, `discard_changes`) do not
   appear in the tools menu, switch the extension off and on again.
2. Ask: "Build a crate called *Friday Opening* from the three tracks between 118 and 126 BPM in 8A
   or 9A, and show me the list before writing anything."

   Expect the assistant to stage the crate and show its three tracks. Nothing is written yet.
3. Ask: "Show me what is staged." Expect one crate with three tracks.
4. Ask: "Apply it." The tool's description tells the assistant to show the staged crate and get
   your explicit go-ahead first, and `apply_changes` is marked destructive, so expect a question
   before the write. Then expect the crate reported as written, with the paths of the two database
   backups taken just before it, under `~/Library/Application Support/serato-dj-mcp/backups/`.

   The write goes to `~/serato-demo/Library/root.sqlite`. It is refused while a Serato process is
   using that library, which a demo library never has. Serato does not have to be installed.

The new crate does not show up in "What crates do I have?" afterwards. That is expected: in a real
library, Serato copies new crates into its other database the next time it starts, and the read
tools answer from that database. The README's
[Writing to the library](../README.md#writing-to-the-library) section says the same. To see the
crate in the file itself:

```sh
sqlite3 -readonly ~/serato-demo/Library/root.sqlite "SELECT name FROM container WHERE name = 'Friday Opening'"
```

## 5. Clean up

- Remove the extension in Settings → Extensions.
- Delete `~/serato-demo`.
- Delete what the extension kept: `~/Library/Caches/serato-dj-mcp` (a snapshot copy of the demo
  library) and, if you tried writing, `~/Library/Application Support/serato-dj-mcp` (staged crates,
  the write manifest and the backups).

Everything the extension reads, writes and sends is listed in [PRIVACY.md](../PRIVACY.md): it makes
no network requests and has no telemetry.
