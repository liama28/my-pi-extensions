/**
 * Model selection for sub-agents: Claude Code's aliases (sonnet, opus, haiku,
 * fable) resolve to the newest matching model on the parent's provider.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

/** `claude-opus-5-5` → [5, 5]; dated snapshots (`-20251101`) and non-matching ids → undefined. */
function aliasVersion(id: string, alias: string): number[] | undefined {
	if (/\d{8}/.test(id)) return undefined;
	const match = new RegExp(`claude-${alias}-(\\d{1,2})(?:-(\\d{1,2}))?(?!\\d)`).exec(id);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2] ?? 0)];
}

function newest(models: readonly Model<Api>[], alias: string): Model<Api> | undefined {
	let best: { model: Model<Api>; version: number[] } | undefined;
	for (const model of models) {
		const version = aliasVersion(model.id, alias);
		if (!version) continue;
		if (!best || version[0] > best.version[0] || (version[0] === best.version[0] && version[1] > best.version[1])) {
			best = { model, version };
		}
	}
	return best?.model;
}

/**
 * Resolve a model spec for a child. `undefined`/"inherit" → the parent's model.
 * Throws with a helpful message when nothing matches.
 */
export async function resolveModel(runtime: ModelRuntime, spec: string | undefined, parent: Model<Api> | undefined): Promise<Model<Api>> {
	const inherit = () => {
		if (!parent) throw new Error("no model is selected in the main session to inherit");
		return runtime.getModel(parent.provider, parent.id) ?? parent;
	};
	const wanted = spec?.trim();
	if (!wanted || wanted.toLowerCase() === "inherit") return inherit();

	const available = await runtime.getAvailable();
	const alias = wanted.toLowerCase();
	if ((MODEL_ALIASES as readonly string[]).includes(alias)) {
		const sameProvider = parent ? available.filter((m) => m.provider === parent.provider) : [];
		const found = newest(sameProvider, alias) ?? newest(available, alias);
		if (found) return found;
		throw new Error(`no "${alias}" model is available${parent ? ` on provider ${parent.provider}` : ""}`);
	}

	const slash = wanted.indexOf("/");
	if (slash > 0) {
		const found = runtime.getModel(wanted.slice(0, slash), wanted.slice(slash + 1));
		if (found) return found;
	}
	const byId = available.find((m) => m.id === wanted && m.provider === parent?.provider) ?? available.find((m) => m.id === wanted);
	if (byId) return byId;
	throw new Error(`model "${wanted}" was not found (use sonnet, opus, haiku, fable, inherit, or provider/model-id)`);
}
