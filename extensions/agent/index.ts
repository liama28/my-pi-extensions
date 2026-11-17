/**
 * Claude Code-style sub-agents for pi.
 *
 * Tools (Claude Code's names and parameters, so Anthropic models use them natively):
 *   Agent        launch a sub-agent (background in TUI/RPC, blocking in -p/json)
 *   SendMessage  steer a running agent, or resume a finished one with its context
 *   ListAgents   list this session's agents
 *   TaskStop     stop a running agent
 *
 * Agent types: bundled ./agents/*.md, ~/.pi/agent/agents/*.md, .pi/agents/*.md.
 * Defaults: "subagents": { "model", "effort" } in pi's settings.json (see subagentDefaults).
 * Background results come back as a <task-notification> message that steers the
 * running turn, or starts a new turn when the main agent is idle.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentDefinition, findAgent, loadAgents } from "./agents.ts";
import { MODEL_ALIASES, resolveModel } from "./models.ts";
import { AgentRun, childRuntime, type TurnOutcome } from "./runner.ts";
import {
	AGENT_PARAMS,
	agentDescription,
	LAUNCHED,
	LIST_AGENTS_DESCRIPTION,
	SEND_MESSAGE_DESCRIPTION,
	SEND_MESSAGE_PARAMS,
	TASK_STOP_DESCRIPTION,
	frameNotification,
	taskNotification,
} from "./text.ts";

const NOTIFICATION_TYPE = "agent-notification";
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Every pi thinking level, accepted in the settings default. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Sub-agent defaults from pi's settings (`~/.pi/agent/settings.json`, overridden
 * per project by `.pi/settings.json`):
 *
 *   "subagents": { "model": "sonnet", "effort": "medium" }
 *
 * `model` takes the same values as an agent file's `model:` (an alias, "inherit",
 * or provider/model-id); `effort` any pi thinking level. A malformed value fails
 * the Agent call loudly rather than being silently ignored.
 */
function subagentDefaults(pi: ExtensionAPI): { model?: string; effort?: string } {
	const raw = (pi.getSettings() as Record<string, unknown>).subagents;
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error('settings "subagents" must be an object like { "model": "sonnet", "effort": "medium" }');
	const { model, effort } = raw as Record<string, unknown>;
	if (model !== undefined && (typeof model !== "string" || !model.trim())) throw new Error('settings "subagents.model" must be a non-empty string');
	if (effort !== undefined && (typeof effort !== "string" || !THINKING_LEVELS.includes(effort))) {
		throw new Error(`settings "subagents.effort" must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return { model: model as string | undefined, effort: effort as string | undefined };
}

interface AgentToolDetails {
	id?: string;
	agentType?: string;
	description?: string;
	model?: string;
	background?: boolean;
	status?: string;
	toolUses?: number;
	durationMs?: number;
	activity?: string;
}

interface NotificationDetails {
	id: string;
	agentType: string;
	description: string;
	status: TurnOutcome["status"];
	toolUses: number;
	durationMs: number;
	result: string;
}

const formatDuration = (ms: number) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const modelLabel = (run: AgentRun) => `${run.model.provider}/${run.model.id}${run.thinking ? ` (effort: ${run.thinking})` : ""}`;

export default function agentExtension(pi: ExtensionAPI) {
	const runs = new Map<string, AgentRun>();
	/** Agents the main model stopped itself: their "stopped" turn is not news. */
	const stoppedByModel = new Set<string>();
	let ctxRef: ExtensionContext | undefined;
	let shuttingDown = false;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;

	// --- helpers --------------------------------------------------------------

	const newId = (def: AgentDefinition) => {
		const slug = def.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
		let id: string;
		do id = `${slug}-${randomBytes(2).toString("hex")}`;
		while (runs.has(id));
		return id;
	};

	const findRun = (ref: string) => {
		const key = ref.trim().toLowerCase();
		return runs.get(ref.trim()) ?? [...runs.values()].find((r) => r.id.toLowerCase() === key);
	};

	/** Where a child's session file lives: beside the parent's, under subagents/<parent-id>/. */
	const childSessionDir = (ctx: ExtensionContext): string | undefined => {
		if (!ctx.sessionManager.getSessionFile()) return undefined;
		return join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId());
	};

	const notifyParent = (run: AgentRun, outcome: TurnOutcome, toolUseId?: string) => {
		if (shuttingDown) return;
		if (outcome.status === "stopped" && stoppedByModel.delete(run.id)) return;
		const notification = taskNotification({
			id: run.id,
			toolUseId,
			status: outcome.status,
			description: run.description,
			result: outcome.text,
			tokens: run.contextTokens,
			toolUses: outcome.toolUses,
			durationMs: outcome.durationMs,
		});
		let opensTurn = false;
		try {
			opensTurn = ctxRef?.isIdle() ?? false;
		} catch {
			// Stale context: treat as mid-turn.
		}
		const content = frameNotification(notification, opensTurn);
		try {
			pi.sendMessage<NotificationDetails>(
				{
					customType: NOTIFICATION_TYPE,
					content,
					display: true,
					details: {
						id: run.id,
						agentType: run.def.name,
						description: run.description,
						status: outcome.status,
						toolUses: outcome.toolUses,
						durationMs: outcome.durationMs,
						result: outcome.text,
					},
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch {
			// The session was replaced under us; nothing to deliver to.
		}
	};

	// --- widget ---------------------------------------------------------------

	const renderWidget = () => {
		renderTimer = undefined;
		const ctx = ctxRef;
		if (!ctx?.hasUI || shuttingDown) return;
		const running = [...runs.values()].filter((r) => r.status === "running");
		try {
			if (running.length === 0) {
				ctx.ui.setWidget("agents", undefined);
				return;
			}
			const t = ctx.ui.theme;
			const lines = running.map((r) => {
				const stats = t.fg("dim", ` · ${formatDuration(Date.now() - r.turnStartedAt)} · ${r.toolUses} tools${r.activity ? ` · ${r.activity}` : ""}`);
				return `${t.fg("accent", "⏳")} ${t.bold(r.def.name)} ${r.description}${stats}`;
			});
			ctx.ui.setWidget("agents", lines, { placement: "belowEditor" });
		} catch {
			// Stale context after a session switch.
		}
	};

	const scheduleRender = () => {
		if (!renderTimer) renderTimer = setTimeout(renderWidget, 150);
		const anyRunning = [...runs.values()].some((r) => r.status === "running");
		if (anyRunning && !tickTimer) {
			tickTimer = setInterval(renderWidget, 1000);
			tickTimer.unref?.();
		} else if (!anyRunning && tickTimer) {
			clearInterval(tickTimer);
			tickTimer = undefined;
		}
	};

	// --- tools ------------------------------------------------------------------

	const agentParams = Type.Object({
		description: Type.String({ description: AGENT_PARAMS.description }),
		prompt: Type.String({ description: AGENT_PARAMS.prompt }),
		subagent_type: Type.Optional(Type.String({ description: AGENT_PARAMS.subagent_type })),
		model: Type.Optional(StringEnum(MODEL_ALIASES, { description: AGENT_PARAMS.model })),
		effort: Type.Optional(StringEnum(EFFORT_LEVELS, { description: AGENT_PARAMS.effort })),
	});

	const registerAgentTool = (agents: AgentDefinition[], background: boolean) => {
		pi.registerTool({
			name: "Agent",
			label: "Agent",
			description: agentDescription(agents, background),
			promptSnippet: "Launch a sub-agent for complex, multi-step, or parallel work in its own context window",
			parameters: agentParams,
			prepareArguments(args) {
				// Older Claude Code builds called the instruction `task`.
				const input = (args ?? {}) as Record<string, unknown>;
				if (input.prompt === undefined && typeof input.task === "string") return { ...input, prompt: input.task } as never;
				return args as never;
			},

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const agents = loadAgents(ctx.cwd, ctx.isProjectTrusted());
				const typeName = params.subagent_type?.trim() || "general-purpose";
				if (typeName.toLowerCase() === "fork") {
					throw new Error('subagent_type "fork" is not supported yet. Use general-purpose with a self-contained prompt.');
				}
				const def = findAgent(agents, typeName);
				if (!def) {
					throw new Error(`Unknown subagent_type "${typeName}". Available agent types: ${agents.map((a) => a.name).join(", ")}`);
				}
				const prompt = params.prompt?.trim();
				if (!prompt) throw new Error("prompt is required: the complete, self-contained task for the agent");
				const description = params.description?.trim() || prompt.slice(0, 40);

				// Precedence: this call's parameter → the agent file → the settings default → the main session.
				const defaults = subagentDefaults(pi);
				const model = await resolveModel(await childRuntime(), params.model ?? def.model ?? defaults.model, ctx.model);
				const thinking = params.effort ?? def.effort ?? defaults.effort ?? pi.getThinkingLevel();
				const id = newId(def);
				const run = new AgentRun({
					id,
					def,
					description,
					cwd: ctx.cwd,
					model,
					thinking,
					sessionDir: childSessionDir(ctx),
					onChange: scheduleRender,
				});
				runs.set(id, run);
				const details: AgentToolDetails = { id, agentType: def.name, description, model: modelLabel(run) };

				// Background whenever there is a live session to notify; -p/json would exit before the report.
				if (ctx.hasUI) {
					void run.runTurn(prompt, (outcome) => notifyParent(run, outcome, toolCallId));
					return {
						content: [{ type: "text", text: LAUNCHED(id, def.name) }],
						details: { ...details, background: true, status: "running" },
					};
				}

				const onAbort = () => void run.stop();
				signal?.addEventListener("abort", onAbort, { once: true });
				const progress = setInterval(() => {
					onUpdate?.({
						content: [{ type: "text", text: run.activity || "working" }],
						details: { ...details, status: "running", toolUses: run.toolUses, activity: run.activity },
					});
				}, 1000);
				try {
					const outcome = await run.runTurn(prompt);
					return {
						content: [
							{
								type: "text",
								text: `${outcome.text}\n\nagentId: ${id} (use SendMessage with to: "${id}" to continue this agent)\n<usage>tool_uses: ${outcome.toolUses}, duration_ms: ${outcome.durationMs}</usage>`,
							},
						],
						details: { ...details, status: outcome.status, toolUses: outcome.toolUses, durationMs: outcome.durationMs },
						isError: outcome.status !== "completed",
					};
				} finally {
					clearInterval(progress);
					signal?.removeEventListener("abort", onAbort);
				}
			},

			renderCall(args, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const type = args.subagent_type || "general-purpose";
				let line = `${theme.fg("toolTitle", theme.bold("Agent"))} ${theme.fg("accent", type)}`;
				if (args.description) line += ` ${args.description}`;
				if (args.model || args.effort) line += theme.fg("dim", ` (${[args.model, args.effort].filter(Boolean).join(", ")})`);
				text.setText(line);
				return text;
			},

			renderResult(result, { expanded, isPartial }, theme) {
				const d = (result.details ?? {}) as AgentToolDetails;
				if (isPartial) {
					return new Text(theme.fg("dim", `${d.toolUses ?? 0} tools · ${d.activity || "working"}`), 0, 0);
				}
				if (d.background) {
					return new Text(theme.fg("dim", `⏳ running in background · ${d.id} · ${d.model}`), 0, 0);
				}
				const body = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
				const ok = d.status === "completed";
				const head = `${ok ? theme.fg("success", "✓") : theme.fg("error", "✗")} ${d.status ?? "done"} · ${d.toolUses ?? 0} tools · ${formatDuration(d.durationMs ?? 0)}`;
				return new Text(expanded ? `${head}\n${body}` : head, 0, 0);
			},
		});
	};

	pi.registerTool({
		name: "SendMessage",
		label: "SendMessage",
		description: SEND_MESSAGE_DESCRIPTION,
		parameters: Type.Object({
			to: Type.String({ description: SEND_MESSAGE_PARAMS.to }),
			message: Type.String({ description: SEND_MESSAGE_PARAMS.message }),
			summary: Type.Optional(Type.String({ description: SEND_MESSAGE_PARAMS.summary })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const run = findRun(params.to);
			if (!run) {
				const known = [...runs.keys()];
				throw new Error(`No agent with ID "${params.to}".${known.length ? ` Known agents: ${known.join(", ")}` : " No agents have been launched in this session."}`);
			}
			const message = params.message.trim();
			if (!message) throw new Error("message is empty");

			const live = await run.deliverLive(message);
			if (live === "steered") {
				return { content: [{ type: "text", text: `Message delivered to ${run.id}; it will see it before its next step. Its completion notification will reflect it.` }], details: {} };
			}
			if (live === "queued") {
				return { content: [{ type: "text", text: `${run.id} is finishing its current turn; your message will start its next turn. Its reply will arrive as a task notification.` }], details: {} };
			}

			if (ctx.hasUI) {
				void run.runTurn(message, (outcome) => notifyParent(run, outcome));
				return {
					content: [{ type: "text", text: `${run.id} resumed with your message. Its reply will arrive as a task notification — do not predict it.` }],
					details: {},
				};
			}
			const onAbort = () => void run.stop();
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const outcome = await run.runTurn(message);
				return { content: [{ type: "text", text: outcome.text }], details: {}, isError: outcome.status !== "completed" };
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`${theme.fg("toolTitle", theme.bold("SendMessage"))} ${theme.fg("accent", args.to ?? "")} ${theme.fg("dim", args.summary ?? "")}`);
			return text;
		},
	});

	pi.registerTool({
		name: "ListAgents",
		label: "ListAgents",
		description: LIST_AGENTS_DESCRIPTION,
		executionMode: "sequential",
		parameters: Type.Object({}),
		async execute() {
			if (runs.size === 0) return { content: [{ type: "text", text: "No agents have been launched in this session." }], details: {} };
			const lines = [...runs.values()].map((r) => {
				const elapsed = r.status === "running" ? ` · running for ${formatDuration(Date.now() - r.turnStartedAt)}` : "";
				return `- ${r.id} (${r.def.name}) "${r.description}" — ${r.status}${elapsed} · ${modelLabel(r)}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	pi.registerTool({
		name: "TaskStop",
		label: "TaskStop",
		description: TASK_STOP_DESCRIPTION,
		executionMode: "sequential",
		parameters: Type.Object({ task_id: Type.String({ description: "The ID of the agent to stop" }) }),
		prepareArguments(args) {
			const input = (args ?? {}) as Record<string, unknown>;
			if (input.task_id === undefined && typeof input.shell_id === "string") return { task_id: input.shell_id } as never;
			return args as never;
		},
		async execute(_toolCallId, params) {
			const run = findRun(params.task_id);
			if (!run) throw new Error(`No agent with ID "${params.task_id}".`);
			if (run.status !== "running") return { content: [{ type: "text", text: `${run.id} is not running (status: ${run.status}).` }], details: {} };
			stoppedByModel.add(run.id);
			await run.stop();
			return { content: [{ type: "text", text: `Stopped ${run.id}. It can be resumed later with SendMessage.` }], details: {} };
		},
	});

	// --- notification rendering --------------------------------------------------

	pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, (message, { expanded }, theme) => {
		const d = message.details;
		if (!d) return new Text(typeof message.content === "string" ? message.content : "", 0, 0);
		const icon = d.status === "completed" ? theme.fg("success", "✓") : d.status === "failed" ? theme.fg("error", "✗") : theme.fg("warning", "■");
		const verb = d.status === "completed" ? "finished" : d.status;
		const head = `${icon} ${theme.bold(d.agentType)} ${d.description} ${theme.fg("dim", `${verb} · ${d.toolUses} tools · ${formatDuration(d.durationMs)} · ${d.id}`)}`;
		return new Text(expanded ? `${head}\n\n${d.result}` : head, 0, 0);
	});

	// --- /agents command ------------------------------------------------------------

	pi.registerCommand("agents", {
		description: "List sub-agents; select a running one to stop it",
		handler: async (_args, ctx) => {
			if (runs.size === 0) {
				ctx.ui.notify("No agents in this session.", "info");
				return;
			}
			const list = [...runs.values()];
			const labels = list.map((r) => `${r.status === "running" ? "⏳" : r.status === "completed" ? "✓" : "✗"} ${r.id}  ${r.description}  [${r.status}, ${formatTokens(r.contextTokens)} tok, $${r.cost.toFixed(3)}]`);
			const choice = await ctx.ui.select("Agents", labels);
			if (choice === undefined) return;
			const run = list[labels.indexOf(choice)];
			if (!run) return;
			if (run.status === "running") {
				if (await ctx.ui.confirm("Stop agent?", `${run.id}: ${run.description}`)) await run.stop();
			} else if (run.lastResult) {
				ctx.ui.notify(run.lastResult.text.slice(0, 2000), "info");
			}
		},
	});

	// --- lifecycle ------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		ctxRef = ctx;
		registerAgentTool(loadAgents(ctx.cwd, ctx.isProjectTrusted()), ctx.hasUI);
		// Warm the shared model runtime so the first spawn doesn't pay for it.
		void childRuntime().catch(() => undefined);
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		if (renderTimer) clearTimeout(renderTimer);
		if (tickTimer) clearInterval(tickTimer);
		renderTimer = tickTimer = undefined;
		try {
			ctxRef?.ui.setWidget("agents", undefined);
		} catch {
			// ignore
		}
		for (const run of runs.values()) run.dispose();
		runs.clear();
		stoppedByModel.clear();
		ctxRef = undefined;
	});
}
