"""Finite task-close model. This model does not run OpenBot."""

from dataclasses import dataclass, replace
from itertools import permutations
from math import factorial


@dataclass(frozen=True)
class Rules:
    name: str
    accept_before_retire: bool = True
    check_v: bool = True
    check_w: bool = True


@dataclass(frozen=True)
class State:
    # Input IDs are stable. The outside child owes result-1 from the start.
    required: frozenset[str] = frozenset({"result-1"})
    accepted: frozenset[str] = frozenset()
    used: frozenset[str] = frozenset()
    open_children: frozenset[str] = frozenset({"child-1"})
    v: int = 0
    w: int = 0
    obligation_read: tuple[int, bool] | None = None
    context_read: tuple[int, bool] | None = None
    closed: bool = False


def truth(state: State) -> bool:
    """Read live obligations and input IDs, apart from the close protocol."""
    return not state.open_children and state.required <= state.used


def step(state: State, action: str, rules: Rules) -> tuple[State, str]:
    if state.closed:
        return state, "closed no-op"
    if action == "accept":
        return replace(state, accepted=state.accepted | {"result-1"}, v=state.v + 1), "done"
    if action == "retire":
        if rules.accept_before_retire and "result-1" not in state.accepted:
            return state, "order no-op"
        return replace(state, open_children=state.open_children - {"child-1"}, w=state.w + 1), "done"
    if action == "incorporate":
        if "result-1" not in state.accepted:
            return state, "order no-op"
        return replace(state, used=state.accepted, v=state.v + 1), "done"
    if action == "correction":
        return replace(
            state,
            required=state.required | {"correction-1"},
            accepted=state.accepted | {"correction-1"},
            v=state.v + 1,
        ), "done"
    if action == "spawn":
        return replace(
            state,
            required=state.required | {"result-2"},
            open_children=state.open_children | {"child-2"},
            w=state.w + 1,
        ), "done"
    if action == "read_obligations":
        return replace(state, obligation_read=(state.w, not state.open_children)), "done"
    if action == "read_context":
        if state.obligation_read is None:
            return state, "order no-op"
        return replace(state, context_read=(state.v, state.accepted <= state.used)), "done"
    if action == "commit":
        if state.obligation_read is None or state.context_read is None:
            return state, "order no-op"
        read_w, no_children = state.obligation_read
        read_v, no_pending_input = state.context_read
        if not no_children or not no_pending_input:
            return state, "busy no-op"
        if rules.check_v and state.v != read_v:
            return state, "v guard no-op"
        if rules.check_w and state.w != read_w:
            return state, "w guard no-op"
        return replace(state, closed=True), "done"
    raise ValueError("Unknown model action")


def snapshot(state: State) -> dict:
    return {
        "required_input_ids": sorted(state.required),
        "accepted_input_ids": sorted(state.accepted),
        "used_input_ids": sorted(state.used),
        "open_child_ids": sorted(state.open_children),
        "pending_input_ids": sorted(state.accepted - state.used),
        "missing_required_input_ids": sorted(state.required - state.used),
        "v": state.v,
        "w": state.w,
        "obligation_read": state.obligation_read,
        "context_read": state.context_read,
        "closed": state.closed,
        "live_completion_truth": truth(state),
    }


def trace(order: tuple[str, ...], rules: Rules) -> dict:
    state = State()
    states = [{"action": "start", "state": snapshot(state)}]
    for action in order:
        state, outcome = step(state, action, rules)
        states.append({"action": action, "outcome": outcome, "state": snapshot(state)})
    return {"order": order, "steps": states}


def explore(checks, actions: tuple[str, ...], rules: Rules) -> dict:
    counts = {
        "schedule_attempts": 0,
        "action_attempts": 0,
        "prefix_checks": 0,
        "successful_closes": 0,
        "true_closes": 0,
        "false_closes": 0,
        "no_close": 0,
        "order_no_ops": 0,
        "closed_no_ops": 0,
        "busy_no_ops": 0,
        "v_guard_no_ops": 0,
        "w_guard_no_ops": 0,
    }
    first_false = None
    first_true = None
    for order in permutations(actions):
        state = State()
        counts["schedule_attempts"] += 1
        for action in order:
            before = state
            state, outcome = step(state, action, rules)
            counts["action_attempts"] += 1
            counts["prefix_checks"] += 1
            checks.that("04 model input sets stay in order", state.used <= state.accepted <= state.required)
            checks.that("04 model counters never fall", state.v >= before.v and state.w >= before.w)
            if before.closed:
                checks.equal("04 closed model state does not change", state, before)
            if rules.name == "proposed":
                checks.that("04 proposed close has all real end facts", not state.closed or truth(state))
            if outcome != "done":
                key = outcome.replace(" ", "_").replace("no-op", "no_ops")
                counts[key] += 1
        if state.closed:
            counts["successful_closes"] += 1
            if truth(state):
                counts["true_closes"] += 1
                if first_true is None:
                    first_true = order
            else:
                counts["false_closes"] += 1
                if first_false is None:
                    first_false = order
        else:
            counts["no_close"] += 1
    checks.equal("04 all action orders are tried", counts["schedule_attempts"], factorial(len(actions)))
    checks.equal("04 every action prefix is checked", counts["prefix_checks"], factorial(len(actions)) * len(actions))
    checks.equal("04 close counts agree", counts["successful_closes"], counts["true_closes"] + counts["false_closes"])
    checks.equal("04 end state counts agree", counts["schedule_attempts"], counts["successful_closes"] + counts["no_close"])
    checks.that("04 some schedules close", counts["successful_closes"] > 0)
    return {
        "rules": rules.name,
        **counts,
        "first_true_close": trace(first_true, rules) if first_true else None,
        "first_false_close": trace(first_false, rules) if first_false else None,
    }


def run(checks) -> dict:
    """Check every order in three small, fixed action sets."""
    initial_checks = checks.count
    base = ("accept", "retire", "incorporate", "read_obligations", "read_context", "commit")
    cases = {
        "handoff": base,
        "one_correction": base + ("correction",),
        "one_new_child": base + ("spawn",),
    }
    rules = (
        Rules("proposed"),
        Rules("early_retire", accept_before_retire=False),
        Rules("without_v_guard", check_v=False),
        Rules("without_w_guard", check_w=False),
        Rules("without_both_guards", check_v=False, check_w=False),
    )
    rows = []
    for case, actions in cases.items():
        for rule in rules:
            rows.append({"case": case, **explore(checks, actions, rule)})
    by_case = {(row["case"], row["rules"]): row for row in rows}
    for case in cases:
        checks.equal("04 proposed has no false close", by_case[case, "proposed"]["false_closes"], 0)
    checks.that("04 early retire has an actual bad close", by_case["handoff", "early_retire"]["false_closes"] > 0)
    checks.that("04 correction needs v guard", by_case["one_correction", "without_v_guard"]["false_closes"] > 0)
    checks.that("04 new child needs w guard", by_case["one_new_child", "without_w_guard"]["false_closes"] > 0)
    checks.that("04 removing both guards has an actual bad close", by_case["one_correction", "without_both_guards"]["false_closes"] > 0)
    checks.equal("04 v guard keeps correction visible", by_case["one_correction", "without_w_guard"]["false_closes"], 0)
    checks.equal("04 w guard keeps new child visible", by_case["one_new_child", "without_v_guard"]["false_closes"], 0)

    # These two orders place a new fact strictly after the full candidate read.
    correction_order = base[:-1] + ("correction", "commit")
    child_order = base[:-1] + ("spawn", "commit")
    races = []
    for case, order, rule in (
        ("correction_after_candidate", correction_order, rules[2]),
        ("child_after_candidate", child_order, rules[3]),
    ):
        guarded = trace(order, rules[0])
        missing_guard = trace(order, rule)
        checks.that("04 race guarded commit is refused", not guarded["steps"][-1]["state"]["closed"])
        checks.that("04 race missing guard closes", missing_guard["steps"][-1]["state"]["closed"])
        checks.that("04 race missing guard close is false", not missing_guard["steps"][-1]["state"]["live_completion_truth"])
        races.append({"case": case, "proposed": guarded, rule.name: missing_guard})
    return {
        "model": "Finite operational task-close model",
        "checks": checks.count - initial_checks,
        "schedule_attempts": sum(row["schedule_attempts"] for row in rows),
        "action_attempts": sum(row["action_attempts"] for row in rows),
        "prefix_checks": sum(row["prefix_checks"] for row in rows),
        "rows": rows,
        "candidate_commit_races": races,
        "semantics": [
            "Each action ID occurs once. All orders are attempted; an action with unmet order rules is a no-op.",
            "Pause, active-work, and terminal-record flags stay in a state that permits closure. Input use stands for an activation that has ended.",
            "The child owes result-1 at the start. The close oracle checks live open children and all required input IDs.",
            "Read obligations saves w and the open-child test. Read context then saves v and the pending-input test.",
            "Commit tests the saved facts and the enabled version guards. It does not repeat the live oracle.",
            "Accept and input use change v. Retire and child creation change w. The child result is accepted before safe retirement.",
            "An accepted correction is an added required input. A new child adds both an open obligation and a required result.",
            "Closure freezes this round. Later attempted actions are no-ops; a real later input would need a new round.",
            "A successful close means the commit took effect. The separate true and false counts say whether that close was sound.",
        ],
        "limitations": [
            "This is a finite abstract model. It does not run OpenBot or test database locks, network loss, or real threads.",
            "The search does not test pause, recovery, or fencing. Fencing means refusing a write from an old work owner.",
            "The search has one child handoff and at most one added correction or child. It is not a proof for unbounded task trees.",
            "No-op attempts are not retried. No-close counts therefore do not measure deadlock, fairness, or time to completion.",
            "Counts are exact for these action sets. They are not event rates or a probability model of real schedules.",
        ],
    }
