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
  Editing is the ✎ in the panel header (live + authed only)
  → a modal in the system-prompt idiom; symbols are free text because the
  owner's source is a pasted broker table, normalised client-side for the count
  and again server-side where the RPC is the real authority.
