# AI API cheat sheet (effect@4.1.x)

Imports: `import { AiError, Chat, EmbeddingModel, LanguageModel, Model, Prompt, Response, Tokenizer, Tool, Toolkit } from "effect/ai"`.
All of `effect/ai` is `@stability unstable`; pin `effect` and every `@effect/ai-*`
package to the same version. Checked against `node_modules/effect/src/ai`.

## LanguageModel

| API | Result |
| --- | --- |
| `LanguageModel.generateText(opts)` | `Effect<GenerateTextResponse, AiError, LanguageModel \| toolkit services>` |
| `LanguageModel.generateObject({ schema, objectName?, prompt, toolkit?, ... })` | `Effect<GenerateObjectResponse<..., A>, AiError, LanguageModel>`; `.value: A` |
| `LanguageModel.streamText(opts)` | `Stream<Response.StreamPart, AiError, LanguageModel>` |
| `LanguageModel.make({ generateText, streamText, codecTransformer? })` | build a `LanguageModel` from provider hooks (also how you write a fake) |
| `yield* LanguageModel.LanguageModel` | the service value with the same three methods |

Common options (`GenerateTextOptions`): `prompt` (string, array of
`{ role, content }`, or `Prompt`), `toolkit`, `toolChoice` (`"auto" | "none" | "required" | { tool: name } | { oneOf: names, mode? }`),
`concurrency` (tool handler concurrency), `disableToolCallResolution` (return tool calls
without running handlers; then the toolkit's handler requirements are not needed),
`toolCallValidation: "strict" | "deferred"` (4.1; with resolution disabled, `"deferred"` returns
calls with `unknown` params, including undeclared tool names, for you to validate).

`GenerateTextResponse` getters: `text`, `reasoningText`, `toolCalls`, `toolResults`
(each has `name`, `id`, `result`/`params`, `isFailure`), `finishReason`
(`"stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" | "other" | "unknown"`),
`usage` (`inputTokens.total/uncached/cacheRead/cacheWrite`, `outputTokens.total/text/reasoning`),
and `content` (all parts).

Streaming parts you will meet: `text-start`, `text-delta` (`.delta`), `text-end`, `tool-call`,
`tool-result`, `finish` (`reason`, `usage`). Narrow with a predicate:
`Stream.filter((p): p is Response.TextDeltaPart => p.type === "text-delta")`.

## Model and provider layers

```ts import.meta.vitest name="references/ai/api-cheatsheet.md#1"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Config, Effect, Layer } from "effect"
import { LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"

// Client: apiKey/apiUrl/organizationId/projectId are Configs; transformClient wraps the HttpClient.
const Client = OpenAiClient.layerConfig({
  apiKey: Config.Redacted("OPENAI_API_KEY")
}).pipe(Layer.provide(FetchHttpClient.layer))

// Model is a Layer<LanguageModel | ProviderName | ModelName, never, OpenAiClient>.
export const Fast = OpenAiLanguageModel.model("gpt-4.1-mini").pipe(Layer.provide(Client))

// The same, as a plain layer constructor.
export const Smart = OpenAiLanguageModel.layer({ model: "gpt-5.2" }).pipe(Layer.provide(Client))

// Inside a Layer.effect: capture the client requirement once, provide per call.
export const useBoth = Effect.gen(function*() {
  const fast = yield* OpenAiLanguageModel.model("gpt-4.1-mini").captureRequirements
  return LanguageModel.generateText({ prompt: "hi" }).pipe(Effect.provide(fast))
}).pipe(Effect.provide(Client))

// Per-call provider options (temperature, etc.) without changing the layer:
export const warm = LanguageModel.generateText({ prompt: "hi" }).pipe(
  OpenAiLanguageModel.withConfigOverride({ temperature: 0.9 })
)
```

`Model.ProviderName` and `Model.ModelName` are services provided by a model
layer; read them for logging or span attributes.

## AiError

`AiError` is a single tagged error (`_tag: "AiError"`) with `module`, `method`
and a `reason`. Switch on `error.reason._tag`:

| Reason | Retryable | Typical response |
| --- | --- | --- |
| `RateLimitError` | yes (`retryAfter` available as `error.retryAfter`) | back off |
| `InternalProviderError`, `NetworkError` (`reason: "TransportError"` only), `InvalidOutputError`, `StructuredOutputError` | yes | bounded retry, then fail |
| `InvalidResponseError` (4.1: provider reply has an incompatible shape), `QuotaExhaustedError`, `AuthenticationError`, `ContentPolicyError`, `InvalidRequestError`, `UnsupportedSchemaError`, `UnknownError` | no | surface / alert |
| `ToolNotFoundError`, `ToolParameterValidationError` | yes (model may self-correct) | bounded retry |
| `InvalidToolResultError`, `ToolResultEncodingError`, `ToolConfigurationError`, `ToolkitRequiredError`, `InvalidUserInputError` | no | fix the toolkit or the prompt input |

`error.isRetryable` and `error.retryAfter` delegate to the reason. To keep the
reason in your own error, embed the schema: `reason: AiError.AiErrorReason`
(it is a `Schema`), as the upstream examples do. `NetworkError` now carries `method`,
`url` and an optional `cause` (the original `HttpClientError`, unredacted) instead of the
removed `request: HttpRequestDetails`; build one from a client failure with
`AiError.NetworkError.fromHttpClientError`.

## Tools

```ts import.meta.vitest name="references/ai/api-cheatsheet.md#2"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

export const Search = Tool.make("Search", {
  description: "Search the catalog",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Array(Schema.String),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return", // handler failures go back to the model as results
  needsApproval: (params) => params.query.includes("internal") // boolean or (params, ctx) => boolean | Effect<boolean>
})

export const Catalog = Toolkit.make(Search)
export const CatalogLive = Catalog.toLayer({
  Search: ({ query }) => Effect.succeed([`result for ${query}`])
})
```

`Tool.make(name, { description?, parameters?, success?, failure?, failureMode?, dependencies?, needsApproval?, toModelOutput? })`.
`Toolkit.make(...tools)` is itself an Effect yielding the toolkit with handlers
(`yield* Catalog`) and needs the handler layer. `Toolkit.merge(a, b)` combines
toolkits; `Toolkit.empty` is the identity. Provider-defined tools (for example
`OpenAiTool.WebSearch({...})`) are added to the toolkit but run on the provider
side, so they need no handler. Handlers receive `(params, { toolCallId, preliminary })`;
`preliminary(partial)` streams partial results.

### Shape what the model sees with `toModelOutput`

The handler's full `success` value stays in `toolResults[i].result` for your code, but the
model is shown the `Prompt.ToolModelOutputPart[]` (text or file parts) that `toModelOutput`
returns. Use it to send a summary instead of 10,000 rows. The result part in the history
carries it as `modelOutput`; `Prompt.toolModelOutputToText(parts)` flattens parts to a string.

```ts import.meta.vitest name="references/ai/api-cheatsheet.md#3"
import { Effect, Layer, Schema, Stream } from "effect"
import { Chat, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"

const Report = Tool.make("Report", {
  description: "Load a report",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String, rows: Schema.Array(Schema.Number) }),
  toModelOutput: (result) => [
    Prompt.textPart({ text: `${result.rows.length} rows, total ${result.rows.reduce((a, b) => a + b, 0)}` })
  ]
})
const Reports = Toolkit.make(Report)
const ReportsLive = Reports.toLayer({ Report: ({ id }) => Effect.succeed({ id, rows: [1, 2, 3] }) })

const usage = { inputTokens: {}, outputTokens: {} }
const replies = [
  [{ type: "tool-call", id: "c1", name: "Report", params: { id: "r1" } }, { type: "finish", reason: "tool-calls", usage }],
  [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage }]
]
const seenPrompts: Array<Prompt.Prompt> = []
let next = 0
const ScriptedModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: (options) => Effect.sync(() => (seenPrompts.push(options.prompt), replies[next++] as any)),
    streamText: () => Stream.empty
  })
)

const program = Effect.gen(function*() {
  const toolkit = yield* Reports
  const chat = yield* Chat.fromPrompt([{ role: "user", content: "summarize r1" }])
  const first = yield* chat.generateText({ prompt: [], toolkit })
  yield* chat.generateText({ prompt: [], toolkit })

  // Your code still gets the full value,
  const full = first.toolResults[0]?.result
  // while the second model request carried only the summary.
  const toolMessage = seenPrompts[1]!.content.find((message) => message.role === "tool")
  const part = toolMessage?.role === "tool" ? toolMessage.content[0] : undefined
  return [full, part?.type === "tool-result" ? Prompt.toolModelOutputToText(part.modelOutput ?? []) : ""] as const
}).pipe(Effect.provide(ReportsLive), Effect.provide(ScriptedModel))

const [full, summary] = await Effect.runPromise(program)
summary // => "3 rows, total 6"
```

Approval flow: a tool with `needsApproval` is not executed when called. The
response contains a `tool-approval-request` part with an `approvalId`; answer it
in the next turn by adding a `tool-approval-response` part (`Prompt.toolApprovalResponsePart`
with `approvalId`, `approved`, optional `reason`) to the prompt/history, and pass
the same toolkit again so the approved call can run. Read
`LanguageModel.ts` (search `collectToolApprovals`) before building on this.

## Chat

| API | Notes |
| --- | --- |
| `Chat.empty` / `Chat.fromPrompt(rawPrompt)` | `Effect<Chat>`; history lives in a `Ref` |
| `chat.generateText`, `chat.generateObject`, `chat.streamText` | same options as `LanguageModel`; require `LanguageModel` in R; append to history |
| `chat.history` | `Ref<Prompt>` (`Ref.get(chat.history)`) |
| `chat.export`, `chat.exportJson`, `Chat.fromExport`, `Chat.fromJson` | snapshots |
| `Chat.layerPersisted({ storeId })` + `Chat.Persistence` | `get(chatId)` / `getOrCreate(chatId, { timeToLive })` returning `Persisted` (with `save`); needs a backing persistence store ([persistence](../persistence/guide.md)) |

## Prompt

`Prompt.make(raw)`, `Prompt.empty`, `Prompt.setSystem(text)`, `Prompt.fromMessages`; message
constructors `Prompt.systemMessage`, `userMessage`, `assistantMessage`, `toolMessage`; part
constructors `textPart`, `filePart`, `toolCallPart`, `toolResultPart`. Raw input may be a
string or `[{ role: "system" | "user" | "assistant", content }]`.

## Other modules

- `EmbeddingModel.EmbeddingModel`: `embed(string)`, `embedMany(strings)`; provider
  layer `OpenAiEmbeddingModel.model(id, options)` in `@effect/ai-openai`.
- `Tokenizer.Service`: `tokenize(prompt)`, `truncate(prompt, tokens)`.
- `Telemetry`: span transformers for GenAI attributes (see [observability](../observability/guide.md)). 4.1 renamed
  attributes to the current OpenTelemetry GenAI names: `gen_ai.provider.name` (was `gen_ai.system`) and
  `gen_ai.output.type`; the `gen_ai.token.type` group is gone.
- `Decision`, `DecisionModel`: classification, rating, probability and locate decisions over one input
  (`DecisionModel.decide`; 4.1 adds `decideSettled`, which keeps valid answers when others fail). Read the sources before use.
- `McpServer`, `McpSchema`, `McpProtocol`, `McpTest`, `McpClient`: Model Context Protocol. Expose a
  `Toolkit` as MCP tools with `McpServer.toolkit(toolkit)`, run it over `McpServer.layerStdio`
  or `layerHttp`, and test it in memory with `McpTest.makeClient`. 4.1 adds `McpServer.middleware`
  (per-request services), `McpServer.skill`/`registerSkill` (publish Agent Skills) and
  `McpClient` (experimental scoped client: `listTools`, `callTool`, `listSkills`, `readSkillResource`;
  transports `McpClient.stdio`/`http` and `layerStdio`/`layerHttp`).

```ts import.meta.vitest name="references/ai/api-cheatsheet.md#4"
import { Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer, McpTest, Tool, Toolkit } from "effect/ai"

const Add = Tool.make("add", {
  description: "Add two numbers",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number
})
const MathTools = Toolkit.make(Add)
const MathLive = MathTools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

// Registration layer: what a real server would pass as `registrations` to layerStdio/layerHttp.
const registrations = McpServer.toolkit(MathTools).pipe(Layer.provide(MathLive))

const program = Effect.gen(function*() {
  const client = yield* McpTest.makeClient(registrations, { protocols: [McpProtocol.v2025_11_25] })
  const listed = yield* client.listTools()
  const called = yield* client.callTool({ name: "add", arguments: { a: 1, b: 2 } })
  return { names: listed.tools.map((tool) => tool.name), isError: called.isError }
}).pipe(Effect.scoped)

await Effect.runPromise(program) // => { names: ["add"], isError: false }
```
- `OpenAiStructuredOutput`, `AnthropicStructuredOutput`: provider-specific schema
  transformers used internally by the providers.
