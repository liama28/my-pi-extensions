/**
 * Agent type discovery: markdown files with YAML frontmatter.
 *
 * Lookup order (later wins on a name clash, matched case-insensitively):
 *   1. bundled   <this extension>/agents/*.md
 *   2. user      ~/.pi/agent/agents/*.md
 *   3. project   <nearest ancestor>/.pi/agents/*.md   (only when the project is trusted)
 *
 * Frontmatter:
 *   name             agent type name (defaults to the file name)
 *   description      when to use it (shown to the main model)
 *   tools            allowlist: "*" or a list (Claude Code or pi names); omitted = all
 *   disallowedTools  denylist, applied after `tools`
 *   model            sonnet | opus | haiku | fable | inherit | provider/id
 *   effort           low | medium | high | xhigh | max (alias: thinking)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentSource = "bundled" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	/** pi tool names, or undefined for every built-in tool. */
	tools?: string[];
	disallowedTools?: string[];
	model?: string;
	effort?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

/** Every built-in pi tool a sub-agent can get. */
export const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Claude Code tool names → pi tool names, so CC-style agent files work unchanged. */
const TOOL_ALIASES: Record<string, string> = {
	read: "read",
	write: "write",
	edit: "edit",
	multiedit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
	find: "find",
	ls: "ls",
};

/** Tool names that only make sense in the main session; silently dropped from agent tool lists. */
const IGNORED_TOOLS = new Set(["agent", "task", "sendmessage", "notebookedit", "exitplanmode", "todowrite", "webfetch", "websearch"]);

function toolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const names = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	return names.length > 0 ? names : undefined;
}

/** Normalize a tool list; `*` (or no list) means every tool. Rule syntax like `Bash(git:*)` grants the whole tool. */
function normalizeTools(names: string[] | undefined): string[] | undefined {
	if (!names || names.includes("*")) return undefined;
	const out = new Set<string>();
	for (const name of names) {
		const base = name.replace(/\(.*\)$/, "").trim();
		const key = base.toLowerCase();
		if (IGNORED_TOOLS.has(key)) continue;
		out.add(TOOL_ALIASES[key] ?? base);
	}
	return [...out];
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function loadDir(dir: string, source: AgentSource): AgentDefinition[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentDefinition[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
			agents.push({
				name: str(frontmatter.name) ?? entry.name.replace(/\.md$/, ""),
				description: str(frontmatter.description) ?? "",
				tools: normalizeTools(toolList(frontmatter.tools)),
				disallowedTools: normalizeTools(toolList(frontmatter.disallowedTools)),
				model: str(frontmatter.model),
				effort: str(frontmatter.effort) ?? str(frontmatter.thinking),
				systemPrompt: body.trim(),
				source,
				filePath,
			});
		} catch {
			// One malformed file must not hide every other agent.
		}
	}
	return agents;
}

/** Nearest `.pi/agents` directory at or above `cwd` (stopping at the home directory). */
function findProjectAgentsDir(cwd: string): string | undefined {
	const home = os.homedir();
	let dir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		if (dir !== home && fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir || dir === home) return undefined;
		dir = parent;
	}
}

const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

export function loadAgents(cwd: string, projectTrusted: boolean): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	const add = (list: AgentDefinition[]) => {
		for (const agent of list) byName.set(agent.name.toLowerCase(), agent);
	};
	add(loadDir(BUNDLED_DIR, "bundled"));
	add(loadDir(path.join(getAgentDir(), "agents"), "user"));
	if (projectTrusted) {
		const projectDir = findProjectAgentsDir(cwd);
		if (projectDir) add(loadDir(projectDir, "project"));
	}
	return [...byName.values()];
}

export function findAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	const key = name.trim().toLowerCase();
	// "claude" is Claude Code's alias for its catch-all agent.
	return agents.find((a) => a.name.toLowerCase() === key) ?? (key === "claude" ? agents.find((a) => a.name === "general-purpose") : undefined);
}

/** The tools clause of a catalog line, in Claude Code's wording. */
export function toolsClause(agent: AgentDefinition): string {
	if (!agent.tools && !agent.disallowedTools?.length) return "*";
	if (!agent.tools) return `All tools except ${agent.disallowedTools!.join(", ")}`;
	const allowed = agent.tools.filter((t) => !agent.disallowedTools?.includes(t));
	return allowed.join(", ") || "none";
}

/** The pi tool selection for a child session. */
export function childTools(agent: AgentDefinition): { tools: string[]; excludeTools?: string[] } {
	return { tools: agent.tools ?? ALL_TOOLS, excludeTools: agent.disallowedTools };
}
