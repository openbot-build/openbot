import { Option, HashMap, Effect, Layer, Ref, Result } from "effect"
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

const found = <A>(
	value: Option.Option<A>,
	operation: string,
): Effect.Effect<A, StoreError> =>
	Effect.fromOption(value, () =>
		StoreError.make({ reason: "Missing", operation }),
	)

interface State {
	readonly apps: HashMap.HashMap<string, AppRecord>
	readonly connections: HashMap.HashMap<string, UserConnection>
}

/** The new connection of an update, or the reason why the store kept the old one. */
type Updated = Result.Result<UserConnection, StoreError>

/** Storage inside this process only. save writes the App record and owned user connection in one atomic step. */
export const layer = Layer.effect(
	AppStore,
	Effect.gen(function* () {
		const state = yield* Ref.make<State>({
			apps: HashMap.empty(),
			connections: HashMap.empty(),
		})
		return AppStore.of({
			save: Effect.fn("AppStore.save")(function* (input) {
				const app = yield* AppRecord.decode(input.app)
				const connection = yield* UserConnection.decode(input.connection)
				if (app.cardUrl !== connection.cardUrl)
					return yield* StoreError.make({
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
					return yield* StoreError.make({
						reason: "AlreadyExists",
						operation: "save",
					})
				return connection
			}),
			get: Effect.fn("AppStore.get")(function* (key) {
				const { connections } = yield* Ref.get(state)
				return yield* found(HashMap.get(connections, keyOf(key)), "get")
			}),
			getApp: Effect.fn("AppStore.getApp")(function* (cardUrl) {
				const { apps } = yield* Ref.get(state)
				return yield* found(HashMap.get(apps, cardUrl), "getApp")
			}),
			update: Effect.fn("AppStore.update")(function* (input) {
				const id = keyOf(input.key)
				const result = yield* Ref.modify(
					state,
					(old): readonly [Updated, State] => {
						const previous = HashMap.get(old.connections, id)
						if (Option.isNone(previous))
							return [
								Result.fail(
									StoreError.make({ reason: "Missing", operation: "update" }),
								),
								old,
							] as const
						const current = input.change(previous.value)
						if (
							keyOf(current) !== keyOf(previous.value) ||
							current.cardUrl !== previous.value.cardUrl
						)
							return [
								Result.fail(
									StoreError.make({ reason: "Invalid", operation: "update" }),
								),
								old,
							] as const
						return [
							Result.succeed(current),
							{
								...old,
								connections: HashMap.set(old.connections, id, current),
							},
						] as const
					},
				)
				return yield* Effect.fromResult(result)
			}),
			updateApp: Effect.fn("AppStore.updateApp")(function* (app) {
				yield* Ref.update(state, (old) => ({
					...old,
					apps: HashMap.set(old.apps, app.cardUrl, app),
				}))
			}),
			delete: Effect.fn("AppStore.delete")(function* (key) {
				yield* Ref.update(state, (old) => ({
					...old,
					connections: HashMap.remove(old.connections, keyOf(key)),
				}))
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
			get: Effect.fn("CredentialStore.get")(function* (input) {
				const credentials = yield* Ref.get(state)
				return yield* found(
					HashMap.get(credentials, input.reference).pipe(
						Option.filter(
							(credential) =>
								bindingOf(credential.binding) === bindingOf(input.binding),
						),
					),
					"credential.get",
				)
			}),
			deleteConnection: Effect.fn("CredentialStore.deleteConnection")(
				function* (key) {
					yield* Ref.update(
						state,
						HashMap.filter(
							(credential) => keyOf(credential.binding) !== keyOf(key),
						),
					)
				},
			),
		})
	}),
)
