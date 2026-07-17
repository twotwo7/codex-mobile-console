# State storage and recovery

The console keeps session metadata in `data/state.json` and message bodies in
`data/messages.sqlite3`. The SQLite database uses WAL mode and every completed
save writes the same `storageGeneration` to both files.

## Backups

Create and verify a backup:

```bash
npm run backup
node scripts/restore-state.mjs data/backups/<timestamp>
```

Backups are stored under `data/backups/`, include a SHA-256 manifest, and retain
the newest 30 snapshots by default. Set `BACKUP_KEEP` or `BACKUP_DIR` to change
that policy.

`scripts/install-systemd.sh` installs a persistent daily backup timer named
`codex-mobile-console-backup.timer`.

## Restore

Always verify first. To apply a verified backup:

```bash
systemctl stop codex-mobile-console
ALLOW_STATE_RESTORE=1 node scripts/restore-state.mjs data/backups/<timestamp> --apply
systemctl start codex-mobile-console
curl -fsS http://127.0.0.1:7072/api/healthz
```

The restore command refuses to overwrite live state unless the service is
stopped. Keep the source backup until the restored service and several sessions
have been checked.
