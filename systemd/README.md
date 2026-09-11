# Scheduling

Two timers, deliberately shipped as a pair.

| Unit | Cadence | What it does |
|---|---|---|
| `bioc-sync` | hourly | `RSYNC_SRC=... ./sync.sh` — pull the delta, push what moved, purge those URLs |
| `bioc-reconcile` | weekly | `RECONCILE=1 ./sync.sh` — `rclone check --checksum`, report drift |
| `bioc-logpush-check` | daily 07:15 | `./check-logpush.sh` — fail if yesterday's UTC Logpush prefix in GCS is empty (ADR 0003: gaps are unrecoverable) |

The two mirror jobs share a lock (`flock` on `$XDG_RUNTIME_DIR/bioc-mirror.lock`): the hourly sync skips its run with exit 0 if the reconcile holds it, and the reconcile waits up to 2 h for a running sync before starting. They used to declare `Conflicts=` on each other, which made systemd *kill* whichever was running when the other started; the multi-hour reconcile never survived the next hourly sync (#5, #6).

Both carry `OnFailure=bioc-notify@%N.service`, so a failed run files (or comments on)
a GitHub issue titled `<unit> is failing` via `../notify-failure.sh` — full journal for
that run plus whatever `sync.sh` log files it left on disk, capped only against
GitHub's body-size limit. One operator has access to this box, so the body isn't
trimmed for brevity. `gh` auth already lives in `~/.config/gh` on this host; nothing
else to provision.

They are a pair because the delta sync is what *creates* the need for reconciliation.
`RSYNC_SRC` mode trusts rsync's delta and never reads the bucket back, so a failed upload
diverges silently and permanently. Scheduling the sync without the check would be
shipping the failure mode without the detector; scheduling the check without the sync
would reconcile a mirror nothing is updating.

## Not installed

These are committed but **not enabled**, on purpose. Three things have to be true first,
and none of them is true yet:

1. **The initial load has to be validated.** Until the bucket matches the docroot once,
   an hourly delta sync is computing differences against an unknown baseline.
2. **This host has to be the permanent one.** The units hardcode paths under
   `/data/davsean/`; the mirror is 453 GB and lives on bulk storage that happens to be
   here. If the sync moves to a server, these move with it.
3. **Unattended SSH has to work.** `the upstream docroot host` is reached over SSH, and a systemd user
   unit has no terminal and no inherited agent. Either the key is passphrase-free and
   readable by the unit, or `SSH_AUTH_SOCK` has to be plumbed in. A timer that silently
   fails every hour on an agent prompt is worse than no timer, because it looks
   scheduled.

## Install, once those hold

```sh
mkdir -p ~/.config/systemd/user
cp systemd/bioc-*.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bioc-sync.timer bioc-reconcile.timer
loginctl enable-linger "$USER"     # timers must survive logout
```

`enable-linger` is not optional: without it user timers stop when the last session ends,
so the sync would run only while someone is logged in.

## Verify

```sh
systemctl --user list-timers 'bioc-*'
journalctl --user -u bioc-sync.service -n 50
systemctl --user start bioc-reconcile.service   # run one now, out of band
```

## Cost note

`bioc-reconcile` reads and hashes the entire local mirror — 453 GB — to compare against
R2 ETags. That is why it is weekly and offset to Sunday 04:00. Running it hourly would
saturate the disk for no benefit; the hourly path deliberately never touches the bucket.
