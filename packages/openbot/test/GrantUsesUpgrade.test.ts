import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import { Store as Protocol } from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Progress from "../src/database/conversion/Progress.ts"
import * as Legacy from "../src/database/conversion/LegacyV1.ts"
import * as Upgrade from "../src/database/conversion/GrantUses.ts"
import * as Grants from "../src/apps/GrantUses.ts"
import * as Connections from "../src/apps/StoredConnections.ts"
import { privateStateCodec } from "../src/apps/DeveloperTestStores.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Store.layer.pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (database) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
	Layer.provideMerge(NodeServices.layer),
)
const owner = '["org","person"]'
const scope = { issuer: "https://issuer.example", clientId: "client" }
const identity = {
	owner: { organizationId: "org", userId: "person" },
	actor: { kind: "member" as const, organizationId: "org", userId: "person" },
}
const json = Schema.fromJsonString(Schema.Json)
const credentialCodec = Schema.fromJsonString(
	Schema.toCodecJson(Protocol.Credential),
)
const connectionCodec = Schema.fromJsonString(
	Schema.toCodecJson(Connections.StoredConnection),
)

it.layer(database, { excludeTestServices: true, timeout: "60 seconds" })(
	(it) => {
		it.effect(
			"a ready old database moves new grant data in batches and can resume",
			() =>
				Effect.gen(function* () {
					const sql = yield* PgClient.PgClient
					const secrets = yield* Secrets.Secrets
					const store = yield* Store.Store
					yield* Migrations.initialize
					yield* Effect.scoped(Migrations.checkStartup)
					const [before] = yield* sql<{
						counts: string
						checked_at: string
					}>`select counts, checked_at::text from openbot_data_upgrades where version = ${Progress.version}`
					if (before === undefined)
						return yield* Effect.die("The old data move is missing.")
					// These current records were added after the old data move passed.
					yield* sql`update openbot_data_upgrades set source = ${Legacy.source} where version = ${Progress.version}`
					const seal = (value: string, binding: ReadonlyArray<string>) =>
						Schema.encodeEffect(json)(binding).pipe(
							Effect.flatMap((aad) => secrets.seal(value, aad)),
						)
					const make = (id: string) => {
						const binding = Protocol.CredentialBinding.make({
							owner,
							connectionId: id,
							issuer: scope.issuer,
							resource: "https://app.example/mcp",
						})
						const credential = Protocol.Credential.make({
							binding,
							clientId: scope.clientId,
							accessToken: Redacted.make("saved private token"),
							scopes: [],
						})
						const connection = Protocol.UserConnection.make({
							owner,
							connectionId: id,
							cardUrl: "https://app.example/card.json",
							endpoint: binding.resource,
							remoteIndex: 0,
							configuration: Redacted.make({}),
							headers: Redacted.make({}),
							state: "Enabled",
							authorization: {
								_tag: "Authorized",
								binding,
								credentialRef: id,
								scopes: [],
							},
						})
						return { credential, connection }
					}
					yield* Effect.forEach(
						Arr.range(0, 100),
						(index) =>
							Effect.gen(function* () {
								const id = "connection-" + Str.padStart(3, "0")(String(index))
								const saved = make(id)
								const body = yield* Schema.encodeEffect(connectionCodec)({
									connection: saved.connection,
									name: id,
									revision: 1,
									verification: null,
								}).pipe(
									Effect.flatMap((body) =>
										seal(body, ["connection", owner, id]),
									),
								)
								yield* sql`insert into openbot_app_connections ${sql.insert({ owner, id, name: id, revision: 1, body })}`
								const credential = yield* Schema.encodeEffect(credentialCodec)(
									saved.credential,
								).pipe(
									Effect.flatMap((body) =>
										seal(body, ["credential", owner, id]),
									),
								)
								yield* sql`insert into openbot_app_secrets ${sql.insert({ owner, kind: "credential", id, connection_id: id, body: credential })}`
							}),
						{ discard: true },
					)
					const testId = "test"
					const test = make(testId)
					const privateState = yield* Schema.encodeEffect(privateStateCodec)({
						connection: test.connection,
						credentials: [{ reference: testId, credential: test.credential }],
					}).pipe(
						Effect.flatMap((body) =>
							seal(body, ["developer-test", owner, testId]),
						),
					)
					yield* sql`insert into openbot_developer_tests ${sql.insert({ namespace: "public", id: testId, owner, card_url: test.connection.cardUrl, status: "Succeeded", cleanup: "Pending", expires_at: 1, value: "{}", private_state: privateState })}`
					const start = (
						kind: "AppAuthorization" | "AppGrant",
						step: "exchange" | "revoke",
					) =>
						Effect.gen(function* () {
							const receipt = yield* store.submit(
								owner,
								Execution.CommandKey.make(step),
								{
									workflow:
										kind === "AppGrant"
											? "openbot.app-grant-cleanup"
											: "openbot.app-authorization",
									identity,
									resource: { kind, id: step },
									input: {},
								},
							)
							const fence = yield* store.takeOver({
								namespace: owner,
								id: receipt.executionId,
							})
							return yield* store.intent(fence, {
								step,
								attempt: 0,
								retry: "idempotent",
								input: { grantScope: scope },
							})
						})
					const sending = yield* start("AppAuthorization", "exchange")
					const revoking = yield* start("AppGrant", "revoke")
					yield* sql`delete from openbot_data_upgrades where version = ${Upgrade.version}`
					assert.instanceOf(
						yield* Effect.flip(Effect.scoped(Migrations.checkStartup)),
						Progress.UpgradeRequired,
					)
					const [last] = yield* sql<{
						body: string
					}>`select body from openbot_app_secrets where owner = ${owner} and kind = 'credential' and id = 'connection-100'`
					assert.isDefined(last)
					if (last === undefined)
						return yield* Effect.die("The last credential is missing.")
					yield* sql`update openbot_app_secrets set body = 'bad saved data' where owner = ${owner} and kind = 'credential' and id = 'connection-100'`
					const failure = yield* Effect.flip(Migrations.upgrade)
					assert.instanceOf(failure, Progress.InvalidRecord)
					const [batch] = yield* sql<{
						rows: number
						complete: boolean
					}>`select rows::float8 as rows, complete from openbot_data_upgrade_steps where version = ${Upgrade.version} and step = 'connections'`
					assert.deepStrictEqual(batch, { rows: 100, complete: false })
					const [gate] = yield* sql<{
						state: string
					}>`select state from openbot_data_upgrades where version = ${Upgrade.version}`
					assert.equal(gate?.state, "blocked")
					assert.instanceOf(
						yield* Effect.flip(Effect.scoped(Migrations.checkStartup)),
						Progress.UpgradeRequired,
					)
					yield* sql`update openbot_app_secrets set body = ${last.body} where owner = ${owner} and kind = 'credential' and id = 'connection-100'`
					yield* Migrations.upgrade
					yield* Migrations.upgrade
					yield* Effect.scoped(Migrations.checkStartup)
					const [oldGate] = yield* sql<{
						source: string
						state: string
						counts: string
						checked_at: string
					}>`select source, state, counts, checked_at::text from openbot_data_upgrades where version = ${Progress.version}`
					assert.deepStrictEqual(oldGate, {
						...before,
						source: Legacy.source,
						state: "ready",
					})
					const uses = yield* sql<{
						kind: string
						reference: string
						scope_key: string
						execution_id: string | null
					}>`select kind, reference, scope_key, execution_id from openbot_app_grant_uses where namespace = ${owner}`
					assert.equal(uses.length, 104)
					assert.isTrue(
						Arr.every(uses, (use) => use.scope_key === Grants.scopeKey(scope)),
					)
					assert.isTrue(
						Arr.some(
							uses,
							(use) =>
								use.kind === "developer-test" &&
								use.reference === Grants.testReference("public", testId) &&
								use.execution_id === null,
						),
					)
					assert.isTrue(
						Arr.some(
							uses,
							(use) => use.kind === "send" && use.reference === sending.id,
						),
					)
					assert.isTrue(
						Arr.some(
							uses,
							(use) => use.kind === "revoke" && use.reference === revoking.id,
						),
					)
				}),
		)
	},
)
