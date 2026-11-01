/**
 * Model metadata for one provider: the remote catalog filtered down to models
 * an agent can drive, with a transport chosen per vendor.
 */

import type { ProviderChatModelConfig } from "@earendil-works/pi-coding-agent";
import type { ProviderSettings, TransportConfig } from "./config.ts";
import type { TokenCost } from "./pricing.ts";
import { ZERO_COST } from "./pricing.ts";
import type { RemoteModel, RemoteProvider } from "./wellknown.ts";

const DEFAULT_TRANSPORT: TransportConfig = { api: "openai-completions" };

const NON_CHAT_MODEL_PATTERN =
	/(^|[-_/])(embed|embedding|rerank|moderation|whisper|tts|transcribe|realtime|image|video|audio|sora|dall)([-_/]|$)/i;

export type CostLookup = (vendor: string | undefined, modelId: string) => TokenCost;

export interface BuildOptions {
	settings: ProviderSettings;
	costFor: CostLookup;
}

export function buildModels(remote: RemoteProvider, options: BuildOptions): ProviderChatModelConfig[] {
	const catalog = new Map<string, ProviderChatModelConfig>();
	for (const [alias, model] of Object.entries(remote.models ?? {})) {
		const chatModel = toChatModel(alias, model, remote, options);
		if (chatModel && !catalog.has(chatModel.id)) {
			catalog.set(chatModel.id, chatModel);
		}
	}
	return [...catalog.values()];
}

function toChatModel(
	alias: string,
	model: RemoteModel,
	remote: RemoteProvider,
	options: BuildOptions,
): ProviderChatModelConfig | undefined {
	if (!isAgentModel(alias, model)) {
		return undefined;
	}
	const contextWindow = model.limit?.context;
	const maxTokens = model.limit?.output;
	if (!contextWindow || !maxTokens) {
		return undefined;
	}

	const id = model.id ?? alias;
	const vendor = vendorOf(alias);
	const transport = selectTransport(vendor, remote, options.settings);
	const reasoning = model.reasoning === true;

	return {
		id,
		name: model.name || id,
		api: transport.api,
		baseUrl: transport.baseUrl,
		reasoning,
		input: inputModalities(model),
		cost: resolveCost(options, vendor, id, model),
		contextWindow,
		maxTokens,
		headers: model.headers,
		compat: transport.api.startsWith("openai-") && reasoning ? { thinkingFormat: "openai" } : undefined,
	};
}

function resolveCost(
	options: BuildOptions,
	vendor: string | undefined,
	id: string,
	model: RemoteModel,
): TokenCost {
	const listed = options.costFor(vendor, id);
	const base = listed.input > 0 || listed.output > 0 ? listed : remoteCost(model);
	const multiplier = options.settings.costMultiplier;
	if (multiplier === undefined) {
		return base;
	}
	return {
		input: base.input * multiplier,
		output: base.output * multiplier,
		cacheRead: base.cacheRead * multiplier,
		cacheWrite: base.cacheWrite * multiplier,
	};
}

function remoteCost(model: RemoteModel): TokenCost {
	const cost = model.cost;
	return {
		input: cost?.input ?? 0,
		output: cost?.output ?? 0,
		cacheRead: cost?.cache_read ?? 0,
		cacheWrite: cost?.cache_write ?? 0,
	};
}

function selectTransport(vendor: string | undefined, remote: RemoteProvider, settings: ProviderSettings): TransportConfig {
	const byVendor = vendor ? settings.transports?.[vendor] : undefined;
	const chosen = byVendor ?? settings.defaultTransport ?? DEFAULT_TRANSPORT;
	return { api: chosen.api, baseUrl: chosen.baseUrl ?? remote.options?.baseURL };
}

function isAgentModel(alias: string, model: RemoteModel): boolean {
	if (model.tool_call !== true || /:batch$/iu.test(alias)) {
		return false;
	}
	if (NON_CHAT_MODEL_PATTERN.test(model.id ?? alias)) {
		return false;
	}
	const outputs = model.modalities?.output ?? ["text"];
	return outputs.includes("text") && outputs.length === 1;
}

function inputModalities(model: RemoteModel): ("text" | "image")[] {
	const inputs = model.modalities?.input ?? ["text"];
	return inputs.includes("text") && inputs.includes("image") ? ["text", "image"] : ["text"];
}

function vendorOf(alias: string): string | undefined {
	const separator = alias.indexOf("/");
	return separator > 0 ? alias.slice(0, separator) : undefined;
}

export { ZERO_COST };
