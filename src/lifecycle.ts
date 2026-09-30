// pi-better-rules lifecycle: activation tracking + prompt rendering.
// Scope-only model (issue 14): no tier. Unscoped rules (paths absent) are
// always-on full content carried by the `user-rules` system-prompt section: pi
// wraps every non-preamble section as `<name>…</name>` and persists the result
// into the transcript's system message, so unscoped rules travel with the
// prompt (and with session exports) without ever becoming a terminal message.
// Scoped rules (paths present) are full content injected into the triggering
// tool result plus a settle-time custom_message hidden in the terminal
// (display: false) but still present in session exports.
// Glob matching lives in scanner.ts; this module takes an injected
// PathMatcher so scoped activation stays testable in isolation.

export type RuleScope = "global" | "project";

export interface LifecycleRule {
	readonly rel: string;
	readonly abs?: string; // full path for display (fallback to rel in tests)
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

/** Escape XML attribute values (paths/summaries stay on one line). */
export function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Gating scope for the `scope` attribute: unscoped (always-on) vs scoped. */
export function ruleScope(rule: LifecycleRule): "unscoped" | "scoped" {
	return rule.paths === undefined ? "unscoped" : "scoped";
}

/** Render one rule as a `<rule>` element with its original body intact. */
export function formatRuleXml(
	rule: LifecycleRule,
	activatedBy?: ReadonlyMap<string, string>,
): string {
	const cause = activatedBy?.get(rule.rel);
	const causeAttr =
		cause === undefined ? "" : ` activated-by="${escapeXmlAttr(cause)}"`;
	return `<rule path="${escapeXmlAttr(rule.abs ?? rule.rel)}" scope="${ruleScope(rule)}" summary="${escapeXmlAttr(rule.summary)}"${causeAttr}>${rule.text}</rule>`;
}

/** Render rules as a `<user-rules>` block. Fenced by callers whose render path
 * is markdown; raw when the block feeds the model directly. */
export function buildRulesXml(
	rules: readonly LifecycleRule[],
	activatedBy?: ReadonlyMap<string, string>,
): string {
	return `<user-rules>\n${rules.map((rule) => formatRuleXml(rule, activatedBy)).join("\n")}\n</user-rules>`;
}

/** System-prompt section name. pi wraps each non-preamble section in a tag of
 * the same name, so this renders as `<user-rules>…</user-rules>` — distinct from
 * pi's own `<rules>` section for built-in tool guidelines. */
export const RULES_SECTION_NAME = "user-rules";

/** Body for the `user-rules` system-prompt section: the `<rule>` children only,
 * because pi adds the wrapper. Undefined when there is nothing to carry. */
export function buildRulesSection(
	rules: readonly LifecycleRule[],
): string | undefined {
	if (rules.length === 0) return undefined;
	return rules.map((rule) => formatRuleXml(rule)).join("\n");
}

/** Wrap an XML block in a ```xml fence so export renderers (markdown)
 * show the tags literally instead of swallowing them as DOM elements. */
export function fenceXml(block: string): string {
	return `\`\`\`xml\n${block}\n\`\`\``;
}

/** First touched file activating a scoped rule, if any (why-it-loaded). */
export function findActivatingFile(
	rule: LifecycleRule,
	touched: ReadonlySet<string>,
	matches: PathMatcher,
): string | undefined {
	return findActivation(rule, touched, matches)?.file;
}

/** Fenced full-content body for newly activated scoped rules. Scoped rules
 * arrive mid-conversation as an ordinary message, so the content is fenced:
 * the terminal and the export both render markdown, which would otherwise
 * swallow raw tags as invisible DOM. */
export function buildScopedMessageContent(
	rules: readonly LifecycleRule[],
	activatedBy?: ReadonlyMap<string, string>,
): string | undefined {
	if (rules.length === 0) return undefined;
	return fenceXml(buildRulesXml(rules, activatedBy));
}
