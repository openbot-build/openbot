"""Run finite paper models. This does not run the OpenBot service."""

import argparse
import hashlib
import importlib
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True

from support import save_json


MODULES = (
    "papers_01_05",
    "papers_06_10",
    "papers_11_12",
    "papers_13_14",
    "paper_15",
)


def source_hashes():
    papers = Path(__file__).resolve().parent.parent
    paths = [papers / "index.typ", papers / "build.sh"]
    paths.extend(papers.glob("[0-9][0-9]-*/main.typ"))
    paths.extend(papers.glob("[0-9][0-9]-*/references.bib"))
    paths.extend((papers / "experiments").glob("*.py"))
    return {
        str(path.relative_to(papers)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(paths)
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=int, default=30)
    parser.add_argument(
        "--output", type=Path, default=Path(__file__).with_name("results.json")
    )
    args = parser.parse_args()
    if args.seeds < 1:
        parser.error("The seed count must be at least one.")
    sources = source_hashes()
    start = time.monotonic()
    records = []
    failures = []
    for name in MODULES:
        try:
            records.extend(importlib.import_module(name).run(args.seeds))
        except Exception as error:
            failures.append({"module": name, "error": f"{type(error).__name__}: {error}"})

    after = source_hashes()
    changed = sorted(
        name for name in sources.keys() | after.keys()
        if sources.get(name) != after.get(name)
    )
    if changed:
        failures.append({"sources": "Source files changed during the run.", "files": changed})
    ids = [record["paper_id"] for record in records]
    missing = sorted(set(f"{number:02}" for number in range(1, 16)) - set(ids))
    if missing or len(set(ids)) != len(ids):
        failures.append({"coverage": "Missing or repeated paper records.", "missing": missing})
    for record in records:
        record["evidence_kind"] = "finite abstract model experiment"
        offset = record.get("seed_offset", 0)
        record["seed_values"] = list(range(offset, offset + record["seeds"]))
        record["source"] = next(
            path for path in sources
            if path.startswith(record["paper_id"] + "-") and path.endswith("/main.typ")
        )

    result = {
        "schema_version": 1,
        "status": "failed" if failures else "passed",
        "scope": (
            "These runs check stated worked cases and finite synthetic models. "
            "They do not run OpenBot, test real providers, or complete the papers' planned studies."
        ),
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "seed_count": args.seeds,
        "seed_range": [0, args.seeds - 1],
        "source_sha256": sources,
        "source_changes_during_run": changed,
        "papers": sorted(records, key=lambda record: record["paper_id"]),
        "checks": sum(record["checks"] for record in records),
        "failures": failures,
        "elapsed_seconds": round(time.monotonic() - start, 6),
        "timing_note": "Elapsed time is a run record, not a speed study.",
    }
    save_json(args.output, result)
    print(f"{result['status']}: {len(records)} papers, {result['checks']} checks")
    print(f"Results: {args.output.resolve()}")
    for failure in failures:
        print(failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
