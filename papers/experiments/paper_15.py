"""Finite tests for the runtime model in paper 15."""

from dataclasses import dataclass
from itertools import permutations, product
import random

from support import Checks


@dataclass(frozen=True)
class Role:
    name: str
    check: str = "true"
    tools: tuple = ()
    handlers: tuple = ()
    prompt: tuple = ()
    hooks: tuple = ()
    resources: tuple = ()
    deadline: tuple | None = None


ROLES = (
    Role("allow", deadline=(5, "allow")),
    Role("deny", check="false", deadline=(5, "deny")),
    Role("failure", check="error", deadline=(2, "check error")),
    Role("prompt", prompt=("mask",)),
    Role("tool", tools=(("send", ("send-key", "tool-v1")),),
         handlers=(("send-key", "tool-v1"),)),
    Role("resource", resources=("connection",)),
    Role("keyed", hooks=("keyed",)),
    Role("unkeyed", hooks=("unkeyed",)),
)
PROMPT = (("request", "user", "keep secret"),)


def override(left, right):
    return tuple((dict(left) | dict(right)).items())


def merge(left, right):
    a, b = left["deadline"], right["deadline"]
    deadline = b if a is None else a if b is None or a[0] <= b[0] else b
    return {
        "tools": override(left["tools"], right["tools"]),
        "handlers": override(left["handlers"], right["handlers"]),
        "instructions": left["instructions"] + right["instructions"],
        "checks": (left["checks"], right["checks"]),
        "prompt": left["prompt"] + right["prompt"],
        "hooks": left["hooks"] + right["hooks"],
        "deadline": deadline,
    }


def build(tree, trace, resources):
    if tree is None:
        return {"tools": (), "handlers": (), "instructions": (), "checks": None,
                "prompt": (), "hooks": (), "deadline": None}
    if isinstance(tree, Role):
        trace.append(("build", tree.name))
        for resource in tree.resources:
            resource = f"{resource}/{len(resources)}"
            resources.append(resource)
            trace.append(("acquire", resource))
        return {
            "tools": tree.tools,
            "handlers": tree.handlers,
            "instructions": (tree.name,),
            "checks": tree,
            "prompt": tree.prompt,
            "hooks": tree.hooks,
            "deadline": tree.deadline,
        }
    return merge(build(tree[0], trace, resources), build(tree[1], trace, resources))


def check(tree, trace, eager=False):
    if tree is None:
        return "true"
    if isinstance(tree, Role):
        trace.append(("check", tree.name, tree.check))
        return tree.check
    first = check(tree[0], trace, eager)
    second = check(tree[1], trace, eager) if eager or first == "true" else None
    return second if first == "true" else first


def dispatch(registration, kind, trace, *, pairs=True, eager=False):
    status = check(registration["checks"], trace, eager) if not pairs or valid_pairs(registration) else "invalid tool pair"
    prompt = PROMPT
    if status == "true":
        for action in registration["prompt"]:
            prompt = tuple((key, role, (text.replace("secret", "[hidden]") if action == "mask"
                                             else text.replace("[hidden]", "secret")))
                           for key, role, text in prompt)
            trace.append(("transform", action))
        if kind == "model":
            trace.extend((("model", prompt), ("save", "model")))
        # The synthetic call list uses sorted names. A real model supplies its own order.
        for name, (key, token) in sorted(registration["tools"]):
            trace.append(("tool", name, dict(registration["handlers"])[key]))
            trace.append(("save", name))
        trace.extend(("hook", hook) for hook in registration["hooks"])
    else:
        trace.append(("stop", status))
    return status


def execute(tree, kind, *, pairs=True, eager=False, cleanup=True):
    trace, resources = [], []
    registration = build(tree, trace, resources)
    status = dispatch(registration, kind, trace, pairs=pairs, eager=eager)
    if cleanup:
        trace.extend(("release", resource) for resource in reversed(resources))
    trace.append(("end", status))
    return registration, tuple(trace)


def oracle(roles, kind):
    """Read leaf data. Do not call the implementation or its validation helpers."""
    trace, opened = [], []
    for role in roles:
        trace.append(("build", role.name))
        for name in role.resources:
            name = f"{name}/{len(opened)}"
            trace.append(("acquire", name))
            opened.append(name)
    chosen, handlers = {}, {}
    for role in reversed(roles):
        for name, value in role.tools:
            chosen.setdefault(name, value)
        for name, value in role.handlers:
            handlers.setdefault(name, value)
    keys = [value[0] for value in chosen.values()]
    good = len(keys) == len(set(keys)) and all(
        key in handlers and handlers[key] == token for key, token in chosen.values())
    status = "true" if good else "invalid tool pair"
    if good:
        for role in roles:
            trace.append(("check", role.name, role.check))
            if role.check != "true":
                status = role.check
                break
    if status == "true":
        text = "keep secret"
        for role in roles:
            for action in role.prompt:
                trace.append(("transform", action))
                if action == "mask":
                    text = "[hidden]".join(text.split("secret"))
                else:
                    text = "secret".join(text.split("[hidden]"))
        prompt = (("request", "user", text),)
        if kind == "model":
            trace.extend((("model", prompt), ("save", "model")))
        for name in sorted(chosen):
            key, token = chosen[name]
            trace.extend((("tool", name, handlers[key]), ("save", name)))
        for role in roles:
            for hook in role.hooks:
                trace.append(("hook", hook))
    else:
        trace.append(("stop", status))
    for resource in reversed(opened):
        trace.append(("release", resource))
    trace.append(("end", status))
    deadlines = [role.deadline for role in roles if role.deadline is not None]
    return tuple(trace), chosen, handlers, min(deadlines, key=lambda item: item[0]) if deadlines else None


def groupings(roles):
    """All ordered full binary trees; None is the empty registration."""
    if not roles:
        return (None,)
    if len(roles) == 1:
        return (roles[0],)
    return tuple((left, right) for split in range(1, len(roles))
                 for left in groupings(roles[:split])
                 for right in groupings(roles[split:]))


def valid_pairs(registration):
    handlers = dict(registration["handlers"])
    keys = [key for key, token in dict(registration["tools"]).values()]
    return len(keys) == len(set(keys)) and all(
        handlers.get(key) == token for key, token in dict(registration["tools"]).values()
    )


def scope_trace(failure_after, bad_releases):
    """Each cut unwinds a scope. A failed release still permits later releases."""
    trace, live = [], []
    state = "open"
    cause = "ok"
    for index in range(3):
        name = f"r{index}"
        live.append(name)
        trace.append(("acquire", name))
        if index == failure_after:
            cause = "build failed"
            break
    trace.append(("exit", cause))
    state = "closing"
    trace.extend((("stop", "children"), ("join", "children")))
    for name in reversed(live):
        trace.append(("release", name))
        if name in bad_releases:
            trace.append(("release failed", name))
    state = "closed"
    return state, tuple(trace)


def apply_receipt(state, receipts, key, payload, action, fail_commit=False, *, keyed=True):
    if not keyed:
        changed = action(state)
        return changed, changed
    if key in receipts:
        old_payload, result = receipts[key]
        if old_payload != payload:
            raise ValueError("The saved value changed")
        return state, result
    changed = action(state)
    if fail_commit:
        raise RuntimeError("The write failed")
    receipts[key] = (payload, changed)
    return changed, changed


class Scope:
    """A finite local scope machine. A blocked close is never called closed."""

    def __init__(self):
        self.state = "open"
        self.resources = []
        self.tasks = []
        self.events = []
        self.causes = []

    def acquire(self, name):
        if self.state != "open":
            raise ValueError("The scope is not open")
        self.resources.append(name)
        self.events.extend((("acquire", name), ("register", name)))

    def start(self, name):
        if self.state != "open":
            raise ValueError("The scope is not open")
        self.tasks.append(name)
        self.events.append(("start", name))

    def close(self, exit_cause, *, joined=True, failed=(), blocked=None):
        if self.state != "open":
            raise ValueError("The scope is not open")
        self.state = "closing"
        self.causes.append(exit_cause)
        self.events.append(("exit", exit_cause))
        for task in self.tasks:
            self.events.append(("interrupt", task))
        if not joined:
            self.events.append(("wait", "children"))
            return
        for task in self.tasks:
            self.events.append(("join", task))
        for resource in reversed(self.resources):
            self.events.append(("release", resource))
            if resource == blocked:
                self.events.append(("wait", resource))
                return
            if resource in failed:
                self.causes.append(("release failed", resource))
        self.state = "closed"


def extended_cases(checks):
    """Use repeated leaves, several tools, all bracketings, and invalid pairs."""
    tools = (
        Role("a", tools=(("a", ("ka", "v1")),), handlers=(("ka", "v1"),)),
        Role("b", tools=(("b", ("kb", "v1")),), handlers=(("kb", "v1"),)),
        Role("a-new", tools=(("a", ("ka", "v2")),), handlers=(("ka", "v2"),)),
        Role("bad", tools=(("c", ("ka", "v3")),), handlers=(("ka", "v3"),)),
        Role("mask", prompt=("mask",)), Role("expand", prompt=("expand",)),
    )
    corpus = [roles for size in range(4) for roles in product(ROLES, repeat=size)]
    corpus += [roles for size in range(4) for roles in product(tools, repeat=size)]
    corpus += [tuple(ROLES[:4]), tuple(ROLES[4:]), tools[:4], tools[2:]]
    corpus = list(dict.fromkeys(corpus))
    variants = traces = invalid = 0
    for roles in corpus:
        previous = {}
        for tree in groupings(roles):
            variants += 1
            for kind in ("model", "action"):
                actual, events = execute(tree, kind)
                expected, chosen, handlers, deadline = oracle(roles, kind)
                checks.equal("extended oracle trace", events, expected)
                checks.equal("extended selected tools", dict(actual["tools"]), chosen)
                checks.equal("extended selected handlers", dict(actual["handlers"]), handlers)
                checks.equal("extended deadline", actual["deadline"], deadline)
                if kind in previous:
                    checks.equal("extended grouping trace", events, previous[kind])
                previous[kind] = events
                if ("stop", "invalid tool pair") in events:
                    checks.that("invalid registration has no check or dispatch", not any(
                        event[0] in ("check", "model", "tool") for event in events))
                    invalid += 1
                traces += 1
        if roles:
            tree = groupings(roles)[0]
            for kind in ("model", "action"):
                base = execute(tree, kind)[1]
                checks.equal("left identity", execute((None, tree), kind)[1], base)
                checks.equal("right identity", execute((tree, None), kind)[1], base)
    return {"ordered_lists": len(corpus), "grouped_variants": variants,
            "traces": traces, "invalid_pair_traces": invalid}


def scope_boundaries(checks):
    completed = blocked = 0
    for count in range(5):
        for exit_cause in ("ok", "build failed", "hook failed", "interrupted"):
            for mask in range(1 << count):
                scope = Scope()
                for index in range(count):
                    scope.acquire(f"r{index}")
                scope.start("child")
                failed = {f"r{i}" for i in range(count) if mask & (1 << i)}
                scope.close(exit_cause, failed=failed)
                checks.equal("completed scope is closed", scope.state, "closed")
                release = tuple(event[1] for event in scope.events if event[0] == "release")
                checks.equal("all registered releases run once", release,
                             tuple(f"r{i}" for i in reversed(range(count))))
                checks.equal("all exit causes remain", scope.causes,
                             [exit_cause] + [("release failed", name) for name in release if name in failed])
                checks.that("child join precedes all releases", all(
                    scope.events.index(("join", "child")) < scope.events.index(("release", name))
                    for name in release))
                completed += 1
    for joined, blocked_name in ((False, None), (True, "r1"), (True, "r0")):
        scope = Scope()
        scope.acquire("r0")
        scope.acquire("r1")
        scope.start("child")
        scope.close("interrupted", joined=joined, blocked=blocked_name)
        checks.equal("blocked close stays closing", scope.state, "closing")
        expected = () if not joined else ("r1",) if blocked_name == "r1" else ("r1", "r0")
        checks.equal("blocked close records only attempted releases", tuple(
            event[1] for event in scope.events if event[0] == "release"), expected)
        for operation in (lambda: scope.acquire("late"), lambda: scope.start("late")):
            try:
                operation()
            except ValueError:
                checks.that("closing rejects new work", True)
            else:
                checks.that("closing rejects new work", False)
        blocked += 1
    return {"completed_cases": completed, "blocked_cases": blocked}


def finalizer_dependencies(checks):
    """Check all directed dependency graphs on zero through four resources."""
    cases = safe = 0
    for size in range(5):
        edges = [(owner, used) for owner in range(size) for used in range(size) if owner != used]
        for mask in range(1 << len(edges)):
            dependencies = [edge for bit, edge in enumerate(edges) if mask & (1 << bit)]
            accepts = all(used < owner for owner, used in dependencies)
            live = set(range(size))
            unsafe = False
            for owner in reversed(range(size)):
                for use_owner, used in dependencies:
                    if use_owner == owner and used not in live:
                        unsafe = True
                live.remove(owner)
            checks.equal("release rank rule matches live-resource oracle", accepts, not unsafe)
            checks.equal("release completes the finite ledger", live, set())
            cases += 1
            safe += accepts
    return {"graphs": cases, "accepted": safe, "rejected": cases - safe,
            "bound": 4, "self_edges": "excluded; a finalizer may use its own resource before release"}


def receipt_boundaries(checks):
    # Two instances of one plugin need two stable keys, even with the same version.
    def writes(keys):
        ledger, state = {}, 0
        for _ in range(2):
            for key in keys:
                state, _ = apply_receipt(state, ledger, key, "same", lambda value: value + 1)
        return state

    prefix = ("turn", 1, "model", "plugin", 1)
    checks.equal("shared plugin key loses a distinct hook", writes((prefix, prefix)), 1)
    checks.equal("stable instance keys keep both hooks once", writes((prefix + (0,), prefix + (1,))), 2)
    # A state-changing check can make a formerly denied chain allow.
    def evaluate(guards, state):
        for guard in guards:
            allowed, state = guard(state)
            if not allowed:
                return False
        return True

    read_flag = lambda state: (state, state)
    set_flag = lambda state: (True, True)
    before = evaluate((read_flag,), False)
    after = evaluate((set_flag, read_flag), False)
    checks.that("effectful check extension need not narrow permission", not before and after)
    return {"shared_instance_key_writes": 1, "distinct_instance_key_writes": 2,
            "guard_extension_counterexample": {"before": before, "after": after}}


def finite_hook_laws(checks):
    """Enumerate every total map on four states, without testing only one input."""
    states = range(4)
    functions = [f for f in product(states, repeat=4)
                 if all(f[f[x]] == f[x] for x in states)]
    commute = changed = noncommuting_safe = 0
    witness = None
    for first, second in product(functions, repeat=2):
        chain = tuple(second[first[x]] for x in states)
        fixed = all(chain[chain[x]] == chain[x] for x in states)
        commutes = all(first[second[x]] == second[first[x]] for x in states)
        if commutes:
            checks.that("commuting idempotent hooks have an idempotent chain", fixed)
            commute += 1
        elif fixed:
            noncommuting_safe += 1
        else:
            changed += 1
            if witness is None:
                state = next(x for x in states if chain[chain[x]] != chain[x])
                witness = {"first": first, "second": second, "start": state,
                           "once": chain[state], "twice": chain[chain[state]]}
    checks.equal("all idempotent four-state maps", len(functions), 41)
    checks.equal("all ordered map pairs", len(functions) ** 2, 1681)
    checks.that("idempotence alone is insufficient", changed > 0)
    checks.that("commutation is sufficient but not necessary", noncommuting_safe > 0)
    return {"states": 4, "total_maps": 256, "idempotent_maps": len(functions),
            "ordered_pairs": len(functions) ** 2, "commuting_pairs": commute,
            "non_idempotent_chains": changed, "noncommuting_idempotent_chains": noncommuting_safe,
            "counterexample": witness}


def prepare_prompt(prompt, transforms, *, per_transform=True):
    changed = prompt
    expected = tuple(item[:2] for item in prompt)
    for transform in transforms:
        changed = transform(changed)
        if per_transform and tuple(item[:2] for item in changed) != expected:
            return prompt, False
    return (changed, True) if len(changed) == len(prompt) else (prompt, False)


def deadline_allows(start, duration, now, *, renew=False):
    saved_start = now if renew else start
    return now < saved_start + duration


def ablation_cases(checks):
    """Each row removes one rule. An independent predicate checks the outcome."""
    rows = []

    def record(name, baseline_bad, protected_bad, safe_rejected):
        checks.that(name + " exposes the fault", baseline_bad)
        checks.that(name + " full rule prevents the fault", not protected_bad)
        checks.that(name + " accepts the safe control", not safe_rejected)
        rows.append({"removed_rule": name, "faults": 1,
                     "faults_with_rule": int(protected_bad), "faults_without_rule": int(baseline_bad),
                     "safe_controls": 1, "false_rejections": int(safe_rejected)})

    old = Role("old", tools=(("a", ("shared", "v1")),), handlers=(("shared", "v1"),))
    other = Role("other", tools=(("b", ("shared", "v2")),), handlers=(("shared", "v2"),))
    new = Role("new", tools=(("a", ("shared", "v2")),), handlers=(("shared", "v2"),))
    bad_dispatch = lambda events: any(event[:2] == ("tool", "a") and event[2] != "v1" for event in events)
    record("pair validation", bad_dispatch(execute((old, other), "action", pairs=False)[1]),
           bad_dispatch(execute((old, other), "action")[1]),
           ("tool", "a", "v2") not in execute((old, new), "action")[1])
    denied = (ROLES[1], ROLES[0])
    after_deny = lambda events: ("check", "allow", "true") in events
    record("short-circuit check", after_deny(execute(denied, "model", eager=True)[1]),
           after_deny(execute(denied, "model")[1]),
           ("model", PROMPT) not in execute((ROLES[0], ROLES[0]), "model")[1])
    resource = ROLES[5]
    leak = lambda events: sum(event[0] == "acquire" for event in events) != sum(
        event[0] == "release" for event in events)
    record("scope cleanup", leak(execute(resource, "action", cleanup=False)[1]),
           leak(execute(resource, "action")[1]), leak(execute((resource, ROLES[0]), "action")[1]))
    prompt = (("request", "user", "write"), ("rule", "system", "do not send"))
    transforms = (lambda value: value[:1], lambda value: value + (("added", "user", "continue"),))
    weak, weak_ok = prepare_prompt(prompt, transforms, per_transform=False)
    full, full_ok = prepare_prompt(prompt, transforms)
    safe, safe_ok = prepare_prompt(prompt, (lambda value: (("request", "user", "ask"), value[1]),))
    record("per-transform prompt check", weak_ok and prompt[1] not in weak,
           full_ok and prompt[1] not in full, not safe_ok)
    def replay(keyed):
        ledger, value = {}, 0
        for _ in range(2):
            value, _ = apply_receipt(value, ledger, "key", "same", lambda state: state + 1, keyed=keyed)
        return value
    distinct, total = {}, 0
    for key in ("first", "second"):
        total, _ = apply_receipt(total, distinct, key, "same", lambda state: state + 1)
    record("saved hook receipt", replay(False) > 1, replay(True) > 1, total != 2)
    # The retry starts after the original deadline; a fresh start would allow it.
    start, duration, retry = 10, 5, 16
    record("saved deadline start", deadline_allows(start, duration, retry, renew=True),
           deadline_allows(start, duration, retry), not deadline_allows(start, duration, 14))
    for now, allowed in ((14, True), (15, False), (16, False)):
        checks.equal("deadline uses the closed expiry boundary", deadline_allows(start, duration, now), allowed)
    return rows


def run(seed_count: int) -> list[dict]:
    checks = Checks()
    lists, variants, traces, blocked = 0, 0, 0, 0
    for size in (1, 2, 3):
        for roles in permutations(ROLES, size):
            lists += 1
            previous = {}
            for tree in groupings(roles):
                variants += 1
                for kind in ("model", "action"):
                    registration, actual = execute(tree, kind)
                    expected, tools, handlers, deadline = oracle(roles, kind)
                    name = "/".join(role.name for role in roles) + "/" + kind
                    checks.equal(name + " trace", actual, expected)
                    checks.equal(name + " tools", dict(registration["tools"]), tools)
                    checks.equal(name + " handlers", dict(registration["handlers"]), handlers)
                    checks.equal(name + " deadline", registration["deadline"], deadline)
                    checks.equal(name + " instructions", registration["instructions"],
                                 tuple(role.name for role in roles))
                    checks.that(name + " pairs", valid_pairs(registration))
                    if kind in previous:
                        checks.equal(name + " grouping", actual, previous[kind])
                    previous[kind] = actual
                    if any(event[0] == "stop" for event in actual):
                        checks.that(name + " no dispatch", not any(
                            event[0] in ("model", "tool") for event in actual))
                        blocked += 1
                    traces += 1
    checks.equal("ordered lists", lists, 400)
    checks.equal("grouped variants", variants, 736)
    checks.equal("model and action traces", traces, 1472)

    # A right replacement must keep the chosen definition and handler together.
    old = Role("old", tools=(("send", ("shared", "v1")),), handlers=(("shared", "v1"),))
    new = Role("new", tools=(("send", ("shared", "v2")),), handlers=(("shared", "v2"),))
    pair, _ = execute((old, new), "action")
    checks.equal("right tool wins", dict(pair["tools"])["send"], ("shared", "v2"))
    checks.that("paired replacement passes", valid_pairs(pair))
    reversed_pair, _ = execute((new, old), "action")
    checks.that("order changes tool", pair["tools"] != reversed_pair["tools"])
    broken = dict(pair, handlers=old.handlers)
    checks.that("wrong handler precedence is found", not valid_pairs(broken))
    other = Role("other", tools=(("other", ("shared", "v3")),), handlers=(("shared", "v3"),))
    for kind in ("model", "action"):
        broken_trace = []
        checks.equal("wrong handler pair stops the step", dispatch(broken, kind, broken_trace), "invalid tool pair")
        checks.that("wrong handler pair has no dispatch", not any(
            event[0] in ("model", "tool") for event in broken_trace))
        clash, clash_trace = execute((old, other), kind)
        checks.that("shared handler key is found", not valid_pairs(clash))
        checks.that("shared handler key stops the step", ("stop", "invalid tool pair") in clash_trace)
        checks.that("shared handler key has no dispatch", not any(
            event[0] in ("model", "tool") for event in clash_trace))

    scope_cases = 0
    for cut in (-1, 0, 1, 2):
        acquired = tuple(f"r{i}" for i in range(3 if cut == -1 else cut + 1))
        for mask in range(8):
            bad = {f"r{i}" for i in range(3) if mask & (1 << i)}
            state, events = scope_trace(cut, bad)
            checks.equal("scope closes", state, "closed")
            checks.equal("all releases are tried", tuple(event[1] for event in events
                         if event[0] == "release"), tuple(reversed(acquired)))
            checks.equal("cleanup keeps build cause", next(event[1] for event in events
                         if event[0] == "exit"), "ok" if cut == -1 else "build failed")
            checks.that("children end before release", events.index(("join", "children")) <
                        next(index for index, event in enumerate(events) if event[0] == "release"))
            scope_cases += 1

    # The same message count can hide a lost restriction.
    prompt = (("request", "user", "write"), ("rule", "system", "do not send"))
    dropped = prompt[:1]
    changed = dropped + (("added", "user", "continue"),)
    checks.equal("weak prompt count passes", len(changed), len(prompt))
    checks.that("weak prompt loses rule", prompt[1] not in changed)
    checks.that("per-function ID check finds loss", tuple(item[0] for item in dropped) !=
                tuple(item[0] for item in prompt))

    # Local idempotence does not imply that the ordered chain is idempotent.
    copy_y = lambda state: (state[1], state[1])
    set_y = lambda state: (state[0], 1)
    for x in (0, 1):
        for y in (0, 1):
            for action in (copy_y, set_y):
                checks.equal("hook is idempotent alone", action(action((x, y))), action((x, y)))
    once = set_y(copy_y((0, 0)))
    twice = set_y(copy_y(once))
    checks.equal("first chain", once, (0, 1))
    checks.equal("repeated chain", twice, (1, 1))
    receipts, state = {}, (0, 0)
    keys = (("turn", 1, "model", "a", 1), ("turn", 1, "model", "b", 1))
    state, _ = apply_receipt(state, receipts, keys[0], "saved", copy_y)
    # A failed suffix leaves the successful prefix receipt for the next attempt.
    state, _ = apply_receipt(state, receipts, keys[0], "saved", copy_y)
    state, _ = apply_receipt(state, receipts, keys[1], "saved", set_y)
    for key, action in zip(keys, (copy_y, set_y)):
        state, _ = apply_receipt(state, receipts, key, "saved", action)
    checks.equal("keyed chain stays fixed", state, (0, 1))
    checks.equal("one receipt per hook", len(receipts), 2)
    try:
        apply_receipt(state, receipts, keys[0], "changed", copy_y)
    except ValueError:
        checks.that("changed saved value is rejected", True)
    else:
        checks.that("changed saved value is rejected", False)

    attempts = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        ledger, count = {}, 0
        key = ("turn", seed, "model", "usage", 1)
        failures = rng.randrange(1, 5)
        repeats = rng.randrange(2, 8)
        for attempt in range(failures + repeats):
            attempts += 1
            try:
                count, _ = apply_receipt(count, ledger, key, "saved", lambda value: value + 1,
                                         fail_commit=attempt < failures)
            except RuntimeError:
                checks.equal("failed write leaves state", count, 0)
                checks.equal("failed write leaves no receipt", len(ledger), 0)
        checks.equal("repeated write commits once", count, 1)
        checks.equal("repeated write has one receipt", len(ledger), 1)

    extended = extended_cases(checks)
    scope = scope_boundaries(checks)
    laws = finite_hook_laws(checks)
    dependencies = finalizer_dependencies(checks)
    receipts = receipt_boundaries(checks)
    ablations = ablation_cases(checks)

    return [{
        "paper_id": "15",
        "title": "Preserving Execution Constraints in a Composable Agent Runtime",
        "checks": checks.count,
        "seeds": seed_count,
        "metrics": {"base_ordered_lists": lists, "base_grouped_variants": variants,
                    "base_traces": traces, "extended": extended, "scope": scope,
                    "hook_laws": laws, "finalizer_dependencies": dependencies,
                    "receipt_boundaries": receipts, "ablations": ablations},
        "observations": [
            f"All {lists} ordered role lists and {variants} grouped variants passed the leaf oracle.",
            f"All {traces} model and action traces matched; {blocked} blocked traces had no dispatch.",
            f"All {scope_cases} build and release failure cases tried every owned release in reverse order.",
            "Right replacement kept its handler. Wrong precedence and a shared handler key stopped both model and action steps before dispatch.",
            "The weak prompt count check accepted 2 messages after the restriction was lost.",
            "Two hooks each passed local idempotence, but their chain changed (0, 0) to (0, 1) to (1, 1).",
            "Per-hook receipts kept the chain at (0, 1), with 2 receipts, after prefix and full replay.",
            f"Across {seed_count} seeds and {attempts} write attempts, each key had 1 committed write.",
            f"Extended cases checked {extended['ordered_lists']} lists and {extended['traces']} traces with repeats, empty records, several tools, and all groupings.",
            "All 1,681 ordered pairs of idempotent four-state maps were checked: 601 commuted, 264 had a non-idempotent chain, and 816 had an idempotent chain without commuting.",
            f"All {scope['completed_cases']} completed scope cases kept every exit cause; {scope['blocked_cases']} blocked cases stayed closing.",
            f"All {dependencies['graphs']} finalizer dependency graphs through four resources matched the independent live-resource oracle.",
            "Two instances sharing a receipt key lost one intended write; stable instance keys kept both writes once.",
            "Six single-rule ablations each exposed one designed fault. The full rule set avoided those faults and accepted all six safe controls.",
        ],
        "limitations": [
            "This is a finite Python model. It does not run the OpenBot runtime or a compiler.",
            "The role lists use one fixed initial prompt and a small declared tool set. Sorted names define the synthetic call order; a real model supplies its own call order.",
            "The pair check uses handler tokens and unique keys. Schema and replacement declaration checks are outside this model.",
            "Receipt writes are single-process model transactions. No real database or remote write is tested.",
            "The scope machine models blocked joins and releases. It does not run real tasks, interrupts, or resource adapters.",
            "Ablation cases are chosen witnesses, not a random population or a measure of general detection rates.",
            "No timing, model meaning, static checker, transport, or general proof claim is made.",
        ],
    }]
