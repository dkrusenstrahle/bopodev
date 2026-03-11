# Plugin Samples

This page documents the sample plugin manifests included in the repository for testing and validation.

## Included Samples

- `plugins/prompt-context-plugin/plugin.json`
  - Prompt runtime plugin for `beforeAdapterExecute`.
  - Demonstrates prompt append behavior with template variables.
- `plugins/prompt-webhook-no-network/plugin.json`
  - Prompt runtime plugin intentionally missing network capability.
  - Demonstrates policy failure when webhook requests are configured without required grants.
- `plugins/prompt-webhook-timeout/plugin.json`
  - Prompt runtime plugin with network capability.
  - Demonstrates timeout/error handling for webhook execution failures.

## Usage

1. Keep samples under `plugins/*/plugin.json`.
2. Start or restart API so manifest discovery runs.
3. Install/configure per company through plugin routes or UI.
4. Verify behavior through `/plugins/runs` or `/observability/plugins/runs`.

## Notes

- Manifests are schema-validated before registration.
- Invalid manifest files are skipped and logged as warnings.
- File registration does not auto-enable plugin execution for companies.

## Related Pages

- Plugin architecture: [`plugin-system.md`](./plugin-system.md)
- Authoring guide: [`plugin-authoring.md`](./plugin-authoring.md)
- Hook reference: [`plugin-hook-reference.md`](./plugin-hook-reference.md)
