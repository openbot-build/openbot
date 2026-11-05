# Streaming to a consumer

```ts import.meta.vitest name="references/ai/streaming.md#1"
import { Effect, Stream } from "effect"
import { LanguageModel, type Response } from "effect/ai"

// Returns a lazy Stream<string, AiError, LanguageModel>. Nothing is sent until
// the consumer runs it, and interrupting the consumer cancels the HTTP request.
export const highlights = (version: string) =>
  LanguageModel.streamText({ prompt: `Write release highlights for ${version}.` }).pipe(
    Stream.filter((part): part is Response.TextDeltaPart => part.type === "text-delta"),
    Stream.map((part) => part.delta)
  )

// Consume with a bound: collect, forEach, or hand to an HTTP response stream.
export const preview = highlights("4.0.0").pipe(
  Stream.take(50),
  Stream.runForEach((chunk) => Effect.logInfo(chunk))
)
```
