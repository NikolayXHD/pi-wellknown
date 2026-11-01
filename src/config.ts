/**
 * Configuration for well-known providers.
 *
 * The file is `wellknown.json` in the agent directory, or the path in
 * PI_WELLKNOWN_CONFIG. Every top-level key is a Pi provider id; nothing else
 * lives at the top level.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";

export interface TransportConfig {
	api: Api;
	/** Endpoint for this transport; the remote config endpoint is used when omitted. */
	baseUrl?: string;
}

export interface PriceUnits {
	input?: string | string[];
	output?: string | string[];
	cacheRead?: string | string[];
	cacheWrite?: string | string[];
}

/** Describes a price list whose shape is not known up front. */
export interface PricingConfig {
	url: string;
	/** Dot path to the model name in each entry. Default "model". */
	modelPath?: string;
	/** Dot path to the array of price lines in each entry. */
	unitPath?: string;
	/** Field holding the unit name, default "unitType". */
	unitField?: string;
	/** Field holding the price, default "totalPrice". */
	priceField?: string;
	/** Unit names for each cost component. */
	units: PriceUnits;
}

export interface ProviderSettings {
	/** Base URL whose `/.well-known/opencode` describes auth and the model catalog. */
	wellKnownUrl: string;
	/**
	 * Command that prints the API key, overriding the manifest's own command.
	 * Use it when the key lives somewhere other than the environment the
	 * manifest expects.
	 */
	keyCommand?: string[];
	/** Transport per vendor, where the vendor is the first segment of a model id. */
	transports?: Record<string, TransportConfig>;
	/** Transport for vendors without an entry in `transports`. */
	defaultTransport?: TransportConfig;
	/** Factor applied to every published price, e.g. to rebase a currency. */
	costMultiplier?: number;
	/** Whether the provider counts cache reads inside the input token count. */
	cacheReadsIncludedInInput?: boolean;
	pricing?: PricingConfig;
}

export type ProviderSettingsMap = Record<string, ProviderSettings>;

export function configPath(): string {
	if (process.env.PI_WELLKNOWN_CONFIG) {
		return process.env.PI_WELLKNOWN_CONFIG;
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "wellknown.json");
}

export async function loadProviderSettings(): Promise<ProviderSettingsMap> {
	const path = configPath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return {};
		}
		throw error;
	}
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`${path}: expected an object keyed by provider id`);
	}
	const settings: ProviderSettingsMap = {};
	for (const [providerId, value] of Object.entries(parsed)) {
		settings[providerId] = readProviderSettings(providerId, value, path);
	}
	return settings;
}

function readProviderSettings(providerId: string, value: unknown, path: string): ProviderSettings {
	if (!isRecord(value)) {
		throw new Error(`${path}: provider "${providerId}" must be an object`);
	}
	const wellKnownUrl = value.wellKnownUrl;
	if (typeof wellKnownUrl !== "string" || wellKnownUrl.length === 0) {
		throw new Error(`${path}: provider "${providerId}" needs a wellKnownUrl`);
	}
	const costMultiplier = value.costMultiplier;
	if (costMultiplier !== undefined && (typeof costMultiplier !== "number" || !Number.isFinite(costMultiplier))) {
		throw new Error(`${path}: provider "${providerId}" has a non-numeric costMultiplier`);
	}
	return {
		wellKnownUrl,
		keyCommand: readCommand(providerId, value.keyCommand, path),
		transports: readTransports(providerId, value.transports, path),
		defaultTransport: readTransport(providerId, value.defaultTransport, path),
		costMultiplier,
		cacheReadsIncludedInInput: value.cacheReadsIncludedInInput === true,
		pricing: readPricing(providerId, value.pricing, path),
	};
}

function readTransports(providerId: string, value: unknown, path: string): Record<string, TransportConfig> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`${path}: provider "${providerId}" transports must be an object`);
	}
	const transports: Record<string, TransportConfig> = {};
	for (const [vendor, transport] of Object.entries(value)) {
		const parsed = readTransport(providerId, transport, path);
		if (!parsed) {
			throw new Error(`${path}: provider "${providerId}" transport "${vendor}" needs an api`);
		}
		transports[vendor] = parsed;
	}
	return transports;
}

function readTransport(providerId: string, value: unknown, path: string): TransportConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error(`${path}: provider "${providerId}" transport must be an object`);
	}
	const api = value.api;
	if (typeof api !== "string" || api.length === 0) {
		return undefined;
	}
	const baseUrl = value.baseUrl;
	if (baseUrl !== undefined && typeof baseUrl !== "string") {
		throw new Error(`${path}: provider "${providerId}" transport baseUrl must be a string`);
	}
	return { api: api as Api, baseUrl };
}

function readPricing(providerId: string, value: unknown, path: string): PricingConfig | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value) || typeof value.url !== "string") {
		throw new Error(`${path}: provider "${providerId}" pricing needs a url`);
	}
	if (!isRecord(value.units)) {
		throw new Error(`${path}: provider "${providerId}" pricing needs units`);
	}
	return {
		url: value.url,
		modelPath: readOptionalString(value.modelPath),
		unitPath: readOptionalString(value.unitPath),
		unitField: readOptionalString(value.unitField),
		priceField: readOptionalString(value.priceField),
		units: value.units as PriceUnits,
	};
}

function readCommand(providerId: string, value: unknown, path: string): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== "string")) {
		throw new Error(`${path}: provider "${providerId}" keyCommand must be a non-empty array of strings`);
	}
	return value as string[];
}

function readOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
