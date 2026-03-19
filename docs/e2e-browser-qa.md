# Browser QA Checklist

This checklist is for live browser verification of the assistant UI and research-document flow.

## Preconditions

- Use the gstack `/browse` workflow in serial, not in parallel.
- Ensure `bun` is available in `PATH` for the browse binary.
- For authenticated checks, import cookies for `alpha-book.org` into the headless browser session first.
- Prefer testing against [https://alpha-book.org/?view=assistant](https://alpha-book.org/?view=assistant).

## 1. Public Assistant Shell

- Open [https://alpha-book.org/?view=assistant](https://alpha-book.org/?view=assistant).
- Verify the shell loads.
- Verify there are no blocking console errors.
- Verify the message composer is visible.
- Verify the main shell requests succeed:
  - app JS/CSS assets
  - `GET /api/me`
  - `GET /api/works`

Expected result:
- Public assistant shell renders without crashing.

## 2. Signed-Out Gate

- While signed out, submit a message from the assistant view.
- Verify the app does not crash.
- Verify the user sees the sign-in gate.

Expected result:
- Sending while signed out produces a clear sign-in requirement.

## 3. Authenticated Assistant Run

- Import cookies for `alpha-book.org`.
- Re-open [https://alpha-book.org/?view=assistant](https://alpha-book.org/?view=assistant).
- Verify `GET /api/me` returns an authenticated user.
- Start a real run with a broad query.
- Watch the run in the browser until:
  - metadata search appears
  - passage search appears
  - corpus briefing appears
  - the left document updates during the run

Expected result:
- The run starts without a page reload.
- The right-side tool stream stays stable during and after completion.
- The left document updates while the run is active.

## 4. Completed Run Handoff

- Wait for the run to complete.
- Verify the right-side tool cards do not switch to raw JSON-style fallback output.
- Verify VM-touched books and passages remain visible in the left document after completion.
- Refresh the page on the completed run.

Expected result:
- Completed state matches the in-run state closely.
- Refresh preserves the same research-document content.

## 5. Standalone Research Document

- Open a known run at:
  - `/?view=assistant_document&session=<sessionId>&run=<runId>`
- Test both states:
  - signed out
  - signed in with access

Expected result:
- Signed out:
  - explicit sign-in message
  - sign-in link
- Signed in without access:
  - explicit access-denied message
  - no fake loading state
- Signed in with access:
  - research document renders
  - sections and ending summary appear

## 6. Responsive Pass

- Capture mobile, tablet, and desktop screenshots of the public assistant shell.
- Repeat for an active or completed run when authenticated.

Expected result:
- No obvious layout breakage in sidebar, composer, or research-document panel.

## 7. Failure Conditions To Flag

Treat any of these as regressions:

- `Loading research document…` persists after a `401` or `403`
- right-side tool cards switch to raw structured payload output after completion
- left document loses VM-touched books/passages at completion
- clicking a recent chat visually reloads the whole app shell
- public or authenticated assistant view throws uncaught frontend errors
- standalone document route renders blank or crashes
