import { assert, it, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { ModelProvidersApi } from "@openbot-build/api"
import { Model } from "@openbot-build/core"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Option, Redacted, Schema } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import { organizationOwner } from "../src/models/ModelProviders.ts"
import * as ModelProvidersPostgres from "../src/models/ModelProvidersPostgres.ts"
import * as Models from "../src/models/Models.ts"
import * as ModelsPostgres from "../src/models/ModelsPostgres.ts"
import { Secrets } from "../src/secrets/Secrets.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

it.effect(
	"model media declarations accept exact MIME types, not wildcards or labels",
	() =>
		Effect.gen(function* () {
			const decode = Schema.decodeUnknownEffect(
				ModelProvidersApi.UpdateModelRequest,
			)
			assert.deepStrictEqual(
				yield* decode({
					expectedVersion: 1,
					inputMediaTypes: ["image/png", "application/pdf"],
				}),
				{
					expectedVersion: 1,
					inputMediaTypes: ["image/png", "application/pdf"],
				},
			)
			for (const mediaType of [
				"image/*",
				"image",
				"IMAGE/PNG",
				"application/pdf; charset=utf-8",
			]) {
				const error = yield* Effect.flip(
					decode({ expectedVersion: 1, inputMediaTypes: [mediaType] }),
				)
				assert.strictEqual(error._tag, "SchemaError")
			}
		}),
)

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
	it.effect(
		"old models stay unknown after upgrade and media declarations survive updates and provider overrides",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const before = yield* MigrationTest.migrationsWhere(
					(name) => name < "20261026200458_model-input-media-types",
				)
				yield* Effect.gen(function* () {
					const db = yield* Db.make
					yield* migrate(db, { migrationsFolder: before })
					const sql = yield* PgClient.PgClient
					yield* sql`INSERT INTO openbot_models (owner_kind, owner_id, id, type, name, reasoning_efforts, service_tiers, version, created_at, updated_at)
					VALUES ('organization', 'org_media', 'old', 'language', 'Old model', '[]', '[]', 1, 0, 0)`
					yield* sql`INSERT INTO openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at)
					VALUES ('prov_media', 'organization', 'org_media', 'openai', 'Media provider', 'sealed', 1, 0, 0)`
					yield* sql`INSERT INTO openbot_provider_models (provider_id, model_owner_kind, model_owner_id, model_id, position)
					VALUES ('prov_media', 'organization', 'org_media', 'old', 0)`
					yield* DatabasePostgres.migrate
					const owner = organizationOwner("org_media")
					const models = yield* ModelsPostgres.make
					const providers = yield* ModelProvidersPostgres.make
					const old = Option.getOrThrow(yield* models.get(owner, "old"))
					assert.strictEqual(old.inputMediaTypes, null)
					assert.strictEqual(Models.view(old).inputMediaTypes, undefined)
					const oldProvider = Option.getOrThrow(
						yield* providers.get(owner, "prov_media"),
					)
					assert.strictEqual(oldProvider.models[0]?.inputMediaTypes, undefined)

					const declared = yield* models.update(owner, "old", {
						expectedVersion: old.version,
						inputMediaTypes: ["image/png", "application/pdf"],
					})
					assert.deepStrictEqual(declared.inputMediaTypes, [
						"image/png",
						"application/pdf",
					])
					const renamed = yield* models.update(owner, "old", {
						expectedVersion: declared.version,
						name: "Renamed",
					})
					assert.deepStrictEqual(
						renamed.inputMediaTypes,
						declared.inputMediaTypes,
					)
					const conflict = yield* Effect.flip(
						models.update(owner, "old", {
							expectedVersion: declared.version,
							inputMediaTypes: [],
						}),
					)
					assert.ok(Schema.is(ModelProvidersApi.ModelConflict)(conflict))
					assert.deepStrictEqual(
						Option.getOrThrow(yield* models.get(owner, "old")).inputMediaTypes,
						declared.inputMediaTypes,
					)

					const overridden = yield* providers.update(owner, "prov_media", {
						expectedVersion: oldProvider.version,
						models: [
							{
								model: Model.Id.make("old"),
								modelOwner: "organization",
								inputMediaTypes: [],
							},
						],
					})
					assert.deepStrictEqual(overridden.models[0]?.inputMediaTypes, [])
					assert.deepStrictEqual(
						Models.effective({ model: renamed, link: overridden.models[0]! })
							.inputMediaTypes,
						[],
					)
					const reread = Option.getOrThrow(
						yield* providers.get(owner, "prov_media"),
					)
					assert.deepStrictEqual(reread.models[0]?.inputMediaTypes, [])

					const reset = yield* models.update(owner, "old", {
						expectedVersion: renamed.version,
						inputMediaTypes: null,
					})
					assert.strictEqual(reset.inputMediaTypes, null)
					const created = yield* models.create(owner, {
						id: Model.Id.make("new"),
						name: "New model",
						reasoningEfforts: [],
						serviceTiers: [],
						inputMediaTypes: ["image/jpeg"],
						availability: { _tag: "None" },
					})
					assert.deepStrictEqual(created.inputMediaTypes, ["image/jpeg"])
				}).pipe(
					Effect.provide(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
					),
					Effect.provideService(
						Secrets,
						Secrets.of({
							seal: (value) => Effect.succeed(value),
							open: (value) => Effect.succeed(value),
						}),
					),
				)
			}),
	)
})
