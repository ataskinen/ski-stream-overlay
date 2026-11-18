# Timing input contracts

The local service binds to `127.0.0.1:8787`. OBS loads its transparent pages through a native `Ski Race Overlay` source. This service does not read a VOLA SQLite database: a CSV roster maps bibs to names and categories.

## JSON events

TCP `jsonl` mode expects one UTF-8 JSON event per newline. HTTP mode fetches an event, an array of events, or `{ "events": [...] }`. `timeMs` is elapsed race time in milliseconds, not an epoch or time-of-day timestamp.

```json
{"type":"start","bib":"001","timeMs":0}
{"type":"time","bib":"001","timeMs":12340}
{"type":"finish","bib":"001","timeMs":42560}
{"type":"clear"}
```

`start` defaults `timeMs` to zero. Other timed events require a finite value from 0 to 86,400,000. Bibs are strings; leading zeros matter. `clear` hides the current racer and keeps standings. `finish` replaces the prior result for that bib. A finish for another bib does not replace a different racer currently running.

HTTP polling skips an unchanged response body to avoid repeatedly restarting the same event. Producers should return their current event batch without changing insignificant whitespace, or use TCP for an event stream. HTTP responses are limited to 2 MB, requests time out after five seconds, redirects are rejected, and URLs cannot contain embedded credentials. Polling interval is configurable from 250 to 60,000 ms. Failed connections retry with increasing delay up to 15 seconds.

## Experimental VOLA TCP adapter

Source evidence: [Kiril's `index.js`](https://github.com/jovchev/vola-skialppro-text-overlay/blob/master/index.js). The original uses TCP port 5409 and a `.scdb` SQLite roster. Its packet parser has no captured packet fixtures. This implementation reconstructs newline-delimited TCP messages and follows these inferred fields:

| Field       | Meaning inferred from the original                          |
| ----------- | ----------------------------------------------------------- |
| `fields[0]` | `NR`                                                        |
| `fields[1]` | `0`: start; every other numeric value: finish               |
| `fields[3]` | Bib                                                         |
| `fields[6]` | Packed timestamp: seconds followed by six fractional digits |

The adapter subtracts the matching start timestamp from the finish timestamp and handles a negative difference as midnight rollover. It accepts packed timestamps of 7–12 decimal digits. A finish without a start in the current connection is ignored. `S` on-course lists and `IR` packets are ignored. Running time between events is a local display estimate. Event silence does not mark the feed stale: some producers send only start and finish. TCP keepalive is enabled with a ten-second initial delay; actual broken-link detection depends on the OS and network.

Confirm message framing, nonzero status meanings, intermediate timing messages and timestamps with the actual VOLA version before using this feed for a race. Synthetic parser tests verify this interpretation only; they are not a hardware compatibility test.

## Local API

All writes use `Content-Type: application/json`. The service checks localhost Host headers and rejects cross-origin requests. It is intended for use on the same computer as OBS.

| Method and route         | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `GET /api/health`        | Identity: `app` is `ski-stream-overlay`                                |
| `GET /api/state`         | Current active mode, connection, roster, racer, results and categories |
| `GET /api/events`        | SSE: default `message` events contain the complete active state        |
| `GET /api/config`        | Saved connection settings                                              |
| `PUT /api/config`        | Replace settings, save and reconnect                                   |
| `POST /api/roster`       | Import `{ "csv": "bib,name,category…" }` atomically                    |
| `POST /api/roster/fetch` | Fetch and cache `{ "url": "https://example.com/roster.csv" }`          |
| `GET /api/roster.csv`    | Download the saved live roster                                         |
| `POST /api/demo`         | `{ "action": "start" }`, `stop`, `next` or `reset`                     |
| `POST /api/reset`        | Clear live results and reconnect                                       |

Configuration fields: `mode` (`demo`, `tcp`, `http-json`), `protocol` (`jsonl`, `vola`), `host`, `port`, `url`, `pollIntervalMs`, `rosterUrl`, `testFeed` (boolean). TCP host is a hostname or IPv4 address without URL scheme or port. CSV roster URLs are fetched on request, not polled automatically.

Live state persists atomically in `state.json` under `DATA_DIR`. Setting `testFeed: true` routes TCP/HTTP input, roster imports and resets into a separate persisted test race and test roster. Overlays label these results `TESTI`. Set the flag to false and load the real roster before receiving real race data. Demo state is separate and ephemeral. The service restores results, roster and configuration, but not the current running racer. Rankings use the last finish per bib and calculate ranks independently per category; tied times share a rank.

Overlay routes are `/overlay/current` and `/overlay/top10?category=...`. Both use a transparent 1920 × 1080 canvas. The native plugin handles these URLs; developers can open them directly for inspection.

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
