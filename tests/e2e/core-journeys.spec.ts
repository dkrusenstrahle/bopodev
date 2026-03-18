import { expect, test, type APIRequestContext } from "@playwright/test";

const apiUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4020";

test.describe("workspace core journeys", () => {
  test("agent lifecycle journey: request approval, approve, run, inspect details", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Agent Lifecycle Company");
    const projectId = await createProject(request, companyId, "Agent Lifecycle Project");

    const approvalId = await requestAgentHireApproval(request, companyId, {
      name: "Lifecycle Worker",
      role: "Engineer",
      projectId
    });
    const agentId = await resolveApproval(request, companyId, approvalId);
    await createIssue(request, companyId, projectId, "Assigned lifecycle issue", agentId);

    const runId = await runHeartbeat(request, companyId, agentId);
    await waitForRun(request, companyId, runId);

    await page.goto(`/agents/${agentId}?companyId=${companyId}`);
    await expect(page.getByRole("heading", { name: "Lifecycle Worker" })).toBeVisible();
    await page.goto(`/runs?companyId=${companyId}`);
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    await expect(page.getByText("Lifecycle Worker")).toBeVisible();
  });

  test("issue workflow journey: create, comment, handoff, review state", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Issue Workflow Company");
    const projectId = await createProject(request, companyId, "Issue Workflow Project");

    const initialAssignee = await createAgent(request, companyId, {
      name: "Issue Worker A",
      role: "Engineer",
      projectId
    });
    const reviewAssignee = await createAgent(request, companyId, {
      name: "Issue Worker B",
      role: "Reviewer",
      projectId
    });
    const issueId = await createIssue(request, companyId, projectId, "Workflow issue", initialAssignee);
    await addIssueComment(request, companyId, issueId, "Initial implementation is complete.");
    await updateIssue(request, companyId, issueId, {
      status: "in_review",
      assigneeAgentId: reviewAssignee
    });

    await page.goto(`/issues/${issueId}?companyId=${companyId}`);
    await expect(page.getByRole("heading", { name: "Workflow issue" })).toBeVisible();
    await expect(page.getByText("Initial implementation is complete.")).toBeVisible();
    await expect(page.getByText("Issue Worker B").first()).toBeVisible();
  });

  test("governance inbox interaction lifecycle", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Inbox Company");
    await requestAgentHireApproval(request, companyId, {
      name: "Needs Approval",
      role: "Engineer"
    });

    await page.goto(`/inbox?companyId=${companyId}`);
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(page.getByText("Needs Approval · Engineer")).toBeVisible();

    await page.goto(`/governance?companyId=${companyId}`);
    await expect(page).toHaveURL(new RegExp(`/inbox\\?companyId=${companyId}.*preset=board-decisions`));
    await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  });

  test("observability pages render seeded run and trace data", async ({ page, request }) => {
    const companyId = await createCompany(request, "E2E Observability Company");
    const projectId = await createProject(request, companyId, "Observability Project");
    const agentId = await createAgent(request, companyId, {
      name: "Observability Worker",
      role: "Engineer",
      projectId
    });
    await createIssue(request, companyId, projectId, "Observability issue", agentId);
    const runId = await runHeartbeat(request, companyId, agentId);
    await waitForRun(request, companyId, runId);

    await page.goto(`/runs?companyId=${companyId}`);
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    await expect(page.getByText("Observability Worker")).toBeVisible();

    await page.goto(`/trace-logs?companyId=${companyId}`);
    await expect(page.getByRole("heading", { name: "Logs" })).toBeVisible();

    await page.goto(`/costs?companyId=${companyId}`);
    await expect(page.getByRole("heading", { name: "Costs" })).toBeVisible();
  });
});

async function createCompany(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(`${apiUrl}/companies`, {
    data: { name, mission: "E2E core journey validation" }
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function createProject(request: APIRequestContext, companyId: string, name: string): Promise<string> {
  const response = await apiPost(request, "/projects", companyId, { name });
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function createIssue(
  request: APIRequestContext,
  companyId: string,
  projectId: string,
  title: string,
  assigneeAgentId?: string
): Promise<string> {
  const response = await apiPost(request, "/issues", companyId, {
    projectId,
    title,
    priority: "medium",
    assigneeAgentId: assigneeAgentId ?? null
  });
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function createAgent(
  request: APIRequestContext,
  companyId: string,
  input: { name: string; role: string; projectId?: string }
): Promise<string> {
  const response = await apiPost(request, "/agents", companyId, {
    role: input.role,
    name: input.name,
    providerType: "shell",
    heartbeatCron: "*/5 * * * *",
    monthlyBudgetUsd: 15,
    canHireAgents: false,
    requestApproval: false,
    projectId: input.projectId,
    runtimeCommand: "echo",
    runtimeCwd: "/tmp",
    runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
  });
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

async function requestAgentHireApproval(
  request: APIRequestContext,
  companyId: string,
  input: { name: string; role: string; projectId?: string }
): Promise<string> {
  const response = await apiPost(request, "/agents", companyId, {
    role: input.role,
    name: input.name,
    providerType: "shell",
    heartbeatCron: "*/5 * * * *",
    monthlyBudgetUsd: 15,
    canHireAgents: false,
    requestApproval: true,
    projectId: input.projectId,
    runtimeCommand: "echo",
    runtimeCwd: "/tmp",
    runtimeArgs: ['{"summary":"noop","tokenInput":0,"tokenOutput":0,"usdCost":0}']
  });
  const body = (await response.json()) as { data: { queuedForApproval: boolean; approvalId: string } };
  expect(body.data.queuedForApproval).toBe(true);
  return body.data.approvalId;
}

async function resolveApproval(request: APIRequestContext, companyId: string, approvalId: string): Promise<string> {
  const response = await apiPost(request, "/governance/resolve", companyId, { approvalId, status: "approved" });
  const body = (await response.json()) as {
    data: { execution: { applied: boolean; entityId: string } };
  };
  expect(body.data.execution.applied).toBe(true);
  return body.data.execution.entityId;
}

async function runHeartbeat(request: APIRequestContext, companyId: string, agentId: string): Promise<string> {
  const response = await apiPost(request, "/heartbeats/run-agent", companyId, { agentId });
  const body = (await response.json()) as { data: { runId: string } };
  return body.data.runId;
}

async function waitForRun(request: APIRequestContext, companyId: string, runId: string): Promise<void> {
  await expect
    .poll(async () => {
      const response = await request.get(`${apiUrl}/observability/heartbeats`, {
        headers: { "x-company-id": companyId }
      });
      if (!response.ok()) {
        return "";
      }
      const body = (await response.json()) as { data: Array<{ id: string }> };
      return body.data.some((row) => row.id === runId) ? "found" : "";
    })
    .toBe("found");
}

async function addIssueComment(request: APIRequestContext, companyId: string, issueId: string, body: string) {
  await apiPost(request, `/issues/${issueId}/comments`, companyId, { body, authorType: "human" });
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
