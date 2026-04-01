# Runtime Demo Plugin

This is a ready-to-test demo plugin for the new plugin platform.

## What it demonstrates

- Worker runtime (`stdio`)
- Hook handling (`plugin.hook`)
- Actions (`plugin.action`)
- Data endpoints (`plugin.data`)
- Scheduled jobs (`plugin.job`)
- Webhook handling (`plugin.webhook`)
- UI slot rendering (`entrypoints.ui`)
- Health checks (`plugin.health`)

## Quick test flow

1. Restart API (or start `pnpm dev`) so manifest discovery runs.
2. Open **Workspace -> Plugins**.
3. Find `Runtime Demo`.
4. Click **Activate**.
5. Click **Health** and confirm success.
6. Trigger one action and one data endpoint using API:

```bash
curl -X POST "http://localhost:4020/plugins/runtime-demo/actions/ping" \
  -H "x-company-id: <company-id>" \
  -H "content-type: application/json" \
  -d '{"from":"readme-test"}'

curl -X POST "http://localhost:4020/plugins/runtime-demo/data/state" \
  -H "x-company-id: <company-id>" \
  -H "content-type: application/json" \
  -d '{"from":"readme-test"}'
```

7. Run a heartbeat and verify plugin runs:

```bash
curl "http://localhost:4020/plugins/runs?pluginId=runtime-demo&limit=20" \
  -H "x-company-id: <company-id>"
```

8. Open an issue and select the Runtime Demo plugin tab to verify UI iframe rendering.

## Expected outputs

- Health returns `status: "ok"`.
- Action returns `ok: true` with `actionKey`.
- Data returns `ok: true` with `dataKey`.
- Runs list shows at least one `runtime-demo` hook row after heartbeat.
