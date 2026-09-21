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
  return {
    id,
    modelID: id,
    providerID,
    name: displayName(id, display),
    family: familyOf(id),
    capabilities: {
      tools: !image,
      input: image ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [
      {
        input: fallback.input,
        output: fallback.outputCost,
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
  const models = live.map((m) => toModel(m.id, m.display_name, PROVIDER_ID));
  await ctx.catalog.transform((draft: AnyRecord) => {
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
    }

    await ctx.aisdk.hook("sdk", async (event: AnyRecord) => {
      if (event.model?.providerID !== PROVIDER_ID) return;
      const key = await resolveApiKey(ctx);
      if (!key) return;
      event.options = { ...(event.options ?? {}), apiKey: key, baseURL };
      await applyModels(ctx, baseURL, key).catch(() => 0);
      await ctx.catalog.reload().catch(() => undefined);
    });
  },
};

export default plugin;
