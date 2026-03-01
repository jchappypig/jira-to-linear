import { JiraIssue, MappedIssue, AppConfig } from "./types";
import { convertAdfToMarkdown } from "./adf-to-markdown";
import { LinearMigrationClient } from "./linear";

const PRIORITY_MAP: Record<string, 0 | 1 | 2 | 3 | 4> = {
  Blocker:  1, // Urgent
  Critical: 1,
  Highest:  1,
  High:     2,
  Medium:   3,
  Normal:   3,
  Low:      4,
  Lowest:   4,
};

export class IssueMapper {
  constructor(
    private readonly config: AppConfig,
    private readonly linearClient: LinearMigrationClient,
    private readonly jiraBaseUrl: string
  ) {}

  async mapIssue(jiraIssue: JiraIssue, teamId: string, allIssues: JiraIssue[] = []): Promise<MappedIssue> {
    const { fields, key, id } = jiraIssue;

    const description = convertAdfToMarkdown(fields.description);

    // Resolve assignee by email
    let assigneeId: string | undefined;
    if (fields.assignee?.emailAddress) {
      assigneeId = this.linearClient.resolveUserByEmail(fields.assignee.emailAddress);
    }

    // Resolve Jira reviewers (customfield_15000) → Linear subscriber IDs
    const subscriberIds: string[] = [];
    for (const reviewer of fields.customfield_15000 ?? []) {
      if (reviewer.emailAddress) {
        const userId = this.linearClient.resolveUserByEmail(reviewer.emailAddress);
        if (userId) subscriberIds.push(userId);
      }
    }

    // Resolve Jira sprint (customfield_10020) → Linear cycle ID
    // - Closed sprint + issue done → skip migration entirely
    // - Closed sprint + issue not done → active Linear cycle (carry forward)
    // - Active/future sprint → find/create matching Linear cycle;
    //   if that cycle is completed in Linear → fall back to active Linear cycle
    // - No sprint → no cycle
    // - Epic → derive cycle from child issues (most current active/future sprint)
    let cycleId: string | undefined;
    let sprintState: "active" | "future" | "closed" | undefined;
    const isDone = ["Done", "Closed", "Resolved", "Released"].includes(fields.status.name);

    if (fields.issuetype.name === "Epic") {
      cycleId = await this.resolveEpicCycleId(key, teamId, allIssues);
    } else {
      const sprints = fields.customfield_10020;
      if (sprints && sprints.length > 0) {
        const sprint = sprints[sprints.length - 1];
        sprintState = sprint.state;
        if (sprint.state === "closed") {
          if (isDone) {
            return { ...({} as MappedIssue), skipMigration: true };
          }
          // Not done in a closed sprint — carry forward to active cycle
          cycleId = await this.linearClient.getActiveCycleId(teamId)
            ?? await this.linearClient.getNextCycleId(teamId);
        } else if (sprint.startDate && sprint.endDate) {
          // Active or future sprint with dates — find/create matching cycle
          try {
            cycleId = await this.linearClient.resolveOrCreateCycle(
              teamId, sprint.name, sprint.startDate, sprint.endDate
            );
          } catch (err) {
            console.warn(`WARN: Sprint "${sprint.name}" cycle completed in Linear, moving to active cycle`);
            cycleId = await this.linearClient.getActiveCycleId(teamId)
              ?? await this.linearClient.getNextCycleId(teamId);
          }
        } else {
          // Active or future sprint but no dates in Jira — look up existing cycle by name in Linear
          cycleId = await this.linearClient.resolveCycleByName(teamId, sprint.name)
            ?? await this.linearClient.getNextCycleId(teamId);
        }
      }
    }

    const priority = PRIORITY_MAP[fields.priority?.name ?? ""] ?? 3;
    const typeName = fields.issuetype.name;

    // Resolve issue type → existing workspace label (never create)
    const labelIds: string[] = [];
    const typeConfig = this.config.issueTypeMapping[typeName];
    if (typeConfig) {
      const labelId = this.linearClient.resolveLabel(typeConfig.linearLabel);
      if (labelId) labelIds.push(labelId);
    }

    const parentJiraKey = resolveParentKey(jiraIssue);
    const jiraUrl = `${this.jiraBaseUrl.replace(/\/$/, "")}/browse/${key}`;

    // Story points: prefer next-gen field (10028), fall back to legacy (10016)
    // Linear requires integer estimates — round any fractional values
    const rawEstimate = fields.customfield_10028 ?? fields.customfield_10016 ?? undefined;
    const estimate = rawEstimate !== undefined ? Math.round(rawEstimate) : undefined;

    // Jira "Flagged" field (customfield_10021) with value "Impediment" → Blocked in Linear
    const isBlocked = fields.customfield_10021?.some((f) => f.value === "Impediment") ?? false;

    return {
      jiraKey: key,
      jiraId: id,
      jiraUrl,
      title: fields.summary,
      description,
      teamId,
      labelIds,
      assigneeId,
      subscriberIds,
      cycleId,
      sprintState,
      isBlocked,
      estimate,
      priority,
      parentJiraKey,
      isEpic: typeName === "Epic",
      reporterName: fields.reporter?.displayName ?? "Unknown",
      reporterEmail: fields.reporter?.emailAddress,
      jiraStatusName: fields.status.name,
    };
  }

  /**
   * Derive a cycle ID for an epic by inspecting the sprints of its child issues.
   *
   * Rules:
   * - Collect all sprints from direct children (issues whose parent/epicLink = epicKey)
   * - Keep only active or future sprints
   * - If none → no cycle (epic was worked but abandoned, or never started)
   * - If some → pick the most current: active sprint first, then nearest future by startDate
   */
  private async resolveEpicCycleId(
    epicKey: string,
    teamId: string,
    allIssues: JiraIssue[]
  ): Promise<string | undefined> {
    const children = allIssues.filter((i) => {
      if (i.key === epicKey) return false;
      return (
        i.fields.parent?.key === epicKey ||
        i.fields.customfield_10014 === epicKey ||
        i.fields.epic?.key === epicKey
      );
    });

    // Gather the last sprint from each child, keeping only active/future ones
    const relevantSprints = children
      .flatMap((child) => {
        const sprints = child.fields.customfield_10020;
        if (!sprints || sprints.length === 0) return [];
        return [sprints[sprints.length - 1]];
      })
      .filter((s) => s.state === "active" || s.state === "future");

    if (relevantSprints.length === 0) return undefined;

    // Prefer active sprint; among multiple futures pick the one starting soonest
    const active = relevantSprints.find((s) => s.state === "active");
    const chosen = active ?? relevantSprints.reduce((a, b) => {
      const aStart = a.startDate ? new Date(a.startDate).getTime() : Infinity;
      const bStart = b.startDate ? new Date(b.startDate).getTime() : Infinity;
      return aStart <= bStart ? a : b;
    });

    if (!chosen.startDate || !chosen.endDate) return undefined;

    try {
      return await this.linearClient.resolveOrCreateCycle(
        teamId, chosen.name, chosen.startDate, chosen.endDate
      );
    } catch {
      return await this.linearClient.getActiveCycleId(teamId)
        ?? await this.linearClient.getNextCycleId(teamId);
    }
  }
}

/**
 * Determine the parent Jira issue key for a given issue.
 *
 * Jira expresses hierarchy in three different ways depending on project type:
 * 1. `fields.parent` — sub-tasks and Next-gen child issues
 * 2. `fields.customfield_10014` — "Epic Link" in classic Jira Software
 * 3. `fields.epic` — legacy epic association
 *
 * Epics themselves have no parent in this migration model.
 */
export function resolveParentKey(issue: JiraIssue): string | undefined {
  const { fields } = issue;

  if (fields.issuetype.name === "Epic") return undefined;

  if (fields.parent?.key) return fields.parent.key;
  if (fields.customfield_10014) return fields.customfield_10014;
  if (fields.epic?.key) return fields.epic.key;

  return undefined;
}

/**
 * Sort issues so that parents always appear before their children.
 * Uses a topological sort; epics are seeded first for stable ordering.
 */
export function sortIssuesByHierarchy(issues: JiraIssue[]): JiraIssue[] {
  const issueMap = new Map<string, JiraIssue>(issues.map((i) => [i.key, i]));
  const sorted: JiraIssue[] = [];
  const visited = new Set<string>();

  function visit(issue: JiraIssue): void {
    if (visited.has(issue.key)) return;
    visited.add(issue.key);

    const parentKey = resolveParentKey(issue);
    if (parentKey && issueMap.has(parentKey)) {
      visit(issueMap.get(parentKey)!);
    }

    sorted.push(issue);
  }

  // Process epics first to guarantee root-level ordering
  const epics = issues.filter((i) => i.fields.issuetype.name === "Epic");
  const rest = issues.filter((i) => i.fields.issuetype.name !== "Epic");

  for (const epic of epics) visit(epic);
  for (const issue of rest) visit(issue);

  return sorted;
}
