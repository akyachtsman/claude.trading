#!/usr/bin/env python3
"""check-job-bounds.py — every workflow job must carry a bound that can actually trip.

WHY: an unbounded job that wedges runs to GitHub's 6-hour default, and for all
of it the PR shows neither pass nor fail — no signal, which reads as "still
working" and then as nothing. Measured here twice in one day (2026-08-19): run
32269445117 sat 57 minutes on a browser install; run 32293469078 sat 35 on the
same step and was only stopped because a bound had landed by then.

THREE RULES, because presence alone proves nothing:
  1. Every job declares `timeout-minutes`. (Exception: a job that `uses:` a
     reusable workflow — GitHub does not accept timeout-minutes there; the
     called workflow's own jobs carry the bounds.)
  2. No bound may be >= 360. GitHub's default IS 360, so declaring 360 or more
     is the absent bound wearing a declared one's clothes — it changes nothing
     and reads as protection.
  3. TWO floors, because the two shapes cost different amounts:
       - a job using the ui-suite composite pays install + EVERY project in
         playwright.config.js + retries + upload, in one sum it cannot
         subdivide: >= 120. ENFORCED — the composite is identified from `uses:`,
         Was 60 until S3's per-test budget went 240s -> 900s. Projects run
         serially, and a FAILING scenario does not merely add a retry: it
         REPLACES its healthy run with the ceiling and THEN retries at the
         ceiling, so one failing profile costs ~+22min, two cost ~+44min. A
         bound reached is a job CANCELLED, i.e. a definite test failure
         downgraded to an inconclusive run — see the callers' comment for the
         full arithmetic and for what 120 deliberately does NOT cover.
         a structured field with one correct answer.
       - a job running `playwright install` DIRECTLY pays the install: >= 30.
         ADVISORY ONLY — it prints, it never fails the build.

     Why that asymmetry. Deciding whether a `run:` block INVOKES playwright means
     parsing bash. Four review rounds produced twenty findings against successive
     attempts — substring, regex, exact-token, shlex — and they did not converge:
     quoted arguments, heredoc bodies, here-strings, comment-embedded markers,
     `env` options, redirections, control keywords, `npm exec`, doubled
     continuation backslashes, quoted separators. Roughly half were FALSE
     POSITIVES that would red-build a correct repo.

     A heuristic over free-form shell is not sound enough to be a hard gate, and
     this file's whole thesis is that an unsound gate costs more than a missing
     one: it gets deleted, taking rules 1-2 with it. So it warns. Rules 1 and 2
     bound the job either way, and the ui-suite floor — the path that the shipped
     templates actually use — stays enforced because `uses:` is structured data,
     not prose.
     Rule 3 exists because rule 1 passed the exact defect #238 fixed: every
     broken template job DECLARED a bound; the value was the fault.

────────────────────────────────────────────────────────────────────────────
THIS FILE IS EXPORTED (templates/scripts/check-job-bounds.py, byte-paired with
it) and runs in downstream repos that this repo has never seen. That inverts the
usual risk, and the inversion is the single most important thing to understand
before editing:

    A FALSE POSITIVE COSTS MORE THAN A FALSE NEGATIVE.

A missed defect leaves one bound unchecked, with rules 1-2 still covering it and
the number still in the comment. A guard that red-builds a repo doing nothing
wrong gets DELETED — and takes the real rules with it.

Seven rounds of review on this file produced one finding of the first kind and
eleven of the second, every one from the same mistake: testing a NAME-SHAPE and
treating the result as the FACT. `templates/` present. `EXPORTS.json` present. A
path prefix matching a sibling directory. A docs job that merely MENTIONS
ui-suite. A remote action whose path happens to END in the same segments.

So the classification below is deliberately CONSERVATIVE and EXACT. Where a job
cannot be identified with certainty, rule 3 is not applied. Do not "improve" any
of these into a looser match.
────────────────────────────────────────────────────────────────────────────

Scans .github/workflows always. Scans templates/workflows ONLY with
--include-templates, which this repo's own qa.yml passes and no downstream
workflow does. That flag replaced four successive attempts to DETECT which repo
was running — each was forged by a legitimate downstream layout. An explicit
argument cannot be: removing it is a visible edit to a workflow file in a PR
diff, which is exactly the review surface a silent heuristic did not have.

Composite actions are not scanned as workflows: composite steps cannot carry
timeout-minutes at all, and their ceiling is the calling job's. They ARE read,
transitively, to see whether a caller reaches ui-suite through a local wrapper.
"""

import posixpath
import re
import shlex
import sys
from pathlib import Path, PurePosixPath

try:
    import yaml
except ModuleNotFoundError:
    sys.stderr.write(
        "❌ check-job-bounds: PyYAML is not installed. It ships with GitHub's "
        "runner images; on a bare host: pip install PyYAML.\n"
    )
    raise SystemExit(1)

KNOWN_FLAGS = {"--include-templates"}

args = [a for a in sys.argv[1:] if not a.startswith("--")]
flags = {a for a in sys.argv[1:] if a.startswith("--")}

# FAIL on an unknown flag. `--include-template` (singular) would otherwise be
# accepted, silently leave the template scan off, and exit GREEN having checked
# half the tree — recreating the exact failure the flag was introduced to close.
# A fix for silent narrowing that is itself silently narrowable is not a fix.
unknown = sorted(flags - KNOWN_FLAGS)
if unknown:
    sys.stderr.write(
        "❌ check-job-bounds: unknown flag(s): " + ", ".join(unknown) + "\n"
        "   Known: " + ", ".join(sorted(KNOWN_FLAGS)) + "\n"
        "   Refusing to run rather than silently narrowing the scan — a typo here\n"
        "   would drop templates/workflows from the scan and still exit 0.\n"
    )
    raise SystemExit(1)

INCLUDE_TEMPLATES = "--include-templates" in flags

REPO_ROOT = Path(args[0]).resolve() if args else Path(__file__).resolve().parents[2]

SCAN_DIRS = [".github/workflows"]
if INCLUDE_TEMPLATES:
    SCAN_DIRS.append("templates/workflows")

GITHUB_DEFAULT = 360
BROWSER_FLOOR = 30
UI_SUITE_FLOOR = 120

# The shipped composite, as a LOCAL reference. `./` is load-bearing: a remote
# `acme/tools/.github/actions/ui-suite@v1` is a different action that merely ends
# in the same segments, and applying a 60-minute floor to it red-builds a repo
# using an unrelated fast action.
UI_SUITE_LOCAL = "./.github/actions/ui-suite"

# An actual invocation at a COMMAND POSITION — not the phrase anywhere in a
# script. `rg 'playwright install' docs/` mentions it; it does not run it, and a
# five-minute docs job must not be forced to 30.
# Deciding whether a `run:` block INVOKES playwright is a shell-parsing question,
# and three rounds of regexes proved it is not a regex question. Each pattern was
# correct and each left a new way for text to look like a command:
#
#   rg 'playwright install' docs/        a quoted argument
#   <<'EOF' ... playwright install       a heredoc BODY
#   echo "Example; playwright install"   a quoted semicolon read as a separator
#   # example: cat <<EOF                 a heredoc marker in a COMMENT, which the
#                                        stripper then honoured, swallowing a REAL
#                                        install after it — a FALSE NEGATIVE
#                                        introduced by the fix for the case above
#
# So: tokenize. `shlex` in POSIX mode drops comments and respects quoting, which
# is exactly what every one of those cases turned on. This is the fleet's own
# lesson from the same day, applied to the file that kept relearning it: parse,
# do not grep, when the question is "is this executed" rather than "is this
# mentioned."
ENV_ASSIGN = re.compile(r"[A-Za-z_]\w*=.*")

# Heredoc operators ONLY. `<<<` is a here-string — a different operator that
# consumes no body — and treating it as a heredoc with delimiter "<" discarded
# the rest of the run block, hiding real installs after it.
HEREDOC_OPERATORS = {"<<", "<<-"}

# Words that can precede the real command and still leave it at a command
# position. Matched by BASENAME, so /usr/bin/sudo counts.
LAUNCHERS = {"npx", "sudo", "yarn", "pnpm", "bunx", "dlx", "exec", "command", "time", "env"}

OPTIONS_TAKING_OPERAND = {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}

SEPARATORS = {";", "&&", "||", "|", "&", "(", ")", "{", "}", ";;", "|&"}


def _logical_lines(script):
    r"""Yield logical shell lines, joining backslash continuations.

    `echo \` + `  playwright install` is ONE command. Tokenizing physical lines
    made the first raise and be skipped, and the second parse as a standalone
    install — turning a docs job into a browser job.
    """
    buffer = ""
    for raw in script.splitlines():
        if _continues(raw):
            buffer += raw[:-1] + " "
            continue
        yield buffer + raw
        buffer = ""
    if buffer:
        yield buffer


def _continues(line):
    r"""True when a trailing backslash is a SYNTACTICALLY ACTIVE continuation.

    `echo ok # \` does not continue: bash ends the comment at the newline and
    runs the next line. Joining them anyway made shlex discard the next line as
    part of the comment, hiding a real install behind a docs line. A backslash
    inside quotes is not a continuation either.
    """
    if not line.endswith("\\"):
        return False
    quote = None
    index = 0
    while index < len(line) - 1:      # the trailing backslash itself is excluded
        char = line[index]
        if quote:
            if char == "\\" and quote == '"':
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char == "\\":
            index += 2
            continue
        elif char == "#" and (index == 0 or line[index - 1].isspace()):
            return False              # the backslash is inside a comment
        index += 1
    return quote is None


def _tokens(line):
    """Tokenize one logical line, or None when it cannot be parsed as shell.

    `punctuation_chars=True` is what makes separators reliable: shlex splits
    `ok;playwright` into three tokens while leaving a QUOTED `"a;b"` whole, which
    no amount of post-hoc string splitting can do. It also normalises `<<'EOF'`
    and `<< EOF` to the same two tokens, and keeps `<<<` distinct.
    """
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        # Unbalanced quotes: not parseable as shell. Claiming a job installs
        # browsers on text we cannot read is the false positive this file exists
        # to avoid — see the header's asymmetry.
        return None


def _lines_of_tokens(script):
    """Tokenize each logical line, dropping comments and heredoc BODIES."""
    delim = None
    pending = []
    for line in _logical_lines(script):
        if delim is not None:
            # `<<-` strips leading TABS from the body and the terminator.
            if line.strip() == delim:
                delim = pending.pop(0) if pending else None
            continue
        tokens = _tokens(line)
        if tokens is None:
            continue
        pending.extend(_heredoc_delims(tokens))
        if pending:
            delim = pending.pop(0)
        yield tokens


def _action_ref(uses):
    """The path/name part of a `uses:` value, with a remote @ref stripped.

    `@` separates a REMOTE action from its version. A LOCAL action takes no ref
    at all, so `@` in `./.github/actions/ui@wrapper` is an ordinary path
    character — splitting on it unconditionally truncated the path, the wrapper
    was never opened, and a caller under 60 passed. Parse remote syntax only
    where remote syntax applies.
    """
    uses = uses.strip()
    return uses if uses.startswith("./") else uses.split("@", 1)[0]


def _normalise_local(ref):
    """Collapse `.` and `..` segments in a local action path.

    `./.github/actions/./ui-suite` and `./.github/actions/w/../ui-suite` both
    resolve to the shipped composite on disk, so a raw string compare missed
    them — then opened the target as a WRAPPER, found it did not reference
    itself, and let a caller under 60 pass.

    Delegated to posixpath.normpath rather than hand-rolled. The hand-rolled
    loop took three review rounds (`./`, then `..`, then this), each fixing the
    segment type in front of it, and normpath has known the whole rule since
    before any of them. A workflow path is POSIX regardless of the runner, so
    posixpath — not os.path, which would answer differently on Windows.
    """
    if not ref.startswith("./"):
        return ref
    collapsed = posixpath.normpath(ref)
    return collapsed if collapsed.startswith("./") else "./" + collapsed.lstrip("/")


def _heredoc_delims(tokens):
    """Every heredoc delimiter opened on this line, in order.

    Two shapes were missed. `cat <<-EOF` tokenizes as ['cat', '<<', '-EOF'] once
    punctuation is split, so the delimiter arrives with the operator's dash stuck
    to it. And `cat <<A <<B` opens TWO bodies — stopping at the first left B's
    body read as executable text.
    """
    found = []
    for index, token in enumerate(tokens):
        if token in HEREDOC_OPERATORS and index + 1 < len(tokens):
            delim = tokens[index + 1]
            if token == "<<" and delim.startswith("-"):
                delim = delim[1:]      # `<<-EOF` split as `<<` + `-EOF`
            found.append(delim)
    return found


def _segments(tokens):
    """Split a logical line's tokens into command segments at separators."""
    current = []
    for token in tokens:
        if token in SEPARATORS:
            if current:
                yield current
            current = []
            continue
        current.append(token)
    if current:
        yield current


def _segment_installs(segment):
    """True when this ONE command is a playwright install.

    Launchers and env assignments INTERLEAVE — `env CI=1 playwright install` is
    valid, and skipping assignments only BEFORE launchers left `CI=1` treated as
    the command word, so a browser job passed at any bound. Consume both in one
    loop rather than in two phases.
    """
    index = 0
    while index < len(segment):
        token = segment[index]
        if ENV_ASSIGN.fullmatch(token) or PurePosixPath(token).name in LAUNCHERS:
            index += 1
            continue
        # Launcher OPTIONS and their operands. `env -u CI playwright install` is
        # valid and stopped the scan at `-u`, so the install went unclassified
        # and any bound passed. A bare `-` is not an option.
        if token.startswith("-") and len(token) > 1:
            index += 1
            if token in OPTIONS_TAKING_OPERAND:
                index += 1
            continue
        break
    if index >= len(segment) or PurePosixPath(segment[index]).name != "playwright":
        return False
    return index + 1 < len(segment) and segment[index + 1].startswith("install")


def _runs_playwright_install(script):
    return any(
        _segment_installs(segment)
        for tokens in _lines_of_tokens(script)
        for segment in _segments(tokens)
    )


class GitHubIntLoader(yaml.SafeLoader):
    """SafeLoader that resolves integers the way GitHub does.

    PyYAML applies YAML 1.1 tag-resolution rules; GitHub applies YAML 1.2. The
    disagreement runs in TWO directions, and the first fix here caught only one:

        070   1.1 -> octal 56          1.2 -> decimal 70    tagged int, wrong VALUE
        080   1.1 -> not an int at all 1.2 -> decimal 80    tagged STRING

    Replacing the int constructor fixed row one and could never fix row two: a
    constructor cannot run for a scalar the RESOLVER never tagged as an integer,
    so `timeout-minutes: 080` reached the check as the string '080' and a valid
    GitHub bound was rejected as "not an integer minute count" — the same red
    build on a healthy repo, one value-class over. (The `./` -> `..` path bug was
    this exact shape: a fix aimed at the instance instead of the class.)

    So the pattern below is registered BOTH as an implicit resolver and as the
    constructor's parser. One definition of "integer", used by both halves.
    """


# YAML 1.2's core-schema integer forms — decimal (leading zeros and all), 0o
# octal, 0x hex. Anchored because PyYAML calls .match() on implicit resolvers.
_GITHUB_INT = re.compile(r"[-+]?(?:0o[0-7]+|0x[0-9a-fA-F]+|[0-9]+)$")


def _ungroup(text):
    """Strip balanced enclosing `()` — GitHub permits them for grouping.

    Only a pair wrapping the WHOLE expression; `(a)+(b)` is not a literal and
    must stay unparseable. Its own function because BOTH the falsy-literal test
    and the numeric-bound parser need it: the first version lived inside the
    numeric parser, so `${{ ((0)) }}` was handled while `${{ (false) }}` was not
    — the same fix-in-one-place-used-in-two bug this file keeps producing, caught
    here by testing both paths instead of the one I had changed.
    """
    while len(text) > 1 and text[0] == "(" and text[-1] == ")":
        depth = 0
        for i, ch in enumerate(text):
            depth += (ch == "(") - (ch == ")")
            if depth == 0 and i < len(text) - 1:
                return text            # the opener closes early: not enclosing
        text = text[1:-1].strip()
    return text


def _expr_literal(text):
    """A GitHub EXPRESSION that is a bare numeric literal, as a float, else None.

    GitHub's expression language accepts decimal, hex and float literals and casts
    them to boolean, so `${{ 0 }}`, `${{ 0x0 }}` and `${{ 0.0 }}` all skip a step.
    Two callers need exactly this — the statically-disabled test and the
    constant-bound test — and they must agree, so it is defined once. Splitting it
    is how `${{ 0x0 }}` survived a round: the loader learned hex and the condition
    test, two functions below, was still calling float().
    """
    text = _ungroup(text.strip())
    # An expression is NOT YAML. YAML 1.2 spells its radix prefixes in lower case
    # and _github_int is strict about that on purpose; GitHub's expression
    # language is JS-shaped and takes `0X0` as readily as `0x0`. Normalising here
    # rather than loosening _github_int keeps each grammar honest — and a rule
    # that turned on letter case would be worse than either answer.
    text = re.sub(r"^([-+]?0)([XOB])", lambda m: m.group(1) + m.group(2).lower(), text)
    # Binary, which YAML 1.2 has no notion of and _github_int therefore rejects.
    # Handled here so the answer does not depend on WHICH radix an author picked:
    # hex disabled, binary counted would be an arbitrary rule, and arbitrary is
    # the property that gets a guard deleted.
    binary = re.fullmatch(r"([-+]?)0b([01]+)", text)
    if binary:
        return float(int(binary.group(2), 2) * (-1 if binary.group(1) == "-" else 1))
    value = _github_int(text)
    if value is not None:
        return float(value)
    try:
        return float(text)          # 0.0, 1e3 — forms int() will not take
    except ValueError:
        return None


def _github_int(text):
    """Parse a scalar as GitHub's YAML 1.2 parser would, or None if it is not an int."""
    text = text.strip()
    if not _GITHUB_INT.fullmatch(text):
        return None
    sign = -1 if text.startswith("-") else 1
    body = text.lstrip("+-")
    base = 8 if body.startswith("0o") else 16 if body.startswith("0x") else 10
    return sign * int(body[2:] if base != 10 else body, base)


def _int_yaml_1_2(loader, node):
    value = _github_int(loader.construct_scalar(node))
    if value is not None:
        return value
    # A form only YAML 1.1 calls an integer: underscore separators, `0b`,
    # sexagesimal `1:30`. GitHub may well reject these, but this guard has no
    # evidence either way, and inventing a rejection would red-build a repo over
    # a spelling nobody has observed. Keep PyYAML's reading; the two forms above
    # are the ones with measured disagreement.
    return yaml.SafeLoader.construct_yaml_int(loader, node)


GitHubIntLoader.add_constructor("tag:yaml.org,2002:int", _int_yaml_1_2)
# The resolver half. Without it the constructor above is unreachable for every
# form YAML 1.1 does not already call an integer.
GitHubIntLoader.add_implicit_resolver(
    "tag:yaml.org,2002:int", _GITHUB_INT, list("-+0123456789")
)


def load_jobs(path):
    """Return {job_id: job_mapping}, preserving YAML 1.1-collapsed key spellings.

    PyYAML speaks YAML 1.1, where the bare keys `on`, `yes`, `no`, `y` and `n`
    resolve to booleans. Two jobs named `yes` and `on` therefore collapse to a
    single `True` key and the later silently OVERWRITES the earlier — so an
    unbounded job disappears from this scan while GitHub still runs it. That is a
    green guard over a real defect, the one failure mode this file exists to
    prevent. workflow-ref-guard.py hit the same edge and solved it the same way:
    compose to NODES, where the original spelling survives.

    Raises yaml.YAMLError so the caller can fail closed on an unreadable file.
    """
    root = yaml.compose(path.read_text(encoding="utf-8"))
    if not isinstance(root, yaml.MappingNode):
        return None
    # LAST wins, not first. Duplicate top-level `jobs:` keys resolve to the last
    # occurrence in both GitHub and PyYAML — workflow-ref-guard.py:138-140 already
    # records this. Taking the first left a bounded decoy mapping shadowing the
    # real unbounded one, green here and running there.
    found = None
    for key_node, value_node in root.value:
        if isinstance(key_node, yaml.ScalarNode) and key_node.value == "jobs":
            found = value_node
    if found is None or not isinstance(found, yaml.MappingNode):
        return None
    jobs = {}
    for jk, jv in found.value:
        if isinstance(jk, yaml.ScalarNode):
            jobs[jk.value] = yaml.serialize(jv)
    # Re-parse each job body individually: the collision only affects the jobs
    # mapping's own keys, and per-job bodies are ordinary data.
    return {k: yaml.load(v, Loader=GitHubIntLoader) for k, v in jobs.items()}


def _statically_disabled(step):
    """True only for a step GitHub can see is off without evaluating anything.

    A step guarded by `if: false` never runs, so it incurs neither the composite's
    cost nor the install's — charging its job the corresponding floor is a false
    positive in the still-ENFORCED ui-suite rule.

    Deliberately literal-only. Any condition referencing context (`github.event`,
    a job output, an input) is unevaluatable here, and the two mistakes are not
    symmetric: counting a step that will be skipped costs a red build on a repo
    that is fine, while EXCLUDING one that will run lets a 40-minute ui-suite
    caller through — the drift this file exists to stop. So the unevaluatable
    case counts, and only a literal false is excused. That asymmetry is why this
    is not the bash-parsing trap that made the browser floor advisory: the domain
    here is a closed set of spellings, not free-form shell.
    """
    cond = step.get("if", True)
    if cond is True:
        return False
    if cond is False:
        return True
    # GitHub CASTS a literal condition to boolean, so `false` is not the only
    # spelling that skips a step: its documented table makes every zero number
    # and the empty string falsy too. Round 15 arrived asking for `if: 0` alone;
    # adding just that would have been the `070` -> `080` mistake a third time,
    # so the whole cast table is handled here at once.
    if isinstance(cond, (int, float)):
        return cond == 0
    if not isinstance(cond, str):
        # `if:` with no value parses as None, indistinguishable at this layer
        # from an explicit `if: null`. Excluding a step is the UNSAFE direction
        # (it lets a 40-minute ui-suite caller through), so an ambiguous
        # condition counts.
        return False
    text = cond.strip()
    wrapped = re.fullmatch(r"\$\{\{(.*)\}\}", text, re.S)
    inner = _ungroup(wrapped.group(1).strip() if wrapped else text)
    if wrapped and not inner:
        return False                      # `${{ }}` is malformed; do not guess
    if not inner or inner in ("''", '""'):
        return True                       # empty string literal -> false
    if inner.lower() in ("false", "null"):
        # `null` is reached ONLY as a string — either quoted or inside `${{ }}` —
        # because a bare `if: null` parses to Python None and is handled above as
        # ambiguous with an empty YAML value. Wrapped or quoted, there is no
        # ambiguity: it is the literal GitHub casts to false. The distinction is
        # the one this function already draws; I just hadn't followed it through.
        return True
    # 0, -0, 00, 0.0, 0e0, 0x0, 0o0, ${{ 0 }} — every numeric literal GitHub
    # casts to false. Anything else is an expression: unevaluatable, so it counts.
    literal = _expr_literal(inner)
    return literal == 0.0 if literal is not None else False


def _steps(node):
    for step in (node or {}).get("steps") or []:
        if isinstance(step, dict) and not _statically_disabled(step):
            yield step


def _uses_ui_suite(node, seen):
    """True when this job/composite reaches the LOCAL ui-suite composite.

    Transitive on purpose: a wrapper composite that itself uses ui-suite incurs
    the identical cost, and a direct-reference-only test let a 40-minute caller
    pass simply by renaming or wrapping the shipped action.
    """
    for step in _steps(node):
        uses = str(step.get("uses", "")).strip()
        ref = _normalise_local(_action_ref(uses))
        if ref == UI_SUITE_LOCAL:
            return True
        # Follow LOCAL composites only. A remote action's definition is not on
        # disk, and guessing at its cost is how the suffix match went wrong.
        if ref.startswith("./") and ref not in seen:
            seen.add(ref)
            for name in ("action.yml", "action.yaml"):
                path = REPO_ROOT / ref[2:] / name
                if path.is_file():
                    try:
                        sub = yaml.safe_load(path.read_text(encoding="utf-8"))
                    except yaml.YAMLError:
                        break
                    runs = (sub or {}).get("runs")
                    if isinstance(runs, dict) and _uses_ui_suite(runs, seen):
                        return True
                    break
    return False


def is_ui_suite_job(job):
    return _uses_ui_suite(job, set())


def is_browser_job(job):
    """True when a step RUNS the install. `uses:` cannot install browsers."""
    return any(_runs_playwright_install(str(step.get("run", ""))) for step in _steps(job))


errors = []
warnings = []
checked = 0
unevaluatable = []

for scan_dir in SCAN_DIRS:
    directory = REPO_ROOT / scan_dir
    if not directory.is_dir():
        errors.append(f"{scan_dir}/ does not exist — wrong root? Scanned from {REPO_ROOT}.")
        continue
    for path in sorted(directory.glob("*.yml")) + sorted(directory.glob("*.yaml")):
        rel = path.relative_to(REPO_ROOT)
        try:
            jobs = load_jobs(path)
        except yaml.YAMLError as exc:
            # FAIL CLOSED: a file this check cannot read is reported, never
            # skipped — a workflow silently treated as empty passes every rule.
            errors.append(f"{rel} is not parseable YAML, so its jobs were never checked: {str(exc).strip()}")
            continue
        if not isinstance(jobs, dict):
            errors.append(f"{rel} has no jobs mapping — not a workflow, or malformed.")
            continue
        for name, job in jobs.items():
            if not isinstance(job, dict):
                errors.append(f"{rel} → job '{name}' is not a mapping.")
                continue
            if "uses" in job:
                continue  # reusable-workflow call: cannot carry timeout-minutes
            checked += 1
            bound = job.get("timeout-minutes")
            if bound is None:
                errors.append(
                    f"{rel} → job '{name}' has no timeout-minutes.\n"
                    f"      Unbounded means GitHub's 6-hour default: a wedged step shows neither pass\n"
                    f"      nor fail for the whole time. Bound it — and size the bound from the job's\n"
                    f"      measured COLD path, not its warm one (see this file's header, rule 3)."
                )
                continue
            # bool FIRST: Python's bool subclasses int, so `timeout-minutes: true`
            # (a YAML boolean) passes an isinstance(int) check while being no
            # minute count at all — green here, broken after installation.
            if isinstance(bound, bool):
                errors.append(f"{rel} → job '{name}' timeout-minutes is {bound!r}, not an integer minute count.")
                continue
            if isinstance(bound, str) and "${{" in bound:
                # GitHub PERMITS expressions here, and a CONTEXT-dependent one
                # (matrix, inputs, vars) genuinely cannot be range-checked — the
                # job IS bounded, which is rule 1, and failing it would red-build
                # a valid workflow.
                #
                # But a CONSTANT expression is not context-dependent. `${{ 360 }}`
                # evaluates to 360, and exempting it meant the guard printed "none
                # >= 360" about a job bounded at exactly the value rule 2 exists to
                # reject — the pass line asserting the opposite of the truth, which
                # is this PR's own defect class. Evaluate what is evaluable.
                literal = _expr_literal(re.fullmatch(r"\$\{\{(.*)\}\}", bound.strip(), re.S).group(1)) \
                    if re.fullmatch(r"\$\{\{(.*)\}\}", bound.strip(), re.S) else None
                if literal is None or literal != int(literal):
                    unevaluatable.append(f"{rel} → {name}")
                    continue
                bound = int(literal)
            if not isinstance(bound, int):
                errors.append(f"{rel} → job '{name}' timeout-minutes is {bound!r}, not an integer minute count.")
                continue
            if bound <= 0:
                errors.append(
                    f"{rel} → job '{name}' declares timeout-minutes: {bound} — no usable execution\n"
                    f"      window at all. The job dies immediately, which reads as flaky CI, not as\n"
                    f"      a bound set to nothing."
                )
                continue
            if bound >= GITHUB_DEFAULT:
                errors.append(
                    f"{rel} → job '{name}' declares timeout-minutes: {bound}, but GitHub's default is\n"
                    f"      {GITHUB_DEFAULT} — declaring >= it changes nothing and reads as protection. Pick a\n"
                    f"      bound the job's real worst case fits under."
                )
                continue
            # A job GitHub skips incurs no cost, so the two COST floors below do
            # not apply to it. Rules 1 and 2 still did, above, and deliberately:
            # bounding a parked job is free, and an unbounded or 400-minute job
            # is a live defect the moment someone re-enables it. Cost is
            # conditional on running; a declaration is not.
            if _statically_disabled(job):
                continue
            if bound < UI_SUITE_FLOOR and is_ui_suite_job(job):
                errors.append(
                    f"{rel} → job '{name}' runs the ui-suite composite under timeout-minutes: {bound}.\n"
                    f"      That composite is install + EVERY project + retries + upload in ONE sum. A\n"
                    f"      bound of {bound} cancels a HEALTHY run, and a cancelled run is not a red one:\n"
                    f"      it reads as inconclusive, so nobody chases it. ui-suite callers need >= {UI_SUITE_FLOOR}."
                )
            elif bound < BROWSER_FLOOR and is_browser_job(job):
                # ADVISORY, not an error — see the header. Deciding whether a
                # `run:` block invokes playwright means parsing bash, and four
                # review rounds produced twenty findings against successive
                # attempts, roughly half of them FALSE POSITIVES that would
                # red-build a correct repo. A heuristic over free-form shell is
                # not sound enough to be a hard gate; it is useful enough to
                # print. Rules 1 and 2 still bound the job either way.
                warnings.append(
                    f"{rel} → job '{name}' installs Playwright browsers under timeout-minutes: {bound}.\n"
                    f"      A cold-cache install has been measured as high as 21m25s upstream; a bound of\n"
                    f"      {bound} risks killing a cold run before a test executes AND skipping the cache\n"
                    f"      save that would warm the next one (#238). Browser jobs want >= {BROWSER_FLOOR}\n"
                    f"      — ADVISORY: this does not fail the build."
                )

for warning in warnings:
    sys.stderr.write("⚠️  check-job-bounds: " + warning + "\n\n")

if errors:
    sys.stderr.write("❌ check-job-bounds: FAILED\n\n")
    for err in errors:
        sys.stderr.write("  • " + err + "\n\n")
    raise SystemExit(1)

scope = ", ".join(SCAN_DIRS)
note = f" {len(unevaluatable)} expression-bounded job(s) not range-checked." if unevaluatable else ""
# Report only what was ENFORCED. Naming the advisory browser floor here said the
# run had passed a rule it no longer checks — and said it loudest in the one
# scenario the advisory exists for, a sub-30 browser job, which warns and then
# exits green under a line claiming `direct browser jobs >= 30`. A pass line that
# credits an unenforced rule is the same defect as a bound that is a number in a
# comment: assurance with nothing behind it.
advisory = (
    f" {len(warnings)} browser-floor advisory notice(s) printed above — ADVISORY, not enforced."
    if warnings
    else f" Browser floor (>= {BROWSER_FLOOR}) is ADVISORY and had nothing to report."
)
print(
    f"✅ check-job-bounds: {checked} job(s) in {scope} bounded, none >= {GITHUB_DEFAULT}, "
    f"ui-suite callers >= {UI_SUITE_FLOOR}.{note}{advisory}"
)
