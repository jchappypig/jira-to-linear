import axios, { AxiosInstance } from "axios";
import { JiraIssue, JiraSearchResponse } from "./types";

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
  "customfield_10014", // Epic Link (classic Jira Software)
  "customfield_10016", // Story Points
  "labels",
  "created",
  "updated",
];

export class JiraClient {
  private readonly http: AxiosInstance;

  constructor(
    private readonly baseUrl: string,
    email: string,
    apiToken: string
  ) {
    const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
    this.http = axios.create({
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
   * Fetch all issues matching a JQL query via offset-based pagination.
   * Uses POST to handle long JQL strings that would exceed GET URL limits.
   */
  async fetchIssues(jql: string): Promise<JiraIssue[]> {
    const PAGE_SIZE = 100;
    const allIssues: JiraIssue[] = [];
    let startAt = 0;
    let total = Infinity;

    while (startAt < total) {
      const response = await this.http.post<JiraSearchResponse>(
        "/issue/search",
        {
          jql,
          startAt,
          maxResults: PAGE_SIZE,
          fields: JIRA_FIELDS,
        }
      );

      const { issues, total: responseTotal } = response.data;
      total = responseTotal;
      allIssues.push(...issues);
      startAt += issues.length;

      if (issues.length < PAGE_SIZE) break;
    }

    return allIssues;
  }

  /** Build the Jira browse URL for a given issue key */
  getIssueUrl(issueKey: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/browse/${issueKey}`;
  }
}
