// pi-better-rules lifecycle: activation tracking + prompt rendering.
// Scope-only model (issue 14): no tier. Unscoped rules (paths absent) are
// always-on full content appended to the system prompt (like pi's appended
// system prompt). Scoped rules (paths present) are full content injected as
// visible session messages (display: true), cumulative inject-once.
// Glob matching lives in scanner.ts; this module takes an injected
// PathMatcher so scoped activation stays testable in isolation.

export type RuleScope = "global" | "project";

export interface LifecycleRule {
	readonly rel: string;
	readonly scope: RuleScope;
	readonly paths?: readonly string[];
	readonly summary: string;
	readonly text: string;
}

export type PathMatcher = (
	patterns: readonly string[],
	file: string,
) => boolean;

/** Custom message type for injected scoped rules. */

const ACTIVATION_TOOLS: readonly string[] = ["read", "edit", "write"];

/** Path bases tried per file: the repo-relative path plus its bare filename.
 * Bare `paths:` entries (e.g. `pyproject.toml`) match nested files via the basename. */
export function candidateBases(file: string): readonly string[] {
	const base = file.split("/").pop() ?? "";
	if (base === "" || base === file) return [file];
	return [file, base];
}

/** Multi-base match: a rule matches when any pattern hits any candidate base. */
export function matchFile(
	patterns: readonly string[],
	file: string,
	matches: PathMatcher,
): boolean {
	return findMatchingPattern(patterns, file, matches) !== undefined;
}

/** First `paths:` pattern hitting any candidate base of `file`, if any. */
export function findMatchingPattern(
	patterns: readonly string[],
	file: string,
	matches: PathMatcher,
): string | undefined {
	for (const pattern of patterns) {
		if (candidateBases(file).some((base) => matches([pattern], base))) {
			return pattern;
		}
	}
	return undefined;
}

/** What activated a rule: the touched file plus the `paths:` pattern that fired. */
export interface Activation {
	readonly file: string;
	readonly pattern: string;
}

/** First (file, pattern) activation for a scoped rule, if any. */
export function findActivation(
	rule: LifecycleRule,
	touched: ReadonlySet<string>,
	matches: PathMatcher,
): Activation | undefined {
	if (rule.paths === undefined) return undefined;
	for (const file of touched) {
		const pattern = findMatchingPattern(rule.paths, file, matches);
		if (pattern !== undefined) return { file, pattern };
	}
	return undefined;
}

/** Repo-relative file paths touched by a tool result (read/edit `path`,
 * write `filePath`/`path`; absolute paths are relativized against cwd).
 * Returns empty for untracked tools — bash output never activates rules. */
export function extractResultPaths(
	toolName: string,
	input: unknown,
	details: unknown,
	cwd = "",
): string[] {
	if (!ACTIVATION_TOOLS.includes(toolName)) return [];
	const found = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && value !== "")
			found.add(relativize(value, cwd));
	};
	const field = (holder: unknown, name: string): string | undefined => {
		if (typeof holder !== "object" || holder === null) return undefined;
		const value = (holder as Record<string, unknown>)[name];
		return typeof value === "string" ? value : undefined;
	};
	if (toolName === "read" || toolName === "edit") {
		add(field(details, "filePath"));
		add(field(input, "path"));
	} else if (toolName === "write") {
		add(field(input, "filePath") ?? field(input, "path"));
	}
	return [...found];
}

/** Strip the cwd prefix so repo-relative `paths:` match absolute tool paths.
 * Absolute paths outside cwd and already-relative paths pass through. */
export function relativize(path: string, cwd: string): string {
	if (cwd === "") return path;
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	if (path.startsWith(prefix)) return path.slice(prefix.length);
	return path;
}
/** Unscoped rules (no `paths:`) — always on. */
export function getUnscopedRules(
	rules: readonly LifecycleRule[],
): readonly LifecycleRule[] {
	return rules.filter((rule) => rule.paths === undefined);
}

/** Scoped rules whose `paths:` match any cumulatively touched file. */
export function getActiveScopedRules(
	rules: readonly LifecycleRule[],
	touched: ReadonlySet<string>,
	matches: PathMatcher,
): readonly LifecycleRule[] {
	return rules.filter(
		(rule) =>
			rule.paths !== undefined &&
			[...touched].some((file) => matchFile(rule.paths ?? [], file, matches)),
	);
}

/** Scoped-active rules not yet injected (cumulative inject-once). */
export function getNewScopedRules(
	activeScoped: readonly LifecycleRule[],
	injected: ReadonlySet<string>,
): readonly LifecycleRule[] {
	return activeScoped.filter((rule) => !injected.has(rule.rel));
}

/** Render one rule with its original body intact, split by a rel separator. */
function formatRuleSection(rule: LifecycleRule): string {
	return `--- ${rule.rel} [${rule.scope}] ---\n${rule.text}`;
}

function renderUnscoped(
	unscoped: readonly LifecycleRule[],
): string | undefined {
	if (unscoped.length === 0) return undefined;
	const body = unscoped.map((rule) => formatRuleSection(rule)).join("\n\n");
	return `## Rules (always-on)\n${body}`;
}

/**
 * Per-prompt systemPrompt override carrying unscoped full content (like pi's
 * appended system prompt); undefined when no unscoped rules exist.
 */
export function buildSystemPromptOverride(
	base: string,
	unscoped: readonly LifecycleRule[],
): string | undefined {
	const section = renderUnscoped(unscoped);
	if (section === undefined) return undefined;
	if (base === "") return section;
	return `${base}\n\n${section}`;
}

/** First touched file activating a scoped rule, if any (why-it-loaded). */
export function findActivatingFile(
	rule: LifecycleRule,
	touched: ReadonlySet<string>,
	matches: PathMatcher,
): string | undefined {
	return findActivation(rule, touched, matches)?.file;
}

/** One scoped section with its activating file (why-it-loaded). */
function formatScopedSection(
	rule: LifecycleRule,
	activatedBy?: ReadonlyMap<string, string>,
): string {
	const section = formatRuleSection(rule);
	const cause = activatedBy?.get(rule.rel);
	return cause === undefined
		? section
		: `${section}\n_Activated by \`${cause}\`._`;
}

/** Full-content body for newly activated scoped rules (next-turn message path). */
export function buildScopedMessageContent(
	rules: readonly LifecycleRule[],
	activatedBy?: ReadonlyMap<string, string>,
): string | undefined {
	if (rules.length === 0) return undefined;
	const body = rules
		.map((rule) => formatScopedSection(rule, activatedBy))
		.join("\n\n");
	return `## Rules (scoped — activated by touched files)\n${body}`;
}

/** Same-turn tool-result block appended to the triggering result's content
 * (pi-rules dynamic style): visible immediately, persisted in the transcript. */
export function buildScopedToolBlock(
	rules: readonly LifecycleRule[],
	target: string,
	activatedBy?: ReadonlyMap<string, string>,
): string | undefined {
	if (rules.length === 0) return undefined;
	const body = rules
		.map((rule) => formatScopedSection(rule, activatedBy))
		.join("\n\n");
	return `\n\n## Rules (scoped — matched for ${target})\n\n${body}`;
}
