import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/index.js";
import entry from "../src/index.js";

type TestHandler = (event: unknown, ctx: unknown) => unknown;

interface StubExtensionAPI {
	readonly events: string[];
	readonly handlers: Map<string, TestHandler[]>;
	on(event: string, handler: TestHandler): void;
}

function createStub(): StubExtensionAPI {
	const events: string[] = [];
	const handlers = new Map<string, TestHandler[]>();
	return {
		events,
		handlers,
		on(event: string, handler: TestHandler): void {
			events.push(event);
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
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
	message?: { customType: string; content: string; display: boolean };
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
	it("registers exactly the four §6 handlers", () => {
		const stub = createStub();
		entry(toExtensionAPI(stub));
		expect([...stub.events].sort()).toEqual(
			[
				"before_agent_start",
				"session_compact",
				"session_start",
				"tool_call",
			].sort(),
		);
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
			PROJECT_SCOPED.replace("# Frontend rules", "# Frontend rules v2"),
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
		const toolCall = getHandler(stub, "tool_call");
		const promptCtx = createCtx(project, []);
		await toolCall(
			{ type: "tool_call", toolName: "read", input: { path: "src/app.ts" } },
			promptCtx,
		);
		const beforeAgentStart = getHandler(stub, "before_agent_start");
		const result = (await beforeAgentStart(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			promptCtx,
		)) as AgentStartResult | undefined;
		expect(result?.message?.content).toContain("Frontend rules v2");
		expect(result?.message?.display).toBe(true);
		expect(result?.message?.customType).toBe("pi-rules");
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

	it("tool_call tracks read/edit/write paths and injects scoped messages inject-once", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const toolCall = getHandler(stub, "tool_call");
		const ctx = createCtx(project, []);

		await toolCall(
			{ type: "tool_call", toolName: "bash", input: { command: "ls" } },
			ctx,
		);
		const beforeAgentStart = getHandler(stub, "before_agent_start");
		const idle = (await beforeAgentStart(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			ctx,
		)) as AgentStartResult | undefined;
		// Unscoped full content is always appended; no scoped message yet.
		expect(idle?.systemPrompt).toContain("Never leak secrets.");
		expect(idle?.message).toBeUndefined();

		await toolCall(
			{ type: "tool_call", toolName: "write", input: { path: "src/new.ts" } },
			ctx,
		);
		const active = (await beforeAgentStart(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			ctx,
		)) as AgentStartResult | undefined;
		expect(active?.message?.content).toContain("frontend.md");
		expect(active?.message?.display).toBe(true);

		// Inject-once: second prompt carries no duplicate message.
		const again = (await beforeAgentStart(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			ctx,
		)) as AgentStartResult | undefined;
		expect(again?.systemPrompt).toContain("Never leak secrets.");
		expect(again?.message).toBeUndefined();
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

	it("before_agent_start returns only a message when scoped rules activate without unscoped", async () => {
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

		// No touches yet: nothing to inject.
		const idle = (await getHandler(stub, "before_agent_start")(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			createCtx(project, []),
		)) as AgentStartResult | undefined;
		expect(idle).toBeUndefined();

		const ctx = createCtx(project, []);
		await getHandler(stub, "tool_call")(
			{ type: "tool_call", toolName: "read", input: { path: "src/app.ts" } },
			ctx,
		);
		const active = (await getHandler(stub, "before_agent_start")(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			ctx,
		)) as AgentStartResult | undefined;
		expect(active?.systemPrompt).toBeUndefined();
		expect(active?.message?.content).toContain("Use hooks.");
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

	it("scoped messages state the activating file", async () => {
		const { project } = await setupBothTrees();
		const stub = createStub();
		entry(toExtensionAPI(stub));
		await getHandler(stub, "session_start")(
			{ type: "session_start", reason: "startup" },
			createCtx(project, []),
		);
		const ctx = createCtx(project, []);
		await getHandler(stub, "tool_call")(
			{ type: "tool_call", toolName: "read", input: { path: "src/app.ts" } },
			ctx,
		);
		const result = (await getHandler(stub, "before_agent_start")(
			{ type: "before_agent_start", prompt: "hi", systemPrompt: "base" },
			ctx,
		)) as AgentStartResult | undefined;
		expect(result?.message?.content).toContain("Activated by `src/app.ts`");
	});
});
