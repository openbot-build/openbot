// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { NodeServices } from "@effect/platform-node"
import { Network, RobotsPolicy } from "@openbot-build/protocol"
import * as Verification from "../src/apps/DeveloperVerification.ts"
import * as Domain from "../src/apps/DomainControl.ts"
import * as Access from "../src/apps/DeveloperAccess.ts"
import { AppInspections } from "../src/apps/AppInspections.ts"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { developerClaims, developerProofs } from "../src/database/Schema.ts"
import * as Rows from "../src/apps/DeveloperRows.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Postgres from "./PostgresTest.ts"

const metadataKey = "legacy.example/developer-verification"
const token = "legacy-verification=stored-random-challenge"
const marker = (value: string) =>
	JSON.stringify({ _meta: { [metadataKey]: { version: 1, tokens: [value] } } })

test("extra metadata locations require explicit configuration and the exact stored token", async () => {
	assert.equal(
		await Effect.runPromise(
			Verification.hasToken({ text: marker(token), token }),
		),
		false,
	)
	assert.equal(
		await Effect.runPromise(
			Verification.hasToken({
				text: marker(token),
				token,
				settings: { metadataKeys: [metadataKey] },
			}),
		),
		true,
	)
	assert.equal(
		await Effect.runPromise(
			Verification.hasToken({
				text: marker("wrong"),
				token,
				settings: { metadataKeys: [metadataKey] },
			}),
		),
		false,
	)
	assert.equal(
		await Effect.runPromise(
			Verification.hasToken({
				text: JSON.stringify({
					_meta: { [metadataKey]: { version: 2, tokens: [token] } },
				}),
				token,
				settings: { metadataKeys: [metadataKey] },
			}),
		),
		false,
	)
})

test("DNS aliases preserve native lookup and do not hide resolver failures", async () => {
	const calls: string[] = []
	const lookup = async (name: string): Promise<string[][]> => {
		calls.push(name)
		if (name.startsWith("_openbot-"))
			throw Object.assign(new Error("missing"), { code: "ENODATA" })
		return [["legacy-verification=", "stored-random-challenge"]]
	}
	const layer = Domain.layerWithLabels({
		aliases: ["_legacy-verification"],
		lookup,
	})
	const tokens = await Effect.runPromise(
		Effect.flatMap(Domain.DomainControl, (domain) =>
			domain.tokens("publisher.example"),
		).pipe(Effect.provide(layer)),
	)
	assert.deepEqual(tokens, [token])
	assert.deepEqual(calls, [
		"_openbot-verification.publisher.example",
		"_legacy-verification.publisher.example",
	])
	assert.throws(() => Domain.layerWithLabels({ aliases: ["bad.label"] }))
	const result = await Effect.runPromise(
		Effect.flatMap(Domain.DomainControl, (domain) =>
			domain.tokens("publisher.example"),
		).pipe(
			Effect.provide(
				Domain.layerWithLabels({
					lookup: async () => {
						throw new Error("SERVFAIL")
					},
				}),
			),
			Effect.result,
		),
	)
	assert.equal(result._tag, "Failure")
})

test(
	"stored migrated proofs recheck through the native tables without rotating their challenge",
	{ timeout: 30000 },
	async (t) => {
		const database = await Postgres.start()
		t.after(() => database.close())
		const storage = Database.layer({
			databaseUrl: Redacted.make(database.url),
		}).pipe(Layer.provide(NodeServices.layer))
		const records = ManagedRuntime.make(storage)
		t.after(() => records.dispose())
		await records.runPromise(Database.migrate)
		const owner = JSON.stringify(["organization", "user"]),
			id = "migrated-proof",
			now = Date.now()
		await records.runPromise(
			Effect.gen(function* () {
				const db = yield* makeWithDefaults()
				const scope = {
					_tag: "AppCard" as const,
					cardUrl: "https://publisher.example/card.json",
				}
				const claim = yield* Rows.encodeClaim({
					id,
					scope,
					token,
					status: "Confirmed",
					createdAt: now,
					expiresAt: now + 86400000,
				})
				yield* db
					.insert(developerClaims)
					.values({
						namespace: "public",
						owner,
						scopeKey: Access.scopeKey(scope),
						...claim,
					})
				const proof = yield* Rows.encodeProof({
					id,
					transition: 1,
					scope,
					status: "Confirmed",
					confirmedAt: now,
					validUntil: now + 86400000,
					nextVerificationAt: now,
					reason: null,
				})
				yield* db
					.insert(developerProofs)
					.values({
						namespace: "public",
						owner,
						token,
						scopeKey: Access.scopeKey(scope),
						...proof,
					})
			}),
		)
		let published = token
		const network = Layer.succeed(Network.PublicNetwork, {
			readDocument: ({ url }) =>
				Effect.succeed({
					url,
					status: 200,
					headers: {},
					text: url.endsWith("/robots.txt")
						? "User-agent: *\nAllow: /\n"
						: marker(published),
				}),
		})
		const make = (settings: Verification.Settings) =>
			ManagedRuntime.make(
				Access.layerWithVerification(settings).pipe(
					Layer.provide(storage),
					Layer.provide(Domain.layer),
					Layer.provide(network),
					Layer.provide(RobotsPolicy.layer),
					Layer.provide(
						Layer.succeed(AppInspections, {
							inspect: (input) =>
								Effect.succeed({
									input,
									checkedAt: Date.now(),
									apps: [],
									issues: [],
									stages: [],
								}),
						}),
					),
				),
			)
		const native = make({}),
			compatible = make({ metadataKeys: [metadataKey] })
		t.after(async () => {
			await compatible.dispose()
			await native.dispose()
		})
		const check = Effect.flatMap(Access.DeveloperAccess, (access) =>
			access.recheck(id),
		)
		assert.equal((await native.runPromise(check)).status, "Suspended")
		assert.equal((await compatible.runPromise(check)).status, "Confirmed")
		assert.equal(
			(
				await records.runPromise(
					Effect.flatMap(makeWithDefaults(), (db) =>
						Rows.getProof(db, "public", id),
					),
				)
			).token,
			token,
		)
		published = "different-token"
		assert.equal((await compatible.runPromise(check)).status, "Suspended")
	},
)
