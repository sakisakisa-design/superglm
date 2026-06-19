// Internal request schema — mirrors section 6 of the architecture plan and
// backend/app/adapters.py normalization logic. All protocols (Anthropic Messages,
// OpenAI Chat, OpenAI Responses) normalize into InternalRequest before routing.

import type { ModelRole } from "./config";
import type { SanitizationReport } from "../compat/billingHeaderSanitizer";

export type ClientProtocol = "anthropic" | "openai" | "openai_responses" | "gateway";
export type ClientName = "claude-code" | "cursor" | "openai-sdk" | "unknown";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: string;
  dataRef: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: unknown;
}

export type ContentBlock = TextBlock | ImageBlock | ToolResultBlock;

export interface InternalMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: ContentBlock[] | string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  reasoning_content?: string;
  [k: string]: unknown;
}

export interface InternalTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  [k: string]: unknown;
}

export interface GenerationParams {
  maxTokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  topP?: number;
  top_k?: number;
  stop?: string[];
  seed?: number;
  response_format?: unknown;
  presence_penalty?: number;
  frequency_penalty?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  parallel_tool_calls?: boolean;
  tool_choice?: unknown;
  service_tier?: string;
  metadata?: unknown;
  extra_body?: unknown;
  [k: string]: unknown;
}

export interface OpaqueReasoningEntry {
  provider: string;
  kind: string;
  message_index?: number;
  block_index?: number;
  item_index?: number;
  value: unknown;
  mustReplayUnmodified: boolean;
}

export interface InternalRequest {
  traceId: string;
  clientProtocol: ClientProtocol;
  clientName?: ClientName;

  incomingModel: string;
  resolvedProfileId?: string;
  resolvedRole?: ModelRole;

  system: string;
  messages: InternalMessage[];
  tools?: InternalTool[];

  stream: boolean;
  generation: GenerationParams;

  metadata: {
    originalHeaders?: Record<string, string>;
    sanitized?: SanitizationReport;
    cache?: CacheReport;
    rawRequestRef?: string;
    opaqueReasoning?: OpaqueReasoningEntry[];
    [k: string]: unknown;
  };
}

export interface CacheReport {
  billingHeaderStripped: boolean;
  systemPrefixStable: boolean;
  toolSchemaOrderStable: boolean;
  volatileTimestampDetected: boolean;
}

export interface ResolvedModelCall {
  providerId: string;
  litellmModel: string;
  apiBase: string;
  apiKeyRef: string;
  actualModelName: string;
  stream: boolean;
  payload: unknown;
}

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  ENCRYPTION_KEY?: string;
  /** When "1" / "true", refuse to store provider api_keys unless ENCRYPTION_KEY is set. */
  REQUIRE_SECRET_ENCRYPTION?: string;
  [key: string]: unknown;
}
