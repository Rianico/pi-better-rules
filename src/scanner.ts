/**
 * Rule scanner — discovery + parsing + glob matching per spec §1, §2, §4.
 * Ported from `.scratch/rules-extension/prototype/pi-rules.ts` (logic reference):
 * fixes the prototype's over-budget fallback to literal matching per spec §4,
 * and sorts `rel` ascending within each scope (§1 GAP).
 *
 * Scope-only model (issue 14): no `tier`. `paths:` absent = unscoped
 * (always-on, full content appended to the system prompt); `paths:` present
 * = scoped (full content injected as a visible session message on activation).
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
	summary: string;
	text: string;
}

/** Walker depth cap (spec §1, §4): dirs deeper than this are not descended into. */
export const MAX_WALK_DEPTH = 5;
/** Whole-`paths:`-list budget (spec §4): expanded patterns per rule. */
export const MAX_PATTERNS = 1000;
/** Per-file hard-skip + whole-`paths:`-list byte budget (spec §4). */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

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
	void warn;
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
	return rule;
}

export interface ScanOptions {
	warn?: Warn;
	maxDepth?: number;
	maxFileBytes?: number;
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
	return { rules: [...found.values()], warnings };
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
		readonly scope: string;
		readonly paths?: readonly string[] | undefined;
	}[],
): string[] {
	return rules.map((rule) =>
		rule.paths === undefined
			? `- ${rule.rel} [${rule.scope}] — unscoped (always-on)`
			: `- ${rule.rel} [${rule.scope}] — scoped (${rule.paths.join(", ")})`,
	);
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
