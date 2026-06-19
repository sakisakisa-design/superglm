// Provider router with failover + circuit breaking — mirrors
// backend/app/provider_router.ProviderRouter.
//
// Given a resolved target model (and optional pinned provider), the router
// produces ordered candidate providers, attempts them in order, and records
// circuit-breaker state per provider:model. Streaming requests pick the first
// available candidate (the stream is then driven by the pipeline).

import type { ProviderConfig } from "../types/config";
import type { RouteAttempt } from "../types/provider";
import type { ConfigStore } from "../storage/configStore";
import { CircuitBreaker, DEFAULT_BREAKER_CONFIG } from "./circuitBreaker";
import { UpstreamStatusError, callOpenAIChat, iterOpenAIChatStream } from "./providerClient";

export interface RouterOptions {
  pinnedProviderId?: string | undefined;
  forceRole?: string | undefined;
  /** When set, only providers speaking this protocol are eligible (e.g. Fusion is OpenAI-only). */
  requireProtocol?: "openai" | "anthropic" | undefined;
  /** Per-call upstream timeout in ms. Falls back to the providerClient default (300000) when unset. */
  timeoutMs?: number | undefined;
}

export interface RoutedCall {
  response: Record<string, unknown>;
  provider: ProviderConfig;
  attempts: RouteAttempt[];
}

export interface PreparedStream {
  payload: Record<string, unknown>;
  provider: ProviderConfig;
  attempts: RouteAttempt[];
}

function providerModels(provider: ProviderConfig): string[] {
  const models = (provider.capabilities as { models?: unknown } | undefined)?.models;
  if (Array.isArray(models)) return models.filter((m): m is string => typeof m === "string");
  return [];
}

export class ProviderRouter {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly store: ConfigStore,
    private readonly breakerConfig = DEFAULT_BREAKER_CONFIG,
  ) {}

  async resolveCandidates(
    targetModel: string,
    pinnedProviderId?: string,
    requireProtocol?: "openai" | "anthropic",
  ): Promise<ProviderConfig[]> {
    const providers = await this.store.listProviderProfiles();
    let enabled = providers.filter((p) => p.enabled !== false);
    if (requireProtocol) {
      enabled = enabled.filter((p) => (p.protocol ?? "openai") === requireProtocol);
    }
    if (pinnedProviderId) {
      const pinned = enabled.find((p) => p.id === pinnedProviderId);
      if (pinned) return [pinned];
    }
    const matching = enabled.filter((p) => {
      const models = providerModels(p);
      return models.length === 0 || models.includes(targetModel);
    });
    if (matching.length > 0) return this.roundRobin(targetModel, matching);
    // Fallback: only fall back to the already-filtered (enabled / protocol-correct) set.
    // Falling back to the raw provider list would re-include disabled providers and
    // (when requireProtocol is set) bypass the protocol filter (e.g. sending an
    // Anthropic-direct request to /v1/chat/completions).
    return this.roundRobin(targetModel, enabled);
  }

  /** Non-streaming OpenAI Chat call with failover. */
  async callOpenAIChatWithFailover(
    payload: Record<string, unknown>,
    targetModel: string,
    opts: RouterOptions = {},
  ): Promise<RoutedCall> {
    const candidates = await this.resolveCandidates(targetModel, opts.pinnedProviderId, opts.requireProtocol);
    const attempts: RouteAttempt[] = [];
    let lastError: unknown = null;
    for (const provider of candidates) {
      const breaker = this.breaker(provider, targetModel);
      if (!breaker.allowRequest()) {
        attempts.push({
          providerId: provider.id,
          model: targetModel,
          status: "skipped",
          reason: "circuit_open",
          circuit: breaker.snapshot(),
        });
        continue;
      }
      const routedPayload = { ...payload, model: targetModel };
      try {
        const response = await callOpenAIChat(routedPayload, provider, opts.timeoutMs);
        breaker.recordSuccess();
        attempts.push({
          providerId: provider.id,
          model: targetModel,
          status: "success",
          circuit: breaker.snapshot(),
        });
        return { response, provider, attempts };
      } catch (err) {
        breaker.recordFailure();
        lastError = err;
        attempts.push({
          providerId: provider.id,
          model: targetModel,
          status: "failed",
          ...(err instanceof UpstreamStatusError ? { statusCode: err.status } : {}),
          error: `${err instanceof Error ? err.name : "Error"}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          circuit: breaker.snapshot(),
        });
      }
    }
    if (lastError) throw lastError;
    throw new Error("No available provider candidates");
  }

  /** Pick the first available candidate for a streaming call. */
  async prepareOpenAIChatStream(
    payload: Record<string, unknown>,
    targetModel: string,
    opts: RouterOptions = {},
  ): Promise<PreparedStream> {
    const candidates = await this.resolveCandidates(targetModel, opts.pinnedProviderId, opts.requireProtocol);
    const attempts: RouteAttempt[] = [];
    for (const provider of candidates) {
      const breaker = this.breaker(provider, targetModel);
      if (!breaker.allowRequest()) {
        attempts.push({
          providerId: provider.id,
          model: targetModel,
          status: "skipped",
          reason: "circuit_open",
          circuit: breaker.snapshot(),
        });
        continue;
      }
      attempts.push({
        providerId: provider.id,
        model: targetModel,
        status: "streaming",
        circuit: breaker.snapshot(),
      });
      return { payload: { ...payload, model: targetModel }, provider, attempts };
    }
    throw new Error("No available provider candidates");
  }

  /** Streaming iterator over the chosen provider. Pipeline records breaker outcome. */
  async *streamOpenAIChat(
    payload: Record<string, unknown>,
    targetModel: string,
    opts: RouterOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const prepared = await this.prepareOpenAIChatStream(payload, targetModel, opts);
    const breaker = this.breaker(prepared.provider, targetModel);
    try {
      for await (const chunk of iterOpenAIChatStream(prepared.payload, prepared.provider, opts.timeoutMs)) {
        yield chunk;
      }
      breaker.recordSuccess();
    } catch (err) {
      breaker.recordFailure();
      throw err;
    }
  }

  status(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, breaker] of this.breakers.entries()) out[key] = breaker.snapshot();
    return out;
  }

  private roundRobin(targetModel: string, candidates: ProviderConfig[]): ProviderConfig[] {
    if (candidates.length <= 1) return candidates;
    const idx = (this.counters.get(targetModel) ?? 0) % candidates.length;
    this.counters.set(targetModel, idx + 1);
    return [...candidates.slice(idx), ...candidates.slice(0, idx)];
  }

  private breaker(provider: ProviderConfig, targetModel: string): CircuitBreaker {
    const key = `${provider.id}:${targetModel}`;
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(this.breakerConfig);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}
