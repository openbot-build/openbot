import { Option, HashMap, Effect, Layer, Ref } from "effect"
import {
	StoreError,
	ConnectionKey,
	CredentialBinding,
	Credential,
	AppRecord,
	UserConnection,
	AppStore,
	CredentialStore,
} from "./Store.ts"

const keyOf = (key: ConnectionKey) =>
	JSON.stringify([key.owner, key.connectionId])

const bindingOf = (binding: CredentialBinding) =>
	JSON.stringify([
		binding.owner,
		binding.connectionId,
		binding.resource,
		binding.issuer,
	])

/** Storage inside this process only. save writes the App record and owned user connection in one atomic step. */
export const layer = Layer.effect(
	AppStore,
	Effect.gen(function* () {
		const state = yield* Ref.make({
			apps: HashMap.empty<string, AppRecord>(),
			connections: HashMap.empty<string, UserConnection>(),
		})
		return AppStore.of({
			save: Effect.fn("AppStore.save")(function* (input) {
				const app = yield* AppRecord.decode(input.app)
				const connection = yield* UserConnection.decode(input.connection)
				if (app.cardUrl !== connection.cardUrl)
					return yield* new StoreError({
						reason: "Invalid",
						operation: "save",
					})
				const saved = yield* Ref.modify(state, (old) => {
					if (HashMap.has(old.connections, keyOf(connection)))
						return [false, old] as const
					const apps = HashMap.set(old.apps, app.cardUrl, app)
					const connections = HashMap.set(
						old.connections,
						keyOf(connection),
						connection,
					)
					return [
						true,
						{
							apps,
							connections,
						},
					] as const
				})
				if (!saved)
					return yield* new StoreError({
						reason: "AlreadyExists",
						operation: "save",
					})
				return connection
			}),
			get: (key) =>
				Ref.get(state).pipe(
					Effect.flatMap((s) => {
						const value = Option.getOrUndefined(
							HashMap.get(s.connections, keyOf(key)),
						)
						return value === undefined
							? Effect.fail(
									new StoreError({
										reason: "Missing",
										operation: "get",
									}),
								)
							: Effect.succeed(value)
					}),
				),
			getApp: (cardUrl) =>
				Ref.get(state).pipe(
					Effect.flatMap((s) => {
						const value = Option.getOrUndefined(HashMap.get(s.apps, cardUrl))
						return value === undefined
							? Effect.fail(
									new StoreError({
										reason: "Missing",
										operation: "getApp",
									}),
								)
							: Effect.succeed(value)
					}),
				),
			update: (input) =>
				Ref.modify(state, (old) => {
					const previous = Option.getOrUndefined(
						HashMap.get(old.connections, keyOf(input.key)),
					)
					if (previous === undefined) return [undefined, old] as const
					const current = input.change(previous)
					if (
						keyOf(current) !== keyOf(previous) ||
						current.cardUrl !== previous.cardUrl
					)
						return [undefined, old] as const
					return [
						current,
						{
							...old,
							connections: HashMap.set(
								old.connections,
								keyOf(input.key),
								current,
							),
						},
					] as const
				}).pipe(
					Effect.filterOrFail(
						(value): value is UserConnection => value !== undefined,
						() =>
							new StoreError({
								reason: "Missing",
								operation: "update",
							}),
					),
				),
			updateApp: (app) =>
				Ref.update(state, (old) => ({
					...old,
					apps: HashMap.set(old.apps, app.cardUrl, app),
				})),
			delete: (key) =>
				Ref.update(state, (old) => {
					let connections = old.connections
					connections = HashMap.remove(connections, keyOf(key))
					return { ...old, connections }
				}),
		})
	}),
)

/** Secrets stay Redacted. Only a caller with the complete binding can read them. */
export const layerCredentials = Layer.effect(
	CredentialStore,
	Effect.gen(function* () {
		const state = yield* Ref.make(HashMap.empty<string, Credential>())
		return CredentialStore.of({
			put: Effect.fn("CredentialStore.put")(function* (input) {
				const credential = yield* Credential.decode(input)
				const reference = bindingOf(credential.binding)
				yield* Ref.update(state, (old) =>
					HashMap.set(old, reference, credential),
				)
				return reference
			}),
			get: (input) =>
				Ref.get(state).pipe(
					Effect.flatMap((s) => {
						const value = Option.getOrUndefined(HashMap.get(s, input.reference))
						return value === undefined ||
							bindingOf(value.binding) !== bindingOf(input.binding)
							? Effect.fail(
									new StoreError({
										reason: "Missing",
										operation: "credential.get",
									}),
								)
							: Effect.succeed(value)
					}),
				),
			deleteConnection: (key) =>
				Ref.update(state, (old) =>
					HashMap.fromIterable(
						[...old].filter(([, value]) => keyOf(value.binding) !== keyOf(key)),
					),
				),
		})
	}),
)
