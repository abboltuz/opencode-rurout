import {
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
} from "./constants.js";
import { fetchGatewayModels } from "./discovery.js";
import { keyFingerprint, purgeLegacyFileCache } from "./cache.js";
import { canonicalId, displayName, familyOf, isImage, isReasoning, lookup, modelLabel } from "./fallback.js";

interface RuroutOptions {
  baseURL?: string;
}

type AnyRecord = Record<string, any>;

interface PluginContext {
  options?: unknown;
  catalog: {
    transform: (cb: (draft: AnyRecord) => void) => Promise<unknown>;
    reload: () => Promise<unknown>;
  };
  integration: {
    transform: (cb: (draft: AnyRecord) => void) => Promise<unknown>;
    connection: {
      active: (id: string) => Promise<AnyRecord | undefined>;
      resolve: (connection: AnyRecord) => Promise<AnyRecord | undefined>;
    };
  };
  aisdk: {
    hook: (name: string, cb: (event: AnyRecord) => Promise<void> | void) => Promise<unknown>;
  };
}

interface PluginDef {
  id: string;
  setup: (ctx: PluginContext) => Promise<(() => Promise<void> | void) | void>;
}

function baseURLFrom(opts: RuroutOptions): string {
  const raw = opts.baseURL ?? process.env.RUROUT_BASE_URL ?? DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function credentialKey(credential: AnyRecord | undefined): string {
  if (!credential || typeof credential !== "object") return "";
  if (credential.type === "key" && typeof credential.key === "string") return credential.key;
  if (typeof (credential as { apiKey?: unknown }).apiKey === "string") {
    return (credential as { apiKey: string }).apiKey;
  }
  return "";
}

async function resolveApiKey(ctx: PluginContext): Promise<string> {
  try {
    const connection = await ctx.integration.connection.active(PROVIDER_ID);
    if (!connection) return process.env.RUROUT_API_KEY ?? "";
    const credential = await ctx.integration.connection.resolve(connection);
    return credentialKey(credential) || process.env.RUROUT_API_KEY || "";
  } catch {
    return process.env.RUROUT_API_KEY ?? "";
  }
}

function toModel(canonical: string, apiId: string, display: string | undefined, providerID: string): AnyRecord {
  const fallback = lookup(canonical);
  const image = isImage(canonical);
  const text = !canonical.startsWith("gpt-image-");
  const input = fallback.input > 0 ? fallback.input : 1;
  const output = fallback.outputCost > 0 ? fallback.outputCost : 5;
  return {
    id: canonical,
    modelID: apiId,
    providerID,
    name: displayName(apiId, display).startsWith("RuRout")
      ? displayName(apiId, display)
      : `RuRout ${displayName(apiId, display)}`,
    family: familyOf(canonical),
    capabilities: {
      tools: !image && text,
      input: image ? ["text", "image"] : ["text"],
      output: image || !text ? ["image"] : ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [
      {
        input,
        output,
        cache: { read: fallback.cacheRead ?? 0, write: 0 },
      },
    ],
    status: "active",
    enabled: true,
    limit: { context: fallback.context, output: fallback.output },
    settings: { reasoning: isReasoning(apiId) },
  };
}

function pickApiId(ids: string[]): string {
  const rank = (id: string): number => {
    if (/-tiered$/i.test(id)) return 0;
    if (/-medium$/i.test(id)) return 1;
    if (/-high$/i.test(id)) return 2;
    if (/-low$/i.test(id)) return 3;
    if (/-thinking$/i.test(id)) return 4;
    if (/-preview$/i.test(id)) return 5;
    if (/-\d{8}$/.test(id)) return 6;
    return 7;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))[0]!;
}

async function fetchKeyLabel(baseURL: string, apiKey: string): Promise<string> {
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/sub2api/billing`, {
      signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return "";
    const body = (await response.json()) as { key_name?: unknown; group_name?: unknown };
    const keyName = typeof body.key_name === "string" ? body.key_name.trim() : "";
    const groupName = typeof body.group_name === "string" ? body.group_name.trim() : "";
    return keyName || groupName;
  } catch {
    return "";
  }
}

function sanitizeLabel(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

const REFRESH_INTERVAL_MS = 15_000;
const KEY_REFRESH_DEBOUNCE_MS = 60_000;
const seenKeyFingerprints = new Set<string>();
const lastKeyRefreshAt = new Map<string, number>();

function shouldRefreshForKey(apiKey: string): boolean {
  const fingerprint = keyFingerprint(apiKey);
  if (!seenKeyFingerprints.has(fingerprint)) {
    seenKeyFingerprints.add(fingerprint);
    lastKeyRefreshAt.set(fingerprint, Date.now());
    return true;
  }
  const last = lastKeyRefreshAt.get(fingerprint) ?? 0;
  if (Date.now() - last < KEY_REFRESH_DEBOUNCE_MS) return false;
  lastKeyRefreshAt.set(fingerprint, Date.now());
  return true;
}

async function refreshModelsForKey(
  ctx: PluginContext,
  baseURL: string,
  apiKey: string,
): Promise<number> {
  if (!apiKey || !shouldRefreshForKey(apiKey)) return 0;
  await purgeLegacyFileCache();
  const count = await applyModels(ctx, baseURL, apiKey).catch(() => 0);
  if (count > 0) {
    await ctx.catalog.reload().catch(() => undefined);
  }
  return count;
}

async function applyModels(ctx: PluginContext, baseURL: string, apiKey: string): Promise<number> {
  let live;
  try {
    live = await fetchGatewayModels(baseURL, apiKey);
  } catch {
    return 0;
  }
  const groups = new Map<string, { ids: string[]; display?: string }>();
  for (const m of live) {
    const canonical = canonicalId(m.id);
    const entry = groups.get(canonical) ?? { ids: [] };
    entry.ids.push(m.id);
    if (!entry.display && m.display_name && m.display_name !== m.id) entry.display = m.display_name;
    groups.set(canonical, entry);
  }
  const models = [...groups.entries()].map(([canonical, entry]) => {
    const apiId = pickApiId(entry.ids);
    const model = toModel(canonical, apiId, entry.display, PROVIDER_ID);
    model.display = entry.display ?? apiId;
    return model;
  });
  const keyLabel = sanitizeLabel(await fetchKeyLabel(baseURL, apiKey));
  const providerName = keyLabel ? `RuRout ${keyLabel}` : PROVIDER_NAME;
  const seen = new Set(models.map((m) => m.id));
  await ctx.catalog.transform((draft: AnyRecord) => {
    draft.provider.update(PROVIDER_ID, (provider: AnyRecord) => {
      provider.name = providerName;
    });
    try {
      const rec = draft.provider.list().find((r: AnyRecord) => r.provider?.id === PROVIDER_ID);
      const stored = rec?.models;
      const storedIds: string[] =
        stored instanceof Map ? [...stored.keys()] : Object.keys(stored ?? {});
      for (const id of storedIds) {
        if (!seen.has(id)) {
          try {
            draft.model.remove(PROVIDER_ID, id);
          } catch {
              // Model may already be gone; ignore per-model errors.
            }
        }
      }
    } catch {
      // Stale cleanup is best-effort; discovery below still applies.
    }
    for (const model of models) {
      draft.model.update(PROVIDER_ID, model.id, (target: AnyRecord) => {
        Object.assign(target, model);
        delete target.display;
        if (keyLabel) {
          target.name = `${providerName} ${displayName(model.modelID, model.display)}`;
        }
      });
    }
  });
  return models.length;
}

const plugin: PluginDef = {
  id: "rurout",
  setup: async (ctx) => {
    const opts = ((ctx as AnyRecord).options ?? {}) as RuroutOptions;
    const baseURL = baseURLFrom(opts);

    await ctx.integration.transform((draft: AnyRecord) => {
      draft.update(PROVIDER_ID, (ref: AnyRecord) => {
        ref.name = PROVIDER_NAME;
      });
      draft.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "env", names: ["RUROUT_API_KEY"] },
      });
      draft.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "key", label: "API Key" },
      });
    });

    await ctx.catalog.transform((draft: AnyRecord) => {
      draft.provider.update(PROVIDER_ID, (provider: AnyRecord) => {
        provider.name = PROVIDER_NAME;
        provider.package = PROVIDER_PACKAGE;
        provider.settings = { ...(provider.settings ?? {}), baseURL };
      });
    });

    await purgeLegacyFileCache();

    const apiKey = await resolveApiKey(ctx);
    if (apiKey) {
      await refreshModelsForKey(ctx, baseURL, apiKey);
    }

    let lastKey = apiKey;
    const refreshTimer = setInterval(() => {
      void (async () => {
        const key = await resolveApiKey(ctx);
        if (!key) return;
        if (key !== lastKey) {
          lastKey = key;
          await refreshModelsForKey(ctx, baseURL, key);
          return;
        }
      })();
    }, REFRESH_INTERVAL_MS);
    if (typeof (refreshTimer as unknown as { unref?: () => void }).unref === "function") {
      (refreshTimer as unknown as { unref: () => void }).unref();
    }

    await ctx.aisdk.hook("sdk", async (event: AnyRecord) => {
      if (event.model?.providerID !== PROVIDER_ID) return;
      const key = await resolveApiKey(ctx);
      if (!key) return;
      event.options = { ...(event.options ?? {}), apiKey: key, baseURL };
      if (key !== lastKey) {
        lastKey = key;
      }
      await refreshModelsForKey(ctx, baseURL, key);
    });

    return () => {
      clearInterval(refreshTimer);
    };
  },
};

export default plugin;
