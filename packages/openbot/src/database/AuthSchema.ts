import { pgTable, text, timestamp, boolean, index } from "drizzle-orm/pg-core"

export const openbot_auth_user = pgTable("openbot_auth_user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		// @effect-diagnostics-next-line globalDate:off -- Drizzle calls $onUpdate outside Effect, and a timestamp column needs a Date back.
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
})

export const openbot_auth_session = pgTable(
	"openbot_auth_session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at").notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			// @effect-diagnostics-next-line globalDate:off -- Drizzle calls $onUpdate outside Effect, and a timestamp column needs a Date back.
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => openbot_auth_user.id, { onDelete: "cascade" }),
	},
	(table) => [index("openbot_auth_session_userId_idx").on(table.userId)],
)

export const openbot_auth_account = pgTable(
	"openbot_auth_account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => openbot_auth_user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at"),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			// @effect-diagnostics-next-line globalDate:off -- Drizzle calls $onUpdate outside Effect, and a timestamp column needs a Date back.
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("openbot_auth_account_userId_idx").on(table.userId)],
)

export const openbot_auth_verification = pgTable(
	"openbot_auth_verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			// @effect-diagnostics-next-line globalDate:off -- Drizzle calls $onUpdate outside Effect, and a timestamp column needs a Date back.
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		index("openbot_auth_verification_identifier_idx").on(table.identifier),
	],
)
