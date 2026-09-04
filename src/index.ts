// pi-better-rules — pi extension entry (spec §5, §6).
//
// Wires src/scanner.ts (discovery + matching), src/cache.ts (checksum
// persistence), and src/lifecycle.ts (activation + rendering) into the four
// §6 handlers. No compact handlers: the in-memory cache survives compaction
// untouched. Handler shapes follow the installed pi docs/extensions.md and
// examples/extensions/claude-rules.ts (default export taking ExtensionAPI,
// pi.on registration); the minimal structural types below mirror those
// reference shapes so this package needs no runtime dependency on pi.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheHooks, FileStat } from "./cache.js";
import { projectCachePath, refreshCache, verifyChecksums } from "./cache.js";
import type {
	ActiveRuleSet,
	LifecycleRule,
	PathMatcher,
	ProviderPayload,
} from "./lifecycle.js";
import {
	buildSystemPromptOverride,
	getActiveRules,
	reconcileProviderPayload,
	trackToolCall,
} from "./lifecycle.js";
import type { Rule, Warn } from "./scanner.js";
import {
	findMarkdownFiles,
	formatLoadReport,
	matchesAny,
	scanRules,
} from "./scanner.js";

export interface SessionStartEvent {
	readonly type: "session_start";
	readonly reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface ToolCallEvent {
	readonly type: "tool_call";
	readonly toolName: string;
	readonly input: unknown;
}

export interface BeforeAgentStartEvent {
	readonly type: "before_agent_start";
	readonly prompt: string;
	readonly systemPrompt: string;
}

export interface BeforeProviderRequestEvent {
	readonly type: "before_provider_request";
	readonly payload: unknown;
}

export interface ExtensionUI {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ExtensionContext {
	readonly cwd: string;
	readonly ui: ExtensionUI;
}

export interface ExtensionAPI {
	on(
		event: "session_start",
		handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown,
	): void;
	on(
		event: "tool_call",
		handler: (event: ToolCallEvent, ctx: ExtensionContext) => unknown,
	): void;
	on(
		event: "before_agent_start",
		handler: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => unknown,
	): void;
	on(
		event: "before_provider_request",
		handler: (
			event: BeforeProviderRequestEvent,
			ctx: ExtensionContext,
		) => unknown,
	): void;
}

interface EntryState {
	rules: LifecycleRule[];
	touched: Set<string>;
	checksumsPath: string;
}

/**
 * Adapt scanner output to the lifecycle model. A defined `paths` list is
 * copied (never shared); an absent list stays absent so the optional field
 * keeps its exact type under `exactOptionalPropertyTypes`.
 */
function toLifecycleRules(rules: Rule[]): LifecycleRule[] {
	return rules.map((rule) => {
		const base = {
			rel: rule.rel,
			scope: rule.scope,
			tier: rule.tier,
			summary: rule.summary,
			text: rule.text,
		};
		if (rule.paths === undefined) return base;
		return { ...base, paths: [...rule.paths] };
	});
}

/** Cache hooks over both rule trees: abs-path listing + read + stat. */
function buildCacheHooks(globalDir: string, projectDir: string): CacheHooks {
	return {
		listFiles: () => [
			...findMarkdownFiles(globalDir).map((rel) => join(globalDir, rel)),
			...findMarkdownFiles(projectDir).map((rel) => join(projectDir, rel)),
		],
		readFile: (absPath: string) => readFile(absPath, "utf8"),
		statFile: async (absPath: string): Promise<FileStat> => {
			const s = await stat(absPath);
			return { mtimeMs: s.mtimeMs, size: s.size };
		},
	};
}

/** Current active system/general sets from cached rules + touched files. */
function activeRules(state: EntryState, warn: Warn): ActiveRuleSet {
	const matches: PathMatcher = (patterns, file) =>
		matchesAny([...patterns], file, warn);
	return getActiveRules(state.rules, state.touched, matches);
}

export default function piBetterRules(pi: ExtensionAPI): void {
	const state: EntryState = {
		rules: [],
		touched: new Set<string>(),
		checksumsPath: "",
	};

	pi.on("session_start", async (event, ctx) => {
		const warn: Warn = (message) => {
			ctx.ui.notify(message, "warning");
		};
		const globalDir = join(homedir(), ".pi", "agent", "rules");
		const projectDir = join(ctx.cwd, ".pi", "rules");
		state.checksumsPath = projectCachePath(ctx.cwd);
		const hooks = buildCacheHooks(globalDir, projectDir);

		if (event.reason === "reload") {
			const verification = await verifyChecksums(
				state.checksumsPath,
				hooks,
				warn,
			);
			if (verification.unchanged) {
				ctx.ui.notify(
					`pi-rules: ${state.rules.length} rule(s) — unchanged`,
					"info",
				);
				return;
			}
			const scanned = scanRules(globalDir, projectDir, { warn }).rules;
			state.rules = toLifecycleRules(scanned);
			const report = await refreshCache(state.checksumsPath, hooks, warn);
			ctx.ui.notify(
				`pi-rules: refreshed ${report.refreshed.length}, added ${report.added.length}, removed ${report.removed.length}`,
				"info",
			);
			return;
		}

		const scanned = scanRules(globalDir, projectDir, { warn }).rules;
		state.rules = toLifecycleRules(scanned);
		await refreshCache(state.checksumsPath, hooks, warn);
		ctx.ui.notify(formatLoadReport(scanned), "info");
	});

	pi.on("tool_call", (event) => {
		trackToolCall(state.touched, event.toolName, event.input);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const warn: Warn = (message) => {
			ctx.ui.notify(message, "warning");
		};
		const override = buildSystemPromptOverride(
			event.systemPrompt,
			activeRules(state, warn),
		);
		if (override === undefined) return undefined;
		return { systemPrompt: override };
	});

	pi.on("before_provider_request", (event, ctx) => {
		const payload: unknown = event.payload;
		if (typeof payload !== "object" || payload === null) return undefined;
		if (!("system" in payload)) return undefined;
		if (typeof payload.system !== "string") return undefined;
		const warn: Warn = (message) => {
			ctx.ui.notify(message, "warning");
		};
		// SAFETY: payload is narrowed above to a non-null object with a string
		// `system` field, matching ProviderPayload's only read contract (the
		// reconciler spreads it and rewrites `system` only). No fields are
		// trusted beyond that structural overlap.
		return reconcileProviderPayload(
			payload as unknown as ProviderPayload,
			activeRules(state, warn),
		);
	});
}
