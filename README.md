# @rurout/opencode-v2

OpenCode **2.x** provider plugin for [RuRout](https://rurout.online) — your gateway key becomes a first-class provider in `/models`.

> For OpenCode **1.x**, use [@rurout/opencode-v1](https://www.npmjs.com/package/@rurout/opencode-v1) instead
> ([source](https://github.com/abboltuz/opencode-rurout-v1)).

## What the client gets

- New `RuRout` provider in the OpenCode model picker, next to the built-ins.
- Model list discovered live from `GET /v1/models` with the client's own key — each client sees exactly the models their key allows, deduplicated to one entry per model family.
- Provider and model names include the admin-given key name from `GET /v1/sub2api/billing` (e.g. `RuRout Germes`).
- Pool refreshes on every startup, on key change (15s watcher + first-use hook), and stale ids are removed.

## Install (OpenCode 2.x only)

```
opencode plugin add @rurout/opencode-v2@latest
```

Then inside OpenCode:

```
/connect
```

Select `rurout`, paste the gateway API key. Restart OpenCode, then `/models` → pick a `rurout/*` model.

Environment alternative (servers / CI):

```sh
export RUROUT_API_KEY=sk-...
opencode
```

## Custom gateway address

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@rurout/opencode-v2@latest",
      "options": { "baseURL": "https://your-gateway.example.com:9443/v1" }
    }
  ]
}
```

Or `export RUROUT_BASE_URL=...`.

## How it works

1. `setup` registers the `rurout` integration (`env` + `key` methods) so `/connect rurout` appears.
2. The provider shell is registered in the catalog with `@opencode/ai/providers/openai` and the configured `baseURL`.
3. Models are fetched live from `{baseURL}/models` with the client's key and written into the catalog via `model.update` — the same mechanism built-in dynamic providers use. Each key sees only its own allowlist.
