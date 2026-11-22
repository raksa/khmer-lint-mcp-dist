/**
 * `khmer-lint-mcp` — an MCP server for Khmer text.
 *
 * The command line (`npx khmer-lint-mcp`) is the usual way in; this module is
 * for hosts that embed the server: create it, then connect any MCP transport —
 * `runStdioServer` / `runHttpServer` here, or the SDK's own. The Khmer tools
 * themselves are the `khmer-lint` package.
 */
export { createKhmerLintMcpServer, createLazyLinter, CustomWords, KHMER_LINT_MCP_INSTRUCTIONS, } from '../../../src/khmer-lint-mcp/server.js';
export type { KhmerLintMcpServerOptions } from '../../../src/khmer-lint-mcp/server.js';
export { runHttpServer, runStdioServer, } from '../../../src/mcp-common/transports.js';
export type { HttpServerOptions, RunningHttpServer, } from '../../../src/mcp-common/transports.js';
export { KHMER_LINT_MCP_VERSION as version } from '../../../src/khmer-lint-mcp/version.js';
