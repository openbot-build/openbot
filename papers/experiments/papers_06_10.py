"""Finite paper models. These checks do not call the product or a model service."""

from __future__ import annotations

import base64
import json
import itertools
import random
import re
from urllib.parse import quote

from support import Checks


def record(paper_id, title, checks, observations, limitations, seeds=0):
    return {
        "paper_id": paper_id,
        "title": title,
        "checks": checks.count,
        "observations": observations,
        "limitations": limitations,
        "seeds": seeds,
    }


# A policy is (organizations, contributors, audience tokens).
def can_read(policy, viewer):
    organizations, people, tokens = policy
    organization, kind, who = viewer
    if organization not in organizations:
        return False
    return any(
        token == "all"
        or token == "person:" + who and kind == "private"
        or token.startswith("group:")
        and (kind == "group" and token == "group:" + who or kind == "private" and who in people)
        for token in tokens
    )


def token_join(left, right):
    tokens = frozenset(
        b if a == "all" else a
        for a in left[2]
        for b in right[2]
        if a == b or a == "all" or b == "all"
    )
    return left[0] & right[0], left[1] | right[1], tokens


def source_rule_read(sources, viewer):
    # Keep each source policy. A shared token does not merge its people.
    for organizations, people, tokens in sources:
        if viewer[0] not in organizations:
            return False
        allowed = False
        for token in tokens:
            if token == "all":
                allowed = True
            elif token.startswith("person:"):
                allowed |= viewer[1:] == ("private", token[7:])
            elif token.startswith("group:"):
                allowed |= viewer[1:] == ("group", token[6:])
                allowed |= viewer[1] == "private" and viewer[2] in people
        if not allowed:
            return False
    return True


def memory(seed_count):
    checks = Checks()
    tokens = ("all", "person:Ana", "person:Bob", "group:g1", "group:g2")
    roots = [
        (frozenset([organization]), frozenset([person]), frozenset(tokens[i] for i in range(5) if mask & 1 << i))
        for organization in ("o1", "o2")
        for person in ("Ana", "Bob")
        for mask in range(1, 32)
    ]
    viewers = [(organization, kind, who) for organization in ("o1", "o2") for kind, who in (("private", "Ana"), ("private", "Bob"), ("group", "g1"), ("group", "g2"))]
    readers = [frozenset(i for i, viewer in enumerate(viewers) if can_read(root, viewer)) for root in roots]
    unsafe = 0
    rejected = 0
    permitted = 0
    corrected_unsafe = 0
    corrected_lost = 0
    for a, left in enumerate(roots):
        for b, right in enumerate(roots):
            joined = token_join(left, right)
            expected = readers[a] & readers[b]
            actual = frozenset(i for i, viewer in enumerate(viewers) if can_read(joined, viewer))
            unsafe += len(actual - expected)
            rejected += len(expected - actual)
            permitted += len(expected)
            corrected = frozenset(i for i, viewer in enumerate(viewers) if source_rule_read((left, right), viewer))
            corrected_unsafe += len(corrected - expected)
            corrected_lost += len(expected - corrected)
            checks.equal("source clauses match the pair oracle", corrected, expected)
            checks.that("group reads preserve all source rules", all(viewers[i][1] == "private" for i in actual - expected))
    a = (frozenset(["o1"]), frozenset(["Ana"]), frozenset(["group:g1"]))
    b = (frozenset(["o1"]), frozenset(["Bob"]), frozenset(["group:g1"]))
    viewer = ("o1", "private", "Ana")
    checks.equal("Ana can read only her source", [can_read(a, viewer), can_read(b, viewer)], [True, False])
    checks.equal("token join admits Ana", can_read(token_join(a, b), viewer), True)
    checks.that("the finite baseline has unsafe reads", unsafe > 0)
    graph_nodes = 0
    changed_nodes = 0
    stale_reads = 0
    withdrawal_checks = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        policies = rng.sample(roots, 8)
        edges = [()] * 8
        cached = [frozenset(i for i, viewer in enumerate(viewers) if can_read(root, viewer)) for root in policies]
        for node in range(8, 48):
            parents = tuple(rng.sample(range(node), rng.randrange(1, min(node, 4) + 1)))
            edges.append(parents)
            cached.append(frozenset.intersection(*(cached[parent] for parent in parents)))
            # Walk the graph from the requested node. Do not use its policy cache.
            todo, found = [node], set()
            while todo:
                current = todo.pop()
                if edges[current]:
                    todo.extend(edges[current])
                else:
                    found.add(current)
            oracle = frozenset(i for i, viewer in enumerate(viewers) if all(can_read(policies[root], viewer) for root in found))
            checks.equal("derived reads match each root", cached[node], oracle)
            graph_nodes += 1
        # Follow reverse edges to remove a root. Compare with a fresh root walk.
        removed = rng.randrange(8)
        reverse = [[] for _ in edges]
        for child, parents in enumerate(edges):
            for parent in parents:
                reverse[parent].append(child)
        affected, pending = set(), [removed]
        while pending:
            current = pending.pop()
            if current not in affected:
                affected.add(current)
                pending.extend(reverse[current])
        changed_nodes += len(affected)
        after = list(cached)
        after[removed] = frozenset()
        for node in sorted(affected):
            if edges[node]:
                after[node] = frozenset.intersection(*(after[parent] for parent in edges[node]))
        for node in range(len(edges)):
            todo, found = [node], set()
            while todo:
                current = todo.pop()
                if edges[current]:
                    todo.extend(edges[current])
                else:
                    found.add(current)
            expected = frozenset() if removed in found else frozenset(i for i, viewer in enumerate(viewers) if all(can_read(policies[root], viewer) for root in found))
            checks.equal("reverse removal matches a fresh root walk", after[node], expected)
            stale_reads += len(cached[node] - expected)
            withdrawal_checks += 1
    # A policy barrier and a prepared output have different versions.
    state = {"version": 1, "blocked": False, "outputs": []}
    ticket = state["version"]
    state.update(version=2, blocked=True)
    accepted = ticket == state["version"] and not state["blocked"]
    if accepted:
        state["outputs"].append("old output")
    checks.equal("a stale output stays out after removal", state["outputs"], [])
    return record("06", "Shared memory source rules", checks, [
        {"root_policies": len(roots), "source_pairs": len(roots) ** 2, "viewers": len(viewers), "pair_read_decisions": len(roots) ** 2 * len(viewers), "oracle_permitted_reads": permitted, "baseline_unsafe_reads": unsafe, "baseline_permitted_reads_lost": rejected, "source_rule_unsafe_reads": corrected_unsafe, "source_rule_permitted_reads_lost": corrected_lost},
        {"withdrawal_node_checks": withdrawal_checks, "withdrawal_changed_nodes": changed_nodes, "no_withdrawal_propagation_stale_reads": stale_reads, "source_rule_stale_reads": 0},
        {"source_graph_nodes": graph_nodes, "baseline_Ana_read": True, "source_rule_Ana_read": False, "stale_output_accepted": accepted},
        {"product_review": "The token baseline is defined in this model. Product checks run apart from this model."},
    ], ["This is a finite policy model. It does not prove product memory privacy.", "No model attacks, release authority, real purge race, or hidden metadata check runs here."], seed_count)


def closed_boundary(messages, recent):
    first = {}
    for i in range(len(messages) - 1, -1, -1):
        for key in messages[i]:
            first[key] = i
    boundary = max(0, len(messages) - recent)
    for i in range(len(messages) - 1, -1, -1):
        if i >= boundary:
            for key in messages[i]:
                boundary = min(boundary, first[key])
    return boundary


def boundary_oracle(messages, recent):
    passing = []
    for boundary in range(max(0, len(messages) - recent) + 1):
        before = set().union(*messages[:boundary]) if boundary else set()
        after = set().union(*messages[boundary:]) if boundary < len(messages) else set()
        if not before & after:
            passing.append(boundary)
    return max(passing)


def interval_boundary(messages, recent):
    # A cut is invalid exactly when it lies inside one key's span.
    spans = {}
    for position, message in enumerate(messages):
        for key in message:
            spans.setdefault(key, []).append(position)
    start = max(0, len(messages) - recent)
    return max(cut for cut in range(start + 1) if all(not (min(positions) < cut <= max(positions)) for positions in spans.values()))


def one_step_boundary(messages, recent):
    cut = max(0, len(messages) - recent)
    keys = set().union(*messages[cut:]) if cut < len(messages) else set()
    return min([cut] + [i for i, message in enumerate(messages) if message & keys])


def split_keys(messages, cut):
    before = set().union(*messages[:cut]) if cut else set()
    after = set().union(*messages[cut:]) if cut < len(messages) else set()
    return len(before & after)


def compaction(seed_count):
    checks = Checks()
    linked = [set(), {"call:a"}, {"call:b", "approval:p"}, {"call:a", "approval:p"}, {"call:b"}, set()]
    checks.equal("transitive links move to the first call", closed_boundary(linked, 2), 1)
    first = {key: next(i for i, message in enumerate(linked) if key in message) for message in linked for key in message}
    one_step = min([4] + [first[key] for message in linked[4:] for key in message])
    checks.equal("one move misses a linked call", one_step, 2)
    checks.equal("approval bridge reaches zero", closed_boundary([{"call:c"}, {"call:c", "approval:p"}, {"approval:p"}], 1), 0)
    checks.equal("call and approval names stay apart", closed_boundary([{"call:x"}, set(), {"approval:x"}], 1), 2)
    history = ["m" + str(i) for i in range(10)]
    boundary = closed_boundary([set()] * 10, 8)
    current = ["s1"] + history[boundary:] + ["m10", "m11"]
    again = closed_boundary([set()] * len(current), 8)
    checks.equal("old summary joins the next prefix", current[:again], ["s1", "m2", "m3"])
    checks.equal("the next tail has eight messages", current[again:], ["m" + str(i) for i in range(4, 12)])
    exhaustive = 0
    exhaustive_histories = 0
    for length in range(6):
        for bits in itertools.product(range(4), repeat=length):
            messages = [{key for key in range(2) if value & 1 << key} for value in bits]
            previous = length
            exhaustive_histories += 1
            for recent in range(length + 1):
                cut = closed_boundary(messages, recent)
                checks.equal("closure matches key-span oracle", cut, interval_boundary(messages, recent))
                checks.equal("closure is idempotent", closed_boundary(messages, length - cut), cut)
                checks.that("more recent messages cannot move the cut right", cut <= previous)
                previous = cut
                exhaustive += 1
    generated = 0
    methods = {name: {"split_histories": 0, "split_keys": 0, "kept_messages": 0} for name in ("recent_window", "one_step", "closure")}
    for seed in range(seed_count):
        rng = random.Random(seed)
        for _ in range(40):
            length = rng.randrange(0, 45)
            messages = [set() for _ in range(length)]
            for key in range(rng.randrange(0, 25)):
                if length:
                    for position in rng.sample(range(length), rng.randrange(1, min(length, 5) + 1)):
                        messages[position].add(("call:" if key % 2 else "approval:") + str(key))
            recent = rng.randrange(0, length + 5)
            checks.equal("scan matches all-boundary oracle", closed_boundary(messages, recent), boundary_oracle(messages, recent))
            cuts = (max(0, length - recent), one_step_boundary(messages, recent), closed_boundary(messages, recent))
            for (name, totals), cut in zip(methods.items(), cuts):
                splits = split_keys(messages, cut)
                totals["split_histories"] += splits > 0
                totals["split_keys"] += splits
                totals["kept_messages"] += length - cut
            generated += 1
    saved = {"revision": 7, "window": ["old"]}
    ticket = saved["revision"]
    saved["window"].append("new")
    saved["revision"] += 1
    if ticket == saved["revision"]:
        saved["window"] = ["summary"]
    checks.equal("a stale summary keeps the new input", saved, {"revision": 8, "window": ["old", "new"]})
    checks.equal("the paper example leaves 550 tokens", 8000 - 1200 - 6200 - 50, 550)
    checks.that("the smaller target cannot fit the fixed tail", 7000 < 1200 + 6200 + 50)
    return record("07", "Context link closure", checks, [
        {"closed_boundary": 1, "one_step_boundary": one_step, "random_traces": generated, "second_summary_source": current[:again]},
        {"exhaustive_histories": exhaustive_histories, "exhaustive_boundary_cases": exhaustive, "keys": 2, "max_history_length": 5},
        {"seeded_baselines": methods, "seeded_histories": generated},
    ], ["The model checks link sets, not provider message validity or complete tool execution.", "No summary model, semantic retention, exact provider token count, or real database race runs here."], seed_count)


class ReplayModel:
    """A finite frame model. Tool effects are kept apart from local replay."""

    def __init__(self, manifest):
        self.manifest = manifest
        self.frames = []
        self.outcomes = {}
        self.sends = []

    def attempt(self, manifest, frames, effects, stop_after=None, decisions=None):
        if manifest != self.manifest:
            return "manifest mismatch"
        for frame_index, frame in enumerate(frames):
            if frame_index < len(self.frames):
                if frame != self.frames[frame_index]:
                    return "frame mismatch"
            else:
                self.frames.append(frame)
            for call in frame:
                if call not in self.outcomes:
                    decision = (decisions or {}).get(call, "allow")
                    if decision == "open":
                        return "waiting"
                    if decision == "deny":
                        self.outcomes[call] = {"error": "ApprovalDenied"}
                        continue
                    self.sends.append(call)
                    self.outcomes[call] = effects[call]
                    if stop_after == len(self.sends):
                        return "stopped"
        return "done" if len(frames) == len(self.frames) else "unread history"


class PositionalReplayModel:
    """A baseline that checks saved call positions but not the local manifest."""

    def __init__(self):
        self.entries = {}
        self.sends = []

    def attempt(self, manifest, frames, effects):
        for frame in frames:
            for call in frame:
                position = call[0]
                if position in self.entries:
                    saved_call, _ = self.entries[position]
                    if saved_call != call:
                        return "call mismatch"
                else:
                    self.sends.append(call)
                    self.entries[position] = call, effects[call]
        return "done"


def replay(seed_count):
    checks = Checks()
    read_a, read_b, write = (0, "read", "one"), (1, "read", "two"), (2, "write", "Plan:1000")
    frames = [(read_a, read_b), (write,)]
    engine = ReplayModel(("program", "read:v1", "write:v1", 1000, 7))
    effects = {read_a: {"title": "Plan", "share": True}, read_b: {"title": "Draft", "share": False}, write: "ok"}
    checks.equal("the reads end before the decision", engine.attempt(engine.manifest, frames, effects, decisions={write: "open"}), "waiting")
    checks.equal("the open decision has no write", engine.sends, [read_a, read_b])
    effects[read_a] = {"title": "Changed", "share": True}
    checks.equal("the allowed run returns", engine.attempt(engine.manifest, frames, effects), "done")
    checks.equal("replay keeps the reviewed title", engine.outcomes[read_a]["title"], "Plan")
    checks.equal("ended calls are not sent twice", engine.sends, [read_a, read_b, write])
    checks.equal("early return leaves unread history", engine.attempt(engine.manifest, [], effects), "unread history")
    checks.equal("a changed tool identity stops replay", engine.attempt(("other",), frames, effects), "manifest mismatch")
    checks.equal("a changed batch stops replay", engine.attempt(engine.manifest, [(read_a,), (read_b,), (write,)], effects), "frame mismatch")
    checks.equal("key sorting removes insertion order", json.dumps({"b": 2, "a": 1}, sort_keys=True), json.dumps({"a": 1, "b": 2}, sort_keys=True))
    checks.that("plain encoding keeps insertion order", json.dumps({"b": 2, "a": 1}) != json.dumps({"a": 1, "b": 2}))
    # The decision is an input. Denial delivers an error and performs no write.
    denied = ReplayModel(engine.manifest)
    checks.equal("a denied frame can finish", denied.attempt(denied.manifest, frames, effects, decisions={write: "deny"}), "done")
    checks.equal("denial has no outside write", denied.sends, [read_a, read_b])
    checks.equal("denial delivers the typed error", denied.outcomes[write], {"error": "ApprovalDenied"})
    mutations = (
        ("changed_manifest", ("other",), frames),
        ("split_frame", engine.manifest, [(read_a,), (read_b,), (write,)]),
        ("merged_frame", engine.manifest, [(read_a, read_b, write)]),
        ("early_return", engine.manifest, []),
    )
    comparison = []
    for name, manifest, changed in mutations:
        baseline = PositionalReplayModel()
        baseline.attempt(engine.manifest, frames, effects)
        strict = ReplayModel(engine.manifest)
        strict.attempt(engine.manifest, frames, effects)
        baseline_result = baseline.attempt(manifest, changed, effects)
        strict_result = strict.attempt(manifest, changed, effects)
        checks.equal("positional baseline accepts the changed replay", baseline_result, "done")
        checks.that("strong replay rejects the changed replay", strict_result != "done")
        checks.equal("rejected replay sends no extra tool calls", strict.sends, [read_a, read_b, write])
        comparison.append({"mutation": name, "positional": baseline_result, "strong": strict_result})
    schedules = 0
    all_cuts = 0
    plain_duplicate_sends = 0
    strong_sends = 0
    plain_sends = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        calls = [(i, "read", str(i)) for i in range(rng.randrange(4, 25))]
        width = rng.choice([1, 4, 8])
        plan = [tuple(calls[i:i + width]) for i in range(0, len(calls), width)]
        values = {call: rng.randrange(1000) for call in calls}
        trial = ReplayModel(("fixed", seed))
        stop = rng.randrange(1, len(calls) + 1)
        checks.equal("a saved outcome can stop delivery", trial.attempt(trial.manifest, plan, values, stop), "stopped")
        checks.equal("restart completes the same frames", trial.attempt(trial.manifest, plan, values), "done")
        checks.equal("fault schedule sends each ended call once", trial.sends, calls)
        checks.equal("fault schedule returns the fixed values", [trial.outcomes[call] for call in calls], [values[call] for call in calls])
        schedules += 1
        for cut in range(1, len(calls) + 1):
            trial = ReplayModel(("fixed", seed))
            checks.equal("each saved-outcome cut stops", trial.attempt(trial.manifest, plan, values, cut), "stopped")
            checks.equal("each saved-outcome cut resumes", trial.attempt(trial.manifest, plan, values), "done")
            checks.equal("each saved-outcome cut has no duplicate sends", trial.sends, calls)
            plain = calls[:cut] + calls
            checks.equal("plain restart repeats the ended prefix", len(plain) - len(set(plain)), cut)
            plain_duplicate_sends += cut
            strong_sends += len(trial.sends)
            plain_sends += len(plain)
            all_cuts += 1
    # These worlds have the same local receipt log after a lost reply.
    unknown_worlds = [(False, []), (True, [])]
    checks.equal("a lost reply leaves equal local logs", unknown_worlds[0][1], unknown_worlds[1][1])
    retry_effects = [int(happened) + 1 for happened, _ in unknown_worlds]
    hold_effects = [int(happened) for happened, _ in unknown_worlds]
    checks.equal("blind retry can repeat an outside effect", retry_effects, [1, 2])
    checks.equal("no retry can leave the work undone", hold_effects, [0, 1])
    return record("08", "Replay frame model", checks, [
        {"reads_sent": 2, "writes_sent_after_allow": 1, "writes_sent_after_deny": 0, "fault_schedules": schedules},
        {"replay_mutations": comparison, "strong_rejections": len(comparison), "positional_rejections": 0},
        {"all_saved_outcome_cuts": all_cuts, "strong_sends": strong_sends, "plain_restart_sends": plain_sends, "plain_restart_duplicate_sends": plain_duplicate_sends, "strong_duplicate_sends": 0},
        {"unknown_world_count": 2, "blind_retry_effects": retry_effects, "no_retry_effects": hold_effects},
        {"product_review": "This frame model does not run a language interpreter. Product replay needs separate tests."},
    ], ["This is a finite frame model, not a JavaScript interpreter or product replay test.", "A send before durable outcome storage is unknown and is outside these no-resend checks.", "No model generation, repair, timing, or token-cost study runs here."], seed_count)


REFERENCE = re.compile(r"⟦vault:([a-z][a-z0-9_]*)/([^/⟦⟧\x00-\x1f]{1,64})⟧")


def substitute(value, secrets):
    if isinstance(value, str):
        return REFERENCE.sub(lambda match: secrets[match[1] + "/" + match[2]], value)
    if isinstance(value, list):
        return [substitute(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: substitute(item, secrets) for key, item in value.items()}
    return value


def forms(value):
    raw = value.encode("utf-8")
    encoded = base64.b64encode(raw).decode()
    values = [value, encoded, encoded.rstrip("="), base64.urlsafe_b64encode(raw).decode().rstrip("="), raw.hex(), raw.hex().upper(), quote(value, safe="-_.!~*\x27()"), json.dumps(value, ensure_ascii=False)[1:-1]]
    return sorted(dict.fromkeys(item for item in values if len(item) >= 4), key=len, reverse=True)


def redact(value, secrets):
    def text(value):
        for name, secret in secrets.items():
            for form in forms(secret):
                value = value.replace(form, "⟦hidden:" + name + "⟧")
        return value
    if isinstance(value, str):
        return text(value)
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {text(key): redact(item, secrets) for key, item in value.items()}
    return value


def secret_references(seed_count):
    checks = Checks()
    reference = "⟦vault:github/token⟧"
    original = {"authorization": "Bearer " + reference, reference: "literal key"}
    outgoing = substitute(original, {"github/token": "ABCD1234"})
    checks.equal("substitution keeps the source tree", original["authorization"], "Bearer " + reference)
    checks.equal("substitution changes values only", outgoing, {"authorization": "Bearer ABCD1234", reference: "literal key"})
    checks.equal("dollar text is literal", substitute(reference, {"github/token": "$&"}), "$&")
    checks.equal("replacement does not read a second reference", substitute(reference, {"github/token": "⟦vault:other/token⟧"}), "⟦vault:other/token⟧")
    secret = {"github/token": "ABCD1234"}
    checks.equal("whole echo is removed", redact("ABCD1234", secret), "⟦hidden:github/token⟧")
    split = redact({"left": "ABCD", "right": "1234"}, secret)
    recovered = split["left"] + split["right"]
    checks.equal("split echo recovers the whole secret", recovered, "ABCD1234")
    short = redact(["ab", "YWI", "YWI=", "6162"], {"github/token": "ab"})
    checks.equal("the form threshold is per encoding", short, ["ab", "YWI", "⟦hidden:github/token⟧", "⟦hidden:github/token⟧"])
    renamed = redact({"content": "data"}, {"github/token": "content"})
    checks.that("redaction can remove a schema key", "content" not in renamed)
    marker = redact("hidden", {"github/token": "hidden"})
    checks.that("the marker can contain the secret", "hidden" in marker)
    checks.equal("boolean facts pass redaction", redact({"starts_with_A": True}, secret), {"starts_with_A": True})
    checks.equal("a later call without references has no filter", redact("ABCD1234", {}), "ABCD1234")
    boolean_transcripts = set()
    constant_transcripts = set()
    recovered_bytes = 0
    for byte in range(256):
        value = format(byte, "08b")
        reply = {"bit_" + str(i): bool(byte & 1 << i) for i in range(8)}
        filtered = redact(reply, {"test/value": value})
        rebuilt = sum(1 << i for i in range(8) if filtered["bit_" + str(i)])
        checks.equal("boolean replies recover each byte", rebuilt, byte)
        boolean_transcripts.add(json.dumps(filtered, sort_keys=True))
        constant_transcripts.add(json.dumps({"result": "done"}))
        recovered_bytes += 1
    checks.equal("the boolean channel keeps all source values distinct", len(boolean_transcripts), 256)
    checks.equal("a fixed reply has one public value", len(constant_transcripts), 1)
    transformed = 0
    raw_only_leaks = 0
    no_filter_leaks = 0
    known_form_leaks = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        value = "value/" + "".join(rng.choice("abcdef0123456789") for _ in range(24))
        secrets = {"github/token": value}
        for encoded in forms(value):
            filtered = redact(encoded, secrets)
            checks.equal("each known whole form is removed", filtered, "⟦hidden:github/token⟧")
            no_filter_leaks += 1
            raw_only_leaks += encoded in encoded.replace(value, "[hidden]")
            known_form_leaks += encoded in filtered
            transformed += 1
        tree = {"outer": [reference, {"auth": "Bearer " + reference}, seed]}
        checks.equal("nested substitution preserves JSON shape", substitute(tree, secrets), {"outer": [value, {"auth": "Bearer " + value}, seed]})
    return record("09", "Secret reference boundaries", checks, [
        {"split_echo_recovered": recovered, "short_forms": short, "marker_contains_secret": "hidden" in marker, "known_encoding_cases": transformed},
        {"whole_echo_cases": transformed, "no_filter_whole_echoes": no_filter_leaks, "raw_only_whole_echoes": raw_only_leaks, "known_form_whole_echoes": known_form_leaks},
        {"byte_secrets": recovered_bytes, "boolean_replies_per_secret": 8, "recovered_secrets": recovered_bytes, "distinct_boolean_transcripts": len(boolean_transcripts), "distinct_constant_transcripts": len(constant_transcripts)},
        {"product_review": "This finite filter model does not check product rights, approval, or value reads."},
    ], ["All values are synthetic and grant no access.", "This model does not test product approval, provider errors, public logs, or a real policy race.", "Finite text redaction does not give end-to-end secrecy after an allowed release."], seed_count)


def publication(previous, paths, noindex=False, baseline=False):
    if noindex:
        return False, "withdrawn" if previous else "excluded"
    if "positive" in paths:
        return True, "indexed"
    negative = "negative" in paths if baseline else bool(paths) and all(path == "negative" for path in paths)
    if previous and negative:
        return False, "withdrawn"
    if "unknown" in paths:
        return previous, "unconfirmed"
    return False, "excluded"


def compatible_publication_worlds(paths):
    possible = [(False, True) if path == "unknown" else (path == "positive",) for path in paths]
    return tuple(itertools.product(*possible))


def discovery(seed_count):
    checks = Checks()
    checks.equal("mixed evidence keeps a prior listing", publication(True, ["negative", "unknown"]), (True, "unconfirmed"))
    checks.equal("the mixed baseline withdraws too soon", publication(True, ["negative", "unknown"], baseline=True), (False, "withdrawn"))
    checks.equal("all valid omissions withdraw", publication(True, ["negative", "negative"]), (False, "withdrawn"))
    checks.equal("a recovered positive path restores the check", publication(True, ["negative", "positive"]), (True, "indexed"))
    checks.equal("fresh noindex has priority", publication(True, ["positive"], noindex=True), (False, "withdrawn"))
    checks.equal("unknown evidence cannot admit a new Card", publication(False, ["unknown"]), (False, "unconfirmed"))
    exhaustive = 0
    totals = {name: {"false_withdrawals": 0, "confirmed_withdrawals": 0, "missed_clear_withdrawals": 0, "unconfirmed": 0} for name in ("mixed_negative", "failure_is_negative", "keep_prior", "all_negative")}
    oracle_unknowns = 0
    for width in range(1, 6):
        for declarations in itertools.product((False, True), repeat=width):
            for available in itertools.product((False, True), repeat=width):
                observed = tuple("unknown" if not seen else "positive" if declaration else "negative" for declaration, seen in zip(declarations, available))
                worlds = compatible_publication_worlds(observed)
                any_possible = any(any(world) for world in worlds)
                every_possible = all(any(world) for world in worlds)
                expected = (True, "indexed") if every_possible else (True, "unconfirmed") if any_possible else (False, "withdrawn")
                proposed = publication(True, observed)
                checks.equal("all-negative rule matches possible worlds", proposed, expected)
                checks.that("the fixed true world remains possible", declarations in worlds)
                oracle_unknowns += any_possible and not every_possible
                failure_paths = ["negative" if path == "unknown" else path for path in observed]
                methods = {
                    "mixed_negative": publication(True, observed, baseline=True),
                    "failure_is_negative": publication(True, failure_paths, baseline=True),
                    "keep_prior": (True, "indexed" if "positive" in observed else "unconfirmed"),
                    "all_negative": proposed,
                }
                for name, result in methods.items():
                    withdrew = result[1] == "withdrawn"
                    totals[name]["false_withdrawals"] += withdrew and any(declarations)
                    totals[name]["confirmed_withdrawals"] += withdrew and not any_possible
                    totals[name]["missed_clear_withdrawals"] += not withdrew and not any_possible
                    totals[name]["unconfirmed"] += result[1] == "unconfirmed"
                exhaustive += 1
    changing = ((False, True), (True, True), (True, False))
    changing_observations = ["positive" if changing[0][0] else "negative", "positive" if changing[-1][1] else "negative"]
    checks.that("the changing publisher stays present", all(any(state) for state in changing))
    checks.equal("separate reads can miss every live path", changing_observations, ["negative", "negative"])
    checks.equal("stable-truth rule is not safe for this changing trace", publication(True, changing_observations), (False, "withdrawn"))
    baseline_errors = 0
    states = 0
    for seed in range(seed_count):
        rng = random.Random(seed)
        for _ in range(60):
            # Publisher truth and network availability are separate fixture inputs.
            declarations = [bool(rng.getrandbits(1)) for _ in range(rng.randrange(1, 6))]
            available = [rng.random() > 0.35 for _ in declarations]
            paths = ["positive" if declaration else "negative" for declaration in declarations]
            observed = [path if seen else "unknown" for path, seen in zip(paths, available)]
            proposed = publication(True, observed)
            old = publication(True, observed, baseline=True)
            if any(declarations):
                checks.that("continued publication does not withdraw", proposed[1] != "withdrawn")
                baseline_errors += old[1] == "withdrawn"
            if all(available) and not any(declarations):
                checks.equal("fully observed withdrawal hides the Card", proposed, (False, "withdrawn"))
            states += 1
    sources = {"A": [("card:1", "One", "same"), ("card:2", "Helper", "old")], "B": [("card:2", "Helper", "new"), ("card:3", "Helper", "other")]}
    merged = {}
    for source, rows in sources.items():
        for key, name, body in rows:
            merged.setdefault(key, []).append((source, name, body))
    checks.equal("Card URLs keep three identities", sorted(merged), ["card:1", "card:2", "card:3"])
    checks.equal("the changed body stays visible", [body for _, _, body in merged["card:2"]], ["old", "new"])
    first_ab = next(row[2] for source in ("A", "B") for row in sources[source] if row[0] == "card:2")
    first_ba = next(row[2] for source in ("B", "A") for row in sources[source] if row[0] == "card:2")
    checks.that("first-wins body depends on source order", first_ab != first_ba)
    federation = {"A": [("card:1", "one"), ("card:2", "old")], "B": [("card:2", "new"), ("card:3", "other")], "C": [("card:2", "third"), ("card:3", "other")]}
    canonical_merges = set()
    first_bodies = set()
    source_orders = 0
    for order in itertools.permutations(federation):
        rows = {}
        first = {}
        for source in order:
            for card, body in federation[source]:
                rows.setdefault(card, set()).add((source, body))
                first.setdefault(card, body)
        normalized = tuple((card, tuple(sorted(values))) for card, values in sorted(rows.items()))
        canonical_merges.add(normalized)
        first_bodies.add(first["card:2"])
        checks.equal("all conflicting source bodies stay visible", {body for _, body in rows["card:2"]}, {"old", "new", "third"})
        source_orders += 1
    checks.equal("source merge does not depend on source order", len(canonical_merges), 1)
    checks.equal("first-wins selects three different bodies", len(first_bodies), 3)
    current = {"owner": "new", "visible": False}
    old_owner = "old"
    if old_owner == current["owner"]:
        current["visible"] = True
    checks.equal("a stale owner cannot restore a listing", current["visible"], False)
    return record("10", "Public discovery evidence", checks, [
        {"publisher_states": states, "mixed_baseline_false_withdrawals": baseline_errors, "proposed_false_withdrawals": 0, "unique_cards": len(merged), "first_wins_bodies": [first_ab, first_ba]},
        {"exhaustive_truth_availability_states": exhaustive, "max_paths": 5, "ambiguous_states": oracle_unknowns, "exhaustive_methods": totals},
        {"source_orders": source_orders, "conflict_merge_results": len(canonical_merges), "first_wins_results": len(first_bodies), "non_atomic_read_false_withdrawal": True},
        {"product_review": "The compared rules are abstract methods. Product HTTP and index checks run apart from this model."},
    ], ["These are finite state and merge models, not real HTTP or product index tests.", "No timing, robots, DNS, private-store, queue, or owner-transaction integration test runs here."], seed_count)


def run(seed_count: int) -> list[dict]:
    return [memory(seed_count), compaction(seed_count), replay(seed_count), secret_references(seed_count), discovery(seed_count)]
