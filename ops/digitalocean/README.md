# DigitalOcean Gutenberg Mirror Box

This directory bootstraps the optional Project Gutenberg rsync mirror box that the ingest service can read from via `GUTENBERG_MIRROR_ROOT`.

Target layout on the VM:

- `/srv/alphabook/gutenberg`
- `/srv/alphabook/gutenberg/cache/epub`
- `/srv/alphabook/bin/gutenberg-rsync.sh`
- `/srv/alphabook/bin/gutenberg-rsync-epub.sh`
- `/srv/alphabook/bin/gutenberg-upload.sh`
- `/srv/alphabook/bin/backfill-book-html-all.sh`
- `/srv/alphabook/bin/rebuild-book-html-all.sh`
- `/etc/systemd/system/alphabook-gutenberg-rsync.service`
- `/etc/systemd/system/alphabook-gutenberg-rsync.timer`
- `/etc/systemd/system/alphabook-gutenberg-rsync-epub.service`
- `/etc/systemd/system/alphabook-gutenberg-rsync-epub.timer`

## Bootstrap

From a fresh Ubuntu/Debian-style DigitalOcean droplet:

```bash
sudo ./ops/digitalocean/bootstrap-rsync-box.sh
```

That script:

- installs `rsync`, `curl`, `ca-certificates`, and `jq`
- installs `nodejs` and `npm` so ingest can run directly on the box
- creates `/srv/alphabook`
- installs the rsync runner into `/srv/alphabook/bin`
- installs the EPUB/RDF rsync runner into `/srv/alphabook/bin`
- installs the upload runner into `/srv/alphabook/bin`
- installs the full book HTML backfill runner into `/srv/alphabook/bin`
- installs the full book HTML rebuild runner into `/srv/alphabook/bin`
- installs the systemd services and timers
- enables the recurring timers

## Manual Sync

```bash
sudo systemctl start alphabook-gutenberg-rsync.service
sudo systemctl start alphabook-gutenberg-rsync-epub.service
sudo journalctl -u alphabook-gutenberg-rsync.service -n 200 --no-pager
sudo journalctl -u alphabook-gutenberg-rsync-epub.service -n 200 --no-pager
```

## Ingest Integration

Set:

```bash
GUTENBERG_MIRROR_ROOT=/srv/alphabook/gutenberg
```

Then:

```bash
npm run dev:ingest -- ingest-gutenberg 12345
```

or with `tsx` directly:

```bash
npx tsx apps/ingest/src/index.ts ingest-gutenberg 12345
```

On the rsync box itself, the upload helper expects an env file at `/srv/alphabook/.ingest.env` with:

```bash
DATABASE_URL=...
R2_BUCKET_NAME=...
R2_ENDPOINT=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
OPENAI_API_KEY=... # optional
```

Then you can run:

```bash
sudo /srv/alphabook/bin/gutenberg-upload.sh
```

To backfill missing static book HTML for existing works without re-running full ingest:

```bash
sudo /srv/alphabook/bin/backfill-book-html-all.sh
```

To regenerate every stored static book HTML artifact after a template or anchor update:

```bash
sudo /srv/alphabook/bin/rebuild-book-html-all.sh
```

To upload automatically after each mirror refresh, set:

```bash
BOOK_HTML_BATCH_SIZE=100
```

The shipped systemd service already enables `ALPHABOOK_UPLOAD_AFTER_SYNC=1`, so the main recurring rsync run will:

- ingest new Gutenberg mirror files in parallel
- backfill a batch of missing `book_html` artifacts
- ensure the full paginated static-book rebuild loop is running in the background

## Notes

The sync scripts mirror only the data the ingest path actually needs:

- from the `gutenberg` rsync module: text/HTML source files plus index/readme files
- from the `gutenberg-epub` rsync module: RDF metadata plus cover images

That keeps the mirror aligned with the current ingest code without pulling unnecessary EPUB, MOBI, ZIP, DOC, and PDF derivatives.

The EPUB/RDF mirror can run independently from the main corpus mirror so generated metadata does not wait behind the initial full-text sync.

The ingest parser now preserves richer browse metadata from the mirror when present, including:

- subtitle / friendly title
- description / summary
- bookshelves
- publisher
- translators, illustrators, and editors
- cover image path (local mirror path)
