/**
 * pi-rules — PROTOTYPE (rough fidelity sketch, not shippable).
 *
 * Decision coverage (see ../../map.md):
 * - 03: recursive `**\/*.md` scan of global `~/.pi/agent/rules` + project `.pi/rules`;
 *        global first, project second, concat, identical relative paths shadow.
 * - 04: `metadata.rule_tier: system | general` (default `general`, unknown warns +
 *        falls back); `paths:` scoping follows claude-rules globs/budgets.
 * - 05: tier = HOW (system full / general index), paths = WHEN (unscoped always,
 *        scoped while a match is active); systemPrompt-only channel; cumulative
 *        Read+Write activation; checksum-gated refresh via
 *        `pi-better-rules-checksums.json`; `/reload` verifies instead of rescanning.
 * - Extra: load-time warnings must render DIMMED (open fidelity gap — see `warn()`).
 *
 * Fidelity gaps to react to (marked GAP below).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Tier = "system" | "general";

interface Rule {
  rel: string; // relative path within its tree (shadow key)
  abs: string; // absolute path
  scope: "global" | "project";
  tier: Tier;
  paths?: string[]; // claude-style globs; undefined = unscoped
  summary: string; // first heading / first line, for the general index
  text: string; // full markdown body minus frontmatter
}

const GLOBAL_DIR = path.join(process.env.HOME ?? "~", ".pi", "agent", "rules");
const CHECKSUM_FILE = "pi-better-rules-checksums.json";

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const MAX_WALK_DEPTH = 5; // decision: symlink-aware walk caps at depth 5

function findMarkdownFiles(
  dir: string,
  base = "",
  depth = 0,
  seen = new Set<string>(),
): string[] {
  if (!fs.existsSync(dir) || depth > MAX_WALK_DEPTH) return [];
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return []; // broken symlink — warn at call site via missing-file note
  }
  if (seen.has(real)) return []; // symlink cycle resistance
  seen.add(real);
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
      } catch {
        continue; // dangling symlink
      }
    }
    if (isDir) out.push(...findMarkdownFiles(full, rel, depth + 1, seen));
    else if (e.name.endsWith(".md")) out.push(rel); // files + file symlinks
  }
  return out;
}

/** Minimal frontmatter parse: metadata.rule_tier + paths. Unknown tier warns. */
function parseRule(
  abs: string,
  rel: string,
  scope: "global" | "project",
  warn: (m: string) => void,
): Rule | null {
  const raw = fs.readFileSync(abs, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  let tier: Tier = "general";
  let paths: string[] | undefined;
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    const tierM = m[1].match(/rule_tier\s*:\s*(\S+)/);
    if (tierM) {
      if (tierM[1] === "system" || tierM[1] === "general") tier = tierM[1];
      else
        warn(
          `${rel}: unknown metadata.rule_tier "${tierM[1]}" — falling back to general`,
        );
    }
    const pathsM = m[1].match(/paths\s*:\s*\[([^\]]*)\]/);
    if (pathsM)
      paths = pathsM[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
  }
  const summary = (
    body.match(/^#\s+(.+)/m)?.[1] ??
    body.split("\n").find((l) => l.trim()) ??
    rel
  ).trim();
  return { rel, abs, scope, tier, paths, summary, text: body.trim() };
}

/** Claude `paths:` semantics: `**` crosses separators, `*`/`?` stay in-segment,
 *  `{a,b}` brace expansion, `[...]` classes, `\[` escapes a literal bracket.
 *  Whole-list budgets (1000 expanded patterns): breach warns and falls back to
 *  literal matching for that rule. */
function expandBraces(p: string): string[] {
  const m = p.match(/\{([^{}]*)\}/);
  if (!m || m.index === undefined) return [p];
  return m[1]
    .split(",")
    .flatMap((part) =>
      expandBraces(p.slice(0, m.index) + part + p.slice(m.index + m[0].length)),
    );
}

function globToRegExp(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          re += "(.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const j = p.indexOf("]", i);
      if (j > i) {
        re += p.slice(i, j + 1);
        i = j;
      } else re += "\\[";
    } else if (c === "\\" && i + 1 < p.length) {
      re += "\\" + p[++i];
    } else re += /[.+^${}()|]/.test(c) ? "\\" + c : c;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(
  patterns: string[],
  file: string,
  warn: (m: string) => void,
  rel: string,
): boolean {
  const expanded = patterns.flatMap(expandBraces);
  const pats =
    expanded.length > 1000
      ? (warn(`${rel}: paths exceed 1000-pattern budget — matching literally`),
        patterns)
      : expanded;
  return pats.some((p) => {
    try {
      return globToRegExp(p).test(file);
    } catch {
      return false; // invalid pattern matches nothing, siblings keep working
    }
  });
}

export default function piRulesPrototype(pi: ExtensionAPI) {
  let rules: Rule[] = [];
  // Cumulative activation set: files read OR written so far this session.
  const touched = new Set<string>();
  const activeRules = () => {
    const isActive = (r: Rule) =>
      !r.paths ||
      [...touched].some((f) => matchesAny(r.paths!, f, warn, r.rel));
    return {
      sys: rules.filter((r) => r.tier === "system" && isActive(r)),
      gen: rules.filter((r) => r.tier === "general" && isActive(r)),
    };
  };
  // Checksum map persists on disk (see `checksumsPath`): /reload wipes memory.
  let checksumsPath = "";

  // Official user-facing channel (ExtensionUIContext.notify, types.d.ts:76):
  // load warnings go out at "warning" level — the dimmed-adjacent style.
  // (TUI renders info/error; "warning" is the sanctioned middle channel.)
  let notifyWarn: (msg: string) => void = (msg) =>
    console.log(`[pi-rules] ${msg}`);
  const warn = (msg: string) => notifyWarn(msg);

  const scan = (
    projectDir: string,
    ctx: { ui: { notify: (m: string, l: string) => void } },
  ) => {
    const found = new Map<string, Rule>();
    for (const [dir, scope] of [
      [GLOBAL_DIR, "global"],
      [projectDir, "project"],
    ] as const) {
      for (const rel of findMarkdownFiles(dir)) {
        const rule = parseRule(path.join(dir, rel), rel, scope, warn);
        if (rule) {
          if (scope === "project" && found.has(rel))
            warn(`${rel}: project shadows global copy`);
          found.set(rel, rule);
        }
      }
    }
    rules = [...found.values()];
    const counts = {
      system: rules.filter((r) => r.tier === "system" && !r.paths).length,
      general: rules.filter((r) => r.tier === "general" && !r.paths).length,
      scoped: rules.filter((r) => r.paths).length,
    };
    ctx.ui.notify(
      `pi-rules: ${rules.length} rule(s) — ${counts.system} system, ${counts.general} general, ${counts.scoped} scoped`,
      "info",
    );
  };

  const verifyChecksums = () => {
    // GAP: only skeleton — list → stat pre-filter → checksum candidates →
    // reload changed / drop deleted / report refreshed-added-removed.
    let prev: Record<string, string> = {};
    try {
      if (fs.existsSync(checksumsPath))
        prev = JSON.parse(fs.readFileSync(checksumsPath, "utf8"));
    } catch {
      prev = {}; // corrupt cache → treat everything as changed
    }
    const next: Record<string, string> = {};
    const changed: string[] = [];
    for (const r of rules) {
      const sum = sha256(fs.readFileSync(r.abs, "utf8"));
      next[r.abs] = sum;
      if (prev[r.abs] !== sum) changed.push(r.rel);
    }
    fs.mkdirSync(path.dirname(checksumsPath), { recursive: true });
    fs.writeFileSync(checksumsPath, JSON.stringify(next, null, 2));
    return changed;
  };

  pi.on("session_start", async (event, ctx) => {
    const projectDir = path.join(ctx.cwd, ".pi", "rules");
    checksumsPath = path.join(ctx.cwd, ".pi", ".cache", CHECKSUM_FILE);
    notifyWarn = (msg) => ctx.ui.notify(msg, "warning"); // official warning channel
    // GAP: global checksum map (~/.pi/agent/cache/…) not wired in sketch.
    if ((event as { reason?: string }).reason === "reload") {
      const changed = verifyChecksums();
      if (changed.length > 0) scan(projectDir, ctx);
      ctx.ui.notify(
        changed.length > 0
          ? `pi-rules: refreshed ${changed.length} changed rule(s)`
          : "pi-rules: snapshot unchanged",
        "info",
      );
      return;
    }
    scan(projectDir, ctx);
  });

  // Grounded: ToolCallEvent { toolName, input } (extensions/types.d.ts:678-724)
  // and session jsonl shows read/edit/write all carry `input.path`.
  // bash {command} carries no path — excluded (documented limitation).
  pi.on("tool_call", async (event) => {
    const p = (event.input as { path?: unknown }).path;
    if (
      typeof p === "string" &&
      (event.toolName === "read" ||
        event.toolName === "edit" ||
        event.toolName === "write")
    )
      touched.add(p);
  });

  pi.on("before_agent_start", async (event) => {
    const { sys, gen } = activeRules();
    if (sys.length === 0 && gen.length === 0) return;

    const sysBlock = sys
      .map((r) => `### ${r.rel} [${r.scope}]\n${r.text}`)
      .join("\n\n");
    const genBlock = gen
      .map((r) => `- ${r.rel} [${r.scope}] — ${r.summary}`)
      .join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Rules: system tier (full)\n${sysBlock}` +
        (gen.length > 0
          ? `\n\n## Rules: general tier (index — use the read tool for full text)\n${genBlock}`
          : ""),
    };
  });

  // Mid-run reconciliation (decision Q7): each provider request full-reconciles
  // the pi-rules block by markers, so mid-run activations land on the next inner
  // turn instead of waiting for the next user prompt. Idempotent under retries:
  // the block is rebuilt deterministically (strip + re-append) every request.
  // GAP: payload shape is provider-specific — locate system instructions per provider.
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as { system?: unknown };
    if (typeof payload.system !== "string") return; // GAP: per-provider locations
    const { sys, gen } = activeRules();
    const block =
      `<!-- pi-rules:begin -->\n## Rules: system tier (full)\n` +
      sys.map((r) => `### ${r.rel} [${r.scope}]\n${r.text}`).join("\n\n") +
      (gen.length > 0
        ? `\n\n## Rules: general tier (index)\n` +
          gen.map((r) => `- ${r.rel} [${r.scope}] — ${r.summary}`).join("\n")
        : "") +
      `\n<!-- pi-rules:end -->`;
    const stripped: string = payload.system.replace(
      /<!-- pi-rules:begin -->[\s\S]*<!-- pi-rules:end -->\n?/,
      "",
    );
    return { ...event.payload, system: `${stripped}\n${block}` };
  });
}
