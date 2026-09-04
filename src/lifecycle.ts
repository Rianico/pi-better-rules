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
export const RULES_MESSAGE_TYPE = "pi-rules";

export interface ScopedMessage {
	readonly customType: typeof RULES_MESSAGE_TYPE;
	readonly content: string;
	readonly display: true;
}

const ACTIVATION_TOOLS: readonly string[] = ["read", "edit", "write"];

/** Record a tool call's file in the cumulative session touched set. */
export function trackToolCall(
	touched: Set<string>,
	toolName: string,
	input: unknown,
): boolean {
	if (!ACTIVATION_TOOLS.includes(toolName)) return false;
	if (typeof input !== "object" || input === null) return false;
	const candidate: unknown = (input as { path?: unknown }).path;
	if (typeof candidate !== "string") return false;
	touched.add(candidate);
	return true;
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
			[...touched].some((file) => matches(rule.paths ?? [], file)),
	);
}

/** Scoped-active rules not yet injected (cumulative inject-once). */
export function getNewScopedRules(
	activeScoped: readonly LifecycleRule[],
	injected: ReadonlySet<string>,
): readonly LifecycleRule[] {
	return activeScoped.filter((rule) => !injected.has(rule.rel));
}

function renderUnscoped(
	unscoped: readonly LifecycleRule[],
): string | undefined {
	if (unscoped.length === 0) return undefined;
	const body = unscoped
		.map((rule) => `### ${rule.rel} [${rule.scope}]\n${rule.text}`)
		.join("\n\n");
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
	if (rule.paths === undefined) return undefined;
	for (const file of touched) {
		if (matches(rule.paths, file)) return file;
	}
	return undefined;
}

/** Full-content body for a scoped message (one message per activation batch). */
export function buildScopedMessageContent(
	rules: readonly LifecycleRule[],
	activatedBy?: ReadonlyMap<string, string>,
): string | undefined {
	if (rules.length === 0) return undefined;
	const body = rules
		.map((rule) => {
			const section = `### ${rule.rel} [${rule.scope}]\n${rule.text}`;
			const cause = activatedBy?.get(rule.rel);
			return cause === undefined
				? section
				: `${section}\n_Activated by \`${cause}\`._`;
		})
		.join("\n\n");
	return `## Rules (scoped — activated by touched files)\n${body}`;
}

/** Visible session message for newly activated scoped rules. */
export function buildScopedMessage(
	rules: readonly LifecycleRule[],
	activatedBy?: ReadonlyMap<string, string>,
): ScopedMessage | undefined {
	const content = buildScopedMessageContent(rules, activatedBy);
	if (content === undefined) return undefined;
	return { customType: RULES_MESSAGE_TYPE, content, display: true };
}
