# Plugin Samples

This page documents the sample plugin manifests included in the repository for testing and validation.

## Included Samples

- `plugins/runtime-demo/plugin.json`
  - End-to-end v2 worker plugin.
  - Includes worker entrypoint and UI entrypoint.
  - Declares hooks, actions, data endpoints, jobs, and webhook declarations.
  - Safe-by-default capability namespace selection for local testing.

- `packages/plugin-sdk-sample/`
  - Publishable package-style sample plugin.
  - Shows how to structure plugin source, build output, and metadata for package install flow.
  - Useful reference for creating your own scoped plugin package.

## Usage

1. Start API and ensure plugin manifest discovery is enabled.
2. Confirm sample appears in `GET /plugins`.
3. Activate sample plugin from workspace Plugins page.
4. Run:
   - health check (`GET /plugins/:pluginId/health`)
   - one action
   - one data endpoint
5. Trigger heartbeat and verify plugin run records in `/plugins/runs`.
6. Open the plugin UI slot and verify rendering.

## Notes

- Manifests are schema-validated before registration.
- Invalid manifest files are skipped and logged as warnings.
- Filesystem registration does not auto-enable plugin execution for companies.
- Sample plugins are for validation and operator training, not production business logic.

## Related Pages

- Plugin architecture: [`plugin-system.md`](./plugin-system.md)
- Authoring guide: [`plugin-authoring.md`](./plugin-authoring.md)
- Hook reference: [`plugin-hook-reference.md`](./plugin-hook-reference.md)
