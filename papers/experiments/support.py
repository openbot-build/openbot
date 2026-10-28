"""Small checks shared by the paper experiments."""

import json


class Checks:
    def __init__(self):
        self.count = 0

    def equal(self, name, actual, expected):
        self.count += 1
        if actual != expected:
            raise AssertionError(
                f"{name}: got {actual!r}; expected {expected!r}"
            )

    def that(self, name, condition):
        self.equal(name, bool(condition), True)


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
