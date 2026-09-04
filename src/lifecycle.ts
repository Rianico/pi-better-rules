// pi-better-rules lifecycle: activation tracking + prompt rendering.
// Spec §§3.1–3.2, 6. Glob matching lives in scanner.ts; this module takes an
// injected PathMatcher so scoped activation stays testable in isolation.

export type RuleTier = "system" | "general";
export type RuleScope = "global" | "project";

export interface LifecycleRule {
	readonly rel: string;
	readonly scope: RuleScope;
	readonly tier: RuleTier;
	readonly paths?: readonly string[];
	readonly summary: string;
	readonly text: string;
}

export interface ActiveRuleSet {
	readonly sys: readonly LifecycleRule[];
	readonly gen: readonly LifecycleRule[];
}

export type PathMatcher = (
	patterns: readonly string[],
	file: string,
) => boolean;

export const RULES_BEGIN = "<!-- pi-rules:begin -->";
export const RULES_END = "<!-- pi-rules:end -->";

const STRIP_PATTERN =
	/<!-- pi-rules:begin -->[\s\S]*?<!-- pi-rules:end -->\n?/g;

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

/** Split rules into active system/general sets; unscoped rules are always on. */
export function getActiveRules(
	rules: readonly LifecycleRule[],
	touched: ReadonlySet<string>,
	matches: PathMatcher,
): ActiveRuleSet {
	const sys: LifecycleRule[] = [];
	const gen: LifecycleRule[] = [];
	for (const rule of rules) {
		const active =
			rule.paths === undefined ||
			[...touched].some((file) => matches(rule.paths ?? [], file));
		if (!active) continue;
		if (rule.tier === "system") sys.push(rule);
		else gen.push(rule);
	}
	return { sys, gen };
}

function renderSections(active: ActiveRuleSet): string | undefined {
	const parts: string[] = [];
	if (active.sys.length > 0) {
		const body = active.sys
			.map((rule) => `### ${rule.rel} [${rule.scope}]\n${rule.text}`)
			.join("\n\n");
		parts.push(`## Rules: system tier (full)\n${body}`);
	}
	if (active.gen.length > 0) {
		const body = active.gen
			.map((rule) => `- ${rule.rel} [${rule.scope}] — ${rule.summary}`)
			.join("\n");
		parts.push(
			`## Rules: general tier (index — use the read tool for full text)\n${body}`,
		);
	}
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}

/** Per-prompt systemPrompt override for before_agent_start; undefined when idle. */
export function buildSystemPromptOverride(
	base: string,
	active: ActiveRuleSet,
): string | undefined {
	const sections = renderSections(active);
	if (sections === undefined) return undefined;
	if (base === "") return sections;
	return `${base}\n\n${sections}`;
}

/** Marker block for before_provider_request; undefined when no rules active. */
export function buildRulesBlock(active: ActiveRuleSet): string | undefined {
	const sections = renderSections(active);
	if (sections === undefined) return undefined;
	return `${RULES_BEGIN}\n${sections}\n${RULES_END}`;
}

/** Strip any existing marker block and rebuild; idempotent under retries. */
export function reconcileProviderSystemText(
	systemText: string,
	active: ActiveRuleSet,
): string {
	const stripped = systemText.replace(STRIP_PATTERN, "").trimEnd();
	const block = buildRulesBlock(active);
	if (block === undefined) return stripped;
	if (stripped === "") return block;
	return `${stripped}\n${block}`;
}

export interface ProviderPayload {
	readonly system?: unknown;
	readonly [key: string]: unknown;
}
/**
 * Reconcile the payload's string system field; pass through untouched when
 * no string system field exists (provider-specific location gap, spec §3.2).
 */
export function reconcileProviderPayload<T extends ProviderPayload>(
	payload: T,
	active: ActiveRuleSet,
): T {
	if (typeof payload.system !== "string") return payload;
	return {
		...payload,
		system: reconcileProviderSystemText(payload.system, active),
	};
}
