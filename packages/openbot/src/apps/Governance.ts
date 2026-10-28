import { AppIndex, ExperienceStorageUnavailable } from "@openbot-build/domain"
import { Array as Arr, Context, Effect, HashMap, Layer, Option } from "effect"
import * as Failures from "../errors/Failures.ts"
import { Settings } from "../settings/Settings.ts"

/** One snapshot serves a whole list. Actions read current restrictions before sending. */
export interface Service {
	readonly snapshot: Effect.Effect<
		HashMap.HashMap<string, AppIndex.Restriction>,
		ExperienceStorageUnavailable
	>
	readonly find: (
		cardUrl: string,
	) => Effect.Effect<
		Option.Option<AppIndex.Restriction>,
		ExperienceStorageUnavailable
	>
	readonly check: (
		cardUrl: string,
	) => Effect.Effect<
		void,
		AppIndex.AppRestricted | ExperienceStorageUnavailable
	>
}

export class Governance extends Context.Service<Governance, Service>()(
	"@openbot-build/openbot/apps/Governance",
) {}

const make = Effect.gen(function* () {
	const settings = yield* Settings
	const snapshot = settings.platform.pipe(
		Effect.map((platform) =>
			HashMap.fromIterable(
				Arr.map(
					Option.isSome(platform)
						? platform.value.document.appRestrictions
						: [],
					(restriction) =>
						[new URL(restriction.cardUrl).href, restriction] as const,
				),
			),
		),
		Failures.replace("Could not read the App restrictions.", () =>
			ExperienceStorageUnavailable.make({}),
		),
	)
	const find = (cardUrl: string) =>
		snapshot.pipe(
			Effect.map((entries) => HashMap.get(entries, new URL(cardUrl).href)),
		)
	const check = (cardUrl: string) =>
		find(cardUrl).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (restriction) =>
						Effect.fail(AppIndex.AppRestricted.make({ restriction })),
				}),
			),
		)
	return Governance.of({ snapshot, find, check })
})

export const layer = Layer.effect(Governance, make)
