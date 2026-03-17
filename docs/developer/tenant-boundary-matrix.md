# Tenant Boundary Matrix

This matrix defines the expected tenant boundary for API routes where `company` is the isolation unit.

## Enforcement Model

- `company-scoped` routes require `x-company-id` and pass `requireCompanyScope`.
- `global-admin` operations are restricted to board actors.
- Tenant-bound repository calls must include `companyId` filters for reads and writes.

## Route Matrix

| Route Group | Scope Class | Enforcement | Notes |
| --- | --- | --- | --- |
| `/projects` | company-scoped | `requireCompanyScope` + permission checks | Repository calls filter by `companyId`. |
| `/issues` | company-scoped | `requireCompanyScope` + permission checks | Attachments/comments/activity are company-filtered. |
| `/goals` | company-scoped | `requireCompanyScope` + permission checks | Goal/project/parent checks enforce same company. |
| `/agents` | company-scoped | `requireCompanyScope` + permission/board checks | Lifecycle and writes require explicit authz. |
| `/governance` | company-scoped | `requireCompanyScope` + permission checks | Approval workflows scoped by company. |
| `/heartbeats` | company-scoped | `requireCompanyScope` + permission checks | Run operations use company-scoped IDs. |
| `/observability` | company-scoped | `requireCompanyScope` | Logs/costs/runs are company-filtered. |
| `/templates` | company-scoped | `requireCompanyScope` + permission checks | Template/version/install resources include company key. |
| `/plugins` config/install/runs | company-scoped | `requireCompanyScope` | Uses `plugin_configs` + `plugin_runs` with company key. |
| `/plugins/:pluginId` delete | global-admin | `requireCompanyScope` + `requireBoardRole` | Prevents tenant-scoped actors from deleting global plugin catalog entries. |
| `/companies` list | actor-visible | actor filter in handler | Board sees all companies; members see assigned companies only. |
| `/companies` create | global-admin | `requireBoardRole` | Company creation is a global admin action. |
| `/companies/:companyId` update/delete | scoped-admin | `canAccessCompany` + `companies:write` (or board) | Prevents cross-company mutation by members. |
| `/auth` | bootstrap/auth | actor-token policy | Not tenant data; provides identity/session primitives. |

## Data Layer Boundary

- Tenant-bound tables include `company_id` and are expected to be queried with `companyId` predicates.
- Intentional global table:
  - `plugins` (catalog metadata), with tenant-specific state in `plugin_configs`.
- Cross-tenant safety hardening:
  - Project workspace hydration now filters by both `project_id` and `company_id`.
