<p align="right"><a href="./README.md">简体中文</a> | <strong>English</strong> | <a href="./README.zh-TW.md">繁體中文</a></p>

# WakaTime sync for Token Monitor

Send Token Monitor's AI token usage to [WakaTime](https://wakatime.com) as **AI Coding** heartbeats, and read your WakaTime day back in a compact card.
Works on a single machine and on a multi-device Token Monitor Hub (a Hub-side bridge is included in this repository).

> Unofficial community integration. Not affiliated with WakaTime or the Token Monitor maintainers.

## What it does

Token Monitor tracks tokens per AI session across 50+ coding tools; WakaTime tracks time per editor file.
Every poll this plugin diffs each session's token counters and posts only the increment as
`POST /api/v1/users/current/heartbeats.bulk`:

| Token Monitor | WakaTime heartbeat |
| --- | --- |
| client (`codex`, `dsh`, `claude`…) | `entity: token-monitor:<client>` |
| category | `ai coding` (configurable) |
| session | `ai_session` |
| input + cache-read/write deltas | `ai_input_tokens` |
| output delta | `ai_output_tokens` |
| project label or workspace folder | `project` |
| device hostname / timezone | `X-Machine-Name` / `Timezone` headers |
| plugin version | User-Agent `token-monitor/<version>` |

WakaTime then shows AI Coding time and AI token counters next to your manual coding stats.
AI *model* attribution stays with WakaTime's own CLI parsers: a custom model token in our User-Agent was read as a bogus model with invented cost, so none is sent.

## Compatibility

- Token Monitor: `>=0.82.0` (plugin API `tmApi: 1`, experimental). Built and exercised against 0.87.x.
- Plugin UI: Windows 11 (Token Monitor desktop). Other desktop platforms use the same host APIs but were not exercised here.
- Hub bridge: Node 22.15+ on Linux/macOS (the same Node the Token Monitor hub uses).

## Install

1. Download the latest `wakatime-sync-<version>.tmplugin` from [Releases](https://github.com/Ayeez757/wakatime-sync/releases).
2. Token Monitor → Settings → Plugins → import the file (or this folder) → review the trusted-code warning → **Trust, install and enable**.
3. Open the plugin settings and paste the write-only API key from <https://wakatime.com/api-key>.
4. Turn on **Send heartbeats to WakaTime**, and approve **background execution** so uploads continue while Token Monitor runs.
5. Optional: paste a personal OAuth token from <https://wakatime.com/oauth> to show WakaTime totals in the card. API keys are write-only, so stats always need an OAuth token.

Start with **Dry run** if you want to see heartbeat payloads without touching your WakaTime account.

## Choose your setup

| Setup | Settings |
| --- | --- |
| One machine, local collection | `scope: auto`, `category: ai coding`, cache tokens on |
| Several machines on a shared Hub, bridge running on the Hub | Keep `preferHub` on: the plugin asks the bridge each poll and stands by; the Hub uploads every device. |
| Several machines, no Hub bridge | Run the plugin on each machine with `scope: auto`; each uploads only its own sessions. |
| Dashboard only | Leave uploads off and set the OAuth token. |
| WakaTime already records AI coding | WakaTime's CLI parses Claude/Codex/Copilot/DeepSeek/Cursor transcripts by default. If it already covers your sessions, leave uploads off (card only) or you double count. |

Never run two uploaders for the same sessions (this plugin, the Hub bridge, WakaTime's own AI sync). Pick one per machine/account.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Send heartbeats to WakaTime | off | Upload master switch. |
| WakaTime API key | — | Write-only key for heartbeats. |
| WakaTime OAuth access token | — | Read-only stats for the card. |
| Which sessions to upload | auto | `auto` resolves this machine through Hub devices; `this-device` pins it; `aggregate` uploads the whole Hub. If the hostname cannot be matched on a multi-device Hub the plugin **fails closed** instead of uploading other machines. |
| WakaTime category | ai coding | `coding` merges with manual coding; other WakaTime categories are available. |
| Count cached input tokens | on | Adds cache read/write tokens to `ai_input_tokens`. |
| Project name source | label | Token Monitor label, workspace folder, or no project. |
| Project name prefix | — | Optional, e.g. `ai-`. |
| Upload interval | 60 s | 30–900 seconds; changes apply without reloading the plugin. |
| Let the Hub bridge upload | on | Stand by while the Hub bridge answers on port 17322. |
| Hub bridge URL | auto | Empty = same host as the Hub, port 17322. |
| Dry run | off | Log payloads without sending. |

## How the counts behave

- First run only records baselines; it never dumps a whole day at once.
- Day rollover and counter regressions rebuild baselines instead of sending negative values.
- Baselines are keyed by client + device + immutable session start time, so an App restart does not lose deltas because an opaque row id changed.
- One heartbeat per session per poll; models are merged for the payload and heartbeats inside a batch get distinct sub-second times.
- Missing or unavailable session data is shown as such, never treated as zero; truncated pagination is labelled `(partial)`.

## Card

Upload state, heartbeats today, uploaded input/output tokens, upload scope, tracked sessions, last upload, last check, session-data availability, then the WakaTime day: total coded time, AI Coding time, AI tokens, AI models with cost, categories, projects and machines.
`Refresh` forces one poll and one stats read (stats reads are cached for 30 seconds).

## Hub bridge (multi-device)

`hub-bridge/` contains a headless Node process that reads the Hub's `/api/stats` and posts the same heartbeats for every device, plus a presence endpoint (`POST /presence/plugin`, `GET /presence`) the desktop plugin uses to coordinate. See [hub-bridge/README.md](hub-bridge/README.md).

## Data and access

- Runs as trusted code with your OS user's file and network authority; it is not sandboxed.
- Sends only token counts, session ids, project names, machine name, timezone and replies to WakaTime and the configured Hub.
- Never sends prompts, transcripts, file paths, account emails or provider credentials.
- The API key, OAuth token and Hub shared secret are read from Token Monitor settings; the plugin stores its baselines (`state.json`, mode 0600) and preferences (plain JSON, not an encrypted vault) in the plugin data directory.
- The bridge stores config and baselines beside its config file (`~/.config/wakatime-bridge/` by default), both mode 0600.

## Updates

Releases are published on [GitHub Releases](https://github.com/Ayeez757/wakatime-sync/releases); replace the package through Settings → Plugins. An optional HTTPS catalog lives at `catalog.json` in this repository — add `https://raw.githubusercontent.com/Ayeez757/wakatime-sync/main/catalog.json` under Plugins → Discover → Custom catalog sources to receive updates in-app. Rollback restores code, not plugin data.

## Development

```sh
npm run check     # syntax, manifest, secret scan
npm test          # unit tests (no network)
npm run build     # build dist/<id>-<version>.tmplugin (needs TM_REPO token-monitor checkout)
npm run catalog   # refresh catalog.json for the built package
```

Live WakaTime checks are opt-in: `WAKATIME_OAUTH_TOKEN=... npm test` runs the statusbar parse test.

## License and credits

MIT. Plugin API and packager come from [Token Monitor](https://github.com/Javis603/token-monitor); WakaTime is a separate service. Icon is original artwork in this repository.
