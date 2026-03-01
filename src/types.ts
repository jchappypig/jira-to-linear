// ============================================================
// JIRA TYPES (Jira REST API v3 response shapes)
// ============================================================

export interface AdfNode {
  type: string;
  version?: number;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
}

export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory: {
    key: string;
  };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: "active" | "closed" | "future";
  startDate?: string;
  endDate?: string;
}

export interface JiraIssueLink {
  id: string;
  type: { name: string; inward: string; outward: string };
  inwardIssue?: { id: string; key: string };
  outwardIssue?: { id: string; key: string };
}

export interface JiraIssueFields {
  summary: string;
  description: AdfNode | null;
  issuetype: JiraIssueType;
  status: JiraStatus;
  assignee: JiraUser | null;
  reporter: JiraUser | null;
  priority: { name: string } | null;
  project: JiraProject;
  parent?: {
    id: string;
    key: string;
    fields: { summary: string; issuetype: JiraIssueType };
  };
  epic?: { id: string; key: string; summary?: string };
  comment?: {
    total: number;
    comments: Array<{
      id: string;
      author: JiraUser;
      body: AdfNode | null;
      created: string;
    }>;
  };
  issuelinks?: JiraIssueLink[];
  customfield_10001?: { name: string } | null; // Team field
  customfield_10014?: string | null; // Epic Link (classic Jira Software)
  customfield_10016?: number | null; // Story Points (legacy)
  customfield_10028?: number | null; // Story Points (next-gen)
  customfield_15000?: JiraUser[] | null; // Reviewer
  customfield_10020?: JiraSprint[] | null; // Sprint
  customfield_10021?: Array<{ value: string }> | null; // Flagged (Impediment)
  labels?: string[];
  created: string;
  updated: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraSearchResponse {
  total: number;
  startAt: number;
  maxResults: number;
  issues: JiraIssue[];
}

// ============================================================
// CONFIG TYPES
// ============================================================

export interface IssueTypeConfig {
  linearLabel: string;
  labelColor: string;
}

export interface AppConfig {
  jql?: string;
  teamMapping: Record<string, string>;
  teamExtraLabels?: Record<string, string[]>; // jiraTeamName → workspace label names to always add
  issueTypeMapping: Record<string, IssueTypeConfig>;
  stateMigration?: Record<string, string>;
  defaultTeamId?: string;
  defaultTeamName?: string;
  batchSize?: number;
  rateLimitDelayMs?: number;
}

// ============================================================
// MIGRATION STATE
// ============================================================

export interface MigrationState {
  jiraKeyToLinearId: Record<string, string>;
  jiraKeyToLinearIdentifier: Record<string, string>;
  failed: Record<string, string>;
  lastRunAt?: string;
}

// ============================================================
// MAPPED TYPES (intermediate representation)
// ============================================================

export interface MappedIssue {
  jiraKey: string;
  jiraId: string;
  jiraUrl: string;
  title: string;
  description: string;
  teamId: string;
  labelIds: string[];
  assigneeId?: string;
  subscriberIds: string[];
  cycleId?: string;
  sprintState?: "active" | "future" | "closed";
  isBlocked?: boolean;
  estimate?: number;
  priority: 0 | 1 | 2 | 3 | 4;
  parentJiraKey?: string;
  stateId?: string;
  isEpic: boolean;
  reporterName: string;
  reporterEmail?: string;
  jiraStatusName: string;
  skipMigration?: boolean;
}

// ============================================================
// CLI OPTIONS
// ============================================================

export interface CliOptions {
  jql?: string;
  expand?: string;
  dryRun: boolean;
  configPath: string;
  statePath: string;
  verbose: boolean;
}

export interface BackfillOptions {
  teamName: string;
  configPath: string;
  statePath: string;
  dryRun: boolean;
  verbose: boolean;
}

export interface BackfillAttachmentsOptions {
  configPath: string;
  statePath: string;
  jiraKeys?: string[];  // if set, only backfill these keys; otherwise all in state
  dryRun: boolean;
  verbose: boolean;
}
