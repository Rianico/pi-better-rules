import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/index.js";
import entry from "../src/index.js";

type TestHandler = (event: unknown, ctx: unknown) => unknown;

interface StubCommand {
	readonly name: string;
	readonly handler: TestHandler;
}

interface StubEntry {
	readonly customType: string;
	readonly data: unknown;
}

interface StubExtensionAPI {
	readonly events: string[];
	readonly handlers: Map<string, TestHandler[]>;
	readonly commands: StubCommand[];
	readonly entries: StubEntry[];
	on(event: string, handler: TestHandler): void;
	registerCommand(name: string, options: { handler: TestHandler }): void;
	appendEntry(customType: string, data?: unknown): void;
}

function createStub(): StubExtensionAPI {
	const events: string[] = [];
	const handlers = new Map<string, TestHandler[]>();
	const commands: StubCommand[] = [];
	const entries: StubEntry[] = [];
	return {
		events,
		handlers,
		commands,
		entries,
		on(event: string, handler: TestHandler): void {
			events.push(event);
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, options: { handler: TestHandler }): void {
			commands.push({ name, handler: options.handler });
		},
		appendEntry(customType: string, data?: unknown): void {
			entries.push({ customType, data });
		},
	};
}

function toExtensionAPI(stub: StubExtensionAPI): ExtensionAPI {
	return stub as unknown as ExtensionAPI;
}

interface Notification {
	message: string;
	type: string;
}

interface TestContext {
	cwd: string;
	ui: {
		notify(message: string, type?: string): void;
	};
}

function createCtx(cwd: string, notifications: Notification[]): TestContext {
	return {
		cwd,
		ui: {
			notify: (message: string, type = "info"): void => {
				notifications.push({ message, type });
			},
		},
	};
}

function getHandler(stub: StubExtensionAPI, event: string): TestHandler {
	const list = stub.handlers.get(event);
	const handler = list?.[0];
	if (handler === undefined) throw new Error(`no handler for ${event}`);
	return handler;
}

function getCommand(stub: StubExtensionAPI, name: string): TestHandler {
	const command = stub.commands.find((entry) => entry.name === name);
	if (command === undefined) throw new Error(`no command ${name}`);
	return command.handler;
}
const tmpDirs: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
});

async function makeTree(files: Record<string, string>): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-entry-test-"));
	tmpDirs.push(dir);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	return dir;
}

const GLOBAL_UNSCOPED = `# Global invariants\n\nNever leak secrets.\n`;
const PROJECT_SCOPED = `---\npaths:\n  - "src/**"\n---\n# Frontend rules\n\nUse hooks.\n`;

interface AgentStartResult {
	systemPrompt?: string;
}

interface ToolResult {
	content?: Array<{ type: string; text: string }>;
}
async function setupBothTrees(): Promise<{ home: string; project: string }> {
	const home = await makeTree({
		".pi/agent/rules/global-unscoped.md": GLOBAL_UNSCOPED,
		".pi/agent/rules/shared.md": "# Shared\n\nShared content.\n",
	});
	const project = await makeTree({
		".pi/rules/shared.md": "# Shared override\n\nProject copy wins.\n",
		".pi/rules/frontend.md": PROJECT_SCOPED,
	});
	vi.stubEnv("HOME", home);
	return { home, project };
}

describe("extension entry", () => {
	it("registers the §6 handlers plus the /rules command", () => {
		const stub = createStub();
		entry(toExtensionAPI(stub));
		expect([...stub.events].sort()).toEqual(
			[
				"before_agent_start",
				"session_compact",
				"session_start",
				"tool_result",
			].sort(),
		);
		expect(stub.commands.map((command) => command.name)).toEqual(["rules"]);
	});

	it("full-scans on startup: info report, shadow warning, persisted checksums", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		const notifications: Notification[] = [];

		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, notifications),
		);

		const info = notifications.filter((n) => n.type === "info");
		expect(
			info.some((n) =>
				/pi-rules: 3 rule\(s\) — 2 unscoped, 1 scoped/.test(n.message),
			),
		).toBe(true);
		const warnings = notifications.filter((n) => n.type === "warning");
		expect(warnings.some((n) => /shared\.md.*shadow/i.test(n.message))).toBe(
			true,
		);
		const persisted = JSON.parse(
			await readFile(
				join(project, ".pi", ".cache", "pi-better-rules-checksums.json"),
				"utf8",
			),
		) as Record<string, unknown>;
		expect(Object.keys(persisted)).toHaveLength(4);
	});

	it("skips the rescan on reload when checksums are unchanged", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		const start = getHandler(stub, "session_start");
		const first: Notification[] = [];
		await start(
			{ type: "session_start", reason: "startup" },
			createCtx(project, first),
		);

		const notifications: Notification[] = [];
		await start(
			{ type: "session_start", reason: "reload" },
			createCtx(project, notifications),
		);

		expect(
			notifications.some(
				(n) => n.type === "info" && /unchanged/i.test(n.message),
			),
		).toBe(true);
		const beforeAgentStart = getHandler(stub, "before_agent_start");
		const result = (await beforeAgentStart(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			createCtx(project, []),
		)) as AgentStartResult | undefined;
		expect(result?.systemPrompt).toContain("Never leak secrets.");
	});

	it("rescans on reload when a rule file changed", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		const start = getHandler(stub, "session_start");
		await start(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);

		await writeFile(
			join(project, ".pi", "rules", "frontend.md"),
			PROJECT_SCOPED.replace("Use hooks.", "Use hooks v2"),
		);
		const notifications: Notification[] = [];
		await start(
			{ type: "session_start", reason: "reload" },
			createCtx(project, notifications),
		);

		expect(
			notifications.some(
				(n) => n.type === "info" && /refreshed|added|removed/.test(n.message),
			),
		).toBe(true);
		const toolResult = getHandler(stub, "tool_result");
		const promptCtx = createCtx(project, []);
		const result = (await toolResult(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: "file body" }],
				isError: false,
			},
			promptCtx,
		)) as ToolResult | undefined;
		expect(result?.content).toHaveLength(2);
		expect(result?.content?.[0]).toEqual({ type: "text", text: "file body" });
		expect(result?.content?.[1]?.text).toContain("Use hooks v2");
		expect(result?.content?.[1]?.text).toContain("matched for src/app.ts");
	});

	it("rebuilds a corrupt checksum cache with a warning on reload", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		const start = getHandler(stub, "session_start");
		await start(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);

		await writeFile(
			join(project, ".pi", ".cache", "pi-better-rules-checksums.json"),
			"{not valid json",
		);
		const notifications: Notification[] = [];
		await start(
			{ type: "session_start", reason: "reload" },
			createCtx(project, notifications),
		);

		expect(
			notifications.some(
				(n) => n.type === "warning" && /corrupt/i.test(n.message),
			),
		).toBe(true);
	});

	it("tool_result appends scoped blocks same-turn and injects once", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const toolResult = getHandler(stub, "tool_result");
		const notifications: Notification[] = [];
		const ctx = createCtx(project, notifications);
		const bash = (await toolResult(
			{
				type: "tool_result",
				toolName: "bash",
				input: { command: "ls" },
				content: [{ type: "text", text: "out" }],
				isError: false,
			},
			ctx,
		)) as ToolResult | undefined;
		expect(bash).toBeUndefined();

		const write = (await toolResult(
			{
				type: "tool_result",
				toolName: "write",
				input: { path: "src/new.ts" },
				content: [{ type: "text", text: "ok" }],
				isError: false,
			},
			ctx,
		)) as ToolResult | undefined;
		expect(write?.content).toHaveLength(2);
		expect(write?.content?.[1]?.text).toContain("frontend.md");
		expect(write?.content?.[1]?.text).toContain("matched for src/new.ts");
		const warn = notifications.find((n) =>
			n.message.includes("+1 scoped rule(s)"),
		);
		expect(warn?.type).toBe("warning");
		expect(warn?.message).toContain(
			"matched for src/new.ts, matched pattern: src/**",
		);
		expect(warn?.message).toContain("\n- frontend.md");

		// Inject-once: a second matching result appends nothing.
		const again = (await toolResult(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "src/other.ts" },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			ctx,
		)) as ToolResult | undefined;
		expect(again).toBeUndefined();

		// Error results never inject.
		const failed = (await toolResult(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "src/new.ts" },
				content: [{ type: "text", text: "boom" }],
				isError: true,
			},
			ctx,
		)) as ToolResult | undefined;
		expect(failed).toBeUndefined();
	});

	it("before_agent_start returns nothing when no rules exist", async () => {
		const home = await makeTree({});
		const project = await makeTree({});
		vi.stubEnv("HOME", home);
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);

		const result = await getHandler(stub, "before_agent_start")(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			createCtx(project, []),
		);
		expect(result).toBeUndefined();
	});

	it("before_agent_start carries only unscoped content; scoped rules ride tool results", async () => {
		const home = await makeTree({});
		const project = await makeTree({
			".pi/rules/scoped-only.md": PROJECT_SCOPED,
		});
		vi.stubEnv("HOME", home);
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);

		// No unscoped rules: no system prompt override, ever.
		const idle = (await getHandler(stub, "before_agent_start")(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			createCtx(project, []),
		)) as AgentStartResult | undefined;
		expect(idle).toBeUndefined();

		const ctx = createCtx(project, []);
		const active = (await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			ctx,
		)) as ToolResult | undefined;
		expect(active?.content).toHaveLength(2);
		expect(active?.content?.[1]?.text).toContain("Use hooks.");
	});
	it("startup notice lists what loaded and why", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		const notifications: Notification[] = [];
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, notifications),
		);
		const info = notifications.filter((n) => n.type === "info");
		expect(info).toHaveLength(1);
		expect(info[0]?.message).toContain("(full scan on startup)");
		expect(info[0]?.message).toContain(
			"- global-unscoped.md [global] — unscoped (always-on)",
		);
		expect(info[0]?.message).toContain(
			"- frontend.md [project] — scoped (src/**)",
		);
	});

	it("reload-changed notice names refreshed files and why", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		const start = getHandler(stub, "session_start");
		await start(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		await writeFile(
			join(project, ".pi", "rules", "frontend.md"),
			PROJECT_SCOPED.replace("# Frontend rules", "# Frontend rules v2"),
		);
		const notifications: Notification[] = [];
		await start(
			{ type: "session_start", reason: "reload" },
			createCtx(project, notifications),
		);
		const info = notifications.filter((n) => n.type === "info");
		expect(info.some((n) => /checksum changes detected/.test(n.message))).toBe(
			true,
		);
		expect(
			info.some((n) => n.message.includes("~ frontend.md [project]")),
		).toBe(true);
	});

	it("session_compact notifies retention with the rule list", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const notifications: Notification[] = [];
		await getHandler(stub, "session_compact")(
			{ type: "session_compact", reason: "threshold" },
			createCtx(project, notifications),
		);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.message).toContain(
			"retained across compaction (threshold)",
		);
		expect(notifications[0]?.message).toContain(
			"- global-unscoped.md [global]",
		);
	});

	it("tool result blocks state the activating file", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const ctx = createCtx(project, []);
		const result = (await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			ctx,
		)) as ToolResult | undefined;
		expect(result?.content?.[1]?.text).toContain("Activated by `src/app.ts`");
	});
	it("absolute tool paths under cwd activate scoped rules", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const ctx = createCtx(project, []);
		const result = (await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: `${project}/src/app.ts` },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			ctx,
		)) as ToolResult | undefined;
		expect(result?.content?.[1]?.text).toContain("frontend.md");
		expect(result?.content?.[1]?.text).toContain("Activated by `src/app.ts`");
	});

	it("bare patterns match nested files via basename", async () => {
		const home = await makeTree({});
		const project = await makeTree({
			".pi/rules/python.md": `---\npaths:\n  - "pyproject.toml"\n---\n# Python\n\nUse uv.\n`,
		});
		vi.stubEnv("HOME", home);
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const result = (await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "a/b/pyproject.toml" },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			createCtx(project, []),
		)) as ToolResult | undefined;
		expect(result?.content?.[1]?.text).toContain("python.md");
		expect(result?.content?.[1]?.text).toContain("Use uv.");
	});

	it("session_start persists a scan entry to the timeline", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const scan = stub.entries.find(
			(entry) => entry.customType === "pi-rules.scan",
		);
		expect(scan?.data).toMatchObject({ reason: "startup" });
		expect(scan?.data).toMatchObject({
			rules: expect.arrayContaining(["frontend.md"]),
		});
	});

	it("/rules reports load state and shows rule bodies", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const notifications: Notification[] = [];
		const ctx = createCtx(project, notifications);
		await getCommand(stub, "rules")("", ctx);
		expect(
			notifications.some((n) => /2 unscoped, 1 scoped/.test(n.message)),
		).toBe(true);
		await getCommand(stub, "rules")("show frontend.md", ctx);
		expect(notifications.some((n) => n.message.includes("Use hooks."))).toBe(
			true,
		);
		await getCommand(stub, "rules")("show missing.md", ctx);
		expect(
			notifications.some(
				(n) => n.type === "warning" && /no rule matching/.test(n.message),
			),
		).toBe(true);
	});
});
