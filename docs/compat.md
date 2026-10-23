# Upstream compatibility (compat.json)

`compat.json` pins the new-api release whose web frontend is vendored (M2) and defines which servers the client accepts.

| Field | Value | Meaning |
|---|---|---|
| `tag` / `commit` | `v1.0.0-rc.46` / `7d8b9126…` | Upstream snapshot. |
| `minServer` | `v1.0.0-rc.46` | Oldest accepted server (**provisional**; verified against `/api/status` in M3). |
| `maxServerTested` | `null` | Newest verified server; `null` means the same as `tag`. |
| `policy` | `same-minor-line` | Accept servers ≥ minServer on the same major.minor line. Newer-than-tested servers are accepted with a warning; other lines are refused. (`exact` is also supported.) |

`bun run compat` validates the file. `node scripts/compat-check.mjs --server v1.0.0-rc.47` evaluates a given server version. Upgrading the pin is a deliberate PR (M2 `scripts/update-upstream.sh`).
