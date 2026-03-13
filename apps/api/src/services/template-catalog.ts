import {
  TemplateManifestSchema,
  TemplateVariableSchema,
  type TemplateManifest,
  type TemplateVariable
} from "bopodev-contracts";
import type { BopoDb } from "bopodev-db";
import {
  createTemplate,
  createTemplateVersion,
  getTemplateBySlug,
  getTemplateVersionByVersion
} from "bopodev-db";

type BuiltinTemplateDefinition = {
  slug: string;
  name: string;
  description: string;
  version: string;
  status: "published";
  visibility: "company";
  variables: TemplateVariable[];
  manifest: TemplateManifest;
};

const builtinTemplateDefinitions: BuiltinTemplateDefinition[] = [
  {
    slug: "founder-startup-basic",
    name: "Founder Startup Basic",
    description: "Baseline operating company for solo founders launching and shipping with AI agents.",
    version: "1.0.0",
    status: "published",
    visibility: "company",
    variables: [
      { key: "brandName", label: "Brand name", type: "string", required: true, options: [] },
      { key: "productName", label: "Product name", type: "string", required: true, options: [] },
      { key: "targetAudience", label: "Target audience", type: "string", required: true, options: [] }
    ],
    manifest: {
      company: {
        mission: "Build and grow {{productName}} for {{targetAudience}} under {{brandName}}.",
        settings: {}
      },
      projects: [
        {
          key: "leadership",
          name: "Leadership Operations",
          description: "Founder planning, weekly priorities, and coordination.",
          status: "active"
        },
        {
          key: "product",
          name: "Product Delivery",
          description: "Customer-facing product improvements and bug fixes.",
          status: "active"
        },
        {
          key: "growth",
          name: "Growth Engine",
          description: "Acquisition, activation, and retention loops.",
          status: "planned"
        }
      ],
      goals: [
        {
          key: "north-star",
          level: "company",
          title: "Reach repeatable weekly shipping cadence for {{productName}}."
        },
        {
          key: "first-demand",
          level: "project",
          projectKey: "growth",
          title: "Create first reliable demand loop for {{targetAudience}}."
        }
      ],
      agents: [
        {
          key: "founder-ceo",
          role: "CEO",
          name: "Founder CEO",
          providerType: "codex",
          heartbeatCron: "*/15 * * * *",
          monthlyBudgetUsd: 150,
          canHireAgents: true
        },
        {
          key: "founding-engineer",
          role: "Founding Engineer",
          name: "Founding Engineer",
          managerAgentKey: "founder-ceo",
          providerType: "codex",
          heartbeatCron: "*/15 * * * *",
          monthlyBudgetUsd: 300,
          canHireAgents: false
        },
        {
          key: "growth-operator",
          role: "Growth Operator",
          name: "Growth Operator",
          managerAgentKey: "founder-ceo",
          providerType: "codex",
          heartbeatCron: "*/30 * * * *",
          monthlyBudgetUsd: 200,
          canHireAgents: false
        }
      ],
      issues: [
        {
          title: "Define one-page strategy for {{productName}}",
          projectKey: "leadership",
          assigneeAgentKey: "founder-ceo",
          priority: "high",
          labels: ["planning", "strategy"],
          tags: []
        },
        {
          title: "Ship first high-impact product improvement",
          projectKey: "product",
          assigneeAgentKey: "founding-engineer",
          priority: "high",
          labels: ["shipping", "product"],
          tags: []
        },
        {
          title: "Set up weekly growth experiment backlog",
          projectKey: "growth",
          assigneeAgentKey: "growth-operator",
          priority: "medium",
          labels: ["growth", "experiments"],
          tags: []
        }
      ],
      plugins: [],
      recurrence: [
        {
          id: "weekly-planning",
          cron: "0 8 * * 1",
          targetType: "agent",
          targetKey: "founder-ceo",
          instruction: "Run weekly planning and reprioritize projects/issues."
        }
      ]
    }
  },
  {
    slug: "marketing-content-engine",
    name: "Marketing Content Engine",
    description: "Content marketing operating template for publishing, distribution, and analytics loops.",
    version: "1.0.0",
    status: "published",
    visibility: "company",
    variables: [
      { key: "brandName", label: "Brand name", type: "string", required: true, options: [] },
      {
        key: "primaryChannel",
        label: "Primary channel",
        type: "string",
        required: true,
        defaultValue: "LinkedIn",
        options: []
      },
      { key: "targetAudience", label: "Target audience", type: "string", required: true, options: [] }
    ],
    manifest: {
      company: {
        mission: "Grow awareness and inbound pipeline for {{brandName}} among {{targetAudience}}.",
        settings: {}
      },
      projects: [
        {
          key: "content-strategy",
          name: "Content Strategy",
          description: "Editorial planning and topic architecture.",
          status: "active"
        },
        {
          key: "content-production",
          name: "Content Production",
          description: "Writing, design support, and publishing.",
          status: "active"
        },
        {
          key: "distribution",
          name: "Distribution and Repurposing",
          description: "Cross-channel distribution and repurposing loops.",
          status: "active"
        }
      ],
      goals: [
        {
          key: "weekly-output",
          level: "company",
          title: "Publish and distribute consistent weekly content for {{targetAudience}}."
        }
      ],
      agents: [
        {
          key: "head-of-marketing",
          role: "Head of Marketing",
          name: "Head of Marketing",
          providerType: "codex",
          heartbeatCron: "*/20 * * * *",
          monthlyBudgetUsd: 250,
          canHireAgents: true
        },
        {
          key: "content-strategist",
          role: "Content Strategist",
          name: "Content Strategist",
          managerAgentKey: "head-of-marketing",
          providerType: "codex",
          heartbeatCron: "*/30 * * * *",
          monthlyBudgetUsd: 180,
          canHireAgents: false
        },
        {
          key: "content-writer",
          role: "Content Writer",
          name: "Content Writer",
          managerAgentKey: "head-of-marketing",
          providerType: "codex",
          heartbeatCron: "*/30 * * * *",
          monthlyBudgetUsd: 220,
          canHireAgents: false
        },
        {
          key: "distribution-manager",
          role: "Distribution Manager",
          name: "Distribution Manager",
          managerAgentKey: "head-of-marketing",
          providerType: "codex",
          heartbeatCron: "*/30 * * * *",
          monthlyBudgetUsd: 180,
          canHireAgents: false
        }
      ],
      issues: [
        {
          title: "Build 4-week editorial calendar for {{targetAudience}}",
          projectKey: "content-strategy",
          assigneeAgentKey: "content-strategist",
          priority: "high",
          labels: ["marketing", "editorial"],
          tags: []
        },
        {
          title: "Draft this week's flagship post for {{primaryChannel}}",
          projectKey: "content-production",
          assigneeAgentKey: "content-writer",
          priority: "high",
          labels: ["marketing", "writing"],
          tags: []
        },
        {
          title: "Repurpose flagship post into 3 distribution assets",
          projectKey: "distribution",
          assigneeAgentKey: "distribution-manager",
          priority: "medium",
          labels: ["marketing", "distribution"],
          tags: []
        }
      ],
      plugins: [],
      recurrence: [
        {
          id: "weekly-content-plan",
          cron: "0 9 * * 1",
          targetType: "agent",
          targetKey: "content-strategist",
          instruction: "Produce weekly content plan and queue production issues."
        },
        {
          id: "weekly-performance-review",
          cron: "0 16 * * 5",
          targetType: "agent",
          targetKey: "head-of-marketing",
          instruction: "Review weekly distribution performance and update next week priorities."
        }
      ]
    }
  }
];

export async function ensureBuiltinTemplatesRegistered(db: BopoDb, companyIds: string[] = []) {
  for (const companyId of companyIds) {
    await ensureCompanyBuiltinTemplateDefaults(db, companyId);
  }
}

export async function ensureCompanyBuiltinTemplateDefaults(db: BopoDb, companyId: string) {
  for (const definition of builtinTemplateDefinitions) {
    const variables = definition.variables.map((entry) => TemplateVariableSchema.parse(entry));
    const manifest = TemplateManifestSchema.parse(definition.manifest);
    let template = await getTemplateBySlug(db, companyId, definition.slug);
    if (!template) {
      template = await createTemplate(db, {
        companyId,
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        currentVersion: definition.version,
        status: definition.status,
        visibility: definition.visibility,
        variablesJson: JSON.stringify(variables)
      });
    }
    if (!template) {
      continue;
    }
    const version = await getTemplateVersionByVersion(db, {
      companyId,
      templateId: template.id,
      version: definition.version
    });
    if (!version) {
      await createTemplateVersion(db, {
        companyId,
        templateId: template.id,
        version: definition.version,
        manifestJson: JSON.stringify(manifest)
      });
    }
  }
}
