#!/usr/bin/env python3
"""Fail when a tracked Python file compiles with a syntax-level warning.

WHY THIS EXISTS. A compile-time warning inside a GUARD is a scheduled outage,
not a lint nit, and it announces itself years before it bites.
check-job-bounds.py quoted a shell backslash-backtick inside a plain (non-raw)
docstring. Python reads that as an unrecognised escape, and the severity climbs
with the interpreter:

    3.11   DeprecationWarning   hidden by default -- nobody sees it
    3.12   SyntaxWarning        SHOWN by default  -- a downstream session
                                reported it from their runner
    3.15   SyntaxError          the file does not compile

No workflow in this repo pins a Python version, so CI already runs past the
middle row and will one day cross the last one on a runner-image bump nobody
here initiates. On that day check-job-bounds.py stops running, and every job
bound it verifies silently stops being verified -- while the failure reads as
"the Python upgrade broke CI", which is the wrong thing to go and fix.

WHAT IT CHECKS. Both SyntaxWarning and DeprecationWarning, because the SAME
defect wears whichever name the running interpreter gives it; checking only the
3.12+ name would report this repo clean on 3.11 and let the bug land.

Compiles from SOURCE TEXT rather than via py_compile: py_compile writes a .pyc
and a cached module never re-emits its compile warnings, so the naive version of
this check passes on every run after the first -- a guard that self-disarms,
which is the exact class of defect it is here to catch.
"""

import subprocess
import sys
import warnings

CATEGORIES = (SyntaxWarning, DeprecationWarning)


def tracked_python_files():
    # -z / NUL-split, NOT the default newline output. `git ls-files` C-QUOTES a
    # path containing non-ASCII or control bytes -- `cafe\u0301.py` comes back as
    # `"caf\\303\\251.py"`, quotes and octal escapes included -- and passing that
    # display form to open() raises FileNotFoundError for a file that exists.
    # The guard would go red on a valid repo, which is the failure mode a guard
    # must never invent. -z emits paths verbatim.
    out = subprocess.run(['git', 'ls-files', '-z', '*.py'],
                         capture_output=True, check=True).stdout
    return [f for f in out.decode('utf-8', 'surrogateescape').split('\0') if f]


def main():
    files = tracked_python_files()
    if not files:
        # No files means no checks, and "OK -- 0 files" is a vacuous pass. This
        # script lives beside guards whose whole history is vacuous passes.
        print('FAIL: no tracked .py files found — this check verified nothing.')
        return 1

    findings = 0
    for path in files:
        # Read BYTES and let compile() decode. A hard-coded utf-8 read raises
        # UnicodeDecodeError on a file carrying a PEP 263 declaration such as
        # `# coding: latin-1` -- which Python itself compiles happily. compile()
        # honours the declaration when handed bytes, so this reports what the
        # interpreter would actually say rather than a false failure of its own.
        with open(path, 'rb') as fh:
            source = fh.read()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('always')
            try:
                compile(source, path, 'exec')
            except SyntaxError as err:
                print(f'FAIL: {path}:{err.lineno}: SyntaxError: {err.msg}')
                findings += 1
                continue
        for w in caught:
            if issubclass(w.category, CATEGORIES):
                print(f'FAIL: {path}:{w.lineno}: {w.category.__name__}: {w.message}')
                findings += 1

    if findings:
        print(f'check-py-warnings: FAIL — {findings} finding(s) across {len(files)} file(s)')
        return 1
    print(f'check-py-warnings: OK — {len(files)} tracked .py file(s) compile clean')
    return 0


if __name__ == '__main__':
    sys.exit(main())
