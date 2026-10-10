import { CursorApiError, CursorClient } from "./cursor-api.js";
import { resolveTextOutputLimit } from "./config.js";

export const DEFAULT_TEXT_OUTPUT_LIMIT = 6000;
export const TRUNCATE_HINT = "[已截断，使用 cursor_get_model 查看详情]";

export type UnifiedEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ModelParamKV = { id: string; value: string };

export interface ModelParamValue {
  value: string;
  displayName?: string;
}

export interface ModelParameter {
  id: string;
  displayName?: string;
  values: ModelParamValue[];
}

export interface ModelVariant {
  params: ModelParamKV[];
  displayName?: string;
  isDefault?: boolean;
}

export interface CursorModelItem {
  id: string;
  displayName?: string;
  aliases?: string[];
  parameters?: ModelParameter[];
  variants?: ModelVariant[];
}

export interface UnifiedModelInput {
  model?: string;
  effort?: UnifiedEffort;
  fast?: boolean;
  context?: "default" | "max";
  thinking?: boolean;
  model_params?: ModelParamKV[];
}

export interface AppliedParamEntry {
  id: string;
  value: string;
  source: "user" | "default";
}

export interface ResolvedModelSelection {
  id: string;
  params: ModelParamKV[];
  applied_model: string;
  applied_params: AppliedParamEntry[];
  applied_notes?: string[];
}

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const EFFORT_LADDER: UnifiedEffort[] = ["low", "medium", "high", "xhigh", "max"];

const CANONICAL_ALIASES: Record<string, string> = {
  auto: "default",
  grok: "grok",
  composer: "composer",
  opus: "opus",
  gpt: "gpt",
  fable: "fable",
  gemini: "gemini-pro",
  "gemini-flash": "gemini-flash",
  sonnet: "sonnet",
  haiku: "haiku",
  codex: "codex",
};

let modelsCache: { fetchedAt: number; items: CursorModelItem[] } | null = null;

export function stripZeroWidth(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "");
}

export function truncateToolText(text: string, max = DEFAULT_TEXT_OUTPUT_LIMIT): string {
  if (text.length <= max) return text;
  const budget = max - TRUNCATE_HINT.length;
  return text.slice(0, Math.max(0, budget)) + TRUNCATE_HINT;
}

export function textToolResult(text: string, env?: Env) {
  const max = env ? resolveTextOutputLimit(env) : DEFAULT_TEXT_OUTPUT_LIMIT;
  return {
    content: [{ type: "text" as const, text: truncateToolText(text, max) }],
  };
}

export async function fetchModelsCached(client: CursorClient): Promise<CursorModelItem[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.items;
  }
  const data = await client.get<{ items?: CursorModelItem[]; models?: CursorModelItem[] }>(
    "/v1/models",
  );
  const items = data.items ?? data.models ?? [];
  modelsCache = { fetchedAt: now, items };
  return items;
}

function versionParts(id: string): number[] {
  const parts = id.match(/\d+/g);
  return parts ? parts.map((p) => parseInt(p, 10)) : [0];
}

function compareModelIds(a: string, b: string): number {
  const av = versionParts(a);
  const bv = versionParts(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

export function familyKey(id: string): string {
  if (id === "default") return "auto";
  if (id.startsWith("grok-")) return "grok";
  if (id.startsWith("composer-")) return "composer";
  if (id.startsWith("claude-opus-")) return "opus";
  if (id.startsWith("claude-fable-")) return "fable";
  if (id.startsWith("claude-sonnet-")) return "sonnet";
  if (id.startsWith("claude-haiku-")) return "haiku";
  if (id.startsWith("gemini-") && id.includes("pro")) return "gemini-pro";
  if (id.startsWith("gemini-")) return "gemini-flash";
  if (id.includes("codex")) return "codex";
  if (id.includes("nano")) return "gpt-nano";
  if (id.includes("mini") && id.startsWith("gpt-")) return "gpt-mini";
  if (id.includes("terra")) return "gpt-terra";
  if (id.includes("luna")) return "gpt-luna";
  if (id.startsWith("muse-")) return "muse";
  if (id.startsWith("kimi-")) return "kimi";
  if (id.startsWith("glm-")) return "glm";
  if (id.startsWith("gpt-")) return "gpt-flagship";
  return id;
}

export class ModelsCatalog {
  readonly items: CursorModelItem[];
  readonly byId: Map<string, CursorModelItem>;
  readonly latestByFamily: Map<string, CursorModelItem>;
  readonly latestAliases: Map<string, string>;

  constructor(items: CursorModelItem[]) {
    this.items = items;
    this.byId = new Map(items.map((m) => [m.id, m]));
    this.latestByFamily = new Map();
    for (const item of items) {
      const key = familyKey(item.id);
      const prev = this.latestByFamily.get(key);
      if (!prev || compareModelIds(item.id, prev.id) > 0) {
        this.latestByFamily.set(key, item);
      }
    }
    this.latestAliases = this.buildLatestAliases();
  }

  private buildLatestAliases(): Map<string, string> {
    const aliasToId = new Map<string, string>();

    const assign = (alias: string, modelId: string) => {
      const key = alias.toLowerCase();
      if (!aliasToId.has(key)) {
        aliasToId.set(key, modelId);
      }
    };

    for (const [family, model] of this.latestByFamily) {
      assign(family === "auto" ? "auto" : family, model.id);
      for (const [alias, fam] of Object.entries(CANONICAL_ALIASES)) {
        if (fam === family || (fam === "gpt" && family === "gpt-flagship")) {
          assign(alias, model.id);
        }
      }
      if (family === "gpt-flagship") {
        assign("gpt", model.id);
      }
      if (family === "gemini-pro") {
        assign("gemini", model.id);
      }
      if (family === "gemini-flash") {
        assign("gemini-flash", model.id);
      }
    }

    for (const model of this.latestByFamily.values()) {
      for (const alias of model.aliases ?? []) {
        assign(alias, model.id);
      }
    }

    return aliasToId;
  }

  resolveId(idOrAlias: string): string | undefined {
    const trimmed = stripZeroWidth(idOrAlias).trim();
    if (this.byId.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    if (this.byId.has(lower)) return lower;
    return this.latestAliases.get(lower);
  }

  listForDisplay(options: { includeLegacy?: boolean; query?: string }): CursorModelItem[] {
    const q = options.query?.trim().toLowerCase();
    const pool = options.includeLegacy
      ? [...this.items]
      : [...this.latestByFamily.values()];

    const filtered = q
      ? pool.filter((m) => {
          const hay = [
            m.id,
            m.displayName ?? "",
            ...(m.aliases ?? []),
            familyKey(m.id),
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : pool;

    return filtered.sort((a, b) => a.id.localeCompare(b.id));
  }

  aliasesForModel(modelId: string): string[] {
    const out: string[] = [];
    for (const [alias, id] of this.latestAliases) {
      if (id === modelId) out.push(alias);
    }
    return [...new Set(out)].sort();
  }

  /** Primary alias column from default `list_models` output (one per latest family). */
  defaultListPrimaryAliases(): string[] {
    return this.listForDisplay({ includeLegacy: false }).map((model) => {
      const aliases = this.aliasesForModel(model.id);
      return aliases[0] ?? model.id;
    });
  }

  nearestAliases(query: string, limit = 3): string[] {
    const q = stripZeroWidth(query).trim().toLowerCase();
    if (!q) return [];

    const aliases = this.defaultListPrimaryAliases();
    const ranked = aliases
      .map((alias) => {
        const lower = alias.toLowerCase();
        const prefixBoost =
          lower.startsWith(q) || q.startsWith(lower)
            ? 0
            : lower.includes(q) || q.includes(lower)
              ? 1
              : 2;
        return { alias, dist: levenshtein(q, lower), prefixBoost };
      })
      .sort(
        (a, b) =>
          a.prefixBoost - b.prefixBoost ||
          a.dist - b.dist ||
          a.alias.localeCompare(b.alias),
      );

    const maxDist = Math.max(2, Math.min(4, Math.ceil(q.length / 3)));
    const close = ranked.filter(
      (x) => x.prefixBoost === 0 || (x.prefixBoost === 1 && x.dist <= maxDist) || x.dist <= 2,
    );
    if (!close.length) return [];

    const best = close[0];
    if (best.prefixBoost > 1 || best.dist > maxDist) {
      return [];
    }

    return close.slice(0, limit).map((x) => x.alias);
  }
}

export function formatUnknownModelMessage(catalog: ModelsCatalog, query: string): string {
  const near = catalog.nearestAliases(query);
  return near.length
    ? `未知模型：${query}。相近：${near.join(", ")}`
    : `未知模型：${query}。无相近项`;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[a.length];
}

function shortParamId(id: string): string {
  if (id === "reasoning_effort" || id === "reasoning") return "effort";
  return id;
}

function orderedParamValues(param: ModelParameter): string[] {
  const raw = param.values.map((v) => stripZeroWidth(v.value));
  if (param.id === "effort" || param.id === "reasoning_effort" || param.id === "reasoning") {
    const order = ["none", ...EFFORT_LADDER, "extra-high"];
    return [...raw].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  return raw;
}

export function formatParametersShort(parameters?: ModelParameter[]): string {
  if (!parameters?.length) return "-";
  const parts: string[] = [];
  for (const param of parameters) {
    if (param.id === "cyber") continue;
    if (param.id === "fast") {
      parts.push("fast");
      continue;
    }
    if (param.id === "thinking") {
      parts.push("thinking");
      continue;
    }
    const values = orderedParamValues(param).filter((v) => v !== "false" && v !== "true");
    if (!values.length) continue;
    const id = shortParamId(param.id);
    if (values.length === 1) {
      parts.push(`${id}:${values[0]}`);
    } else if (
      (id === "effort" || id === "context") &&
      values.length > 2
    ) {
      parts.push(`${id}:${values[0]}..${values[values.length - 1]}`);
    } else {
      parts.push(`${id}:${values.join("|")}`);
    }
  }
  return parts.join(" ");
}

export function formatListModelsText(
  catalog: ModelsCatalog,
  options: { includeLegacy?: boolean; query?: string },
): string {
  const models = catalog.listForDisplay(options);
  const lines: string[] = [];
  for (const model of models) {
    const aliases = catalog.aliasesForModel(model.id);
    const alias = aliases[0] ?? model.id;
    const params = formatParametersShort(model.parameters);
    lines.push(`${alias}  ${model.id}  ${params}`);
  }
  return lines.join("\n");
}

function defaultVariant(model: CursorModelItem): ModelVariant | undefined {
  const variants = model.variants ?? [];
  return variants.find((v) => v.isDefault) ?? variants[0];
}

function paramValues(model: CursorModelItem, paramId: string): string[] {
  const def = model.parameters?.find((p) => p.id === paramId);
  return def?.values.map((v) => stripZeroWidth(v.value)) ?? [];
}

function normalizeEffortToken(value: string): UnifiedEffort | "none" | "extra-high" {
  if (value === "extra-high") return "extra-high";
  if (value === "none") return "none";
  return value as UnifiedEffort;
}

function effortRank(value: string): number {
  const order = ["none", "low", "medium", "high", "xhigh", "extra-high", "max"];
  const idx = order.indexOf(value);
  return idx === -1 ? 0 : idx;
}

function pickEffortValue(
  model: CursorModelItem,
  paramId: string,
  requested: UnifiedEffort,
): string {
  const available = paramValues(model, paramId);
  if (!available.length) return requested;

  let target = requested;
  if (paramId === "reasoning" && model.id === "gpt-5.5" && requested === "xhigh") {
    target = "xhigh";
  }

  const mapped =
    paramId === "reasoning" && model.id === "gpt-5.5" && (target === "xhigh" || target === "max")
      ? target === "xhigh"
        ? "extra-high"
        : target
      : target;

  if (available.includes(mapped)) return mapped;

  const reqRank = effortRank(
    mapped === "xhigh" && available.includes("extra-high") ? "extra-high" : mapped,
  );
  let best = available[0];
  let bestRank = -1;
  for (const value of available) {
    const rank = effortRank(normalizeEffortToken(value) as string);
    if (rank <= reqRank && rank >= bestRank) {
      best = value;
      bestRank = rank;
    }
  }
  if (bestRank >= 0) return best;
  return available[available.length - 1];
}

function parseContextSize(value: string): number {
  const m = value.toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? "";
  if (unit === "m") return n * 1_000_000;
  if (unit === "k") return n * 1_000;
  return n;
}

function pickContextValue(model: CursorModelItem, mode: "default" | "max"): string | undefined {
  const values = paramValues(model, "context");
  if (!values.length) return undefined;
  if (mode === "max") {
    return [...values].sort((a, b) => parseContextSize(b) - parseContextSize(a))[0];
  }
  const variant = defaultVariant(model);
  const fromDefault = variant?.params.find((p) => p.id === "context")?.value;
  if (fromDefault && values.includes(fromDefault)) return fromDefault;
  return values[0];
}

function effortParamId(model: CursorModelItem): string | undefined {
  if (paramValues(model, "effort").length) return "effort";
  if (paramValues(model, "reasoning_effort").length) return "reasoning_effort";
  if (paramValues(model, "reasoning").length) return "reasoning";
  return undefined;
}

function mapEffortToParamValue(
  model: CursorModelItem,
  paramId: string,
  requested: UnifiedEffort,
): string {
  if (paramId === "reasoning" && model.id === "gpt-5.5" && requested === "xhigh") {
    return "extra-high";
  }
  return requested;
}

function effortValuesEquivalent(
  requested: UnifiedEffort,
  actual: string,
  model: CursorModelItem,
  paramId: string,
): boolean {
  const ideal = mapEffortToParamValue(model, paramId, requested);
  if (actual === ideal) return true;
  if (model.id === "gpt-5.5" && paramId === "reasoning" && requested === "xhigh") {
    return actual === "extra-high";
  }
  return false;
}

function applyUnifiedFields(
  model: CursorModelItem,
  params: Map<string, string>,
  input: UnifiedModelInput,
  userSpecified: Set<string>,
): string[] {
  const notes: string[] = [];

  if (input.effort) {
    const paramId = effortParamId(model);
    if (paramId) {
      userSpecified.add(paramId);
      const picked = pickEffortValue(model, paramId, input.effort);
      params.set(paramId, picked);
      if (!effortValuesEquivalent(input.effort, picked, model, paramId)) {
        notes.push(`effort 请求 ${input.effort}，实际 ${picked}`);
      }
    } else {
      notes.push(`${model.id} 不支持 effort，已忽略`);
    }
  }
  if (input.fast !== undefined) {
    if (paramValues(model, "fast").length) {
      userSpecified.add("fast");
      params.set("fast", input.fast ? "true" : "false");
    } else {
      notes.push(`${model.id} 不支持 fast，已忽略`);
    }
  }
  if (input.context) {
    if (paramValues(model, "context").length) {
      userSpecified.add("context");
      const value = pickContextValue(model, input.context);
      if (value) params.set("context", value);
    } else {
      notes.push(`${model.id} 不支持 context，已忽略`);
    }
  }
  if (input.thinking !== undefined) {
    if (paramValues(model, "thinking").length) {
      userSpecified.add("thinking");
      params.set("thinking", input.thinking ? "true" : "false");
    } else {
      notes.push(`${model.id} 不支持 thinking，已忽略`);
    }
  }

  return notes;
}

function validateExplicitParams(model: CursorModelItem, params: ModelParamKV[]): void {
  for (const entry of params) {
    const allowed = paramValues(model, entry.id);
    if (!allowed.length) continue;
    if (!allowed.includes(entry.value)) {
      throw new CursorApiError(
        400,
        "validation_error",
        `模型 ${model.id} 参数 ${entry.id}=${entry.value} 无效，可选：${allowed.join(", ")}`,
      );
    }
  }
}

export function resolveModelSelection(
  catalog: ModelsCatalog,
  input: UnifiedModelInput,
): ResolvedModelSelection | undefined {
  if (!input.model?.trim()) return undefined;

  const resolvedId = catalog.resolveId(input.model);
  if (!resolvedId) {
    throw new CursorApiError(
      400,
      "model_not_found",
      formatUnknownModelMessage(catalog, input.model),
    );
  }

  const model = catalog.byId.get(resolvedId);
  if (!model) {
    throw new CursorApiError(400, "model_not_found", `未知模型：${input.model}`);
  }

  const variant = defaultVariant(model);
  const params = new Map<string, string>();
  const userSpecified = new Set<string>();

  for (const p of variant?.params ?? []) {
    params.set(p.id, stripZeroWidth(p.value));
  }

  if (input.model_params?.length) {
    validateExplicitParams(model, input.model_params);
    for (const p of input.model_params) {
      params.set(p.id, stripZeroWidth(p.value));
      userSpecified.add(p.id);
    }
  }

  const notes = applyUnifiedFields(model, params, input, userSpecified);

  const plainParams = [...params.entries()].map(([id, value]) => ({ id, value }));
  const applied_params: AppliedParamEntry[] = plainParams.map(({ id, value }) => ({
    id,
    value,
    source: userSpecified.has(id) ? "user" : "default",
  }));

  return {
    id: model.id,
    params: plainParams,
    applied_model: model.id,
    applied_params,
    ...(notes.length ? { applied_notes: notes } : {}),
  };
}

export function formatGetModelText(
  catalog: ModelsCatalog,
  idOrAlias: string,
  includeVariants = false,
): string {
  const resolvedId = catalog.resolveId(idOrAlias);
  if (!resolvedId) {
    return formatUnknownModelMessage(catalog, idOrAlias);
  }

  const model = catalog.byId.get(resolvedId)!;
  const aliases = catalog.aliasesForModel(model.id);
  const lines: string[] = [
    `id: ${model.id}`,
    `aliases: ${aliases.length ? aliases.join(", ") : "-"}`,
    `params: ${formatParametersShort(model.parameters)}`,
  ];

  const defs = model.parameters ?? [];
  if (defs.length) {
    lines.push("definitions:");
    for (const def of defs) {
      if (def.id === "cyber") continue;
      const values = orderedParamValues(def).join(", ");
      lines.push(`  ${def.id}: ${values}`);
    }
  }

  const variant = defaultVariant(model);
  if (variant?.params?.length) {
    lines.push(
      `defaults: ${variant.params
        .filter((p) => p.id !== "cyber")
        .map((p) => `${p.id}=${p.value}`)
        .join(", ")}`,
    );
  }

  if (includeVariants) {
    lines.push(`variants (${model.variants?.length ?? 0}):`);
    for (const v of model.variants ?? []) {
      const hidden = v.params.filter((p) => p.id !== "cyber");
      lines.push(`  - ${hidden.map((p) => `${p.id}=${p.value}`).join(", ")}`);
    }
  }

  return lines.join("\n");
}

export function buildModelPayload(
  selection: ResolvedModelSelection | undefined,
): { id: string; params: ModelParamKV[] } | undefined {
  if (!selection) return undefined;
  return { id: selection.id, params: selection.params };
}

export async function loadModelsCatalog(client: CursorClient): Promise<ModelsCatalog> {
  const items = await fetchModelsCached(client);
  return new ModelsCatalog(items);
}
