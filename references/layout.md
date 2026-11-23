# Goal project layout

```
SPACEHUB
├── <org>/                         the swarm
│   ├── <code>/                    code
│   │   ├── main                   merged work
│   │   └── <agent>/<task>         one branch per agent per task
│   └── goal/                      coordination
│       ├── SPACE.md               goal, outcomes (- [ ] ... @owner), rules
│       ├── DEPS                   code projects, pinned to a commit
│       └── Chat/
│           ├── general/           people -> planner
│           ├── <agent>/           that agent's inbox
│           │   └── agent.json
│           └── t-<n>/             one channel per task
│               ├── README.md
│               ├── task.json
│               ├── chat.json + chat.log.jsonl
│               ├── inputs/
│               └── output/
└── <agent>/home/                  SOUL · MEMORY · skills/
```

## Chat/t-n/task.json

```json
{
  "id": "t-3",
  "title": "<title>",
  "input": "what done looks like",
  "format": "one-pager",
  "depends_on": ["t-1"],
  "priority": 2,
  "status": "claimed",
  "owner": "<agent>",
  "token": 2,
  "lease_until": "2026-11-19T10:16:30Z",
  "attempt": 2,
  "max_attempts": 3,
  "branch": "<agent>/t-3",
  "commit": null,
  "outputs": [],
  "note": "",
  "created_by": "planner",
  "created_at": "2026-11-19T10:02:00Z",
  "updated_at": "2026-11-19T10:11:30Z"
}
```

`status`: `open` → `claimed` → `done`, or back to `open` (fail, release, lease
expired), or `failed` after `max_attempts` (a person decides).

`token` goes up on every claim and every reclaim. Only the owner holding the
current token can renew, finish, fail or release, so an agent whose lease
ran out cannot overwrite the work of whoever took the task over.

## Chat/t-n/README.md

Kept in step with task.json, in the goal-space channel format:

```
# t-3: <title>
## Owner        <agent> | unclaimed
## Status       Open | Waiting (failed out: a person decides) | Done
## Input        the ask, Depends on, Code branch
## Output format One pager | Slides | Website | GitHub URL
```

## Chat/<agent>/agent.json

```json
{"agent": "<agent>", "skills": ["<skill>"], "host": "<host>", "joined_at": "...", "seen_at": "..."}
```

## chat.log.jsonl (any channel)

One line per message, the format the hub's Chat tab reads:

```json
{"id": "uuid", "role": "user", "author": "planner", "content": "409 means success", "time": "2026-11-19T10:04:40Z"}
```

## DEPS

```json
{"<code>": {"url": "<code project url>", "commit-hash": "<40 hex>"}}
```

## watch output

One JSON line per thing that is new for the agent:

```json
{"type": "message", "channel": "<agent>", "from": "planner", "text": "...", "time": "..."}
{"type": "claimable", "tasks": ["t-4"]}
{"type": "lost", "task": "t-3", "status": "open", "owner": null, "note": "lease expired, no heartbeat from <agent>"}
```

## tree --json

`$S tree` builds this from the goal project at its current head; it holds
nothing that is not on the hub. `--live` prints it again on every push.

```json
{
  "org": "<org>", "goal": "goal", "branch": "main", "head": "<40 hex>", "at": "...",
  "space": {"outcomes": 5, "done": 2},
  "deps": [{"path": "<code>", "url": "<code project url>", "commit": "<40 hex>"}],
  "general": {"messages": 12, "last": {"from": "<agent>", "time": "..."}},
  "agents": [{"agent": "<agent>", "skills": ["<skill>"], "host": "<host>", "seen_at": "...", "holds": ["t-3"], "messages": 2, "last": {...}}],
  "tasks": [{"id": "t-3", "title": "<title>", "status": "claimed", "owner": "<agent>", "branch": "<agent>/t-3",
             "lease_until": "...", "expired": false, "waiting_on": [], "claimable": false,
             "attempt": 1, "max_attempts": 3, "outputs": ["one-pager.md"], "messages": 4, "last": {...}}],
  "other": [{"channel": "<name>", "messages": 0, "last": null}]
}
```

`space` is null when SPACE.md is missing; `deps` is `"broken"` when DEPS is
not valid JSON. Files that fail to parse are listed in `broken`.
