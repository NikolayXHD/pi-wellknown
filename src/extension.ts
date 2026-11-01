/**
 * Providers described by a `/.well-known/opencode` manifest.
 *
 * Each configured provider is discovered the way coding agents do it: the
 * manifest names a command that prints the API key and the URL of the remote
 * config that lists models. The catalog is read in the extension factory
 * because Pi fetches provider catalogs from the network only in the interactive
 * UI, and waits for async factories before startup.
 */

import { execFile } from "node:child_process";
import { calculateCost } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { loadProviderSettings, type ProviderSettings } from "./config.ts";
import { readStoredApiKey } from "./credentials.ts";
import { buildModels } from "./models.ts";
import { loadPriceLookup } from "./pricing.ts";
import { type CommandResult, fetchManifest, fetchRemoteConfig, type RemoteConfig, readApiKey } from "./wellknown.ts";

const FACTORY_FETCH_TIMEOUT_MS = 20_000;

interface DescribedProvider {
	config: ProviderConfig;
	cacheReadsIncludedInInput: boolean;
}

export default async function wellKnownProviders(pi: ExtensionAPI) {
	const settings = await loadProviderSettings();
	const repairs = new Set<string>();
	const failures: string[] = [];

	for (const [providerId, providerSettings] of Object.entries(settings)) {
		let described: DescribedProvider;
		try {
			described = await describeProvider(providerId, providerSettings);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
			continue;
		}
		pi.registerProvider(providerId, {
			...described.config,
			async refreshModels(context) {
				if (!context.allowNetwork || context.signal.aborted) {
					return described.config.models ?? [];
				}
				const refreshed = await describeProvider(providerId, providerSettings, context.signal);
				return refreshed.config.models ?? [];
			},
		});
		if (described.cacheReadsIncludedInInput) {
			repairs.add(providerId);
		}
	}

	if (repairs.size > 0) {
		registerUsageRepair(pi, repairs);
	}

	if (failures.length > 0) {
		pi.on("session_start", (_event, ctx) => {
			for (const failure of failures) {
				ctx.ui.notify(`well-known provider unavailable: ${failure}`, "warning");
			}
		});
	}
}

async function describeProvider(
	providerId: string,
	settings: ProviderSettings,
	signal: AbortSignal = AbortSignal.timeout(FACTORY_FETCH_TIMEOUT_MS),
): Promise<DescribedProvider> {
	const manifest = await fetchManifest(settings.wellKnownUrl, signal);
	const storedKey = await readStoredApiKey(providerId);
	const apiKey = await readApiKey(providerId, manifest, runCommand, {
		override: settings.keyCommand,
		storedKey,
	});
	const remote = await fetchRemoteConfig(providerId, manifest, apiKey, signal);
	const remoteProvider = remoteProviderFor(providerId, remote);
	const costFor = await loadPriceLookup(settings.pricing, signal);

	const models = buildModels(remoteProvider, { settings, costFor });
	if (models.length === 0) {
		throw new Error(`provider "${providerId}": remote config listed no agent-capable models`);
	}
	const fallback = models[0];
	return {
		config: {
			name: providerId,
			baseUrl: fallback.baseUrl,
			api: fallback.api,
			apiKey,
			models,
		},
		cacheReadsIncludedInInput: settings.cacheReadsIncludedInInput === true,
	};
}

function runCommand(command: string[], env: Record<string, string>): Promise<CommandResult> {
	return new Promise((resolve) => {
		execFile(
			command[0],
			command.slice(1),
			{ env: { ...process.env, ...env }, timeout: FACTORY_FETCH_TIMEOUT_MS },
			(error, stdout, stderr) => {
				const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
			},
		);
	});
}

function remoteProviderFor(providerId: string, remote: RemoteConfig) {
	const providers = remote.provider ?? {};
	const own = providers[providerId];
	if (own) {
		return own;
	}
	const keys = Object.keys(providers);
	if (keys.length === 1) {
		return providers[keys[0]];
	}
	throw new Error(`remote config has no provider "${providerId}"`);
}

/**
 * Some providers count cache reads inside the input token count, while Pi
 * follows the Anthropic spec and bills input and cache reads separately. The
 * repair subtracts the cache reads and recomputes the cost.
 */
function registerUsageRepair(pi: ExtensionAPI, providerIds: Set<string>) {
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !providerIds.has(message.provider)) {
			return;
		}
		const usage = message.usage;
		if (!usage || usage.cacheRead <= 0 || usage.input < usage.cacheRead) {
			return;
		}
		const repaired = { ...usage, input: usage.input - usage.cacheRead };
		repaired.totalTokens = repaired.input + repaired.output + repaired.cacheRead + repaired.cacheWrite;
		const model = ctx.modelRegistry.find(message.provider, message.model);
		if (model) {
			repaired.cost = calculateCost(model, repaired);
		}
		return { message: { ...message, usage: repaired } };
	});
}
