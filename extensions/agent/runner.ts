/**
 * One sub-agent run: an in-process pi AgentSession with its own context window.
 *
 * The session is built with `noExtensions: true`, so a child never loads this
 * extension (no recursive Agent tool) or any UI extension. It is persisted under
 * the parent's session dir so a finished agent can be resumed by SendMessage
 * after its live session has been released.
 */

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type AgentDefinition, childTools } from "./agents.ts";

export type RunStatus = "running" | "completed" | "failed" | "stopped";

export interface TurnOutcome {
	status: Exclude<RunStatus, "running">;
	text: string;
	toolUses: number;
	durationMs: number;
}

/** Release an idle child's live session after this long; its session file keeps it resumable. */
const IDLE_RELEASE_MS = Number(process.env.PI_AGENT_IDLE_RELEASE_MS) || 10 * 60_000;
/** Hard cap on one turn — a hung child shares the main event loop. */
const TURN_CAP_MS = 30 * 60_000;

let runtimePromise: Promise<ModelRuntime> | undefined;
/** One model/auth runtime shared by every child. */
export function childRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= ModelRuntime.create().catch((error) => {
		runtimePromise = undefined;
		throw error;
	});
	return runtimePromise;
}

/** Appended to every child's system prompt (pi has no other way to tell it it's a sub-agent). */
const SUBAGENT_NOTE = [
	"You are running as a sub-agent, launched by another agent to handle one task.",
	"The person writing to you is that agent, not the user. You cannot ask it follow-up questions: make reasonable assumptions, note them, and finish the task.",
	"Your final message is your report: it is returned verbatim to the agent that launched you. Make it complete and self-contained.",
].join("\n");

export interface AgentRunInit {
	id: string;
	def: AgentDefinition;
	description: string;
	cwd: string;
	model: Model<Api>;
	thinking?: string;
	/** Directory for the persisted child session; undefined → in-memory only. */
	sessionDir?: string;
	/** Called whenever progress or status changes (widget refresh). */
	onChange: () => void;
}

export class AgentRun {
	readonly id: string;
	readonly def: AgentDefinition;
	readonly description: string;
	readonly cwd: string;
	readonly model: Model<Api>;
	readonly thinking?: string;
	readonly createdAt = Date.now();

	status: RunStatus = "running";
	turnStartedAt = Date.now();
	/** Tool calls in the current turn. */
	toolUses = 0;
	/** Context size of the latest assistant message. */
	contextTokens = 0;
	/** Cumulative cost of every child request. */
	cost = 0;
	/** One-line description of what the agent is doing now. */
	activity = "starting";
	lastResult?: TurnOutcome;

	private readonly sessionDir?: string;
	private sessionFile?: string;
	private session?: AgentSession;
	private unsubscribe?: () => void;
	private turnActive = false;
	private turnSettled?: Promise<void>;
	private stopRequested = false;
	private pendingMessage?: string;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private readonly onChange: () => void;

	constructor(init: AgentRunInit) {
		this.id = init.id;
		this.def = init.def;
		this.description = init.description;
		this.cwd = init.cwd;
		this.model = init.model;
		this.thinking = init.thinking;
		this.sessionDir = init.sessionDir;
		this.onChange = init.onChange;
	}

	get busy(): boolean {
		return this.turnActive;
	}

	/**
	 * Run one turn to completion. `onDone` receives this turn's outcome (and the
	 * outcome of any message that arrived as the turn was settling, which runs as
	 * a follow-up turn).
	 */
	async runTurn(text: string, onDone?: (outcome: TurnOutcome) => void): Promise<TurnOutcome> {
		this.clearIdleTimer();
		this.turnActive = true;
		let settle!: () => void;
		this.turnSettled = new Promise<void>((resolve) => (settle = resolve));
		this.stopRequested = false;
		this.status = "running";
		this.turnStartedAt = Date.now();
		this.toolUses = 0;
		this.activity = "thinking";
		this.onChange();

		let outcome: TurnOutcome;
		const cap = setTimeout(() => {
			this.stopRequested = true;
			void this.session?.abort();
		}, TURN_CAP_MS);
		cap.unref?.();
		try {
			const session = await this.ensureSession();
			if (this.stopRequested) throw new Error("stopped before start");
			await session.prompt(text, { expandPromptTemplates: false });
			outcome = this.readOutcome();
		} catch (error) {
			outcome = {
				status: this.stopRequested ? "stopped" : "failed",
				text: this.stopRequested ? "(agent was stopped)" : `Agent failed: ${(error as Error).message}`,
				toolUses: this.toolUses,
				durationMs: Date.now() - this.turnStartedAt,
			};
		} finally {
			clearTimeout(cap);
		}

		this.turnActive = false;
		this.status = outcome.status;
		this.lastResult = outcome;
		this.activity = "";
		settle();
		this.onChange();
		onDone?.(outcome);

		// A message that arrived while the turn was settling starts the next turn.
		const pending = this.pendingMessage;
		this.pendingMessage = undefined;
		if (pending !== undefined && outcome.status !== "stopped" && !this.disposed) {
			void this.runTurn(pending, onDone);
		} else {
			this.armIdleTimer();
		}
		return outcome;
	}

	/**
	 * Deliver a message to a running agent: steered into its current turn, or held
	 * for the next turn if the turn is just settling. Returns false when the agent
	 * is not running (the caller starts a new turn instead).
	 */
	async deliverLive(message: string): Promise<"steered" | "queued" | false> {
		if (!this.turnActive) return false;
		if (this.session && !this.session.isIdle) {
			await this.session.steer(message);
			return "steered";
		}
		this.pendingMessage = this.pendingMessage === undefined ? message : `${this.pendingMessage}\n\n${message}`;
		return "queued";
	}

	/** Abort the current turn and wait until it has settled (status is final on return). */
	async stop(): Promise<void> {
		if (!this.turnActive) return;
		this.stopRequested = true;
		this.pendingMessage = undefined;
		await this.session?.abort().catch(() => undefined);
		await this.turnSettled;
	}

	dispose(): void {
		this.disposed = true;
		this.clearIdleTimer();
		this.pendingMessage = undefined;
		this.releaseSession();
	}

	// ---------------------------------------------------------------------------

	private async ensureSession(): Promise<AgentSession> {
		if (this.session) return this.session;
		const agentDir = getAgentDir();
		const resume = this.sessionFile !== undefined;

		const loader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			...(this.def.systemPrompt ? { systemPrompt: this.def.systemPrompt } : {}),
			appendSystemPrompt: [SUBAGENT_NOTE],
		});
		await loader.reload();

		const settingsManager = SettingsManager.create(this.cwd, agentDir);
		// Cache warming an idle child would spend money keeping a dead cache alive.
		settingsManager.applyOverrides({ cacheWarming: "off" });

		const sessionManager = resume
			? SessionManager.open(this.sessionFile!, undefined, this.cwd)
			: this.sessionDir
				? SessionManager.create(this.cwd, this.sessionDir)
				: SessionManager.inMemory(this.cwd);

		const { tools, excludeTools } = childTools(this.def);
		const { session } = await createAgentSession({
			cwd: this.cwd,
			agentDir,
			modelRuntime: await childRuntime(),
			model: this.model,
			...(this.thinking ? { thinkingLevel: this.thinking as never } : {}),
			tools,
			excludeTools,
			resourceLoader: loader,
			sessionManager,
			settingsManager,
			sessionStartEvent: { type: "session_start", reason: resume ? "resume" : "startup" },
		});
		await session.bindExtensions({});
		if (this.disposed) {
			session.dispose();
			throw new Error("agent was disposed");
		}
		this.session = session;
		this.sessionFile = session.sessionFile ?? this.sessionFile;
		this.unsubscribe = session.subscribe((event) => this.onEvent(event));
		return session;
	}

	private onEvent(event: unknown): void {
		try {
			const e = event as { type?: string; toolName?: string; args?: unknown; message?: Record<string, unknown> };
			if (e.type === "tool_execution_start") {
				this.toolUses++;
				this.activity = describeToolCall(e.toolName ?? "tool", e.args);
				this.onChange();
			} else if (e.type === "message_end" && e.message?.role === "assistant") {
				const usage = e.message.usage as { totalTokens?: number; cost?: { total?: number } } | undefined;
				if (usage?.totalTokens) this.contextTokens = usage.totalTokens;
				this.cost += usage?.cost?.total ?? 0;
				this.onChange();
			}
			// Keep the session file path current: pi writes it with the first assistant reply.
			if (!this.sessionFile && this.session?.sessionFile) this.sessionFile = this.session.sessionFile;
		} catch {
			// Never throw into the child's event loop.
		}
	}

	private readOutcome(): TurnOutcome {
		const base = { toolUses: this.toolUses, durationMs: Date.now() - this.turnStartedAt };
		const messages = (this.session?.messages ?? []) as unknown as Array<Record<string, unknown>>;
		const last = [...messages].reverse().find((m) => m.role === "assistant");
		const stopReason = last?.stopReason as string | undefined;
		const text = this.session?.getLastAssistantText()?.trim() ?? "";
		if (this.stopRequested || stopReason === "aborted") {
			return { ...base, status: "stopped", text: text ? `(agent was stopped) Partial output:\n${text}` : "(agent was stopped)" };
		}
		if (stopReason === "error") {
			return { ...base, status: "failed", text: `Agent failed: ${(last?.errorMessage as string | undefined) ?? "unknown error"}${text ? `\n\nPartial output:\n${text}` : ""}` };
		}
		return { ...base, status: "completed", text: text || "(agent finished without a final message)" };
	}

	private armIdleTimer(): void {
		this.clearIdleTimer();
		// An in-memory child can't be reopened, so it stays live until shutdown.
		if (!this.sessionFile || this.disposed) return;
		this.idleTimer = setTimeout(() => {
			if (!this.turnActive) this.releaseSession();
		}, IDLE_RELEASE_MS);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private releaseSession(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const session = this.session;
		this.session = undefined;
		if (session) {
			void session
				.abort()
				.catch(() => undefined)
				.finally(() => session.dispose());
		}
	}
}

/** A short "what is it doing" line for the widget. */
export function describeToolCall(toolName: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const pick = (...keys: string[]) => keys.map((k) => a[k]).find((v): v is string => typeof v === "string" && v.length > 0);
	const detail = pick("command", "path", "pattern", "file_path", "query", "url") ?? "";
	const oneLine = detail.replace(/\s+/g, " ").trim();
	return oneLine ? `${toolName} ${oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine}` : toolName;
}
