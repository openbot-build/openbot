"""Finite scope and risk design checks. No learned judge is used."""

from itertools import product
from math import ceil, log


def run(checks, select):
    truth_cases = 0
    missing_deny_cases = 0
    unsafe_allows = 0
    witness = None
    for size in range(4):
        for truth in product(("allow", "deny", "irrelevant"), repeat=size):
            expected = "deny" if "deny" in truth else "allow" if "allow" in truth else "no_match"
            actual = select(tuple((label, 1.0) for label in truth))
            checks.equal(f"03 sound complete labels {truth_cases}", actual, expected)
            truth_cases += 1
            for missing, label in enumerate(truth):
                if label != "deny":
                    continue
                observed = tuple((value, 1.0) for index, value in enumerate(truth)
                                 if index != missing)
                predicted = select(observed)
                unsafe = predicted == "allow"
                missing_deny_cases += 1
                unsafe_allows += int(unsafe)
                if unsafe and witness is None:
                    witness = {"true_rule_labels": truth, "missing_rule_index": missing,
                               "observed_labels": [value for value, _ in observed],
                               "true_decision": expected, "selected_decision": predicted}
    checks.that("03 missing deny can cause a wrong allow", unsafe_allows > 0)

    # Recipient identity is not in this set. A child has a different recipient.
    contexts = tuple(product(("read", "send"), ("c1", "c2"),
                             ("team", "outside"), (0, 1)))
    grants = tuple(product(("read", "send"), (None, "c1", "c2"),
                           (None, "team", "outside"), (None, 1)))
    def matches(grant, context):
        capability, chat, arguments, expiry = grant
        used_capability, used_chat, used_arguments, now = context
        return (capability == used_capability and (chat is None or chat == used_chat)
                and (arguments is None or arguments == used_arguments)
                and (expiry is None or now < expiry))
    def narrower(child, parent):
        return (child[0] == parent[0]
                and (parent[1] is None or child[1] == parent[1])
                and (parent[2] is None or child[2] == parent[2])
                and (parent[3] is None or child[3] is not None and child[3] <= parent[3]))
    match_sets = [frozenset(index for index, context in enumerate(contexts)
                           if matches(grant, context)) for grant in grants]
    scope_cases = 0
    contained = 0
    for parent_index, parent in enumerate(grants):
        for child_index, child in enumerate(grants):
            actual = narrower(child, parent)
            expected = match_sets[child_index] <= match_sets[parent_index]
            checks.equal(f"03 finite child scope {scope_cases}", actual, expected)
            scope_cases += 1
            contained += int(expected)
    wide_child = ("send", None, None, None)
    narrow_parent = ("send", "c1", "team", 1)
    checks.that("03 scope removal is not attenuation", not narrower(wide_child, narrow_parent))

    # These values size a future study. They are not measured error rates.
    alpha, delta = 0.01, 0.05
    risk_rows = []
    for threshold_pairs in (1, 10, 100):
        per_test_delta = delta / (2 * threshold_pairs)
        n = ceil(log(per_test_delta) / log(1 - alpha))
        bound = 1 - per_test_delta ** (1 / n)
        previous_bound = 1 - per_test_delta ** (1 / (n - 1))
        checks.that(f"03 risk count is enough {threshold_pairs}", bound <= alpha)
        checks.that(f"03 risk count is the first enough {threshold_pairs}", previous_bound > alpha)
        risk_rows.append({"fixed_threshold_pairs": threshold_pairs,
                          "selected_cases_per_effect_with_zero_errors": n,
                          "one_sided_upper_risk": bound,
                          "per_test_delta": per_test_delta})
    return {
        "model": "finite truth, Grant scope, and future study size",
        "complete_truth_cases": truth_cases,
        "missing_deny_cases": missing_deny_cases,
        "missing_deny_wrong_allows": unsafe_allows,
        "missing_deny_witness": witness,
        "Grant_contexts": len(contexts), "Grants": len(grants),
        "parent_child_scope_pairs": scope_cases, "contained_scope_pairs": contained,
        "risk_target": alpha, "family_error_limit": delta,
        "zero_error_study_sizes": risk_rows,
        "limits": [
            "Labels are given by the fixture. This does not test semantic support or score quality.",
            "Scope sets do not test grant lineage, live revocation, or a shared one-call budget.",
            "The risk bound assumes independent selected cases at each fixed threshold and stable use data.",
        ],
    }
