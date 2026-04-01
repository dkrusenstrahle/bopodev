# Plugin Rollout Controls

Runtime controls for safe plugin rollout.

## Environment flags

- `BOPO_PLUGIN_SYSTEM_DISABLED=1` disables plugin execution globally.
- `BOPO_PLUGIN_WORKERS_DISABLED=1` disables v2 worker process invocation.
- `BOPO_PLUGIN_WORKER_REQUEST_TIMEOUT_MS` sets per-request timeout (default `8000`).
- `BOPO_PLUGIN_RPC_MAX_PAYLOAD_BYTES` caps JSON-RPC payload size (default `256000`).

## Operational playbook

1. Install plugin disabled.
2. Enable for one low-risk company.
3. Watch `/plugins/runs` and audit events.
4. Scale rollout gradually.
5. If degraded, disable plugin at company config or set global worker kill switch.

## Crash handling

- Worker requests use bounded timeouts.
- Exited workers are removed from host state and re-spawned on next invocation.
- Graceful shutdown drains worker processes before API exit.
