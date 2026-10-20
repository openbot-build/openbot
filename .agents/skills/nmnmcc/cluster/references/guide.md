# Cluster

Use `$cluster` to start a work cluster. Cluster is a way to arrange agents around one result, not a fourth engineering view and not a separate coordinator role. The root agent remains `plane`.

## Keep one result in three layers

Use this fixed relationship:

```text
Plane  (root agent: whole result, boundaries, integration, acceptance)
|-- Line  (one agent for each in-scope Plane pass)
|   `-- Point  (local agents for causes, changes, and deferred-check requirements; checks run later by the validation coordinator)
`-- Line  ...
```

`plane` owns the user promise from the first shape through the final handoff. A `pass` in Plane is the place of a domain branch that `line` must resolve; it is not completion and it is not a second coordinator. Each `line` owns one such domain rule and the domain result returned to Plane. Each `point` owns one local cause-and-effect question assigned by Line. The layers are fixed: a Point returns an expanded concern to Line, and a Line returns a cross-domain concern to Plane; neither creates a lateral role or skips its parent. An agent assigned to Line or Point stays in that layer even though it owns its own thread; it does not start a new Plane root.

## Start a cluster when it helps

Start a cluster only when the work produces at least two independently reviewable workstreams or needs separate owners for different technical domains. Typical cases include:

- a visible result crosses UI, API, services, data, infrastructure, or operations;
- one domain rule covers several local changes that can be checked separately;
- exploration, implementation, checking, or review needs separate working context;
- independent work can move together and later be integrated by Plane.

Keep one local cause in `point`, one domain rule in `line`, or one cross-boundary path in `plane` when a cluster would add no useful work.

## Freeze contracts before implementation

The root uses `$cluster` and `$plane` together. Plane holds the user result, scope, acceptance, boundaries, and participating domains. Each parent scans all parts it owns before implementation: Plane scans the domain branches; each Line scans the modules in its domain. This scan sets scope and ownership. It does not build a dependency graph or choose a topological order.

The parent defines and freezes the shared contracts for its children before any implementation child starts. Express each contract as a first-class typed interface in the project's target language or framework. Use the project's native dependency-injection form when it already has one. Otherwise declare the native typed interface and let each module agent infer and provide its implementation. Do not add a DI container, framework, shared IDL, or other fallback only for Cluster.

The root Plane owns cross-domain contracts. A Line owns contracts shared by Points in its domain. A child may report that a frozen contract cannot satisfy the task, but it must not change that contract itself. The parent decides and freezes any revision before redispatching every affected child.

## Implement every sibling in parallel

After all contracts for a sibling set are frozen, dispatch every in-scope sibling implementation at once. Do not inspect dependency direction, prove that siblings are independent, or order them topologically. Flattening changes scheduling only: Plane → Line → Point ownership, task scope, and parent integration remain fixed.

Give each implementation agent its module ownership, required behavior, frozen interfaces, allowed public surfaces, change boundary, and deferred acceptance checks. It may read only its own module, its task card, frozen interfaces, and explicitly allowed public surfaces. It must not read a sibling module's internal implementation or coordinate laterally with a sibling.

During implementation, no agent runs compilation, type checking, static analysis, linting, formatting checks, or tests. It may state which checks the validator must run later, but it must not claim that unrun checks prove its work. A Point returns its implementation and assumptions to Line. A Line integrates its Points and returns one domain result to Plane. Concerns still move upward through the fixed layers.

## Validate and align after all implementation

Wait until every implementation agent in the whole Cluster has returned. Then Plane assigns one dedicated validation coordinator. Only this coordinator runs the project's native compile, type, static, lint, and test commands. It may inspect frozen contracts, allowed public surfaces, and diagnostics; it needs parent authorization before reading a module's internals.

The coordinator normalizes failures by contract and module, then dispatches all module-local alignment agents in parallel. Each alignment agent may read and edit only its assigned module plus its frozen interfaces and diagnostics. It must not change a contract, inspect sibling internals, or run checks. If a repair needs a contract change, return it to the owning parent. The parent revises and freezes the contract centrally, then redispatches all affected modules in parallel.

After alignment agents return, the coordinator reruns the relevant targeted checks and then the full acceptance checks. Repeat this diagnose, parallel-align, targeted-check, full-check loop while diagnostics lead to clear module-local repairs. Plane integrates the returned Line results and accepts the Cluster only after full acceptance passes.

## Keep collaboration healthy

Give every agent one bounded ownership area and enough contract context to work without reconstructing the whole result. If an agent cannot continue or finds a concern outside its boundary, it tells its parent. The parent clarifies, revises the contract, changes the owner, narrows the work, or brings a material product choice to the user. An agent return is not acceptance by itself.

## Finish as Plane

The root `plane` declares the Cluster complete only when the promised result is integrated, every participating Line rule is coherent, the validation coordinator has completed targeted and full checks, and the full acceptance case passes. Report the user-visible result first and include only the evidence or unresolved decision the user needs. Keep the agent tree and collaboration mechanics backstage unless the user needs them to continue the work.
