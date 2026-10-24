# @nmnmcc/ability

Authorization tools for Effect programs. Authorization means the work of
deciding if a principal may do an act. A principal is the one who asks: a
person, a user token, or a Bot.

The library is made with [Effect](https://effect.website) only:

- Resources and principals are Schema classes. The types of rules, conditions
  and checks all come from them.
- A condition is plain data. You can test it on a value, make it smaller with
  the principal, change it into a database query, and keep it as JSON.
- A policy is a tree. Lists of rules are its leaves, and you put policies
  together with `all`, `any`, `firstOf` and `ceiling`.
- An `Authorizer` is an Effect service. A "no" goes into the error channel. When
  a policy can not be loaded, the check fails, so an error is never a "yes".

## Requirements

- Use strict type checking. Without it, the types do not give all of their
  safety.
- `effect` is a peer dependency. Your project must install it.

## Install

```sh
pnpm add @nmnmcc/ability effect
```

## Overview

```ts
import {
	Authorizer,
	Condition,
	Decision,
	Domain,
	Policy,
	Principal,
	Resource,
	Rule,
} from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
```

| Module       | What it is                                                                  |
| ------------ | --------------------------------------------------------------------------- |
| `Resource`   | A kind of thing to act on, with its actions, its Schema, and a path.        |
| `Principal`  | The Schema of the one who asks.                                             |
| `Domain`     | The principal and all the resources. Every other type comes from it.        |
| `Condition`  | A test on a resource value, as plain data.                                  |
| `Rule`       | An allow rule or a deny rule.                                               |
| `Policy`     | A tree of rules that gives a decision, a residual condition, and fields.    |
| `Decision`   | `Allow`, `Deny` or `NotApplicable`.                                         |
| `Authorizer` | An Effect service that checks the principal of the current request.         |
| `HttpApi`    | Annotations and a middleware for `effect/http-api`. A separate entry point. |

## First Steps

Make the principal and the resources. `Resource.Class` works in the same way as
`Schema.TaggedClass`. The class is a Schema, a constructor, and a resource at
the same time:

```ts
import { Effect, Schema } from "effect"
import { Decision, Domain, Policy, Principal, Resource } from "@nmnmcc/ability"

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
```

Make a policy. Each `yield*` gives one rule. The function runs at once and gives
back the policy:

```ts
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
```

The types check every name. `_.allow("fly", Post)` is a type error, because
`fly` is not an action of `Post`. `$.eq("authorId", 5)` is a type error, because
`authorId` is a string. `$.principal("name")` is a type error, because the
principal has no `name` field.

Get a decision:

```ts
const writer = User.make({ id: "u1" })
const post = Post.make({
	id: "p1",
	authorId: "u1",
	published: true,
	title: "Hello",
	body: "World",
})

const decision = Policy.decideSync(policy, {
	principal: writer,
	action: "delete",
	resource: post,
})

decision._tag // "Deny"
Decision.reason(decision) // "No one may delete a published post"
```

## Resources

A resource has a kind name, a list of actions, and Schema fields. Every value
has a `_tag` field with the kind name. The library uses `_tag` to find the
resource of a value.

There are two ways to make a resource:

```ts
// A Schema class. Its body may have its own getters and methods.
class Bot extends Resource.Class<Bot>()("Bot", {
	actions: ["read", "update"],
	fields: { id: Schema.String, ownerUserId: Schema.NullOr(Schema.String) },
}) {
	get shared() {
		return this.ownerUserId === null
	}
}

// Plain objects with a `_tag` field.
const Trigger = Resource.make("Trigger", {
	actions: ["read", "write"],
	fields: { id: Schema.String, enabled: Schema.Boolean },
})
const trigger = Trigger.make({ id: "t1", enabled: true })
```

A resource may have a path. The path puts the resource in a tree, so one rule
can cover a part of the tree:

```ts
class Bot extends Resource.Class<Bot>()("Bot", {
	actions: ["read", "update"],
	fields: {
		id: Schema.String,
		organizationId: Schema.String,
		ownerUserId: Schema.NullOr(Schema.String),
	},
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "bot", f.id],
}) {}

// Every resource of the organization of the principal.
_.allow("read", "*", {
	when: ($) => $.under("org", $.principal("organizationId")),
})
```

## Rules

- `_.allow(action, resource, options)` and `_.deny(...)` make rules. The action
  and the resource may be lists.
- The action `"*"` means every action. The resource `"*"` means every resource.
- `when` is the condition. It gets a builder with the types of the resource.
- `fields` makes the rule about some fields only. `*` stands for any part of one
  field name, and `**` for any number of parts: `settings.*` covers
  `settings.model`.
- `reason`, `id` and `meta` are kept with the rule. `meta` is extra data, such
  as the scope of a grant. Give its Schema to `Domain.make({ meta })`.

An allow rule with fields covers a request for the whole value: "may update some
fields" is a yes. A deny rule with fields does not stop a request for the whole
value.

## Conditions

The builder in `when` has these functions:

| Function                 | True when                                         |
| ------------------------ | ------------------------------------------------- |
| `eq`, `ne`               | The field is (not) equal to the value.            |
| `lt`, `lte`, `gt`, `gte` | The field is less or greater. Numbers or strings. |
| `in`                     | The field is equal to one of the values.          |
| `exists`                 | The field is not `null` and not missing.          |
| `under(...prefix)`       | The path of the resource starts with the prefix.  |
| `and`, `or`, `not`       | Logic.                                            |
| `principal(field)`       | Not a test. It gives a field of the principal.    |
| `predicate(name, test)`  | The test function says yes. It may be an Effect.  |

A missing field of a resource has the value `null`. A field of the principal
that is `null` or missing is different: a test with it is always false, also
with `ne`. So a guest with no `userId` never matches a Bot with no owner. To
test for `null`, use a fixed value, as in `$.eq("ownerUserId", null)`.

`predicate` is the one way out of plain data. Its test may give a boolean or an
`Effect`. The error type and the service type of the `Effect` go into the types
of the policy and of every check. A policy with a predicate can not become JSON
or a query, and the type system stops you when you try.

## Policies

A list of rules has a combining algorithm. It decides which rule gives the
answer when more than one rule applies:

| Algorithm                 | Winner                                   |
| ------------------------- | ---------------------------------------- |
| `denyOverrides` (default) | A deny rule wins over every allow rule.  |
| `permitOverrides`         | An allow rule wins over every deny rule. |
| `firstApplicable`         | The first rule that applies.             |
| `lastApplicable`          | The last rule that applies.              |

```ts
const policy = Policy.define(Blog, { algorithm: "lastApplicable" })(
	function* (_) {
		// ...
	},
)
```

Put policies together:

| Combinator                    | Decision                                                         |
| ----------------------------- | ---------------------------------------------------------------- |
| `Policy.all([a, b])`          | Every policy must allow. One deny is enough to deny.             |
| `Policy.any([a, b])`          | One allow is enough.                                             |
| `Policy.firstOf([a, b])`      | The first policy that allows or denies.                          |
| `Policy.ceiling(policy, cap)` | A deny from `cap` always wins. An allow from `cap` does nothing. |

For example, a user token may never do more than its member, and the platform
has deny rules for everyone:

```ts
const forToken = Policy.all([memberPolicy, tokenPolicy]).pipe(
	Policy.ceiling(platformPolicy),
)
```

A decision is one of three answers: `Allow`, `Deny`, or `NotApplicable`, when no
rule gives an answer. A check treats `NotApplicable` as a "no", but an
authorizer with a decider asks the decider first.

## Questions to a Policy

| Function                 | Answer                                                         |
| ------------------------ | -------------------------------------------------------------- |
| `Policy.decide`          | The decision for one resource value, as an `Effect`.           |
| `Policy.decideSync`      | The same, at once. Only for policies with no predicates.       |
| `Policy.explain`         | The decision and the rules that were tested, for an audit log. |
| `Policy.residual`        | The condition on resource values that the policy allows.       |
| `Policy.permittedFields` | The fields of a value that the policy lets a request use.      |

`Policy.residual` puts the principal into every rule and gives a condition on
the resource fields only. It is `True` when the policy allows every value of the
kind, and `False` when it allows none. Use it to ask "may this principal do this
act on some value of this kind?", or to make a database query.

### A part of a kind

A kind target may have `where`: known values of some fields. Then the question
is about the part of the kind with these values, such as "the Bots of this
user":

```ts
Policy.residual(policy, {
	principal,
	action: "update",
	kind: "Post",
	where: { authorId: "u1" },
})
```

The result is `True` when the policy allows the act on every post of `u1`.
`Condition.assign` does the same work on any condition.

## Queries

Change a residual condition into a query with `Condition.fold`. You give one
function for each kind of node:

```ts
const toSql = Condition.fold<string>({
	true: () => "TRUE",
	false: () => "FALSE",
	compare: (op, field, value) => `${field} ${sqlOperator(op)} ${quote(value)}`,
	in: (field, values) => `${field} IN (${values.map(quote).join(", ")})`,
	exists: (field) => `${field} IS NOT NULL`,
	and: (parts) => `(${parts.join(" AND ")})`,
	or: (parts) => `(${parts.join(" OR ")})`,
	not: (part) => `NOT ${part}`,
})

const where =
	yield *
	toSql(Policy.residual(policy, { principal, action: "read", kind: "Post" }))
```

`fold` fails with `Untranslatable` on a predicate, unless you give a `predicate`
function too. Take care with `null`: in this library `ne` is true when the field
is `null`, but in SQL `x <> 'a'` is not true when `x` is `NULL`. Use
`IS DISTINCT FROM` or a similar form.

## JSON

A policy with no predicates can become JSON:

```ts
const PolicySchema = Policy.schema(Blog)

const json = Schema.encodeSync(PolicySchema)(policy)
const again = Schema.decodeUnknownSync(PolicySchema)(json)
```

Decoding checks every kind, action, field and principal field against the
domain, and `meta` against the `meta` Schema of the domain. So a policy from a
database can not name a field that does not exist.

## Authorizer

An authorizer is an Effect service. It gets the principal of the current
request, loads its policy, and keeps the policy in a cache.

```ts
class Identity extends Context.Service<Identity, User>()("app/Identity") {}

class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
	"app/Auth",
	Blog,
) {}

const AuthLive = Authorizer.layer(Auth, {
	principal: Identity,
	policy: (user) => loadPolicyOf(user),
	cache: { capacity: 1000, timeToLive: "30 seconds" },
})
```

Use it in a handler:

```ts
yield * Auth.check({ action: "update", resource: post })
yield * Auth.check({ action: "read", kind: "Post" })
yield *
	Auth.guard(
		{ action: "update", resource: post },
		{
			hide: () => PostNotFound.make({ id: post.id }),
		},
	)
const where = yield * Auth.filter({ action: "read", kind: "Post" })
```

| Function          | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `check`           | Succeeds with `void`, or fails with `Forbidden`.                              |
| `guard`           | Fails with your error when the principal may not read the value, then checks. |
| `filter`          | Gives the residual condition, for a list query.                               |
| `decide`          | Gives the decision. It does not fail on a "no".                               |
| `permittedFields` | Gives the fields that the principal may use.                                  |
| `invalidate`      | Removes a cached policy, after a change to the rules of a principal.          |

A check on a kind (`{ action, kind }`) passes only when the policy allows the
act on every value of the kind. With `where`, it passes when the policy allows
the act on every value with those field values.

The errors of a check:

- `Forbidden`: the policy says no. It has the action, the kind, the field, and
  the reason of the rule.
- `PolicyUnavailable`: the policy could not be loaded. It keeps the cause.
- `Pending`: the decider must wait for an answer. It has a `ticket`.

### Deciders

When no rule gives an answer, the authorizer asks the decider, if there is one.
A decider may answer at once, or fail with `Pending` when a person or a Bot must
answer later:

```ts
Authorizer.layer(Auth, {
	principal: Identity,
	policy: loadPolicyOf,
	decider: (request) =>
		requests
			.create(request)
			.pipe(Effect.flatMap((ticket) => Authorizer.Pending.make({ ticket }))),
})
```

When the answer comes, keep it as a rule, for example in a grant policy that
comes first: `Policy.firstOf([grants, rules])`.

## HttpApi

`@nmnmcc/ability/HttpApi` checks requests in an `effect/http-api` server. Each
endpoint says what it needs. An endpoint with no annotation is closed, so a new
endpoint does nothing until you say what it needs:

```ts
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"

class Authorization extends HttpApiMiddleware.Service<
	Authorization,
	{ requires: Identity }
>()("app/Authorization", { error: AbilityHttpApi.errors }) {}

const update = HttpApiEndpoint.patch("update", "/posts/:id", {
	params: { id: Schema.String },
}).annotate(AbilityHttpApi.Required, [
	AbilityHttpApi.requires(Auth, "update", "Post", (params) =>
		Posts.find(params["id"]),
	),
])

const health = HttpApiEndpoint.get("health", "/health").annotate(
	AbilityHttpApi.Required,
	[],
)

const AuthorizationLive = AbilityHttpApi.layer(Authorization, Auth)
```

`requiresWhere` checks a part of a kind, with no value to load. Its function
gets the path parameters and the principal, and gives the known field values:

```ts
AbilityHttpApi.requiresWhere(Auth, "read", "Post", (params, user) => ({
	authorId: user.id,
}))
```

A `load` function gets the principal as its second argument too.

`GroupRequired` gives a default for a whole group: one list for GET requests and
one for every other method. `AbilityHttpApi.errors` gives the errors with HTTP
status codes: 403, 503, and 409.

## Examples

```sh
node examples/basic.ts
node examples/authorizer.ts
node examples/openbot-rbac.ts
```
