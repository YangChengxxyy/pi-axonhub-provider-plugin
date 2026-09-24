/**
 * AxonHub provider extension for the Pi coding agent.
 *
 * Port of opencode-axonhub-provider-plugin.
 *
 * - Auto-discovers models from an AxonHub gateway (`GET {baseURL}/v1/models`)
 *   as a dynamic provider; Pi restores the cached list offline and refreshes
 *   it through its model-catalog refresh (no custom timers)
 * - API key via `/login axonhub` (stored credential wins, `AXONHUB_API_KEY`
 *   env var as ambient fallback)
 * - Registers under configurable protocol(s): "openai", "anthropic", or both
 * - Enriches models with pricing / context limits / reasoning capability from
 *   models.dev (canonical vendor rates, or ZenMux gateway rates)
 * - Reasoning models get `reasoning: true`, so Pi's thinking-level selector works
 *
 * Configuration via environment variables:
 *   AXONHUB_BASE_URL   - AxonHub root, default https://llm.cccloud.xin
 *   AXONHUB_API_KEY    - ambient API key fallback (prefer `/login axonhub`)
 *   AXONHUB_PROTOCOL   - "openai" | "anthropic" | "both" (comma-separated list also accepted; default "openai")
 *   AXONHUB_PRICING    - "canonical" | "zenmux" | "none" (default "canonical")
 *
 * Install: `pi install git:github.com/YangChengxxyy/pi-axonhub-provider-plugin`
 * (the package.json `pi` manifest declares this file as the extension entry),
 * or run `pi -e /path/to/pi-axonhub-provider-plugin` while developing.
 */
import {
	anthropicMessagesApi,
	createProvider,
	envApiKeyAuth,
	openAICompletionsApi,
	type Api,
	type Credential,
	type Model,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

type Protocol = "openai" | "anthropic"
type Pricing = "canonical" | "zenmux" | "none"

const MODELS_DEV_API = "https://models.dev/api.json"
const DEFAULT_BASE_URL = "https://llm.cccloud.xin"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function readEnv(): { baseURL: string; protocols: Protocol[]; pricing: Pricing } {
	const pricingEnv = process.env.AXONHUB_PRICING as Pricing | undefined
	const protocols = new Set<Protocol>()
	for (const token of (process.env.AXONHUB_PROTOCOL ?? "openai").split(",")) {
		const t = token.trim().toLowerCase()
		if (t === "both" || t === "all") {
			protocols.add("openai")
			protocols.add("anthropic")
		} else if (t === "openai" || t === "anthropic") {
			protocols.add(t)
		}
	}
	if (protocols.size === 0) protocols.add("openai")
	return {
		baseURL: (process.env.AXONHUB_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
		protocols: [...protocols],
		pricing: pricingEnv === "zenmux" || pricingEnv === "none" ? pricingEnv : "canonical",
	}
}

// ---------------------------------------------------------------------------
// Reasoning / limits heuristics (fallback when models.dev has no match)
// ---------------------------------------------------------------------------

const REASONING_MATCHERS: RegExp[] = [
	/^(o[134](-mini)?|gpt-5|gpt-6)/, // OpenAI
	/^claude-(opus|sonnet|haiku)/, // Anthropic
	/^glm/, // Zhipu
	/^deepseek/,
	/^(kimi|moonshot)/i,
	/^minimax/i,
	/^grok/,
	/^qwen/, // Qwen thinking
	/^(step|doubao|seed)/i,
	/^(mimo|muse)/i,
]

function supportsReasoning(id: string): boolean {
	const lower = id.toLowerCase()
	return REASONING_MATCHERS.some((re) => re.test(lower))
}

/** Rough per-family context/output limits; unknown models get conservative defaults (fallback). */
const LIMITS: { match: RegExp; context: number; output: number }[] = [
	{ match: /^claude-(opus|sonnet)-?5/, context: 200_000, output: 64_000 },
	{ match: /^claude/, context: 200_000, output: 32_000 },
	{ match: /^gpt-6|^o[134]/, context: 400_000, output: 128_000 },
	{ match: /^gpt-5/, context: 400_000, output: 128_000 },
	{ match: /^glm/, context: 200_000, output: 128_000 },
	{ match: /^deepseek/, context: 164_000, output: 64_000 },
	{ match: /^(kimi|moonshot)/i, context: 256_000, output: 64_000 },
	{ match: /^minimax/i, context: 1_000_000, output: 128_000 },
	{ match: /^grok/, context: 256_000, output: 128_000 },
	{ match: /^qwen/, context: 262_000, output: 64_000 },
]

function limitsFor(id: string): { context: number; output: number } {
	const lower = id.toLowerCase()
	for (const l of LIMITS) if (l.match.test(lower)) return { context: l.context, output: l.output }
	return { context: 128_000, output: 32_000 }
}

// ---------------------------------------------------------------------------
// AxonHub model discovery
// ---------------------------------------------------------------------------

interface AxonHubModel {
	id: string
	created?: number
}

function apiKeyOf(credential: Credential | undefined): string | undefined {
	return credential?.type === "api_key" ? credential.key : undefined
}

// Both protocol providers fetch the same `/v1/models` list; share a short-TTL
// cache so a catalog refresh issues one upstream request.
let axonHubModelsCache: { key: string; at: number; models: AxonHubModel[] } | undefined
const AXONHUB_MODELS_TTL_MS = 60 * 1000

async function fetchAxonHubModels(
	baseURL: string,
	credential: Credential | undefined,
	signal: AbortSignal,
): Promise<AxonHubModel[]> {
	const apiKey = apiKeyOf(credential) ?? process.env.AXONHUB_API_KEY
	if (!apiKey) return [] // unconfigured: no models until /login or env key
	const cacheKey = `${baseURL}|${apiKey}`
	if (
		axonHubModelsCache &&
		axonHubModelsCache.key === cacheKey &&
		Date.now() - axonHubModelsCache.at < AXONHUB_MODELS_TTL_MS
	)
		return axonHubModelsCache.models
	const res = await fetch(`${baseURL}/v1/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	})
	if (!res.ok)
		throw new Error(`AxonHub model list failed: ${res.status} ${await res.text().catch(() => "")}`)
	const body = (await res.json()) as { data?: AxonHubModel[] }
	const models = body.data ?? []
	axonHubModelsCache = { key: cacheKey, at: Date.now(), models }
	return models
}

// ---------------------------------------------------------------------------
// models.dev enrichment
// ---------------------------------------------------------------------------

interface DevModel {
	name?: string
	reasoning?: boolean
	tool_call?: boolean
	limit?: { context?: number; output?: number }
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

/** Normalize an id for fuzzy equality: case, and `4.5` vs `4-5` version styles. */
function norm(id: string): string {
	return id.toLowerCase().replaceAll(".", "-")
}

interface DevEntry {
	provider: string
	key: string
	nkey: string
	dev: DevModel
}

function push(map: Map<string, DevEntry[]>, key: string, e: DevEntry): void {
	const list = map.get(key)
	if (list) list.push(e)
	else map.set(key, [e])
}

class ModelsDevIndex {
	private readonly exact = new Map<string, DevEntry[]>()
	private readonly suffix = new Map<string, DevEntry[]>()

	constructor(entries: DevEntry[]) {
		for (const e of entries) {
			push(this.exact, e.nkey, e)
			const slash = e.nkey.lastIndexOf("/")
			if (slash >= 0) push(this.suffix, e.nkey.slice(slash + 1), e)
		}
	}

	/**
	 * Resolve metadata for a bare model id. Preference order:
	 * pricingProvider (e.g. zenmux) → canonical vendors → any provider (exact key, then `vendor/id` suffix).
	 */
	lookup(id: string, pricingProvider?: string): DevModel | undefined {
		const n = norm(id)
		const hits = [...(this.exact.get(n) ?? []), ...(this.suffix.get(n) ?? [])]
		if (hits.length === 0) return undefined
		return this.pick(hits, pricingProvider)?.dev
	}

	private pick(hits: DevEntry[], pricingProvider?: string): DevEntry | undefined {
		const order = [
			pricingProvider,
			"anthropic",
			"openai",
			"zai",
			"zhipuai",
			"deepseek",
			"minimax",
			"moonshotai",
			"xai",
			"stepfun",
			"xiaomi",
			"google",
		].filter((p): p is string => typeof p === "string")
		for (const p of order) {
			const hit = hits.find((h) => h.provider === p)
			if (hit) return hit
		}
		return hits[0]
	}
}

let devIndexCache: { index: ModelsDevIndex | undefined; at: number } | undefined
const DEV_TTL_MS = 5 * 60 * 1000

async function fetchModelsDev(signal: AbortSignal): Promise<ModelsDevIndex | undefined> {
	if (devIndexCache && Date.now() - devIndexCache.at < DEV_TTL_MS) return devIndexCache.index
	try {
		const res = await fetch(MODELS_DEV_API, { signal })
		if (!res.ok) throw new Error(`${res.status}`)
		const body = (await res.json()) as Record<string, { models?: Record<string, DevModel> }>
		const entries: DevEntry[] = []
		for (const [provider, info] of Object.entries(body)) {
			for (const [key, dev] of Object.entries(info.models ?? {})) {
				if (dev.limit?.context || dev.cost) entries.push({ provider, key, nkey: norm(key), dev })
			}
		}
		const index = new ModelsDevIndex(entries)
		devIndexCache = { index, at: Date.now() }
		return index
	} catch (err) {
		if ((err as Error).name === "AbortError") throw err
		console.error("[axonhub] models.dev fetch failed, falling back to heuristics:", err)
		devIndexCache = { index: undefined, at: Date.now() }
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Model mapping (models.dev / heuristics → pi Model)
// ---------------------------------------------------------------------------

function buildModels(
	providerId: string,
	api: Api,
	baseUrl: string,
	remote: AxonHubModel[],
	devIndex: ModelsDevIndex | undefined,
	pricingProvider?: string,
): Model<Api>[] {
	return remote.map((m) => {
		const meta = devIndex?.lookup(m.id, pricingProvider)
		const limit = meta?.limit?.context
			? { context: meta.limit.context, output: meta.limit.output ?? 64_000 }
			: limitsFor(m.id)
		const reasoning = meta ? meta.reasoning === true : supportsReasoning(m.id)
		const model: Model<Api> = {
			id: m.id,
			name: meta?.name ?? m.id,
			api,
			provider: providerId,
			baseUrl,
			reasoning,
			input: ["text", "image"],
			cost: {
				input: meta?.cost?.input ?? 0,
				output: meta?.cost?.output ?? 0,
				cacheRead: meta?.cost?.cache_read ?? 0,
				cacheWrite: meta?.cost?.cache_write ?? 0,
			},
			contextWindow: limit.context,
			maxTokens: limit.output,
		} as Model<Api>
		// openai-completions: send the thinking level as top-level `reasoning_effort`,
		// matching how AxonHub's OpenAI protocol exposes 思考强度.
		if (api === "openai-completions" && reasoning) {
			;(model as Model<"openai-completions">).compat = { supportsReasoningEffort: true }
		}
		return model
	})
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const { baseURL, protocols, pricing } = readEnv()
	const pricingProvider = pricing === "zenmux" ? "zenmux" : undefined

	for (const protocol of protocols) {
		const providerId = protocol === "anthropic" ? "axonhub-anthropic" : "axonhub"
		const api = protocol === "anthropic" ? "anthropic-messages" : "openai-completions"
		// anthropic-messages (Anthropic SDK style) resolves to {baseUrl}/v1/messages,
		// i.e. AxonHub's /anthropic/v1/messages route.
		const baseUrl = protocol === "anthropic" ? `${baseURL}/anthropic` : `${baseURL}/v1`

		const provider = createProvider({
			id: providerId,
			name: `AxonHub (${protocol})`,
			baseUrl,
			// `/login axonhub` (or `axonhub-anthropic`) prompts for and stores the key;
			// a stored credential wins, AXONHUB_API_KEY is the ambient fallback.
			auth: { apiKey: envApiKeyAuth("AxonHub API key", ["AXONHUB_API_KEY"]) },
			models: [],
			api: protocol === "anthropic" ? anthropicMessagesApi() : openAICompletionsApi(),
			// Dynamic model list: Pi restores the persisted catalog offline and
			// re-fetches through its model-catalog refresh.
			fetchModels: async (context: RefreshModelsContext): Promise<Model<Api>[]> => {
				const remote = await fetchAxonHubModels(baseURL, context.credential, context.signal)
				if (remote.length === 0) return []
				const devIndex = pricing === "none" ? undefined : await fetchModelsDev(context.signal)
				return buildModels(providerId, api, baseUrl, remote, devIndex, pricingProvider)
			},
		})

		pi.registerProvider(provider)
	}
}
