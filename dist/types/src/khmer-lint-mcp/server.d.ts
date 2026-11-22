import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLazyLinter, type KhmerLintToolContext } from './context.js';
import { CustomWords } from './custom-words.js';
import { KHMER_LINT_MCP_INSTRUCTIONS } from './guide.js';
export { KHMER_LINT_MCP_INSTRUCTIONS };
export interface KhmerLintMcpServerOptions {
    /**
     * Folders file tools may use, besides the roots the client announces. With
     * neither, the working directory.
     */
    roots?: string[];
    /** Never write a file (edits on a path return the text instead), nor the custom-words file. */
    readOnly?: boolean;
    /** Base for relative roots, and the fallback root. Default `process.cwd()`. */
    cwd?: string;
    /** Replace the client roots lookup (tests, custom hosts). */
    listClientRoots?: () => Promise<string[] | null>;
    /**
     * A folder holding `km_KH.aff`, `km_KH.dic` and `km_KH-suggest.aff`.
     * Default: the dictionaries the `khmer-lint` package ships.
     */
    dictionaryDir?: string;
    /**
     * The custom dictionary: a text file, one word per line, read on first use
     * and updated by add/remove_custom_words. Without one, custom words last
     * for the server's lifetime.
     */
    customWordsFile?: string;
    /** Words to accept from the start. */
    customWords?: Iterable<string>;
    /**
     * Share one custom dictionary between servers (the HTTP transport makes a
     * server per request). Overrides `customWordsFile` / `customWords`.
     */
    customWordStore?: CustomWords;
    /** Share one linter (loaded dictionaries) between servers. */
    getLinter?: KhmerLintToolContext['getLinter'];
}
/**
 * An MCP server for Khmer text: lint and fix, spellcheck and suggestions,
 * segmentation, the custom dictionary, zero-width characters, digits and the
 * NiDA keyboard. Connect it to a transport (`runStdioServer`,
 * `runHttpServer`, or the SDK's own).
 */
export declare function createKhmerLintMcpServer(options?: KhmerLintMcpServerOptions): McpServer;
export { CustomWords, createLazyLinter };
