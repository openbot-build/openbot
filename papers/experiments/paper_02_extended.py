"""Finite authority checks. This does not run the service."""

from itertools import combinations, product


def run(checks):
    resources = frozenset({"X", "Y", "Z"})
    rights = tuple(frozenset(items) for size in range(4)
                   for items in combinations(sorted(resources), size))
    limit_cases = 0
    for limits in product(rights, repeat=4):
        result = resources.intersection(*limits)
        for resource in resources:
            checks.equal(f"02 all limits {limit_cases} {resource}",
                         resource in result,
                         all(resource in limit for limit in limits))
        for limit in limits:
            checks.that(f"02 no extra rights {limit_cases}", result <= limit)
        limit_cases += 1

    policy_cases = 0
    safe_final = 0
    leaf_accepted = 0
    conservative_refusals = 0
    for writer, positive, denied in product(rights, repeat=3):
        final = positive - denied
        leaf_pass = positive <= writer
        final_pass = final <= writer
        checks.that(f"02 positive guard is sound {policy_cases}",
                    not leaf_pass or final_pass)
        safe_final += int(final_pass)
        leaf_accepted += int(leaf_pass)
        conservative_refusals += int(final_pass and not leaf_pass)
        policy_cases += 1

    schedules = []
    for revoke_at in range(4):
        order = ["read", "admit", "send"]
        order.insert(revoke_at, "revoke")
        for policy in ("separate_read_and_admit", "atomic_authority_oracle", "epoch_at_admit"):
            version = 0
            live = True
            read_version = None
            read_allowed = False
            admitted = False
            invalid_admission = False
            sent_after_revoke = False
            for action in order:
                if action == "read":
                    read_version, read_allowed = version, live
                elif action == "revoke":
                    version += 1
                    live = False
                elif action == "admit":
                    if policy == "separate_read_and_admit":
                        admitted = read_allowed
                    elif policy == "atomic_authority_oracle":
                        admitted = live
                    else:
                        admitted = read_allowed and read_version == version
                    invalid_admission = admitted and not live
                elif admitted:
                    sent_after_revoke = not live
            if policy != "separate_read_and_admit":
                checks.that(f"02 current admission {order} {policy}", not invalid_admission)
            schedules.append({"order": order, "policy": policy,
                              "admitted": admitted,
                              "invalid_admission": invalid_admission,
                              "send_after_revoke": sent_after_revoke})
    checks.equal("02 stale read has one bad order",
                 sum(row["invalid_admission"] for row in schedules), 1)
    checks.equal("02 admitted request can arrive after revoke",
                 sum(row["send_after_revoke"] for row in schedules
                     if row["policy"] == "epoch_at_admit"), 1)

    # A policy clock can change truth without changing a stored policy version.
    permit = {"version": 3, "generation": 4, "action": "read:X", "expires": 10}
    def claim(version=3, generation=4, action="read:X", now=9):
        return (version == permit["version"] and generation == permit["generation"]
                and action == permit["action"] and now < permit["expires"])
    checks.that("02 unchanged permit before expiry", claim())
    checks.that("02 expiry requires a clock check", not claim(now=10))
    checks.that("02 action binding blocks another action", not claim(action="write:X"))
    checks.that("02 generation binding blocks old owner", not claim(generation=5))
    checks.that("02 version binding blocks old policy", not claim(version=4))
    return {
        "model": "bounded authority and admission comparison",
        "resource_count": 3, "four_limit_cases": limit_cases,
        "policy_leaf_cases": policy_cases,
        "safe_final_policy_cases": safe_final,
        "positive_leaf_accepted_cases": leaf_accepted,
        "safe_final_but_leaf_refused_cases": conservative_refusals,
        "revocation_schedules": schedules,
        "permit_checks": ["policy version", "owner generation", "action", "expiry"],
        "bound": "Three resources, four limits, one positive and one negative leaf; four revoke orders.",
        "limit": "Admission is the local guarded point. A later revoke cannot recall a prior send permit.",
    }
