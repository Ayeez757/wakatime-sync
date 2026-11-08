# Hub bridge

Headless Node process that turns a Token Monitor Hub into a WakaTime uploader, and answers the desktop plugin's presence handshake.

It reads the Hub's authenticated `GET /api/stats`, diffs each device's session token counters with the shared core, and posts `ai coding` heartbeats with the device's hostname (`X-Machine-Name`) and timezone.
The Hub stays the single uploader for every device on it; a desktop plugin that can reach this bridge stands by automatically.

## Requirements

- Node 22.15+ (the same runtime the Token Monitor hub uses).
- A Token Monitor Hub with its shared secret.
- A WakaTime write-only API key.

## Configure

Copy `config.example.json` to `~/.config/wakatime-bridge/config.json` (mode 0600) and edit:

| Field | Meaning |
| --- | --- |
| `hubUrl` | Hub base URL, e.g. `http://127.0.0.1:17321`. |
| `hubSecretFile` | File containing the Hub shared secret (for example Token Monitor's `.hubsecret`). |
| `wakatimeApiKey` | Write-only WakaTime plugin key (or set `WAKATIME_API_KEY`). |
| `pollSeconds` | Upload interval, default 60. |
| `timezone` | IANA zone for the `Timezone` header. Defaults to the process zone; set it explicitly on a UTC server. |
| `devices` | `[]` = every Hub device; otherwise a list of device ids. |
| `projectPrefix` / `projectOverrides` | Project naming tweaks. |
| `presenceEnabled`, `presenceHost`, `presencePort` | Presence endpoint; defaults `true`, `0.0.0.0`, `17322`. |
| `stateFile` | Baseline file. Defaults to `state.json` beside the config. |

Environment overrides: `TOKEN_MONITOR_HUB_URL`, `TOKEN_MONITOR_SECRET`, `WAKATIME_API_KEY`, `TOKEN_MONITOR_WAKATIME_POLL_SECONDS`, `TOKEN_MONITOR_WAKATIME_DRY_RUN=1`, `TOKEN_MONITOR_WAKATIME_CONFIG`.

## Run

```sh
node bridge.js --once --dry-run --verbose   # establish baselines, print payloads
node bridge.js --once                       # one real upload round
node bridge.js                              # stay resident
```

systemd user unit:

```ini
[Unit]
Description=Token Monitor -> WakaTime bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/ayeez/wakatime-sync/hub-bridge
ExecStart=/usr/bin/node /home/ayeez/wakatime-sync/hub-bridge/bridge.js --config /home/ayeez/.config/wakatime-bridge/config.json
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

## Presence API

Authenticated with the Hub shared secret (`Authorization: Bearer <secret>`):

- `POST /presence/plugin` with `{hostname, version}` → `{ok:true, uploader:"hub", takeOver:true}`. The desktop plugin
  calls this every poll; a successful answer makes it stand by.
- `GET /presence` → role, bridge version, known plugins (with `ageMs`), and runtime counters
  (`lastTickAt`, `lastPostAt`, today's heartbeats/tokens, `partial`, `error`).

```sh
curl -H "Authorization: Bearer $(cat ~/token-monitor/.hubsecret)" \
  -H 'Content-Type: application/json' \
  -d '{"hostname":"MYPC","version":"0.4.0"}' \
  http://127.0.0.1:17322/presence/plugin
```

Entries expire after one hour and the map is capped, so stale desktop installs disappear.

## Notes

- One bridge per WakaTime account is enough; it covers every device the Hub aggregates.
- Never run the bridge and a desktop uploader against the same sessions at the same time. The presence handshake
  prevents this when the plugin can reach the bridge; if the presence port is blocked, both upload and you get
  duplicates — check `GET /presence` from the desktop machine first.
- The bridge sends no prompts, transcripts, file paths or account identities; only token counters, session ids,
  project names, device hostnames and timezones.
