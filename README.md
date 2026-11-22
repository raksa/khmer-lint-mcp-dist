# Khmer Lint MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for Khmer
text, built on [`khmer-lint`](https://www.npmjs.com/package/khmer-lint). An AI
client can spellcheck Khmer — unspaced text included — split it into words,
fix zero-width characters, convert digits, and turn text typed in the wrong
keyboard layout back into Khmer (NiDA).

## Install

Node.js 20 or newer. Clients start it with `npx`:

```bash
# Claude Code
claude mcp add khmer-lint -- npx -y khmer-lint-mcp
```

```jsonc
// Claude Desktop (claude_desktop_config.json), Cursor (~/.cursor/mcp.json)
{
  "mcpServers": {
    "khmer-lint": { "command": "npx", "args": ["-y", "khmer-lint-mcp", "--root", "/path/to/texts"] }
  }
}
```

```jsonc
// VS Code (.vscode/mcp.json) — or install the "Khmer Lint MCP" extension
{
  "servers": {
    "khmer-lint": { "type": "stdio", "command": "npx", "args": ["-y", "khmer-lint-mcp"] }
  }
}
```

## What it offers

- **Tools**:
  - lint a text or file, fix it, or lint a whole folder;
  - check words, get suggestions, add zero-width word breaks to unspaced text;
  - keep a custom dictionary;
  - reveal, collapse or remove zero-width characters;
  - convert between Khmer and Western digits;
  - list the Khmer words in a text;
  - convert text between US-QWERTY and NiDA, list the NiDA keystrokes for a
    text, and show the layout.
- **Resources**: a guide to Khmer text conventions, the lint rules, the NiDA
  layout and the custom dictionary.
- **Prompts**: proofread, add word breaks, type a text on NiDA, recover text
  typed in the wrong layout.

File tools stay inside the roots the client announces, plus any `--root`
folders; with neither, the working directory. `--read-only` never writes.
`--custom-words <file>` keeps the custom dictionary between sessions.
`--http` serves Streamable HTTP on `127.0.0.1:3334/mcp` instead of stdio.

The full guide, covering every tool, option and rule, is
[`how-to_khmer-lint-mcp.md`](./how-to_khmer-lint-mcp.md) and ships in this
package.

## Use it from code

```js
import { createKhmerLintMcpServer, runStdioServer } from 'khmer-lint-mcp';

await runStdioServer(createKhmerLintMcpServer({ roots: ['/srv/texts'] }));
```

ESM only. For the Khmer tools without MCP, use
[`khmer-lint`](https://www.npmjs.com/package/khmer-lint) directly.

## Build

From the repo root, run `npm run pack -- khmer-lint khmer-lint-mcp`.
`khmer-lint` stays an external dependency, and its dictionaries come with it.

### Releasing

For maintainers:

1. Bump `version` in `package.json`.
2. Run `npm run pack -- khmer-lint-mcp`. This also syncs `server.json`.
3. Run `npm run pub -- khmer-lint-mcp`, after `khmer-lint` is published.
4. To list the release in the MCP Registry, run `mcp-publisher login github`
   and then `mcp-publisher publish` in this folder. The registry checks that
   this package's `mcpName` matches the `name` in `server.json`.

## License

MIT
