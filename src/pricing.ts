/**
 * Optional price list. Price lists come in arbitrary shapes, so the entry
 * shape is described by the configuration: where the model name
 * lives, where the price lines live, which field names carry the unit and the
 * amount, and how unit names map onto Pi's cost components.
 */

import type { PricingConfig } from "./config.ts";

const FETCH_TIMEOUT_MS = 20_000;

export interface TokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export const ZERO_COST: TokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type PriceLookup = (vendor: string | undefined, modelId: string) => TokenCost;

export async function loadPriceLookup(pricing: PricingConfig | undefined, signal: AbortSignal): Promise<PriceLookup> {
	if (!pricing) {
		return () => ZERO_COST;
	}
	const response = await fetch(pricing.url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`price list ${pricing.url} answered ${response.status}`);
	}
	const entries = (await response.json()) as unknown;
	if (!Array.isArray(entries)) {
		throw new Error(`price list ${pricing.url} is not an array`);
	}
	const priced = new Map<string, TokenCost>();
	for (const entry of entries) {
		const name = readPath(entry, pricing.modelPath ?? "model");
		if (typeof name !== "string" || name.length === 0) {
			continue;
		}
		priced.set(name, readEntryCost(entry, pricing));
	}
	return (vendor, modelId) => {
		for (const candidate of priceKeys(vendor, modelId)) {
			const cost = priced.get(candidate);
			if (cost) {
				return cost;
			}
		}
		return ZERO_COST;
	};
}

function readEntryCost(entry: unknown, pricing: PricingConfig): TokenCost {
	const lines = pricing.unitPath ? readPath(entry, pricing.unitPath) : entry;
	const cost: TokenCost = { ...ZERO_COST };
	for (const line of Array.isArray(lines) ? lines : [lines]) {
		const unit = readPath(line, pricing.unitField ?? "unitType");
		const amount = Number(readPath(line, pricing.priceField ?? "totalPrice"));
		if (typeof unit !== "string" || !Number.isFinite(amount)) {
			continue;
		}
		const field = unitField(pricing, unit);
		if (field && amount > cost[field]) {
			cost[field] = amount;
		}
	}
	return cost;
}

function unitField(pricing: PricingConfig, unit: string): keyof TokenCost | undefined {
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const names = pricing.units[field];
		const candidates = Array.isArray(names) ? names : names ? [names] : [];
		if (candidates.includes(unit)) {
			return field;
		}
	}
	return undefined;
}

/**
 * The catalog and the price list do not always spell a model the same way, so
 * probe from the most to the least exact: with the vendor prefix, without it,
 * and with dots replaced by dashes.
 */
function priceKeys(vendor: string | undefined, modelId: string): string[] {
	const bare = modelId.replace(/^[^/]+/u, "").replace(/^\//u, "");
	const candidates = [
		vendor ? `${vendor}/${modelId}` : undefined,
		modelId,
		vendor ? `${vendor}/${bare}` : undefined,
		modelId.replace(/\./gu, "-"),
		bare,
		bare.replace(/\./gu, "-"),
	];
	return candidates.filter((candidate, index, all): candidate is string => !!candidate && all.indexOf(candidate) === index);
}

function readPath(value: unknown, path: string): unknown {
	let current = value;
	for (const part of path.split(".")) {
		if (typeof current !== "object" || current === null) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}
