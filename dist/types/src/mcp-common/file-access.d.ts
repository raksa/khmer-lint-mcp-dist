/**
 * File access for the MCP servers' path-taking tools, confined to roots.
 *
 * The roots are, in order of preference: the ones the client announces
 * (`roots/list` — an editor's workspace folders), plus any configured with
 * `--root` / an environment variable; with neither, the server's working
 * directory. Every path a tool is given is resolved (relative paths against
 * the first root), its real location taken (so a symlink cannot point out of
 * a root), and refused unless it lies inside one. Writes are refused outright
 * in read-only mode and limited to the extensions each tool allows.
 */
export interface FileAccessOptions {
    /** Roots from the command line / environment (absolute or cwd-relative). */
    configuredRoots?: readonly string[];
    /** Refuse every write. */
    readOnly?: boolean;
    /** Working directory used for relative configured roots and as a last resort root. */
    cwd?: string;
    /**
     * The client's roots as file paths, or `null` when the client offers none.
     * Asked on every call, so a workspace change is picked up.
     */
    listClientRoots?: () => Promise<string[] | null>;
}
export declare class FileAccessError extends Error {
}
export declare function hasAllowedExtension(filePath: string, extensions: readonly string[]): boolean;
export declare class FileAccess {
    #private;
    readonly readOnly: boolean;
    constructor({ configuredRoots, readOnly, cwd, listClientRoots, }?: FileAccessOptions);
    /** The roots in effect right now, real paths, deduplicated. */
    getRoots(): Promise<string[]>;
    /** The real path of an existing file inside the roots. */
    resolveForRead(input: string): Promise<string>;
    /** Where a write to `input` lands, once checked against the roots. */
    resolveForWrite(input: string, extensions: readonly string[]): Promise<string>;
    /**
     * A UTF-8 file inside the roots. With `maxBytes`, a larger file is refused
     * before it is read.
     */
    readText(input: string, { maxBytes }?: {
        maxBytes?: number;
    }): Promise<{
        path: string;
        text: string;
    }>;
    writeFile(input: string, data: string | Uint8Array, extensions: readonly string[]): Promise<{
        path: string;
        bytes: number;
    }>;
    /**
     * Files under `directory` (default: every root) whose names end in one of
     * `extensions`, skipping dot-folders, `node_modules`, `.git` and `dist`.
     */
    listFiles({ directory, extensions, recursive, limit, }: {
        directory?: string;
        extensions: readonly string[];
        recursive?: boolean;
        limit?: number;
    }): Promise<{
        files: string[];
        truncated: boolean;
    }>;
}
