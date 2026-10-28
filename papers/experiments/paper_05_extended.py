"""Finite source graph and sampling checks. No model output is judged."""

from fractions import Fraction
from itertools import combinations, permutations, product


def run(checks):
    vertices = tuple(range(4))
    possible_edges = tuple(combinations(vertices, 2))
    graphs = []
    for bits in product((False, True), repeat=len(possible_edges)):
        parents = {node: set() for node in vertices}
        for keep, (source, child) in zip(bits, possible_edges):
            if keep:
                parents[child].add(source)
        graphs.append(parents)

    def closure(parents, invalid):
        blocked = set(invalid)
        while True:
            following = blocked | {node for node, sources in parents.items()
                                   if sources & blocked}
            if following == blocked:
                return blocked
            blocked = following

    def ancestors(parents, node):
        # A separate path walk is the reference for the batch update.
        reached = set()
        pending = list(parents[node])
        while pending:
            source = pending.pop()
            if source not in reached:
                reached.add(source)
                pending.extend(parents[source])
        return reached

    graph_cases = 0
    baseline_bad_cases = 0
    serialized_orders = 0
    for parents in graphs:
        for count in range(1, 5):
            for roots in combinations(vertices, count):
                invalid = set(roots)
                blocked = closure(parents, invalid)
                expected = {node for node in parents
                            if node in invalid or ancestors(parents, node) & invalid}
                checks.equal(f"05 graph closure {graph_cases}", blocked, expected)
                baseline_bad_cases += int(bool(expected - invalid))
                graph_cases += 1
                for source in vertices:
                    for order in permutations(("insert", "invalidate")):
                        state = {node: set(values) for node, values in parents.items()}
                        blocked_now = set()
                        for action in order:
                            if action == "insert":
                                if source not in blocked_now:
                                    state[4] = {source}
                            else:
                                blocked_now = closure(state, invalid)
                        for node in state.keys() - blocked_now:
                            checks.that(f"05 live graph after ordered writes {serialized_orders} {node}",
                                        not (ancestors(state, node) & invalid) and node not in invalid)
                        serialized_orders += 1

    race_rows = []
    for order in permutations(("scan", "insert", "commit")):
        if order.index("scan") > order.index("commit"):
            continue
        for guard in (False, True):
            parents = {0: set(), 1: {0}}
            version = 0
            captured_version = None
            captured_blocked = set()
            blocked = set()
            retries = 0
            for action in order:
                if action == "scan":
                    captured_version = version
                    captured_blocked = closure(parents, {0})
                elif action == "insert":
                    if 1 not in blocked:
                        parents[2] = {1}
                        version += 1
                else:
                    if guard and version != captured_version:
                        captured_blocked = closure(parents, {0})
                        retries += 1
                    blocked = captured_blocked
            bad = sorted(node for node in parents.keys() - blocked
                         if node == 0 or 0 in ancestors(parents, node))
            if guard:
                checks.equal(f"05 graph version closes insert race {order}", bad, [])
            race_rows.append({"order": order, "version_guard": guard,
                              "live_children_of_invalid_source": bad, "scan_retries": retries})
    checks.equal("05 unguarded graph update has one bad order",
                 sum(bool(row["live_children_of_invalid_source"]) for row in race_rows), 1)

    task_values = (0, 1, 2, 3)
    p = Fraction(1, 4)
    sampling_cases = 0
    sampling_rows = []
    for cue_bits in product((False, True), repeat=4):
        estimate_mean = Fraction(0)
        estimate_second = Fraction(0)
        selected_probability = [Fraction(0) for _ in vertices]
        mass = Fraction(0)
        for audit_bits in product((False, True), repeat=4):
            hits = sum(audit_bits)
            probability = p ** hits * (1 - p) ** (4 - hits)
            mass += probability
            estimate = sum((Fraction(task_values[index], 1) / p
                            for index in vertices if not cue_bits[index] and audit_bits[index]), Fraction(0))
            estimate_mean += probability * estimate
            estimate_second += probability * estimate * estimate
            for index in vertices:
                if cue_bits[index] or audit_bits[index]:
                    selected_probability[index] += probability
            sampling_cases += 1
        silent_total = sum(value for value, cue in zip(task_values, cue_bits) if not cue)
        expected_variance = sum(((1 - p) * value * value / p
                                 for value, cue in zip(task_values, cue_bits) if not cue), Fraction(0))
        checks.equal(f"05 audit mass {cue_bits}", mass, 1)
        checks.equal(f"05 silent count mean {cue_bits}", estimate_mean, silent_total)
        checks.equal(f"05 silent count variance {cue_bits}",
                     estimate_second - estimate_mean ** 2, expected_variance)
        for index in vertices:
            checks.equal(f"05 cue or audit inclusion {cue_bits} {index}",
                         selected_probability[index], Fraction(1) if cue_bits[index] else p)
        sampling_rows.append({"cue_mask": list(cue_bits), "silent_claim_count": silent_total,
                              "estimate_mean": str(estimate_mean), "estimate_variance": str(expected_variance)})
    return {
        "model": "bounded source graph and exact audit expectation",
        "vertices": 4, "forward_graphs": len(graphs), "graph_retraction_cases": graph_cases,
        "direct_only_invalidation_bad_cases": baseline_bad_cases,
        "serialized_insert_retract_orders": serialized_orders,
        "scan_insert_commit_orders": race_rows,
        "sampling_tasks": len(task_values), "audit_probability": str(p),
        "cue_audit_mask_pairs": sampling_cases, "sampling_rows": sampling_rows,
        "limits": [
            "All source links are recorded and all parents are needed. The model does not infer missing links.",
            "The graph order makes cycles absent. The source graph is small and stored in one transaction.",
            "The audit uses complete task labels, independent sampling, and fixed claim ownership.",
            "Adding audits adds work. These inclusion checks do not compare equal-cost task quality.",
        ],
    }
