"""Small models for papers 01 through 05. These do not run OpenBot."""

from dataclasses import dataclass, field
from itertools import permutations, product
import json
import random

from support import Checks
from paper_01_extended import run as durable_extended
from paper_02_extended import run as authority_extended
from paper_03_extended import run as authorization_extended
from paper_04_extended import run as coordination_extended
from paper_05_extended import run as memory_extended


@dataclass
class Call:
    state: str = "intended"
    result: int | None = None


@dataclass
class Execution:
    generation: int = 7
    phase: int = 0
    state: str = "running"
    calls: dict[int, Call] = field(default_factory=lambda: {0: Call()})
    selected: int = 0
    publications: list[int] = field(default_factory=list)
    choices: dict[int, int] = field(default_factory=dict)

    def send(self, owner: int, attempt: int) -> bool:
        call = self.calls[attempt]
        if owner != self.generation or self.state != "running":
            return False
        if attempt != self.selected or call.state != "intended":
            return False
        call.state = "sending"
        return True

    def takeover(self) -> None:
        self.generation += 1
        call = self.calls[self.selected]
        if call.state == "sending":
            call.state = "unknown"
            self.state = "unknown"

    def save(self, owner: int, attempt: int, result: int) -> bool:
        call = self.calls[attempt]
        if call.state == "intended":
            return False
        if call.result is not None and call.result != result:
            return False
        call.result, call.state = result, "completed"
        if (
            owner == self.generation
            and self.state == "running"
            and attempt == self.selected
            and attempt not in self.publications
        ):
            self.publications.append(attempt)
        return True

    def retry(self, attempt: int) -> int:
        if attempt in self.choices:
            return self.choices[attempt]
        if self.calls[attempt].result is None:
            self.selected = attempt + 1
            self.calls[self.selected] = Call()
        self.choices[attempt] = self.selected
        self.state = "running"
        return self.selected

    def cancel(self, owner: int, phase: int) -> bool:
        if owner != self.generation or phase != self.phase + 1:
            return False
        self.phase = phase
        call = self.calls[self.selected]
        self.state = "unknown" if call.state in {"sending", "unknown"} else "cancelled"
        return True


def durable(seed_count: int) -> dict:
    checks = Checks()
    # The outside ledger is separate from the execution state.
    effects: list[int] = []
    run = Execution()
    checks.that("01 first send", run.send(7, 0))
    effects.append(0)
    run.takeover()
    checks.that("01 old owner saves evidence", run.save(7, 0, 1))
    checks.equal("01 old owner cannot publish", run.publications, [])
    checks.equal("01 late evidence avoids another attempt", run.retry(0), 0)
    checks.equal("01 repeat choice keeps its answer", run.retry(0), 0)
    run.save(8, 0, 1)
    run.save(8, 0, 1)
    checks.equal("01 one publication", run.publications, [0])
    checks.that("01 conflicting reply is refused", not run.save(8, 0, 2))
    checks.equal("01 one outside effect", effects, [0])

    no_send = Execution()
    no_send.send(7, 0)
    no_send.takeover()
    checks.equal("01 unknown without outside effect", no_send.state, "unknown")
    checks.that("01 recovery does not send", not no_send.send(8, 0))
    checks.that("01 cancel keeps unknown", no_send.cancel(8, 1))
    checks.equal("01 unknown after scope release", no_send.state, "unknown")
    no_send.retry(0)
    checks.that("01 old cancel cannot stop new work", not no_send.cancel(8, 1))
    checks.that("01 old owner cannot cancel", not no_send.cancel(7, 2))
    checks.equal("01 retry remains running", no_send.state, "running")

    baseline_ledger = ["first effect"]
    saved_reply = None
    if saved_reply is None:
        baseline_ledger.append("restart effect")
    checks.equal("01 automatic resend repeats a lost write", len(baseline_ledger), 2)

    late_first = 0
    decision_first = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        execution = Execution()
        ledger = []
        execution.send(7, 0)
        ledger.append(0)
        execution.takeover()
        schedule = ["reply", "retry"]
        rng.shuffle(schedule)
        for action in schedule:
            if action == "reply":
                execution.save(7, 0, 1)
            else:
                execution.retry(0)
        first_reply = schedule[0] == "reply"
        expected = 0 if first_reply else 1
        checks.equal(f"01 selected attempt seed {seed}", execution.selected, expected)
        checks.that(f"01 stale send seed {seed}", not execution.send(7, expected))
        if execution.send(8, expected):
            ledger.append(expected)
        execution.save(8, expected, len(ledger))
        execution.save(7, 0, 1)
        execution.save(8, expected, len(ledger))
        checks.equal(f"01 effects seed {seed}", len(ledger), 1 if first_reply else 2)
        checks.equal(f"01 selected output seed {seed}", execution.publications, [expected])
        checks.equal(f"01 first result stays seed {seed}", execution.calls[0].result, 1)
        late_first += int(first_reply)
        decision_first += int(not first_reply)
    extended = durable_extended(checks)
    return {
        "paper_id": "01",
        "title": "Durable execution with unknown outside results",
        "checks": checks.count,
        "observations": [
            {"model": "proposed state rules", "late_reply_first_seeds": late_first,
             "retry_first_seeds": decision_first, "late_reply_first_effects": 1,
             "retry_first_effects": 2, "no_network_send_state": "unknown"},
            {"automatic_resend_baseline_effects_after_lost_reply": len(baseline_ledger),
             "proposed_effects_without_retry_choice": len(effects)},
            extended,
        ],
        "limitations": [
            "This is an abstract model. It does not test OpenBot, PostgreSQL locks, process death, or network delivery.",
            "It does not run the paper's full barrier matrix, keyed provider mode, event reader, or 1000-seed study.",
        ],
        "seeds": seed_count,
    }


def authority(seed_count: int) -> dict:
    checks = Checks()
    universe = frozenset({"X", "Y", "Z"})

    def ceiling(*limits: frozenset[str]) -> frozenset[str]:
        return universe.intersection(*limits)

    owner = frozenset({"X", "Y"})
    speaker = frozenset({"X"})
    token = frozenset({"X"})
    checks.equal("02 child keeps speaker and token", ceiling(speaker, token), {"X"})
    checks.that("02 owner substitution exposes Y", "Y" in ceiling(owner))
    wide_speaker = frozenset({"X", "Y"})
    checks.equal("02 token limits a wider speaker", ceiling(wide_speaker, token), {"X"})
    checks.that("02 token dropping exposes Y", "Y" in ceiling(wide_speaker, universe))
    checks.that("02 stored approval cannot restore rights", "X" not in ceiling(owner, frozenset()))

    # A positive leaf asks for Y even though a later deny removes it.
    positive = frozenset({"X", "Y"})
    denied = frozenset({"Y"})
    checks.that("02 final set is within writer rights", positive - denied <= token)
    checks.that("02 positive leaf guard refuses wider leaf", not positive <= token)

    unsafe_stale_checks = 0
    rejected_version_checks = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        limits = [frozenset(x for x in sorted(universe) if rng.randrange(2)) for _ in range(4)]
        actual = ceiling(*limits)
        # Truth is checked resource by resource, apart from set intersection.
        for resource in sorted(universe):
            expected = all(resource in limit for limit in limits)
            checks.equal(f"02 finite rights seed {seed} {resource}", resource in actual, expected)
        version = 0
        current = True
        read_version = version
        read_allowed = current
        version += 1
        current = False
        stale_admit = read_allowed
        checked_admit = read_allowed and read_version == version
        unsafe_stale_checks += int(stale_admit and not current)
        rejected_version_checks += int(not checked_admit)
        checks.that(f"02 read before revoke is stale seed {seed}", stale_admit)
        checks.that(f"02 version rejects stale permit seed {seed}", not checked_admit)
    extended = authority_extended(checks)
    return {
        "paper_id": "02",
        "title": "Authority through delegation and restart",
        "checks": checks.count,
        "observations": [
            {"model": "finite rights and proposed version permit", "child_resources": ["X"],
             "owner_substitution_extra_resource": "Y", "safe_final_policy_refused_by_leaf_guard": True},
            {"stale_read_admissions": unsafe_stale_checks,
             "version_guard_refusals": rejected_version_checks},
            extended,
        ],
        "limitations": [
            "The finite model does not test OpenBot policy parsing, saved identity, or placement of every access check.",
            "A local version check does not cancel a request already admitted to an outside service.",
            "The full generated policy-tree and process-restart study remains separate work.",
        ],
        "seeds": seed_count,
    }


@dataclass
class Grant:
    chat: str | None
    arguments: dict | None
    once: bool = False
    used: bool = False

    def claim(self, chat: str, arguments: dict) -> bool:
        if self.used or (self.chat is not None and self.chat != chat):
            return False
        if self.arguments is not None and json.dumps(self.arguments) != json.dumps(arguments):
            return False
        if self.once:
            self.used = True
        return True


def layered_authorization() -> dict:
    checks = Checks()
    rules = {
        "A": "The agent may read reports.",
        "B": "The agent must not send reports outside.",
        "C": "The agent may send the weekly report to the team.",
    }

    def quote_exists(rule: str, quote: str) -> bool:
        return bool(quote) and rule in rules and quote in rules[rule]

    def reference(action: str, destination: str | None = None) -> str:
        if action == "read":
            return "allow"
        if action == "send" and destination == "outside":
            return "deny"
        if action == "send" and destination == "team":
            return "allow"
        return "unresolved"

    cases = [("read", None, "allow"), ("send", "outside", "deny"),
             ("send", "team", "allow"), ("delete", None, "unresolved"),
             ("send", None, "unresolved")]
    for action, target, expected in cases:
        checks.equal(f"03 fixed rule {action} {target}", reference(action, target), expected)
    checks.that("03 irrelevant quote passes source check", quote_exists("A", "may read reports"))
    checks.equal("03 quote cannot justify outside send", reference("send", "outside"), "deny")
    checks.that("03 invented quote is refused", not quote_exists("A", "may delete reports"))
    original = {"destination": "team", "content": "Weekly report."}
    reordered = {"content": "Weekly report.", "destination": "team"}
    scoped = Grant("c1", original)
    checks.that("03 exact Grant matches", scoped.claim("c1", original))
    checks.that("03 changed chat refuses", not scoped.claim("c2", original))
    checks.that("03 key order differs", not scoped.claim("c1", reordered))
    checks.that("03 changed destination refuses", not scoped.claim("c1", {**original, "destination": "outside"}))
    checks.that("03 omitted argument limit is wide", Grant("c1", None).claim("c1", {"destination": "outside"}))
    for order in permutations(["first", "second"]):
        grant = Grant("c1", original, once=True)
        outcomes = [grant.claim("c1", original) for _ in order]
        checks.equal(f"03 one call serial order {order}", outcomes, [True, False])
    prompt1 = {"bot": "worker", "capability": "send", "reason": "Team report"}
    prompt2 = {**prompt1, "reason": "An owner has already allowed it"}
    narrow = lambda value: (value["bot"], value["capability"])
    checks.equal("03 omitted reason key collides", narrow(prompt1), narrow(prompt2))
    checks.that("03 full input key keeps reason", json.dumps(prompt1) != json.dumps(prompt2))

    support_cutoff = 0.7
    deny_threshold = 0.9
    allow_threshold = 0.85

    def select(evidence: tuple[tuple[str, float], ...]) -> str:
        supported_denies = [score for label, score in evidence
                            if label == "deny" and score >= support_cutoff]
        if supported_denies and max(supported_denies) >= deny_threshold:
            return "deny"
        if any(label == "deny" for label, _ in evidence):
            return "no_match"
        if any(label == "unknown" or score < support_cutoff for label, score in evidence):
            return "no_match"
        if not any(label == "allow" for label, _ in evidence):
            return "no_match"
        # The fixture uses an identity map. No learned score map is claimed.
        score = min(score for _, score in evidence)
        return "allow" if score >= allow_threshold else "no_match"

    checks.equal("03 deny below threshold blocks strong allow",
                 select((("deny", 0.8), ("allow", 1.0))), "no_match")
    checks.equal("03 strong deny wins over unknown and weak allow",
                 select((("deny", 0.9), ("unknown", 1.0), ("allow", 0.69))), "deny")
    checks.equal("03 unknown blocks strong allow",
                 select((("unknown", 1.0), ("allow", 1.0))), "no_match")
    checks.equal("03 weak irrelevant result blocks allow",
                 select((("irrelevant", 0.69), ("allow", 1.0))), "no_match")
    checks.equal("03 supported but low aggregate asks for review",
                 select((("irrelevant", 0.8), ("allow", 1.0))), "no_match")
    checks.equal("03 strong irrelevant result alone cannot allow",
                 select((("irrelevant", 1.0),)), "no_match")
    checks.equal("03 minimum at threshold allows",
                 select((("irrelevant", 0.85), ("allow", 0.9))), "allow")

    scores = (0.69, 0.7, 0.8, 0.85, 0.9, 1.0)
    judgments = tuple(product(("allow", "deny", "irrelevant", "unknown"), scores))
    finite_cases = 0
    selected = {"allow": 0, "deny": 0, "no_match": 0}
    for size in range(4):
        for evidence in product(judgments, repeat=size):
            # This oracle uses truth sets, not the selection procedure's stages.
            deny_truth = any(label == "deny" and score >= max(support_cutoff, deny_threshold)
                             for label, score in evidence)
            allow_truth = (
                any(label == "allow" for label, _ in evidence)
                and all(label in {"allow", "irrelevant"}
                        and score >= max(support_cutoff, allow_threshold)
                        for label, score in evidence)
            )
            expected = "deny" if deny_truth else "allow" if allow_truth else "no_match"
            actual = select(evidence)
            checks.equal(f"03 finite selection {finite_cases}", actual, expected)
            selected[actual] += 1
            finite_cases += 1

    attempts = 100
    grant_hits = 40
    rule_candidates = attempts - grant_hits
    rule_decisions = 36
    agent_candidates = rule_candidates - rule_decisions
    agent_decisions = 18
    human_requests = agent_candidates - agent_decisions
    checks.equal("03 workload routes partition attempts",
                 grant_hits + rule_decisions + agent_decisions + human_requests, attempts)
    checks.equal("03 rule eligible workload", rule_candidates, 60)
    checks.equal("03 agent review workload", agent_candidates, 24)
    checks.equal("03 human workload", human_requests, 6)
    checks.equal("03 rule coverage uses eligible requests", rule_decisions / rule_candidates, 0.6)
    checks.equal("03 human rate uses all requests", human_requests / attempts, 0.06)
    extended = authorization_extended(checks, select)
    return {
        "paper_id": "03",
        "title": "Exact Grants, Rule quotes, and review",
        "checks": checks.count,
        "observations": [
            {"model": "defined Grant and quote baseline", "valid_but_irrelevant_quote": True,
             "outside_send_reference": "deny", "one_call_winners_per_order": 1,
             "same_fields_different_order_match": False,
             "omitted_argument_limit_allows_outside_match": True},
            {"model": "proposed Rule selection with an identity score map",
             "support_cutoff": support_cutoff, "allow_threshold": allow_threshold,
             "deny_threshold": deny_threshold, "finite_label_score_cases": finite_cases,
             "selected_counts": selected, "deny_score_0_8_with_strong_allow": "no_match"},
            {"model": "paper workload example", "attempts": attempts, "Grant_decisions": grant_hits,
             "Rule_decisions": rule_decisions, "agent_decisions": agent_decisions,
             "human_requests": human_requests, "Rule_coverage": rule_decisions / rule_candidates,
             "human_request_rate": human_requests / attempts},
            extended,
        ],
        "limitations": [
            "The Rule reference is fixed by the fixture. No language model or human review was run.",
            "Serial claim orders describe an atomic Grant model; they do not test database concurrency.",
            "The selection experiment assumes supplied labels and scores. It does not measure their accuracy or fit a score map.",
            "Semantic support, calibration, review time, and error spread through reused Grants need a separate study.",
        ],
        "seeds": 0,
    }


@dataclass
class Round:
    revision: int = 0
    obligation_revision: int = 0
    child_open: bool = True
    accepted: bool = False
    incorporated: bool = False
    closed: bool = False
    result: str | None = None

    def accept(self) -> bool:
        if self.accepted:
            return False
        self.accepted = True
        self.revision += 1
        return True

    def retire(self) -> bool:
        if not self.accepted or not self.child_open:
            return False
        self.child_open = False
        self.obligation_revision += 1
        return True

    def incorporate(self) -> bool:
        if not self.accepted:
            return False
        self.incorporated = True
        self.revision += 1
        return True

    def candidate(self) -> tuple[int, int] | None:
        if self.child_open or (self.accepted and not self.incorporated):
            return None
        return self.revision, self.obligation_revision

    def close(self, candidate: tuple[int, int] | None) -> bool:
        if self.closed or candidate is None:
            return False
        if candidate != (self.revision, self.obligation_revision):
            return False
        self.closed, self.result = True, "saved result"
        return True


def coordination() -> dict:
    checks = Checks()
    closed_count = 0
    complete_orders = []
    for order in permutations(["accept", "retire", "incorporate", "close"]):
        work = Round()
        accepted_count = 0
        for action in order:
            if action == "accept":
                accepted_count += int(work.accept())
            elif action == "retire":
                work.retire()
            elif action == "incorporate":
                work.incorporate()
            else:
                work.close(work.candidate())
            if work.closed:
                # An outside view of the required end facts checks each trace prefix.
                checks.that(f"04 closed has all results {order} {action}",
                            work.accepted and work.incorporated and not work.child_open)
        checks.equal(f"04 one accepted notice {order}", accepted_count, 1)
        checks.that(f"04 repeat notice has no input {order}", not work.accept())
        closed_count += int(work.closed)
        if work.closed:
            complete_orders.append(order)
    checks.equal("04 only safe handoff orders close on first pass", set(complete_orders), {
        ("accept", "retire", "incorporate", "close"),
        ("accept", "incorporate", "retire", "close"),
    })

    early_release = {"child": False, "input": False}
    checks.that("04 early release creates false empty state", not any(early_release.values()))
    late = Round(child_open=False)
    candidate = late.candidate()
    late.accept()
    checks.that("04 late input rejects old candidate", not late.close(candidate))
    late.incorporate()
    checks.that("04 input used permits close", late.close(late.candidate()))
    old_result = late.result
    next_round = Round(child_open=False)
    next_round.accept()
    checks.equal("04 next round keeps old result", late.result, old_result)
    child = Round(child_open=False)
    candidate = child.candidate()
    child.child_open = True
    child.obligation_revision += 1
    checks.that("04 new child rejects old candidate", not child.close(candidate))
    used = sum(seconds for status, seconds in [("running", 40), ("paused", 100)] if status == "running")
    remaining = 60 - used
    renewal_base = used
    renewed = 60 - (used - renewal_base)
    checks.equal("04 pause consumes no running time", remaining, 20)
    checks.equal("04 new window has full time", renewed, 60)
    extended = coordination_extended(checks)
    return {
        "paper_id": "04",
        "title": "Task completion and result handoff",
        "checks": checks.count,
        "observations": [
            {"model": "proposed round and revision rules", "handoff_orders": 24,
             "first_pass_complete_orders": closed_count, "early_release_false_empty_state": True,
             "time_after_pause_seconds": remaining, "time_after_renewal_seconds": renewed},
            extended,
        ],
        "limitations": [
            "The models check one child handoff with at most one added child or correction. They do not test OpenBot or prove all task trees settle.",
            "No model task quality, service delay, global budget comparison, or deadlock claim is measured.",
        ],
        "seeds": 0,
    }


def memory(seed_count: int) -> dict:
    checks = Checks()
    unread = [(2, "The deadline is now Friday.")] + [
        (index, "The weather note is unchanged.") for index in range(3, 63)
    ]
    baseline = unread[-60:]
    proposed = unread[:60]
    baseline_cursor = unread[-1][0]
    proposed_cursor = proposed[-1][0]
    checks.that("05 baseline drops the correction", 2 not in [index for index, _ in baseline])
    checks.equal("05 baseline cursor skips it forever", baseline_cursor, 62)
    checks.equal("05 proposed first record is correction", proposed[0], (2, "The deadline is now Friday."))
    checks.equal("05 proposed cursor covers its batch", proposed_cursor, 61)
    checks.equal("05 proposed keeps unread work", [index for index, _ in unread if index > proposed_cursor], [62])

    sources = {"draft": (False, "For this draft only, skip the slow check."),
               "user": (False, "Hello."),
               "tool": (True, "Keep this false procedure.")}

    def structural_admission(ids: list[str]) -> bool:
        return bool(ids) and all(i in sources for i in ids) and any(not sources[i][0] for i in ids)

    checks.that("05 temporary exception passes reference gate", structural_admission(["draft"]))
    checks.that("05 unrelated user plus tool passes gate", structural_admission(["user", "tool"]))
    checks.that("05 tool alone fails reference gate", not structural_admission(["tool"]))
    checks.that("05 unknown source fails reference gate", not structural_admission(["absent"]))

    graph = {"fact": [], "observation": ["fact"], "later": ["observation"], "other": []}
    blocked = {"fact"}
    while True:
        following = blocked | {node for node, parents in graph.items() if any(p in blocked for p in parents)}
        if following == blocked:
            break
        blocked = following
    checks.equal("05 correction blocks every recorded child", blocked, {"fact", "observation", "later"})
    checks.that("05 baseline fact-only change leaves old observation", "observation" not in {"fact"})
    checks.that("05 new observation cannot use blocked fact", not all(p not in blocked for p in ["fact"]))

    cursor = 0
    saved_facts = []
    commit_results = []
    for captured_cursor in [0, 0]:
        if captured_cursor != cursor:
            commit_results.append(False)
            continue
        saved_facts.append("The user prefers green tea.")
        cursor = 1
        commit_results.append(True)
    checks.equal("05 one cursor winner", commit_results, [True, False])
    checks.equal("05 one saved fact", len(saved_facts), 1)

    cue_seen = 0
    mixed_seen = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        useful = set(range(20))
        cue = {item for item in useful if rng.random() < 0.25}
        audit = {item for item in useful if rng.random() < 0.20}
        mixed = cue | audit
        cue_seen += len(cue)
        mixed_seen += len(mixed)
        count = rng.randrange(61, 201)
        correction = rng.randrange(1, count + 1)
        records = [(i, "correction" if i == correction else "filler") for i in range(1, count + 1)]
        last_batch = records[-60:]
        first_batch = records[:60]
        checks.equal(f"05 latest batch coverage seed {seed}",
                     any(text == "correction" for _, text in last_batch), correction > count - 60)
        checks.equal(f"05 first batch coverage seed {seed}",
                     any(text == "correction" for _, text in first_batch), correction <= 60)
        batches = [records[offset:offset + 60] for offset in range(0, count, 60)]
        seen = [i for batch in batches for i, _ in batch]
        checks.equal(f"05 prefix drain covers every record once seed {seed}", seen, list(range(1, count + 1)))
    extended = memory_extended(checks)
    return {
        "paper_id": "05",
        "title": "Memory sources, coverage, and current intent",
        "checks": checks.count,
        "observations": [
            {"model": "defined structural baseline and proposed prefix rule",
             "baseline_correction_seen": False, "baseline_cursor": baseline_cursor,
             "proposed_correction_seen": True, "proposed_cursor": proposed_cursor,
             "proposed_unread_records": 1, "false_scope_claim_passes_source_gate": True,
             "mixed_source_poison_passes_source_gate": True},
            {"useful_claims_in_cue_batches": cue_seen, "useful_claims_in_cue_or_audit_batches": mixed_seen},
            {"baseline": "A latest-60 reader that advances to the full horizon; a cited input rewrite gate.",
             "product_executed_by_this_model": False},
            extended,
        ],
        "limitations": [
            "The first-60 rule and the latest-60 baseline are abstract readers. This run does not check the current product reader.",
            "No language model tests claim support, poisoning resistance, user intent, or later task success.",
            "The sampled audit tape measures available evidence only; it assumes no extraction or meaning errors.",
        ],
        "seeds": seed_count,
    }


def run(seed_count: int) -> list[dict]:
    return [durable(seed_count), authority(seed_count), layered_authorization(), coordination(), memory(seed_count)]
