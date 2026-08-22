#!/usr/bin/env python3
"""workflow-ref-guard.py — every `workflow_run.workflows:` entry must name a real workflow.

WHY: a `workflow_run` trigger is a hardcoded cross-reference to another workflow's
display `name:`, and GitHub raises NO error when that name matches nothing. The
workflow simply never fires. There is no red check, no warning, no run to inspect —
the gate is just absent, and an absent signal reads as "nothing failed".

Three real instances of that class inside two days in one downstream project
(apfp.claude, 2026-08-18/19), which is why this exists:
  • qa-live.yml watched 'pages-build-deployment' after Settings -> Pages -> Source
    moved to GitHub Actions. The legacy build stopped firing and the authoritative
    live gate went silent across four merged commits before anyone noticed.
  • pages-monitor.yml triggered on `page_build`, which is managed-build-only, so it
    went inert at the same cutover — the second deploy alarm, quiet for the same
    reason, and unnoticed for a further day.
  • a ci-monitor template watched QA workflow names that did not exist in the host
    repo at all. Adopting that drop-in would have left CI Monitor watching nothing.

The third case is the one no reviewer catches: a name resolving to nothing is
invisible when reading either file alone. Both are internally consistent; only the
cross-reference is broken.

TWO RULES, and neither implies the other:
  1. every name that IS listed must resolve                  (ALLOWED_EXTERNAL below)
  2. every name that MUST be watched must be listed          (REQUIRED below)
Rule 1 alone is blind to a watcher deleted outright — it dangles nothing and sails
through. Adopting an upstream template verbatim is exactly how that happens.

⚠️ SCOPE — READ BEFORE TRUSTING A GREEN RUN. This checks that a referenced name
EXISTS. It does NOT check that the referenced workflow still FIRES. It would NOT have
caught the first case above: 'pages-build-deployment' is a real, still-"active"
GitHub-managed workflow that had merely stopped being triggered. Liveness needs run
history, not the tree. Green here means "no dangling reference and no missing required
watcher" — never "all my triggers fire".

⚠️ Do NOT add an "optional workflow" exception category to rule 1. A name allowed not
to resolve is indistinguishable from one that has silently stopped resolving — the very
failure this catches — and an allow-list of names permitted to dangle is the same
self-defeating shape as a curated preserve-list. If a workflow is optional, do not
pre-list it in any watcher; make installing it carry the obligation to add itself.
ALLOWED_EXTERNAL is a different claim: externally HOSTED, not optional. REQUIRED is the
INVERSE of an allow-list — it gets louder when something breaks, not quieter.

⚠️ WHY PYTHON, AND WHY A REAL PARSER. The first version of this guard read the
workflow files line by line with regexes, because "no dependencies" looked like the
portable choice. It was not: a line scanner has to re-implement YAML, and the set of
valid YAML forms it can misread is unbounded. Review found thirteen such forms across
four rounds on this one file — quoted mapping keys (`'workflow_run':`), flow mappings
(`on: {workflow_run: {...}}`), anchors (`workflows: &watched [A]`), aliases
(`workflows: *watched`), indentless block sequences, consistently indented root
mappings, escapes in double-quoted names (`"QA — Tests"`), escaped quotes inside
a flow sequence, and `run: |` bodies containing illustrative YAML — and each fix
exposed the next. Every one of those is a wrong answer from a guard whose entire
purpose is to be trusted when it is quiet.

`python3` and PyYAML are already present on GitHub's runner images and this repo's
qa.yml already parses workflow YAML with them, so the parser costs nothing a Node
YAML dependency would not have cost more. Do NOT reintroduce a hand-rolled scan.

PORTABILITY: one stdlib-adjacent dependency (PyYAML, preinstalled on GitHub runners),
no network, nothing repo-specific. Drop into .github/scripts/ and add to a
static-checks job:
    - name: Workflow cross-reference guard
      run: python3 .github/scripts/workflow-ref-guard.py
"""

import json
import sys
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    sys.stderr.write(
        "❌ workflow-ref-guard: PyYAML is not installed.\n"
        "   It ships with GitHub's runner images; on a bare host: pip install PyYAML.\n"
        "   Failing rather than skipping — a guard that cannot read the workflows must\n"
        "   never report that they are fine.\n"
    )
    raise SystemExit(1)

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = REPO_ROOT / ".github" / "workflows"

# Workflows that exist on GitHub but are NOT files in .github/workflows/. Add here only
# with a justification — an entry that is merely misspelled belongs in the failure list,
# not in this allow-list.
ALLOWED_EXTERNAL = {
    "pages-build-deployment": (
        "GitHub-managed Pages build (path dynamic/pages/pages-build-deployment). Not a file in "
        ".github/workflows/. Still fires when repo visibility is flipped, so a project that has "
        "moved to an Actions-sourced Pages workflow should watch BOTH names."
    ),
}

# Watchers this repo cannot LOSE.
#
# The rule above checks that every LISTED name resolves. It says nothing about a name
# that is simply GONE. Delete 'Pages' from qa-live's list and what remains
# ('pages-build-deployment') still resolves — so the guard passes and the live gate is
# dead again, exactly as in #849. A refresh that adopts an upstream template verbatim
# is the realistic way that happens, and it is invisible in review because the file it
# produces is internally consistent.
#
# ⚠️ This is the INVERSE of an allow-list, not another one. A permit-list ("these names
# MAY dangle") stays silent when something breaks, which is why that shape self-defeats
# and why the upstream templates refuse to carry one. A require-list ("these names MUST
# be present") gets LOUDER when something breaks. Remove an entry here only when this
# repo genuinely stops needing that watcher — never to make a red build go green.
# Per-project intent — a template cannot know these names, only the RULE. Populate with
# the deploy workflow's own name for each file that must keep watching it.
# Loaded from `.github/workflow-ref-required.json`, NOT hard-coded here — the script
# is byte-identical across every repo that installs it (CI diffs the shipped copy
# against the live one), so a repo could never populate this while it lived in the
# file. That left rule 2 permanently inert in the only place it runs, which is a
# rule that exists on paper and nowhere else.
#
# Format: { "qa-live.yml": ["My Deploy Workflow"], ... }
# Absent file = no required watchers, which is the correct default for a fresh repo.
def _load_required():
    cfg = REPO_ROOT / ".github" / "workflow-ref-required.json"
    if not cfg.exists():
        return {}
    try:
        return json.loads(cfg.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        sys.stderr.write(f"❌ workflow-ref-guard: {cfg} is not valid JSON — {exc}\n")
        raise SystemExit(1)


REQUIRED = _load_required()


def mapping_get(node, key):
    """Value node for `key` in a mapping node, or None.

    Keys are matched on their raw scalar text, so `workflows:`, `'workflows':` and
    `"workflows":` are one key — the quoting is the formatter's business, not ours.
    Last match wins, matching how both PyYAML and GitHub resolve a duplicated key;
    taking the first would let a second `on:` further down the file be the one that
    actually runs while this guard read the one above it.
    """
    if not isinstance(node, yaml.MappingNode):
        return None
    found = None
    for key_node, value_node in node.value:
        if isinstance(key_node, yaml.ScalarNode) and key_node.value == key:
            found = value_node
    return found


def on_node(root):
    """The value of the root `on:` key.

    YAML 1.1 — which PyYAML and most formatters speak — resolves a bare `on` to
    boolean true, so a document that has been round-tripped through such a tool can
    come back with the key spelled `true` or `yes`. GitHub still reads it as the
    trigger block, so this must too.
    """
    if not isinstance(root, yaml.MappingNode):
        return None
    found = None
    for key_node, value_node in root.value:
        if not isinstance(key_node, yaml.ScalarNode):
            continue
        if key_node.value == "on" or (
            key_node.tag == "tag:yaml.org,2002:bool"
            # `ON:` and `On:` are bool-tagged but keep their original casing, so a
            # lowercase-only comparison misses them and the guard reports zero
            # references on a file that has a live trigger. `on` belongs in this list
            # for the same reason `yes` does. The tag check is what keeps a QUOTED
            # `"ON":` out — that is str-tagged and genuinely is not the trigger key,
            # so it must keep being ignored.
            and key_node.value.lower() in ("true", "yes", "y", "on")
        ):
            found = value_node
    return found


def referenced_workflows(root, unreadable):
    """[(name, line)] for every name under `on.workflow_run.workflows`.

    Scoped to the ROOT `on:` mapping, so a `workflows:` key anywhere else in the file
    — a job named `workflows`, an illustrative snippet inside a `run: |` body — is
    never mistaken for a trigger. The parser makes that scoping structural rather
    than a guess about indentation.
    """
    refs = []
    on = on_node(root)
    if on is None:
        return refs
    workflow_run = mapping_get(on, "workflow_run")
    if workflow_run is None:
        return refs
    workflows = mapping_get(workflow_run, "workflows")
    if workflows is None:
        # `workflow_run:` with no `workflows:` list watches every workflow. Nothing
        # is named, so nothing can dangle.
        return refs

    if isinstance(workflows, yaml.ScalarNode):
        # The same null hole as `name:` above: a `workflows:` key left with no value
        # is a ScalarNode, so reading `.value` would record "" as a watched name and
        # report it dangling — a real fault, described wrongly. Name it for what it is.
        if workflows.tag == "tag:yaml.org,2002:null" or not workflows.value.strip():
            unreadable.append(
                (workflows.start_mark.line + 1, "a `workflows:` key with no value")
            )
            return refs
        # `workflows: Name` — a bare scalar where GitHub wants a sequence. Read it
        # rather than find nothing: a dangling name here fails the same way.
        refs.append((workflows.value, workflows.start_mark.line + 1))
        return refs

    if not isinstance(workflows, yaml.SequenceNode):
        unreadable.append(
            (workflows.start_mark.line + 1, "a `workflows:` value that is neither a name nor a list")
        )
        return refs

    for item in workflows.value:
        if isinstance(item, yaml.ScalarNode):
            # Same null hole as the scalar branch above, and it was inconsistent to
            # reject it there while accepting it here. `workflows: [null]` composes to
            # a null-tagged node whose `.value` is the string "null", so a repo that
            # happened to contain a workflow named "null" would resolve it and pass.
            # Empty entries go the same way: no workflow can declare an empty name, so
            # such an entry can never resolve, and reporting it as a dangling name
            # describes the wrong fault. Non-string scalars stay allowed — `2026` is a
            # legal display name.
            if item.tag == "tag:yaml.org,2002:null" or not item.value.strip():
                unreadable.append(
                    (item.start_mark.line + 1, "a null or empty entry in the `workflows:` list")
                )
                continue
            refs.append((item.value, item.start_mark.line + 1))
        else:
            # A nested mapping or sequence is not a workflow name. Report it rather
            # than drop it: silently ignoring an item is how a watcher ends up
            # watching less than its author believes.
            unreadable.append(
                (item.start_mark.line + 1, "a non-scalar item in the `workflows:` list")
            )
    return refs


def compose(path):
    """Node graph for one workflow file.

    Composing rather than loading keeps the source line of every scalar, which is what
    makes a failure here point at the offending line. It also resolves anchors and
    aliases natively — `workflows: &watched [A]` and `workflows: *watched` both arrive
    as the sequence they denote.
    """
    with path.open(encoding="utf-8") as handle:
        return yaml.compose(handle, Loader=yaml.SafeLoader)


files = sorted(
    p for p in WORKFLOW_DIR.iterdir() if p.suffix in (".yml", ".yaml")
) if WORKFLOW_DIR.is_dir() else []

if not files:
    sys.stderr.write("❌ workflow-ref-guard: no workflow files found — wrong path?\n")
    raise SystemExit(1)

errors = []
roots = {}

# Every workflow's declared display name, which is what workflow_run matches on.
declared = {}  # name -> filename
for path in files:
    rel = path.relative_to(REPO_ROOT)
    try:
        root = compose(path)
    except yaml.YAMLError as exc:
        # FAIL CLOSED. A file this guard cannot read is reported, never skipped: a
        # workflow silently treated as empty yields zero references and a green run,
        # reporting health because nothing was looked at — precisely the failure mode
        # this guard exists to catch.
        errors.append(
            f"{rel} — is not parseable YAML, so its triggers were never checked.\n"
            f"      {str(exc).strip()}"
        )
        roots[path.name] = None
        continue
    roots[path.name] = root
    name_node = mapping_get(root, "name")
    # A bare `name:` and `name: ""` are the same defect as no `name:` at all — GitHub
    # falls back to the file path in every case. PyYAML still hands back a ScalarNode
    # for both (tagged null, or str with an empty value), so an isinstance check alone
    # accepts them, declares "" as the workflow's display name, and exits green on a
    # workflow nothing can reference. Require a name with something in it.
    if (
        not isinstance(name_node, yaml.ScalarNode)
        or name_node.tag == "tag:yaml.org,2002:null"
        or not name_node.value.strip()
    ):
        errors.append(
            f"{rel} has no usable top-level `name:`. GitHub falls back to the file path, "
            f"which no workflow_run list can reliably reference — give it an explicit name."
        )
        continue
    declared[name_node.value] = path.name

if errors:
    sys.stderr.write("❌ workflow-ref-guard: FAILED\n\n")
    for err in errors:
        sys.stderr.write("  • " + err + "\n\n")
    raise SystemExit(1)

checked = 0
seen_per_file = {}

for path in files:
    root = roots[path.name]
    unreadable = []
    refs = referenced_workflows(root, unreadable)
    for line, form in unreadable:
        errors.append(
            f".github/workflows/{path.name}:{line} — {form}.\n"
            f"      GitHub matches workflow_run entries against workflow display names, so "
            f"anything else here watches nothing."
        )
    seen_per_file[path.name] = {name for name, _ in refs}
    for name, line in refs:
        checked += 1
        if name in declared or name in ALLOWED_EXTERNAL:
            continue
        valid = ", ".join(f'"{n}"' for n in declared)
        errors.append(
            f'.github/workflows/{path.name}:{line} — workflow_run watches "{name}", which is not '
            f"the `name:` of any workflow in this repo.\n"
            f"      A workflow_run naming something that does not exist NEVER FIRES, and GitHub "
            f"reports no error.\n"
            f"      Valid names here: {valid}\n"
            f"      If it is a GitHub-managed workflow, add it to ALLOWED_EXTERNAL with a justification."
        )

# Rule 2 — a required watcher may never go missing (see REQUIRED above).
for filename, names in REQUIRED.items():
    seen = seen_per_file.get(filename)
    if seen is None:
        listed = ", ".join(f'"{n}"' for n in names)
        errors.append(
            f".github/workflows/{filename} — REQUIRED to watch {listed}, but the file is "
            f"missing. If it was deliberately removed, drop its REQUIRED entry too."
        )
        continue
    for name in names:
        if name in seen:
            continue
        errors.append(
            f'.github/workflows/{filename} — no longer watches "{name}", which this repo REQUIRES.\n'
            f"      Dropping it does NOT dangle anything, so the resolve rule above stays green "
            f"while the trigger goes dead — that is #849 exactly.\n"
            f'      Most likely cause: an upstream template was adopted verbatim. Re-add "{name}" '
            f"rather than deleting the REQUIRED entry."
        )

# ---------------------------------------------------------------------------
# Second pass: templates/workflows/, resolved against ITS OWN name set.
# The templates are what every downstream project inherits, so a dangling
# watcher introduced there propagates to every project with nothing failing
# here - a scan of the live workflows alone reports health precisely when the
# shipped ones are broken. (Same argument check-job-bounds.py makes for
# scanning both; #238's defect lived only in the templates.)
# REQUIRED is deliberately NOT applied: it encodes THIS repo's watchers, and a
# project legitimately installs a subset of the template set.
TEMPLATE_DIR = REPO_ROOT / "templates" / "workflows"
template_files = sorted(
    p for p in TEMPLATE_DIR.iterdir() if p.suffix in (".yml", ".yaml")
) if TEMPLATE_DIR.is_dir() else []

template_checked = 0
t_declared = {}
t_roots = {}
for path in template_files:
    try:
        root = compose(path)
    except yaml.YAMLError as exc:
        errors.append(
            f"templates/workflows/{path.name} - not parseable YAML, so its triggers "
            f"were never checked.\n      {str(exc).strip()}"
        )
        t_roots[path.name] = None
        continue
    t_roots[path.name] = root
    name_node = mapping_get(root, "name")
    if (
        isinstance(name_node, yaml.ScalarNode)
        and name_node.tag != "tag:yaml.org,2002:null"
        and name_node.value.strip()
    ):
        t_declared[name_node.value.strip()] = path.name
    else:
        # Error, don't skip. The live pass rejects a workflow with no usable
        # display name; silently omitting the template from t_declared would
        # certify scaffolding that fails that same guard the moment a project
        # installs it — and nothing here would have said so.
        errors.append(
            f"templates/workflows/{path.name} - has no usable top-level `name:`, so no "
            f"workflow_run list can reference it.\n"
            f"      GitHub falls back to the file path, and this guard's live-workflow "
            f"pass rejects that — a project installing this template would fail its own "
            f"validation immediately. Give it an explicit name."
        )

for path in template_files:
    root = t_roots.get(path.name)
    if root is None:
        continue
    unreadable = []
    refs = referenced_workflows(root, unreadable)
    for line, form in unreadable:
        errors.append(
            f"templates/workflows/{path.name}:{line} - {form}.\n"
            f"      GitHub matches workflow_run entries against workflow display names, "
            f"so anything else here watches nothing."
        )
    for name, line in refs:
        template_checked += 1
        if name in t_declared or name in ALLOWED_EXTERNAL:
            continue
        errors.append(
            f'templates/workflows/{path.name}:{line} - workflow_run watches "{name}", '
            f"which no template in templates/workflows/ declares.\n"
            f"      Every project installing this template inherits a trigger that NEVER "
            f"FIRES, silently. Fix the name, or ship the template that declares it."
        )

if errors:
    sys.stderr.write("❌ workflow-ref-guard: FAILED\n\n")
    for err in errors:
        sys.stderr.write("  • " + err + "\n\n")
    raise SystemExit(1)

required_count = sum(len(v) for v in REQUIRED.values())
print(
    f"✅ workflow-ref-guard: {checked} workflow_run reference(s) across {len(files)} "
    f"workflow(s) + {template_checked} across {len(template_files)} template(s) — all "
    f"resolve, and {required_count} required watcher(s) intact. "
    f"(Existence only; does not prove they still fire.)"
)
