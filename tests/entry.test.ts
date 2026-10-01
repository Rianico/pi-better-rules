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

interface StubMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly options?: {
		readonly deliverAs?: string;
		readonly triggerTurn?: boolean;
	};
}

interface StubExtensionAPI {
	readonly events: string[];
	readonly handlers: Map<string, TestHandler[]>;
	readonly commands: StubCommand[];
	readonly entries: StubEntry[];
	readonly messages: StubMessage[];
	on(event: string, handler: TestHandler): void;
	registerCommand(name: string, options: { handler: TestHandler }): void;
	appendEntry(customType: string, data?: unknown): void;
	sendMessage(message: StubMessage, options?: StubMessage["options"]): void;
}

function createStub(): StubExtensionAPI {
	const events: string[] = [];
	const handlers = new Map<string, TestHandler[]>();
	const commands: StubCommand[] = [];
	const entries: StubEntry[] = [];
	const messages: StubMessage[] = [];
	return {
		events,
		handlers,
		commands,
		entries,
		messages,
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
		sendMessage(message: StubMessage, options?: StubMessage["options"]): void {
			messages.push({
				...message,
				...(options === undefined ? {} : { options }),
			});
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

interface SystemPromptOptions {
	sections: Record<string, string>;
}

interface AgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt: string;
	systemPromptOptions: SystemPromptOptions;
}

const RULES_SECTION = "user-rules";

/** Event for before_agent_start; `systemPromptOptions.sections` is the mutable
 * map pi wraps into `<name>…</name>` prompt sections. */
function startEvent(sections: Record<string, string> = {}): AgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "hi",
		systemPrompt: "base",
		systemPromptOptions: { sections },
	};
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
		const event = startEvent();
		await beforeAgentStart(event, createCtx(project, []));
		expect(event.systemPromptOptions.sections[RULES_SECTION]).toContain(
			"Never leak secrets.",
		);
	});

	it("repopulates on reload-unchanged when state is fresh (new Extension instance after /reload)", async () => {
		const { home, project } = await setupBothTrees();
		// First instance populates cache via startup scan
		const firstStub = createStub();
		entry(toExtensionAPI(firstStub));
		await getHandler(firstStub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		// Fresh instance mimics pi's reload: new closure with empty state, same cwd/checksums
		vi.stubEnv("HOME", home);
		const freshStub = createStub();
		entry(toExtensionAPI(freshStub));
		const notifications: Notification[] = [];
		await getHandler(freshStub, "session_start")(
			{ type: "session_start", reason: "reload" },
			createCtx(project, notifications),
		);
		// Must not report 0 rules — should rescan and repopulate even though checksums are unchanged
		expect(
			notifications.some((n) => /0 rule\(s\).*unchanged/.test(n.message)),
		).toBe(false);
		const reloadEvent = startEvent();
		await getHandler(freshStub, "before_agent_start")(
			reloadEvent,
			createCtx(project, []),
		);
		const section = reloadEvent.systemPromptOptions.sections[RULES_SECTION];
		expect(section).toContain("Never leak secrets.");
		expect(section).toContain("Shared");
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
		expect(result).toBeUndefined();
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0]?.customType).toBe("pi-rules.activated");
		expect(stub.messages[0]?.display).toBe(false);
		expect(stub.messages[0]?.options?.deliverAs).toBe("steer");
		expect(stub.messages[0]?.content).toContain("Use hooks v2");
		expect(stub.messages[0]?.content).toContain('activated-by="src/app.ts"');
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

	it("tool_result sends scoped rules as an ordinary message, once", async () => {
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
		expect(write).toBeUndefined();
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0]?.display).toBe(false);
		expect(stub.messages[0]?.content).toContain("frontend.md");
		expect(stub.messages[0]?.content).toContain('activated-by="src/new.ts"');
		const warn = notifications.find((n) =>
			n.message.includes("+1 scoped rule(s)"),
		);
		expect(warn?.type).toBe("warning");
		expect(warn?.message).toContain(
			"matched for src/new.ts, matched pattern: src/**",
		);
		expect(warn?.message).toContain("frontend.md");

		// Inject-once: a second matching result sends nothing.
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
		expect(stub.messages).toHaveLength(1);

		// Error results never send a message.
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

		const event = startEvent();
		await getHandler(stub, "before_agent_start")(event, createCtx(project, []));
		expect(event.systemPromptOptions.sections[RULES_SECTION]).toBeUndefined();
	});

	it("before_agent_start carries only unscoped content; scoped rules ride messages", async () => {
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

		// No unscoped rules: no user-rules section, ever.
		const idle = startEvent();
		await getHandler(stub, "before_agent_start")(idle, createCtx(project, []));
		expect(idle.systemPromptOptions.sections[RULES_SECTION]).toBeUndefined();
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
		expect(active).toBeUndefined();
		expect(stub.messages[0]?.content).toContain("Use hooks.");
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
			"global-unscoped.md [global] — unscoped (always-on)",
		);
		expect(info[0]?.message).toContain(
			"frontend.md [project] — scoped (src/**)",
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
		expect(info.some((n) => n.message.includes("frontend.md [project]"))).toBe(
			true,
		);
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
		expect(notifications[0]?.message).toContain("global-unscoped.md [global]");
	});

	it("activation messages state the activating file", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const ctx = createCtx(project, []);
		await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			ctx,
		);
		expect(stub.messages[0]?.content).toContain('activated-by="src/app.ts"');
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
		await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: `${project}/src/app.ts` },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			ctx,
		);
		expect(stub.messages[0]?.content).toContain("frontend.md");
		expect(stub.messages[0]?.content).toContain('activated-by="src/app.ts"');
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
		await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "a/b/pyproject.toml" },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			createCtx(project, []),
		);
		expect(stub.messages[0]?.content).toContain("python.md");
		expect(stub.messages[0]?.content).toContain("Use uv.");
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

	it("before_agent_start publishes unscoped rules as the user-rules prompt section", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const beforeAgentStart = getHandler(stub, "before_agent_start");
		const ctx = createCtx(project, []);
		const event = startEvent();
		await beforeAgentStart(event, ctx);
		const section = event.systemPromptOptions.sections[RULES_SECTION];
		expect(section).toContain('scope="unscoped"');
		expect(section).toContain("Never leak secrets.");
		expect(section).not.toContain("frontend.md");
		// pi adds the <user-rules> wrapper; the body must not nest it.
		expect(section).not.toContain("<user-rules>");
		expect(await beforeAgentStart(event, ctx)).toBeUndefined();
	});

	it("before_agent_start refreshes the section after the unscoped set changes", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		const start = getHandler(stub, "session_start");
		await start(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const beforeAgentStart = getHandler(stub, "before_agent_start");
		const ctx = createCtx(project, []);
		const before = startEvent();
		await beforeAgentStart(before, ctx);
		await writeFile(
			join(project, ".pi", "rules", "extra.md"),
			"# Extra\n\nExtra body.\n",
		);
		await start(
			{ type: "session_start", reason: "reload" },
			createCtx(project, []),
		);
		const after = startEvent();
		await beforeAgentStart(after, ctx);
		expect(after.systemPromptOptions.sections[RULES_SECTION]).toContain(
			"Extra body.",
		);
		expect(before.systemPromptOptions.sections[RULES_SECTION]).not.toContain(
			"Extra body.",
		);
	});

	it("before_agent_start drops a stale section when only scoped rules remain", async () => {
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
		const event = startEvent({ [RULES_SECTION]: "stale" });
		await getHandler(stub, "before_agent_start")(event, createCtx(project, []));
		expect(event.systemPromptOptions.sections[RULES_SECTION]).toBeUndefined();
	});

	it("activation message carries fenced scoped bodies and stays hidden", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		expect(stub.messages).toHaveLength(0);
		await getHandler(stub, "tool_result")(
			{
				type: "tool_result",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: "body" }],
				isError: false,
			},
			createCtx(project, []),
		);
		expect(stub.messages).toHaveLength(1);
		expect(stub.messages[0]?.customType).toBe("pi-rules.activated");
		// Hidden from the terminal and default export view; still model-facing.
		expect(stub.messages[0]?.display).toBe(false);
		expect(stub.messages[0]?.content).toContain("```xml");
		expect(stub.messages[0]?.content).toContain("Use hooks.");
		expect(stub.messages[0]?.content).toContain('activated-by="src/app.ts"');
	});
});
