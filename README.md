# EngLoop

**A multi-agent orchestrator for Claude Code, built on Redis Streams and tmux.**

EngLoop runs a long-lived orchestrator (JARVIS) and a team of resident agents, each in its own
Claude Code session inside tmux. They talk to each other and to you through durable Redis Streams.
One-shot workers (eval, review, solve, test) are spawned on demand by a worker pool. You watch and
steer everything from a local web console.

![Today view: what needs you, what just finished, fleet health](assets/screenshots/today.png)

> The screenshots come from the built-in preview server (`npm run preview`), which serves
> synthetic fixture data. The console UI text is in Chinese.

---

## Why

Most multi-agent setups treat agents as functions: call one, get a result back. EngLoop treats them
as **colleagues who stay online**. Each agent keeps its own session, context and working directory.
Agents receive work through an inbox, report back, and keep going. The hard part is keeping a group
like that reliable, and that is most of what this repo does:

- **Messages are never lost.** Each inbox is a Redis Stream with a consumer group. A message is
  acknowledged only after the agent replies. If an agent crashes mid-task, the message stays
  pending and is redelivered with a `redelivered: true` flag (`XREADGROUP` → `XACK`, with
  `XAUTOCLAIM` for recovery). Delivery is at-least-once by design.
- **A silent agent is detected on the server.** The watchdog reads each consumer's idle time from
  Redis (`XINFO CONSUMERS`). It doesn't rely on the agent to report its own health. An agent that
  stops polling is flagged as *deaf* and nudged, and a rate-limited agent is recognized as rate-limited.
- **"Done" is verified, not trusted.** When an agent marks work done and attaches evidence, an
  independent check runs before the task gets its 🏁. A failed check bounces the task back to the agent.
  After repeated failures it escalates to the orchestrator.
- **The model-facing contract is tiny.** An agent's whole loop is: run `node bin/next.js`, which
  blocks for up to about 10 minutes. Then handle the JSON it returns, write a reply file into its
  outbox, and repeat. Transport, routing, rooms and verification all sit below that interface.

## How it works

```
               ┌──────────────────── bus (bin/serve.js, 127.0.0.1:9969) ────────────────────┐
  you ──web──▶ │  HTTP + WebSocket · auth · relay · rooms · watchdog · worker pool · graphs  │
               └───────┬─────────────────────────┬──────────────────────────┬──────────────┘
                       │ Redis Streams            │                          │ work:<type>
          ┌────────────▼───────────┐   ┌──────────▼──────────┐    ┌──────────▼───────────┐
          │ orchestrator (JARVIS)  │   │ resident agents     │    │ one-shot workers     │
          │ tmux: orch             │◀─▶│ tmux: agent_<name>  │    │ eval/review/solve/   │
          │ loop: bin/next.js      │   │ loop: bin/next.js   │    │ test (claude -p)     │
          └────────────────────────┘   └─────────────────────┘    └──────────────────────┘
               replies: temp/outbox/<name>/*.json  ──▶  relay  ──▶  recipient's inbox stream
```

- **Bus.** A single Node process (`bin/serve.js`) that owns the queue, the relay, the roster,
  the watchdog, rooms, the worker pool and the task-graph runner. It binds to `127.0.0.1` only.
- **Orchestrator.** A Claude Code session whose instructions are the root `CLAUDE.md` and
  `protocols/`. It talks to people, hands work to agents, and relays results back.
- **Resident agents.** Started with `./start.sh <name>` or `node bin/agent-start.js`. Each
  runs in its own tmux session and working directory, optionally in its own git worktree. Agents
  run sandboxed by default. Their `CLAUDE.md` and settings are rendered from `templates/`.
- **Roster.** Addressing is by name. A reply to a name on the roster lands in that agent's inbox,
  and a reply to any other name goes to the web console as a message to a person.
- **Rooms.** Group conversations. Each room is one stream (the source of truth for its history),
  and the bus fans messages out to each participant's inbox, so agents need no changes to take part.
  **Flows** (`protocols/flows/*.json`) turn a room into a staged pipeline, for example
  survey → tasks → implement → review, with verdict-based send-backs.
- **Worker pool.** Each worker type has its own `work:<type>` stream. A worker takes one task from
  its prompt, prints the result to stdout and exits. The pool acknowledges the task; a failure is
  never acked and gets retried. The default types are `eval`, `review`, `solve` and `test`.
- **Task graphs.** A `PLAN.json` describes a DAG of tasks. `bin/graph.js` validates it, freezes
  it, waits for human approval, and lets the bus schedule the nodes across agents and workers.

## The web console

Open `http://127.0.0.1:9969` and sign in with a key from `bin/bus-user.js`.

| View | What it's for |
|---|---|
| **Today** | A greeting and a summary line. Cards for anything waiting on you (a deaf agent, an unanswered @mention). A feed of reports finished in the last 24 hours, with their verification status. |
| **Conversations** | The fleet strip: every agent's state (online, deaf, rate-limited, slow to poll, not started) and its queue depth. Rooms and direct messages, plus the "needs you" panel and the latest full test run. |
| **Lanes** | One column per agent showing everything it sent and received, side by side, so you can follow each agent's traffic at a glance. |

![Conversations view: fleet strip, rooms and DMs, needs-you panel](assets/screenshots/conversations.png)

![Lanes view: one column per agent](assets/screenshots/lanes.png)

There is also a ⌘K jump palette, desktop notifications, and a dark theme.

To work on the UI without a bus, Redis or tmux:

```bash
npm run preview          # serves web/ against test/fixtures/web-preview/ on a random port
                         # (never 9969); ?scenario=blind|busy-queue|empty|… picks a fixture set
```

## Requirements

- macOS. The launchd integration and the `sandbox-exec` sandboxing are macOS-only; the rest is plain Node.
- Node.js 22+
- Redis with AOF enabled (only Streams are used)
- tmux
- The [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI (`claude`), signed in

## Quick start

```bash
npm ci
node bin/bus-user.js add <username> --manage   # creates a web login key (printed once; only the hash is stored)
./start.sh                       # start the bus (nohup by default) and the orchestrator
open http://127.0.0.1:9969       # web console
tmux attach -t orch              # sit in the orchestrator's session
./start.sh dev                   # start a resident agent named "dev"
node bin/agent-start.js --list   # who's online
./bin/preflight.sh               # self-check
./stop.sh                        # graceful shutdown
```

`config/users.json` is git-ignored. See `config/users.json.template` for its shape.

Task graphs:

```bash
node bin/graph.js start <dir>      # validate <dir>/PLAN.json, freeze it, and start (or wait for approval)
node bin/graph.js approve <id>
node bin/graph.js status [<id>]
node bin/graph.js retry <id> <node>
node bin/graph.js cancel <id>
```

## Running the bus: nohup or launchd

The default is **nohup**. Once you install the launchd agent, start, stop and restart all go
through launchd instead. Both paths run `bin/serve.sh`, so the node path, `PATH`, worker types
and log location (`temp/bus.log`) are defined in one place.

| | nohup (default) | launchd (after `node bin/launchd.js install`) |
|---|---|---|
| Start | `./start.sh` → `nohup bash bin/serve.sh` | `./start.sh` → `launchctl bootstrap` / `kickstart` |
| Stop | `./stop.sh` | `./stop.sh` → `launchctl bootout`, then stop the process (the plist is kept) |
| Restart | `node bin/bus-restart.js` | `node bin/bus-restart.js` → `launchctl kickstart -k` |
| If it crashes | stays down | KeepAlive restarts it |
| After login | start it by hand | starts automatically (RunAtLoad) |

```bash
node bin/launchd.js print       # show the generated plist; changes nothing
node bin/launchd.js status
node bin/launchd.js install     # refuses while a nohup bus is running: ./stop.sh first
node bin/launchd.js uninstall   # back to nohup
```

launchd manages only the bus. The orchestrator and agents are still started by `./start.sh`,
because a Claude Code session needs a logged-in user. Redis is managed separately, for example
with `brew services`.

## Repository layout

| Path | What's there |
|---|---|
| `bin/` | Entry points: bus (`serve.js`), poller (`next.js`), agent launcher (`agent-start.js`), task graphs (`graph.js`), launchd, users, … |
| `lib/` | Queue, relay, roster, watchdog, worker pool, rooms, graph runner, done-verification, sandbox profiles, auth |
| `web/` | The web console (vanilla JS, no build step) |
| `hooks/` | Claude Code hooks (security check, Stop checks) |
| `protocols/` | The identity and polling rules injected into agents each turn; `flows/` holds room flow templates |
| `templates/` | `CLAUDE.md` and `.claude/settings.json` templates for each agent and worker type |
| `workers/` | Worker working directories, re-rendered from `templates/` for each task |
| `agents/` | Resident agents' working directories, created on first start (empty in a fresh clone) |
| `scripts/` | Mutation-testing scripts, UI preview server, maintenance tools |
| `test/` | Tests; `node test/run-all.js` runs them all |

## Tests

```bash
node test/run-all.js                        # everything, one subprocess per file
node test/run-all.js --only queue.test.js
```

Tests use Redis databases 1–15 (each run claims a free one and locks it) and **never touch db 0**.
They never connect to a bus on port 9969.
A few tests depend on the host (tmux, macOS `sandbox-exec`) and fail elsewhere.
`scripts/mutate-*.js` apply in-memory mutations to check that the tests actually fail when the code is wrong.

## Roadmap

**Shipped**

- [x] Durable inboxes on Redis Streams, with redelivery after a crash
- [x] Resident agents in tmux, launched sandboxed with generated settings, optionally in their own git worktree
- [x] Watchdog for silent agents and rate limits, with automatic resume after a usage-limit reset
- [x] One-shot worker pool (`eval` / `review` / `solve` / `test`), including an alternative sandboxed backend for `solve`
- [x] Rooms and staged room flows with verdict-based send-backs
- [x] Independent verification of "done" (⏳ → 🏁 / 🔙)
- [x] Task graphs (`PLAN.json`) with a human approval gate
- [x] Web console with login, plus nohup and launchd modes for the bus

**In scope, not scheduled**

Both items below are part of the design but have no use on a single machine with one orchestrator.
They wait until a concrete need shows up.

- [ ] **Service registry.** An agent can publish an HTTP endpoint, and other agents call it by path
  alone. Paths are unique across the fleet; a collision is rejected. Worth building when the first
  agent needs to serve something to the others.
- [ ] **Orchestrator network.** Parent and child orchestrators on different machines, registered with
  per-child keys. The parent controls what each child can see (all off by default). Messages travel
  child ↔ parent, and sibling ↔ sibling through the parent. Only a verified parent can start or stop
  a child's agents. Worth building once there is a second orchestrator.

## Status

EngLoop is a personal project, used daily on one Mac. It's shared as-is: expect rough edges,
a Chinese-language UI and protocols, and macOS assumptions.

## License

MIT. See [`LICENSE`](LICENSE).
