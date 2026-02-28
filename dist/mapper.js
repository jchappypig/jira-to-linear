"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IssueMapper = void 0;
exports.sortIssuesByHierarchy = sortIssuesByHierarchy;
const adf_to_markdown_1 = require("./adf-to-markdown");
const PRIORITY_MAP = {
    Blocker: 1, // Urgent
    Critical: 1,
    Highest: 1,
    High: 2,
    Medium: 3,
    Normal: 3,
    Low: 4,
    Lowest: 4,
};
class IssueMapper {
    config;
    linearClient;
    jiraBaseUrl;
    constructor(config, linearClient, jiraBaseUrl) {
        this.config = config;
        this.linearClient = linearClient;
        this.jiraBaseUrl = jiraBaseUrl;
    }
    async mapIssue(jiraIssue, teamId) {
        const { fields, key, id } = jiraIssue;
        const description = (0, adf_to_markdown_1.convertAdfToMarkdown)(fields.description);
        // Resolve assignee by email
        let assigneeId;
        if (fields.assignee?.emailAddress) {
            assigneeId = this.linearClient.resolveUserByEmail(fields.assignee.emailAddress);
        }
        // Resolve Jira reviewers (customfield_15000) → Linear subscriber IDs
        const subscriberIds = [];
        for (const reviewer of fields.customfield_15000 ?? []) {
            if (reviewer.emailAddress) {
                const userId = this.linearClient.resolveUserByEmail(reviewer.emailAddress);
                if (userId) subscriberIds.push(userId);
            }
        }
        const priority = PRIORITY_MAP[fields.priority?.name ?? ""] ?? 3;
        // Resolve issue type → Linear label
        const labelIds = [];
        const typeName = fields.issuetype.name;
        const typeConfig = this.config.issueTypeMapping[typeName];
        if (typeConfig) {
            const labelId = await this.linearClient.resolveOrCreateLabel(typeConfig.linearLabel, typeConfig.labelColor, teamId);
            labelIds.push(labelId);
        }
        // Add a "Jira:PROJECT" label for traceability
        const projectLabelId = await this.linearClient.resolveOrCreateLabel(`Jira:${fields.project.key}`, "#6b7280", teamId);
        labelIds.push(projectLabelId);
        const parentJiraKey = resolveParentKey(jiraIssue);
        const jiraUrl = `${this.jiraBaseUrl.replace(/\/$/, "")}/browse/${key}`;
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
            priority,
            parentJiraKey,
            isEpic: typeName === "Epic",
            reporterName: fields.reporter?.displayName ?? "Unknown",
            reporterEmail: fields.reporter?.emailAddress,
            jiraStatusName: fields.status.name,
        };
    }
}
exports.IssueMapper = IssueMapper;
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
function resolveParentKey(issue) {
    const { fields } = issue;
    if (fields.issuetype.name === "Epic")
        return undefined;
    if (fields.parent?.key)
        return fields.parent.key;
    if (fields.customfield_10014)
        return fields.customfield_10014;
    if (fields.epic?.key)
        return fields.epic.key;
    return undefined;
}
/**
 * Sort issues so that parents always appear before their children.
 * Uses a topological sort; epics are seeded first for stable ordering.
 */
function sortIssuesByHierarchy(issues) {
    const issueMap = new Map(issues.map((i) => [i.key, i]));
    const sorted = [];
    const visited = new Set();
    function visit(issue) {
        if (visited.has(issue.key))
            return;
        visited.add(issue.key);
        const parentKey = resolveParentKey(issue);
        if (parentKey && issueMap.has(parentKey)) {
            visit(issueMap.get(parentKey));
        }
        sorted.push(issue);
    }
    // Process epics first to guarantee root-level ordering
    const epics = issues.filter((i) => i.fields.issuetype.name === "Epic");
    const rest = issues.filter((i) => i.fields.issuetype.name !== "Epic");
    for (const epic of epics)
        visit(epic);
    for (const issue of rest)
        visit(issue);
    return sorted;
}
