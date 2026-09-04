// pi-better-rules — pi extension entry (spec §5, §6).
//
// Wires src/scanner.ts (discovery + matching), src/cache.ts (checksum
// persistence), and src/lifecycle.ts (activation + rendering) into the four
// §6 handlers. No compaction work: the in-memory cache survives compaction
// untouched; the session_compact handler only notifies retention.
// Handler shapes follow the installed pi docs/extensions.md and
// examples/extensions/claude-rules.ts (default export taking ExtensionAPI,
// pi.on registration); the minimal structural types below mirror those
// reference shapes so this package needs no runtime dependency on pi.
//
// Scope-only model (issue 14): no tier. Unscoped rules (paths absent) are
// always-on full content appended to the system prompt (like pi's appended
// system prompt). Scoped rules (paths present) are full content injected as
// visible session messages (display: true), cumulative inject-once.
//
// Load visibility (issue 15): every loading trigger notifies what loaded and
// why — full scan with rule list on startup/new/resume/fork, checksum
// refreshed/added/removed file lists on reload, retention on compaction.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CacheHooks, FileStat } from "./cache.js";
import { projectCachePath, refreshCache, verifyChecksums } from "./cache.js";
import type { LifecycleRule, PathMatcher, ScopedMessage } from "./lifecycle.js";
import {
	buildScopedMessage,
	buildSystemPromptOverride,
	findActivatingFile,
	getActiveScopedRules,
	getNewScopedRules,
	getUnscopedRules,
	trackToolCall,
} from "./lifecycle.js";
import type { Rule, Warn } from "./scanner.js";
import {
	findMarkdownFiles,
	formatLoadReport,
	formatRuleList,
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

export interface ScopedRuleMessage {
	readonly customType: "pi-rules";
	readonly content: string;
	readonly display: true;
}

export interface BeforeAgentStartEvent {
	readonly type: "before_agent_start";
	readonly prompt: string;
	readonly systemPrompt: string;
}

export interface SessionCompactEvent {
	readonly type: "session_compact";
	readonly reason: "manual" | "threshold" | "overflow";
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
		event: "session_compact",
		handler: (event: SessionCompactEvent, ctx: ExtensionContext) => unknown,
	): void;
}

interface EntryState {
	rules: LifecycleRule[];
	touched: Set<string>;
	injected: Set<string>;
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

/** Prune injected rels that no longer exist after a rescan. */
function pruneInjected(state: EntryState): void {
	const live = new Set(state.rules.map((rule) => rule.rel));
	for (const rel of [...state.injected]) {
		if (!live.has(rel)) state.injected.delete(rel);
	}
}

/** Render an abs checksum path as `rel [scope]` for change reports. */
function describeAbs(
	absPath: string,
	globalDir: string,
	projectDir: string,
): string {
	const relTo = (dir: string, scope: string): string | undefined => {
		const prefix = dir.endsWith("/") ? dir : `${dir}/`;
		if (absPath.startsWith(prefix))
			return `${absPath.slice(prefix.length)} [${scope}]`;
		return undefined;
	};
	return relTo(projectDir, "project") ?? relTo(globalDir, "global") ?? absPath;
}

export default function piBetterRules(pi: ExtensionAPI): void {
	const state: EntryState = {
		rules: [],
		touched: new Set<string>(),
		injected: new Set<string>(),
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
					`pi-rules: ${state.rules.length} rule(s) — unchanged (checksums verified, no rescan)\n${formatRuleList(state.rules).join("\n")}`,
					"info",
				);
				return;
			}
			const scanned = scanRules(globalDir, projectDir, { warn }).rules;
			state.rules = toLifecycleRules(scanned);
			pruneInjected(state);
			const report = await refreshCache(state.checksumsPath, hooks, warn);
			const changes = [
				...report.refreshed.map(
					(f) => `~ ${describeAbs(f, globalDir, projectDir)}`,
				),
				...report.added.map(
					(f) => `+ ${describeAbs(f, globalDir, projectDir)}`,
				),
				...report.removed.map(
					(f) => `- ${describeAbs(f, globalDir, projectDir)}`,
				),
			].join("\n");
			ctx.ui.notify(
				`pi-rules: refreshed ${report.refreshed.length}, added ${report.added.length}, removed ${report.removed.length} (checksum changes detected)\n${changes}\n${formatRuleList(state.rules).join("\n")}`,
				"info",
			);
			return;
		}

		const scanned = scanRules(globalDir, projectDir, { warn }).rules;
		state.rules = toLifecycleRules(scanned);
		state.touched.clear();
		state.injected.clear();
		await refreshCache(state.checksumsPath, hooks, warn);
		ctx.ui.notify(
			`${formatLoadReport(scanned)} (full scan on ${event.reason})\n${formatRuleList(scanned).join("\n")}`,
			"info",
		);
	});

	pi.on("tool_call", (event) => {
		trackToolCall(state.touched, event.toolName, event.input);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const warn: Warn = (message) => {
			ctx.ui.notify(message, "warning");
		};
		const matches: PathMatcher = (patterns, file) =>
			matchesAny([...patterns], file, warn);
		const override = buildSystemPromptOverride(
			event.systemPrompt,
			getUnscopedRules(state.rules),
		);
		const activeScoped = getActiveScopedRules(
			state.rules,
			state.touched,
			matches,
		);
		const fresh = getNewScopedRules(activeScoped, state.injected);
		let message: ScopedMessage | ScopedRuleMessage | undefined;
		if (fresh.length > 0) {
			const activatedBy = new Map<string, string>();
			for (const rule of fresh) {
				const cause = findActivatingFile(rule, state.touched, matches);
				if (cause !== undefined) activatedBy.set(rule.rel, cause);
			}
			message = buildScopedMessage(fresh, activatedBy);
			if (message !== undefined) {
				for (const rule of fresh) state.injected.add(rule.rel);
			}
		}
		if (override === undefined && message === undefined) return undefined;
		if (override !== undefined && message !== undefined)
			return { systemPrompt: override, message };
		if (override !== undefined) return { systemPrompt: override };
		return { message };
	});

	pi.on("session_compact", (event, ctx) => {
		ctx.ui.notify(
			`pi-rules: ${state.rules.length} rule(s) retained across compaction (${event.reason}) — cache untouched, no rescan\n${formatRuleList(state.rules).join("\n")}`,
			"info",
		);
	});
}
