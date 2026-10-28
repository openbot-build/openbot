"""State traces for protocol effects and model-call budgets."""

import random
from copy import deepcopy
from itertools import permutations, product
from dataclasses import dataclass, field

from support import Checks


@dataclass
class Notes:
    """The note part of paper 11, including its two faulty methods."""

    fault: str = "none"
    revision: int = 0
    notes: dict = field(default_factory=dict)
    receipts: dict = field(default_factory=dict)

    def view(self):
        return self.revision, tuple(sorted(self.notes.items()))

    def write(self, key, text):
        if key in self.receipts:
            old_text, receipt = self.receipts[key]
            if old_text != text and self.fault != "key_conflict":
                return "KeyConflict"
            if self.fault == "hidden_write":
                self.revision += 1
                self.notes[self.revision] = text
            return receipt
        if len(self.notes) >= 2 and self.fault != "capacity":
            return "Full"
        self.revision += 1
        self.notes[self.revision] = text
        receipt = self.view()
        self.receipts[key] = (text, receipt)
        return receipt

    def delete(self, note, expected):
        if self.revision != expected and self.fault != "stale_delete":
            return "RevisionConflict"
        if note in self.notes:
            del self.notes[note]
            self.revision += 1
            if self.fault == "lost_receipt":
                self.receipts = {
                    key: row
                    for key, row in self.receipts.items()
                    if all(item[0] != note for item in row[1][1])
                }
        return self.view()


@dataclass
class Once:
    """A grant code or input handle with a binding and an expiry tick."""

    binding: tuple
    deadline: int
    used: bool = False

    def use(self, binding, tick):
        if self.used or binding != self.binding or tick >= self.deadline:
            return "Rejected"
        self.used = True
        return "Complete"



def note_reference(trace):
    """Fold successful events, with receipts stored apart from live notes."""
    events = []
    replies = []
    receipts = {}
    for step in trace:
        live = {}
        for revision, event in enumerate(events, 1):
            if event[0] == "add":
                live[revision] = event[1]
            else:
                live.pop(event[1])
        view = (len(events), tuple(sorted(live.items())))
        if step[0] == "read":
            reply = view
        elif step[0] == "delete":
            _, note, expected = step
            if expected != len(events):
                reply = "RevisionConflict"
            elif note not in live:
                reply = view
            else:
                events.append(("remove", note))
                live.pop(note)
                reply = (len(events), tuple(sorted(live.items())))
        else:
            _, key, text = step
            if key in receipts:
                original, receipt = receipts[key]
                reply = receipt if text == original else "KeyConflict"
            elif len(live) == 2:
                reply = "Full"
            else:
                events.append(("add", text))
                live[len(events)] = text
                reply = (len(events), tuple(sorted(live.items())))
                receipts[key] = text, reply
        replies.append(reply)
    live = {}
    for revision, event in enumerate(events, 1):
        if event[0] == "add":
            live[revision] = event[1]
        else:
            live.pop(event[1])
    return replies, (len(events), tuple(sorted(live.items())))


def run_notes(trace, fault="none"):
    target = Notes(fault)
    replies = []
    for step in trace:
        if step[0] == "read":
            replies.append(target.view())
        elif step[0] == "write":
            replies.append(target.write(*step[1:]))
        else:
            replies.append(target.delete(*step[1:]))
    return replies, target.view()


def protocol_exhaustive(checks):
    """Check every word of length at most four in one fixed alphabet."""
    alphabet = (
        ("write", "k0", "a"), ("write", "k0", "b"),
        ("write", "k1", "b"), ("write", "k2", "a"),
        ("delete", 1, 1), ("delete", 1, 0), ("read",),
    )
    faults = ("lost_receipt", "hidden_write", "key_conflict", "capacity", "stale_delete")
    result = {fault: dict(reply_traces=0, effect_traces=0, combined_traces=0, shortest=None) for fault in faults}
    trace_count = request_count = 0
    for length in range(5):
        for trace in product(alphabet, repeat=length):
            trace_count += 1
            request_count += length
            expected = note_reference(trace)
            checks.equal("event-fold oracle agrees on bounded trace", run_notes(trace), expected)
            # Rename keys and text together. Observations keep their structure.
            renamed = tuple((step[0], "renamed-" + step[1], step[2].translate(str.maketrans("ab", "ba"))) if step[0] == "write" else step for step in trace)
            def swap_text(value):
                if isinstance(value, tuple):
                    return tuple(swap_text(item) for item in value)
                if isinstance(value, list):
                    return [swap_text(item) for item in value]
                return {"a": "b", "b": "a"}.get(value, value)
            checks.equal("symbolic renaming keeps observation structure", run_notes(renamed), swap_text(expected))
            for fault in faults:
                observed = run_notes(trace, fault)
                reply_bad, effect_bad = observed[0] != expected[0], observed[1] != expected[1]
                row = result[fault]
                row["reply_traces"] += reply_bad
                row["effect_traces"] += effect_bad
                row["combined_traces"] += reply_bad or effect_bad
                if row["shortest"] is None and (reply_bad or effect_bad):
                    row["shortest"] = trace
    for fault, row in result.items():
        checks.that("every defined mutant has a witness: " + fault, row["combined_traces"] > 0)
    checks.that("read-back adds hidden-effect traces", result["hidden_write"]["combined_traces"] > result["hidden_write"]["reply_traces"])

    # Effects after reply loss are a set until a completion barrier and read.
    before = (0, ())
    after = (1, ((1, "a"),))
    belief = {before, after}
    checks.equal("response loss keeps both possible states", len(belief), 2)
    checks.equal("completed read resolves the effect", belief.intersection({after}), {after})
    checks.equal("impossible read fails the model", belief.intersection({(2, ())}), set())

    # The last read is the fixed witness. A dependency records each producer.
    trace = (
        ("write", "k0", "a"), ("read",), ("delete", 1, 1),
        ("read",), ("write", "k0", "a"), ("read",),
    )
    dependencies = {2: {0}, 4: {0}, 5: {4}}
    keep = list(range(len(trace)))
    attempts = 0
    def same_failure(indices):
        if 5 not in indices:
            return False
        if any(not needed.issubset(indices) for index, needed in dependencies.items() if index in indices):
            return False
        selected = tuple(trace[index] for index in indices)
        expected = note_reference(selected)
        observed = run_notes(selected, "lost_receipt")
        return observed[1] != expected[1]
    changed = True
    while changed:
        changed = False
        for index in tuple(keep):
            attempts += 1
            candidate = [item for item in keep if item != index]
            if same_failure(candidate):
                keep = candidate
                changed = True
                break
    checks.equal("reducer keeps setup trigger and witness", keep, [0, 2, 4, 5])
    checks.that("reduced trace keeps the same effect failure", same_failure(keep))
    checks.that("all allowed single removals lose the failure", all(not same_failure([item for item in keep if item != index]) for index in keep))
    return dict(alphabet_size=len(alphabet), max_length=4, traces=trace_count, operation_steps=request_count, final_state_observations=trace_count,
                mutation_ablation=result, response_loss_states=2,
                reducer=dict(original_steps=len(trace), final_steps=len(keep), attempts=attempts, one_step_minimal=True))


def protocol(seed_count):
    checks = Checks()
    exhaustive = protocol_exhaustive(checks)
    outcomes = {}
    for fault in ("none", "lost_receipt", "hidden_write"):
        model = Notes(fault)
        first = model.write("k0", "a")
        checks.equal(f"{fault}: first receipt", first, (1, ((1, "a"),)))
        checks.equal(f"{fault}: delete", model.delete(1, 1), (2, ()))
        replay = model.write("k0", "a")
        outcomes[fault] = {"reply": replay, "view": model.view()}
    checks.equal("receipt survives delete", outcomes["none"]["reply"], (1, ((1, "a"),)))
    checks.equal("replay has no write", outcomes["none"]["view"], (2, ()))
    checks.equal("lost receipt adds a note", outcomes["lost_receipt"]["view"], (3, ((3, "a"),)))
    checks.equal("hidden write passes reply check", outcomes["hidden_write"]["reply"], outcomes["none"]["reply"])
    checks.equal("read finds hidden write", outcomes["hidden_write"]["view"], (3, ((3, "a"),)))

    full = Notes()
    full.write("k0", "a")
    full.write("k1", "b")
    checks.equal("third key reaches capacity", full.write("k2", "a"), "Full")
    checks.equal("capacity keeps state", full.view(), (2, ((1, "a"), (2, "b"))))
    checks.equal("key is checked before capacity", full.write("k0", "b"), "KeyConflict")
    checks.equal("saved receipt before capacity", full.write("k0", "a"), (1, ((1, "a"),)))

    for deadline in (10, 20, 60):
        for tick in (deadline - 1, deadline, deadline + 1):
            handle = Once(("a", "r0", "ask-label", "a"), deadline)
            checks.equal("wrong binding rejected", handle.use(("b", "r0", "ask-label", "a"), tick), "Rejected")
            checks.equal("wrong binding keeps handle", handle.used, False)
            expected = "Complete" if tick == deadline - 1 else "Rejected"
            checks.equal("expiry boundary", handle.use(handle.binding, tick), expected)
            checks.equal("no second use", handle.use(handle.binding, tick), "Rejected")

    state_steps = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        model = Notes()
        # This oracle stores successful commands and receipts, not model state.
        saved = {}
        known_notes = {}
        revision = 0
        for _ in range(100):
            state_steps += 1
            key, text = rng.choice(("k0", "k1", "k2")), rng.choice(("a", "b", "ab"))
            if rng.randrange(3) != 0:
                before = model.view()
                reply = model.write(key, text)
                if key in saved:
                    old_text, old_reply = saved[key]
                    checks.equal("known key reply", reply, old_reply if text == old_text else "KeyConflict")
                    checks.equal("known key keeps current view", model.view(), before)
                elif len(known_notes) == 2:
                    checks.equal("full workspace reply", reply, "Full")
                    checks.equal("full workspace keeps view", model.view(), before)
                else:
                    revision += 1
                    known_notes[revision] = text
                    expected = (revision, tuple(sorted(known_notes.items())))
                    checks.equal("new write view", reply, expected)
                    saved[key] = text, expected
            else:
                note = rng.randrange(1, revision + 3)
                expected_revision = revision if rng.randrange(2) else revision - 1
                reply = model.delete(note, expected_revision)
                if expected_revision != revision:
                    checks.equal("stale delete rejected", reply, "RevisionConflict")
                else:
                    if note in known_notes:
                        del known_notes[note]
                        revision += 1
                    checks.equal("valid delete returns current view", reply, (revision, tuple(sorted(known_notes.items()))))
            checks.equal("command trace state", model.view(), (revision, tuple(sorted(known_notes.items()))))

    return {
        "paper_id": "11",
        "title": "State-Based Conformance Testing for Agent Tool Protocols",
        "checks": checks.count,
        "seeds": seed_count,
        "observations": [
            {"receipt_trace": outcomes},
            {"bounded_protocol_campaign": exhaustive},
            {"seeded_state_steps": state_steps, "capacity_keys": 3, "expiry_deadlines": [10, 20, 60]},
        ],
        "limitations": [
            "This is the note and one-use handle model, not an MCP server or wire test.",
            "OAuth exchange, real concurrent consumption, network search and independent target comparisons are not run.",
            "Exhaustive coverage is only all words through length four in seven note operations. It does not cover the full paper alphabet.",
            "The reducer checks one receipt-loss trace and single-step minimality, not globally shortest traces.",
            "The planned 10,000-request, 30-seed study and defect-rate comparison remain open.",
        ],
    }


@dataclass
class Ledger:
    """Atomic model events; hold room is separate from known cost."""

    caps: dict
    retain_unknown: bool = True
    calls: dict = field(default_factory=dict)

    def exposure(self, scope):
        total = 0
        for row in self.calls.values():
            if scope in row["scopes"]:
                total += row["cost"] if row["status"] == "confirmed" else row["hold"]
        return total

    def admit(self, key, hold, scopes):
        if key in self.calls:
            row = self.calls[key]
            if row["original_hold"] != hold or row["scopes"] != scopes:
                raise ValueError("The call key has other input.")
            return True
        if any(self.exposure(scope) + hold > self.caps[scope] for scope in scopes):
            return False
        self.calls[key] = dict(original_hold=hold, hold=hold, scopes=scopes, status="active", cost=None)
        return True

    def unknown(self, key):
        row = self.calls[key]
        if row["status"] != "confirmed":
            row["status"] = "unknown"
            if not self.retain_unknown:
                row["hold"] = 0

    def settle(self, key, cost):
        row = self.calls[key]
        if row["status"] == "confirmed" and row["cost"] != cost:
            raise ValueError("The call has other known cost.")
        row["status"] = "confirmed"
        row["cost"] = cost



def budget_exhaustive(checks, seed_count):
    """Enumerate legal event orders; test errors outside the strict premise."""
    events = tuple((key, kind) for key in ("a", "b") for kind in ("admit", "unknown", "settle"))
    orders = tuple(order for order in permutations(events)
                   if all(order.index((key, "admit")) < order.index((key, "unknown")) < order.index((key, "settle")) for key in ("a", "b")))
    checks.equal("all two-call event orders", len(orders), 20)
    results = {}
    for retain in (False, True):
        row = dict(cases=0, strict_cases=0, strict_excess_cases=0, max_exposure=0, max_final_cost=0)
        for cost_a, cost_b in product(range(5), repeat=2):
            costs = dict(a=cost_a, b=cost_b)
            for order in orders:
                row["cases"] += 1
                strict = max(costs.values()) <= 2
                row["strict_cases"] += strict
                ledger = Ledger({"org": 3, "a": 3, "b": 3}, retain)
                violated = False
                for key, kind in order:
                    if kind == "admit":
                        ledger.admit(key, 2, ("org", key))
                    elif key in ledger.calls:
                        if kind == "unknown":
                            before = ledger.exposure("org")
                            ledger.unknown(key)
                            ledger.unknown(key)
                            if retain:
                                checks.equal("repeated unknown keeps exposure", ledger.exposure("org"), before)
                        else:
                            ledger.settle(key, costs[key])
                            snapshot = deepcopy(ledger.calls)
                            ledger.settle(key, costs[key])
                            checks.equal("repeated settlement keeps all rows", ledger.calls, snapshot)
                    for scope, cap in ledger.caps.items():
                        exposure = ledger.exposure(scope)
                        row["max_exposure"] = max(row["max_exposure"], exposure)
                        liability = sum(costs[call] for call, item in ledger.calls.items() if scope in item["scopes"])
                        violated |= exposure > cap or liability > cap
                        if retain:
                            settled_excess = sum(max(0, costs[call] - 2) for call, item in ledger.calls.items() if scope in item["scopes"] and item["status"] == "confirmed")
                            unknown_excess = sum(max(0, costs[call] - 2) for call, item in ledger.calls.items() if scope in item["scopes"] and item["status"] != "confirmed")
                            checks.that("settled excess bounds exposure", exposure <= cap + settled_excess)
                            checks.that("unsettled excess bounds hidden liability", liability <= exposure + unknown_excess)
                            if strict:
                                checks.that("strict bound holds at every event", liability <= exposure <= cap)
                if strict and violated:
                    row["strict_excess_cases"] += 1
                final = sum(costs[key] for key in ledger.calls)
                checks.equal("all admitted charges are conserved", ledger.exposure("org"), final)
                row["max_final_cost"] = max(row["max_final_cost"], final)
        results["retained" if retain else "released"] = row
    checks.equal("retained strict cases never exceed cap", results["retained"]["strict_excess_cases"], 0)
    checks.that("release has strict counterexamples", results["released"]["strict_excess_cases"] > 0)

    # An upgrade can recover the saved hold, but cannot remove old debt.
    old = Ledger({"org": 1000}, False)
    old.admit("old", 1000, ("org",))
    old.unknown("old")
    legacy = {}
    for restore in (False, True):
        ledger = deepcopy(old)
        ledger.retain_unknown = True
        if restore:
            ledger.calls["old"]["hold"] = ledger.calls["old"]["original_hold"]
        admitted = ledger.admit("new", 1000, ("org",))
        if admitted:
            ledger.settle("new", 1000)
        ledger.settle("old", 1000)
        legacy["restore_saved_hold" if restore else "new_calls_only"] = dict(new_call_admitted=admitted, final_cost=ledger.exposure("org"))
    checks.equal("changing only new calls leaves old gap", legacy["new_calls_only"]["final_cost"], 2000)
    checks.equal("restore old bound blocks new charge", legacy["restore_saved_hold"]["final_cost"], 1000)
    def start_strict(caps, old_calls):
        ledger = Ledger(caps)
        for key, item in old_calls.items():
            if item["upper_bound"] is None or not item["bound_validated"]:
                return None
            if not ledger.admit(key, item["upper_bound"], item["scopes"]):
                return None
            ledger.unknown(key)
        return ledger
    old_rows = {"old": dict(upper_bound=1000, bound_validated=True, scopes=("org",))}
    resumed = start_strict({"org": 1000}, old_rows)
    checks.that("known old bound starts strict accounting", resumed is not None)
    checks.equal("old call consumes restored strict room", resumed.admit("new", 1, ("org",)), False)
    for bound, validated in ((None, False), (1000, False), (1001, True)):
        old_rows["old"].update(upper_bound=bound, bound_validated=validated)
        checks.equal("missing weak or excessive old bound blocks strict start", start_strict({"org": 1000}, old_rows), None)

    # Five billed classes use one saved schedule and whole-call input tiers.
    schedule = {"version": 1, "tiers": ((5, (1000001, 500001, 2000001, 4000001, 8000001)), (None, (2000001, 1000001, 3000001, 6000001, 10000001)))}
    saved = deepcopy(schedule)
    def price(counts, prices):
        input_total = sum(counts[:3])
        rates = next(rates for ceiling, rates in prices["tiers"] if ceiling is None or input_total <= ceiling)
        return (sum(count * rate for count, rate in zip(counts, rates)) + 999999) // 1000000
    vectors = tuple(product(range(4), repeat=5))
    upper_hold = max(price(counts, saved) for counts in vectors)
    for counts in vectors:
        checks.that("full price envelope bounds each billed vector", price(counts, saved) <= upper_hold)
    schedule["version"] = 2
    schedule["tiers"] = ((None, (9000001,) * 5),)
    checks.equal("late receipt keeps saved five-rate price", saved["version"], 1)
    checks.that("new prices do not rewrite old schedule", price((3,) * 5, schedule) != price((3,) * 5, saved))

    def serve_visit(deficit, head, following, free_limit):
        spent = accepted = free = 0
        while head <= deficit:
            if head == 0:
                if free == free_limit:
                    break
                free += 1
            deficit -= head
            spent += head
            accepted += 1
            head = following()
        return spent, deficit, head, accepted

    zero_visit = serve_visit(10, 0, lambda: 0, 3)
    checks.equal("zero-cost stream ends its visit", zero_visit, (0, 10, 0, 3))
    checks.equal("zero-cost work with no allowance moves on", serve_visit(10, 0, lambda: 0, 0), (0, 10, 0, 0))

    # A real deficit loop tests the stated restricted sharing identity.
    fairness_rounds = 0
    maximum_normalized_gap = 0.0
    for seed in range(seed_count):
        rng = random.Random(seed + 10000)
        weights = (1, 2, 3)
        deficits = [0, 0, 0]
        service = [0, 0, 0]
        next_holds = [rng.randrange(1, 11) for _ in weights]
        for turn in range(1, 41):
            fairness_rounds += 1
            for index, weight in enumerate(weights):
                deficits[index] += 10 * weight
                spent, deficits[index], next_holds[index], _ = serve_visit(
                    deficits[index], next_holds[index], lambda: rng.randrange(1, 11), 3)
                service[index] += spent
                checks.equal("round identity preserves money", service[index], turn * 10 * weight - deficits[index])
                checks.that("remaining deficit is below max hold", 0 <= deficits[index] < 10)
            for left, right in ((0, 1), (0, 2), (1, 2)):
                gap = abs(service[left] / weights[left] - service[right] / weights[right])
                maximum_normalized_gap = max(maximum_normalized_gap, gap)
                checks.that("weighted share bound holds", gap < 10 / weights[left] + 10 / weights[right])
    return dict(event_orders=len(orders), cost_pairs=25, hold=2, cap=3, policy_results=results,
                legacy_exposure=legacy, missing_old_bound="strict admission unavailable",
                five_class_price_vectors=len(vectors), five_class_upper_hold=upper_hold,
                fairness_rounds=fairness_rounds, maximum_normalized_share_gap=maximum_normalized_gap,
                zero_cost_visit=dict(limit=3, admitted=zero_visit[3], remaining_deficit=zero_visit[1]))


def budget(seed_count):
    checks = Checks()
    exhaustive = budget_exhaustive(checks, seed_count)
    examples = {}
    for retain in (False, True):
        ledger = Ledger({"org": 1000}, retain)
        checks.that("first call admitted", ledger.admit("a", 1000, ("org",)))
        ledger.unknown("a")
        second = ledger.admit("b", 1000, ("org",))
        if second:
            ledger.settle("b", 1000)
        ledger.settle("a", 1000)
        ledger.settle("a", 1000)
        label = "retained" if retain else "released"
        examples[label] = {"second_admitted": second, "final_cost": ledger.exposure("org")}
    checks.equal("release counterexample", examples["released"], {"second_admitted": True, "final_cost": 2000})
    checks.equal("retained bound", examples["retained"], {"second_admitted": False, "final_cost": 1000})

    worked_states = []
    for late_cost in (16000, 32000):
        ledger = Ledger({"org": 100000, "agent": 90000, "a": 60000, "b": 50000})
        for owner in ("a", "b"):
            ledger.admit("old-" + owner, 20000, ("org", "agent", owner))
            ledger.settle("old-" + owner, 20000)
        totals = [ledger.exposure("org")]
        checks.that("worked call A fits", ledger.admit("a", 20000, ("org", "agent", "a")))
        checks.that("worked call B fits", ledger.admit("b", 30000, ("org", "agent", "b")))
        totals.append(ledger.exposure("org"))
        ledger.unknown("a")
        ledger.settle("b", 18000)
        totals.append(ledger.exposure("org"))
        checks.equal("agent cap blocks large option", ledger.admit("large", 15000, ("org", "agent", "a")), False)
        checks.that("small option fits", ledger.admit("small", 10000, ("org", "agent", "a")))
        totals.append(ledger.exposure("org"))
        ledger.settle("a", late_cost)
        totals.append(ledger.exposure("org"))
        checks.equal("worked exposure totals", totals, [40000, 90000, 78000, 88000, 68000 + late_cost])
        worked_states.append({"late_cost": late_cost, "exposure": totals, "agent_excess": max(0, ledger.exposure("agent") - 90000)})
    checks.equal("underestimated cost breaks strict premise", worked_states[1]["agent_excess"], 10000)

    def tier_cost(tokens, upper_rate):
        return tokens * (1 if tokens <= 1000 else upper_rate)

    schedule = {"upper_rate": 3, "version": 1}
    priced_call = {"schedule": schedule.copy(), "hold": None, "cost": None}
    priced_call["hold"] = max(tier_cost(tokens, priced_call["schedule"]["upper_rate"]) for tokens in range(2001))
    bound = priced_call["hold"]
    checks.equal("envelope crosses the price tier", bound, 6000)
    schedule.update(upper_rate=4, version=2)
    priced_call["cost"] = tier_cost(1200, priced_call["schedule"]["upper_rate"])
    checks.equal("saved schedule settles late cost", priced_call["cost"], 3600)
    checks.equal("saved schedule keeps its version", priced_call["schedule"]["version"], 1)
    checks.equal("new schedule is different", tier_cost(1200, schedule["upper_rate"]), 4800)

    def share(ceiling):
        deficit = spent = 0
        rounds = []
        for _ in range(2):
            deficit = min(ceiling, deficit + 10)
            while deficit >= 6:
                deficit -= 6
                spent += 6
            rounds.append((spent, deficit))
        return rounds

    checks.equal("clipping counterexample", share(10), [(6, 4), (12, 4)])
    checks.equal("nonbinding share balance", share(20), [(6, 4), (18, 2)])

    for order in (("a", "b"), ("b", "a")):
        ledger = Ledger({"agent": 10000, "a": 10000, "b": 10000})
        accepted = [ledger.admit(key, 10000, ("agent", key)) for key in order]
        checks.equal("one shared-cap admission", sum(accepted), 1)
    # Split read/check/write has both writers see the same room.
    stale_reads = [0, 0]
    weak_admitted = [seen + 10000 <= 10000 for seen in stale_reads]
    checks.equal("split admission exceeds shared cap", sum(weak_admitted) * 10000, 20000)

    steps = 0
    largest_exposure = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        ledger = Ledger({"org": 1000, "agent": 700, "a": 550, "b": 550})
        latent_cost = {}
        for step in range(200):
            steps += 1
            unsettled = [key for key, row in ledger.calls.items() if row["status"] != "confirmed"]
            if unsettled and rng.randrange(3) == 0:
                key = rng.choice(unsettled)
                if rng.randrange(2):
                    ledger.unknown(key)
                else:
                    ledger.settle(key, latent_cost[key])
                    before = tuple(ledger.exposure(scope) for scope in ledger.caps)
                    ledger.settle(key, latent_cost[key])
                    checks.equal("repeat receipt keeps totals", tuple(ledger.exposure(scope) for scope in ledger.caps), before)
            else:
                hold = rng.randrange(1, 150)
                scopes = ("org", "agent", rng.choice(("a", "b")))
                key = str(step)
                if ledger.admit(key, hold, scopes):
                    latent_cost[key] = rng.randrange(hold + 1)
            for scope, cap in ledger.caps.items():
                value = ledger.exposure(scope)
                largest_exposure = max(largest_exposure, value)
                checks.that("all cap exposures stay bounded", 0 <= value <= cap)
                # Actual liability is known only to the experiment, not the ledger.
                liability = sum(latent_cost[key] for key, row in ledger.calls.items() if scope in row["scopes"])
                checks.that("hold covers hidden liability", liability <= value)
        for key, cost in latent_cost.items():
            ledger.settle(key, cost)
        for scope in ledger.caps:
            expected = sum(latent_cost[key] for key, row in ledger.calls.items() if scope in row["scopes"])
            checks.equal("final settlement conserves cost", ledger.exposure(scope), expected)

    return {
        "paper_id": "12",
        "title": "Hierarchical Agent Budgets Under Uncertain Model Usage",
        "checks": checks.count,
        "seeds": seed_count,
        "observations": [
            {"late_receipt_trace": examples},
            {"bounded_budget_campaign": exhaustive},
            {"worked_exposure_trace": worked_states},
            {"tier_hold": bound, "late_saved_cost": 3600, "clipped_share": share(10), "unclipped_share": share(20)},
            {"seeded_events": steps, "largest_scope_exposure": largest_exposure, "cap_excess": 0},
        ],
        "limitations": [
            "The model applies events atomically; it does not test database transactions or process races.",
            "The strict subset bounds cost by construction. Outlier cases test only the deterministic overrun inequality, not risk calibration.",
            "Weighted scheduling checks only one always-queued sibling group with no cap blocks, refunds or clipping. Task value and the full tree are not tested.",
            "These models do not establish product behavior. The separate real-database check supplies product evidence.",
            "Legacy restoration assumes an available and valid old cost bound. A saved heuristic is not a proved provider ceiling.",
            "The full planned policy comparison, workload grid and confidence intervals remain open.",
        ],
    }


def run(seed_count):
    return [protocol(seed_count), budget(seed_count)]
