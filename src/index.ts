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
  };
  integration: {
    transform: (cb: (draft: AnyRecord) => void) => Promise<unknown>;
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

const plugin: PluginDef = {
  id: "rurout",
  setup: async (ctx) => {
    const opts = ((ctx as AnyRecord).options ?? {}) as RuroutOptions;
    const baseURL = baseURLFrom(opts);
    const apiKey = process.env.RUROUT_API_KEY ?? "";

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

    if (!apiKey) return;

    let live;
    try {
      live = await fetchGatewayModels(baseURL, apiKey);
    } catch {
      return;
    }

    await ctx.catalog.transform((draft: AnyRecord) => {
      for (const m of live) {
        draft.model.update(PROVIDER_ID, m.id, (model: AnyRecord) => {
          Object.assign(model, toModel(m.id, m.display_name, PROVIDER_ID));
        });
      }
    });
  },
};

export default plugin;
