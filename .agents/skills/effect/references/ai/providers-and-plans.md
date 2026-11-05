# Providers, config overrides and fallback plans

## Layer shape

```
OpenAiClient.layerConfig(...)      Layer<OpenAiClient, ConfigError, HttpClient>
OpenAiLanguageModel.model("id")    Layer<LanguageModel | ProviderName | ModelName, never, OpenAiClient>
FetchHttpClient.layer              Layer<HttpClient>
```

Compose from the left: `model.pipe(Layer.provide(client), Layer.provide(http))`.
The result has no requirements besides what the `Config` needs, and its error is
`ConfigError`. Other providers (`@effect/ai-anthropic`, `@effect/ai-openai-compat`,
`@effect/ai-openrouter`) expose the same pair (`XClient.layerConfig`,
`XLanguageModel.model`); they are not installed in this repository, so read their
declarations in your project before copying names. Upstream shows
`AnthropicLanguageModel.model("claude-opus-4-6")` and `AnthropicClient.layerConfig`.

## Fallback across models with ExecutionPlan

An `ExecutionPlan` lists steps; each step provides a layer and may limit
`attempts` (and optionally `schedule` or `while`). `Effect.withExecutionPlan`
runs the effect with the first step's services, moves to the next step when the
effect fails, and finally fails with the last error. `captureRequirements` turns
the plan into something you can build inside a `Layer.effect` so the client
requirements are resolved by the layer graph rather than at every call site.

```ts import.meta.vitest name="references/ai/providers-and-plans.md#1"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { Config, Context, Effect, ExecutionPlan, Layer, Schema } from "effect"
import { AiError, LanguageModel, Model } from "effect/ai"
import { FetchHttpClient } from "effect/http"

export class DraftFailed extends Schema.TaggedError<DraftFailed>()("DraftFailed", {
  reason: AiError.AiErrorReason
}) {}

// Try the strong model twice, then fall back to a cheaper one once.
const Plan = ExecutionPlan.make(
  { provide: OpenAiLanguageModel.model("gpt-5.2"), attempts: 2 },
  { provide: OpenAiLanguageModel.model("gpt-4.1-mini"), attempts: 1 }
)

export class Drafts extends Context.Service<Drafts, {
  announce(product: string): Effect.Effect<{ readonly model: string; readonly text: string }, DraftFailed>
}>()("app/Drafts") {
  static readonly layer = Layer.effect(
    Drafts,
    Effect.gen(function*() {
      // Moves the plan's OpenAiClient requirement into this layer's requirements.
      const plan = yield* Plan.captureRequirements
      return Drafts.of({
        announce: Effect.fn("Drafts.announce")(
          function*(product: string) {
            const model = yield* Model.ModelName
            const response = yield* LanguageModel.generateText({
              prompt: `Write a two-sentence launch announcement for ${product}.`
            })
            return { model, text: response.text }
          },
          // Run the effect under the plan; AiError is mapped at the boundary.
          Effect.withExecutionPlan(plan),
          Effect.mapError((error) => new DraftFailed({ reason: error.reason }))
        )
      })
    })
  ).pipe(
    Layer.provide(OpenAiClient.layerConfig({ apiKey: Config.Redacted("OPENAI_API_KEY") })),
    Layer.provide(FetchHttpClient.layer)
  )
}
```

Fallback is a product decision (cost, data residency, output differences), so
keep each step explicit and log which step succeeded (read `Model.ProviderName`
and `Model.ModelName` inside the effect). Plans retry any failure, so add
`while: (error) => error.isRetryable` to a step when some failures (policy,
auth) must not move on silently.
