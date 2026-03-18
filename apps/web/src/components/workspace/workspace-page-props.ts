import type {
  ApprovalRow,
  AgentRow,
  AuditRow,
  CompanyRow,
  CostRow,
  GoalRow,
  GovernanceInboxRow,
  AttentionRow,
  HeartbeatRunRow,
  IssueRow,
  PluginRow,
  ProjectRow,
  TemplateRow
} from "@/components/workspace/types";

export interface WorkspacePageProps {
  companyId: string | null;
  activeCompany: CompanyRow | null;
  companies: CompanyRow[];
  issues: IssueRow[];
  agents: AgentRow[];
  heartbeatRuns: HeartbeatRunRow[];
  goals: GoalRow[];
  approvals: ApprovalRow[];
  governanceInbox?: GovernanceInboxRow[];
  attentionItems?: AttentionRow[];
  auditEvents: AuditRow[];
  costEntries: CostRow[];
  projects: ProjectRow[];
  plugins?: PluginRow[];
  templates?: TemplateRow[];
}
