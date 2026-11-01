/**
 * Pi stores provider credentials in `auth.json` inside the agent directory.
 * A well-known manifest expects its key in an environment variable, so the
 * stored credential for the provider is read here and handed to that variable.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface StoredCredential {
	type?: string;
	key?: unknown;
}

export function credentialsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "auth.json");
}

export async function readStoredApiKey(providerId: string): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(credentialsPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	const stored = JSON.parse(raw) as Record<string, StoredCredential>;
	const credential = stored[providerId];
	if (credential?.type !== "api_key" || typeof credential.key !== "string") {
		return undefined;
	}
	return credential.key;
}
