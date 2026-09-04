import { describe, expect, it } from "vitest";
import type { LifecycleRule, PathMatcher } from "../src/lifecycle.js";
import {
	buildScopedMessage,
	buildScopedMessageContent,
	buildSystemPromptOverride,
	findActivatingFile,
	getActiveScopedRules,
	getNewScopedRules,
	getUnscopedRules,
	RULES_MESSAGE_TYPE,
	trackToolCall,
} from "../src/lifecycle.js";

const unscopedA: LifecycleRule = {
	rel: "a.md",
	scope: "project",
	summary: "A",
	text: "Never leak secrets.",
};

const unscopedB: LifecycleRule = {
	rel: "b.md",
	scope: "global",
	summary: "B",
	text: "General stuff full text.",
};

const scopedRule: LifecycleRule = {
	rel: "frontend/react.md",
	scope: "project",
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

describe("getUnscopedRules", () => {
	it("returns only rules without paths", () => {
		expect(getUnscopedRules([unscopedA, unscopedB, scopedRule])).toEqual([
			unscopedA,
			unscopedB,
		]);
	});

	it("returns empty when all rules are scoped", () => {
		expect(getUnscopedRules([scopedRule])).toEqual([]);
	});
});

describe("getActiveScopedRules", () => {
	it("leaves scoped rules inactive with an empty touched set", () => {
		expect(getActiveScopedRules([scopedRule], new Set(), exactMatch)).toEqual(
			[],
		);
	});

	it("activates a scoped rule on a matching touch", () => {
		const touched = new Set(["src/app.tsx"]);
		const matches: PathMatcher = (patterns, file) =>
			patterns.some((p) => p === "src/**/*.tsx" && file.endsWith(".tsx"));
		expect(getActiveScopedRules([scopedRule], touched, matches)).toEqual([
			scopedRule,
		]);
	});

	it("stays active after later non-matching touches (cumulative)", () => {
		const touched = new Set(["src/app.tsx", "README.md"]);
		const matches: PathMatcher = (_patterns, file) => file === "src/app.tsx";
		expect(getActiveScopedRules([scopedRule], touched, matches)).toEqual([
			scopedRule,
		]);
	});

	it("activates a scoped rule from a Write-without-Read touch", () => {
		const touched = new Set<string>();
		trackToolCall(touched, "write", { path: "src/fresh.tsx" });
		const matches: PathMatcher = (_patterns, file) => file === "src/fresh.tsx";
		expect(getActiveScopedRules([scopedRule], touched, matches)).toEqual([
			scopedRule,
		]);
	});

	it("ignores unscoped rules", () => {
		expect(
			getActiveScopedRules([unscopedA], new Set(["a.ts"]), exactMatch),
		).toEqual([]);
	});
});

describe("getNewScopedRules", () => {
	it("returns active rules not yet injected", () => {
		expect(getNewScopedRules([scopedRule], new Set())).toEqual([scopedRule]);
	});

	it("filters out already-injected rels (inject-once)", () => {
		expect(
			getNewScopedRules([scopedRule], new Set(["frontend/react.md"])),
		).toEqual([]);
	});
});

describe("buildSystemPromptOverride", () => {
	it("returns undefined when no unscoped rules exist", () => {
		expect(buildSystemPromptOverride("base", [])).toBeUndefined();
	});

	it("renders unscoped full content like an appended system prompt", () => {
		expect(buildSystemPromptOverride("base prompt", [unscopedA])).toBe(
			"base prompt\n\n## Rules (always-on)\n--- a.md [project] ---\nNever leak secrets.",
		);
	});

	it("renders multiple unscoped rules", () => {
		expect(buildSystemPromptOverride("base", [unscopedA, unscopedB])).toBe(
			"base\n\n## Rules (always-on)\n--- a.md [project] ---\nNever leak secrets.\n\n--- b.md [global] ---\nGeneral stuff full text.",
		);
	});

	it("returns the section alone when base is empty", () => {
		expect(buildSystemPromptOverride("", [unscopedA])).toBe(
			"## Rules (always-on)\n--- a.md [project] ---\nNever leak secrets.",
		);
	});
});

describe("buildScopedMessage", () => {
	it("returns undefined when no rules are given", () => {
		expect(buildScopedMessage([])).toBeUndefined();
		expect(buildScopedMessageContent([])).toBeUndefined();
	});

	it("injects full content as a visible message", () => {
		const message = buildScopedMessage([scopedRule]);
		expect(message?.customType).toBe(RULES_MESSAGE_TYPE);
		expect(message?.customType).toBe("pi-rules");
		expect(message?.display).toBe(true);
		expect(message?.content).toContain("--- frontend/react.md [project] ---");
		expect(message?.content).toContain("Use hooks.");
	});
	it("appends the activating file when reasons are given", () => {
		const message = buildScopedMessage(
			[scopedRule],
			new Map([["frontend/react.md", "src/app.tsx"]]),
		);
		expect(message?.content).toContain("Activated by `src/app.tsx`");
	});

	it("finds the first touched file matching a scoped rule", () => {
		expect(
			findActivatingFile(
				scopedRule,
				new Set(["README.md", "src/a.ts"]),
				(_p, f) => f.startsWith("src/"),
			),
		).toBe("src/a.ts");
		expect(
			findActivatingFile(scopedRule, new Set(["README.md"]), exactMatch),
		).toBeUndefined();
	});
	it("splits rules with rel separators and preserves original bodies", () => {
		const titled: LifecycleRule = {
			rel: "t.md",
			scope: "global",
			summary: "T",
			text: "# T\n\nBody text.",
		};
		expect(buildSystemPromptOverride("base", [titled])).toBe(
			"base\n\n## Rules (always-on)\n--- t.md [global] ---\n# T\n\nBody text.",
		);
		expect(buildScopedMessageContent([titled])).toBe(
			"## Rules (scoped — activated by touched files)\n--- t.md [global] ---\n# T\n\nBody text.",
		);
	});
});
