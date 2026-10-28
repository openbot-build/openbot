"""Small models for the proposed voice and compute tests."""

from dataclasses import dataclass, replace
from fractions import Fraction
from heapq import heappop, heappush
from itertools import permutations, product
from random import Random

from support import Checks


@dataclass(frozen=True)
class SpeechUnit:
    name: str
    end: int
    complete: bool = True
    mapped: bool = True


@dataclass(frozen=True)
class Speech:
    epoch: str
    item: str
    sent: int
    units: tuple[SpeechUnit, ...]
    played: int = 0
    receipt: int = -1
    retired: bool = False
    stopped: bool = False
    provider_cut: int | None = None
    repair_request: tuple[str, str, str, int] | None = None
    tool: str = "succeeded"

    def report(self, epoch, item, number, offset, stopped=False):
        if (
            epoch != self.epoch
            or item != self.item
            or number < 0
            or offset < 0
            or number <= self.receipt
            or offset < self.played
            or offset > self.sent
            or (self.stopped and offset > self.played)
        ):
            return self
        return replace(
            self,
            played=offset,
            receipt=number,
            stopped=self.stopped or stopped,
        )

    def supported(self):
        result = []
        for unit in self.units:
            if not unit.complete or not unit.mapped or unit.end > self.played:
                break
            result.append(unit.name)
        return result

    def begin_repair(self, request):
        if self.retired and self.stopped:
            return replace(self, repair_request=(self.epoch, self.item, request, self.played))
        return self

    def repair(self, epoch, item, request, offset):
        if self.repair_request == (epoch, item, request, offset):
            return replace(self, provider_cut=offset)
        return self

    def may_answer(self):
        return self.retired and self.stopped and self.provider_cut == self.played


@dataclass(frozen=True)
class Notice:
    saved_outcome: str | None = None
    tool_running: bool = False
    report_state: str = "none"
    retry_due: bool = False
    calls: int = 0
    trace: tuple[str, ...] = ()

    def next_action(self, retry_tool):
        if self.tool_running:
            return "wait"
        if self.saved_outcome is None:
            return "book"
        if self.report_state == "queued":
            return "book" if retry_tool and self.retry_due else "speak"
        return "wait"

    def step(self, event):
        state = replace(self, trace=self.trace + (event,))
        if event == "book" and not self.tool_running:
            return replace(state, tool_running=True, retry_due=False, calls=self.calls + 1)
        if event == "result" and self.tool_running:
            return replace(state, tool_running=False, saved_outcome="succeeded", report_state="queued")
        if event == "speak" and self.saved_outcome == "succeeded" and self.report_state == "queued":
            return replace(state, report_state="playing", retry_due=False)
        if event == "cut" and self.report_state == "playing":
            return replace(state, report_state="queued", retry_due=True)
        if event == "finish" and self.report_state == "playing":
            return replace(state, report_state="done")
        raise ValueError(f"The notice cannot take this step: {event}")


def notice_trace(retry_tool):
    def advance(state):
        action = state.next_action(retry_tool)
        state = state.step(action)
        # The fake booking service gives a confirmed result after each call.
        return state.step("result") if action == "book" else state

    state = advance(Notice())
    state = advance(state)
    cut = state.step("cut")
    state = advance(cut)
    if state.report_state == "queued":
        state = advance(state)
    return cut, state.step("finish")


def playback_trace(generation_guard):
    """A sample clock, a work turn, and a player have separate states."""
    events = []
    for number, (time, name) in enumerate(
        [
            (Fraction(2, 10), "play"),
            (Fraction(7, 10), "generated"),
            (Fraction(8, 10), "turn_end"),
            (Fraction(9, 10), "sent"),
            (Fraction(18, 10), "speech_start"),
            (Fraction(42, 10), "audio_end"),
        ]
    ):
        heappush(events, (time, number, name))
    active = True
    started = None
    ended = None
    trace = []
    while events:
        time, number, name = heappop(events)
        trace.append((str(time), name))
        if name == "play":
            started = time
        elif name == "turn_end":
            active = False
        elif name == "speech_start" and (active or not generation_guard):
            heappush(events, (time + Fraction(1, 10), 100, "stop"))
        elif name in ("stop", "audio_end") and ended is None:
            ended = time
    return {"samples": int((ended - started) * 24000), "end": ended, "trace": trace}


def voice_finite_checks(checks):
    """The device oracle is separate from the host receipt state."""
    events = ("render", "receipt", "retire", "stop", "final", "ack", "late", "answer")
    edges = (("render", "receipt"), ("render", "stop"), ("retire", "stop"),
             ("stop", "final"), ("final", "ack"), ("retire", "late"),
             ("retire", "answer"))
    schedules = 0
    checked_prefixes = 0
    ready_answers = 0
    blocked_answers = 0
    early_witness = None
    states = set()
    for order in permutations(events):
        positions = {event: index for index, event in enumerate(order)}
        if any(positions[first] >= positions[last] for first, last in edges):
            continue
        schedules += 1
        host = Speech("one", "item", 2, (SpeechUnit("first", 1), SpeechUnit("last", 2)))
        device_samples = 0
        device_stopped = False
        provider_applied = False
        scheduled_after_stop = 0
        for index, event in enumerate(order):
            if event == "render":
                device_samples = 1
            elif event == "receipt":
                host = host.report("one", "item", 1, 1)
            elif event == "retire":
                host = replace(host, retired=True)
            elif event == "stop":
                device_stopped = True
            elif event == "final":
                host = host.report("one", "item", 2, device_samples, stopped=True).begin_repair("repair-one")
                for bad in (("old", "item", "repair-one", 1),
                            ("one", "other", "repair-one", 1),
                            ("one", "item", "other", 1),
                            ("one", "item", "repair-one", 2)):
                    checks.equal("voice wrong repair identity leaves the barrier shut", host.repair(*bad), host)
            elif event == "ack":
                provider_applied = True
                host = host.repair("one", "item", "repair-one", 1)
            elif event == "late":
                if not host.retired:
                    scheduled_after_stop += 1
            elif event == "answer":
                # Read the oracle's device and provider events, not host.may_answer.
                expected = device_stopped and provider_applied
                checks.equal("voice answer gate agrees with independent actor events", host.may_answer(), expected)
                if expected:
                    ready_answers += 1
                else:
                    blocked_answers += 1
                    if early_witness is None:
                        early_witness = list(order[:index + 1])
            checks.that("voice every prefix uses only device output", host.played <= device_samples)
            checks.that("voice every committed unit has a whole device span", set(host.supported()) <= ({"first"} if device_samples == 1 else set()))
            checks.equal("voice presentation events keep the saved effect", host.tool, "succeeded")
            checks.equal("voice late data cannot restart a retired player", scheduled_after_stop, 0)
            checks.that("voice a released gate has both outside facts", not host.may_answer() or (device_stopped and provider_applied))
            states.add((device_samples, device_stopped, provider_applied, host))
            checked_prefixes += 1
        checks.equal("voice every complete schedule has the same supported unit", host.supported(), ["first"])
        checks.that("voice every complete schedule can later answer", host.may_answer())
    checks.that("voice exploration reaches both response outcomes", ready_answers > 0 and blocked_answers > 0)

    # Observation classes contain every device world allowed by an error bound.
    # The reference answer is set intersection, not the host frontier routine.
    worlds_checked = 0
    classes_checked = 0
    unsafe_raw = 0
    for report in range(5):
        for error in range(3):
            worlds = tuple(played for played in range(5) if report - played <= error)
            common = set.intersection(*(set(range(1, played + 1)) for played in worlds))
            conservative = max(0, report - error)
            host = Speech("clock", "one", 4, tuple(SpeechUnit(str(end), end) for end in range(1, 5)))
            host = host.report("clock", "one", 1, conservative)
            checks.equal("voice bounded clock uses exactly the common prefix", set(map(int, host.supported())), common)
            for played in worlds:
                checks.that("voice bounded clock commits no unrendered sample unit", host.played <= played)
                if report > played:
                    unsafe_raw += 1
                worlds_checked += 1
            classes_checked += 1
    checks.that("voice raw clock has a finite counterexample", unsafe_raw > 0)
    no_receipt_worlds = [set(range(1, played + 1)) for played in range(5)]
    checks.equal("voice no receipt leaves no known nonempty prefix", set.intersection(*no_receipt_worlds), set())
    # A conservative end can include silence after the word itself has ended.
    # This is safe but disproves maximum retention without exact boundaries.
    padded = Speech("map", "one", 2, (SpeechUnit("word", 2),)).report("map", "one", 1, 1)
    exact = Speech("map", "one", 2, (SpeechUnit("word", 1),)).report("map", "one", 1, 1)
    checks.equal("voice conservative map can lose a fully rendered word", padded.supported(), [])
    checks.equal("voice exact boundary retains the same rendered word", exact.supported(), ["word"])
    old = Speech("old", "same", 2, (SpeechUnit("old", 2),)).report("old", "same", 1, 2, stopped=True)
    new = Speech("new", "same", 2, (SpeechUnit("new", 2),))
    checks.equal("voice reused item name does not accept an old epoch", new.report(old.epoch, old.item, 1, 2), new)
    checks.equal("voice receipt under zero is rejected", new.report("new", "same", 1, -1), new)
    bad_epoch_host = replace(new, epoch="old").report(old.epoch, old.item, 1, 2)
    checks.equal("voice removing epoch separation admits unplayed content", bad_epoch_host.supported(), ["new"])
    return {
        "fixture": "finite legal event orders and clock worlds",
        "events": list(events),
        "order_edges": [list(edge) for edge in edges],
        "legal_orders": schedules,
        "checked_prefixes": checked_prefixes,
        "distinct_actor_host_states": len(states),
        "ready_answer_attempts": ready_answers,
        "blocked_answer_attempts": blocked_answers,
        "barrier_removed_counterexample": early_witness,
        "clock_observation_classes": classes_checked,
        "clock_worlds": worlds_checked,
        "raw_clock_unsound_worlds": unsafe_raw,
        "epoch_removed_counterexample": ["old item played to 2", "new epoch reuses item name", "old receipt commits new unplayed unit"],
        "conservative_map_counterexample": {"device_end": 1, "actual_word_end": 1, "map_upper_end": 2, "retained_words": 0},
        "oracle": "Device render and provider apply events; set intersection of all bounded clock worlds.",
    }


def voice_experiment(seed_count):
    checks = Checks()
    finite = voice_finite_checks(checks)
    baseline = playback_trace(True)
    fixed = playback_trace(False)
    checks.equal("voice guard leaves all sound playing", baseline["samples"], 96000)
    checks.equal("voice stop uses the player clock", fixed["samples"], 40800)
    checks.equal("voice stop ends at 1.9 seconds", fixed["end"], Fraction(19, 10))
    checks.equal("voice guard adds 2.3 seconds", baseline["end"] - fixed["end"], Fraction(23, 10))
    units = (SpeechUnit("room booked", 33600), SpeechUnit("door code", 96000))
    speech = Speech("old", "answer", 96000, units)
    speech = speech.report("old", "answer", 1, fixed["samples"], stopped=True)
    speech = replace(speech, retired=True).begin_repair("cut-one")
    checks.equal("voice keeps the complete first phrase", speech.supported(), ["room booked"])
    checks.that("voice waits for provider repair", not speech.may_answer())
    checks.equal("voice wrong repair does not release", speech.repair("old", "answer", "cut-one", 96000), speech)
    speech = speech.repair("old", "answer", "cut-one", 40800)
    checks.that("voice matching repair releases", speech.may_answer())

    # All policies get the same output and stop point in this comparison.
    histories = {
        "B0": {"host": [unit.name for unit in units], "provider": [unit.name for unit in units]},
        "B1": {"host": [], "provider": []},
        "B2": {"host": [unit.name for unit in units], "provider": speech.supported()},
        "frontier": {"host": speech.supported(), "provider": speech.supported()},
    }
    supported = {"room booked"}
    history_scores = {}
    for policy, views in histories.items():
        host = set(views["host"])
        history_scores[policy] = {
            "unsupported_host_units": len(host - supported),
            "lost_supported_units": len(supported - host),
            "different_views": views["host"] != views["provider"],
        }
    checks.equal("voice B0 holds one unsupported claim", history_scores["B0"]["unsupported_host_units"], 1)
    checks.equal("voice B1 loses the supported phrase", history_scores["B1"]["lost_supported_units"], 1)
    checks.that("voice B2 views differ", history_scores["B2"]["different_views"])
    checks.equal("voice frontier holds no unsupported claim", history_scores["frontier"]["unsupported_host_units"], 0)
    checks.equal("voice frontier loses no supported phrase", history_scores["frontier"]["lost_supported_units"], 0)

    ordered = Speech("old", "answer", 96000, units)
    frontiers = []
    for number, offset in [(3, 14400), (2, 9600), (3, 14400), (4, 26400)]:
        ordered = ordered.report("old", "answer", number, offset)
        frontiers.append(ordered.played)
    checks.equal("voice old and duplicate receipts do not move the cut", frontiers, [14400, 14400, 14400, 26400])
    checks.equal("voice receipt past sent sound is rejected", ordered.report("old", "answer", 5, 96001), ordered)
    current = Speech("new", "next", 48000, (SpeechUnit("next phrase", 48000),))
    checks.equal("voice old receipt cannot change new output", current.report("old", "answer", 5, 30000), current)
    checks.equal("voice old receipt can refine old record", ordered.report("old", "answer", 5, 30000).played, 30000)
    checks.equal("voice stopped prefix cannot grow", speech.report("old", "answer", 2, 45000), speech)

    # Missing timing blocks later units, even if their own times are known.
    gap = Speech("gap", "one", 96000, (SpeechUnit("do not send", 24000, mapped=False), SpeechUnit("next", 48000)))
    gap = gap.report("gap", "one", 1, 96000)
    checks.equal("voice unknown alignment blocks exact text", gap.supported(), [])
    partial = Speech("part", "one", 24000, (SpeechUnit("do", 12000, complete=False),))
    partial = partial.report("part", "one", 1, 24000)
    checks.equal("voice incomplete meaning cannot become a claim", partial.supported(), [])
    cut_notice, notice = notice_trace(retry_tool=False)
    _, bad_notice = notice_trace(retry_tool=True)
    checks.equal("voice cut notice keeps the outside result", cut_notice.saved_outcome, "succeeded")
    checks.equal("voice cut notice queues an unfinished report", cut_notice.report_state, "queued")
    checks.equal("voice resumed notice completes its report", notice.report_state, "done")
    checks.equal("voice later report does not book again", notice.calls, 1)
    checks.equal("voice faulty retry books twice", bad_notice.calls, 2)
    checks.equal("voice saved result is read on resume", notice.trace, ("book", "result", "speak", "cut", "speak", "finish"))
    checks.equal("voice faulty retry dispatches a second action", bad_notice.trace, ("book", "result", "speak", "cut", "book", "result", "speak", "finish"))
    checks.equal("voice faulty retry still completes its report", bad_notice.report_state, "done")

    random_reports = 0
    for seed in range(seed_count):
        rng = Random(seed)
        rendered = rng.randint(1, 96000)
        offsets = sorted(rng.randint(0, rendered) for _ in range(20))
        reports = [("old", "answer", index + 1, offset) for index, offset in enumerate(offsets)]
        reports += reports[::3]
        reports += [("wrong", "answer", 80, 96000), ("old", "wrong", 81, 96000), ("old", "answer", 82, 96001)]
        rng.shuffle(reports)
        state = Speech("old", "answer", 96000, units, retired=True)
        for report in reports:
            prior = state.played
            state = state.report(*report)
            checks.that("voice random cut does not go back", state.played >= prior)
            checks.that("voice random cut stays inside rendered sound", state.played <= rendered)
            checks.equal("voice random receipts keep the tool fact", state.tool, "succeeded")
            checks.that("voice random receipts cannot release repair", not state.may_answer())
            random_reports += 1
        checks.equal("voice reordering keeps the largest valid receipt", state.played, max(offsets))
        state = state.report("old", "answer", 100, rendered, stopped=True)
        state = state.begin_repair("final").repair("old", "answer", "final", rendered)
        checks.that("voice final receipt and repair release the barrier", state.may_answer())
        checks.equal("voice supported units end within rendered sound", state.supported(), [unit.name for unit in units if unit.end <= rendered])

    return {
        "paper_id": "13",
        "title": "History Consistency for Interruptible Voice Agents",
        "checks": checks.count,
        "seeds": seed_count,
        "observations": [
            finite,
            {"fixture": "stop after generation", "guarded_samples": baseline["samples"], "stopped_samples": fixed["samples"], "extra_seconds": float(baseline["end"] - fixed["end"])},
            {"fixture": "same stop, four histories", "scores": history_scores},
            {"fixture": "receipt order", "played_samples": frontiers, "random_reports": random_reports},
            {"fixture": "tool notice", "saved_outcome_after_cut": cut_notice.saved_outcome, "report_after_cut": cut_notice.report_state, "report_after_resume": notice.report_state, "external_calls": notice.calls, "faulty_retry_external_calls": bad_notice.calls, "trace": list(notice.trace), "faulty_retry_trace": list(bad_notice.trace)},
        ],
        "limitations": [
            "This is an abstract protocol model. It does not run the product Live driver.",
            "The product currently sends raw audio and has no playback receipt or repair barrier in its Live types.",
            "Clock error bounds and text maps are supplied model inputs. These results do not calibrate a clock or measure speech timing, hearing, or understanding.",
            "No live model or spoken user study was run. The history counts are known units, not measured later language claims.",
        ],
    }


@dataclass(frozen=True)
class Place:
    name: str
    guarantees: frozenset[str]
    shared: bool
    cost: Fraction
    minutes: int
    restore_seconds: int
    revision: int = 1
    evidence_valid: bool = True


@dataclass(frozen=True)
class Task:
    name: str
    needs: frozenset[str]
    exclusive: bool = True
    cap: Fraction = Fraction(100)
    minutes: int = 100
    restore_seconds: int = 100
    changes: tuple[str, ...] = ()


def reasons(task, place):
    failures = []
    if task.needs - place.guarantees:
        failures.append("missing guarantee")
    if task.exclusive and place.shared:
        failures.append("shared host")
    if not place.evidence_valid:
        failures.append("old evidence")
    if place.cost > task.cap:
        failures.append("cost cap")
    if place.minutes > task.minutes or place.restore_seconds > task.restore_seconds:
        failures.append("time bound")
    return failures


def choose(tasks, places):
    feasible = [(task, place) for task in tasks for place in places if not reasons(task, place)]
    if not feasible:
        return None
    return min(feasible, key=lambda pair: (pair[1].cost, pair[1].minutes, len(pair[0].changes), pair[1].name))


def resume_value(place, saved=None):
    files = {"one": 1}
    process = {"value": 41}
    if saved is not None:
        files["checkpoint"] = saved
    if "memory pause" not in place.guarantees:
        process.clear()
    if saved is not None:
        record = files["checkpoint"]
        if record.get("digest") != "input-one" or record.get("schema") != 1 or record.get("phase") != "add":
            return None
        if not isinstance(record.get("value"), int):
            return None
        process["value"] = record["value"]
    return None if "value" not in process else process["value"] + files["one"]


def claim_trace(planned_revision, actual_revision, capacity=True, allowed=True):
    trace = ["planned"]
    if planned_revision != actual_revision or not capacity or not allowed:
        return trace + ["claim failed"]
    return trace + ["claimed", "stage input", "run", "ended", "release"]


def safe_prefixes(trace):
    allowed = {"read input", "write checkpoint", "write result", "remove checkpoint"}
    return all(action in allowed for action in trace)


@dataclass(frozen=True)
class SearchCase:
    terminal: bool
    memory: bool
    batch_known: bool
    full_state: bool
    phase: str
    effect_cap: int
    result_bound: int
    cost_cap: int
    deadline: int


@dataclass(frozen=True)
class SearchNode:
    terminal: bool
    memory: bool
    file_pause: bool = False
    lost_state: bool = False
    writes: int = 0
    work: int = 0
    chain: tuple[str, ...] = ()


# These are model facts, not prices or claims about a provider.
SEARCH_PLACES = (
    ("M", frozenset(("pty", "pipe", "memory", "file")), 2, 1),
    ("F", frozenset(("pipe", "file")), 1, 2),
    ("P", frozenset(("pipe",)), 0, 1),
)
SEARCH_RULES = ("batch", "checkpoint", "drop state")


def expand_rule(case, node, rule, skip=frozenset()):
    if case.phase != "ready" and "phase" not in skip:
        return None
    if rule == "batch":
        if not node.terminal or (not case.batch_known and "precondition" not in skip):
            return None
        next_node = replace(node, terminal=False, writes=node.writes + 1, work=node.work + 1)
    elif rule == "checkpoint":
        if not node.memory or (not case.full_state and "precondition" not in skip):
            return None
        next_node = replace(node, memory=False, file_pause=True, writes=node.writes + 1, work=node.work + 1)
    elif rule == "drop state":
        if not node.memory:
            return None
        next_node = replace(node, memory=False, lost_state=True)
    else:
        raise ValueError("Unknown rule")
    if next_node.writes > case.effect_cap and "shared effects" not in skip:
        return None
    if next_node.lost_state and case.result_bound < 41 and "result" not in skip:
        return None
    return replace(next_node, chain=node.chain + (rule,))


def bounded_search(case, places, skip=frozenset()):
    start = SearchNode(case.terminal, case.memory)
    pending = [start]
    variants = []
    while pending:
        node = pending.pop(0)
        variants.append(node)
        if len(node.chain) < 2:
            for rule in SEARCH_RULES:
                child = expand_rule(case, node, rule, skip)
                if child is not None:
                    pending.append(child)
    feasible = set()
    for node in variants:
        needs = {"pty" if node.terminal else "pipe"}
        if node.memory:
            needs.add("memory")
        if node.file_pause:
            needs.add("file")
        for name, guarantees, cost, duration in places:
            if needs <= guarantees and cost + node.work <= case.cost_cap and duration + node.work <= case.deadline:
                feasible.add((node.chain, name, cost + node.work, duration + node.work))
    return frozenset(feasible)


def brute_force_oracle(case, places):
    """Enumerate words, execute their conversions, and check every prefix.

    This deliberately does not call the search transition or filter. Four
    input pairs supply the complete input set for this finite task family.
    """
    feasible = set()
    for length in range(3):
        for word in product(SEARCH_RULES, repeat=length):
            mode = "terminal" if case.terminal else "pipe"
            saved = "memory" if case.memory else "none"
            output_keeps_value = True
            effects = []
            extra_time = 0
            valid = True
            for operation in word:
                if case.phase == "closed":
                    valid = False
                    break
                if operation == "batch":
                    if mode != "terminal" or not case.batch_known:
                        valid = False
                        break
                    mode = "pipe"
                    effects.append("write batch file")
                    extra_time += 1
                elif operation == "checkpoint":
                    if saved != "memory" or not case.full_state:
                        valid = False
                        break
                    saved = "file"
                    effects.append("write state file")
                    extra_time += 1
                else:
                    if saved != "memory":
                        valid = False
                        break
                    saved = "none"
                    output_keeps_value = False
                # All prefixes must fit the same bound, even if the run stops.
                for prefix in range(len(effects) + 1):
                    if prefix > case.effect_cap:
                        valid = False
                for value, added in product((0, 41), (1, 2)):
                    result = (value if output_keeps_value else 0) + added
                    if abs(result - (value + added)) > case.result_bound:
                        valid = False
            if not valid:
                continue
            for name, guarantees, price, duration in places:
                if mode == "terminal" and "pty" not in guarantees:
                    continue
                if mode == "pipe" and "pipe" not in guarantees:
                    continue
                if saved == "memory" and "memory" not in guarantees:
                    continue
                if saved == "file" and "file" not in guarantees:
                    continue
                if price + extra_time > case.cost_cap:
                    continue
                if duration + extra_time > case.deadline:
                    continue
                feasible.add((word, name, price + extra_time, duration + extra_time))
    return frozenset(feasible)


def first_pair(pairs):
    # A chain is the final tie break when two chains use the same place.
    return min(pairs, key=lambda item: (item[2], item[3], len(item[0]), item[1], item[0]), default=None)


@dataclass(frozen=True)
class PhaseLease:
    epoch: int
    revision: int
    policy_revision: int
    expires: int
    phase: str = "claimed"


@dataclass(frozen=True)
class PhaseMachine:
    clock: int = 0
    revision: int = 1
    policy_revision: int = 1
    allowed: bool = True
    capacity: bool = True
    next_epoch: int = 1
    lease: PhaseLease | None = None
    effects: tuple[str, ...] = ()

    def claim(self, planned_revision=1, planned_policy=1):
        live = self.lease is not None and self.lease.phase not in ("released", "ended") and self.clock < self.lease.expires
        if planned_revision != self.revision or planned_policy != self.policy_revision or not self.allowed or not self.capacity or live:
            return self, None
        lease = PhaseLease(self.next_epoch, self.revision, self.policy_revision, self.clock + 2)
        return replace(self, next_epoch=self.next_epoch + 1, lease=lease), lease

    def permits(self, token, phase):
        return (
            token is not None
            and self.lease is not None
            and token.epoch == self.lease.epoch
            and self.lease.phase == phase
            and self.clock < self.lease.expires
            and self.revision == self.lease.revision
            and self.policy_revision == self.lease.policy_revision
            and self.allowed
        )

    def action(self, token, action):
        if action == "stage" and self.permits(token, "claimed"):
            return replace(self, lease=replace(self.lease, phase="staged"), effects=self.effects + ("stage",))
        if action == "run" and self.permits(token, "staged"):
            return replace(self, lease=replace(self.lease, phase="running"), effects=self.effects + ("run",))
        if action == "finish" and self.permits(token, "running"):
            return replace(self, lease=replace(self.lease, phase="ended"))
        if action == "release" and token is not None and self.lease is not None and token.epoch == self.lease.epoch and self.lease.phase != "released":
            return replace(self, lease=replace(self.lease, phase="released"))
        return self


def compute_extended_checks(checks):
    start_count = checks.count
    cases = 0
    empty = 0
    total_pairs = 0
    for flags in product((False, True), repeat=4):
        for phase, effect_cap, result_bound, cost_cap, deadline, place_mask in product(
            ("ready", "closed"), range(3), (0, 41), (1, 3, 5), (2, 4), range(8)
        ):
            case = SearchCase(*flags, phase, effect_cap, result_bound, cost_cap, deadline)
            places = tuple(place for index, place in enumerate(SEARCH_PLACES) if place_mask & (1 << index))
            actual = bounded_search(case, places)
            expected = brute_force_oracle(case, places)
            checks.equal("compute bounded search finds the full oracle set", actual, expected)
            checks.equal("compute bounded search gives the oracle first pair", first_pair(actual), first_pair(expected))
            cases += 1
            empty += not actual
            total_pairs += len(actual)

    # Each bad choice is made by the same selector with one check removed.
    ablations = []
    fixtures = [
        ("precondition", SearchCase(True, False, False, True, "ready", 2, 0, 5, 4), (SEARCH_PLACES[1],)),
        ("phase", SearchCase(True, False, True, True, "closed", 2, 0, 5, 4), (SEARCH_PLACES[1],)),
        ("result", SearchCase(False, True, True, True, "ready", 2, 0, 5, 4), (SEARCH_PLACES[2],)),
        ("shared effects", SearchCase(True, True, True, True, "ready", 1, 0, 5, 4), (SEARCH_PLACES[1],)),
    ]
    for removed, case, places in fixtures:
        safe = bounded_search(case, places)
        unsafe = bounded_search(case, places, frozenset((removed,)))
        checks.equal("compute full checks reject the ablation fixture", len(safe), 0)
        checks.that("compute one missing check admits a bad pair", bool(unsafe))
        choice = first_pair(unsafe)
        ablations.append({"removed_check": removed, "chain": list(choice[0]), "place": choice[1], "false_admissions": len(unsafe)})
    checks.that("compute two small writes each fit the cap", all(write <= 1 for write in (1, 1)))
    checks.that("compute both writes break the shared cap", sum((1, 1)) > 1)

    # The selector cannot prove the behavior of an arbitrary source program.
    # An identity adapter preserves a bad source trace as well as a good one.
    source_case = SearchCase(False, False, True, True, "ready", 0, 0, 5, 4)
    source_match = bounded_search(source_case, (SEARCH_PLACES[0],))
    source_effects = []

    def run_bad_source():
        source_effects.append("send forbidden message")
        return 42

    checks.that("compute a declared manifest has a matching identity variant", bool(source_match))
    checks.equal("compute a bad source can still give the right result", run_bad_source(), 42)
    checks.equal("compute identity keeps the source forbidden effect", source_effects, ["send forbidden message"])
    checks.that("compute a bad source violates its zero effect bound", len(source_effects) > source_case.effect_cap)

    denied = 0
    for revision, policy, capacity in product((1, 2), (False, True), (False, True)):
        state = PhaseMachine(revision=revision, allowed=policy, capacity=capacity)
        claimed, token = state.claim()
        after = claimed.action(token, "stage").action(token, "run")
        should_claim = revision == 1 and policy and capacity
        checks.equal("compute claim result meets its snapshot", token is not None, should_claim)
        checks.equal("compute denied claim starts no action", len(after.effects), 2 if should_claim else 0)
        denied += not should_claim

    state, old_token = PhaseMachine().claim()
    expired = replace(state, clock=2)
    current, new_token = expired.claim()
    checks.that("compute a new claim has a larger epoch", new_token.epoch > old_token.epoch)
    checks.equal("compute old epoch cannot stage after a new claim", current.action(old_token, "stage"), current)
    checks.equal("compute old epoch cannot run after a new claim", current.action(old_token, "run"), current)
    checks.equal("compute old release cannot free a new claim", current.action(old_token, "release"), current)
    current = current.action(new_token, "stage").action(new_token, "run")
    checks.equal("compute current epoch can stage and run", current.effects, ("stage", "run"))
    released = current.action(new_token, "release")
    checks.equal("compute duplicate release has no effect", released.action(new_token, "release"), released)
    for mutation in (replace(state, revision=2), replace(state, policy_revision=2), replace(state, allowed=False), expired):
        checks.equal("compute changed facts block an unstarted phase", mutation.action(old_token, "stage").effects, ())
    staged = state.action(old_token, "stage")
    for mutation in (replace(staged, revision=2), replace(staged, policy_revision=2), replace(staged, allowed=False), replace(staged, clock=2)):
        checks.equal("compute changed facts block the run boundary", mutation.action(old_token, "run").effects, ("stage",))

    alphabet = ("claim", "stage", "run", "release", "tick", "revision", "deny", "finish")
    histories = 0
    transitions = 0
    rejected_actions = 0
    allowed_actions = 0
    for history in product(alphabet, repeat=4):
        state = PhaseMachine()
        token = None
        for event in history:
            before = state
            if event == "claim":
                state, next_token = state.claim()
                if next_token is not None:
                    token = next_token
            elif event == "tick":
                state = replace(state, clock=state.clock + 1)
            elif event == "revision":
                state = replace(state, revision=state.revision + 1)
            elif event == "deny":
                state = replace(state, allowed=False, policy_revision=state.policy_revision + 1)
            else:
                state = state.action(token, event)
            if event in ("stage", "run"):
                required_phase = "claimed" if event == "stage" else "staged"
                expected = False
                if token is not None and before.lease is not None:
                    # A separate check of action authority; do not call permits.
                    expected = all((
                        token.epoch == before.lease.epoch,
                        before.lease.phase == required_phase,
                        before.clock < before.lease.expires,
                        before.revision == before.lease.revision,
                        before.policy_revision == before.lease.policy_revision,
                        before.allowed,
                    ))
                checks.equal("compute every action boundary checks the live lease", len(state.effects) - len(before.effects), int(expected))
                allowed_actions += expected
                rejected_actions += not expected
            checks.equal("compute action records only grow by appending", state.effects[:len(before.effects)], before.effects)
            transitions += 1
        histories += 1
    return {
        "fixture": "bounded search and phase lease",
        "checks": checks.count - start_count,
        "search": {
            "case_count": cases,
            "input_pairs_per_variant": 4,
            "max_chain_length": 2,
            "catalog_size": 3,
            "words_per_case": 13,
            "no_placement_cases": empty,
            "feasible_pairs_over_all_cases": total_pairs,
            "false_admissions": 0,
            "false_rejections": 0,
            "ablations": ablations,
        },
        "base_procedure_counterexample": {
            "matching_identity_variant": True,
            "result": 42,
            "forbidden_effects": len(source_effects),
            "lesson": "The source procedure must already meet its result and effect contract. Matching a declared manifest cannot prove arbitrary source code safe.",
        },
        "lease": {
            "claim_cases": 8,
            "denied_claims": denied,
            "history_length": 4,
            "action_kinds": len(alphabet),
            "histories": histories,
            "transitions": transitions,
            "allowed_stage_or_run": allowed_actions,
            "rejected_stage_or_run": rejected_actions,
            "effects_from_rejected_actions": 0,
            "stale_epoch_effects": 0,
        },
        "scope": "The finite search uses exact model facts and four input pairs. The lease fixes one task, variant, and environment; it uses an atomic guard and a trusted clock. No provider, network delay, cost, or isolation boundary is measured.",
    }



def compute_experiment(seed_count):
    checks = Checks()
    extended = compute_extended_checks(checks)
    common = {"pipe", "binary files", "linux", "x86"}
    places = [
        Place("M", frozenset(common | {"pty", "resize", "desktop", "file pause", "memory pause"}), False, Fraction(13), 38, 0),
        Place("F", frozenset(common | {"desktop", "file pause"}), False, Fraction(38, 5), 40, 4),
        Place("H", frozenset(common | {"pty", "resize"}), True, Fraction(1), 38, 0),
    ]
    m, f, h = places
    checks.equal("compute M retains memory", resume_value(m), 42)
    checks.equal("compute F loses memory", resume_value(f), None)
    checkpoint = {"value": 41, "digest": "input-one", "schema": 1, "phase": "add"}
    checks.equal("compute F resumes from a full checkpoint", resume_value(f, checkpoint), 42)
    for key in checkpoint:
        broken = dict(checkpoint)
        del broken[key]
        checks.equal("compute incomplete checkpoint fails", resume_value(f, broken), None)
    for key, value in [("digest", "other"), ("schema", 2), ("phase", "done")]:
        checks.equal("compute wrong checkpoint fails", resume_value(f, dict(checkpoint, **{key: value})), None)

    families = [
        Task("batch", frozenset({"pipe", "binary files"})),
        Task("terminal", frozenset({"pty", "resize"})),
        Task("desktop", frozenset({"desktop"})),
        Task("review gap", frozenset({"memory pause"})),
        Task("private files", frozenset({"binary files"})),
    ]
    admitted = {task.name: [place.name for place in places if not reasons(task, place)] for task in families}
    checks.equal("compute family matches honor semantics", admitted, {
        "batch": ["M", "F"], "terminal": ["M"], "desktop": ["M", "F"],
        "review gap": ["M"], "private files": ["M", "F"],
    })
    checks.equal("compute absent CPU gives no placement", choose([Task("other CPU", frozenset({"arm"}))], places), None)
    checks.equal("compute old evidence cannot admit", choose([families[0]], [replace(f, evidence_valid=False)]), None)
    original = Task("report", frozenset({"pty", "memory pause", "binary files"}), cap=Fraction(10), minutes=45)
    adapted = replace(original, needs=frozenset({"pipe", "file pause", "binary files"}), changes=("batch", "checkpoint"))
    checks.equal("compute original has no match under cap", choose([original], places), None)
    selected = choose([original, adapted], places)
    checks.equal("compute approved checkpoint selects F", (selected[0].changes, selected[1].name), (("batch", "checkpoint"), "F"))
    checks.equal("compute M illustrative cost", 2 + 8 * Fraction(1) + 30 * Fraction(1, 10), m.cost)
    checks.equal("compute F illustrative cost", 1 + 10 * Fraction(1, 2) + 30 * Fraction(2, 100) + 1, f.cost)
    checks.equal("compute faster return leaves no match", choose([replace(original, restore_seconds=1), replace(adapted, restore_seconds=1)], places), None)
    cheapest_boolean_pause = min([m, f], key=lambda place: place.cost)
    checks.equal("compute Boolean pause chooses losing state", cheapest_boolean_pause.name, "F")
    checks.equal("compute Boolean pause gives no result", resume_value(cheapest_boolean_pause), None)

    data = bytes([0, 10, 255])
    file_map = {"input": data}
    file_map["copy"] = bytes.fromhex(file_map["input"].hex())
    checks.equal("compute model binary round trip", file_map["copy"], data)
    old_rectangle = (100, 100, 40, 20)
    new_rectangle = (400, 300, 40, 20)
    old_point = (old_rectangle[0] + old_rectangle[2] // 2, old_rectangle[1] + old_rectangle[3] // 2)
    new_point = (new_rectangle[0] + new_rectangle[2] // 2, new_rectangle[1] + new_rectangle[3] // 2)
    x, y, width, height = new_rectangle
    checks.that("compute stale pixel misses moved object", not (x <= old_point[0] < x + width and y <= old_point[1] < y + height))
    checks.that("compute fresh pixel reaches moved object", x <= new_point[0] < x + width and y <= new_point[1] < y + height)
    checks.equal("compute failed claim has no stage", claim_trace(1, 2), ["planned", "claim failed"])
    checks.equal("compute full claim releases its lease", claim_trace(1, 1), ["planned", "claimed", "stage input", "run", "ended", "release"])
    checks.equal("compute rejected owner policy has no stage", claim_trace(1, 1, allowed=False), ["planned", "claim failed"])
    safe = ["read input", "write checkpoint", "write result", "remove checkpoint"]
    for end in range(len(safe) + 1):
        checks.that("compute cancelled safe prefix stays within bounds", safe_prefixes(safe[:end]))
    checks.that("compute failure cannot erase forbidden send", not safe_prefixes(["write checkpoint", "send message"]))

    rejected_claims = 0
    random_prefixes = 0
    for seed in range(seed_count):
        rng = Random(seed + 14000)
        shuffled = places.copy()
        rng.shuffle(shuffled)
        choice = choose([adapted, original], shuffled)
        checks.equal("compute input order does not change placement", choice[1].name, "F")
        revision = rng.choice([1, 2, 3])
        capacity = rng.choice([False, True])
        trace = claim_trace(1, revision, capacity=capacity)
        if revision != 1 or not capacity:
            rejected_claims += 1
            checks.that("compute random failed claim has no effects", "stage input" not in trace and "run" not in trace)
        else:
            checks.that("compute random claim precedes staging", trace.index("claimed") < trace.index("stage input"))
        stop = rng.randrange(len(safe) + 1)
        checks.that("compute random safe failure keeps bounds", safe_prefixes(safe[:stop]))
        trace = safe[:stop] + ["send message"] + safe[stop:]
        checks.that("compute forbidden effect fails a prefix", not safe_prefixes(trace[:stop + 1]))
        random_prefixes += 2

    return {
        "paper_id": "14",
        "title": "Capability-Aware Portability of Agent Tasks Across Compute Environments",
        "checks": checks.count,
        "seeds": seed_count,
        "seed_offset": 14000,
        "observations": [
            extended,
            {"fixture": "pause memory", "M_native_result": resume_value(m), "F_native_result": resume_value(f), "F_checkpoint_result": resume_value(f, checkpoint)},
            {"fixture": "task families", "admitted": admitted},
            {"fixture": "illustrative placement", "selected": selected[1].name, "cost": float(selected[1].cost), "minutes": selected[1].minutes, "changes": list(selected[0].changes)},
            {"fixture": "claim and effect traces", "random_rejected_claims": rejected_claims, "random_prefixes": random_prefixes},
        ],
        "limitations": [
            "These are the paper's abstract M, F, and H profiles, not measured provider guarantees.",
            "The search covers three rules, chains of length at most two, and four input pairs. It does not prove result equivalence for arbitrary programs.",
            "No cloud sandbox, real desktop, isolation boundary, terminal, or billed cost was measured here.",
            "The product's current Boolean pause feature and adapter tests do not implement or validate this proposed selector.",
            "Random trials vary model event order and claim failure. They are not the planned thirty paired live task trials.",
        ],
    }


def run(seed_count: int) -> list[dict]:
    return [voice_experiment(seed_count), compute_experiment(seed_count)]
