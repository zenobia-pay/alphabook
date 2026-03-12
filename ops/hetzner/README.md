# Hetzner Gutenberg Mirror Box

This directory bootstraps the optional Project Gutenberg rsync mirror box that the ingest service can read from via `GUTENBERG_MIRROR_ROOT`.

Target layout on the VM:

- `/srv/alphabook/gutenberg`
- `/srv/alphabook/gutenberg/cache/epub`
- `/srv/alphabook/bin/gutenberg-rsync.sh`
- `/etc/systemd/system/alphabook-gutenberg-rsync.service`
- `/etc/systemd/system/alphabook-gutenberg-rsync.timer`

## Bootstrap

From a fresh Ubuntu/Debian-style Hetzner VM:

```bash
sudo ./ops/hetzner/bootstrap-rsync-box.sh
```

That script:

- installs `rsync`, `curl`, `ca-certificates`, and `jq`
- creates `/srv/alphabook`
- installs the rsync runner into `/srv/alphabook/bin`
- installs the systemd service and timer
- enables the daily timer

## Manual Sync

```bash
sudo systemctl start alphabook-gutenberg-rsync.service
sudo journalctl -u alphabook-gutenberg-rsync.service -n 200 --no-pager
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

## Notes

The sync script mirrors:

- the `gutenberg` rsync module into `/srv/alphabook/gutenberg`
- the `gutenberg-epub` rsync module into `/srv/alphabook/gutenberg/cache/epub`

That follows Project Gutenberg’s published mirroring pattern for combining the main corpus with generated EPUB/cache content.
