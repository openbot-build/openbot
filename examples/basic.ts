import { Effect, Schema } from "effect"
import { Decision, Domain, Policy, Principal, Resource } from "../src/index.ts"

class User extends Principal.Class<User>("User")({
	id: Schema.String,
}) {}

class Post extends Resource.Class<Post>()("Post", {
	actions: ["read", "update", "delete"],
	fields: {
		id: Schema.String,
		authorId: Schema.String,
		published: Schema.Boolean,
		title: Schema.String,
		body: Schema.String,
	},
}) {}

const Blog = Domain.make({ principal: User, resources: [Post] })

const policy = Policy.define(Blog)(function* (_) {
	yield* _.allow("read", Post)

	yield* _.allow("update", Post, {
		fields: ["title", "body"],
		when: ($) => $.eq("authorId", $.principal("id")),
		reason: "Writers may change their own posts",
	})

	yield* _.deny("delete", Post, {
		when: ($) => $.eq("published", true),
		reason: "No one may delete a published post",
	})
})

const writer = User.make({ id: "u1" })

const post = Post.make({
	id: "p1",
	authorId: "u1",
	published: true,
	title: "Hello",
	body: "World",
})

const program = Effect.gen(function* () {
	const canUpdateTitle = yield* Policy.decide(policy, {
		principal: writer,
		action: "update",
		resource: post,
		field: "title",
	})

	const canDelete = yield* Policy.decide(policy, {
		principal: writer,
		action: "delete",
		resource: post,
	})

	return {
		canUpdateTitle: Decision.isAllow(canUpdateTitle),
		deleteAnswer: canDelete._tag,
		deleteReason: Decision.reason(canDelete),
	}
})

console.log(Effect.runSync(program))
