"""A finite search of unsafe calls. This is a model, not OpenBot code."""

from collections import deque
from dataclasses import dataclass, replace
from typing import Iterator


@dataclass(frozen=True)
class Call:
    # A permit records which owner passed the local send gate.
    permits: tuple[int, ...] = ()
    # Each accepted permit can cause one outside effect with a known reply.
    effects: tuple[int, ...] = ()
    result: int = 0
    publications: int = 0


@dataclass(frozen=True)
class State:
    generation: int = 0
    selected: int = 0
    running: bool = True
    choice: int = -1
    calls: tuple[Call, Call] = (Call(), Call())


@dataclass(frozen=True)
class Step:
    name: str
    after: State
    actor: int = -1
    attempt: int = -1
    kind: str = "outside"


def put(state: State, attempt: int, call: Call) -> State:
    calls = list(state.calls)
    calls[attempt] = call
    return replace(state, calls=tuple(calls))


def steps(state: State, mode: str) -> Iterator[Step]:
    """Yield every state change within the stated bounds; omit self loops."""
    if state.generation == 0:
        selected = state.calls[state.selected]
        pending = bool(selected.permits) and selected.result == 0
        yield Step("takeover by owner 1", replace(
            state, generation=1, running=state.running and not pending
        ), actor=1, kind="takeover")

    for attempt, call in enumerate(state.calls):
        exists = attempt == 0 or state.choice == 1
        if not exists:
            continue
        # Effects may occur after takeover or after a new attempt is selected.
        # This models a request already admitted to the outside boundary.
        if len(call.effects) < len(call.permits):
            for result in (1, 2):
                yield Step(
                    f"provider effect for attempt {attempt}, reply {result}",
                    put(state, attempt, replace(call, effects=call.effects + (result,))),
                    attempt=attempt,
                )

        for actor in range(state.generation + 1):
            current = actor == state.generation or mode == "no-generation-check"
            if current and state.running and attempt == state.selected and call.result == 0:
                if not call.permits or (mode == "no-unsafe-guard" and len(call.permits) < 2):
                    yield Step(
                        f"owner {actor} gets send permit for attempt {attempt}",
                        put(state, attempt, replace(call, permits=call.permits + (actor,))),
                        actor, attempt, "send",
                    )
            # Only the owner of an admitted invocation can first save its reply.
            # A saved reply is then available to the current owner as evidence.
            for index, result in enumerate(call.effects):
                if actor != call.permits[index]:
                    continue
                if call.result == 0:
                    yield Step(
                        f"owner {actor} saves reply {result} for attempt {attempt}",
                        put(state, attempt, replace(call, result=result)),
                        actor, attempt, "evidence",
                    )
                # Equal saves are self loops. Different saves are refused.
            if current and state.running and attempt == state.selected and call.result != 0:
                limit = 2 if mode == "no-completion-marker" else 1
                if call.publications < limit:
                    yield Step(
                        f"owner {actor} publishes attempt {attempt}",
                        put(state, attempt, replace(call, publications=call.publications + 1)),
                        actor, attempt, "publish",
                    )

        if (attempt == state.selected and state.running
                and call.permits and call.result == 0):
            yield Step(
                f"reply wait ends with unknown result for attempt {attempt}",
                replace(state, running=False), attempt=attempt, kind="unknown",
            )

    # The finite model has one choice and at most two attempts. Choosing retry
    # with late evidence keeps attempt 0; without it, the choice creates 1.
    if not state.running and state.selected == 0 and state.choice == -1:
        for actor in range(state.generation + 1):
            if actor != state.generation and mode != "no-generation-check":
                continue
            selected = 0 if state.calls[0].result else 1
            yield Step(
                f"owner {actor} records retry choice selecting attempt {selected}",
                replace(state, selected=selected, choice=selected, running=True),
                actor, selected, "choice",
            )


PROPERTIES = (
    "P2_current_owner_controls_work",
    "P3_one_send_per_unsafe_attempt",
    "P3_later_send_has_prior_retry_choice",
    "P4_saved_evidence_does_not_change",
    "P5_one_completion_per_attempt",
    "P5_publication_is_current",
    "P5_publication_has_saved_evidence",
)


def violations(before: State, step: Step) -> tuple[str, ...]:
    """Check facts on each edge, apart from the guards that make that edge."""
    after = step.after
    failed = []
    if step.kind in {"send", "choice", "publish"} and step.actor != before.generation:
        failed.append("P2_current_owner_controls_work")
    if any(len(call.permits) > 1 for call in after.calls):
        failed.append("P3_one_send_per_unsafe_attempt")
    if after.calls[1].permits and before.choice != 1:
        failed.append("P3_later_send_has_prior_retry_choice")
    if any(old.result and new.result != old.result
           for old, new in zip(before.calls, after.calls)):
        failed.append("P4_saved_evidence_does_not_change")
    if any(call.publications > 1 for call in after.calls):
        failed.append("P5_one_completion_per_attempt")
    if step.kind == "publish":
        if step.actor != before.generation or step.attempt != before.selected or not before.running:
            failed.append("P5_publication_is_current")
        if before.calls[step.attempt].result == 0:
            failed.append("P5_publication_has_saved_evidence")
    return tuple(failed)


def path_to(state: State, parents: dict) -> list[str]:
    path = []
    while parents[state] is not None:
        state, action = parents[state]
        path.append(action)
    return list(reversed(path))


def explore(mode: str) -> dict:
    initial = State()
    queue = deque([initial])
    parents = {initial: None}
    depths = {initial: 0}
    first_failure = {}
    transitions = 0
    kinds = {}
    coverage = {
        "stale_owner_saves_evidence": False,
        "provider_effect_after_takeover": False,
        "late_reply_before_retry_reuses_attempt": False,
        "retry_before_late_reply_keeps_new_attempt": False,
        "two_effects_after_explicit_retry": False,
        "one_saved_reply_then_current_publication": False,
    }
    witnesses = {}

    def reach(name: str, state: State, step: Step) -> None:
        coverage[name] = True
        if name not in witnesses:
            witnesses[name] = path_to(state, parents) + [step.name]

    while queue:
        state = queue.popleft()
        for step in steps(state, mode):
            transitions += 1
            kinds[step.kind] = kinds.get(step.kind, 0) + 1
            for failure in violations(state, step):
                if failure not in first_failure:
                    trace = path_to(state, parents) + [step.name]
                    first_failure[failure] = {"length": len(trace), "trace": trace}
            after = step.after
            if step.kind == "evidence" and step.actor != state.generation:
                reach("stale_owner_saves_evidence", state, step)
            if step.kind == "outside" and state.generation == 1:
                call = state.calls[step.attempt]
                if call.permits[len(call.effects)] == 0:
                    reach("provider_effect_after_takeover", state, step)
            if step.kind == "choice" and after.selected == 0:
                reach("late_reply_before_retry_reuses_attempt", state, step)
            if step.kind == "evidence" and step.attempt == 0 and state.selected == 1:
                if after.selected == 1:
                    reach("retry_before_late_reply_keeps_new_attempt", state, step)
            if all(call.effects for call in after.calls) and after.choice == 1:
                reach("two_effects_after_explicit_retry", state, step)
            if step.kind == "publish" and state.calls[step.attempt].result:
                reach("one_saved_reply_then_current_publication", state, step)
            if after not in parents:
                parents[after] = (state, step.name)
                depths[after] = depths[state] + 1
                queue.append(after)
    return {
        "mode": mode,
        "search_complete_within_bounds": True,
        "termination": "queue empty; search continues after each found violation",
        "property_edge_checks": {name: transitions for name in PROPERTIES},
        "states": len(parents),
        "transitions": transitions,
        "max_shortest_path_depth": max(depths.values()),
        "state_changing_edges_by_kind": kinds,
        "properties_hold": not first_failure,
        "shortest_counterexamples": first_failure,
        "coverage": coverage,
        "coverage_witnesses": witnesses,
    }


def run(checks) -> dict:
    results = [explore(mode) for mode in (
        "proposed", "no-generation-check", "no-completion-marker", "no-unsafe-guard"
    )]
    base = results[0]
    checks.that("01 finite search keeps P2 through P5", base["properties_hold"])
    for name, reached in base["coverage"].items():
        checks.that(f"01 finite search reaches {name}", reached)
    expected = {
        "no-generation-check": {"P2_current_owner_controls_work", "P5_publication_is_current"},
        "no-completion-marker": {"P5_one_completion_per_attempt"},
        "no-unsafe-guard": {"P3_one_send_per_unsafe_attempt"},
    }
    for result in results[1:]:
        checks.equal(
            "01 guard removal has its expected failures: " + result["mode"],
            set(result["shortest_counterexamples"]), expected[result["mode"]],
        )
    return {
        "experiment": "bounded exhaustive unsafe-call model",
        "search": "breadth-first search of all reachable states within finite bounds",
        "bounds": {
            "logical_steps": 1,
            "owners": 2,
            "takeovers": 1,
            "attempts": 2,
            "recorded_retry_choices": 1,
            "send_permits_per_attempt": 2,
            "provider_effects_per_permit": 1,
            "reply_values": [1, 2],
            "publications_per_attempt": 2,
        },
        "results": results,
        "scope": [
            "The model separates send permission, provider effect, reply save, takeover, retry choice, and publication.",
            "Each permit can reach the provider once, before or after takeover. It can also remain undelivered in any trace prefix.",
            "Each provider effect returns one of two reply values. The reply can be delayed or left unsaved.",
            "P3 counts locally admitted send permits, not arbitrary provider effects. P5 checks the selected attempt when publication occurs, not only at the end.",
            "The provider is honest. In the proposed model, a single admitted invocation has one reply value; conflicting provider replies are not part of that model.",
            "P4 is checked on reachable edges under honest replies. Result replacement is refused by construction; this study has no P4 guard-removal experiment.",
            "A known result is saved only by the owner of that invocation. Saving evidence is separate from current publication.",
            "The search checks every generated edge. Equal replay and refused commands leave state unchanged and are omitted.",
            "Breadth-first traversal makes each reported trace shortest in state-changing model steps for that failed property.",
        ],
        "limitations": [
            "Finite reachability is not an unbounded proof and gives no timing, failure rate, or liveness result.",
            "One atomic model step stands for a locked database transaction. The search does not establish SQL isolation or product refinement.",
            "P1 command admission and P6 cancellation are not modeled. There is no outbox, event reader, model stream, keyed write, or access policy.",
            "The one-effect-per-permit bound assumes no hidden adapter retry or duplicate provider delivery. The model does not prove at-most-once business effects.",
            "There is no third owner, third attempt, second choice, or more than two duplicate sends or completion groups. Paths at those limits are outside the search.",
        ],
    }


if __name__ == "__main__":
    import json
    from support import Checks

    checks = Checks()
    result = run(checks)
    print(json.dumps({"checks": checks.count, **result}, indent=2, sort_keys=True))
