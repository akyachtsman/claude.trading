#!/usr/bin/env python3
"""check-yaml-anchors.py — refuse the YAML anchors, aliases and merge keys GitHub refuses.

WHY: PyYAML accepts every one of them, so a file using one passes every local
YAML check and then fails on GitHub, in every project that copied it:
  - an action's metadata file (`action.yml`) may carry no anchor and no alias.
    The runner reads it with a reader that throws "Anchors are not currently
    supported". A WORKFLOW may use both.
  - a merge key (`<<`) is merged nowhere: GitHub reads it as a literal key
    named `<<`, which no workflow or action schema accepts.
A composite is read only by a job that uses it, and fails there, late and as a
failed step; this reads every one on every run and names the file and line.

TWO RULES, read from the parser's events by the sibling gh_yaml.py, never from
the text (an `&` or `*` inside a quoted string or a block scalar is content):
  1. every action.yml / action.yaml: no anchor, no alias, no merge key;
  2. every workflow: no merge key. Anchors and aliases stay allowed.
A file that does not parse at all is reported too: a file this guard cannot
read is never counted as clean.

SCOPE. Reads .github/workflows/*.y?ml and every action.y?ml under
.github/actions/ (node_modules skipped: GitHub reads a manifest only where a
step points). With --include-templates it adds templates/workflows/ and
templates/actions/, which only claude.directives has; that repo's qa.yml
passes the flag, and no downstream workflow does. A local action kept outside
.github/actions/ is not found. It checks that GitHub can READ the files, not
that they are valid workflows: the schema is GitHub's, not this file's.

Usage:
    python3 .github/scripts/check-yaml-anchors.py [ROOT] [--include-templates]

Needs PyYAML (on GitHub's runner images) and gh_yaml.py beside this file.
"""

import sys
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    sys.stderr.write("❌ check-yaml-anchors: PyYAML is not installed. It ships with GitHub's "
                     "runner images; on a bare host: pip install PyYAML.\n")
    raise SystemExit(1)

# The shared YAML 1.2 reader, a sibling of this file (templates/scripts/ here,
# .github/scripts/ downstream). Inserted explicitly so a load by path finds it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import gh_yaml
except ModuleNotFoundError:
    sys.stderr.write("❌ check-yaml-anchors: gh_yaml.py is missing beside this script. Install "
                     "templates/scripts/gh_yaml.py from claude.directives next to it.\n")
    raise SystemExit(1)

KNOWN_FLAGS = {"--include-templates"}
args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}
if flags - KNOWN_FLAGS or len(args) > 1:
    sys.stderr.write(f"❌ check-yaml-anchors: unknown arguments {sorted(flags - KNOWN_FLAGS) or args[1:]}.\n"
                     "   Usage: check-yaml-anchors.py [ROOT] [--include-templates]\n")
    raise SystemExit(2)

ROOT = Path(args[0]).resolve() if args else Path(__file__).resolve().parents[2]
TEMPLATES = "--include-templates" in flags

# (directory, required): a required directory that is missing is an error,
# never an empty pass. .github/actions/ is optional: a project may have none.
WORKFLOW_DIRS = [(".github/workflows", True)] + ([("templates/workflows", True)] if TEMPLATES else [])
ACTION_DIRS = [(".github/actions", False)] + ([("templates/actions", True)] if TEMPLATES else [])

errors = []


def workflows(rel):
    directory = ROOT / rel
    return sorted(directory.glob("*.yml")) + sorted(directory.glob("*.yaml"))


def actions(rel):
    found = []
    for path in sorted((ROOT / rel).rglob("action.y*ml")):
        if path.name in ("action.yml", "action.yaml") and "node_modules" not in path.relative_to(ROOT).parts:
            found.append(path)
    return found


def check(path, allow_anchors):
    try:
        with open(path, encoding="utf-8") as handle:
            gh_yaml.load(handle, allow_anchors=allow_anchors)
    except gh_yaml.Refused as exc:
        mark = exc.problem_mark
        errors.append(f"{path.relative_to(ROOT)}, line {mark.line + 1}, column {mark.column + 1}: "
                      f"{exc.problem}")
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as exc:
        errors.append(f"{path.relative_to(ROOT)} cannot be read as YAML, so it was never checked: "
                      f"{str(exc).strip()}")


counts = {}
scanned = []
for kind, dirs, lister, allow in (("workflow", WORKFLOW_DIRS, workflows, True),
                                  ("action", ACTION_DIRS, actions, False)):
    counts[kind] = 0
    for rel, required in dirs:
        if not (ROOT / rel).is_dir():
            if required:
                errors.append(f"{rel}/ does not exist — wrong root? Scanned from {ROOT}.")
            continue
        scanned.append(rel)
        files = lister(rel)
        if required and not files:
            errors.append(f"{rel}/ holds no {kind} files — nothing to check is not a pass.")
        for path in files:
            check(path, allow)
            counts[kind] += 1

if errors:
    sys.stderr.write("❌ check-yaml-anchors: FAILED — GitHub refuses these files\n\n")
    for err in errors:
        sys.stderr.write("  • " + err.replace("\n", "\n    ") + "\n\n")
    raise SystemExit(1)

scope = ", ".join(scanned)
print(f"✅ check-yaml-anchors: {counts['workflow']} workflow file(s) carry no merge key, and "
      f"{counts['action']} action file(s) no anchor, alias or merge key (scanned {scope}).")
