#!/usr/bin/env python3
"""Refuse a report-path that is not a single relative path inside the workspace.

WHY THIS IS A SEPARATE STEP. `report-path` reaches three consumers: an `rm`, a
`--report` argument, and a MULTILINE `path:` list on actions/upload-artifact.
That last one is the dangerous shape -- a newline in the value becomes another
entry in the list, and the upload step runs under `always()`, so a caller
deriving the input from untrusted workflow input could have an arbitrary
runner-readable file uploaded even on a failing run (Codex, #347 round 8).

Validated ONCE here rather than escaped at each use. Three consumers with three
escaping rules is how one of them ends up wrong, and this composite has already
been caught twice on exactly that coupling: a `--report` the guard accepted and
the gate ignored, and an upload path the gate read and the artifact did not.

NOT exported on its own -- it ships inside templates/actions/ui-suite/, which
projects copy whole.
"""
import os
import re
import sys
from pathlib import PurePosixPath

raw = os.environ.get("REPORT_PATH", "")
tests_dir = os.environ.get("TESTS_DIR", ".")


def refuse(reason, detail=None):
    print("validate-report-path: REFUSED")
    print(f"  {reason}")
    if detail:
        print(f"  {detail}")
    print("  report-path must be ONE relative path that stays inside the workspace.")
    print("  test.md -> UI coverage gates, fifth gate.")
    sys.exit(1)


# THE DEFAULT IS DERIVED HERE, NOT WRITTEN IN THE ACTION'S YAML. It used to be
# the literal `../../../.agent-reports/playwright-results.json`, which is correct
# for exactly one `tests-dir` -- the shipped kit's `.github/scripts/ui-tests`,
# three levels below the workspace -- and wrong for every other depth the
# `tests-dir` contract permits. Codex reproduced `tests-dir: e2e` resolving the
# default to `/.agent-reports/...` and `tests-dir: tests/ui` resolving it ABOVE
# the repository, both refused by this validator before any test ran (#347
# round 21). A default that only works at one depth is a hidden coupling between
# two inputs, and nothing said so.
#
# Deriving it keeps the `.agent-reports/` convention the rest of the toolkit
# uses (usage-guide.md, the review agents) while depending on no depth at all:
# this step knows both the workspace and the tests dir, which is exactly what
# computing the relative path needs, and nowhere else in the composite does.
#
# The value still travels as a tests-dir-relative path, because both consumers
# need it that way -- the gate resolves `--report` against the tests dir, and
# PLAYWRIGHT_JSON_OUTPUT_FILE resolves against the run step's cwd, which is the
# same directory. So it is derived and then validated exactly like a supplied
# one: everything below this point does not know or care which it got.
DEFAULT_REPORT = ".agent-reports/playwright-results.json"

# STRICTLY EMPTY, and whitespace is NOT empty. A whitespace-only value falls
# through to the character rules below, which refuse surrounding whitespace with
# a diagnostic about what the caller typed. Deriving there would silently replace
# a value someone wrote — and #347 round 20 established, on this PR, that
# whitespace can be a path's CONTENT rather than a synonym for absent.
if raw == "":
    workspace_root = os.path.realpath(os.environ.get("GITHUB_WORKSPACE") or os.getcwd())
    tests_root = os.path.realpath(os.path.join(workspace_root, tests_dir))
    try:
        raw = os.path.relpath(os.path.join(workspace_root, DEFAULT_REPORT), tests_root)
    except ValueError as exc:  # different drives on Windows runners
        refuse("report-path was not given and a default could not be derived.",
               f"{exc}. Pass report-path explicitly.")
    print(f"validate-report-path: no report-path given, derived {raw!r}")
    print(f"  ({DEFAULT_REPORT} relative to tests-dir {tests_dir!r})")

# THE CHARACTER RULES, FACTORED SO THEY CAN RUN TWICE. They were written against
# `report-path` alone, but the value that reaches the consumers is `tests_dir` +
# `report-path`, and NOTHING validated the first half. Codex reproduced
# `TESTS_DIR='suite?'` emitting `path=suite?/results.json`, which the uploader
# expands as a pattern across sibling directories (#347 round 13); measuring it
# turned up the worse sibling, a NEWLINE in tests-dir emitting a two-line `path`
# — the artifact-list injection this whole file exists to stop, arriving through
# the input nobody was checking.
#
# So the rules run on the raw input (where the diagnostics are about what the
# caller typed) and again on the final emitted value (where they are about what
# the consumers actually receive). Validating only the input is the same class of
# mistake as round 9's upload interpolating a value the validator had rejected:
# the check has to be on the thing that travels.
LINE_BREAKS = "\n\r\v\f\x1c\x1d\x1e\x85  "
# `!` IS NOT IN HERE, because it is not a metacharacter where it appears. In an
# upload-artifact path list `!` negates a pattern only as the FIRST character of
# an entry; inside a filename it is an ordinary character, and `reports/run!1.json`
# is a perfectly good Linux filename that the quoted `rm`, Node's path resolution
# and the uploader all address as one file. Banning it everywhere refused a config
# every consumer handles correctly — the same false-refusal shape as the colon
# rule corrected in round 24, and as the `Array.isArray` refusal round 27 put into
# the viewport gate (Codex, #347 round 28). The leading position IS load-bearing,
# so it is refused separately below.
GLOB_CHARS = "*?"


def _has_class(segment):
    """True when a path SEGMENT contains a real minimatch character class.

    MEASURED against minimatch 9/10 with `minimatch(p, p)`, which self-matches
    exactly when `p` is literal:

        report[].json    literal  -- an empty pair is not a class
        report[!].json   literal  -- a negation marker with no member is not one
        report[^].json   literal  -- likewise
        report[!a].json  CLASS
        report[]].json   CLASS    -- a leading `]` is a MEMBER, not the close
        r[12].json       CLASS
        a[/]b.json       literal  -- a class cannot span a path separator

    Round 30 banned the brackets, round 31 required a non-empty body, and round
    35 found `[!]` and `[^]` -- the eighth false refusal on this PR, and the
    third on this one rule. Each earlier version was a shorter description of
    the construct than the construct is. So this walks it: an opening bracket,
    an optional negation marker, an optional leading `]` that counts as a
    member, then a closing bracket with at least one member before it.
    """
    i = 0
    while True:
        i = segment.find("[", i)
        if i < 0:
            return False
        j = i + 1
        if j < len(segment) and segment[j] in "!^":
            j += 1
        members_start = j
        if j < len(segment) and segment[j] == "]":
            j += 1  # a `]` immediately after the marker is a member, not the close
        close = segment.find("]", j)
        if close >= 0 and close > members_start:
            return True
        i += 1


def forbid_chars(value, what):
    # Any vertical whitespace, not just \n: \r splits the artifact list too, and
    # a lone \r would otherwise pass a `"\n" in value` test while still ending
    # the line.
    if any(ch in value for ch in LINE_BREAKS):
        refuse(f"{what} contains a line break.",
               f"got {value!r} -- it is interpolated into a MULTILINE artifact "
               "path list, where a second line is a second file to upload.")
    # GLOB METACHARACTERS, because the consumer that matters expands them.
    # `actions/upload-artifact` treats each path entry as a PATTERN, so
    # `../../../**/*` survives the containment check below -- it resolves
    # workspace-local -- and then uploads the whole workspace (Codex, #347 round
    # 9). Containment answers "where does this land", which is the wrong question
    # for a value that names MANY places.
    if any(ch in value for ch in GLOB_CHARS):
        refuse(f"{what} contains glob metacharacters.",
               f"got {value!r} -- the artifact uploader expands patterns, so this "
               "names a set of files rather than the one report.")
    # A BACKSLASH IS AN ESCAPE TO THE UPLOADER AND A LETTER TO EVERYONE ELSE.
    # On the Linux runners every shipped caller uses, `foo\bar.json` is a legal
    # filename that the quoted `rm`, Node and Playwright all address literally --
    # but as an upload-artifact PATTERN it escapes the next character. Measured
    # against minimatch: `minimatch('foobar.json', 'foo\bar.json')` is TRUE and
    # the pattern does not match its own name. So the gate would verify one file
    # and the artifact would collect a different one, or none (Codex, #347 r32).
    #
    # This is the same divergence the glob rules cover, not a new class: a
    # character that means something to the consumer that expands patterns.
    if "\\" in value:
        refuse(f"{what} contains a backslash.",
               f"got {value!r} -- the artifact uploader reads it as a pattern "
               "escape while every other consumer reads it as a filename "
               "character, so the file verified is not the file uploaded.")
    # A CHARACTER CLASS IS A `[` WITH A CLOSING `]`, not either bracket on its
    # own. minimatch treats an unmatched bracket as literal, so `report].json`
    # and `report[.json` name exactly one file and every consumer -- the quoted
    # `rm`, Node's resolution, the uploader -- reads them that way. Banning the
    # characters refused ordinary Linux filenames for a property they do not
    # have: the fourth false refusal on this PR, after the colon (r24), the
    # `Array.isArray` entry check (r28) and the leading `!` applied to the wrong
    # value (r29). Detected as the construct rather than as its letters
    # (Codex, #347 round 30).
    # MEASURED AGAINST minimatch ITSELF, not reasoned about. `minimatch(p, p)`
    # self-matches exactly when `p` is literal:
    #   report[].json   literal  -- an EMPTY pair is not a class (round 31)
    #   report[]].json  CLASS    -- a `]` may be the class's first member
    #   a[/]b.json      literal  -- a class cannot span a path separator
    #   r[12].json      CLASS
    # So: a non-empty body, within one segment. Round 30's `\[[^\[]*\]` allowed an
    # empty body and ignored segments -- two more false refusals, one of them
    # caught here only because this rule was measured rather than argued.
    if any(_has_class(seg) for seg in value.split("/")):
        refuse(f"{what} contains a character class.",
               f"got {value!r} -- `[...]` is a glob character class to the "
               "artifact uploader, so this names a set of files rather than the "
               "one report.")



def forbid_edges(value, what):
    """Rules about an entry's EDGES -- applied to the resolved entry only.

    THE ARTIFACT ENTRY IS `landed`, NOT THE INPUT. Round 28 put the leading-`!`
    rule in forbid_chars(), which runs on the RAW tests-dir-relative value too --
    so with a nested tests-dir, `!report.json` (which the uploader receives as
    `templates/ui-tests/!report.json`, where the `!` is interior and literal) was
    refused for a property it does not have. Same for surrounding whitespace: the
    uploader trims the whole ENTRY, so a space at the edge of the raw input is
    interior once the prefix is prepended (Codex, #347 round 29).

    Both rules are about the uploader's whole-entry semantics -- negation and
    trimming -- so they belong where the entry exists and nowhere else. The
    position-independent rules in forbid_chars() still run on both values,
    because a line break or a glob metacharacter is one wherever it sits.
    """
    # As an entry's FIRST character `!` makes the line an EXCLUSION, subtracting
    # the report from the upload set rather than adding it -- and every other
    # rule here would pass.
    if value.startswith("!"):
        refuse(f"{what} starts with '!'.",
               f"got {value!r} -- a leading '!' in an artifact path entry NEGATES "
               "the pattern, so this subtracts the report from the upload instead "
               "of naming it.")
    # SURROUNDING WHITESPACE, because the uploader TRIMS each pattern before
    # resolving it: `../../../ ~/.ssh/id_rsa` lands as ` ~/.ssh/id_rsa`, whose
    # first component is " ~" and so slips the leading-tilde rule, and then gets
    # trimmed and expanded to the runner's home (Codex, #347 round 14).
    if value != value.strip():
        refuse(f"{what} has leading or trailing whitespace.",
               f"got {value!r} -- a path list trims each entry, so this is not "
               "the path you think, and a trimmed value can mean something else "
               "entirely.")


forbid_chars(raw, "report-path")

# A COLON IS ONLY A DRIVE ON A DRIVE-LETTERED SYSTEM. `raw[1] == ":"` refused
# `a:report.json`, which on the `ubuntu-latest` every shipped caller runs is an
# ordinary relative filename all three consumers resolve against tests-dir
# (Codex, #347 round 24). The rule was written for a Windows runner and applied
# everywhere, which is the same over-broad shape as round 20's `trim()`: correct
# about what it meant to refuse, wrong about how to recognise it.
#
# Narrowed to the actual syntax — a single ASCII letter, a colon, and then a
# separator or nothing, which is what `C:` and `C:\path` look like — and only
# where the platform HAS drive letters. `os.path.isabs` on Windows already covers
# `C:\path`; this keeps the bare-drive and drive-relative forms out too.
_drive = (len(raw) > 1 and raw[1] == ":" and raw[0].isascii() and raw[0].isalpha()
          and (len(raw) == 2 or raw[2] in "\\/"))
if PurePosixPath(raw).is_absolute() or raw.startswith("\\") or (os.name == "nt" and _drive):
    refuse("report-path is absolute.", f"got {raw!r}")

# ── WHERE DOES IT LAND, ASKED OF REAL PATHS ──────────────────────────────────
# Rounds 8-10 answered this with string rules on the NORMALISED text, and each
# one was right about the case that motivated it and wrong one step out:
# `landed.startswith("..")` refused `..report.json`, and `os.path.isabs(landed)`
# refused a workspace-local absolute `tests-dir` that the composite's
# working-directory consumers accept (Codex, #347 rounds 10 and 11).
#
# So the containment question is now asked of resolved absolute paths against
# the workspace root, which is what "inside the workspace" actually means.
# realpath on BOTH sides: a symlink inside the workspace pointing out of it lands
# outside, and a workspace root that is itself a symlink would otherwise never
# match its own children.
workspace = os.path.realpath(os.environ.get("GITHUB_WORKSPACE") or os.getcwd())

# RESOLVE THE DIRECTORY, KEEP THE FILENAME LEXICAL. Round 11 resolved the whole
# path, which resolves the FINAL component too -- and if that component is a
# symlink the three consumers stop naming the same file. Codex reproduced
# `report.json -> ../target.txt`: the upload got `path=target.txt` while
# `relative` still said `report.json`, so the clear step removed the link,
# Playwright wrote a fresh report at the link's name, and the artifact collected
# the untouched target instead of the report (#347 round 12).
#
# Resolving the PARENT still catches a directory symlink pointing out of the
# workspace, which is what round 11 added realpath for. Appending the filename
# lexically keeps every consumer on one name.
# os.path.dirname AND os.path.basename, not PurePosixPath().name for the second
# half. The two disagree: for `../../../.` dirname gives `../../..` and basename
# gives `.`, but PurePosixPath normalises the trailing dot away and reports `..`
# — so pairing them double-counted a level and pointed the check one directory
# too high. Caught by running the existing `..` cases against the new resolution,
# not by reading it.
raw_dir = os.path.dirname(raw)
parent_abs = os.path.realpath(os.path.join(workspace, tests_dir, raw_dir) if raw_dir
                              else os.path.join(workspace, tests_dir))
landed_abs = os.path.join(parent_abs, os.path.basename(raw))
try:
    contained = os.path.commonpath([landed_abs, workspace]) == workspace
except ValueError:      # different drives on Windows runners
    contained = False
if not contained:
    refuse("report-path resolves outside the workspace.",
           f"{tests_dir!r} + {raw!r} -> {landed_abs!r}, outside {workspace!r}")

# AND REFUSE A SYMLINKED FINAL COMPONENT OUTRIGHT. Keeping the name lexical makes
# the three consumers agree, but the link is still there when Playwright opens
# the path for writing, and a write follows it. The `rm -f` step ahead of the run
# removes it in the shipped ordering -- that is an ordering, not a guarantee, and
# this file exists so no consumer has to depend on another's behaviour.
if os.path.islink(landed_abs):
    refuse("report-path is a symlink.",
           f"{landed_abs!r} -- a link makes the file the gate reads, the file the "
           "run writes and the file the uploader collects three different questions.")

# A DIRECTORY IS NOT A REPORT, and the uploader treats one very differently.
# `actions/upload-artifact` given a directory uploads it RECURSIVELY, so
# `../../../.` — which resolves to the workspace root and passes every rule
# above — publishes the entire workspace as an artifact. Codex walked the whole
# path through on #347 round 11: validation succeeds, the `rm -f` step fails
# (GNU rm refuses `.`), and the upload still runs because it is gated on the
# VALIDATION's outcome, not the clear step's.
#
# Refused rather than escaped, because "which of these three consumers treats a
# directory the way I meant" is the coupling this file exists to remove.
if os.path.isdir(landed_abs):
    refuse("report-path names a directory, not a report file.",
           f"{tests_dir!r} + {raw!r} -> {landed_abs!r} -- the artifact uploader "
           "publishes a directory recursively, so this names the whole tree.")

# `.` and `..` as the FINAL component name a directory even when it does not
# exist yet, so the check above would miss them on a clean checkout. So does a
# TRAILING SLASH, and that one is checked on the raw string rather than through
# PurePosixPath, which strips it -- `PurePosixPath("reports/").name` is
# "reports", so a path parser cannot see the thing that makes it a directory.
# (Found by the case, not by reading the fix: the first version of this rule
# used only the parsed name and let `reports/` through.)
if raw.endswith("/") or raw.endswith("\\") or os.path.basename(raw) in ("", ".", ".."):
    refuse("report-path does not end in a filename.", f"got {raw!r}")

# The value the artifact uploader gets, which is the one the tilde rule is about.
landed = os.path.relpath(landed_abs, workspace)

# A LEADING `~` IS A THIRD PLACE THIS CAN LAND. `actions/upload-artifact`
# expands a leading tilde to the runner's home directory, which is OUTSIDE the
# workspace and outside everything the containment rule above reasons about:
# `../../../~/secret.txt` resolves to a real path inside the workspace, and the
# workspace-relative form handed to the uploader is `~/secret.txt`, which that
# consumer reads as the runner's home (Codex, #347 round 10). The containment
# check answers "where does this path point"; the tilde makes that a different
# question for one consumer, so it is refused rather than reasoned about.
# ...AND ONLY WHEN THE FIRST COMPONENT IS EXACTLY `~`. Measured in
# @actions/glob's own source (internal-pattern.js `fixupPattern`): expansion
# fires for `pattern === '~'` or `pattern.startsWith('~' + path.sep)` and nothing
# else. So `~reports/run.json` -- and `~root/.ssh/id_rsa`, which THIS FILE HAS
# BEEN REFUSING SINCE ROUND 10 with a case pinning it -- are ordinary literal
# directory names the uploader never expands, already covered by containment.
# `startswith("~")` was a text prefix standing in for the construct, which is the
# same substitution round 10 corrected for `..` two lines of reasoning away from
# here (Codex, #347 round 32). Seventh false refusal on this PR, and the oldest.
if landed.split(os.sep)[0] == "~":
    refuse("report-path resolves to a home-directory reference.",
           f"{tests_dir!r} + {raw!r} -> {landed!r} -- the artifact uploader expands "
           "a leading ~ to the runner's home, outside the workspace entirely.")

# HAND THE VALIDATED PATH ON IN BOTH BASES, so NO consumer re-reads the raw
# input. Round 9 did this for the upload alone and left the other three steps on
# `${{ inputs.report-path }}`; the post-run gate runs under `always()`, so a
# REFUSED value still reached it and `/dev/zero` blocked its read forever (Codex,
# #347 round 10). One escaped consumer is the same defect as no validation, and
# the reason it escaped was that there were two bases and only one output:
#   path      -- workspace-relative, for actions/upload-artifact
#   relative  -- tests-dir-relative, for the steps that run from tests-dir
# `relative` is the raw value AFTER every rule above accepted it, which is what
# makes it safe to pass on; it is not the raw input by another name.
# THE VALUE THE CONSUMERS ACTUALLY GET, checked as such. `landed` carries
# tests-dir, which no rule above has looked at (#347 round 13).
forbid_chars(landed, "the resolved report path")
forbid_edges(landed, "the resolved report path")

out = os.environ.get("GITHUB_OUTPUT")
if out:
    with open(out, "a", encoding="utf-8") as handle:
        handle.write(f"path={landed}\n")
        handle.write(f"relative={raw}\n")

print(f"validate-report-path: OK -- {raw!r} resolves to {landed!r}, inside the workspace.")
