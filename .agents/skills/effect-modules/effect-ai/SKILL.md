---
compatibility: Examples target effect@4.0.0; align @effect/* packages. Effect v3 requires migration.
description: Use when integrating an AI model or provider with Effect, generating structured output, exposing typed tools, managing chat state, or consuming streamed responses.
metadata:
  github-path: skills/effect-ai
  github-ref: refs/heads/main
  github-repo: https://github.com/nmnmcc/effect-skills
  github-tree-sha: 258a547f1012a4a4ca513bd3b5a31870c5a84b9c
name: effect-ai
---

# Effect AI

Use this skill for the schema-first AI runtime in `effect/ai` and its provider
packages. It covers these modules and boundaries:

- Core model services: `LanguageModel`, `Model`, `Prompt`, `Response`, `Chat`,
  `AiError`, `EmbeddingModel`, `Tokenizer`, `Telemetry`, and `IdGenerator`.
- Tool execution: `Tool`, `Toolkit`, provider-defined tools, approval requests,
  tool result streaming, and `failureMode`.
- Structured and policy-oriented APIs: `OpenAiStructuredOutput`,
  `AnthropicStructuredOutput`, `Decision`, `DecisionModel`, and response-id
  tracking.
- MCP: `McpSchema`, `McpProtocol`, and `McpServer`, including their versioned
  schema and transport boundaries.
- Providers: `@effect/ai-openai`, `@effect/ai-anthropic`,
  `@effect/ai-openai-compat`, `@effect/ai-openrouter`, and
  `@effect/ai-typesafe`.

## Activate

Activate when a request mentions any of those import paths, asks to add a chat or
agent, extracts typed JSON from a model, exposes tools to a model, integrates an
MCP server/client, switches providers, adds AI telemetry, or diagnoses a stream
that leaks or fails during cancellation. Also activate when reviewing code that
places API keys in source, loops on tool calls without a bound, or treats model
output as trusted JSON.

## Version gate

Read `package.json` and the lockfile before choosing an example. This skill
targets the published `4.0.0` and its `effect/ai` modules;
provider layers are unstable. Effect v3 uses different imports and signatures,
so these are not a drop-in match. If the project is on v3, use its pinned
documentation or make an explicit upgrade decision; do not silently mix v4
`effect/ai` examples into a v3 program. Keep `effect` and every
`@effect/ai-*` provider on compatible versions.

## Design workflow

1. Identify the boundary. Use `LanguageModel.generateText` for text, `generateObject`
   for a decoded `Schema`, and `streamText` for incremental `Response` parts.
   Use `Chat` when history is state, not when a single prompt is enough.
2. Configure a provider once. Build its client with `Config.Redacted`, provide an
   HTTP client layer, then expose a model layer with `OpenAiLanguageModel.model`
   (or the corresponding provider API). Keep provider requirements in the layer
   graph instead of global mutable state.
3. Describe data with `Schema`. Treat prompts and response parts as typed
   boundaries; inspect `response.usage`, `finishReason`, `toolCalls`, and
   `toolResults` rather than parsing an unvalidated string.
4. Define tools with `Tool.make` and group them with `Toolkit.make`. Give every
   parameter and result a schema, a useful description, an explicit failure
   strategy, and an approval policy for side effects. Implement handlers through
   `Toolkit.toLayer` so database, filesystem, and network dependencies remain
   visible.
5. Make agent loops finite. `Chat` records tool results for the next turn, but
   the application owns the loop. Set a maximum round count, model/tool timeout,
   and cancellation path; return a typed domain failure when the bound is
   reached.
6. Map `AiError` at the application boundary. Preserve its reason (auth,
   rate-limit, transport, invalid request/output, tool validation, or provider
   defect) in a domain error, while logging only safe metadata.

## Minimal model and object generation

```ts
import { Config, Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { AiError, LanguageModel } from "effect/ai";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";

const OpenAiClientLayer = OpenAiClient.layerConfig({
  apiKey: Config.Redacted("OPENAI_API_KEY"),
}).pipe(Layer.provide(FetchHttpClient.layer));

const Answer = Schema.Struct({
  answer: Schema.String,
  confidence: Schema.Number,
});

const ModelLayer = OpenAiLanguageModel.model("gpt-5.2").pipe(
  Layer.provide(OpenAiClientLayer),
);

const program = LanguageModel.generateObject({
  objectName: "answer",
  prompt: "Summarize the incident and give a confidence from 0 to 1",
  schema: Answer,
}).pipe(
  Effect.map((response) => response.value),
  Effect.catchTag("AiError", (error: AiError.AiError) =>
    Effect.fail(new Error(`AI request failed: ${error.reason._tag}`)),
  ),
  Effect.provide(ModelLayer),
);
```

`generateObject` validates and decodes the provider response through `Answer`.
Do not use `JSON.parse(response.text)` as a substitute. If the provider supports
special JSON-schema constraints, choose its structured-output transformer and
verify the installed provider declaration.

## Tools, streaming, and chat state

```ts
import { Effect, Schema, Stream } from "effect";
import { LanguageModel, Response, Tool, Toolkit } from "effect/ai";

const Lookup = Tool.make("Lookup", {
  description: "Look up a product by its stable id",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, stock: Schema.Number }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
});

const Products = Toolkit.make(Lookup);
const ProductsLayer = Products.toLayer({
  Lookup: ({ id }) => Effect.succeed({ id, stock: 3 }),
});

const response = LanguageModel.generateText({
  prompt: "Check product p-42 and explain whether it is in stock",
  toolkit: Products,
  toolChoice: "auto",
  concurrency: 4,
}).pipe(Effect.provide(ProductsLayer));

const textStream = LanguageModel.streamText({
  prompt: "Write three release highlights",
}).pipe(
  Stream.filter(
    (part): part is Response.TextDeltaPart => part.type === "text-delta",
  ),
  Stream.map((part) => part.delta),
);
```

`Toolkit` is itself an effect: provide `ProductsLayer` before passing `Products`
to a generation call, or yield it inside an `Effect.gen` service. The resulting
`response` still requires a `LanguageModel` service, so compose this layer with
the provider `ModelLayer` from the first example at the application boundary.
With
`failureMode: "error"`, handler and schema failures fail the generation effect;
with `"return"`, they become typed tool-result parts and the model can decide how
to recover. `concurrency` bounds concurrent tool handlers, but it is not a bound
on chat turns. Consume `textStream` inside the caller's scope so interruption
closes the provider response and interrupts in-flight handlers.

For a stateful session, create `Chat.empty` or `Chat.fromPrompt`, call
`chat.generateText`/`chat.streamText`, and inspect `chat.history`. Use
`Chat.fromJson`/`exportJson` for an explicit snapshot or `Chat.makePersisted` and
its persistence layer when history must survive a process restart. Persist only
the prompt/response data needed by the product and define a migration policy for
provider-specific parts.

## Failure, lifecycle, and runtime boundaries

- `AiError` is the expected failure channel for provider requests and normalized
  model/tool problems. Map it with `catchTag` or `Effect.mapError`; keep defects
  (programming errors, impossible response shapes) distinct from recoverable
  provider errors.
- `SchemaError` from structured output, tool parameters, or tool results is a
  contract failure. Include the schema issue in a typed domain error and avoid
  retrying deterministic invalid prompts forever.
- API keys belong in `Config.Redacted`; never interpolate them into prompts,
  spans, response metadata, or logs. Redact request headers in telemetry.
- A provider client, HTTP client, MCP transport, and persisted chat store are
  resources. Construct them in `Layer`s and run streams/chats in a scoped
  runtime. Do not retain a service value after its layer scope closes.
- `LanguageModel.streamText` is lazy. Starting a stream can allocate provider
  resources; cancellation must be observable by the consumer. Use
  `Stream.runForEach`, `Stream.runCollect`, or a scoped handoff rather than
  dropping the stream.
- Tool handlers are ordinary effects and can be retried or run concurrently.
  Make external writes idempotent, set timeouts, and require approval for
  destructive actions (`needsApproval`). Keep agent rounds, token budgets, and
  provider retries bounded.
- MCP protocol versions and transports are wire contracts. Use the matching
  `McpSchema` version on both sides, validate capabilities, and close the
  transport scope on shutdown. Do not expose arbitrary MCP tools without an
  allowlist and authorization boundary.

## Related modules

Use `effect/Schema`, `effect/Config`, `effect/Layer`, `effect/Stream`, and
`effect/Scope` for the surrounding boundaries. Use `effect/ExecutionPlan` when
provider fallback and retry policy is a product decision; keep each provider
layer explicit so its credentials and transport requirements remain visible.

## References

- [Language model API](https://effect.website/docs/v4/api/effect/ai/LanguageModel)
- [Chat API](https://effect.website/docs/v4/api/effect/ai/Chat)
- [Tool API](https://effect.website/docs/v4/api/effect/ai/Tool)
- [Toolkit API](https://effect.website/docs/v4/api/effect/ai/Toolkit)
- [OpenAI provider](https://effect.website/docs/v4/api/ai-openai)
- [Effect AI source](https://github.com/Effect-TS/effect/tree/effect%404.0.0/packages/effect/src/ai)
- [Pinned LanguageModel source](https://github.com/Effect-TS/effect/blob/effect%404.0.0/packages/effect/src/ai/LanguageModel.ts)
- [AI examples](https://github.com/Effect-TS/effect/tree/effect%404.0.0/ai-docs/src/71_ai)
