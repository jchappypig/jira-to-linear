import { LinearClient } from "@linear/sdk";

export interface LinearTeamInfo {
  id: string;
  name: string;
  key: string;
}

export interface LinearLabelInfo {
  id: string;
  name: string;
  color: string;
}

export interface LinearUserInfo {
  id: string;
  name: string;
  email: string;
}

export interface LinearStateInfo {
  id: string;
  name: string;
  type: string;
  teamId: string;
}

export interface CreatedIssue {
  id: string;
  identifier: string;
  url: string;
}

export class LinearMigrationClient {
  private readonly client: LinearClient;

  // Caches to avoid redundant API calls
  private teams = new Map<string, LinearTeamInfo>();          // key: lowercased name
  private labels = new Map<string, LinearLabelInfo>();        // key: "teamId:lowercasedName" or "ws:name"
  private users = new Map<string, LinearUserInfo>();          // key: lowercased email
  private states = new Map<string, LinearStateInfo>();        // key: "teamId:lowercasedName"
  private cycles = new Map<string, string>();                 // key: "teamId:cycleName" → cycleId

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  /** Validate credentials and return the authenticated user's info */
  async getViewer(): Promise<{ id: string; name: string; email: string }> {
    const viewer = await this.client.viewer;
    return { id: viewer.id, name: viewer.displayName, email: viewer.email };
  }

  /** Load all workspace teams into cache */
  async loadTeams(): Promise<void> {
    const result = await this.client.teams({ first: 250 });
    for (const team of result.nodes) {
      this.teams.set(team.name.toLowerCase(), {
        id: team.id,
        name: team.name,
        key: team.key,
      });
    }
  }

  /**
   * Resolve a Jira project/team name to a Linear team ID.
   * Checks teamMapping config first, then falls back to direct name match.
   */
  resolveTeamId(
    jiraProjectName: string,
    teamMapping: Record<string, string>
  ): string | undefined {
    const linearName = teamMapping[jiraProjectName] ?? jiraProjectName;
    return this.teams.get(linearName.toLowerCase())?.id;
  }

  /** Load all workspace labels and team-specific labels into cache */
  async loadLabels(teamIds: string[]): Promise<void> {
    // Workspace-level labels
    const wsLabels = await this.client.issueLabels({ first: 250 });
    for (const label of wsLabels.nodes) {
      this.labels.set(`ws:${label.name.toLowerCase()}`, {
        id: label.id,
        name: label.name,
        color: label.color,
      });
    }

    // Team-specific labels
    for (const teamId of teamIds) {
      const team = await this.client.team(teamId);
      const teamLabels = await team.labels({ first: 250 });
      for (const label of teamLabels.nodes) {
        this.labels.set(`${teamId}:${label.name.toLowerCase()}`, {
          id: label.id,
          name: label.name,
          color: label.color,
        });
      }
    }
  }

  /**
   * Find or create a label by name for a given team.
   * Checks team-specific cache first, then workspace cache, then creates new.
   */
  async resolveOrCreateLabel(
    name: string,
    color: string,
    teamId: string
  ): Promise<string> {
    const teamKey = `${teamId}:${name.toLowerCase()}`;
    const wsKey = `ws:${name.toLowerCase()}`;

    const existing = this.labels.get(teamKey);
    if (existing) return existing.id;

    const payload = await this.client.createIssueLabel({ name, color, teamId });
    if (!payload.success || !payload.issueLabel) {
      throw new Error(`Failed to create label "${name}"`);
    }

    const newLabel = await payload.issueLabel;
    this.labels.set(teamKey, { id: newLabel.id, name: newLabel.name, color: newLabel.color });
    return newLabel.id;
  }

  /** Load all workspace users into cache keyed by email */
  async loadUsers(): Promise<void> {
    let after: string | undefined;

    do {
      const page = await this.client.users({ first: 250, after });
      for (const user of page.nodes) {
        if (user.email) {
          this.users.set(user.email.toLowerCase(), {
            id: user.id,
            name: user.displayName,
            email: user.email,
          });
        }
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
    } while (after);
  }

  /** Look up a Linear user by email. Returns undefined if not found. */
  resolveUserByEmail(email: string): string | undefined {
    return this.users.get(email.toLowerCase())?.id;
  }

  /** Load workflow states for the given teams into cache */
  async loadWorkflowStates(teamIds: string[]): Promise<void> {
    for (const teamId of teamIds) {
      const team = await this.client.team(teamId);
      const states = await team.states({ first: 100 });
      for (const state of states.nodes) {
        this.states.set(`${teamId}:${state.name.toLowerCase()}`, {
          id: state.id,
          name: state.name,
          type: state.type,
          teamId,
        });
      }
    }
  }

  /**
   * Resolve a Jira status name to a Linear workflow state ID.
   * Uses the stateMigration config mapping, then falls back to direct name match.
   */
  resolveStateId(
    jiraStatusName: string,
    teamId: string,
    stateMigration?: Record<string, string>
  ): string | undefined {
    const linearName = stateMigration?.[jiraStatusName] ?? jiraStatusName;
    return this.states.get(`${teamId}:${linearName.toLowerCase()}`)?.id;
  }

  /**
   * Normalize a Jira sprint name to a compact "FYXXSXX" cycle name.
   * Examples:
   *   "Enable FY26 Sprint 17" → "FY26S17"
   *   "Convert FY26S17"       → "FY26S17"
   *   "Receeve FY26 S17"      → "FY26S17"
   *   "Scale FY26S13-15"      → "FY26S13-15"
   * Returns undefined if the name doesn't match the expected pattern.
   */
  static normalizeCycleName(sprintName: string): string | undefined {
    // Match FY + 2 digits + optional space + S + sprint number (may include range like 13-15)
    const match = sprintName.match(/FY(\d{2})\s*[Ss](?:print\s*)?(\d+(?:-\d+)?)/i);
    if (!match) return undefined;
    return `FY${match[1]}S${match[2]}`;
  }

  /**
   * Find or create a Linear cycle for a Jira sprint on the given team.
   * Sprint names are normalized to "FYXXSXX" format.
   * Cycles are scoped per team since Linear requires cycle and issue to be on the same team.
   */
  async resolveOrCreateCycle(
    teamId: string,
    sprintName: string,
    startDate: string,
    endDate: string
  ): Promise<string> {
    const cycleName = LinearMigrationClient.normalizeCycleName(sprintName);
    if (!cycleName) throw new Error(`Cannot normalize sprint name: "${sprintName}"`);

    const cacheKey = `${teamId}:${cycleName}`;
    const cached = this.cycles.get(cacheKey);
    if (cached) return cached;

    // Check existing cycles on this team
    const team = await this.client.team(teamId);
    const existing = await team.cycles({ first: 250 });
    for (const cycle of existing.nodes) {
      if (cycle.name?.toLowerCase() === cycleName.toLowerCase()) {
        this.cycles.set(cacheKey, cycle.id);
        return cycle.id;
      }
    }

    // Create a new cycle on this team
    const payload = await this.client.createCycle({
      teamId,
      name: cycleName,
      startsAt: new Date(startDate),
      endsAt: new Date(endDate),
    });
    if (!payload.success || !payload.cycle) {
      throw new Error(`Failed to create cycle "${cycleName}"`);
    }
    const cycle = await payload.cycle;
    this.cycles.set(cacheKey, cycle.id);
    return cycle.id;
  }

  /**
   * Create a Linear issue.
   *
   * Key IssueCreateInput fields used:
   *   title, teamId, description (markdown), assigneeId,
   *   labelIds, parentId, priority (0-4), stateId, cycleId
   */
  async createIssue(input: {
    title: string;
    teamId: string;
    description?: string;
    assigneeId?: string;
    subscriberIds?: string[];
    labelIds?: string[];
    parentId?: string;
    priority?: number;
    stateId?: string;
    cycleId?: string;
    estimate?: number;
  }): Promise<CreatedIssue> {
    const payload = await this.client.createIssue(input);

    if (!payload.success) {
      throw new Error(`Linear createIssue failed for: "${input.title}"`);
    }

    const issue = await payload.issue;
    if (!issue) throw new Error("createIssue returned null issue");

    return {
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
    };
  }

  /** Add a markdown comment to a Linear issue */
  async createComment(issueId: string, body: string): Promise<void> {
    const payload = await this.client.createComment({ issueId, body });
    if (!payload.success) {
      throw new Error(`Failed to add comment to issue ${issueId}`);
    }
  }
}
