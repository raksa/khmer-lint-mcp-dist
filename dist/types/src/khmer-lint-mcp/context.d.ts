import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type KhmerLintIssue, type KhmerLintRule } from 'khmer-lint';
import { type KhmerLinter } from 'khmer-lint/node';
import { type FileAccess } from '../mcp-common/file-access.js';
import { type CustomWords } from './custom-words.js';
/** What every tool group registers against. */
export interface KhmerLintToolContext {
    server: McpServer;
    files: FileAccess;
    customWords: CustomWords;
    readOnly: boolean;
    /** The linter, made on first use: loading the dictionaries takes a moment. */
    getLinter(): Promise<KhmerLinter>;
}
export declare class KhmerToolError extends Error {
}
/** Files larger than this are not read. */
export declare const MAX_TEXT_FILE_BYTES: number;
/** Text formats a fix may be written back to. */
export declare const TEXT_FILE_EXTENSIONS: string[];
/** What `lint_khmer_files` reads when no extensions are given. */
export declare const DEFAULT_LINT_EXTENSIONS: string[];
/** A linter factory that loads the dictionaries once, on first use. */
export declare function createLazyLinter(dictionaryDir?: string): () => Promise<KhmerLinter>;
export interface TextSource {
    text: string;
    /** The real path, when the text came from a file. */
    path?: string;
}
export declare function readTextSource(files: FileAccess, { text, path }: {
    text?: string;
    path?: string;
}): Promise<TextSource>;
/** Spelling + rules, with the stored and per-call custom words. */
export declare function lintText(context: KhmerLintToolContext, text: string, { rules, maxSuggestions, maxIssues, customWords, }?: {
    rules?: readonly KhmerLintRule[];
    maxSuggestions?: number;
    maxIssues?: number;
    customWords?: readonly string[];
}): Promise<{
    issues: KhmerLintIssue[];
    truncated: boolean;
}>;
/** An issue as the tools report it: 1-based line and columns. */
export declare function toReportedIssue(issue: KhmerLintIssue): {
    unknownParts?: string[] | undefined;
    rule: KhmerLintRule;
    severity: "warning" | "information";
    message: string;
    line: number;
    column: number;
    endColumn: number;
    text: string;
    replacements: string[];
};
export declare function countIssues(issues: readonly KhmerLintIssue[]): {
    spelling: number;
    wordSeparator: number;
    repeatedZeroWidth: number;
};
/**
 * Finish an edit: for text input, return the new text; for a file, write it
 * back — unless `dryRun` or the server is read-only (then return the text and
 * say why it was not written), or nothing changed.
 */
export declare function finishTextEdit<T extends object>(files: FileAccess, source: TextSource, text: string, data: T, { dryRun, summary }: {
    dryRun?: boolean;
    summary: string;
}): Promise<{
    [x: string]: unknown;
    content: ({
        type: "text";
        text: string;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | {
        type: "image";
        data: string;
        mimeType: string;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | {
        type: "audio";
        data: string;
        mimeType: string;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    } | {
        uri: string;
        name: string;
        type: "resource_link";
        description?: string | undefined;
        mimeType?: string | undefined;
        size?: number | undefined;
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
        icons?: {
            src: string;
            mimeType?: string | undefined;
            sizes?: string[] | undefined;
            theme?: "light" | "dark" | undefined;
        }[] | undefined;
        title?: string | undefined;
    } | {
        type: "resource";
        resource: {
            uri: string;
            text: string;
            mimeType?: string | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        } | {
            uri: string;
            blob: string;
            mimeType?: string | undefined;
            _meta?: {
                [x: string]: unknown;
            } | undefined;
        };
        annotations?: {
            audience?: ("user" | "assistant")[] | undefined;
            priority?: number | undefined;
            lastModified?: string | undefined;
        } | undefined;
        _meta?: {
            [x: string]: unknown;
        } | undefined;
    })[];
    _meta?: {
        [x: string]: unknown;
        progressToken?: string | number | undefined;
        "io.modelcontextprotocol/related-task"?: {
            taskId: string;
        } | undefined;
    } | undefined;
    structuredContent?: {
        [x: string]: unknown;
    } | undefined;
    isError?: boolean | undefined;
}>;
