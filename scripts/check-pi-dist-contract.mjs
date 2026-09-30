#!/usr/bin/env node
/**
 * Guard the pi-dist contract that src/ depends on.
 *
 * The extension relies on undocumented-by-us behaviour of the installed pi:
 * custom prompt sections are wrapped in a tag of the same name, they persist
 * into the transcript, and a live-state export carries `systemPrompt` while a
 * file export does not. A pi upgrade that changes any of that would silently
 * drop the rules from the record, so assert it here instead.
 *
 * Checks import pi's own modules and call them, so they survive line drift and
 * only fail on a real behaviour change. The two marker checks at the end read
 * the export template as text — they are drift alarms, not proofs.
 *
 * Run: node scripts/check-pi-dist-contract.mjs   (or: pnpm check:pi-dist)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Locate the installed pi dist. `PI_DIST` overrides; pnpm/npm globals are searched otherwise. */
function resolvePiDist() {
	if (process.env.PI_DIST) return process.env.PI_DIST;

	const roots = [
		join(process.env.PNPM_HOME ?? join(process.env.HOME ?? "", "Library/pnpm"), "global"),
		process.env.npm_config_prefix ? join(process.env.npm_config_prefix, "lib") : "",
	].filter(Boolean);

	for (const root of roots) {
		if (!existsSync(root)) continue;
		let found;
		try {
			found = execFileSync(
				"find",
				["-L", root, "-type", "d", "-path", "*/node_modules/@earendil-works/pi-coding-agent/dist"],
				{ encoding: "utf8" },
			).split("\n")[0];
		} catch {
			continue;
		}
		if (found && existsSync(join(found, "core/agent-session.js"))) return found;
	}
	return undefined;
}

/** The section name this repo ships, read from source so the guard tracks the real value. */
function repoSectionName() {
	const source = readFileSync(join(REPO_ROOT, "src/lifecycle.ts"), "utf8");
	const match = /export const RULES_SECTION_NAME = "([^"]+)"/.exec(source);
	if (!match) throw new Error("RULES_SECTION_NAME not found in src/lifecycle.ts");
	return match[1];
}

/** The export embeds the payload in this tag; the blob fallback covers older layouts. */
const SESSION_DATA = /<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/;

/** Decode the session payload out of an export HTML — the same move the skill prescribes. */
function decodePayload(html) {
	const tagged = SESSION_DATA.exec(html);
	const candidates = tagged
		? [tagged[1]]
		: [...new Set(html.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? [])].sort(
				(a, b) => b.length - a.length,
			);
	for (const blob of candidates) {
		try {
			const data = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));
			if (data && ("entries" in data || "systemPrompt" in data)) return data;
		} catch {
			// not this blob
		}
	}
	throw new Error("no session payload found in exported HTML");
}

const results = [];
function check(name, kind, run) {
	try {
		run();
		results.push({ name, kind, ok: true });
	} catch (error) {
		results.push({ name, kind, ok: false, error: error.message });
	}
}
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function main() {
	const piDist = resolvePiDist();
	if (!piDist) {
		console.error("pi dist not found — set PI_DIST to @earendil-works/pi-coding-agent/dist");
		return 2;
	}
	console.log(`pi dist: ${piDist}\n`);

	const prompt = await import(pathToFileURL(join(piDist, "core/system-prompt.js")).href);
	const exporter = await import(pathToFileURL(join(piDist, "core/export-html/index.js")).href);
	const sectionName = repoSectionName();
	const temp = mkdtempSync(join(tmpdir(), "pi-dist-contract-"));
	const sessionFile = join(temp, "session.jsonl");
	execFileSync("touch", [sessionFile]);

	check(`section "${sectionName}" is accepted and wrapped as <${sectionName}>`, "behaviour", () => {
		const sections = prompt.buildSystemPromptSections({
			sections: { [sectionName]: "<rule/>" },
			cwd: REPO_ROOT,
		});
		assert(
			sections[sectionName] === `<${sectionName}>\n<rule/>\n</${sectionName}>`,
			`expected <${sectionName}> wrapper, got ${JSON.stringify(sections[sectionName])}`,
		);
	});

	check("invalid section names throw rather than drop the section", "behaviour", () => {
		for (const bad of ["preamble", "Bad Name", "1leading", ""]) {
			let threw = false;
			try {
				prompt.buildSystemPromptSections({ sections: { [bad]: "x" }, cwd: REPO_ROOT });
			} catch {
				threw = true;
			}
			assert(threw, `section name ${JSON.stringify(bad)} was accepted`);
		}
	});

	check("unchanged sections diff to undefined", "behaviour", () => {
		const sections = prompt.buildSystemPromptSections({
			sections: { [sectionName]: "<rule/>" },
			cwd: REPO_ROOT,
		});
		assert(
			prompt.diffSystemPromptSections(sections, sections) === undefined,
			"an unchanged section produced a diff",
		);
		assert(
			prompt.diffSystemPromptSections({}, sections) !== undefined,
			"a changed section produced no diff",
		);
	});

	check("a forced prompt carries no sections (why T1 loses the export)", "behaviour", () => {
		const forced = prompt.buildSystemPromptState({ forceSystemPrompt: "<forced/>" });
		assert(forced.content === "<forced/>", "forced content not carried verbatim");
		assert(!forced.sections, "forced prompt unexpectedly carries structured sections");
		const structured = prompt.buildSystemPromptState({
			sections: { [sectionName]: "<rule/>" },
			cwd: REPO_ROOT,
		});
		assert(structured.sections?.[sectionName], "structured state lost the section");
	});

	const fakeSession = {
		getSessionFile: () => sessionFile,
		getEntries: () => [],
		getHeader: () => ({}),
		getLeafId: () => undefined,
	};

	await checkAsync("live-state export round-trips systemPrompt", "behaviour", async () => {
		const out = join(temp, "live.html");
		await exporter.exportSessionToHtml(fakeSession, { systemPrompt: "<rules-body/>" }, {
			outputPath: out,
		});
		const payload = decodePayload(readFileSync(out, "utf8"));
		assert(payload.systemPrompt === "<rules-body/>", "systemPrompt did not survive the export");
	});

	await checkAsync("file export carries no systemPrompt", "behaviour", async () => {
		const out = join(temp, "file.html");
		await exporter.exportFromFile(sessionFile, { outputPath: out });
		const payload = decodePayload(readFileSync(out, "utf8"));
		assert(payload.systemPrompt === undefined, "file export unexpectedly carries a systemPrompt");
	});

	await checkAsync("in-memory sessions refuse to export", "behaviour", async () => {
		let message;
		try {
			await exporter.exportSessionToHtml(
				{ ...fakeSession, getSessionFile: () => undefined },
				{ systemPrompt: "x" },
				{ outputPath: join(temp, "mem.html") },
			);
		} catch (error) {
			message = error.message;
		}
		assert(
			typeof message === "string" && message.includes("in-memory session"),
			`expected an in-memory refusal, got ${JSON.stringify(message)}`,
		);
	});

	check("export template still marks display:false entries hidden by default", "marker", () => {
		const template = readFileSync(join(piDist, "core/export-html/template.js"), "utf8");
		assert(template.includes("hook-message-hidden"), "hook-message-hidden marker is gone");
		assert(template.includes("showHiddenMessages = false"), "hidden-message default changed");
		assert(template.includes("custom_message"), "custom_message render branch is gone");
	});

	rmSync(temp, { recursive: true, force: true });

	const failed = results.filter((result) => !result.ok);
	for (const result of results) {
		const tag = result.kind === "marker" ? "marker" : "behaviour";
		console.log(`${result.ok ? "PASS" : "FAIL"}  [${tag}] ${result.name}`);
		if (!result.ok) console.log(`        ${result.error}`);
	}
	console.log(`\n${results.length - failed.length}/${results.length} contract checks passed`);
	return failed.length === 0 ? 0 : 1;
}

async function checkAsync(name, kind, run) {
	try {
		await run();
		results.push({ name, kind, ok: true });
	} catch (error) {
		results.push({ name, kind, ok: false, error: error.message });
	}
}

process.exit(await main());
