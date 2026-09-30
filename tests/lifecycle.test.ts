import { describe, expect, it } from "vitest";
import type { LifecycleRule, PathMatcher } from "../src/lifecycle.js";
import {
	buildRulesSection,
	buildScopedMessageContent,
	candidateBases,
	escapeXmlAttr,
	extractResultPaths,
	findActivatingFile,
	findActivation,
	findMatchingPattern,
	formatRuleXml,
	getActiveScopedRules,
	getNewScopedRules,
	getUnscopedRules,
	matchFile,
	RULES_SECTION_NAME,
	relativize,
	ruleScope,
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

describe("findMatchingPattern", () => {
	it("returns the firing pattern, preferring earlier entries", () => {
		const matches: PathMatcher = (patterns, file) =>
			patterns.some((p) => p === "src/**" || p === "**/*.ts") &&
			file.startsWith("src/");
		expect(
			findMatchingPattern(["src/**", "**/*.ts"], "src/a.ts", matches),
		).toBe("src/**");
	});

	it("finds bare patterns via the basename base", () => {
		expect(
			findMatchingPattern(
				["other.toml", "pyproject.toml"],
				"a/b/pyproject.toml",
				exactMatch,
			),
		).toBe("pyproject.toml");
	});

	it("returns undefined when nothing matches", () => {
		expect(
			findMatchingPattern(["src/**"], "docs/a.md", exactMatch),
		).toBeUndefined();
	});
});

describe("findActivation", () => {
	it("returns the file plus the firing pattern", () => {
		expect(
			findActivation(scopedRule, new Set(["src/app.tsx"]), (_p, f) =>
				f.endsWith(".tsx"),
			),
		).toEqual({
			file: "src/app.tsx",
			pattern: "src/**/*.tsx",
		});
	});

	it("returns undefined when nothing matches", () => {
		expect(
			findActivation(scopedRule, new Set(["README.md"]), exactMatch),
		).toBeUndefined();
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

describe("buildRulesSection", () => {
	it("returns undefined when no unscoped rules exist", () => {
		expect(buildRulesSection([])).toBeUndefined();
	});

	it("renders the <rule> children pi wraps in the user-rules section", () => {
		expect(buildRulesSection([unscopedA])).toBe(
			'<rule path="a.md" scope="unscoped" summary="A">Never leak secrets.</rule>',
		);
	});

	it("renders multiple unscoped rules one per line", () => {
		expect(buildRulesSection([unscopedA, unscopedB])).toBe(
			'<rule path="a.md" scope="unscoped" summary="A">Never leak secrets.</rule>\n<rule path="b.md" scope="unscoped" summary="B">General stuff full text.</rule>',
		);
	});

	it("names a section tag pi accepts and keeps it distinct from <rules>", () => {
		expect(RULES_SECTION_NAME).toBe("user-rules");
		expect(RULES_SECTION_NAME).toMatch(/^[a-z][a-z0-9_-]*$/);
		expect(RULES_SECTION_NAME).not.toBe("preamble");
		expect(RULES_SECTION_NAME).not.toBe("rules");
	});
});

describe("buildScopedMessageContent", () => {
	it("returns undefined when no rules are given", () => {
		expect(buildScopedMessageContent([])).toBeUndefined();
	});

	it("fences scoped XML bodies for markdown-rendered messages", () => {
		const content = buildScopedMessageContent([scopedRule]);
		expect(content).toContain("```xml");
		expect(content).toContain(
			'<rule path="frontend/react.md" scope="scoped" summary="React">Use hooks.</rule>',
		);
	});

	it("renders the activating file as an activated-by attribute", () => {
		const content = buildScopedMessageContent(
			[scopedRule],
			new Map([["frontend/react.md", "src/app.tsx"]]),
		);
		expect(content).toContain('activated-by="src/app.tsx"');
	});
});

describe("scoped activation helpers", () => {
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
	it("preserves original bodies inside raw XML rule elements", () => {
		const titled: LifecycleRule = {
			rel: "t.md",
			scope: "global",
			summary: "T",
			text: "# T\n\nBody text.",
		};
		expect(buildRulesSection([titled])).toBe(
			'<rule path="t.md" scope="unscoped" summary="T"># T\n\nBody text.</rule>',
		);
		expect(buildScopedMessageContent([titled])).toBe(
			'```xml\n<user-rules>\n<rule path="t.md" scope="unscoped" summary="T"># T\n\nBody text.</rule>\n</user-rules>\n```',
		);
	});
});

describe("rulesXml", () => {
	it("gates scope from paths presence", () => {
		expect(ruleScope(unscopedA)).toBe("unscoped");
		expect(ruleScope(scopedRule)).toBe("scoped");
	});

	it("escapes attribute special chars", () => {
		expect(escapeXmlAttr('a&<>"b')).toBe("a&amp;&lt;&gt;&quot;b");
	});

	it("renders activated-by only when mapped", () => {
		expect(formatRuleXml(scopedRule)).not.toContain("activated-by");
		expect(
			formatRuleXml(scopedRule, new Map([["frontend/react.md", "src/a.ts"]])),
		).toContain('activated-by="src/a.ts"');
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
