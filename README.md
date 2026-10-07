# opengym-mcp

A remote [MCP](https://modelcontextprotocol.io) server for a self-hosted
[openGym](https://github.com/DuarteSantos8/openGym). It lets an LLM client (Claude Code, Claude
Desktop, Cursor and others) read and change your training data over HTTPS: plan routines, set
the week, log and correct workouts, record your weight, add your own exercises.

openGym itself ships a read-only MCP server that runs as a local stdio process next to the data
folder. This project is the remote counterpart: a small gateway you run next to your openGym
instance, which talks to openGym only through its public API. Nothing in openGym changes.

```
LLM client ──HTTPS, Bearer token──▶ opengym-mcp ──same token──▶ openGym API (GET/PUT /api/data)
```

## How it works

- **Auth is openGym's own.** The gateway holds no credentials. A client sends the token a paired
  phone would hold. The gateway forwards it to openGym on every call, so it can do exactly what
  your phone can do on your profile and nothing more. "Sign out everywhere" in openGym revokes it.
- **The same training logic as the app.** openGym is a git submodule, and the tools call its
  pure helpers in `frontend/src/lib`. A workout logged here is built by `buildCompletedWorkout`
  and filed by `completeBackfill`, PR badges come from `rebuildPrHistory`, an edit goes through
  `saveWorkoutEdit`, and a plan import through `parsePlan`/`mergePlan`. The nine read tools are
  upstream's own `mcp/src/tools.js`, answering from your profile over the API instead of a file.
- **Safe concurrent writes.** Every write is a read-modify-write with `baseRev`, the conditional
  write the app's own devices use. When a phone wrote in between, openGym answers 409 with the
  newer document, and the edit is replayed on it. Your other devices pick the change up within
  30 seconds.
- **Validate, then write.** Unknown exercise ids, positions past the end, a session in the future
  and similar mistakes are refused before anything is sent.
- **Stateless.** Each request gets its own MCP server bound to its token. The process keeps no
  session table, and one profile's data never reaches another.

## Tools

| Area | Tools |
|---|---|
| Plan (read) | `list_routines`, `get_routine`, `preview_session`, `get_week_plan`, `export_plan` |
| History and stats (read) | `list_workouts`, `get_workout`, `get_bodyweight`, `estimate_1rm`, `muscle_balance` |
| Library and profile (read) | `search_exercises`, `get_exercise`, `get_settings` |
| Routines | `create_routine`, `update_routine`, `duplicate_routine`, `delete_routine`, `set_routine_exercises`, `add_routine_exercise`, `update_routine_exercise`, `remove_routine_exercise` |
| Schedule | `set_weekday_routines`, `set_day_override` |
| Workouts | `log_workout`, `edit_workout`, `delete_workout` |
| Body weight | `log_bodyweight`, `delete_bodyweight`, `set_goal_weight` |
| Exercises | `create_custom_exercise`, `update_custom_exercise`, `delete_custom_exercise`, `set_exercise_note` |
| Settings and plans | `update_settings`, `import_plan` |

Read tools carry `readOnlyHint`, and deleting or replacing tools carry `destructiveHint`, so
clients can ask before running them.

Not covered, on purpose: account and security settings (passkeys, passwords, sessions), the
admin dashboard, the AI coach, push subscriptions, photo and video uploads, and switching the
weight unit (the app converts every stored weight when you do that, so it belongs there).
The live in-progress workout stays on the device, as in openGym.

## Run it

Next to an openGym started with its own `docker-compose.yml`:

```bash
git clone --recurse-submodules https://github.com/PatrykCzechowski/opengym-mcp
cd opengym-mcp
docker compose -f docker-compose.example.yml up -d --build
curl localhost:3100/health
```

Then route `/mcp` through the reverse proxy that serves openGym over HTTPS. With Caddy, for
openGym under a subpath:

```caddy
handle /gym/mcp {
	uri strip_prefix /gym
	reverse_proxy 127.0.0.1:3100
}
```

| Variable | Default | |
|---|---|---|
| `OPENGYM_API` | `http://api:3000` | openGym API, as the gateway reaches it |
| `PORT` | `3100` | |
| `HOST` | `0.0.0.0` | |
| `MCP_HOST_PORT` | `3100` | host port in `docker-compose.example.yml` |

## Connect a client

1. In openGym: **Settings → Account → Pair the mobile app**. Copy the code; it is valid for 5 minutes.
2. Turn it into a token:

   ```bash
   npm run pair -- https://gym.example.com K7Q2MX9P
   ```

3. Add the server. In Claude Code:

   ```bash
   claude mcp add --transport http opengym https://gym.example.com/mcp \
     --header "Authorization: Bearer <token>"
   ```

   Claude Desktop and other clients that only speak stdio can use
   [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with the same URL and header.

The token lasts `SESSION_DAYS` on the openGym side (90 by default). When it expires, the gateway
answers 401; pair again.

## Develop

```bash
git clone --recurse-submodules https://github.com/PatrykCzechowski/opengym-mcp
npm install
npm test
```

The tests run a real MCP client over Streamable HTTP against the gateway, which talks to an
in-memory openGym API with the same `rev`/409 contract. They cover every write path, conflict
replay and profile isolation.

The submodule is pinned to an openGym commit. To move it forward, check out the new commit in
`vendor/opengym`, run the tests, and commit the submodule change.

## License

AGPL-3.0-or-later, like openGym, whose code this project includes and runs.
