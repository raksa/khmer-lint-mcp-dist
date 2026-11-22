#!/usr/bin/env node
import { i as KHMER_LINT_MCP_VERSION, n as runStdioServer, o as createLazyLinter, r as createKhmerLintMcpServer, s as CustomWords, t as runHttpServer } from "./chunks/transports-KxWGCYAm.js";
import path from "node:path";
import { format } from "node:util";
//#region src/mcp-common/console.ts
/**
* Keep stdout clean for the stdio transport.
*
* Over stdio, stdout *is* the JSON-RPC stream: a stray `console.log` from any
* module the server loads would land in the middle of a message and break the
* client's parser. `console.log` / `info` / `debug` are rerouted to stderr
* (where `warn` and `error` already go), which MCP clients show as the
* server's log. Call it once, before the transport starts.
*/
function routeConsoleToStderr() {
	const writeToStderr = (...args) => {
		process.stderr.write(`${format(...args)}\n`);
	};
	console.log = writeToStderr;
	console.info = writeToStderr;
	console.debug = writeToStderr;
}
//#endregion
//#region src/mcp-common/route-console.ts
/**
* Side-effect module: import it first in a server's CLI entry, before any
* module that might log while it loads, so stdout stays the JSON-RPC stream.
*/
routeConsoleToStderr();
//#endregion
//#region src/mcp-common/cli-args.ts
var CliArgError = class extends Error {};
function parseCliArgs(argv, spec) {
	const booleans = new Set(spec.booleans ?? []);
	const strings = new Set(spec.strings ?? []);
	const arrays = new Set(spec.arrays ?? []);
	const aliases = spec.aliases ?? {};
	const result = {
		positionals: [],
		booleans: {},
		strings: {},
		arrays: {}
	};
	let index = 0;
	const takeValue = (name, inlineValue) => {
		if (inlineValue !== void 0) return inlineValue;
		const next = argv[index + 1];
		if (next === void 0 || next.startsWith("-") && next !== "-") throw new CliArgError(`Option --${name} needs a value.`);
		index += 1;
		return next;
	};
	for (; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--") {
			result.positionals.push(...argv.slice(index + 1));
			break;
		}
		const longMatch = arg.match(/^--([^=]+)(?:=(.*))?$/);
		const shortMatch = longMatch ? null : arg.match(/^-([A-Za-z])$/);
		if (!longMatch && !shortMatch) {
			result.positionals.push(arg);
			continue;
		}
		const rawName = longMatch ? longMatch[1] : shortMatch[1];
		const name = aliases[rawName] ?? rawName;
		const inlineValue = longMatch ? longMatch[2] : void 0;
		if (booleans.has(name)) {
			if (inlineValue !== void 0 && !/^(?:true|false)$/i.test(inlineValue)) throw new CliArgError(`Option --${name} takes no value.`);
			result.booleans[name] = inlineValue === void 0 || /^true$/i.test(inlineValue);
		} else if (strings.has(name)) result.strings[name] = takeValue(name, inlineValue);
		else if (arrays.has(name)) (result.arrays[name] ??= []).push(takeValue(name, inlineValue));
		else throw new CliArgError(`Unknown option ${arg}.`);
	}
	return result;
}
/** A TCP port from a CLI/env string, or the fallback. */
function parsePort(value, fallback) {
	if (value === void 0 || value === "") return fallback;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliArgError(`Invalid port "${value}".`);
	return port;
}
/** Split a path-list environment variable (`a:b` on POSIX, `a;b` on Windows). */
function splitPathList(value) {
	if (!value) return [];
	return value.split(process.platform === "win32" ? ";" : ":").map((entry) => entry.trim()).filter(Boolean);
}
//#endregion
//#region src/khmer-lint-mcp/cli.ts
var HELP = `khmer-lint-mcp ${KHMER_LINT_MCP_VERSION}
An MCP server for Khmer text: lint and fix, spellcheck, segmentation, custom
dictionary, zero-width characters, digits and the NiDA keyboard.

Usage: khmer-lint-mcp [options]

Options:
  --http                  Serve Streamable HTTP (POST /mcp) instead of stdio
  --port <n>              HTTP port (default 3334; env KHMER_LINT_MCP_PORT)
  --host <host>           HTTP interface (default 127.0.0.1)
  --root <dir>            Allow file tools under <dir>; repeatable
                          (env KHMER_LINT_MCP_ROOTS, a path list)
  --read-only             Never write files (env KHMER_LINT_MCP_READ_ONLY=1)
  --custom-words <file>   Keep the custom dictionary in <file>, one word per
                          line (env KHMER_LINT_MCP_CUSTOM_WORDS)
  --dictionary-dir <dir>  Read km_KH.aff, km_KH.dic and km_KH-suggest.aff from
                          <dir> (env KHMER_LINT_MCP_DICTIONARY_DIR)
  -v, --version           Print the version
  -h, --help              Print this help

File tools use the roots the client announces plus --root; with neither, the
working directory.
`;
function isTruthy(value) {
	return /^(?:1|true|yes|on)$/i.test(String(value ?? "").trim());
}
function optionalPath(value) {
	const trimmed = String(value ?? "").trim();
	return trimmed ? path.resolve(trimmed) : void 0;
}
/** Run the `khmer-lint-mcp` command line. */
async function runKhmerLintMcpCli(argv = process.argv.slice(2), env = process.env) {
	let args;
	try {
		args = parseCliArgs(argv, {
			booleans: [
				"http",
				"read-only",
				"help",
				"version"
			],
			strings: [
				"port",
				"host",
				"custom-words",
				"dictionary-dir"
			],
			arrays: ["root"],
			aliases: {
				h: "help",
				v: "version"
			}
		});
		if (args.positionals.length) throw new CliArgError(`Unexpected argument "${args.positionals[0]}".`);
	} catch (error) {
		if (error instanceof CliArgError) {
			process.stderr.write(`khmer-lint-mcp: ${error.message}\n\n${HELP}`);
			process.exitCode = 2;
			return;
		}
		throw error;
	}
	if (args.booleans.help) {
		process.stdout.write(HELP);
		return;
	}
	if (args.booleans.version) {
		process.stdout.write(`${KHMER_LINT_MCP_VERSION}\n`);
		return;
	}
	const readOnly = Boolean(args.booleans["read-only"]) || isTruthy(env.KHMER_LINT_MCP_READ_ONLY);
	const getLinter = createLazyLinter(optionalPath(args.strings["dictionary-dir"] ?? env.KHMER_LINT_MCP_DICTIONARY_DIR));
	const customWordStore = new CustomWords({
		file: optionalPath(args.strings["custom-words"] ?? env.KHMER_LINT_MCP_CUSTOM_WORDS) ?? null,
		readOnly
	});
	const options = {
		roots: [...splitPathList(env.KHMER_LINT_MCP_ROOTS), ...args.arrays.root ?? []],
		readOnly,
		getLinter,
		customWordStore
	};
	if (args.booleans.http) {
		const running = await runHttpServer(() => createKhmerLintMcpServer(options), {
			port: parsePort(args.strings.port ?? env.KHMER_LINT_MCP_PORT, 3334),
			host: args.strings.host ?? "127.0.0.1",
			log: (message) => console.error(message)
		});
		const stop = () => {
			running.close().then(() => process.exit(0));
		};
		console.error(`khmer-lint-mcp ${KHMER_LINT_MCP_VERSION} listening on ${running.url}`);
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		return;
	}
	await runStdioServer(createKhmerLintMcpServer(options));
}
//#endregion
//#region packages/khmer-lint-mcp/src/cli.ts
/**
* The `khmer-lint-mcp` executable (`bin`). The build prepends the
* `#!/usr/bin/env node` line.
*/
runKhmerLintMcpCli().catch((error) => {
	process.stderr.write(`khmer-lint-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
});
//#endregion
export {};

//# sourceMappingURL=cli.js.map