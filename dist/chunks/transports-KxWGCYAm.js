import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fileURLToPath } from "node:url";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { KHMER_BASE_LETTER_RE, KHMER_KEY_LAYOUTS, KHMER_LINT_DEFAULT_RULES, KHMER_LINT_RULES, US_QWERTY_LAYOUT, ZERO_WIDTH_SPACE, applyKhmerLintFixes, collapseZeroWidthRuns, convertKhmerToQwerty, convertQwertyToKhmer, findKhmerWords, findZeroWidthRuns, getNidaKeystrokes, lintKhmerText, normalizeKhmerWord, removeZeroWidthCharacters, toArabicDigits, toKhmerDigits } from "khmer-lint";
import { createKhmerLinter } from "khmer-lint/node";
import { z } from "zod";
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
//#region src/mcp-common/client-roots.ts
/**
* The client's `roots/list` as file paths, for {@link FileAccess}: `null` when
* the client does not offer roots (or does not answer in time — a stateless
* HTTP request cannot carry a server-to-client request), so the configured
* roots apply. Cached until the client says the list changed.
*/
function createClientRootsLister(server, { timeoutMs = 3e3 } = {}) {
	let cached = null;
	server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
		cached = null;
	});
	const fetchRoots = async () => {
		if (!server.server.getClientCapabilities()?.roots) return null;
		let timer;
		try {
			const result = await Promise.race([server.server.listRoots(), new Promise((resolve) => {
				timer = setTimeout(() => resolve(null), timeoutMs);
			})]);
			if (!result) return null;
			const paths = result.roots.filter((root) => root.uri.startsWith("file:")).map((root) => fileURLToPath(root.uri));
			return paths.length ? paths : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
	return () => {
		cached ??= fetchRoots().then((roots) => {
			if (!roots) cached = null;
			return roots;
		});
		return cached;
	};
}
//#endregion
//#region src/mcp-common/file-access.ts
var FileAccessError = class extends Error {};
var SKIPPED_DIRECTORY_NAMES = /* @__PURE__ */ new Set([
	"node_modules",
	".git",
	"dist"
]);
function isInside(child, root) {
	const relative = path.relative(root, child);
	return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
function toPath(input) {
	const value = String(input ?? "").trim();
	if (!value) throw new FileAccessError("A path is required.");
	return value.startsWith("file:") ? fileURLToPath(value) : value;
}
async function realpathOrNull(target) {
	try {
		return await realpath(target);
	} catch {
		return null;
	}
}
function hasAllowedExtension(filePath, extensions) {
	const lower = filePath.toLowerCase();
	return extensions.some((extension) => lower.endsWith(extension.toLowerCase()));
}
var FileAccess = class {
	#configuredRoots;
	#cwd;
	#listClientRoots;
	readOnly;
	constructor({ configuredRoots = [], readOnly = false, cwd = process.cwd(), listClientRoots } = {}) {
		this.#cwd = cwd;
		this.#configuredRoots = configuredRoots.map((root) => path.resolve(cwd, toPath(root)));
		this.#listClientRoots = listClientRoots;
		this.readOnly = readOnly;
	}
	/** The roots in effect right now, real paths, deduplicated. */
	async getRoots() {
		let clientRoots = [];
		try {
			clientRoots = await this.#listClientRoots?.() ?? [];
		} catch {
			clientRoots = [];
		}
		const candidates = [...clientRoots, ...this.#configuredRoots];
		const roots = [];
		for (const candidate of candidates.length ? candidates : [this.#cwd]) {
			const real = await realpathOrNull(path.resolve(this.#cwd, candidate));
			if (real && !roots.includes(real)) roots.push(real);
		}
		return roots;
	}
	async #resolve(input) {
		const roots = await this.getRoots();
		if (!roots.length) throw new FileAccessError("No file roots are available — start the server with --root <dir>.");
		const candidate = toPath(input);
		return {
			absolute: path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(roots[0], candidate),
			roots
		};
	}
	#assertInsideRoots(realTarget, roots, input) {
		if (!roots.some((root) => isInside(realTarget, root))) throw new FileAccessError(`"${input}" is outside the allowed roots (${roots.join(", ")}).`);
	}
	/** The real path of an existing file inside the roots. */
	async resolveForRead(input) {
		const { absolute, roots } = await this.#resolve(input);
		const real = await realpathOrNull(absolute);
		if (!real) throw new FileAccessError(`File not found: ${absolute}`);
		this.#assertInsideRoots(real, roots, input);
		return real;
	}
	/** Where a write to `input` lands, once checked against the roots. */
	async resolveForWrite(input, extensions) {
		if (this.readOnly) throw new FileAccessError("The server is read-only; writing is disabled.");
		const { absolute, roots } = await this.#resolve(input);
		if (extensions.length && !hasAllowedExtension(absolute, extensions)) throw new FileAccessError(`Refusing to write "${absolute}": the file must end in ${extensions.join(", ")}.`);
		let existing = path.dirname(absolute);
		const missingSegments = [path.basename(absolute)];
		while (!await realpathOrNull(existing)) {
			const parent = path.dirname(existing);
			if (parent === existing) throw new FileAccessError(`Cannot resolve a parent folder of ${absolute}.`);
			missingSegments.unshift(path.basename(existing));
			existing = parent;
		}
		const realParent = await realpathOrNull(existing);
		const target = path.join(realParent, ...missingSegments);
		this.#assertInsideRoots(target, roots, input);
		try {
			const stats = await lstat(target);
			if (stats.isSymbolicLink()) {
				const realTarget = await realpathOrNull(target);
				if (!realTarget) throw new FileAccessError(`Refusing to write through the dangling link ${target}.`);
				this.#assertInsideRoots(realTarget, roots, input);
				return realTarget;
			}
			if (stats.isDirectory()) throw new FileAccessError(`${target} is a folder, not a file.`);
		} catch (error) {
			if (error instanceof FileAccessError) throw error;
		}
		return target;
	}
	/**
	* A UTF-8 file inside the roots. With `maxBytes`, a larger file is refused
	* before it is read.
	*/
	async readText(input, { maxBytes } = {}) {
		const resolved = await this.resolveForRead(input);
		if (maxBytes !== void 0) {
			const { size } = await stat(resolved);
			if (size > maxBytes) throw new FileAccessError(`${resolved} is ${size} bytes; the limit is ${maxBytes}.`);
		}
		return {
			path: resolved,
			text: await readFile(resolved, "utf8")
		};
	}
	async writeFile(input, data, extensions) {
		const resolved = await this.resolveForWrite(input, extensions);
		await mkdir(path.dirname(resolved), { recursive: true });
		await writeFile(resolved, data);
		return {
			path: resolved,
			bytes: typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength
		};
	}
	/**
	* Files under `directory` (default: every root) whose names end in one of
	* `extensions`, skipping dot-folders, `node_modules`, `.git` and `dist`.
	*/
	async listFiles({ directory, extensions, recursive = true, limit = 500 }) {
		const starts = directory ? [await this.resolveForRead(directory)] : await this.getRoots();
		const files = [];
		let truncated = false;
		const walk = async (folder) => {
			if (truncated) return;
			let entries;
			try {
				entries = await readdir(folder, { withFileTypes: true });
			} catch {
				return;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (truncated) return;
				const entryPath = path.join(folder, entry.name);
				if (entry.isDirectory()) {
					if (recursive && !entry.name.startsWith(".") && !SKIPPED_DIRECTORY_NAMES.has(entry.name)) await walk(entryPath);
					continue;
				}
				if (entry.isFile() && hasAllowedExtension(entry.name, extensions)) {
					if (files.length >= limit) {
						truncated = true;
						return;
					}
					files.push(entryPath);
				}
			}
		};
		for (const start of starts) await walk(start);
		return {
			files,
			truncated
		};
	}
};
//#endregion
//#region src/mcp-common/results.ts
/**
* Tool result helpers shared by the Open Lyric MCP servers.
*
* A tool that declares an `outputSchema` returns its data twice: as
* `structuredContent` (what a client validates and programs against) and as a
* text block holding a one-line summary plus the same JSON, for clients that
* only read `content`.
*/
function structuredResult(data, summary = "") {
	const json = JSON.stringify(data, null, 2);
	return {
		content: [{
			type: "text",
			text: summary ? `${summary}\n\n${json}` : json
		}],
		structuredContent: data
	};
}
function errorMessage(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
function errorResult(error) {
	return {
		isError: true,
		content: [{
			type: "text",
			text: errorMessage(error)
		}]
	};
}
/**
* Run a tool body, turning a thrown error into an `isError` result — the MCP
* way to tell the model its call failed (bad input, a path outside the roots),
* as opposed to a protocol error.
*/
async function runTool(body) {
	try {
		return await body();
	} catch (error) {
		return errorResult(error);
	}
}
//#endregion
//#region src/khmer-lint-mcp/custom-words.ts
/**
* The custom dictionary: words the spellcheck accepts whatever the Hunspell
* dictionary says. With a file (`--custom-words`), it is read on first use
* and every addition or removal is saved to it — one word per line, `#`
* starting a comment line. The file is read again whenever it changes on
* disk, so words another program writes there (an editor keeping its own
* dictionary in step) count from the next check. Without one, changes last
* for the session.
*/
var MAX_CUSTOM_WORD_LENGTH = 100;
/** A word as stored: trimmed, without edge ZWNJ/ZWJ; `null` when unusable. */
function cleanCustomWord(word) {
	const cleaned = normalizeKhmerWord(String(word ?? "").trim());
	return cleaned && cleaned.length <= MAX_CUSTOM_WORD_LENGTH && !/\s/u.test(cleaned) && KHMER_BASE_LETTER_RE.test(cleaned) ? cleaned : null;
}
function parseWordList(text) {
	return text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => cleanCustomWord(line)).filter((word) => Boolean(word));
}
var CustomWords = class {
	file;
	readOnly;
	/** The words given to the constructor: accepted whatever the file says. */
	#given = /* @__PURE__ */ new Set();
	/** The file's words, as last read or written. */
	#saved = /* @__PURE__ */ new Set();
	/** Changes this session could not save (no file, or read-only). */
	#added = /* @__PURE__ */ new Set();
	#removed = /* @__PURE__ */ new Set();
	/** The file's size and modification time when last read; `null`: unread. */
	#stamp = null;
	constructor({ file = null, words = [], readOnly = false } = {}) {
		this.file = file ? path.resolve(file) : null;
		this.readOnly = readOnly;
		for (const word of words) {
			const cleaned = cleanCustomWord(word);
			if (cleaned) this.#given.add(cleaned);
		}
	}
	/** Whether additions and removals are saved. */
	get persistent() {
		return Boolean(this.file) && !this.readOnly;
	}
	/** The file's size and modification time, `''` when there is none. */
	async #readStamp() {
		if (!this.file) return "";
		try {
			const info = await stat(this.file);
			return `${info.size}:${info.mtimeMs}`;
		} catch (error) {
			if (error.code === "ENOENT") return "";
			throw error;
		}
	}
	/** Read the file when it is new to us: first use, or changed since. */
	async #load() {
		if (!this.file) return;
		const stamp = await this.#readStamp();
		if (stamp === this.#stamp) return;
		let text = "";
		if (stamp) try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		this.#saved = new Set(parseWordList(text));
		this.#stamp = stamp;
	}
	/** The file as this store just wrote it: no need to read it back. */
	async #wrote() {
		this.#stamp = await this.#readStamp();
	}
	#words() {
		const words = /* @__PURE__ */ new Set([
			...this.#given,
			...this.#saved,
			...this.#added
		]);
		this.#removed.forEach((word) => words.delete(word));
		return words;
	}
	async list() {
		await this.#load();
		return Array.from(this.#words()).sort((left, right) => left.localeCompare(right));
	}
	async has(word) {
		await this.#load();
		return this.#words().has(word);
	}
	/** Add words; returns those that were new and those refused. */
	async add(words) {
		await this.#load();
		const present = this.#words();
		const added = [];
		const rejected = [];
		words.forEach((word) => {
			const cleaned = cleanCustomWord(word);
			if (!cleaned) rejected.push(word);
			else if (!present.has(cleaned) && !added.includes(cleaned)) added.push(cleaned);
		});
		added.forEach((word) => this.#removed.delete(word));
		if (added.length && this.persistent && this.file) {
			await mkdir(path.dirname(this.file), { recursive: true });
			let prefix = "";
			try {
				const current = await readFile(this.file, "utf8");
				prefix = current && !/\n$/.test(current) ? "\n" : "";
			} catch {
				prefix = "";
			}
			await appendFile(this.file, `${prefix}${added.join("\n")}\n`, "utf8");
			added.forEach((word) => this.#saved.add(word));
			await this.#wrote();
		} else added.forEach((word) => this.#added.add(word));
		return {
			added,
			rejected,
			saved: this.persistent && added.length > 0
		};
	}
	/** Remove words; returns those that were there. */
	async remove(words) {
		await this.#load();
		const present = this.#words();
		const removed = Array.from(new Set(words.map((word) => cleanCustomWord(word)).filter((word) => Boolean(word && present.has(word)))));
		removed.forEach((word) => this.#added.delete(word));
		if (removed.length && this.persistent && this.file) {
			let current = "";
			try {
				current = await readFile(this.file, "utf8");
			} catch {
				current = "";
			}
			const kept = current.split(/\r\n|\r|\n/).filter((line) => {
				const cleaned = cleanCustomWord(line.trim());
				return !(cleaned && removed.includes(cleaned) && !line.trim().startsWith("#"));
			});
			await writeFile(this.file, `${kept.join("\n").replace(/\n+$/, "")}\n`, "utf8");
			removed.forEach((word) => this.#saved.delete(word));
			await this.#wrote();
			removed.filter((word) => this.#given.has(word)).forEach((word) => this.#removed.add(word));
		} else removed.forEach((word) => this.#removed.add(word));
		return {
			removed,
			saved: this.persistent && removed.length > 0
		};
	}
};
//#endregion
//#region src/khmer-lint-mcp/context.ts
var KhmerToolError = class extends Error {};
/** Files larger than this are not read. */
var MAX_TEXT_FILE_BYTES = 5242880;
/** Text formats a fix may be written back to. */
var TEXT_FILE_EXTENSIONS = [
	".txt",
	".md",
	".markdown",
	".html",
	".htm",
	".xml",
	".json",
	".yaml",
	".yml",
	".csv",
	".tsv",
	".srt",
	".vtt",
	".po",
	".strings",
	".properties",
	".tex",
	".rst",
	".adoc"
];
/** What `lint_khmer_files` reads when no extensions are given. */
var DEFAULT_LINT_EXTENSIONS = [
	".txt",
	".md",
	".markdown",
	".html",
	".htm",
	".srt",
	".vtt",
	".csv",
	".tsv",
	".json"
];
/** A linter factory that loads the dictionaries once, on first use. */
function createLazyLinter(dictionaryDir) {
	let linter = null;
	return () => {
		linter ??= (async () => {
			const created = createKhmerLinter({ ...dictionaryDir ? { dictionaryDir } : {} });
			await created.ready();
			return created;
		})().catch((error) => {
			linter = null;
			throw error;
		});
		return linter;
	};
}
function assertText(text, where) {
	if (text.includes("\0")) throw new KhmerToolError(`${where} is not a text file.`);
	return text;
}
async function readTextSource(files, { text, path }) {
	if (typeof text === "string" && path) throw new KhmerToolError("Pass the text or a path, not both.");
	if (typeof text === "string") return { text };
	if (path) {
		const file = await files.readText(path, { maxBytes: MAX_TEXT_FILE_BYTES });
		return {
			text: assertText(file.text, file.path),
			path: file.path
		};
	}
	throw new KhmerToolError("Pass the text, or a path to a text file.");
}
/** Spelling + rules, with the stored and per-call custom words. */
async function lintText(context, text, { rules, maxSuggestions = 3, maxIssues = 500, customWords = [] } = {}) {
	const linter = !rules || rules.includes("spelling") ? await context.getLinter() : null;
	const issues = await lintKhmerText(text, {
		spellchecker: linter?.engine ?? null,
		customWords: [...await context.customWords.list(), ...customWords],
		...rules ? { rules } : {},
		maxSuggestions,
		maxIssues: maxIssues + 1
	});
	return {
		issues: issues.slice(0, maxIssues),
		truncated: issues.length > maxIssues
	};
}
/** An issue as the tools report it: 1-based line and columns. */
function toReportedIssue(issue) {
	return {
		rule: issue.rule,
		severity: issue.severity,
		message: issue.message,
		line: issue.line + 1,
		column: issue.start + 1,
		endColumn: issue.end + 1,
		text: issue.text,
		replacements: issue.replacements,
		...issue.unknownParts ? { unknownParts: issue.unknownParts } : {}
	};
}
function countIssues(issues) {
	return {
		spelling: issues.filter(({ rule }) => rule === "spelling").length,
		wordSeparator: issues.filter(({ rule }) => rule === "word-separator").length,
		repeatedZeroWidth: issues.filter(({ rule }) => rule === "repeated-zero-width").length
	};
}
/**
* Finish an edit: for text input, return the new text; for a file, write it
* back — unless `dryRun` or the server is read-only (then return the text and
* say why it was not written), or nothing changed.
*/
async function finishTextEdit(files, source, text, data, { dryRun = false, summary }) {
	if (!source.path) return structuredResult({
		...data,
		text,
		written: false
	}, summary);
	if (text === source.text) return structuredResult({
		...data,
		path: source.path,
		written: false,
		note: "No change."
	}, `${summary}\nNo change: ${source.path} was not written.`);
	if (dryRun || files.readOnly) {
		const note = dryRun ? "Dry run: the file was not written." : "The server is read-only: the file was not written.";
		return structuredResult({
			...data,
			text,
			path: source.path,
			written: false,
			note
		}, `${summary}\n${note}`);
	}
	const written = await files.writeFile(source.path, text, TEXT_FILE_EXTENSIONS);
	return structuredResult({
		...data,
		path: written.path,
		written: true
	}, `${summary}\nWrote ${written.path}.`);
}
//#endregion
//#region src/khmer-lint-mcp/guide.ts
/** What the server tells every client up front (`instructions`). */
var KHMER_LINT_MCP_INSTRUCTIONS = `Khmer text tools. Khmer runs its words together: a word break is an invisible zero-width space (U+200B, ZWSP); a visible space separates phrases.

- lint_khmer finds possible misspellings and repeated zero-width characters; its 'word-separator' rule (opt-in) flags visible spaces between Khmer letters, for text that marks word breaks with ZWSP. fix_khmer applies fixes — check spelling fixes with lint_khmer first.
- A run of dictionary words written without breaks is correct. For a misspelled longer run, unknownParts names the part the dictionary does not know; its replacements are dictionary suggestions, sometimes none. segment_khmer adds word breaks throughout.
- Names and new words belong in the custom dictionary (add_custom_words), not "corrected".
- Zero-width characters are invisible in tool output: show_invisible_characters reveals them.
- Files are read and written only inside the allowed roots. Tools given a path change that file in place — pass dryRun to preview.
- qwerty_to_khmer / khmer_to_qwerty repair text typed with the wrong keyboard layout; nida_keystrokes says how to type Khmer on the NiDA layout.`;
var RULE_DESCRIPTIONS = {
	spelling: "A run of Khmer letters that neither the Khmer dictionary nor the custom dictionary knows. A run of dictionary words written without breaks is correct. Replacements: the dictionary suggestions (sometimes none); for a longer run, unknownParts names the part the dictionary does not know.",
	"word-separator": "A visible space (or other whitespace, ZWNJ included) between two Khmer letters. Replacement: a zero-width space. Opt-in: Khmer prose separates phrases with visible spaces, so only text that marks every word break with a zero-width space should use it.",
	"repeated-zero-width": "Two or more zero-width characters (ZWSP, ZWNJ, ZWJ) in a row. Replacement: the first of them."
};
var RULE_SEVERITIES = {
	spelling: "warning",
	"word-separator": "information",
	"repeated-zero-width": "warning"
};
function describeLintRules() {
	return KHMER_LINT_RULES.map((rule) => ({
		rule,
		default: KHMER_LINT_DEFAULT_RULES.includes(rule),
		severity: RULE_SEVERITIES[rule],
		description: RULE_DESCRIPTIONS[rule]
	}));
}
/** The `khmer-lint://guide` resource. */
var KHMER_TEXT_GUIDE = `# Khmer text, as these tools see it

## Word breaks
- Khmer is written without spaces between words. A word break is a zero-width space (U+200B, ZWSP): invisible, but it lets a line wrap between words and lets software find the words.
- A visible space separates phrases or clauses, not words.
- On the NiDA keyboard, the Space key types a zero-width space and Shift+Space a visible one.
- segment_khmer inserts zero-width spaces between the dictionary words of unspaced text; a stretch the dictionary does not know stays one piece.

## Spelling
- Spelling is checked per run: the Khmer letters between spaces, punctuation and zero-width breaks.
- A run that is several dictionary words written together is correct. A misspelled run gets the dictionary's suggestions (sometimes none) and, when it is several words long, the part the dictionary does not know (unknownParts) — that is where the mistake is.
- The dictionary is the Khmer (km_KH) Hunspell dictionary. Words it does not know — names, loanwords, new terms — go in the custom dictionary (add_custom_words); they are not mistakes.

## Zero-width characters
- ZWSP (U+200B) is the word break. ZWNJ (U+200C) and ZWJ (U+200D) control how neighbouring characters join when rendered: keep them unless asked otherwise.
- Two or more zero-width characters in a row are always a slip: one is enough (remove_zero_width, mode collapse).
- They are invisible: show_invisible_characters makes them visible (ZWSP ·, ZWNJ ⟨ZWNJ⟩, ZWJ ⟨ZWJ⟩, no-break space ⍽).

## Digits
- Khmer digits ០១២៣៤៥៦៧៨៩ stand for 0–9 one for one; convert_digits switches between them.
- Khmer digits belong in Khmer text. convert_digits to 'khmer' keeps the digits of Latin text as they are — a number whose nearest letter on its line is not Khmer: chords (Bm7), section names (Verse 1), Time 4/4, Tempo 70bpm — so a song or other markup survives. Pass all: true only when every digit should change.

## Keyboard
- NiDA is the standard Khmer keyboard layout. qwerty_to_khmer reads text typed while the US layout was active as the NiDA keys pressed (xjmEr → ខ្មែរ); khmer_to_qwerty is the reverse; nida_keystrokes lists the keys that type a text.

## Lint rules
${describeLintRules().map(({ rule, default: isDefault, description }) => `- \`${rule}\`${isDefault ? "" : " (opt-in)"}: ${description}`).join("\n")}
`;
//#endregion
//#region src/khmer-lint-mcp/prompts.ts
/**
* Prompt templates for the common Khmer text jobs. The ones about an existing
* text inline it (from `text`, or read from `path`); proofreading also inlines
* the current lint result.
*/
var MAX_INLINED_ISSUES = 60;
function userMessage(text) {
	return { messages: [{
		role: "user",
		content: {
			type: "text",
			text
		}
	}] };
}
var textArgs = {
	text: z.string().optional().describe("The text."),
	path: z.string().optional().describe("Or a text file inside the allowed roots.")
};
async function describeTextArgument(context, args, { withLint = false } = {}) {
	let source;
	try {
		source = await readTextSource(context.files, args);
	} catch (error) {
		return args.path ? `The text should be read from ${args.path}, but reading it failed: ${errorMessage(error)}.` : "No text was given: ask for it.";
	}
	const parts = [
		source.path ? `Work on the text in ${source.path} (shown below; the tools take this path and change the file in place — pass dryRun to preview).` : "Work on the text below.",
		"",
		"```text",
		source.text,
		"```"
	];
	if (withLint) try {
		const { issues, truncated } = await lintText(context, source.text, { maxIssues: MAX_INLINED_ISSUES });
		const counts = countIssues(issues);
		parts.push("", issues.length ? `lint_khmer found ${issues.length}${truncated ? "+" : ""} issue(s) (${counts.spelling} spelling, ${counts.repeatedZeroWidth} repeated zero-width):` : "lint_khmer found no issues.", ...issues.map((issue) => {
			const reported = toReportedIssue(issue);
			return `- line ${reported.line}, column ${reported.column}: ${reported.message}${reported.replacements.length ? ` Replacements: ${reported.replacements.join(" | ")}` : ""}`;
		}));
	} catch (error) {
		parts.push("", `Linting failed: ${errorMessage(error)}.`);
	}
	return parts.join("\n");
}
function registerKhmerLintPrompts(context) {
	const { server } = context;
	server.registerPrompt("proofread_khmer", {
		title: "Proofread Khmer text",
		description: "Review the spelling and word breaks of a Khmer text and correct it.",
		argsSchema: textArgs
	}, async (args) => userMessage([
		await describeTextArgument(context, args, { withLint: true }),
		"",
		"Proofread the Khmer. For each possible misspelling, look at the part the dictionary does not know (unknownParts, for a longer run) and decide from context whether it is a real mistake or a name or new word the dictionary lacks — add those with add_custom_words rather than changing them. Use suggest_khmer for more candidates. Explain the corrections you make, apply them (edit the text, or fix_khmer with the rules you checked), and run lint_khmer again to confirm."
	].join("\n")));
	server.registerPrompt("add_word_breaks", {
		title: "Add Khmer word breaks",
		description: "Insert zero-width word breaks into unspaced Khmer so lines wrap between words.",
		argsSchema: textArgs
	}, async (args) => userMessage([
		await describeTextArgument(context, args),
		"",
		"Add zero-width word breaks (U+200B) between the Khmer words: run segment_khmer (dryRun first for a file), check its preview — breaks shown as · — for splits that look wrong in context, then collapse any doubled zero-width characters with remove_zero_width. Keep visible spaces between phrases. Report how many breaks were added."
	].join("\n")));
	server.registerPrompt("type_with_nida", {
		title: "How to type it on NiDA",
		description: "Explain the NiDA keystrokes that type a Khmer text.",
		argsSchema: { text: z.string().describe("The Khmer text.") }
	}, ({ text }) => userMessage([
		`Show how to type this on the Khmer NiDA keyboard: ${text}`,
		"",
		"Use nida_keystrokes and present the keys syllable by syllable (Alt is Option on a Mac). Point out keys that type several characters at once, and that the Space key types an invisible word break while Shift+Space types a visible space."
	].join("\n")));
	server.registerPrompt("recover_wrong_layout", {
		title: "Recover text typed in the wrong layout",
		description: "Turn Latin gibberish typed while the US layout was active back into Khmer, or the reverse.",
		argsSchema: { text: z.string().describe("The garbled text.") }
	}, ({ text }) => userMessage([
		`This was typed with the wrong keyboard layout active: ${text}`,
		"",
		"If it is Latin gibberish, convert it with qwerty_to_khmer; if it is Khmer that should have been Latin, use khmer_to_qwerty. Check the result with lint_khmer (Khmer) or by reading it, and give the recovered text."
	].join("\n")));
}
//#endregion
//#region src/khmer-lint-mcp/tools/keyboard.ts
var MAX_KEYSTROKES = 2e3;
var LAYERS = [
	"base",
	"shift",
	"alt",
	"altShift"
];
var layerSchema = z.enum([
	"base",
	"shift",
	"alt",
	"altShift"
]);
/** The NiDA layout as rows a reader can scan: one per key. */
function describeNidaLayout(layers = LAYERS) {
	return Array.from(new Set(layers.flatMap((layer) => Object.keys(KHMER_KEY_LAYOUTS[layer])))).map((code) => ({
		code,
		qwerty: US_QWERTY_LAYOUT[code]?.[0] ?? null,
		...Object.fromEntries(layers.map((layer) => [layer, KHMER_KEY_LAYOUTS[layer][code] ?? null]))
	}));
}
function registerKeyboardTools({ server }) {
	server.registerTool("qwerty_to_khmer", {
		title: "Read US keystrokes as NiDA Khmer",
		description: "Recover Khmer typed with the wrong keyboard layout active: each character is read as the US-QWERTY key that typed it and replaced by what that key types on the Khmer NiDA layout (Shift included; a space becomes NiDA's word break, U+200B). Characters no US key types are kept. Example: 'xjmEr' → 'ខ្មែរ'.",
		inputSchema: { text: z.string().max(1e5) },
		outputSchema: { text: z.string() },
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ text }) => runTool(async () => {
		const result = convertQwertyToKhmer(text);
		return structuredResult({ text: result }, result);
	}));
	server.registerTool("khmer_to_qwerty", {
		title: "Write Khmer as US keystrokes",
		description: "The US-QWERTY characters that type a Khmer text on the NiDA layout — the reverse of qwerty_to_khmer, for text typed with the Khmer layout active by mistake. Characters needing Alt, and characters with no NiDA key, are kept as they are; `untypeable` lists them.",
		inputSchema: { text: z.string().max(1e5) },
		outputSchema: {
			text: z.string(),
			untypeable: z.array(z.string()).describe("Pieces kept because no plain or Shift key types them.")
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ text }) => runTool(async () => {
		const result = convertKhmerToQwerty(text);
		const untypeable = getNidaKeystrokes(text).filter((stroke) => stroke.code === null || stroke.qwerty === void 0).map((stroke) => stroke.text).filter((piece) => /\S/u.test(piece));
		return structuredResult({
			text: result,
			untypeable: Array.from(new Set(untypeable))
		}, result);
	}));
	server.registerTool("nida_keystrokes", {
		title: "How to type Khmer on NiDA",
		description: "The keystrokes that type a Khmer text on the NiDA keyboard, in order: each with its key label (K, Shift+K, Alt+1 — Alt is Option on a Mac), its KeyboardEvent.code and layer, and the US character on the same key. Keys that type several characters at once are preferred. Text no key types is listed with code null.",
		inputSchema: { text: z.string().max(2e4) },
		outputSchema: {
			keystrokes: z.array(z.object({
				text: z.string(),
				label: z.string().nullable(),
				code: z.string().nullable(),
				layer: layerSchema.nullable(),
				qwerty: z.string().nullable()
			})),
			sequence: z.string().describe("The labels in order, space separated."),
			untypeableCount: z.number().int(),
			truncated: z.boolean()
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ text }) => runTool(async () => {
		const all = getNidaKeystrokes(text);
		const keystrokes = all.slice(0, MAX_KEYSTROKES).map((stroke) => stroke.code === null ? {
			text: stroke.text,
			label: null,
			code: null,
			layer: null,
			qwerty: null
		} : {
			text: stroke.text,
			label: stroke.label,
			code: stroke.code,
			layer: stroke.layer,
			qwerty: stroke.qwerty ?? null
		});
		const sequence = keystrokes.map((stroke) => stroke.label ?? `[${stroke.text}]`).join(" ");
		return structuredResult({
			keystrokes,
			sequence,
			untypeableCount: keystrokes.filter((stroke) => stroke.code === null).length,
			truncated: all.length > keystrokes.length
		}, sequence);
	}));
	server.registerTool("get_nida_layout", {
		title: "The Khmer NiDA keyboard layout",
		description: "What every key types on the Khmer NiDA layout, per layer (base, shift, alt, altShift), with the US-QWERTY character on the same key.",
		inputSchema: { layers: z.array(layerSchema).optional().describe("Default: all four.") },
		outputSchema: { keys: z.array(z.object({
			code: z.string(),
			qwerty: z.string().nullable()
		}).catchall(z.string().nullable())) },
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ layers }) => runTool(async () => {
		const keys = describeNidaLayout(layers?.length ? layers : LAYERS);
		return structuredResult({ keys }, `${keys.length} keys.`);
	}));
}
//#endregion
//#region src/khmer-lint-mcp/resources.ts
/**
* Read-only reference material: how the tools treat Khmer text, the lint
* rules, the NiDA layout, and the custom dictionary.
*/
function jsonContents(uri, value) {
	return { contents: [{
		uri: uri.href,
		mimeType: "application/json",
		text: `${JSON.stringify(value, null, 2)}\n`
	}] };
}
function registerKhmerLintResources(server, customWords) {
	server.registerResource("guide", "khmer-lint://guide", {
		title: "Khmer text conventions",
		description: "Word breaks (zero-width spaces), how spelling is checked, zero-width characters, digits, the NiDA keyboard, and the lint rules.",
		mimeType: "text/markdown"
	}, (uri) => ({ contents: [{
		uri: uri.href,
		mimeType: "text/markdown",
		text: KHMER_TEXT_GUIDE
	}] }));
	server.registerResource("lint-rules", "khmer-lint://rules", {
		title: "Lint rules",
		description: "Each lint rule: what it flags, its severity, whether it runs by default.",
		mimeType: "application/json"
	}, (uri) => jsonContents(uri, describeLintRules()));
	server.registerResource("nida-layout", "khmer-lint://keyboard/nida", {
		title: "Khmer NiDA keyboard layout",
		description: "What each key types in each layer (base, shift, alt, altShift), with the US-QWERTY character on the same key.",
		mimeType: "application/json"
	}, (uri) => jsonContents(uri, describeNidaLayout()));
	server.registerResource("custom-words", "khmer-lint://custom-words", {
		title: "Custom dictionary",
		description: "Words every spellcheck accepts, one per line.",
		mimeType: "text/plain"
	}, async (uri) => ({ contents: [{
		uri: uri.href,
		mimeType: "text/plain",
		text: `${(await customWords.list()).join("\n")}\n`
	}] }));
}
//#endregion
//#region src/khmer-lint-mcp/schemas.ts
var ruleSchema = z.enum(KHMER_LINT_RULES);
/** Text tools take the text itself or a file. */
var textSourceShape = {
	text: z.string().optional().describe("The text itself."),
	path: z.string().optional().describe("A UTF-8 text file inside the allowed roots (instead of text).")
};
var editShape = {
	...textSourceShape,
	dryRun: z.boolean().optional().describe("With path: return the new text without writing the file.")
};
var customWordsParam = z.array(z.string()).max(1e3).optional().describe("Extra words to accept for this call (the custom dictionary always applies).");
var issueSchema = z.object({
	rule: ruleSchema,
	severity: z.enum(["warning", "information"]),
	message: z.string(),
	line: z.number().int().describe("1-based."),
	column: z.number().int().describe("1-based, in UTF-16 code units."),
	endColumn: z.number().int().describe("1-based, exclusive."),
	text: z.string().describe("The text the issue covers."),
	replacements: z.array(z.string()).describe("Replacements for text, best first."),
	unknownParts: z.array(z.string()).optional().describe("Spelling: the parts of a run of several words that the dictionary does not know.")
});
var issueCountsSchema = z.object({
	spelling: z.number().int(),
	wordSeparator: z.number().int(),
	repeatedZeroWidth: z.number().int()
});
/** What an edit tool returns. */
var editOutputShape = {
	text: z.string().optional().describe("The new text (text input, dry run, read-only)."),
	path: z.string().optional(),
	written: z.boolean(),
	note: z.string().optional()
};
//#endregion
//#region src/khmer-lint-mcp/tools/lint.ts
/** What fix_khmer applies unless told otherwise: the one fix that is always safe. */
var DEFAULT_FIX_RULES = ["repeated-zero-width"];
var RULES_HELP = "Rules: 'spelling' — runs neither the Khmer dictionary nor the custom dictionary knows (a run of dictionary words written without breaks is fine; unknownParts names the part of a longer run that is not); 'repeated-zero-width' — two or more zero-width characters in a row; 'word-separator' (opt-in) — a visible space between Khmer letters, for text that marks every word break with a zero-width space (U+200B): Khmer prose puts visible spaces between phrases, so leave it off there.";
function summarizeCounts(counts) {
	const parts = [
		counts.spelling && `${counts.spelling} possible misspelling(s)`,
		counts.wordSeparator && `${counts.wordSeparator} visible space(s) between Khmer words`,
		counts.repeatedZeroWidth && `${counts.repeatedZeroWidth} run(s) of repeated zero-width characters`
	].filter(Boolean);
	return parts.length ? parts.join(", ") : "No issues";
}
function registerLintTools(context) {
	const { server, files } = context;
	server.registerTool("lint_khmer", {
		title: "Lint Khmer text",
		description: `Check the Khmer in a text or file. Each issue has 1-based line/columns and replacements, best first — for a misspelling, the dictionary's suggestions (sometimes none). Only Khmer is checked. ${RULES_HELP}`,
		inputSchema: {
			...textSourceShape,
			rules: z.array(ruleSchema).optional().describe(`Default: ${KHMER_LINT_DEFAULT_RULES.join(", ")}.`),
			maxSuggestions: z.number().int().min(0).max(10).optional().describe("Replacements per misspelling; 0 for none (faster). Default 3."),
			maxIssues: z.number().int().min(1).max(5e3).optional().describe("Default 500."),
			customWords: customWordsParam
		},
		outputSchema: {
			path: z.string().optional(),
			issueCount: z.number().int(),
			counts: issueCountsSchema,
			truncated: z.boolean(),
			issues: z.array(issueSchema)
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ text, path, rules, maxSuggestions, maxIssues, customWords }) => runTool(async () => {
		const source = await readTextSource(files, {
			text,
			path
		});
		const { issues, truncated } = await lintText(context, source.text, {
			rules,
			maxSuggestions,
			maxIssues,
			customWords
		});
		const counts = countIssues(issues);
		return structuredResult({
			...source.path ? { path: source.path } : {},
			issueCount: issues.length,
			counts,
			truncated,
			issues: issues.map(toReportedIssue)
		}, `${summarizeCounts(counts)}${truncated ? " (more not shown)" : ""}.`);
	}));
	server.registerTool("fix_khmer", {
		title: "Fix Khmer text",
		description: `Apply lint fixes. By default only 'repeated-zero-width' (each run collapses to its first character). 'word-separator' turns visible spaces between Khmer letters into zero-width word breaks — only for text that marks word breaks that way. 'spelling' replaces each misspelling that has a suggestion with the top one, and leaves the rest: review them first with lint_khmer. With path the file is fixed in place (dryRun to preview).`,
		inputSchema: {
			...editShape,
			rules: z.array(ruleSchema).optional().describe("Default: ['repeated-zero-width']."),
			customWords: customWordsParam
		},
		outputSchema: {
			...editOutputShape,
			applied: z.number().int(),
			counts: issueCountsSchema.describe("What was fixed, by rule.")
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, ({ text, path, dryRun, rules = DEFAULT_FIX_RULES, customWords }) => runTool(async () => {
		const source = await readTextSource(files, {
			text,
			path
		});
		const { issues } = await lintText(context, source.text, {
			rules,
			maxIssues: 1e5,
			maxSuggestions: rules.includes("spelling") ? 3 : 0,
			customWords
		});
		const fixable = issues.filter((issue) => issue.replacements.length);
		const fixed = applyKhmerLintFixes(source.text, fixable);
		return finishTextEdit(files, source, fixed.text, {
			applied: fixed.applied,
			counts: countIssues(fixable)
		}, {
			dryRun,
			summary: `Applied ${fixed.applied} fix(es).`
		});
	}));
	server.registerTool("lint_khmer_files", {
		title: "Lint Khmer files",
		description: "Lint every text file under the allowed roots (or one folder inside them): issue counts per file, worst first. Skips dot-folders, node_modules and dist, and files over 5 MB. Use lint_khmer on a file for the issues themselves.",
		inputSchema: {
			directory: z.string().optional().describe("A folder inside the roots. Default: every root."),
			extensions: z.array(z.string().regex(/^\.[\w.-]+$/)).optional().describe(`File extensions to read. Default: ${DEFAULT_LINT_EXTENSIONS.join(" ")}.`),
			recursive: z.boolean().optional().describe("Default true."),
			rules: z.array(ruleSchema).optional(),
			maxFiles: z.number().int().min(1).max(1e3).optional().describe("Default 200.")
		},
		outputSchema: {
			roots: z.array(z.string()),
			fileCount: z.number().int(),
			totalIssues: z.number().int(),
			truncated: z.boolean(),
			files: z.array(z.object({
				path: z.string(),
				issueCount: z.number().int(),
				counts: issueCountsSchema,
				error: z.string().optional()
			}))
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ directory, extensions, recursive, rules, maxFiles = 200 }) => runTool(async () => {
		const roots = await files.getRoots();
		const listing = await files.listFiles({
			directory,
			recursive,
			extensions: extensions?.length ? extensions : DEFAULT_LINT_EXTENSIONS,
			limit: maxFiles
		});
		const results = [];
		for (const file of listing.files) try {
			const { issues } = await lintText(context, (await readTextSource(files, { path: file })).text, {
				rules,
				maxSuggestions: 0,
				maxIssues: 1e5
			});
			results.push({
				path: file,
				issueCount: issues.length,
				counts: countIssues(issues)
			});
		} catch (error) {
			results.push({
				path: file,
				issueCount: 0,
				counts: countIssues([]),
				error: error instanceof Error ? error.message : String(error)
			});
		}
		results.sort((left, right) => right.issueCount - left.issueCount || left.path.localeCompare(right.path));
		const totalIssues = results.reduce((sum, file) => sum + file.issueCount, 0);
		return structuredResult({
			roots,
			fileCount: results.length,
			totalIssues,
			truncated: listing.truncated,
			files: results
		}, `${totalIssues} issue(s) in ${results.filter((file) => file.issueCount).length} of ${results.length} file(s)${listing.truncated ? " (more files not read)" : ""}. Files over ${MAX_TEXT_FILE_BYTES / 1024 / 1024} MB are skipped.`);
	}));
}
//#endregion
//#region src/khmer-lint-mcp/text-display.ts
var DEFAULT_INVISIBLE_MARKERS = {
	zwsp: "·",
	zwnj: "⟨ZWNJ⟩",
	zwj: "⟨ZWJ⟩",
	nbsp: "⍽"
};
function showInvisibles(text, markers = {}) {
	const { zwsp, zwnj, zwj, nbsp } = {
		...DEFAULT_INVISIBLE_MARKERS,
		...markers
	};
	return text.replace(/​/g, zwsp).replace(/‌/g, zwnj).replace(/‍/g, zwj).replace(/[  ]/g, nbsp);
}
var ZERO_WIDTH_NAMES = {
	"​": "ZWSP",
	"‌": "ZWNJ",
	"‍": "ZWJ"
};
//#endregion
//#region src/khmer-lint-mcp/tools/spelling.ts
var wordList = z.array(z.string().min(1).max(200)).min(1).max(500);
function isKhmerWord(word) {
	return KHMER_BASE_LETTER_RE.test(normalizeKhmerWord(word));
}
function registerSpellingTools(context) {
	const { server, files, customWords } = context;
	server.registerTool("check_khmer_words", {
		title: "Check Khmer words",
		description: "Spellcheck single words against the Khmer dictionary and the custom dictionary. A run of dictionary words written without breaks counts as correct. Words with no Khmer letter are not checked (reported correct, khmer: false).",
		inputSchema: { words: wordList },
		outputSchema: {
			results: z.array(z.object({
				word: z.string(),
				correct: z.boolean(),
				khmer: z.boolean(),
				custom: z.boolean().describe("Accepted through the custom dictionary.")
			})),
			misspelledCount: z.number().int()
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ words }) => runTool(async () => {
		const linter = await context.getLinter();
		const custom = new Set(await customWords.list());
		const unique = Array.from(new Set(words));
		const checked = await linter.engine.checkWords(unique.filter((word) => !custom.has(normalizeKhmerWord(word))));
		const results = words.map((word) => {
			const isCustom = custom.has(normalizeKhmerWord(word));
			return {
				word,
				correct: isCustom || checked[word] !== false,
				khmer: isKhmerWord(word),
				custom: isCustom
			};
		});
		const misspelled = results.filter((result) => !result.correct);
		return structuredResult({
			results,
			misspelledCount: misspelled.length
		}, misspelled.length ? `Possibly misspelled: ${misspelled.map(({ word }) => word).join(", ")}.` : "Every word is spelled correctly.");
	}));
	server.registerTool("suggest_khmer", {
		title: "Suggest Khmer spellings",
		description: "Spelling suggestions for one Khmer word or unspaced run, and its parts: the run split at the dictionary words it contains, each marked known or not — for a misspelled run, the unknown parts are where the mistake is. A correct run gets no suggestions.",
		inputSchema: {
			word: z.string().min(1).max(200),
			limit: z.number().int().min(1).max(10).optional().describe("Default 5.")
		},
		outputSchema: {
			word: z.string(),
			correct: z.boolean(),
			parts: z.array(z.object({
				text: z.string(),
				known: z.boolean()
			})).describe("The run split at its dictionary words; one part when it does not split."),
			suggestions: z.array(z.string())
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ word, limit = 5 }) => runTool(async () => {
		const linter = await context.getLinter();
		const custom = new Set(await customWords.list());
		const normalized = normalizeKhmerWord(word.trim());
		const segmentation = await linter.engine.segmentWord(normalized);
		const pieces = segmentation ? segmentation.split(ZERO_WIDTH_SPACE) : [normalized];
		const checked = await linter.engine.checkWords(Array.from(/* @__PURE__ */ new Set([normalized, ...pieces])).filter((piece) => !custom.has(piece)));
		const isKnown = (piece) => custom.has(piece) || checked[piece] !== false;
		const correct = isKnown(normalized);
		const parts = pieces.map((piece) => ({
			text: piece,
			known: isKnown(piece)
		}));
		const suggestions = correct ? [] : await linter.engine.suggestWord(normalized, limit);
		const unknown = parts.filter((part) => !part.known).map((part) => part.text);
		return structuredResult({
			word: normalized,
			correct,
			parts,
			suggestions
		}, correct ? `"${normalized}" is spelled correctly${parts.length > 1 ? ` (${parts.map((part) => part.text).join(" + ")})` : ""}.` : [parts.length > 1 && unknown.length ? `Not in the dictionary: ${unknown.join(", ")}` : `"${normalized}" is not in the dictionary`, suggestions.length ? `Suggestions: ${suggestions.join(", ")}` : "No suggestions"].join(". ") + ".");
	}));
	server.registerTool("segment_khmer", {
		title: "Segment Khmer text",
		description: "Insert zero-width word breaks (U+200B) into unspaced Khmer: each run is split at the dictionary words it contains; a stretch the dictionary does not know stays one piece, with breaks around it. A run that is a single word is left alone. Breaks are invisible: `preview` shows them as visibleSeparator. With path the file is changed in place (dryRun to preview).",
		inputSchema: {
			...editShape,
			visibleSeparator: z.string().max(5).optional().describe("How preview shows each break. Default '·'.")
		},
		outputSchema: {
			...editOutputShape,
			preview: z.string().describe("The segmented text with breaks made visible."),
			breaksAdded: z.number().int()
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, ({ text, path, dryRun, visibleSeparator = "·" }) => runTool(async () => {
		const source = await readTextSource(files, {
			text,
			path
		});
		const segmented = await (await context.getLinter()).segmentText(source.text);
		const count = (value) => value.split("​").length - 1;
		const breaksAdded = count(segmented) - count(source.text);
		return finishTextEdit(files, source, segmented, {
			preview: showInvisibles(segmented, { zwsp: visibleSeparator }),
			breaksAdded
		}, {
			dryRun,
			summary: `Added ${breaksAdded} word break(s).`
		});
	}));
	server.registerTool("list_custom_words", {
		title: "List custom dictionary words",
		description: "The custom dictionary: words every spellcheck accepts whatever the Khmer dictionary says.",
		inputSchema: {},
		outputSchema: {
			words: z.array(z.string()),
			file: z.string().nullable().describe("Where they are saved; null: this session only."),
			persistent: z.boolean()
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, () => runTool(async () => {
		const words = await customWords.list();
		return structuredResult({
			words,
			file: customWords.file,
			persistent: customWords.persistent
		}, `${words.length} custom word(s)${customWords.persistent ? ` in ${customWords.file}` : " (this session only)"}.`);
	}));
	server.registerTool("add_custom_words", {
		title: "Add words to the custom dictionary",
		description: "Accept words the Khmer dictionary does not know (names, loanwords, new terms) in every later check. Saved to the custom-words file when the server has one and is not read-only; otherwise kept for this session. Each word must contain a Khmer letter and no whitespace.",
		inputSchema: { words: wordList },
		outputSchema: {
			added: z.array(z.string()),
			rejected: z.array(z.string()),
			saved: z.boolean(),
			file: z.string().nullable()
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		}
	}, ({ words }) => runTool(async () => {
		const result = await customWords.add(words);
		return structuredResult({
			...result,
			file: customWords.file
		}, [
			`Added ${result.added.length} word(s)`,
			result.saved ? ` to ${customWords.file}` : " for this session",
			result.rejected.length ? `; rejected ${result.rejected.length} (no Khmer letter, whitespace, or too long)` : "",
			"."
		].join(""));
	}));
	server.registerTool("remove_custom_words", {
		title: "Remove words from the custom dictionary",
		description: "Stop accepting words added to the custom dictionary.",
		inputSchema: { words: wordList },
		outputSchema: {
			removed: z.array(z.string()),
			saved: z.boolean(),
			file: z.string().nullable()
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, ({ words }) => runTool(async () => {
		const result = await customWords.remove(words);
		return structuredResult({
			...result,
			file: customWords.file
		}, `Removed ${result.removed.length} word(s)${result.saved ? ` from ${customWords.file}` : ""}.`);
	}));
}
//#endregion
//#region src/khmer-lint-mcp/tools/text.ts
var MAX_REPORTED_RUNS = 500;
function registerTextTools(context) {
	const { server, files } = context;
	server.registerTool("show_invisible_characters", {
		title: "Show invisible characters",
		description: "Reveal the zero-width characters in a text — ZWSP (U+200B, Khmer's word break), ZWNJ (U+200C), ZWJ (U+200D) — and no-break spaces: counts, where each run is (1-based line/column), and a preview with them made visible (ZWSP ·, ZWNJ ⟨ZWNJ⟩, ZWJ ⟨ZWJ⟩, no-break space ⍽).",
		inputSchema: {
			...textSourceShape,
			includePreview: z.boolean().optional().describe("Return the preview text. Default true.")
		},
		outputSchema: {
			path: z.string().optional(),
			counts: z.object({
				zwsp: z.number().int(),
				zwnj: z.number().int(),
				zwj: z.number().int(),
				noBreakSpace: z.number().int()
			}),
			runs: z.array(z.object({
				line: z.number().int(),
				column: z.number().int(),
				length: z.number().int(),
				characters: z.array(z.string()).describe("ZWSP, ZWNJ or ZWJ, in order.")
			})),
			truncated: z.boolean(),
			preview: z.string().optional()
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ text, path, includePreview = true }) => runTool(async () => {
		const source = await readTextSource(files, {
			text,
			path
		});
		const lines = source.text.split(/\r\n|\r|\n/);
		const found = findZeroWidthRuns(source.text);
		const runs = found.slice(0, MAX_REPORTED_RUNS).map(({ line, start, end }) => ({
			line: line + 1,
			column: start + 1,
			length: end - start,
			characters: Array.from(lines[line].slice(start, end)).map((character) => ZERO_WIDTH_NAMES[character] ?? character)
		}));
		const count = (pattern) => source.text.match(pattern)?.length ?? 0;
		const counts = {
			zwsp: count(/​/g),
			zwnj: count(/‌/g),
			zwj: count(/‍/g),
			noBreakSpace: count(/[  ]/g)
		};
		return structuredResult({
			...source.path ? { path: source.path } : {},
			counts,
			runs,
			truncated: found.length > runs.length,
			...includePreview ? { preview: showInvisibles(source.text) } : {}
		}, `${counts.zwsp} ZWSP, ${counts.zwnj} ZWNJ, ${counts.zwj} ZWJ, ${counts.noBreakSpace} no-break space(s).`);
	}));
	server.registerTool("remove_zero_width", {
		title: "Remove zero-width characters",
		description: "mode 'collapse' (default) turns each run of zero-width characters into its first — the editor's Format rule, safe for Khmer. mode 'remove' deletes every ZWSP/ZWNJ/ZWJ — this also removes Khmer's word breaks and can change how joined letters render, so use it only for text that must not carry them (search keys, identifiers). With path the file is changed in place (dryRun to preview).",
		inputSchema: {
			...editShape,
			mode: z.enum(["collapse", "remove"]).optional()
		},
		outputSchema: {
			...editOutputShape,
			removed: z.number().int().describe("Characters taken out.")
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, ({ text, path, dryRun, mode = "collapse" }) => runTool(async () => {
		const source = await readTextSource(files, {
			text,
			path
		});
		const result = mode === "remove" ? removeZeroWidthCharacters(source.text) : collapseZeroWidthRuns(source.text);
		const removed = source.text.length - result.length;
		return finishTextEdit(files, source, result, { removed }, {
			dryRun,
			summary: `Removed ${removed} zero-width character(s).`
		});
	}));
	server.registerTool("convert_digits", {
		title: "Convert digits",
		description: "Write numbers with Khmer digits (០១២៣៤៥៦៧៨៩) or Western ones (0–9). Only digits change. to 'khmer' leaves the digits of non-Khmer text alone — a number whose nearest letter on its line, before or after, is Latin (or any non-Khmer letter): Bm7, Verse 1, Time: 4/4, 70bpm — so markup such as an Open Lyric song's chords, section names and Config survives; `kept` counts them, and all: true converts them too. With path the file is changed in place (dryRun to preview).",
		inputSchema: {
			...editShape,
			to: z.enum(["khmer", "western"]),
			all: z.boolean().optional().describe("to 'khmer' only: convert every digit, the digits of Latin text included. Default false.")
		},
		outputSchema: {
			...editOutputShape,
			converted: z.number().int(),
			kept: z.number().int().optional().describe("to 'khmer': Western digits left as they are, because they belong to non-Khmer text.")
		},
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, ({ text, path, dryRun, to, all }) => runTool(async () => {
		const source = await readTextSource(files, {
			text,
			path
		});
		const result = to === "khmer" ? toKhmerDigits(source.text, { skipNonKhmerText: !all }) : toArabicDigits(source.text);
		let converted = 0;
		for (let index = 0; index < result.length; index += 1) if (result[index] !== source.text[index]) converted += 1;
		const kept = to === "khmer" ? (result.match(/[0-9]/g) ?? []).length : void 0;
		const summary = kept ? `Converted ${converted} digit(s); kept ${kept} in non-Khmer text.` : `Converted ${converted} digit(s).`;
		return finishTextEdit(files, source, result, kept === void 0 ? { converted } : {
			converted,
			kept
		}, {
			dryRun,
			summary
		});
	}));
	server.registerTool("list_khmer_words", {
		title: "List Khmer words",
		description: "The distinct runs of Khmer in a text with how often each occurs and where it first appears — a run is Khmer letters between spaces, punctuation or word breaks, so unspaced text gives long runs (segment_khmer splits them). With checkSpelling, each says whether it is spelled correctly.",
		inputSchema: {
			...textSourceShape,
			checkSpelling: z.boolean().optional().describe("Default false."),
			limit: z.number().int().min(1).max(5e3).optional().describe("Default 1000, most frequent first.")
		},
		outputSchema: {
			path: z.string().optional(),
			totalRuns: z.number().int(),
			distinctRuns: z.number().int(),
			truncated: z.boolean(),
			words: z.array(z.object({
				word: z.string(),
				count: z.number().int(),
				line: z.number().int().describe("1-based line of the first occurrence."),
				column: z.number().int(),
				correct: z.boolean().optional()
			}))
		},
		annotations: {
			readOnlyHint: true,
			openWorldHint: false
		}
	}, ({ text, path, checkSpelling = false, limit = 1e3 }) => runTool(async () => {
		const source = await readTextSource(files, {
			text,
			path
		});
		const occurrences = findKhmerWords(source.text);
		const byWord = /* @__PURE__ */ new Map();
		occurrences.forEach(({ word, line, start }) => {
			const entry = byWord.get(word);
			if (entry) entry.count += 1;
			else byWord.set(word, {
				word,
				count: 1,
				line: line + 1,
				column: start + 1
			});
		});
		const sorted = Array.from(byWord.values()).sort((left, right) => right.count - left.count || left.line - right.line || left.column - right.column);
		const listed = sorted.slice(0, limit);
		let words = listed;
		if (checkSpelling && listed.length) {
			const linter = await context.getLinter();
			const custom = new Set(await context.customWords.list());
			const checked = await linter.engine.checkWords(listed.map(({ word }) => word).filter((word) => !custom.has(word)));
			words = listed.map((entry) => ({
				...entry,
				correct: custom.has(entry.word) || checked[entry.word] !== false
			}));
		}
		return structuredResult({
			...source.path ? { path: source.path } : {},
			totalRuns: occurrences.length,
			distinctRuns: byWord.size,
			truncated: sorted.length > listed.length,
			words
		}, `${byWord.size} distinct Khmer run(s), ${occurrences.length} in all${checkSpelling ? `; ${words.filter((entry) => entry.correct === false).length} possibly misspelled` : ""}.`);
	}));
}
//#endregion
//#region src/khmer-lint-mcp/version.ts
/** The `khmer-lint-mcp` package version, reported as the server version. */
var KHMER_LINT_MCP_VERSION = "0.1.3";
//#endregion
//#region src/khmer-lint-mcp/server.ts
/**
* An MCP server for Khmer text: lint and fix, spellcheck and suggestions,
* segmentation, the custom dictionary, zero-width characters, digits and the
* NiDA keyboard. Connect it to a transport (`runStdioServer`,
* `runHttpServer`, or the SDK's own).
*/
function createKhmerLintMcpServer(options = {}) {
	const readOnly = Boolean(options.readOnly);
	const server = new McpServer({
		name: "khmer-lint",
		title: "Khmer Lint",
		version: KHMER_LINT_MCP_VERSION
	}, { instructions: KHMER_LINT_MCP_INSTRUCTIONS });
	const files = new FileAccess({
		configuredRoots: options.roots ?? [],
		readOnly,
		cwd: options.cwd,
		listClientRoots: options.listClientRoots ?? createClientRootsLister(server)
	});
	const customWords = options.customWordStore ?? new CustomWords({
		file: options.customWordsFile ? path.resolve(options.cwd ?? process.cwd(), options.customWordsFile) : null,
		words: options.customWords ?? [],
		readOnly
	});
	const context = {
		server,
		files,
		customWords,
		readOnly,
		getLinter: options.getLinter ?? createLazyLinter(options.dictionaryDir)
	};
	registerLintTools(context);
	registerSpellingTools(context);
	registerTextTools(context);
	registerKeyboardTools(context);
	registerKhmerLintResources(server, customWords);
	registerKhmerLintPrompts(context);
	return server;
}
//#endregion
//#region src/mcp-common/transports.ts
/**
* The two ways the Open Lyric MCP servers are reached: stdio (one client, the
* process that started the server — what `npx`-launched servers use) and
* Streamable HTTP (any number of clients on a port).
*
* The HTTP server is stateless: every POST gets a fresh `McpServer` and
* transport, so no session state is kept between requests. It listens on
* loopback by default and turns on the SDK's DNS-rebinding protection for
* loopback hosts.
*/
async function runStdioServer(server) {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"::1"
]);
function sendJsonRpcError(response, status, message, headers = {}) {
	if (response.headersSent) {
		response.end();
		return;
	}
	response.writeHead(status, {
		"Content-Type": "application/json",
		...headers
	});
	response.end(JSON.stringify({
		jsonrpc: "2.0",
		error: {
			code: -32e3,
			message
		},
		id: null
	}));
}
async function runHttpServer(createServer$1, { port = 3333, host = "127.0.0.1", path = "/mcp", log = () => {} } = {}) {
	const httpServer = createServer(async (request, response) => {
		if (new URL(request.url ?? "/", "http://localhost").pathname !== path) {
			sendJsonRpcError(response, 404, `Not found. The MCP endpoint is ${path}.`);
			return;
		}
		if (request.method !== "POST") {
			sendJsonRpcError(response, 405, "Method not allowed.", { Allow: "POST" });
			return;
		}
		const server = createServer$1();
		const address = httpServer.address();
		const boundPort = address && typeof address === "object" ? address.port : port;
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: void 0,
			...LOOPBACK_HOSTS.has(host) ? {
				enableDnsRebindingProtection: true,
				allowedHosts: [
					`127.0.0.1:${boundPort}`,
					`localhost:${boundPort}`,
					`[::1]:${boundPort}`
				]
			} : {}
		});
		response.on("close", () => {
			transport.close();
			server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(request, response);
		} catch (error) {
			log(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
			sendJsonRpcError(response, 500, "Internal server error.");
		}
	});
	await new Promise((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, host, () => {
			httpServer.off("error", reject);
			resolve();
		});
	});
	const address = httpServer.address();
	const boundPort = address && typeof address === "object" ? address.port : port;
	return {
		url: `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}${path}`,
		close: () => new Promise((resolve) => {
			httpServer.close(() => resolve());
			httpServer.closeAllConnections?.();
		})
	};
}
//#endregion
export { KHMER_LINT_MCP_INSTRUCTIONS as a, KHMER_LINT_MCP_VERSION as i, runStdioServer as n, createLazyLinter as o, createKhmerLintMcpServer as r, CustomWords as s, runHttpServer as t };

//# sourceMappingURL=transports-KxWGCYAm.js.map