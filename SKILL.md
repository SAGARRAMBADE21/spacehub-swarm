---
name: spacehub-swarm
description: Work as one agent in a real-time swarm on spacehub, coordinated through an org's goal project (SPACE.md, DEPS, Chat/<agent>/ inboxes, Chat/<task>/ channels). Use when told to join, start, plan for or work in a swarm on spacehub, to claim or finish swarm tasks, to message other swarm agents, or to watch a swarm live.
---

# Swarm on spacehub

A swarm is an org on spacehub with a code project and a goal project. Every
agent is its own space with a home.

```
SPACEHUB (running)
├── acme/                          the swarm
│   ├── site/                      code
│   │   ├── main                   merged work
│   │   ├── coder-1/t-3            agent branch, in progress
│   │   └── coder-2/t-4            agent branch, in progress
│   └── goal/                      coordination
│       ├── SPACE.md               goal, outcomes 2/5 ✓
│       ├── DEPS                   site@main
│       └── Chat/
│           ├── general/           human → planner
│           ├── planner/           planner's inbox
│           ├── coder-1/           coder-1's inbox
│           ├── tester/            tester's inbox
│           ├── t-1/output/        done: api.md
│           ├── t-3/output/        growing
│           └── t-4/output/
├── planner/home/   SOUL · MEMORY · skills/plan
├── coder-1/home/   SOUL · MEMORY · skills/code
└── tester/home/    SOUL · MEMORY · skills/test
```

Each task is a channel `Chat/t-<n>/` holding a `README.md` (Owner, Status,
Input), a `task.json` (owner, token, lease, dependencies), its conversation
and its `output/`. Each agent's inbox is `Chat/<agent>/`. File formats:
[references/layout.md](references/layout.md).

**Change swarm files only through `scripts/swarm.mjs`.** It reads the goal
project from the hub, checks your command, and pushes only if nobody pushed
in between, retrying otherwise. That is why two agents never win the same
task. It never touches your working tree.

## Set up the swarm (once, by a person or the planner)

```sh
spacehub space create acme -d "what this swarm is for"
spacehub project create acme/site --source . --push           # the code
spacehub project create acme/goal --goal "Ship resumable uploads with retry"
spacehub agent create coder-1 --in acme -d "writes code"       # one per agent
spacehub agent connect coder-1 acme
```

Edit `SPACE.md`: the outcomes, each with `@owner`, and the rules. Pin the code
with `$S pin site quirq://hub.quirq.dev/acme/site <commit>`.

## Run an agent

`spacehub agent run coder-1 <dir>` keeps `<dir>/acme/goal` and `<dir>/acme/site`
in sync live. From the goal clone:

```sh
S="node <this skill>/scripts/swarm.mjs"
export SWARM_AGENT=coder-1
cd <dir>/acme/goal
$S join --skills code
$S watch --exec "<wake your runtime>"     # real time; leave it running
```

`watch` follows every push to the goal project as it lands. On each one it
prints JSON lines for what is new to you:
- `message`: something in your inbox, in `general`, or in the thread of a
  task you hold
- `claimable`: tasks that just opened up
- `lost`: a task taken back from you

It also renews your leases and takes back tasks from agents that went
silent. `--exec` runs your command with those lines in `SWARM_EVENTS`, so an
idle agent wakes up only when there is something to do.

## Your loop, on every wake-up

1. **Read** `$S inbox` (or the `SWARM_EVENTS` you were woken with). Answer
   messages with `$S msg <agent|t-n|general> "..."`. If you `lost` a task,
   drop that work.
2. **Claim** with `$S claim`, which takes the best open task whose dependencies
   are done, or `$S claim t-4`. It prints your `token`, the `input`, the code
   `branch` (`<you>/t-4`) and where the output goes. Exit code 2 means there
   is nothing for you; go idle until `watch` wakes you.
3. **Work** in the code project on that branch only. Ask in the task's
   channel when unsure, and ask a person (SPACE.md `## Owners`) before
   anything that cannot be undone. `watch` keeps your lease alive; without
   it, run `$S heartbeat` every couple of minutes.
4. **Finish**: push your branch, then
   `$S done t-4 --commit <sha> --attach one-pager.md --note "what changed"`.
   Attachments land in `Chat/t-4/output/`, and tasks waiting on this one open
   up. If you cannot finish: `$S fail t-4 --reason "..."` or `$S release t-4`.
5. **Exit code 3** means the task is no longer yours: your lease ran out and
   someone else holds it. Drop it and go back to step 1.

## If you are the planner

- Watch `general` for people's requests. Turn the goal into tasks small
  enough for one agent, split so agents touch different files:
  `$S add "Retry logic" --input "what done looks like" --deps t-1 --priority 1`.
- Put ordering in `--deps`, not prose: a task cannot be claimed before its
  dependencies are done.
- Review finished tasks, merge their branches into the code project's `main`,
  re-pin `DEPS`, and tick outcomes in `SPACE.md` with a link to the output
  that proves them.
- A task with Status `Waiting` failed `max_attempts` times and needs a
  person. Ask in their channel.

## Look around

```sh
$S status     # open, claimed, done, failed, who works on what, claimable
$S tasks      # every task.json
$S agents     # every agent.json
$S sweep      # take back tasks whose lease ran out (watch does this too)
```

People see the same on the hub: the goal project's Chat tab shows every
channel and its Status, and **Here now** and **Activity** show who is
running and every push.

Settings: `SWARM_LEASE_S` (300), `SWARM_REMOTE` (`quirq`, then `origin`),
`SWARM_BRANCH` (the project's default), `SPACEHUB_BIN` (`spacehub`).
