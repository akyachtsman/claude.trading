# Watchlist roster storage and writes

Where the roster lives (`desk_watchlists`), the version-guarded replace-all (`desk_014`), create / delete a whole list, and the ✎ editor (`wlMutate`; scenarios S30, S31).

  **The roster is NOT in this repo.** It lives in `desk_watchlists`
  (`desk_010`): RLS deny-all, reached by anon only through SECURITY DEFINER RPCs — the
  PIN-gated `desk_get_watchlists` / `desk_set_watchlists` and the anon-callable
  `_open` variants the panel actually uses (`desk_012`/`desk_014`; see the accepted
  residual under Security Constraints) — and read server-side by `desk-watchlist`
  with the service key. `config/watchlists.json` is a
  BOOTSTRAP FALLBACK ONLY — editing it does nothing once the table is
  populated, and it says so in its own `_note`. `desk_set_watchlists` takes the
  COMPLETE desired state, so add/remove symbol and create/rename/reorder/delete
  list all land atomically in one replace-all; the seed is guarded on emptiness
  (not a fixed id) so a replay can't clobber later edits — the documented
  `desk_009` hazard.
  **A replace-all is version-guarded** (`desk_014`). `desk_get_watchlists_open`
  returns a `version` — `max(updated_at)` — and `desk_set_watchlists_open` takes
  `expected_version`, holds an exclusive table lock and REFUSES with
  `{ok:false, error:'conflict', version}` when the table has moved since. Every
  caller in this repo sends it; `null` means "do not check", so a cached
  pre-`desk_014` tab keeps working rather than bricking mid-session. This exists
  because a replace-all is otherwise a last-write-wins overwrite of everything
  that happened while a dialog was open, and **that is how the Radar list was
  silently deleted on 2026-08-01** — inserted while the dashboard was open, then
  erased by a later save built from a pre-Radar snapshot, leaving 15 rows with
  contiguous ids and no error anywhere. `wlMutate` was never the risk (its read
  and write are milliseconds apart); the **editor** is, because its draft is
  loaded when the modal opens and saved whenever the owner presses Save. On a
  conflict the editor reloads the draft IN PLACE and says so — it must not close
  (that discards the owner's edits) and must not re-send (that loses the same
  race again).
  **Create and delete a whole list from the panel** (owner request 2026-08-01) —
  a labelled `+ list` in the panel header mints an empty list; an `×` in each
  band's gutter, beside its ↑/↓, deletes that one. Both were previously
  reachable ONLY inside the ✎ editor, so the two commonest roster edits meant
  opening a modal, editing a draft and saving it. Three things are deliberate:
  the new-list control is **labelled rather than a bare `+`**, because the `+`
  next to it already means "new SYMBOL tile" and two identical glyphs doing
  different jobs is how a control gets pressed by mistake; **delete is gated on `wlLocked`** while
  create is NOT (owner ruling 2026-08-01, revising the first cut). The lock had
  been read as position-only — its tooltip promised "adding and removing stay
  available" — and delete was left ungated behind its confirm dialog; the
  owner's ruling draws the line at destruction instead, which is the more
  defensible reading, since losing a whole list is not the same kind of act as
  removing one tile. It is **disabled, never hidden** (like the ↑/↓ beside it),
  and refused inside `openWlDelList` as well as on the button — a disabled
  control is a hint, while the keyboard path and a stale render both reach the
  function directly, the same reason `wlCommitMove`/`wlMoveBand` enforce it
  themselves. The confirm dialog still names the
  list AND its symbol count, counted from the **saved** symbols so a list of
  unresolved tickers is never described as empty at the moment it is destroyed;
  and a **duplicate list name is refused** (case-insensitive), which is
  correctness rather than tidiness — `wlPick()` resolves a list by title
  whenever its index has shifted and gives up unless exactly one matches, so two
  lists sharing a name would make every add, remove and drop into either of them
  silently unaddressable. Both route through `wlMutate()` like every other
  write, and the delete resolves its target through `wlPick` so a roster that
  shifted under an open dialog deletes the list the owner POINTED AT or nothing.
  **Split the excess into a real list** (owner request 2026-10-05). A band that
  wraps (owner request 2026-10-04: the excess drops onto rows below) shows
  "Split off N" in its head; `wlSplitBand` moves those N tiles into a NEW saved
  list placed directly after the source, in ONE `wlMutate` replace-all — so a list
  can be pruned, kept apart or dragged like any other. Decisions that are
  deliberate, not accidental:
  - **An action, never automatic.** The cut is read off the layout THIS tab is
    showing at the click (`wlRowCapacity`: tiles sharing the first tile's
    `offsetTop`), because how many fit a row depends on the screen (26 at 1822px, 4
    on a phone). A split that ran at render time would let a phone cut the owner's
    roster into slivers on every poll. For the same reason the button is offered
    only where a row holds `WL_SPLIT_MIN_ROW` (12) tiles or more, and
    `wlSplitBand` refuses below that even when called directly.
  - **What moves** is the tiles drawn below the first row, by symbol and in drawn
    order (under a sort key that is not the saved order — the owner moves what they
    SEE below the row). Saved symbols that drew nothing (a typo, no quote) stay in
    the source list. The source is resolved through `wlPick`, so a roster that
    shifted under the click moves nothing ("That list changed — try again").
  - **The name** is `"<name> 2"`, the first number ≥ 2 not taken, compared
    case-insensitively (`wlPick` needs unique titles) and cut so it stays inside
    the server's 60 characters (`left(t, 60)` in `desk_014`). A trailing number on
    a list whose base exists is replaced: "Radar 2" splits into "Radar 3", never
    "Radar 2 2"; "Top 10" with no "Top" list becomes "Top 10 2".
  - **The lock covers it** (it is an arrangement change): the button is disabled,
    never hidden, and `wlSplitBand` refuses under `wlLocked` itself. Creating the
    list is not what is gated, moving the tiles is.
  - **At most 50 lists** (`WL_MAX_LISTS`, `desk_014`): a full roster is refused with
    a note, nothing is written.
  - **A split holds the SHARED write guard** (`wlBusy`, Codex PR #307) for its whole run, not only
    `wlSplitting`: the quick-add / remove / create / delete dialogs all read-modify-write the roster
    behind `wlBusy`, and one that started while the split's read was in flight would read the same
    version — `desk_014` would refuse whichever write finished second and a valid action would
    fail. A drag-drop (`wlCommitMove`) and a band move (`wlMoveBand`) are refused for the same
    reason ("A split is being saved"). **And the other ordering** (Codex, second round on PR #307): a
    write that began BEFORE the split — an arrow reorder, a drag-drop — never set `wlBusy`, so a guard that
    only covered writes begun after the split let it start beside them. `wlMutate` therefore counts every
    roster write in flight (`wlInFlight`, in a `try/finally` around the whole read-modify-write — it is the
    one place a roster write happens) and every entry point that STARTS one refuses while it is above zero:
    the split, the four dialogs' openers and their submits (`wlWriting()`; the note/error reads "Another
    roster change is being saved — try again in a moment"). `wlBusy` stays the dialogs' own "my write is in
    flight" flag. **The ✎ editor's save is the only other roster writer** (`saveWlEditor` calls
    `deskSetWatchlists` directly, not through `wlMutate`), so it takes the same turn (Codex, third round):
    refused while any other write is in flight ("Another roster change is being saved" in the editor), and
    counted in `wlInFlight` itself so a split, a drop or a dialog started meanwhile is refused. (Its long-lived
    DRAFT going stale is the designed case the version guard answers with the in-place reload.) **A drop
    (`wlCommitMove`) and a band move (`wlMoveBand`) take the same turn** (Codex, fourth round: the editor can be
    dismissed with Escape or the backdrop while its save is still pending, which leaves the panel interactive
    with a write in flight that `wlSplitting` knows nothing about): both call `wlMoveRefused()` — a split keeps
    its own wording, anything else in flight says "Another roster change is being saved" — so a second move
    pressed while the first is still saving is refused with that note rather than racing it (the drop's ghost
    is already cleaned up; nothing is written). S61 asserts both orderings, the editor and the two move entry
    points against it (fourteen mutants).
  - `wlSplitting` stops a second press while a write is in flight; the repaint
    inside `wlMutate` draws the new buttons while it is still set, so
    `wlSplitBand` re-syncs once more in its `finally` (otherwise the NEW list's own
    button came up disabled — found by driving the real control, S61).
  The ✎ editor still creates and renames lists the long way round; none of this
  changes it. Covered by S61 (a stateful fake roster; the live roster is never
  touched).
  Editing is the ✎ in the panel header (live + authed only)
  → a modal in the system-prompt idiom; symbols are free text because the
  owner's source is a pasted broker table, normalised client-side for the count
  and again server-side where the RPC is the real authority.
