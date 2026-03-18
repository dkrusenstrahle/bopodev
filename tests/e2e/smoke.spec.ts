import { expect, test, type APIRequestContext } from "@playwright/test";

const apiUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4020";

test.describe("workspace smoke journeys", () => {
  test("issues page renders seeded issue", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Issues Company");
    const projectId = await createProject(request, companyId, "E2E Project");
    await createIssue(request, companyId, projectId, "E2E Smoke Issue");

    await page.goto(`/issues?companyId=${companyId}`);

    await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  });

  test("projects page renders seeded project", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Projects Company");
    await createProject(request, companyId, "Open Source Beta Prep");

    await page.goto(`/projects?companyId=${companyId}`);

    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByText("Open Source Beta Prep")).toBeVisible();
  });

  test("legacy governance route redirects to inbox board decisions", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Governance Company");

    await apiPost(request, "/agents", companyId, {
      role: "Engineer",
      name: "Needs Approval",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 25,
      canHireAgents: false,
      requestApproval: true,
      runtimeCommand: "echo",
      runtimeCwd: "/tmp",
      runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
    });

    await page.goto(`/governance?companyId=${companyId}`);

    await expect(page).toHaveURL(new RegExp(`/inbox\\?companyId=${companyId}.*preset=board-decisions`));
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.getByText("hire_agent")).toBeVisible();
    await expect(page.getByText("Needs Approval · Engineer")).toBeVisible();
  });

  test("dashboard highlights pending approvals and attention actions", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Dashboard Company");
    const projectId = await createProject(request, companyId, "E2E Dashboard Project");
    const issueId = await createIssue(request, companyId, projectId, "Blocked dashboard issue");
    await updateIssue(request, companyId, issueId, { status: "blocked" });

    await apiPost(request, "/agents", companyId, {
      role: "Engineer",
      name: "Dashboard Approver",
      providerType: "shell",
      heartbeatCron: "*/5 * * * *",
      monthlyBudgetUsd: 25,
      canHireAgents: false,
      requestApproval: true,
      runtimeCommand: "echo",
      runtimeCwd: "/tmp",
      runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
    });

    await page.goto(`/dashboard?companyId=${companyId}`);

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Needs your approval")).toBeVisible();
    await expect(page.getByText("Pending approval mix")).toBeVisible();
    await expect(page.getByText("Needs attention")).toBeVisible();
    await expect(page.getByText("hire agent").first()).toBeVisible();
    await expect(page.getByText("requested by system")).toBeVisible();
    await expect(page.locator("div", { hasText: "Blocked issues" }).first()).toContainText("1");

    await page.getByRole("link", { name: "Open inbox" }).click();
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();

    await page.goto(`/dashboard?companyId=${companyId}`);
    await page.getByRole("link", { name: "Review approvals" }).click();
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/inbox\\?companyId=${companyId}.*preset=board-decisions`));
  });
});

async function createCompany(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(`${apiUrl}/companies`, {
    data: { name, mission: "E2E smoke validation" }
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function createProject(
  request: APIRequestContext,
  companyId: string,
  name: string
): Promise<string> {
  const response = await apiPost(request, "/projects", companyId, { name });
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function createIssue(
  request: APIRequestContext,
  companyId: string,
  projectId: string,
  title: string
) {
  const response = await apiPost(request, "/issues", companyId, { projectId, title, priority: "medium" });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function updateIssue(
  request: APIRequestContext,
  companyId: string,
  issueId: string,
  payload: { status?: string; assigneeAgentId?: string | null }
) {
  const response = await request.put(`${apiUrl}/issues/${issueId}`, {
    headers: {
      "x-company-id": companyId
    },
    data: payload
  });
  expect(response.ok()).toBeTruthy();
}

async function apiPost(
  request: APIRequestContext,
  path: string,
  companyId: string,
  data: Record<string, unknown>
) {
  const response = await request.post(`${apiUrl}${path}`, {
    headers: {
      "x-company-id": companyId
    },
    data
  });
  expect(response.ok()).toBeTruthy();
  return response;
}
