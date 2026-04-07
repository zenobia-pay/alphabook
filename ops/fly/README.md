# Fly Ops Boxes

This directory documents the Fly cold-standby clones of the live DigitalOcean ops boxes.

The repo helper is:

```bash
npm run ops:fly:duplicate-boxes
```

By default it provisions two stateful Fly apps in `iad` under the `master-maker` org:

- `alphabook-hermes-box`
- `alphabook-qdrant-box`

The helper:

- creates the Fly apps when they do not exist yet
- allocates persistent volumes sized for the current live footprints
- creates one Fly Machine per box using `ubuntu:24.04`
- mounts the persistent volume at `/data`
- streams the selected live source paths from the DigitalOcean boxes through the public mirror host
- recreates the main absolute paths as symlinks into `/data`

Permission requirement:

- the caller still needs Fly app-create and machine-create permission in the target org
- if the repo already has `FLY_API_TOKEN` in `.dev.vars`, the helper promotes it to `FLY_ACCESS_TOKEN` automatically before invoking `flyctl`

Current source assumptions:

- public jump host: `root@134.209.116.167`
- Hermes/Codex source box: `root@10.116.0.2`
- Qdrant source box: `root@10.116.0.4`
- source key on the jump host: `/root/.ssh/hermes_consolidate`

The clone is a filesystem duplicate first. It intentionally does not try to reproduce the exact DigitalOcean init stack, nested Docker setup, or systemd state inside Fly. The important live data, repo tree, mounted corpus artifacts, and box-local helper scripts are copied onto persistent Fly volumes so the new boxes can be inspected, resumed, or promoted from a known-good state without relying on DigitalOcean.

Useful flags:

- `--role hermes`
- `--role qdrant`
- `--skip-sync`
- `--dry-run`
- `--hermes-volume-size-gb 350`
- `--qdrant-volume-size-gb 550`

Example dry run:

```bash
npm run ops:fly:duplicate-boxes -- --dry-run
```
