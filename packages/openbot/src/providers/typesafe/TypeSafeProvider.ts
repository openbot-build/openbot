import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"
import type { DecisionModel } from "effect/ai"
import type { HttpClient } from "effect/http"
import { Layer, type Redacted } from "effect"

export interface Options {
	readonly apiKey: Redacted.Redacted<string>
	/** The base URL, such as `https://api.typesafe.ai/v1`. Leave it out for the default of the client. */
	readonly apiUrl?: string
	/** The model name that TypeSafe gets, such as `jev-latest`. */
	readonly upstreamModel: string
}

/** A decision model of TypeSafe, such as Jev, with its own client. */
export const layer = (
	options: Options,
): Layer.Layer<DecisionModel.DecisionModel, never, HttpClient.HttpClient> =>
	TypeSafeDecisionModel.layer({ model: options.upstreamModel }).pipe(
		Layer.provide(
			TypeSafeClient.layer({
				apiKey: options.apiKey,
				...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
			}),
		),
	)
