import { FALLBACK_CONTEXT, FALLBACK_OUTPUT } from "./constants.js";

export interface FallbackSpec {
  context: number;
  output: number;
  input: number;
  outputCost: number;
  cacheRead?: number;
}

function spec(
  context: number,
  output: number,
  input: number,
  outputCost: number,
  cacheRead = 0,
): FallbackSpec {
  return { context, output, input, outputCost, cacheRead };
}

// Costs are USD per 1M tokens (from the gateway pricing catalog).
// Suffix-stripped variants (thinking/preview/high/medium/low/tiered/dates)
// resolve to the base entry in `lookup`.
const TABLE: Record<string, FallbackSpec> = {
  "claude-haiku-4-5": spec(200000, 64000, 1, 5, 0.1),
  "claude-opus-4-5": spec(200000, 64000, 5, 25, 0.5),
  "claude-opus-4-6": spec(1000000, 128000, 5, 25, 0.5),
  "claude-sonnet-4-5": spec(200000, 64000, 3, 15, 0.3),
  "claude-sonnet-4-6": spec(1000000, 64000, 3, 15, 0.3),
  "gemini-2.5-flash": spec(1048576, 65535, 0.3, 2.5),
  "gemini-2.5-flash-lite": spec(1048576, 65535, 0.1, 0.4),
  "gemini-2.5-pro": spec(1048576, 65535, 1.25, 10),
  "gemini-3-flash": spec(1048576, 65535, 0.5, 3),
  "gemini-3-pro-image": spec(65536, 32768, 2, 12),
  "gemini-3-pro-preview": spec(1048576, 65535, 2, 12),
  "gemini-3.1-flash-image": spec(65536, 32768, 0.5, 3),
  "gemini-3.1-pro-high": spec(1048576, 65536, 2, 12),
  "gemini-3.1-pro-low": spec(1048576, 65536, 2, 12),
  "gemini-3.1-pro-preview": spec(1048576, 65536, 2, 12),
  "gemini-3.6-flash": spec(1048576, 65536, 1.5, 7.5),
};

const SUFFIX = /-(thinking|preview|high|medium|low|tiered)$/;
const DATE = /-\d{8}$/;

export function lookup(id: string): FallbackSpec {
  const direct = TABLE[id];
  if (direct) return direct;
  const noSuffix = id.replace(SUFFIX, "");
  if (TABLE[noSuffix]) return TABLE[noSuffix];
  const noDate = id.replace(DATE, "");
  if (TABLE[noDate]) return TABLE[noDate];
  const noBoth = noSuffix.replace(DATE, "");
  if (TABLE[noBoth]) return TABLE[noBoth];
  return {
    context: FALLBACK_CONTEXT,
    output: FALLBACK_OUTPUT,
    input: 0,
    outputCost: 0,
  };
}

export function familyOf(id: string): string {
  if (id.startsWith("claude-")) return "anthropic";
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("gpt-")) return "openai";
  return id.split("-")[0] || "rurout";
}

export function isReasoning(id: string): boolean {
  return id.includes("thinking");
}

export function isImage(id: string): boolean {
  return id.includes("image");
}

export function displayName(id: string, display?: string): string {
  const base = display && display.length > 0 ? display : id;
  const words = base
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^(v?\d+(\.\d+)+|\d+b|\d+k)$/i.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)));
  return words.join(" ");
}
