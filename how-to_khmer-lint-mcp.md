# khmer-lint-mcp — how to use the MCP server

`khmer-lint-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server for Khmer text, built on the `khmer-lint` package. Through it, an AI
client can:

- spellcheck Khmer, including text written without word breaks;
- segment text;
- fix zero-width characters;
- keep a custom dictionary;
- convert digits;
- turn text typed in the wrong keyboard layout back into Khmer (NiDA).

## Install

Requires Node.js 20 or newer. Clients start it with `npx`:

```bash
npx -y khmer-lint-mcp --help
```

### Claude Code

```bash
claude mcp add khmer-lint -- npx -y khmer-lint-mcp
# every project: claude mcp add --scope user khmer-lint -- npx -y khmer-lint-mcp
```

### Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "khmer-lint": {
      "command": "npx",
      "args": ["-y", "khmer-lint-mcp", "--root", "/Users/me/Documents/Khmer"]
    }
  }
}
```

Give a `--root` for the file tools. A desktop app's working directory isn't a
document folder.

### Cursor

`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "khmer-lint": { "command": "npx", "args": ["-y", "khmer-lint-mcp"] }
  }
}
```

### VS Code

Install the **Khmer Lint MCP** extension. It registers the server, bundled
with its dictionaries, in VS Code's MCP Servers list. Or add it to
`.vscode/mcp.json`:

```json
{
  "servers": {
    "khmer-lint": { "type": "stdio", "command": "npx", "args": ["-y", "khmer-lint-mcp"] }
  }
}
```

On Windows, if a client cannot start `npx` directly, use
`"command": "cmd", "args": ["/c", "npx", "-y", "khmer-lint-mcp"]`.

## Command line

```text
khmer-lint-mcp [--http] [--port <n>] [--host <host>] [--root <dir>]… [--read-only]
               [--custom-words <file>] [--dictionary-dir <dir>]
```

| Option | Environment | Meaning |
| --- | --- | --- |
| *(none)* | | Serve MCP over stdio, which every client above uses. |
| `--http` | | Serve stateless Streamable HTTP instead: `POST /mcp`. Other paths answer 404, other methods 405. |
| `--port <n>` | `KHMER_LINT_MCP_PORT` | HTTP port. Default `3334`. |
| `--host <host>` | | HTTP interface. Default `127.0.0.1`. |
| `--root <dir>` (repeatable) | `KHMER_LINT_MCP_ROOTS` (a path list: `:`-separated, `;` on Windows) | Folders the file tools may use. |
| `--read-only` | `KHMER_LINT_MCP_READ_ONLY=1` (`1`/`true`/`yes`/`on`) | Never write a file, including the custom-words file. |
| `--custom-words <file>` | `KHMER_LINT_MCP_CUSTOM_WORDS` | Keep the custom dictionary in this file. |
| `--dictionary-dir <dir>` | `KHMER_LINT_MCP_DICTIONARY_DIR` | Use `km_KH.aff`, `km_KH.dic` and `km_KH-suggest.aff` from this folder instead of the bundled dictionaries. |
| `-v`, `--version` / `-h`, `--help` | | Print and exit. |

A bad option exits with code 2. stdout carries only the protocol; logging goes
to stderr.

The dictionaries load the first time a tool needs them, which takes a second
or two. Over HTTP, the loaded dictionaries and the custom dictionary are shared
by every request.

On a loopback host, the HTTP server checks the `Host` header (DNS-rebinding
protection). There is **no authentication**: binding `--host 0.0.0.0` hands
the file tools to anyone who can reach the port.

## Files and roots

Tools that take a `path` work only inside the **allowed roots**:

1. the roots the client announces (MCP `roots/list`, re-read when the client
   says they changed), plus
2. every `--root` / `KHMER_LINT_MCP_ROOTS` folder;
3. with neither, the server's working directory.

A relative path resolves against the first root. Every path is checked after
resolving symlinks, so a link pointing outside the roots is refused.

- **Reading.** Files must be UTF-8 text of at most 5 MB.
- **Writing.** An edit writes back only to a text format: `.txt`, `.md`,
  `.markdown`, `.html`, `.htm`, `.xml`, `.json`, `.yaml`, `.yml`, `.csv`,
  `.tsv`, `.srt`, `.vtt`, `.po`, `.strings`, `.properties`, `.tex`, `.rst` or
  `.adoc`.

## How tools take text

Every tool that reads text accepts **`text`** (the text itself) **or `path`**
(a file inside the roots), not both.

The edit tools are `fix_khmer`, `segment_khmer`, `remove_zero_width` and
`convert_digits`:

- Given `text`, they return the new `text`.
- Given `path`, they write the file in place and return `path` and
  `written: true`.
- With `dryRun: true`, or when the server is read-only, they return the new
  `text` with `written: false` and a `note` saying why.
- An edit that changes nothing writes nothing (`note: "No change."`).

Positions in results are 1-based: `line`, `column`, and `endColumn`, which is
exclusive. Columns count UTF-16 code units.

A tool that fails returns an MCP error result (`isError: true`) whose text says
why, for example a file outside the roots or dictionaries that won't load.

## Khmer text, as these tools see it

- **Word breaks.** A word break is a zero-width space (U+200B, ZWSP). A
  visible space separates phrases. On the NiDA keyboard, Space types the
  zero-width space and Shift+Space a visible one.
- **Runs.** Spelling is checked per *run*: the Khmer letters between spaces,
  punctuation and zero-width breaks.
- **Unspaced words.** A run of dictionary words written together is correct.
  A misspelled run gets the dictionary's suggestions, which may be empty. When
  it is several words long, `unknownParts` names the part the dictionary
  doesn't know.
- **Names and new words** belong in the custom dictionary. They aren't
  mistakes.

## Tools

### Lint and fix

| Tool | |
| --- | --- |
| `lint_khmer` | Issues in a text or file. See the rules and the options below. |
| `fix_khmer` | Applies fixes. Only `repeated-zero-width` by default; see below. |
| `lint_khmer_files` | Issue counts for every text file under the roots, worst first. |

`lint_khmer` takes these options:

- `rules`: default `spelling` and `repeated-zero-width`.
- `maxSuggestions`: 0–10, default 3. `0` is faster: no suggestions and no
  `unknownParts`.
- `maxIssues`: up to 5000, default 500.
- `customWords`: extra words to accept for this call.

Each issue carries `rule`, `severity`, `message`, `text`, `replacements`
(best first) and `unknownParts`. The result also counts the issues per rule
and sets `truncated` when `maxIssues` cut the list.

`fix_khmer` works rule by rule:

- `word-separator` turns visible spaces between Khmer letters into word
  breaks.
- `spelling` replaces each misspelling with its top suggestion and leaves
  misspellings that have none. Review these first with `lint_khmer`.

`lint_khmer_files` takes these options:

- `directory`: one folder inside the roots.
- `extensions`: default `.txt .md .markdown .html .htm .srt .vtt .csv .tsv
  .json`.
- `recursive`: default on.
- `rules`.
- `maxFiles`: up to 1000, default 200.

It skips dot-folders, `node_modules` and `dist`. A file it cannot read is
listed with an `error`.

| Rule | Default | Flags | Fix |
| --- | --- | --- | --- |
| `spelling` | on | A run that neither the Khmer dictionary nor the custom dictionary knows. | The top suggestion. |
| `repeated-zero-width` | on | Two or more zero-width characters (ZWSP, ZWNJ, ZWJ) in a row. | The first of them. |
| `word-separator` | off | Whitespace, ZWNJ included, between two Khmer letters. Use it only for text that marks every word break with ZWSP, such as lyrics typed on NiDA: Khmer prose puts visible spaces between phrases. | A ZWSP. |

### Spelling and segmentation

| Tool | |
| --- | --- |
| `check_khmer_words` | Checks 1–500 words. Each gets `correct`, `khmer` (false for a word with no Khmer letter, which always passes) and `custom` (accepted through the custom dictionary). |
| `suggest_khmer` | One word or run. Returns `correct`, `parts` (the run split at its dictionary words, each `known` or not) and `suggestions` (`limit`, default 5; none when correct). |
| `segment_khmer` | An edit tool. It inserts ZWSP word breaks: each run is split at the dictionary words it contains. An unknown stretch stays one piece, and a single-word run is left alone. `preview` shows the breaks as `visibleSeparator` (default `·`); `breaksAdded` counts them. |

### Custom dictionary

The custom dictionary applies to every spelling check.

| Tool | |
| --- | --- |
| `list_custom_words` | The words, the `file` they are kept in (`null` for this session only), and whether changes are `persistent`. |
| `add_custom_words` | Adds up to 500 words. A word must contain a Khmer letter, have no whitespace, and be at most 100 characters; others come back `rejected`. Leading and trailing ZWNJ/ZWJ are trimmed. |
| `remove_custom_words` | Removes words. |

With `--custom-words <file>`, the file is read on first use, and read again
whenever it changes on disk (its size or modification time), so words another
program writes there count from the next check. Additions are appended, one
word per line, and the file is created when needed. A removal rewrites the
file and keeps its `#` comment lines. Without the option, or in read-only
mode, changes last as long as the server; in read-only mode they are kept
over the file when it is read again.

### Zero-width characters, digits and words

| Tool | |
| --- | --- |
| `show_invisible_characters` | Counts ZWSP, ZWNJ, ZWJ and no-break spaces, and locates each zero-width run (at most 500, with `characters` naming each one). Returns a `preview` with them visible: ZWSP `·`, ZWNJ `⟨ZWNJ⟩`, ZWJ `⟨ZWJ⟩`, no-break space `⍽`. Pass `includePreview: false` to omit it. |
| `remove_zero_width` | An edit tool. `mode: collapse` (default) turns each run into its first character. `mode: remove` deletes every ZWSP/ZWNJ/ZWJ; that removes the word breaks too and can change how letters join. Returns `removed`. |
| `convert_digits` | An edit tool. `to: khmer` (០–៩) or `to: western` (0–9). Only digits change. `to: khmer` leaves the digits of non-Khmer text alone: a number whose nearest letter on its line, before or after, is Latin or another non-Khmer letter (`Bm7`, `Verse 1`, `Time: 4/4`, `70bpm`, `Psalm 23`) keeps its Western digits, so markup such as an Open Lyric song's chords, section names and Config survives. A number with only Khmer, or no letters, around it converts. Pass `all: true` to convert every digit. Returns `converted`, and for `to: khmer` `kept` — the Western digits left as they are. `to: western` converts every Khmer digit. |
| `list_khmer_words` | The distinct Khmer runs, most frequent first, with `count` and first `line`/`column`. Pass `checkSpelling: true` to add `correct`. `limit` defaults to 1000. |

### NiDA keyboard

| Tool | |
| --- | --- |
| `qwerty_to_khmer` | Text typed on US QWERTY while NiDA was meant → Khmer: `xjmEr` → `ខ្មែរ`. A space becomes ZWSP; characters no US key types are kept. |
| `khmer_to_qwerty` | The reverse. Characters needing Alt, or no key, are kept and listed in `untypeable`. |
| `nida_keystrokes` | The keys that type a text, in order. Each comes with `label` (`Shift+B`; Alt is Option on a Mac), `code`, `layer` and `qwerty`, the US character on that key. A key typing several characters wins. Text no key types has `code: null`. `sequence` lists the labels. Returns at most 2000 keystrokes, with `truncated` set when there are more. |
| `get_nida_layout` | What each key types per layer (`base`, `shift`, `alt`, `altShift`), with the US character on the same key. `layers` picks some. |

## Resources

| URI | Content |
| --- | --- |
| `khmer-lint://guide` | How these tools treat Khmer text (Markdown). |
| `khmer-lint://rules` | The lint rules: what each flags, its severity, whether it runs by default. |
| `khmer-lint://keyboard/nida` | The NiDA layout, as `get_nida_layout` returns it. |
| `khmer-lint://custom-words` | The custom dictionary, one word per line. |

## Prompts

| Prompt | Arguments |
| --- | --- |
| `proofread_khmer` | `text` or `path`. The text and its current lint result are inlined. |
| `add_word_breaks` | `text` or `path` |
| `type_with_nida` | `text` |
| `recover_wrong_layout` | `text` |

## Use it from code

```js
import {
  CustomWords,
  createKhmerLintMcpServer,
  createLazyLinter,
  runHttpServer,
  runStdioServer,
} from 'khmer-lint-mcp';

await runStdioServer(createKhmerLintMcpServer({ roots: ['/srv/texts'], readOnly: true }));

// Over HTTP, share one linter and one custom dictionary across requests:
const getLinter = createLazyLinter();
const customWordStore = new CustomWords({ file: '/srv/khmer-words.txt' });
const http = await runHttpServer(
  () => createKhmerLintMcpServer({ getLinter, customWordStore }),
  { port: 4000 },
);
// http.url, await http.close()
```

`createKhmerLintMcpServer(options)` accepts:

| Option | Meaning |
| --- | --- |
| `roots` | Allowed roots. |
| `readOnly` | Never write. |
| `cwd` | The base for relative roots and the custom-words file, and the fallback root. |
| `listClientRoots` | Replaces the roots lookup. |
| `dictionaryDir` | Where to read the dictionaries from. |
| `customWordsFile` | The custom-words file. |
| `customWords` | Words accepted from the start. |
| `customWordStore` | A shared `CustomWords`. |
| `getLinter` | A shared linter. |

`version` is the package version. The package is ESM-only. For the Khmer tools
without MCP, use `khmer-lint`.
