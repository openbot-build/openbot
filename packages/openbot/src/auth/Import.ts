import { PgClient } from "@effect/sql-pg"
import { Effect, Schema } from "effect"

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(200))
/** Only stable sign-in links are imported. Tokens and sessions are not accepted. */
export const User = Schema.Struct({
	id: Id,
	name: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
	email: Schema.NonEmptyString.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
	emailVerified: Schema.Literal(true),
	accounts: Schema.Array(
		Schema.Struct({ id: Id, providerId: Id, subject: Id }),
	).check(Schema.isMinLength(1)),
})
export type User = typeof User.Type

/** The caller must hold the fresh database lock. */
export const insert = Effect.fn("AuthImport.insert")(function* (
	users: ReadonlyArray<User>,
) {
	const sql = yield* PgClient.PgClient
	for (const user of users) {
		yield* sql`INSERT INTO openbot_auth_user(id,name,email,email_verified) VALUES(${user.id},${user.name},${user.email},${user.emailVerified})`
		for (const account of user.accounts)
			yield* sql`INSERT INTO openbot_auth_account(id,account_id,provider_id,user_id,updated_at) VALUES(${account.id},${account.subject},${account.providerId},${user.id},now())`
	}
})
