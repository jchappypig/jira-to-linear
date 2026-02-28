"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinearMigrationClient = void 0;
const sdk_1 = require("@linear/sdk");
class LinearMigrationClient {
    client;
    // Caches to avoid redundant API calls
    teams = new Map(); // key: lowercased name
    labels = new Map(); // key: "teamId:lowercasedName" or "ws:name"
    users = new Map(); // key: lowercased email
    states = new Map(); // key: "teamId:lowercasedName"
    cycles = new Map(); // key: "teamId:cycleName" → cycleId
    constructor(apiKey) {
        this.client = new sdk_1.LinearClient({ apiKey });
    }
    /** Validate credentials and return the authenticated user's info */
    async getViewer() {
        const viewer = await this.client.viewer;
        return { id: viewer.id, name: viewer.displayName, email: viewer.email };
    }
    /** Load all workspace teams into cache */
    async loadTeams() {
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
    resolveTeamId(jiraProjectName, teamMapping) {
        const linearName = teamMapping[jiraProjectName] ?? jiraProjectName;
        return this.teams.get(linearName.toLowerCase())?.id;
    }
    /** Load all workspace labels and team-specific labels into cache */
    async loadLabels(teamIds) {
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
    async resolveOrCreateLabel(name, color, teamId) {
        const teamKey = `${teamId}:${name.toLowerCase()}`;
        const wsKey = `ws:${name.toLowerCase()}`;
        const existing = this.labels.get(teamKey);
        if (existing)
            return existing.id;
        const payload = await this.client.createIssueLabel({ name, color, teamId });
        if (!payload.success || !payload.issueLabel) {
            throw new Error(`Failed to create label "${name}"`);
        }
        const newLabel = await payload.issueLabel;
        this.labels.set(teamKey, { id: newLabel.id, name: newLabel.name, color: newLabel.color });
        return newLabel.id;
    }
    /** Load all workspace users into cache keyed by email */
    async loadUsers() {
        let after;
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
    resolveUserByEmail(email) {
        return this.users.get(email.toLowerCase())?.id;
    }
    /** Load workflow states for the given teams into cache */
    async loadWorkflowStates(teamIds) {
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
    resolveStateId(jiraStatusName, teamId, stateMigration) {
        const linearName = stateMigration?.[jiraStatusName] ?? jiraStatusName;
        return this.states.get(`${teamId}:${linearName.toLowerCase()}`)?.id;
    }
    /** Normalize a Jira sprint name to "FYXXSXX" format. Returns undefined if unrecognized. */
    static normalizeCycleName(sprintName) {
        const match = sprintName.match(/FY(\d{2})\s*[Ss](?:print\s*)?(\d+(?:-\d+)?)/i);
        if (!match) return undefined;
        return `FY${match[1]}S${match[2]}`;
    }
    /** Find or create a Linear cycle on the given team, using normalized sprint name. */
    async resolveOrCreateCycle(teamId, sprintName, startDate, endDate) {
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
    async createIssue(input) {
        const payload = await this.client.createIssue(input);
        if (!payload.success) {
            throw new Error(`Linear createIssue failed for: "${input.title}"`);
        }
        const issue = await payload.issue;
        if (!issue)
            throw new Error("createIssue returned null issue");
        return {
            id: issue.id,
            identifier: issue.identifier,
            url: issue.url,
        };
    }
    /** Add a markdown comment to a Linear issue */
    async createComment(issueId, body) {
        const payload = await this.client.createComment({ issueId, body });
        if (!payload.success) {
            throw new Error(`Failed to add comment to issue ${issueId}`);
        }
    }
}
exports.LinearMigrationClient = LinearMigrationClient;
