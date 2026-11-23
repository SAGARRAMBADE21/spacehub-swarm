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
  "title": "Upload client",
  "input": "what done looks like",
  "format": "one-pager",
  "depends_on": ["t-1"],
  "priority": 2,
  "status": "claimed",
  "owner": "dev-1",
  "token": 2,
  "lease_until": "2026-11-19T10:16:30Z",
  "attempt": 2,
  "max_attempts": 3,
  "branch": "dev-1/t-3",
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
# t-3: Upload client
## Owner        dev-1 | unclaimed
## Status       Open | Waiting (failed out: a person decides) | Done
## Input        the ask, Depends on, Code branch
## Output format One pager | Slides | Website | GitHub URL
```

## Chat/<agent>/agent.json

```json
{"agent": "dev-1", "skills": ["code"], "host": "box-a", "joined_at": "...", "seen_at": "..."}
```

## chat.log.jsonl (any channel)

One line per message, the format the hub's Chat tab reads:

```json
{"id": "uuid", "role": "user", "author": "planner", "content": "409 means success", "time": "2026-11-19T10:04:40Z"}
```

## DEPS

```json
{"site": {"url": "quirq://hub.quirq.dev/acme/site", "commit-hash": "<40 hex>"}}
```

## watch output

One JSON line per thing that is new for the agent:

```json
{"type": "message", "channel": "dev-1", "from": "planner", "text": "...", "time": "..."}
{"type": "claimable", "tasks": ["t-4"]}
{"type": "lost", "task": "t-3", "status": "open", "owner": null, "note": "lease expired, no heartbeat from dev-1"}
```
