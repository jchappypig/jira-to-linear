"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JiraClient = void 0;
const axios_1 = __importDefault(require("axios"));
const JIRA_FIELDS = [
    "summary",
    "description",
    "issuetype",
    "status",
    "assignee",
    "reporter",
    "priority",
    "project",
    "parent",
    "epic",
    "comment",
    "issuelinks",
    "customfield_10001", // Team field
    "customfield_10014", // Epic Link (classic Jira Software)
    "customfield_10016", // Story Points
    "customfield_15000", // Reviewer
    "labels",
    "created",
    "updated",
];
class JiraClient {
    baseUrl;
    http;
    constructor(baseUrl, email, apiToken) {
        this.baseUrl = baseUrl;
        const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
        this.http = axios_1.default.create({
            baseURL: `${baseUrl.replace(/\/$/, "")}/rest/api/3`,
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            timeout: 30_000,
        });
    }
    /**
     * Fetch all issues matching a JQL query via cursor-based pagination.
     * Uses the /search/jql endpoint which replaced /issue/search.
     */
    async fetchIssues(jql) {
        const PAGE_SIZE = 100;
        const allIssues = [];
        let nextPageToken;
        while (true) {
            const params = {
                jql,
                maxResults: PAGE_SIZE,
                fields: JIRA_FIELDS.join(","),
            };
            if (nextPageToken)
                params.nextPageToken = nextPageToken;
            const response = await this.http.get("/search/jql", { params });
            const { issues, isLast, nextPageToken: token } = response.data;
            allIssues.push(...issues);
            if (isLast || !token)
                break;
            nextPageToken = token;
        }
        return allIssues;
    }
    /** Fetch a single issue by key */
    async fetchIssueByKey(key) {
        const response = await this.http.get(`/issue/${key}`, {
            params: { fields: JIRA_FIELDS.join(",") },
        });
        return response.data;
    }
    /**
     * Recursively discover all related issues from a seed issue key using BFS.
     * Follows parent/child relationships, Epic Links, and same-project issuelinks.
     * Uses a visited set to prevent cycles/deadlocks.
     */
    async expandIssueGraph(seedKey, verbose) {
        const projectKey = seedKey.split("-")[0];
        const visited = new Set();
        const queue = [seedKey];
        const collected = [];
        while (queue.length > 0) {
            const key = queue.shift();
            if (visited.has(key))
                continue;
            visited.add(key);
            if (verbose)
                console.log(`  [expand] Fetching ${key}...`);
            let issue;
            try {
                issue = await this.fetchIssueByKey(key);
            }
            catch (err) {
                console.warn(`  [expand] Could not fetch ${key}: ${err instanceof Error ? err.message : err}`);
                continue;
            }
            collected.push(issue);
            // Follow parent upward (same project only)
            const parentKey = issue.fields.parent?.key;
            if (parentKey && parentKey.startsWith(`${projectKey}-`) && !visited.has(parentKey))
                queue.push(parentKey);
            // Follow Epic Link upward (same project only)
            const epicLink = issue.fields.customfield_10014;
            if (epicLink && epicLink.startsWith(`${projectKey}-`) && !visited.has(epicLink))
                queue.push(epicLink);
            // Find children via parent = KEY
            const childrenByParent = await this.fetchIssues(`parent = ${key} ORDER BY created ASC`);
            for (const child of childrenByParent) {
                if (!visited.has(child.key))
                    queue.push(child.key);
            }
            // Find children via Epic Link = KEY
            const epicChildren = await this.fetchIssues(`"Epic Link" = ${key} ORDER BY created ASC`);
            for (const child of epicChildren) {
                if (!visited.has(child.key))
                    queue.push(child.key);
            }
            // Follow issuelinks within the same project only
            for (const link of issue.fields.issuelinks ?? []) {
                const linkedKey = link.outwardIssue?.key ?? link.inwardIssue?.key;
                if (linkedKey && linkedKey.startsWith(`${projectKey}-`) && !visited.has(linkedKey))
                    queue.push(linkedKey);
            }
        }
        return collected;
    }
    /** Build the Jira browse URL for a given issue key */
    getIssueUrl(issueKey) {
        return `${this.baseUrl.replace(/\/$/, "")}/browse/${issueKey}`;
    }
}
exports.JiraClient = JiraClient;
