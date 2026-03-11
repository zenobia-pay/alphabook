# Terminal Use contract

The repo's Terminal Use adapter expects a remote agent that can work against this filesystem shape:

## Input workspace

- `input/book.txt`
- `input/manifest.json`
- `input/hints.json`
- `input/query.txt`
- `input/instructions.md`

## Expected output

- `output/report.md`
- optionally `output/report.json`

## Remote-agent behavior

The agent should:

1. Read the book and the query.
2. Use terminal tooling such as `rg`, `sed`, and local scripting to inspect the whole book.
3. Produce a short markdown report with:
   - summary
   - evidence passages
   - limitations

The local code does not require this remote agent to exist, but if it does, the slow loop can hand off whole-book research to it.
