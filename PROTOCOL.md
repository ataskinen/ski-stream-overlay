# Timing input contracts

The local service binds to `127.0.0.1:8787`. OBS loads its transparent pages through a native `Ski Race Overlay` source. This service does not read a VOLA SQLite database: a CSV roster maps bibs to names, categories and clubs.

## JSON events

TCP `jsonl` mode expects one UTF-8 JSON event per newline. HTTP mode fetches an event, an array of events, or `{ "events": [...] }`. `timeMs` is elapsed race time in milliseconds, not an epoch or time-of-day timestamp.

```json
{"type":"start","bib":"001","timeMs":0}
{"type":"time","bib":"001","timeMs":12340}
{"type":"finish","bib":"001","timeMs":42560}
{"type":"dnf","bib":"002"}
{"type":"dsq","bib":"003"}
{"type":"clear"}
```

`start` defaults `timeMs` to zero. `dnf` and `dsq` do not require a time and normalize it to null. Other timed events require a finite value from 0 to 86,400,000. Bibs are strings; leading zeros matter. `clear` clears the active presentation while keeping standings. `finish` replaces the prior result for that bib. Multiple bibs can be active at once: a terminal event removes only its own bib from the active racers. Terminal events are presented in order before returning to the oldest remaining active racer. DNF and DSQ are not ranked times.

HTTP polling skips an unchanged response body to avoid repeatedly restarting the same event. Producers should return their current event batch without changing insignificant whitespace, or use TCP for an event stream. HTTP responses are limited to 2 MB, requests time out after five seconds, redirects are rejected, and URLs cannot contain embedded credentials. Polling interval is configurable from 250 to 60,000 ms. Failed connections retry with increasing delay up to 15 seconds.

## Experimental VOLA TCP adapter

Source evidence: [Kiril's `index.js`](https://github.com/jovchev/vola-skialppro-text-overlay/blob/master/index.js). The original uses TCP port 5409 and a `.scdb` SQLite roster. Its packet parser has no captured packet fixtures. This implementation reconstructs newline-delimited TCP messages and follows these inferred fields:

| Field       | Meaning inferred from the original                          |
| ----------- | ----------------------------------------------------------- |
| `fields[0]` | `NR`                                                        |
| `fields[1]` | Status code interpreted through `volaStatusMap`             |
| `fields[3]` | Bib                                                         |
| `fields[6]` | Packed timestamp: seconds followed by six fractional digits |

The default status map is `{"0":"start","1":"finish"}`. Unknown codes are ignored. The previous inferred adapter treated every nonzero numeric code as a finish; this is no longer done because it could turn a DNF or DSQ into a ranked time. `volaStatusMap` is an object whose numeric-string keys (`0`–`999`, at most 32 entries) map to `start`, `finish`, `dnf` or `dsq`; it must include at least one start and finish mapping. Configure additional codes only after confirming them with the timing operator. Kiril's public code contains no documented DNF/DSQ status mapping.

The adapter subtracts the matching start timestamp from the finish timestamp and handles a negative difference as midnight rollover. It accepts packed timestamps of 7–12 decimal digits. A finish without a start in the current connection is ignored. `S` on-course lists and `IR` packets are ignored. Running time between events is a local display estimate. Event silence does not mark the feed stale: some producers send only start and finish. TCP keepalive is enabled with a ten-second initial delay; actual broken-link detection depends on the OS and network.

Confirm message framing, nonzero status meanings, intermediate timing messages and timestamps with the actual VOLA version before using this feed for a race. Synthetic parser tests verify this interpretation only; they are not a hardware compatibility test.

## Competitor roster

CSV requires a `bib` header and a nonempty, unique bib in every row. Optional headers are `name`, `category`, `club` and `yearOfBirth`. The optional birth year is a four-digit string and is omitted from metadata when blank. It appears beside the club in the main lower third; compact stacks and top 10 omit it. Omitted optional columns and empty values become empty strings; unknown bibs also have blank metadata. Bibs remain strings, so `001` and `1` are distinct. Comma, semicolon and tab separators and quoted fields are accepted. Malformed CSV and duplicate bibs reject the whole import.

VOLA tab-separated TXT exports may include title lines before `Bib.\tCode\tCategory\tName\tYear\tClub` and a final `N Competitors` count. `Bib.` maps to `bib`, `Year` to `yearOfBirth`; `Code` is ignored. A supplied count must match the rows. Uploaded and downloaded roster files accept UTF-8 (optional BOM) or Windows-1252. Title lines do not change the competition name or discipline.

Existing three-column `bib,name,category` files remain valid. CSV export writes `bib,name,category,club`, including empty optional fields, and appends `yearOfBirth` when any competitor has one. Reimporting updates metadata on existing results. A racer without a category remains visible as the current racer but is excluded from category rankings.

## Local API

All writes use `Content-Type: application/json`. The service checks localhost Host headers and rejects cross-origin requests. It is intended for use on the same computer as OBS.

| Method and route         | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `GET /api/health`        | Identity: `app` is `ski-stream-overlay`                                |
| `GET /api/state`         | Current active mode, connection, roster, racer, results and categories |
| `GET /api/events`        | SSE: default `message` events contain the complete active state        |
| `GET /api/config`        | Saved connection settings                                              |
| `PUT /api/config`        | Update settings; reconnect when timing settings change                 |
| `POST /api/roster`       | Import `{ "csv": "bib,name,category,club…" }` atomically               |
| `POST /api/roster/fetch` | Fetch and cache `{ "url": "https://example.com/roster.csv" }`          |
| `GET /api/roster.csv`    | Download the active saved roster and optional birth years              |
| `POST /api/demo`         | `{ "action": "start" }`, `stop`, `next` or `reset`                     |
| `POST /api/reset`        | Clear live results and reconnect                                       |

Configuration fields: `mode` (`demo`, `tcp`, `http-json`), `protocol` (`jsonl`, `vola`), `host`, `port`, `url`, `pollIntervalMs`, `rosterUrl`, `testFeed` (boolean), `eventName` (string), `discipline` (enum), `finishHoldMs`, `idleRotationMs`, `categoryRotationMs`, and `volaStatusMap`. `eventName` defaults to an empty string; it is trimmed, limited to 120 UTF-16 code units and rejects control characters (including DEL). An empty value hides the competition name. The same saved name appears in current-racer and top 10 overlays, separate from category and DEMO/TESTI markers. Configuration updates may be partial; updating only `eventName` preserves other settings and does not restart the timing feed. TCP host is a hostname or IPv4 address without URL scheme or port. CSV roster URLs are fetched on request, not polled automatically.

`discipline` is saved global metadata with the exact, case-sensitive values `GS`, `SL`, `TAITO`, `SG`, `SUP`, `DH` or `Other`. It defaults to `Other`, which hides the red discipline badge without hiding the category or DEMO/TESTI marker. `PUT /api/config` with only `{ "discipline": "SL" }` preserves other settings and does not reconnect the feed or freeze active racers.

Presentation timing settings use integer milliseconds:

| Field                | Default | Allowed range |
| -------------------- | ------: | ------------: |
| `finishHoldMs`       |    2000 |     500–30000 |
| `idleRotationMs`     |  180000 | 10000–3600000 |
| `categoryRotationMs` |   10000 |    1000–60000 |

The idle timer starts at the latest start event. Category rotation requires an empty course and an empty terminal display queue; only categories with ranked results participate. A new start immediately ends rotation. Presentation timing changes do not reconnect the feed. The service broadcasts timed presentation transitions even when no new timing packet arrives.

Live state persists atomically in `state.json` under `DATA_DIR`. Setting `testFeed: true` routes TCP/HTTP input, roster imports and resets into a separate persisted test race and test roster. Overlays label these results `TESTI`. Set the flag to false and load the real roster before receiving real race data. Demo state is separate and ephemeral. The service restores results, roster and configuration, but not the current running racer. Rankings use the last finish per bib and calculate ranks independently per nonempty category. Tied times share a rank with competition ranking (1, 1, 3). Category rows include elapsed time and a nonnegative gap behind the current category leader. Uncategorized racers receive no rank or comparison.

### Race-state fields

`GET /api/state` and SSE snapshots include `eventName` and `discipline` at the top level. Roster entries contain string fields `bib`, `name`, `category` and `club`; missing optional metadata is `""`.

Result entries contain `bib`, metadata, `status` (`finish`, `dnf` or `dsq`), `timeMs`, `rank` and `gapToLeaderMs`. DNF/DSQ entries have null time, rank and gap and are excluded from top 10 standings. Legacy saved results without a status are treated as finishes. A categorized result's gap is its elapsed time minus the current fastest time in that category. Tied times have the same rank, using 1, 1, 3 ranking. An uncategorized result has `rank: null` and `gapToLeaderMs: null` and is omitted from category standings.

`activeRacers` contains every racer still on course in start order. `terminalQueue` contains pending finish/DNF/DSQ displays. `presentation` contains `mode` (`racers`, `top10` or `cycle`), `current`, `otherRacers` and `category`; automatic overlays use this server-selected state. A terminal queue head takes precedence over active racers. `otherRacers` holds the remaining compact stack, and each active racer has its own `updatedAt` and elapsed-time estimate. `lastStartAt` anchors the idle timer. `presentationSettings` exposes the three timing settings.

The `current` racer also contains `finished`, `rank`, `gapToLeaderMs`, `leadDeltaMs` and `isLeader`. `finished` is authoritative: while running or after a disconnect before a finish, rank and comparison fields are null and `isLeader` is false. On a finish, rank and gap are calculated only within the racer's category. `leadDeltaMs` compares this finish with the fastest other result in that category immediately before the finish: positive means slower, negative means a new lead and zero means a tie. It is null when there was no prior comparison. `isLeader` is true for rank 1, including tied leaders. A first finisher displays `JOHDOSSA` (IN THE LEAD); a negative comparison is green and a positive comparison is red. A correction excludes that bib's previous result from the comparison.

Overlay routes are `/overlay/auto`, `/overlay/current` and `/overlay/top10?category=...`. They use a transparent 1920 × 1080 canvas. Automatic coverage selects the racer stack, latest terminal category standings, or idle category rotation without navigating between pages. Manual top 10 accepts an exact category or `category=auto` to follow the current racer. The native plugin handles these URLs; developers can open them directly for inspection.

## Standalone test competition

`node simulator/server.mjs` starts the synthetic competition. `docker compose -f simulator/compose.yaml up --build -d` packages the same service with `node:20-alpine`. Compose publishes only `127.0.0.1:5409` and `127.0.0.1:8790` on the host. The container listens on all container interfaces; native execution defaults to localhost.

Environment settings are `HOST`, `TCP_PORT` (5409), `HTTP_PORT` (8790), and `FORMAT` (`vola` by default, `jsonl` optionally). It is a synthetic producer for this adapter, not a validated VOLA emulator. `vola` emits inferred `NR` start/finish messages; `jsonl` emits the documented JSON event format.

| Simulator route        | Purpose                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /`                | Test-competition control panel                                                                  |
| `GET /competitors.csv` | Test roster used for bib/name/category mapping                                                  |
| `GET /api/state`       | Competition state, format, connection count and TCP port                                        |
| `POST /api/control`    | JSON `{ "action": "start" }`, `pause`, `next`, `reset`, or `{ "action": "speed", "speed": 10 }` |

The simulator starts paused at 1× speed. All TCP clients share one competition; joining during a run does not synthesize a new start. Pause completes the current run before stopping. Next immediately starts the next racer, or finishes the current racer at the predefined synthetic finish time. Reset pauses, restores initial order and disconnects TCP clients; it does not reset overlay standings.

Speed accepts values from 1 to 100. Race timestamps use a virtual clock, so final durations remain constant at any speed. OBS interpolates running time using real elapsed time; use 1× for checking the lower-third clock. The test roster has nine competitors in `Demo`; bib `001` has a 30-second time and all others are slower.

Before connecting the overlay, set `mode: "tcp"`, `protocol: "vola"`, `host: "127.0.0.1"`, `port: 5409`, `testFeed: true`. Then import the simulator CSV. The admin preset fills these values but requires explicit save and roster fetch.
