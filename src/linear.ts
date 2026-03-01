import { LinearClient } from "@linear/sdk";

export interface LinearTeamInfo {
  id: string;
  name: string;
  key: string;
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

export interface LinearLabelInfo {
  id: string;
  name: string;
}

export class LinearMigrationClient {
  private readonly client: LinearClient;

  // Caches to avoid redundant API calls
  private teams = new Map<string, LinearTeamInfo>();          // key: lowercased name
  private labels = new Map<string, LinearLabelInfo>();        // key: lowercased name
  private users = new Map<string, LinearUserInfo>();          // key: lowercased email
  private states = new Map<string, LinearStateInfo>();        // key: "teamId:lowercasedName"
  private cycles = new Map<string, string>();                 // key: cycleName → cycleId (root team only)
  private rootTeamId: string | undefined;                     // Indebted-rd root team ID

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  /** Validate credentials and return the authenticated user's info */
  async getViewer(): Promise<{ id: string; name: string; email: string }> {
    const viewer = await this.client.viewer;
    return { id: viewer.id, name: viewer.displayName, email: viewer.email };
  }

  /** Load all workspace teams into cache and identify the root team (cycle owner) */
  async loadTeams(rootTeamName = "Indebted-rd"): Promise<void> {
    const result = await this.client.teams({ first: 250 });
    for (const team of result.nodes) {
      this.teams.set(team.name.toLowerCase(), {
        id: team.id,
        name: team.name,
        key: team.key,
      });
    }
    this.rootTeamId = this.teams.get(rootTeamName.toLowerCase())?.id;
    if (!this.rootTeamId) {
      console.warn(`WARN: Root team "${rootTeamName}" not found — cycle creation will be skipped.`);
    }
  }

  /** Load existing workspace-level labels into cache. Never creates labels. */
  async loadLabels(): Promise<void> {
    const result = await this.client.issueLabels({ first: 250 });
    for (const label of result.nodes) {
      const labelTeam = await label.team;
      if (!labelTeam) {
        this.labels.set(label.name.toLowerCase(), { id: label.id, name: label.name });
      }
    }
  }

  /** Look up a workspace label by name. Returns undefined if not found. */
  resolveLabel(name: string): string | undefined {
    return this.labels.get(name.toLowerCase())?.id;
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
   * Find or create a Linear cycle for a Jira sprint.
   * Cycles are created on the root team (Indebted-rd) and inherited by sub-teams.
   * Each sub-team has its own cycle ID for the inherited cycle, so we look up
   * the cycle ID from the sub-team by name after ensuring it exists on the root team.
   * Sprint names are normalized to "FYXXSXX" format.
   */
  /**
   * Find or create a Linear cycle for a Jira sprint.
   * Cycles are always created on the root team (Indebted-rd) and inherited by sub-teams.
   * Returns the sub-team's inherited cycle ID, or throws if the cycle is completed in Linear.
   */
  async resolveOrCreateCycle(
    teamId: string,
    sprintName: string,
    startDate: string,
    endDate: string
  ): Promise<string> {
    const cycleName = LinearMigrationClient.normalizeCycleName(sprintName);
    if (!cycleName) throw new Error(`Cannot normalize sprint name: "${sprintName}"`);
    if (!this.rootTeamId) throw new Error("Root team not loaded — call loadTeams() first.");

    const cacheKey = `${teamId}:${cycleName}`;
    const cached = this.cycles.get(cacheKey);
    if (cached) return cached;

    // Ensure the cycle exists on the root team (create if missing)
    const rootTeam = await this.client.team(this.rootTeamId);
    const rootCycles = await rootTeam.cycles({ first: 250 });
    const existsOnRoot = rootCycles.nodes.some(
      (c) => c.name?.toLowerCase() === cycleName.toLowerCase()
    );
    if (!existsOnRoot) {
      const payload = await this.client.createCycle({
        teamId: this.rootTeamId,
        name: cycleName,
        startsAt: new Date(startDate),
        endsAt: new Date(endDate),
      });
      if (!payload.success || !payload.cycle) {
        throw new Error(`Failed to create cycle "${cycleName}" on root team`);
      }
    }

    // Look up the inherited cycle ID from the sub-team (Linear uses different IDs per team)
    const subTeam = await this.client.team(teamId);
    const subCycles = await subTeam.cycles({ first: 250 });
    for (const cycle of subCycles.nodes) {
      if (cycle.name?.toLowerCase() !== cycleName.toLowerCase()) continue;
      if (cycle.completedAt) continue; // skip old completed duplicate with same name
      this.cycles.set(cacheKey, cycle.id);
      return cycle.id;
    }

    throw new Error(`Cycle "${cycleName}" is already completed in Linear`);
  }

  /** Return the active cycle ID for a team. Trusts Linear's own activeCycle field completely. */
  async getActiveCycleId(teamId: string): Promise<string | undefined> {
    const team = await this.client.team(teamId);
    const activeCycle = await team.activeCycle;
    return activeCycle?.id;
  }

  /** Return the next upcoming cycle ID (soonest future start), or undefined if none. */
  async getNextCycleId(teamId: string): Promise<string | undefined> {
    const team = await this.client.team(teamId);
    const cycles = await team.cycles({ first: 250 });
    const now = new Date();
    let next: { id: string; startsAt: Date } | undefined;
    for (const cycle of cycles.nodes) {
      if (!cycle.startsAt || !cycle.endsAt || cycle.completedAt) continue;
      const startsAt = new Date(cycle.startsAt);
      if (startsAt > now) {
        if (!next || startsAt < next.startsAt) next = { id: cycle.id, startsAt };
      }
    }
    return next?.id;
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

  /** Update a Linear issue (e.g. set assigneeId) */
  async updateIssue(id: string, input: { assigneeId?: string }): Promise<void> {
    await this.client.updateIssue(id, input);
  }

  /**
   * Fetch all issues for a Linear team, paginated.
   * Returns an array of { id, identifier, assigneeId } objects.
   */
  async getTeamIssues(teamId: string): Promise<Array<{ id: string; identifier: string; assigneeId: string | undefined }>> {
    const team = await this.client.team(teamId);
    const results: Array<{ id: string; identifier: string; assigneeId: string | undefined }> = [];
    let after: string | undefined;

    while (true) {
      const page = await team.issues({ first: 100, after });
      for (const issue of page.nodes) {
        const assignee = await issue.assignee;
        results.push({
          id: issue.id,
          identifier: issue.identifier,
          assigneeId: assignee?.id,
        });
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor ?? undefined;
    }

    return results;
  }
}
