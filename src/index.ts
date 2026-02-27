#!/usr/bin/env node

import "dotenv/config";
import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { AppConfig, CliOptions, MigrationState } from "./types";
import { JiraClient } from "./jira";
import { LinearMigrationClient } from "./linear";
import { IssueMapper, sortIssuesByHierarchy } from "./mapper";

// ── Config / state helpers ─────────────────────────────────────────────────

function loadConfig(configPath: string): AppConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}\nCopy config.example.json to config.json and fill in your mappings.`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf-8")) as AppConfig;
}

function loadState(statePath: string): MigrationState {
  const resolved = path.resolve(statePath);
  if (fs.existsSync(resolved)) {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as MigrationState;
  }
  return { jiraKeyToLinearId: {}, jiraKeyToLinearIdentifier: {}, failed: {} };
}

function saveState(statePath: string, state: MigrationState): void {
  fs.writeFileSync(path.resolve(statePath), JSON.stringify(state, null, 2), "utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Migration orchestrator ─────────────────────────────────────────────────

async function runMigration(opts: CliOptions): Promise<void> {
  const config = loadConfig(opts.configPath);
  const state = loadState(opts.statePath);
  const jql = opts.jql ?? config.jql;

  if (!jql) {
    throw new Error("JQL query is required. Provide it via --jql or set jql in config.json.");
  }

  // Validate required environment variables
  const jiraBaseUrl = process.env.JIRA_BASE_URL;
  const jiraEmail = process.env.JIRA_EMAIL;
  const jiraToken = process.env.JIRA_API_TOKEN;
  const linearKey = process.env.LINEAR_API_KEY;

  if (!jiraBaseUrl || !jiraEmail || !jiraToken || !linearKey) {
    throw new Error(
      "Missing env vars. Ensure JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, and LINEAR_API_KEY are set in your .env file."
    );
  }

  const jiraClient = new JiraClient(jiraBaseUrl, jiraEmail, jiraToken);
  const linearClient = new LinearMigrationClient(linearKey);

  // Validate Linear credentials
  const viewer = await linearClient.getViewer();
  console.log(`Connected to Linear as: ${viewer.name} (${viewer.email})`);

  // Pre-load Linear reference data
  console.log("Loading Linear workspace data...");
  await linearClient.loadTeams();
  await linearClient.loadUsers();

  // Fetch matching Jira issues
  console.log(`Fetching Jira issues with JQL: ${jql}`);
  const jiraIssues = await jiraClient.fetchIssues(jql);
  console.log(`Found ${jiraIssues.length} Jira issues`);

  if (jiraIssues.length === 0) {
    console.log("No issues to migrate.");
    return;
  }

  // Sort so parents (epics) come before children
  const sorted = sortIssuesByHierarchy(jiraIssues);

  // Collect all target Linear team IDs for label/state pre-loading
  const teamIds = new Set<string>();
  for (const issue of sorted) {
    const teamId = linearClient.resolveTeamId(issue.fields.project.name, config.teamMapping);
    if (teamId) teamIds.add(teamId);
  }

  if (teamIds.size === 0) {
    throw new Error(
      "Could not resolve any Jira projects to Linear teams. Check your teamMapping in config.json."
    );
  }

  await linearClient.loadLabels([...teamIds]);
  await linearClient.loadWorkflowStates([...teamIds]);

  const mapper = new IssueMapper(config, linearClient, jiraBaseUrl);
  const rateLimitMs = config.rateLimitDelayMs ?? 500;
  const batchSize = config.batchSize ?? 10;

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  // ── Main migration loop ──────────────────────────────────────────────────

  for (const jiraIssue of sorted) {
    const { key } = jiraIssue;

    // Skip already-migrated issues
    if (state.jiraKeyToLinearId[key]) {
      if (opts.verbose) console.log(`SKIP (already migrated): ${key}`);
      skipped++;
      continue;
    }

    // Resolve team
    const teamId = linearClient.resolveTeamId(
      jiraIssue.fields.project.name,
      config.teamMapping
    );

    if (!teamId) {
      const msg = `No Linear team mapping for Jira project "${jiraIssue.fields.project.name}"`;
      console.warn(`WARN: ${msg} — skipping ${key}`);
      state.failed[key] = msg;
      saveState(opts.statePath, state);
      failed++;
      continue;
    }

    try {
      const mapped = await mapper.mapIssue(jiraIssue, teamId);

      // Look up the Linear ID of the parent (must have been migrated already due to sort order)
      let parentId: string | undefined;
      if (mapped.parentJiraKey) {
        parentId = state.jiraKeyToLinearId[mapped.parentJiraKey];
        if (!parentId && opts.verbose) {
          console.warn(
            `WARN: Parent ${mapped.parentJiraKey} not yet migrated — ${key} will be created without a parent.`
          );
        }
      }

      const stateId = linearClient.resolveStateId(
        mapped.jiraStatusName,
        teamId,
        config.stateMigration
      );

      if (opts.dryRun) {
        console.log(`[DRY RUN] ${key} → "${mapped.title}"`);
        if (opts.verbose) {
          console.log(`  Team: ${teamId}`);
          console.log(`  Labels: ${mapped.labelIds.join(", ") || "(none)"}`);
          console.log(`  Parent: ${parentId ?? "(none)"}`);
          console.log(`  Assignee: ${mapped.assigneeId ?? "(unresolved)"}`);
          console.log(`  Priority: ${mapped.priority}`);
        }
        continue;
      }

      // Create the Linear issue
      const created = await linearClient.createIssue({
        title: mapped.title,
        description: mapped.description || undefined,
        teamId: mapped.teamId,
        labelIds: mapped.labelIds.length ? mapped.labelIds : undefined,
        assigneeId: mapped.assigneeId,
        parentId,
        priority: mapped.priority,
        stateId,
      });

      console.log(`CREATED: ${key} → ${created.identifier} ${created.url}`);
      await sleep(rateLimitMs);

      // Add comment linking back to the original Jira ticket
      const reporterInfo = mapped.reporterEmail
        ? `${mapped.reporterName} (${mapped.reporterEmail})`
        : mapped.reporterName;

      const commentBody = [
        `**Migrated from Jira:** [${key}](${mapped.jiraUrl})`,
        `**Reporter in Jira:** ${reporterInfo}`,
        `**Jira status at migration:** ${mapped.jiraStatusName}`,
        `**Migrated on:** ${new Date().toISOString().split("T")[0]}`,
      ].join("\n");

      await linearClient.createComment(created.id, commentBody);
      await sleep(rateLimitMs);

      // Persist the mapping so child issues and re-runs can reference it
      state.jiraKeyToLinearId[key] = created.id;
      state.jiraKeyToLinearIdentifier[key] = created.identifier;
      delete state.failed[key];
      saveState(opts.statePath, state);

      migrated++;

      // Brief extra pause between batches
      if (migrated % batchSize === 0) {
        console.log(`Processed ${migrated} issues. Pausing...`);
        await sleep(rateLimitMs * 3);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ERROR: ${key}: ${msg}`);
      state.failed[key] = msg;
      saveState(opts.statePath, state);
      failed++;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  state.lastRunAt = new Date().toISOString();
  saveState(opts.statePath, state);

  console.log("\n=== Migration complete ===");
  console.log(`  Migrated : ${migrated}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);

  if (failed > 0) {
    console.log("\nFailed issues (also recorded in state file):");
    for (const [k, reason] of Object.entries(state.failed)) {
      console.log(`  ${k}: ${reason}`);
    }
  }
}

// ── CLI definition ─────────────────────────────────────────────────────────

program
  .name("jira-to-linear")
  .description("Migrate Jira Cloud issues to Linear")
  .version("1.0.0")
  .option("-j, --jql <query>", "JQL query to select Jira issues (overrides config.jql)")
  .option("-d, --dry-run", "Preview migration without creating any Linear issues", false)
  .option("-c, --config <path>", "Path to config.json", "config.json")
  .option("-s, --state <path>", "Path to migration state file (for resume support)", "migration-state.json")
  .option("-v, --verbose", "Print detailed logs", false)
  .action(async (options: Record<string, unknown>) => {
    try {
      await runMigration({
        jql: options.jql as string | undefined,
        dryRun: options.dryRun as boolean,
        configPath: options.config as string,
        statePath: options.state as string,
        verbose: options.verbose as boolean,
      });
    } catch (err) {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
