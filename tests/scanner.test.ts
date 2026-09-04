import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	expandBraces,
	findMarkdownFiles,
	formatLoadReport,
	formatRuleList,
	globToRegExp,
	MAX_FILE_BYTES,
	MAX_PATTERNS,
	MAX_WALK_DEPTH,
	matchesAny,
	parseRule,
	scanRules,
} from "../src/scanner.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "scanner-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

describe("findMarkdownFiles", () => {
	it("recursively finds nested markdown files only", () => {
		write("a.md", "# A");
		write("sub/b.md", "# B");
		write("sub/c.txt", "not markdown");
		write("sub/deep/d.md", "# D");
		const found = findMarkdownFiles(root);
		expect(found).toEqual(["a.md", "sub/b.md", "sub/deep/d.md"]);
	});

	it("returns rel paths sorted ascending for determinism", () => {
		write("z.md", "# Z");
		write("a.md", "# A");
		write("m.md", "# M");
		expect(findMarkdownFiles(root)).toEqual(["a.md", "m.md", "z.md"]);
	});

	it("caps walk depth at MAX_WALK_DEPTH", () => {
		expect(MAX_WALK_DEPTH).toBe(5);
		write("d5/l0/l1/l2/l3/at-depth-5.md", "# deep5");
		write("d5/l0/l1/l2/l3/l4/beyond-depth.md", "# deep6");
		const found = findMarkdownFiles(root);
		expect(found).toContain("d5/l0/l1/l2/l3/at-depth-5.md");
		expect(found).not.toContain("d5/l0/l1/l2/l3/l4/beyond-depth.md");
	});

	it("follows dir symlinks but stops cycles at first revisit", () => {
		write("real/rule.md", "# R");
		const outside = mkdtempSync(join(tmpdir(), "scanner-ext-"));
		try {
			writeFileSync(join(outside, "ext.md"), "# E");
			symlinkSync(outside, join(root, "ext"), "dir");
			// self-referential cycle: loop -> root
			symlinkSync(root, join(root, "real", "loop"), "dir");
			const found = findMarkdownFiles(root);
			expect(found).toContain("real/rule.md");
			expect(found).toContain("ext/ext.md");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
	it("skips dangling symlinks silently", () => {
		write("ok.md", "# ok");
		symlinkSync(join(root, "missing.md"), join(root, "dangling.md"));
		expect(findMarkdownFiles(root)).toEqual(["ok.md"]);
	});

	it("returns empty for a missing dir", () => {
		expect(findMarkdownFiles(join(root, "nope"))).toEqual([]);
	});
});

describe("parseRule", () => {
	it("parses paths and derives summary from heading", () => {
		const abs = write("r.md", '---\npaths: ["src/**"]\n---\n# Title\nbody\n');
		const warns: string[] = [];
		const rule = parseRule(abs, "r.md", "global", (m) => warns.push(m));
		expect(rule).toMatchObject({
			rel: "r.md",
			scope: "global",
			paths: ["src/**"],
			summary: "Title",
			text: "# Title\nbody",
		});
		expect(warns).toEqual([]);
	});

	it("treats no frontmatter as a valid unscoped rule", () => {
		const abs = write("plain.md", "# Hello\nworld\n");
		const rule = parseRule(abs, "plain.md", "project");
		expect(rule).toMatchObject({ paths: undefined });
		expect(rule?.summary).toBe("Hello");
	});

	it("ignores metadata.rule_tier (tier retired, issue 14)", () => {
		const abs = write(
			"g.md",
			"---\nmetadata:\n  rule_tier: system\n---\nbody\n",
		);
		const warns: string[] = [];
		const rule = parseRule(abs, "g.md", "global", (m) => warns.push(m));
		expect(rule?.paths).toBeUndefined();
		expect(warns).toEqual([]);
	});

	it("derives summary from first non-blank line, else rel path", () => {
		const abs1 = write("s1.md", "\n\njust text\n");
		expect(parseRule(abs1, "s1.md", "global")?.summary).toBe("just text");
		const abs2 = write("s2.md", "\n  \n");
		expect(parseRule(abs2, "s2.md", "global")?.summary).toBe("s2.md");
	});

	it("hard-skips files larger than the byte budget", () => {
		const abs = write("big.md", "x".repeat(64));
		expect(
			parseRule(abs, "big.md", "global", undefined, { maxFileBytes: 10 }),
		).toBeNull();
	});

	it("exposes a 4 MiB default file budget", () => {
		expect(MAX_FILE_BYTES).toBe(4 * 1024 * 1024);
	});
});

describe("scanRules", () => {
	function tree(base: string, files: Record<string, string>): string {
		for (const [rel, content] of Object.entries(files)) {
			const abs = join(base, rel);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, content);
		}
		return base;
	}

	it("concats global-first with project-wins shadowing + warning", () => {
		const globalDir = tree(join(root, "g"), {
			"shared.md": "# Global\n",
			"only-global.md": "# G\n",
		});
		const projectDir = tree(join(root, "p"), {
			"shared.md": "# Project\n",
			"only-project.md": "# P\n",
		});
		const warns: string[] = [];
		const { rules } = scanRules(globalDir, projectDir, {
			warn: (m) => warns.push(m),
		});
		expect(rules.map((r) => r.rel)).toEqual([
			"only-global.md",
			"shared.md",
			"only-project.md",
		]);
		const shared = rules.find((r) => r.rel === "shared.md");
		expect(shared?.scope).toBe("project");
		expect(shared?.summary).toBe("Project");
		expect(
			warns.some((w) => w.includes("shared.md") && w.includes("shadow")),
		).toBe(true);
	});

	it("sorts rel ascending within each scope", () => {
		const globalDir = tree(join(root, "g"), {
			"z.md": "# Z\n",
			"a.md": "# A\n",
		});
		const projectDir = tree(join(root, "p"), { "m.md": "# M\n" });
		const { rules } = scanRules(globalDir, projectDir);
		expect(rules.map((r) => r.rel)).toEqual(["a.md", "z.md", "m.md"]);
	});

	it("formats the load report as pi-rules: N — U unscoped, S scoped", () => {
		const globalDir = tree(join(root, "g"), {
			"a.md": "# A\n",
			"b.md": "# B\n",
		});
		const projectDir = tree(join(root, "p"), {
			"scoped.md": '---\npaths: ["src/**"]\n---\n# Scoped\n',
		});
		const { rules } = scanRules(globalDir, projectDir);
		expect(formatLoadReport(rules)).toBe(
			"pi-rules: 3 rule(s) — 2 unscoped, 1 scoped",
		);
	});

	it("lists each rule with scope and kind", () => {
		expect(
			formatRuleList([
				{ rel: "a.md", scope: "global", paths: undefined },
				{ rel: "s.md", scope: "project", paths: ["src/**"] },
			]),
		).toEqual([
			"- a.md [global] — unscoped (always-on)",
			"- s.md [project] — scoped (src/**)",
		]);
	});
});

describe("glob matrix", () => {
	it("** crosses separators while * stays in-segment", () => {
		expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
		expect(globToRegExp("src/*.ts").test("src/b.ts")).toBe(true);
	});

	it("? matches exactly one non-separator char", () => {
		expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
		expect(globToRegExp("src/?.ts").test("src/a/b.ts")).toBe(false);
	});

	it("expands {a,b} alternatives", () => {
		expect(expandBraces("src/{a,b}.ts")).toEqual(["src/a.ts", "src/b.ts"]);
		expect(matchesAny(["src/{a,b}.ts"], "src/b.ts")).toBe(true);
		expect(matchesAny(["src/{a,b}.ts"], "src/c.ts")).toBe(false);
	});

	it("supports [...] classes", () => {
		expect(matchesAny(["src/[ab].ts"], "src/a.ts")).toBe(true);
		expect(matchesAny(["src/[ab].ts"], "src/c.ts")).toBe(false);
	});

	it("treats \\[ as a literal bracket", () => {
		expect(matchesAny(["src/\\[x\\].ts"], "src/[x].ts")).toBe(true);
		expect(matchesAny(["src/\\[x\\].ts"], "src/x.ts")).toBe(false);
	});

	it("isolates invalid patterns: siblings keep working", () => {
		const warns: string[] = [];
		expect(
			matchesAny(["src/[z-a].ts", "src/ok.ts"], "src/ok.ts", (m) =>
				warns.push(m),
			),
		).toBe(true);
		expect(matchesAny(["src/[z-a].ts"], "src/whatever.ts")).toBe(false);
	});

	it("falls back to literal matching over the 1000-pattern budget", () => {
		expect(MAX_PATTERNS).toBe(1000);
		const patterns = Array.from({ length: 1001 }, (_, i) => `src/file${i}.ts`);
		const warns: string[] = [];
		// glob would match, but over budget only the literal entry matches itself
		expect(matchesAny(patterns, "src/*.ts", (m) => warns.push(m))).toBe(false);
		expect(warns.some((w) => w.includes("1000"))).toBe(true);
		const warns2: string[] = [];
		expect(matchesAny(patterns, "src/file5.ts", (m) => warns2.push(m))).toBe(
			true,
		);
	});
});
