import { describe, expect, it } from "vitest";
import type { LifecycleRule, PathMatcher } from "../src/lifecycle.js";
import {
	buildRulesBlock,
	buildSystemPromptOverride,
	getActiveRules,
	reconcileProviderPayload,
	reconcileProviderSystemText,
	trackToolCall,
} from "../src/lifecycle.js";

const sysRule: LifecycleRule = {
	rel: "sys.md",
	scope: "project",
	tier: "system",
	summary: "Sys",
	text: "Be safe.",
};

const genRule: LifecycleRule = {
	rel: "gen.md",
	scope: "global",
	tier: "general",
	summary: "General stuff",
	text: "Full general text.",
};

const scopedSysRule: LifecycleRule = {
	rel: "frontend/react.md",
	scope: "project",
	tier: "system",
	paths: ["src/**/*.tsx"],
	summary: "React",
	text: "Use hooks.",
};

/** Stub matcher: exact pattern equality (glob semantics live in scanner). */
const exactMatch: PathMatcher = (patterns, file) =>
	patterns.some((p) => p === file);

describe("trackToolCall", () => {
	it("adds input.path on read", () => {
		const touched = new Set<string>();
		expect(trackToolCall(touched, "read", { path: "src/a.ts" })).toBe(true);
		expect(touched.has("src/a.ts")).toBe(true);
	});

	it("adds input.path on edit", () => {
		const touched = new Set<string>();
		expect(trackToolCall(touched, "edit", { path: "src/a.ts" })).toBe(true);
		expect(touched.has("src/a.ts")).toBe(true);
	});

	it("adds input.path on write without a prior read", () => {
		const touched = new Set<string>();
		expect(trackToolCall(touched, "write", { path: "src/new.ts" })).toBe(true);
		expect(touched.has("src/new.ts")).toBe(true);
	});

	it("ignores bash (no path trigger)", () => {
		const touched = new Set<string>();
		expect(trackToolCall(touched, "bash", { command: "ls" })).toBe(false);
		expect(touched.size).toBe(0);
	});

	it("ignores unknown tools even when a path is present", () => {
		const touched = new Set<string>();
		expect(trackToolCall(touched, "grep", { path: "src/a.ts" })).toBe(false);
		expect(touched.size).toBe(0);
	});

	it("ignores missing or non-string paths", () => {
		const touched = new Set<string>();
		expect(trackToolCall(touched, "read", {})).toBe(false);
		expect(trackToolCall(touched, "read", { path: 42 })).toBe(false);
		expect(trackToolCall(touched, "read", null)).toBe(false);
		expect(touched.size).toBe(0);
	});

	it("is cumulative and idempotent", () => {
		const touched = new Set<string>();
		trackToolCall(touched, "read", { path: "a.ts" });
		trackToolCall(touched, "write", { path: "b.ts" });
		trackToolCall(touched, "read", { path: "a.ts" });
		expect([...touched].sort()).toEqual(["a.ts", "b.ts"]);
	});
});

describe("getActiveRules", () => {
	it("keeps unscoped rules always active", () => {
		const active = getActiveRules([sysRule, genRule], new Set(), exactMatch);
		expect(active.sys).toEqual([sysRule]);
		expect(active.gen).toEqual([genRule]);
	});

	it("leaves scoped rules inactive with an empty touched set", () => {
		const active = getActiveRules([scopedSysRule], new Set(), exactMatch);
		expect(active.sys).toEqual([]);
	});

	it("activates a scoped rule on a matching touch", () => {
		const touched = new Set(["src/app.tsx"]);
		const matches: PathMatcher = (patterns, file) =>
			patterns.some((p) => p === "src/**/*.tsx" && file.endsWith(".tsx"));
		const active = getActiveRules([scopedSysRule], touched, matches);
		expect(active.sys).toEqual([scopedSysRule]);
	});

	it("stays active after later non-matching touches (cumulative)", () => {
		const touched = new Set(["src/app.tsx", "README.md"]);
		const matches: PathMatcher = (_patterns, file) => file === "src/app.tsx";
		const active = getActiveRules([scopedSysRule], touched, matches);
		expect(active.sys).toEqual([scopedSysRule]);
	});

	it("activates a scoped rule from a Write-without-Read touch", () => {
		const touched = new Set<string>();
		trackToolCall(touched, "write", { path: "src/fresh.tsx" });
		const matches: PathMatcher = (_patterns, file) => file === "src/fresh.tsx";
		const active = getActiveRules([scopedSysRule], touched, matches);
		expect(active.sys).toEqual([scopedSysRule]);
	});

	it("returns empty sets for no rules", () => {
		const active = getActiveRules([], new Set(["a.ts"]), exactMatch);
		expect(active.sys).toEqual([]);
		expect(active.gen).toEqual([]);
	});
});

describe("buildSystemPromptOverride", () => {
	it("returns undefined when no rules are active", () => {
		expect(
			buildSystemPromptOverride("base", { sys: [], gen: [] }),
		).toBeUndefined();
	});

	it("renders system full plus general index", () => {
		expect(
			buildSystemPromptOverride("base prompt", {
				sys: [sysRule],
				gen: [genRule],
			}),
		).toBe(
			"base prompt\n\n## Rules: system tier (full)\n### sys.md [project]\nBe safe.\n\n## Rules: general tier (index — use the read tool for full text)\n- gen.md [global] — General stuff",
		);
	});

	it("skips the system section when only general rules are active", () => {
		expect(buildSystemPromptOverride("base", { sys: [], gen: [genRule] })).toBe(
			"base\n\n## Rules: general tier (index — use the read tool for full text)\n- gen.md [global] — General stuff",
		);
	});

	it("skips the general section when only system rules are active", () => {
		expect(buildSystemPromptOverride("base", { sys: [sysRule], gen: [] })).toBe(
			"base\n\n## Rules: system tier (full)\n### sys.md [project]\nBe safe.",
		);
	});
});

describe("buildRulesBlock", () => {
	it("wraps sections in markers", () => {
		expect(buildRulesBlock({ sys: [sysRule], gen: [] })).toBe(
			"<!-- pi-rules:begin -->\n## Rules: system tier (full)\n### sys.md [project]\nBe safe.\n<!-- pi-rules:end -->",
		);
	});

	it("returns undefined when no rules are active", () => {
		expect(buildRulesBlock({ sys: [], gen: [] })).toBeUndefined();
	});
});

describe("reconcileProviderSystemText", () => {
	const active = { sys: [sysRule], gen: [genRule] };

	it("appends the marker block to system text", () => {
		const out = reconcileProviderSystemText("hello", active);
		expect(out).toContain("hello");
		expect(out).toContain("<!-- pi-rules:begin -->");
		expect(out).toContain("### sys.md [project]\nBe safe.");
		expect(out).toContain("- gen.md [global] — General stuff");
		expect(out).toContain("<!-- pi-rules:end -->");
	});

	it("strips a stale block and rebuilds", () => {
		const stale = `hello\n<!-- pi-rules:begin -->\nSTALE\n<!-- pi-rules:end -->`;
		const out = reconcileProviderSystemText(stale, active);
		expect(out).not.toContain("STALE");
		expect(out).toContain("### sys.md [project]");
		expect(out.match(/<!-- pi-rules:begin -->/g)).toHaveLength(1);
	});

	it("is idempotent under retries", () => {
		const once = reconcileProviderSystemText("hello", active);
		expect(reconcileProviderSystemText(once, active)).toBe(once);
	});

	it("removes the block when no rules are active", () => {
		const stale = `hello\n<!-- pi-rules:begin -->\nSTALE\n<!-- pi-rules:end -->`;
		expect(reconcileProviderSystemText(stale, { sys: [], gen: [] })).toBe(
			"hello",
		);
	});
});

describe("reconcileProviderPayload", () => {
	const active = { sys: [sysRule], gen: [] };

	it("passes the payload through untouched without a string system field", () => {
		const absent = { prompt: "hi" };
		expect(reconcileProviderPayload(absent, active)).toBe(absent);
		const nonString = { system: 42 };
		expect(reconcileProviderPayload(nonString, active)).toBe(nonString);
	});

	it("reconciles the system field when present", () => {
		const out = reconcileProviderPayload({ system: "hello" }, active);
		expect(out.system).toContain("<!-- pi-rules:begin -->");
		expect(out.system).toContain("### sys.md [project]");
	});
});
