import {
  DEFAULT_BASE_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
} from "./constants.js";
import { fetchGatewayModels } from "./discovery.js";
import { displayName, familyOf, isImage, isReasoning, lookup } from "./fallback.js";

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

function toModel(id: string, display: string | undefined, providerID: string): AnyRecord {
  const fallback = lookup(id);
  const image = isImage(id);
  const text = !id.startsWith("gpt-image-");
  const input = fallback.input > 0 ? fallback.input : 1;
  const output = fallback.outputCost > 0 ? fallback.outputCost : 5;
  return {
    id,
    modelID: id,
    providerID,
    name: `RuRout ${displayName(id, display)}`,
    family: familyOf(id),
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
    settings: { reasoning: isReasoning(id) },
  };
}

async function applyModels(ctx: PluginContext, baseURL: string, apiKey: string): Promise<number> {
  let live;
  try {
    live = await fetchGatewayModels(baseURL, apiKey);
  } catch {
    return 0;
  }
  const seen = new Set(live.map((m) => m.id));
  const models = live.map((m) => toModel(m.id, m.display_name, PROVIDER_ID));
  await ctx.catalog.transform((draft: AnyRecord) => {
    try {
      const rec = draft.provider.list().find((r: AnyRecord) => r.provider?.id === PROVIDER_ID);
      for (const id of Object.keys(rec?.models ?? {})) {
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

    const apiKey = await resolveApiKey(ctx);
    if (apiKey) {
      await applyModels(ctx, baseURL, apiKey);
      await ctx.catalog.reload().catch(() => undefined);
    }

    let lastKey = apiKey;
    const refreshTimer = setInterval(() => {
      void (async () => {
        const key = await resolveApiKey(ctx);
        if (!key) return;
        if (key !== lastKey) {
          lastKey = key;
          const count = await applyModels(ctx, baseURL, key).catch(() => 0);
          if (count > 0) {
            await ctx.catalog.reload().catch(() => undefined);
          }
          return;
        }
      })();
    }, 15_000);
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
        const count = await applyModels(ctx, baseURL, key).catch(() => 0);
        if (count > 0) {
          await ctx.catalog.reload().catch(() => undefined);
        }
      }
    });

    return () => {
      clearInterval(refreshTimer);
    };
  },
};

export default plugin;
