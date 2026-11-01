/**
 * The `/.well-known/opencode` handshake: a manifest names the command that
 * produces the API key and the URL of the remote config that lists models.
 */

const MANIFEST_PATH = "/.well-known/opencode";
const FETCH_TIMEOUT_MS = 20_000;

export interface WellKnownManifest {
	auth?: {
		/** Command whose standard output is the API key. */
		command?: string[];
		/** Environment variable the provider expects the key under. */
		env?: string;
	};
	remote_config?: {
		url?: string;
		headers?: Record<string, string>;
	};
}

export interface RemoteModel {
	name?: string;
	id?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	attachment?: boolean;
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[]; output?: string[] };
	headers?: Record<string, string>;
}

export interface RemoteProvider {
	options?: { baseURL?: string };
	models?: Record<string, RemoteModel>;
}

export interface RemoteConfig {
	config?: RemoteConfig;
	provider?: Record<string, RemoteProvider>;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Runs a command with extra environment entries on top of the inherited ones. */
export type RunCommand = (command: string[], env: Record<string, string>) => Promise<CommandResult>;

export async function fetchManifest(wellKnownUrl: string, signal: AbortSignal): Promise<WellKnownManifest> {
	const url = `${wellKnownUrl.replace(/\/+$/u, "")}${MANIFEST_PATH}`;
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`${url} answered ${response.status}`);
	}
	return (await response.json()) as WellKnownManifest;
}

export async function readApiKey(
	providerId: string,
	manifest: WellKnownManifest,
	run: RunCommand,
	options: { override?: string[]; storedKey?: string } = {},
): Promise<string | undefined> {
	const command = options.override ?? manifest.auth?.command;
	if (!command || command.length === 0) {
		return undefined;
	}
	const result = await run(command, keyEnvironment(manifest, options.storedKey));
	if (result.code !== 0) {
		const detail = result.stderr.trim() || `exit code ${result.code}`;
		throw new Error(`provider "${providerId}": key command failed: ${detail}`);
	}
	const key = result.stdout.trim();
	if (key.length === 0) {
		throw new Error(`provider "${providerId}": key command printed nothing`);
	}
	return key;
}

export async function fetchRemoteConfig(
	providerId: string,
	manifest: WellKnownManifest,
	apiKey: string | undefined,
	signal: AbortSignal,
): Promise<RemoteConfig> {
	const remote = manifest.remote_config;
	if (!remote?.url) {
		throw new Error(`provider "${providerId}": well-known manifest has no remote_config.url`);
	}
	const headers: Record<string, string> = { accept: "application/json" };
	for (const [name, value] of Object.entries(remote.headers ?? {})) {
		headers[name] = resolveTemplate(value, manifest, apiKey);
	}
	const response = await fetch(remote.url, {
		headers,
		signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		throw new Error(`provider "${providerId}": ${remote.url} answered ${response.status}`);
	}
	const body = (await response.json()) as RemoteConfig;
	return body.config ?? body;
}

/** The variable the manifest expects the key under, when one is named. */
function keyEnvironment(manifest: WellKnownManifest, storedKey: string | undefined): Record<string, string> {
	const name = manifest.auth?.env;
	if (!name || storedKey === undefined) {
		return {};
	}
	return { [name]: storedKey };
}

function resolveTemplate(value: string, manifest: WellKnownManifest, apiKey: string | undefined): string {
	return value.replace(/\{env:([^}]+)\}/gu, (_match, name: string) => {
		if (apiKey !== undefined && name === manifest.auth?.env) {
			return apiKey;
		}
		return process.env[name] ?? "";
	});
}
