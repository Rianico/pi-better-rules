import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Checksum cache + refresh (spec §3.3). Disk-persisted sha256 map with a stat pre-filter. */

export const CHECKSUM_FILENAME = "pi-better-rules-checksums.json";

export interface FileStat {
	mtimeMs: number;
	size: number;
}

export interface ChecksumEntry extends FileStat {
	checksum: string;
}

export type ChecksumMap = Record<string, ChecksumEntry>;

export interface RefreshReport {
	added: string[];
	refreshed: string[];
	removed: string[];
	unchanged: string[];
}

export interface VerifyResult {
	unchanged: boolean;
	changed: string[];
	added: string[];
	removed: string[];
}

export interface CacheHooks {
	listFiles: () => Promise<string[]> | string[];
	readFile: (absPath: string) => Promise<string | Uint8Array>;
	statFile?: (absPath: string) => Promise<FileStat>;
}

export type Warn = (message: string) => void;

export function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function globalCachePath(homeDir: string): string {
	return join(homeDir, ".pi", "agent", "cache", CHECKSUM_FILENAME);
}

export function projectCachePath(projectRoot: string): string {
	return join(projectRoot, ".pi", ".cache", CHECKSUM_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChecksumEntry(value: unknown): value is ChecksumEntry {
	return (
		isRecord(value) &&
		typeof value.checksum === "string" &&
		typeof value.mtimeMs === "number" &&
		typeof value.size === "number"
	);
}

function isEnoent(error: unknown): boolean {
	return (
		isRecord(error) &&
		typeof error.code === "string" &&
		(error as { code: string }).code === "ENOENT"
	);
}

export async function loadChecksumMap(
	cachePath: string,
	warn?: Warn,
): Promise<{ map: ChecksumMap; corrupt: boolean }> {
	let raw: string;
	try {
		raw = await readFile(cachePath, "utf8");
	} catch (error: unknown) {
		if (isEnoent(error)) {
			return { map: {}, corrupt: false };
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		warn?.(`corrupt checksum cache at ${cachePath} — rebuilding`);
		return { map: {}, corrupt: true };
	}
	if (!isRecord(parsed)) {
		warn?.(`corrupt checksum cache at ${cachePath} — rebuilding`);
		return { map: {}, corrupt: true };
	}
	const map: ChecksumMap = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!isChecksumEntry(value)) {
			warn?.(`corrupt checksum cache at ${cachePath} — rebuilding`);
			return { map: {}, corrupt: true };
		}
		map[key] = value;
	}
	return { map, corrupt: false };
}

export async function saveChecksumMap(
	cachePath: string,
	map: ChecksumMap,
): Promise<void> {
	await mkdir(join(cachePath, ".."), { recursive: true });
	await writeFile(cachePath, JSON.stringify(map, null, 2));
}

interface Verification extends VerifyResult {
	refreshedPaths: string[];
	unchangedPaths: string[];
	next: ChecksumMap;
}
async function verifyWithMap(
	cachePath: string,
	hooks: CacheHooks,
	warn?: Warn,
): Promise<Verification> {
	const { map: prev } = await loadChecksumMap(cachePath, warn);
	const listed = await hooks.listFiles();
	const files = [...listed].sort();
	const seen = new Set<string>();
	const next: ChecksumMap = {};
	const added: string[] = [];
	const refreshed: string[] = [];
	const unchangedPaths: string[] = [];

	for (const absPath of files) {
		if (seen.has(absPath)) {
			continue;
		}
		seen.add(absPath);
		const previous = prev[absPath];
		try {
			if (hooks.statFile !== undefined && previous !== undefined) {
				const current = await hooks.statFile(absPath);
				if (
					current.mtimeMs === previous.mtimeMs &&
					current.size === previous.size
				) {
					next[absPath] = previous;
					unchangedPaths.push(absPath);
					continue;
				}
			}
			const content = await hooks.readFile(absPath);
			const checksum = sha256Hex(content);
			let currentStat: FileStat = { mtimeMs: 0, size: 0 };
			if (hooks.statFile !== undefined) {
				currentStat = await hooks.statFile(absPath);
			}
			next[absPath] = {
				checksum,
				mtimeMs: currentStat.mtimeMs,
				size: currentStat.size,
			};
			if (previous === undefined) {
				added.push(absPath);
			} else if (previous.checksum !== checksum) {
				refreshed.push(absPath);
			} else {
				unchangedPaths.push(absPath);
			}
		} catch (error: unknown) {
			if (!isEnoent(error)) {
				throw error;
			}
		}
	}

	const removed = Object.keys(prev)
		.filter((absPath) => !seen.has(absPath) || next[absPath] === undefined)
		.sort();
	const refreshedPaths = [...refreshed].sort();
	const changed = [...added, ...refreshedPaths].sort();
	unchangedPaths.sort();
	return {
		unchanged: changed.length === 0 && removed.length === 0,
		changed,
		added: [...added].sort(),
		removed,
		refreshedPaths,
		unchangedPaths,
		next,
	};
}

/** Read-only check for the `/reload` path: verifies checksums without rescanning. */
export async function verifyChecksums(
	cachePath: string,
	hooks: CacheHooks,
	warn?: Warn,
): Promise<VerifyResult> {
	const { unchanged, changed, added, removed } = await verifyWithMap(
		cachePath,
		hooks,
		warn,
	);
	return { unchanged, changed, added, removed };
}

/** Full refresh: list → stat pre-filter → checksum candidates, then persist. */
export async function refreshCache(
	cachePath: string,
	hooks: CacheHooks,
	warn?: Warn,
): Promise<RefreshReport> {
	const verification = await verifyWithMap(cachePath, hooks, warn);
	await saveChecksumMap(cachePath, verification.next);
	return {
		added: verification.added,
		refreshed: verification.refreshedPaths,
		removed: verification.removed,
		unchanged: verification.unchangedPaths,
	};
}
