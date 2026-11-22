export declare class CustomWordError extends Error {
}
/** A word as stored: trimmed, without edge ZWNJ/ZWJ; `null` when unusable. */
export declare function cleanCustomWord(word: string): string | null;
export declare class CustomWords {
    #private;
    readonly file: string | null;
    readonly readOnly: boolean;
    constructor({ file, words, readOnly, }?: {
        file?: string | null;
        words?: Iterable<string>;
        readOnly?: boolean;
    });
    /** Whether additions and removals are saved. */
    get persistent(): boolean;
    list(): Promise<string[]>;
    has(word: string): Promise<boolean>;
    /** Add words; returns those that were new and those refused. */
    add(words: readonly string[]): Promise<{
        added: string[];
        rejected: string[];
        saved: boolean;
    }>;
    /** Remove words; returns those that were there. */
    remove(words: readonly string[]): Promise<{
        removed: string[];
        saved: boolean;
    }>;
}
