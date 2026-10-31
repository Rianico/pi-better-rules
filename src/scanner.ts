/**
 * Rule scanner — discovery + parsing + glob matching per spec §1, §2, §4.
 * Ported from `.scratch/rules-extension/prototype/pi-rules.ts` (logic reference):
 * fixes the prototype's over-budget fallback to literal matching per spec §4,
 * and sorts `rel` ascending within each scope (§1 GAP).
 *
 * Scope-only model (issue 14): no `tier`. `paths:` absent = unscoped
 * (always-on, full content appended to the system prompt); `paths:` present
 * = scoped (full content injected as a visible session message on activation).
 * Harness scoping (`agents:`, issue 340) filters the effective set at load:
 * absent key = every harness, present allowlist = listed harnesses only.
 */
import type { Dirent } from "node:fs";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

export type RuleScope = "global" | "project";

export interface Rule {
	rel: string;
	abs: string;
	scope: RuleScope;
	paths?: string[] | undefined;
	/** Harness allowlist from `agents:`; absent = load in every harness. */
	agents?: string[] | undefined;
	summary: string;
	text: string;
}

/** Walker depth cap (spec §1, §4): dirs deeper than this are not descended into. */
export const MAX_WALK_DEPTH = 5;
/** Whole-`paths:`-list budget (spec §4): expanded patterns per rule. */
export const MAX_PATTERNS = 1000;
/** Per-file hard-skip + whole-`paths:`-list byte budget (spec §4). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Harness id matched against each rule's `agents:` allowlist. pi is the only
 * harness this extension runs under; a port overrides it through
 * `ScanOptions.agent` rather than hard-coding a second literal.
 */
export const HARNESS_ID = "pi";
export type Warn = (message: string) => void;

const noop: Warn = () => {};

function walkDir(
	dir: string,
	base: string,
	depth: number,
	seen: Set<string>,
	maxDepth: number,
	out: string[],
): void {
	if (depth > maxDepth || !existsSync(dir)) return;
	let real = dir;
	try {
		real = realpathSync(dir);
	} catch {
		return;
	}
	if (seen.has(real)) return;
	seen.add(real);
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const rel = base === "" ? entry.name : `${base}/${entry.name}`;
		const full = join(dir, entry.name);
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue; // dangling symlink — skipped silently (spec §1)
			}
		}
		if (isDir) {
			walkDir(full, rel, depth + 1, seen, maxDepth, out);
		} else if (entry.name.endsWith(".md")) {
			out.push(rel);
		}
	}
}

/** Recursively list `**\/*.md` rel paths under `dir`, sorted ascending. */
export function findMarkdownFiles(
	dir: string,
	maxDepth: number = MAX_WALK_DEPTH,
): string[] {
	const out: string[] = [];
	walkDir(dir, "", 0, new Set<string>(), maxDepth, out);
	out.sort();
	return out;
}

function parsePaths(frontmatter: string): string[] | undefined {
	const at = frontmatter.search(/^\s*paths\s*:/m);
	if (at < 0) return undefined;
	const tail = frontmatter.slice(at);
	const inline = /paths\s*:\s*\[([\s\S]*?)\]/.exec(tail);
	if (inline) {
		const items = (inline[1] ?? "")
			.split(",")
			.map((s) => s.trim().replace(/^["']|["']$/g, ""))
			.filter((s) => s !== "");
		return items.length > 0 ? items : undefined;
	}
	const items: string[] = [];
	for (const line of tail.split("\n").slice(1)) {
		const item = /^\s*-\s*(.+?)\s*$/.exec(line);
		if (item) {
			items.push((item[1] ?? "").replace(/^["']|["']$/g, ""));
		} else if (line.trim() !== "" && /^\S/.test(line)) {
			break; // next top-level key — end of the paths list
		}
	}
	return items.length > 0 ? items : undefined;
}

/** Result of reading the optional `agents:` allowlist: an unparsable value
 * reports `malformed` so the caller can warn and still load the rule. */
export interface AgentsKey {
	readonly agents: string[] | undefined;
	readonly malformed: boolean;
}

const NO_AGENTS: AgentsKey = { agents: undefined, malformed: false };

/** Trim, unquote, and lowercase one allowlist entry; "" means no id. */
function normalizeAgent(raw: string): string {
	return raw
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim()
		.toLowerCase();
}

/** Append a normalized id, dropping blanks and duplicates (first wins). */
function pushAgent(out: string[], raw: string): void {
	const id = normalizeAgent(raw);
	if (id !== "" && !out.includes(id)) out.push(id);
}

/**
 * Parse the optional `agents:` frontmatter allowlist (harness scoping).
 * One line: `agents: [pi, "claude"]`; block form: `agents:` then `- pi`
 * lines. Ids are trimmed, unquoted, lowercased, and de-duplicated.
 *
 * Absent key → `{ agents: undefined }` (load everywhere, today's default).
 * Explicit empty list → `[]`, which admits nobody.
 * A scalar (`agents: pi`), bare (`agents:`), or unclosed (`agents: [pi`)
 * value → `malformed`, so the caller loads everywhere and warns once instead
 * of silently hiding the rule.
 */
export function parseAgents(frontmatter: string): AgentsKey {
	const key = /^[ \t]*agents[ \t]*:/m.exec(frontmatter);
	if (key === null) return NO_AGENTS;
	const rest = frontmatter.slice(key.index + key[0].length);
	const eol = rest.indexOf("\n");
	const inlineValue = (eol < 0 ? rest : rest.slice(0, eol)).trim();
	if (inlineValue.startsWith("[")) {
		const open = rest.indexOf("[");
		const close = rest.indexOf("]", open + 1);
		if (close < 0) return { agents: undefined, malformed: true };
		const items: string[] = [];
		for (const part of rest.slice(open + 1, close).split(",")) {
			pushAgent(items, part);
		}
		return { agents: items, malformed: false };
	}
	if (inlineValue !== "") return { agents: undefined, malformed: true };
	const items: string[] = [];
	for (const line of rest.split("\n").slice(1)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const item = /^-\s*(.+)$/.exec(trimmed);
		if (item === null) break; // next top-level key — end of the list
		pushAgent(items, item[1] ?? "");
	}
	if (items.length === 0) return { agents: undefined, malformed: true };
	return { agents: items, malformed: false };
}

/**
 * Whether a parsed allowlist admits `agent`. An absent list (no key, or a
 * malformed key the parser refused) admits every harness.
 */
export function admitsAgent(
	agents: readonly string[] | undefined,
	agent: string = HARNESS_ID,
): boolean {
	if (agents === undefined) return true;
	const id = normalizeAgent(agent);
	return id !== "" && agents.includes(id);
}

export interface ParseOptions {
	maxFileBytes?: number;
}

/**
 * Parse one rule file. Returns null for oversize/unreadable files (hard-skip,
 * spec §4). A file with no frontmatter is a valid unscoped rule (§1).
 * A `metadata.rule_tier` key, if present, is ignored (tier retired, issue 14).
 */
export function parseRule(
	abs: string,
	rel: string,
	scope: RuleScope,
	warn: Warn = noop,
	opts: ParseOptions = {},
): Rule | null {
	const budget = opts.maxFileBytes ?? MAX_FILE_BYTES;
	try {
		if (statSync(abs).size > budget) return null;
	} catch {
		return null;
	}
	const raw = readFileSync(abs, "utf8");
	const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
	const body = fm ? raw.slice(fm[0].length) : raw;
	const paths = fm ? parsePaths(fm[1] ?? "") : undefined;
	const agents: AgentsKey = fm ? parseAgents(fm[1] ?? "") : NO_AGENTS;
	if (agents.malformed) {
		warn(
			`${rel}: malformed agents: frontmatter (expected a list of harness ids) — loading the rule everywhere`,
		);
	}
	const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
	const firstLine = body
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
	const summary =
		heading !== undefined && heading !== "" ? heading : (firstLine ?? rel);
	const rule: Rule = {
		rel,
		abs,
		scope,
		paths,
		summary,
		text: body.trim(),
	};
	if (agents.agents !== undefined) rule.agents = agents.agents;
	return rule;
}

export interface ScanOptions {
	warn?: Warn;
	maxDepth?: number;
	maxFileBytes?: number;
	/** Harness id matched against `agents:`; defaults to `HARNESS_ID`. */
	agent?: string;
}

export interface ScanResult {
	rules: Rule[];
	warnings: string[];
}

/**
 * Scan global then project trees and concatenate with project-wins shadowing:
 * an identical rel path replaces the global copy (no merge) and warns (§1).
 */
export function scanRules(
	globalDir: string,
	projectDir: string,
	opts: ScanOptions = {},
): ScanResult {
	const outerWarn = opts.warn ?? noop;
	const warnings: string[] = [];
	const warn: Warn = (message) => {
		warnings.push(message);
		outerWarn(message);
	};
	const maxDepth = opts.maxDepth ?? MAX_WALK_DEPTH;
	const parseOpts: ParseOptions =
		opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes };
	const agent = opts.agent ?? HARNESS_ID;
	const found = new Map<string, Rule>();
	const scopes = [
		[globalDir, "global"],
		[projectDir, "project"],
	] as const;
	for (const [dir, scope] of scopes) {
		for (const rel of findMarkdownFiles(dir, maxDepth)) {
			let rule: Rule | null;
			try {
				rule = parseRule(join(dir, rel), rel, scope, warn, parseOpts);
			} catch {
				continue; // unreadable file (e.g. raced deletion) — skip silently
			}
			if (rule === null) continue;
			if (scope === "project" && found.has(rel)) {
				warn(`${rel}: project shadows global copy`);
			}
			found.set(rel, rule);
		}
	}
	// Harness scoping applies to the effective set: when the project shadow
	// excludes the running harness the rel disappears entirely (project wins).
	const rules = [...found.values()].filter((rule) =>
		admitsAgent(rule.agents, agent),
	);
	return { rules, warnings };
}

/** Load report line emitted at info level after scan (spec §1). */
export function formatLoadReport(rules: readonly Rule[]): string {
	const unscoped = rules.filter((r) => r.paths === undefined).length;
	const scoped = rules.filter((r) => r.paths !== undefined).length;
	return `pi-rules: ${rules.length} rule(s) — ${unscoped} unscoped, ${scoped} scoped`;
}

/** Per-rule detail lines for load notifications (issue 15). */
export function formatRuleList(
	rules: readonly {
		readonly rel: string;
		readonly abs?: string;
		readonly scope: string;
		readonly paths?: readonly string[] | undefined;
	}[],
): string[] {
	return rules.map((rule) => {
		const displayPath = (rule as { abs?: string }).abs ?? rule.rel;
		return rule.paths === undefined
			? `- ${displayPath} [${rule.scope}] — unscoped (always-on)`
			: `- ${displayPath} [${rule.scope}] — scoped (${rule.paths.join(", ")})`;
	});
}

/** Expand the first `{a,b}` group recursively (Claude `paths:` semantics). */
export function expandBraces(pattern: string): string[] {
	const match = /\{([^{}]*)\}/.exec(pattern);
	if (!match) return [pattern];
	const index = match.index;
	const inner = match[0] ?? "";
	return (match[1] ?? "")
		.split(",")
		.flatMap((part) =>
			expandBraces(
				pattern.slice(0, index) + part + pattern.slice(index + inner.length),
			),
		);
}

/**
 * Claude `paths:` glob: `**` crosses separators, `*`/`?` stay in-segment,
 * `{a,b}` via expandBraces, `[...]` classes, `\\` escapes a literal.
 */
export function globToRegExp(pattern: string): RegExp {
	let re = "";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					re += "(.*/)?";
					i += 3;
				} else {
					re += ".*";
					i += 2;
				}
			} else {
				re += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			re += "[^/]";
			i += 1;
		} else if (c === "[") {
			const j = pattern.indexOf("]", i);
			if (j > i) {
				re += pattern.slice(i, j + 1);
				i = j + 1;
			} else {
				re += "\\[";
				i += 1;
			}
		} else if (c === "\\" && i + 1 < pattern.length) {
			re += `\\${pattern[i + 1] ?? ""}`;
			i += 2;
		} else if (c === undefined) {
			i += 1;
		} else {
			re += /[.+^${}()|]/.test(c) ? `\\${c}` : c;
			i += 1;
		}
	}
	return new RegExp(`^${re}$`);
}

export interface MatchOptions {
	maxPatterns?: number;
	maxBytes?: number;
}

/**
 * Test `file` against `patterns`. Over the expanded-pattern/byte budget warns
 * and falls back to literal matching for that rule (spec §4); an invalid
 * pattern matches nothing while siblings keep working (spec §2).
 */
export function matchesAny(
	patterns: string[],
	file: string,
	warn: Warn = noop,
	rel = "",
	opts: MatchOptions = {},
): boolean {
	const expanded = patterns.flatMap(expandBraces);
	const bytes = expanded.reduce(
		(n, p) => n + TextEncoderSingleton.encode(p).length,
		0,
	);
	const budget = opts.maxPatterns ?? MAX_PATTERNS;
	const byteBudget = opts.maxBytes ?? MAX_FILE_BYTES;
	if (expanded.length > budget || bytes > byteBudget) {
		warn(
			`${rel === "" ? "rule" : rel}: paths exceed ${budget}-pattern budget — matching literally`,
		);
		return patterns.includes(file);
	}
	return expanded.some((p) => {
		try {
			return globToRegExp(p).test(file);
		} catch {
			return false;
		}
	});
}

const TextEncoderSingleton = new TextEncoder();
