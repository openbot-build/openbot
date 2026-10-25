import { HashMap, Effect, Layer, Ref, Schema } from "effect"
import * as Document from "../Document.ts"
import { IndexError, Entry, IndexStore } from "./Index.ts"

export const layer = Layer.effect(
	IndexStore,
	Effect.gen(function* () {
		const state = yield* Ref.make(HashMap.empty<string, Entry>())
		const identity = (cardUrl: string) =>
			Schema.decodeEffect(Document.Link)(cardUrl).pipe(
				Effect.mapError(() =>
					IndexError.make({
						reason: "Invalid",
						operation: "Card URL",
					}),
				),
			)
		return IndexStore.of({
			get: (cardUrl) =>
				identity(cardUrl).pipe(
					Effect.flatMap((key) =>
						Ref.get(state).pipe(
							Effect.map((entries) => HashMap.get(entries, key)),
						),
					),
				),
			upsert: (entry) =>
				Entry.decode(entry).pipe(
					Effect.flatMap((value) =>
						Ref.update(state, (entries) =>
							HashMap.set(entries, value.cardUrl, value),
						).pipe(Effect.as(value)),
					),
				),
			withdraw: (cardUrl) =>
				identity(cardUrl).pipe(
					Effect.flatMap((key) => Ref.update(state, HashMap.remove(key))),
				),
		})
	}),
)
