# Changelog

## 0.4.0

Repository and correctness release.

- **Fail closed on unmatched hostnames**: on a multi-device Hub the plugin now pauses with a clear error instead of uploading every device (which duplicated other machines). A one-device Hub/local mode still uploads.
- **Stable baselines**: state v2 keys baselines by client + device + immutable session start time, so restarts no longer drop an interval of tokens because an opaque row id changed. v1 state migrates automatically (baselines rebuild once).
- **Shared core**: the plugin backend and the Hub bridge now import one `shared/wakatime-core.cjs`; the User-Agent version comes from the manifest/bridge version instead of a hard-coded string.
- **Heartbeat timestamps**: heartbeats in one batch get distinct sub-second times so WakaTime cannot collapse same-entity/same-second records.
- **Truncated pagination** is reported as `(partial)` instead of silently presenting partial data as complete.
- Interval changes apply without reloading; `state.json` is only written when it changes; WakaTime stats reads are cached for 30 s.
- Hub bridge: presence entries expire after an hour and are capped, auth uses a timing-safe comparison, `GET /presence` reports runtime counters/partial data, and the `_model` dead field was removed.
- Repository: layout, tests, CI, secret scan, build/catalog scripts, MIT license, publish-ready README.

## 0.3.0

- Hub coordination: every poll the plugin asks the Hub bridge's presence endpoint and stands by while the bridge owns uploads, so a Hub + desktop setup never double counts. Falls back to local uploads when the bridge is unreachable.
- New settings: **Let the Hub bridge upload** (default on) and optional **Hub bridge URL** (auto-derived from the configured Hub host, port 17322).
- Card surfaces the new **Hub uploading** state and a hint when the bridge cannot be reached.

## 0.2.1

- Compact card layout: smaller type scale (11px base, 10px labels), tighter paddings and grid gaps so the Home card fits without wrapping.

## 0.2.0

- Add scenario settings: upload scope (auto / this-device / aggregate), category, cache-token handling, project-name source.
- Resolve the local device through the Hub device list so a shared Hub never gets other devices uploaded twice.
- Map opaque project ids to real project labels; fall back to the workspace folder or no project.
- Card now shows WakaTime AI tokens, AI models with cost, plus upload scope and tracked-session counts.
- Fix the WakaTime stats read: use `statusbar/today` (the cached endpoint the official CLI uses) instead of the invalid `stats/today` range that returned HTTP 400.
- Attribute heartbeats to the right machine (`X-Machine-Name`) and timezone (`Timezone`). No AI-model token in the User-Agent: WakaTime reads a custom model token as a bogus model with invented cost.

## 0.1.1

- Add machine-name, timezone and AI-model User-Agent attribution.
- Show baselines and last check time so a first-run zero is self-explanatory.

## 0.1.0

- First release: diff Token Monitor token counters into WakaTime AI Coding heartbeats, with a status card.
