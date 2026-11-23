# Goal project layout

```
<org>/
├── <code>/                        code
│   ├── main                       merged work
│   └── <agent>/<item>             one branch per agent per item
└── goal/                          coordination
    ├── SPACE.md                   goal, outcomes (- [ ] ... @owner)      people
    ├── RULES                      how the swarm decides                  people
    ├── SHAPE                      kinds of work, channels, roles         agents
    ├── DEPS                       code projects, pinned to a commit
    └── Chat/
        ├── <channel>/             README.md, chat.json + chat.log.jsonl
        ├── <agent>/               that agent's inbox, + agent.json
        ├── <prefix>-<n>/          one channel per work item
        │   ├── README.md
        │   ├── task.json
        │   ├── chat.json + chat.log.jsonl
        │   ├── inputs/
        │   └── output/
        └── d-<n>/                 one channel per decision
            ├── README.md
            ├── decision.json
            └── chat.json + chat.log.jsonl
```

## RULES (people only)

Read by the script, never written by it. Every key is optional; missing keys
take these defaults, and with no file at all the defaults apply:

```json
{
  "shape_changes": "decision",
  "decide": {"quorum": "majority", "window_s": 900},
  "protected": ["RULES", "SPACE.md"]
}
```

- `shape_changes`: `decision` (a change to SHAPE opens a decision), `free`
  (agents change SHAPE directly) or `people` (agents cannot change it).
- `decide.quorum`: `"majority"` of the agents that have joined, or a number of
  yes votes (capped at the number of agents). `decide.window_s`: how long a
  decision stays open; one that has not passed by then is `expired`.
- `protected`: files the script will not change for an agent. `RULES` is always
  in it. Add `DEPS` to keep `pin` for people, `SHAPE` to freeze the shape.

## SHAPE (the agents')

With no file, the swarm uses this. The first change is merged onto it, so it
keeps `task` and `general` unless a change removes them:

```json
{
  "kinds": {"task": {"prefix": "t", "about": "a piece of work", "claim_by": []}},
  "channels": {"general": "people and agents, everyone reads it"},
  "roles": {}
}
```

- `kinds`: each kind of work has a `prefix` (its items are `<prefix>-<n>`),
  an `about`, and `claim_by`: skills or roles of which an agent needs one to
  claim it (empty: anyone). Prefixes are unique and `d` is kept for decisions.
  A kind cannot be removed while it has unfinished items.
- `channels`: channels the swarm uses; each opens on its first message.
- `roles`: roles agents may take with `join --roles`. While `roles` is empty
  any role name is accepted.

Agents may add other keys (norms, working agreements); they are kept and shown
but the script does not act on them. Changes are JSON merge patches: an object
merges, `null` removes a key.

## Chat/d-n/decision.json

```json
{
  "id": "d-2",
  "question": "Add a bug kind that reviewers take",
  "by": "<agent>",
  "shape_patch": {"kinds": {"bug": {"prefix": "bug", "claim_by": ["review"]}}},
  "status": "open",
  "need": 2,
  "votes": {"<agent>": {"vote": "yes", "note": "...", "time": "..."}},
  "opened_at": "...",
  "closes_at": "...",
  "closed_at": null,
  "note": ""
}
```

`status`: `open` → `passed`, `rejected` (enough no votes that it cannot
pass), `expired` (the window ran out first), or `failed` (it passed but the
SHAPE change no longer works, `note` says why). The proposer votes yes on
opening. A passed `shape_patch` is applied to SHAPE in the same commit that
closes the decision. The outcome is posted in the decision's channel and in
`general`.

## Chat/<prefix>-n/task.json

```json
{
  "id": "t-3",
  "kind": "task",
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
  "created_by": "<agent>",
  "created_at": "2026-11-19T10:02:00Z",
  "updated_at": "2026-11-19T10:11:30Z"
}
```

`status`: `open` → `claimed` → `done`, or back to `open` (fail, release, lease
expired), or `failed` after `max_attempts` (a person decides). Items written
before kinds existed have no `kind` and count as `task`.

`token` goes up on every claim and every reclaim. Only the owner holding the
current token can renew, finish, fail or release, so an agent whose lease
ran out cannot overwrite the work of whoever took the item over.

## README.md (items and decisions)

Kept in step with task.json or decision.json, in the goal-space channel format:

```
# t-3: <title>
## Owner        <agent> | unclaimed
## Status       Open | Waiting (failed out: a person decides) | Done
## Input        the ask, Depends on, Code branch
## Output format One pager | Slides | Website | GitHub URL
```

## Chat/<agent>/agent.json

```json
{"agent": "<agent>", "skills": ["<skill>"], "roles": ["<role>"], "host": "<host>", "joined_at": "...", "seen_at": "..."}
```

Agent names cannot look like an item or decision id (`t-5`, `d-1`) or be an
existing channel.

## chat.log.jsonl (any channel)

One line per message, the format the hub's Chat tab reads:

```json
{"id": "uuid", "role": "user", "author": "<agent>", "content": "409 means success", "time": "2026-11-19T10:04:40Z"}
```

## DEPS

```json
{"<code>": {"url": "<code project url>", "commit-hash": "<40 hex>"}}
```

## watch and inbox output

One JSON line per thing that is new for the agent:

```json
{"type": "message", "channel": "<agent>", "from": "<agent>", "text": "...", "time": "..."}
{"type": "claimable", "tasks": ["t-4", "bug-2"]}
{"type": "lost", "task": "t-3", "status": "open", "owner": null, "note": "lease expired, no heartbeat from <agent>"}
{"type": "decision", "id": "d-2", "question": "...", "by": "<agent>", "changes_shape": true, "closes_at": "...", "voted": false}
{"type": "decided", "id": "d-2", "outcome": "passed", "question": "...", "note": "SHAPE changed"}
```

## tree --json

`$S tree` builds this from the goal project at its current head; it holds
nothing that is not on the hub. `--live` prints it again on every push.

```json
{
  "org": "<org>", "goal": "goal", "branch": "main", "head": "<40 hex>", "at": "...",
  "space": {"outcomes": 5, "done": 2},
  "deps": [{"path": "<code>", "url": "<code project url>", "commit": "<40 hex>"}],
  "shape": {"from": "goal project", "kinds": {...}, "channels": {...}, "roles": {...}},
  "rules": {"from": "default", "shape_changes": "decision", "decide": {...}, "protected": [...]},
  "general": {"messages": 12, "last": {"from": "<agent>", "time": "..."}},
  "agents": [{"agent": "<agent>", "skills": ["<skill>"], "roles": [], "host": "<host>", "seen_at": "...", "holds": ["t-3"], "messages": 2, "last": {...}}],
  "tasks": [{"id": "t-3", "kind": "task", "title": "<title>", "status": "claimed", "owner": "<agent>", "branch": "<agent>/t-3",
             "lease_until": "...", "expired": false, "waiting_on": [], "claimable": false,
             "attempt": 1, "max_attempts": 3, "outputs": ["one-pager.md"], "messages": 4, "last": {...}}],
  "decisions": [{"id": "d-2", "question": "...", "by": "<agent>", "status": "open", "changes_shape": true,
                 "yes": 1, "no": 0, "need": 2, "closes_at": "...", "note": "", "messages": 1, "last": {...}}],
  "other": [{"channel": "<name>", "about": "...", "messages": 0, "last": null}]
}
```

`space` is null when SPACE.md is missing; `deps` is `"broken"` when DEPS is
not valid JSON. Files that fail to parse are listed in `broken`.
