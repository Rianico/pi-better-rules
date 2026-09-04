import { describe, expect, it } from "vitest";
import type { LifecycleRule, PathMatcher } from "../src/lifecycle.js";
import {
	buildScopedMessageContent,
	buildScopedToolBlock,
	buildSystemPromptOverride,
	candidateBases,
	extractResultPaths,
	findActivatingFile,
	getActiveScopedRules,
	getNewScopedRules,
	getUnscopedRules,
	matchFile,
	relativize,
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

describe("extractResultPaths", () => {
	it("reads input.path on read", () => {
		expect(extractResultPaths("read", { path: "src/a.ts" }, undefined)).toEqual(
			["src/a.ts"],
		);
	});

	it("reads input.path on edit", () => {
		expect(extractResultPaths("edit", { path: "src/a.ts" }, undefined)).toEqual(
			["src/a.ts"],
		);
	});

	it("prefers details.filePath when present", () => {
		expect(
			extractResultPaths(
				"read",
				{ path: "rel/a.ts" },
				{ filePath: "/repo/a.ts" },
				"/repo",
			),
		).toEqual(["a.ts", "rel/a.ts"]);
	});

	it("reads write filePath then path", () => {
		expect(
			extractResultPaths("write", { filePath: "src/new.ts" }, undefined),
		).toEqual(["src/new.ts"]);
		expect(
			extractResultPaths("write", { path: "src/new.ts" }, undefined),
		).toEqual(["src/new.ts"]);
	});

	it("relativizes absolute paths against cwd", () => {
		expect(
			extractResultPaths(
				"read",
				{ path: "/repo/src/a.ts" },
				undefined,
				"/repo",
			),
		).toEqual(["src/a.ts"]);
	});

	it("ignores bash (no path trigger)", () => {
		expect(extractResultPaths("bash", { command: "ls" }, undefined)).toEqual(
			[],
		);
	});

	it("ignores unknown tools even when a path is present", () => {
		expect(extractResultPaths("grep", { path: "src/a.ts" }, undefined)).toEqual(
			[],
		);
	});

	it("ignores missing or non-string paths", () => {
		expect(extractResultPaths("read", {}, undefined)).toEqual([]);
		expect(extractResultPaths("read", { path: 42 }, undefined)).toEqual([]);
		expect(extractResultPaths("read", null, undefined)).toEqual([]);
	});
});

describe("candidateBases", () => {
	it("returns the path plus its bare filename", () => {
		expect(candidateBases("a/b/pyproject.toml")).toEqual([
			"a/b/pyproject.toml",
			"pyproject.toml",
		]);
	});

	it("returns a single base for bare filenames", () => {
		expect(candidateBases("pyproject.toml")).toEqual(["pyproject.toml"]);
	});
});

describe("matchFile", () => {
	it("matches bare patterns against nested files via basename", () => {
		expect(
			matchFile(["pyproject.toml"], "a/b/pyproject.toml", exactMatch),
		).toBe(true);
		expect(matchFile(["pyproject.toml"], "a/b/other.toml", exactMatch)).toBe(
			false,
		);
	});

	it("still matches full relative paths", () => {
		const matches: PathMatcher = (patterns, file) =>
			patterns.some((p) => p === "src/**" && file.startsWith("src/"));
		expect(matchFile(["src/**"], "src/a.ts", matches)).toBe(true);
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

	it("activates a scoped rule from Write result paths", () => {
		const touched = new Set(
			extractResultPaths("write", { path: "src/fresh.tsx" }, undefined),
		);
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

describe("buildScopedToolBlock", () => {
	it("returns undefined when no rules are given", () => {
		expect(buildScopedToolBlock([], "src/a.ts")).toBeUndefined();
		expect(buildScopedMessageContent([])).toBeUndefined();
	});

	it("appends full content naming the matched target", () => {
		const block = buildScopedToolBlock([scopedRule], "src/app.tsx");
		expect(block).toContain("## Rules (scoped — matched for src/app.tsx)");
		expect(block).toContain("--- frontend/react.md [project] ---");
		expect(block).toContain("Use hooks.");
	});

	it("appends the activating file when reasons are given", () => {
		const block = buildScopedToolBlock(
			[scopedRule],
			"src/app.tsx",
			new Map([["frontend/react.md", "src/app.tsx"]]),
		);
		expect(block).toContain("Activated by `src/app.tsx`");
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

describe("relativize", () => {
	it("strips the cwd prefix from absolute paths", () => {
		expect(relativize("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
		expect(relativize("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
	});

	it("passes through relative paths and paths outside cwd", () => {
		expect(relativize("src/a.ts", "/repo")).toBe("src/a.ts");
		expect(relativize("/other/a.ts", "/repo")).toBe("/other/a.ts");
		expect(relativize("src/a.ts", "")).toBe("src/a.ts");
	});

	it("does not strip partial directory names", () => {
		expect(relativize("/repo-other/a.ts", "/repo")).toBe("/repo-other/a.ts");
	});
});
