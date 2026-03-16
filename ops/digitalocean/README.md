# DigitalOcean Gutenberg Mirror Box

This directory bootstraps the optional Project Gutenberg rsync mirror box that the ingest service can read from via `GUTENBERG_MIRROR_ROOT`.

Target layout on the VM:

- `/srv/alphabook/gutenberg`
- `/srv/alphabook/gutenberg/cache/epub`
- `/srv/alphabook/bin/gutenberg-rsync.sh`
- `/srv/alphabook/bin/gutenberg-rsync-epub.sh`
- `/srv/alphabook/bin/gutenberg-upload.sh`
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
- creates `/srv/alphabook`
- installs the rsync runner into `/srv/alphabook/bin`
- installs the EPUB/RDF rsync runner into `/srv/alphabook/bin`
- installs the upload runner into `/srv/alphabook/bin`
- installs the systemd services and timers
- enables the daily timers

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

To upload automatically after each mirror refresh, set:

```bash
ALPHABOOK_UPLOAD_AFTER_SYNC=1
```

in the systemd service environment or shell before running `gutenberg-rsync.sh`.

## Notes

The sync scripts mirror:

- the `gutenberg` rsync module into `/srv/alphabook/gutenberg`
- the `gutenberg-epub` rsync module into `/srv/alphabook/gutenberg/cache/epub`

That follows Project Gutenberg’s published mirroring pattern for combining the main corpus with generated EPUB/cache content.

The EPUB/RDF mirror can run independently from the main corpus mirror so generated metadata does not wait behind the initial full-text sync.

The ingest parser now preserves richer browse metadata from the mirror when present, including:

- subtitle / friendly title
- description / summary
- bookshelves
- publisher
- translators, illustrators, and editors
- cover image path (local mirror path)
