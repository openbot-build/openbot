import { Schema } from "effect"
import { Domain, Principal, Resource } from "../src/index.ts"

export class Caller extends Principal.Class<Caller>("Caller")({
	userId: Schema.String,
	organizationId: Schema.String,
	role: Schema.Literals(["admin", "member", "guest"]),
}) {}

export class Bot extends Resource.Class<Bot>()("Bot", {
	actions: ["read", "update", "delete", "delegate"],
	fields: {
		id: Schema.String,
		organizationId: Schema.String,
		ownerUserId: Schema.NullOr(Schema.String),
		name: Schema.String,
		level: Schema.Finite,
		settings: Schema.Struct({
			model: Schema.String,
			secret: Schema.String,
		}),
	},
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "bot", f.id],
}) {
	get shared() {
		return this.ownerUserId === null
	}
}

export const Trigger = Resource.make("Trigger", {
	actions: ["read", "write"],
	fields: {
		id: Schema.String,
		organizationId: Schema.String,
		ownerUserId: Schema.NullOr(Schema.String),
		enabled: Schema.Boolean,
	},
	path: (f) => [
		"org",
		f.organizationId,
		"user",
		f.ownerUserId,
		"trigger",
		f.id,
	],
})

export const Grant = Schema.Struct({
	scope: Schema.Literals(["once", "chat", "lifetime"]),
})

export const App = Domain.make({
	principal: Caller,
	resources: [Bot, Trigger],
	meta: Grant,
})

export const alice = Caller.make({
	userId: "alice",
	organizationId: "acme",
	role: "member",
})

export const bob = Caller.make({
	userId: "bob",
	organizationId: "acme",
	role: "member",
})

export const aliceBot = Bot.make({
	id: "b1",
	organizationId: "acme",
	ownerUserId: "alice",
	name: "Helper",
	level: 2,
	settings: { model: "small", secret: "s1" },
})

export const sharedBot = Bot.make({
	id: "b2",
	organizationId: "acme",
	ownerUserId: null,
	name: "Team",
	level: 5,
	settings: { model: "large", secret: "s2" },
})

export const aliceTrigger = Trigger.make({
	id: "t1",
	organizationId: "acme",
	ownerUserId: "alice",
	enabled: true,
})
