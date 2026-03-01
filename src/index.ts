#!/usr/bin/env node

import "dotenv/config";
import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { AppConfig, BackfillOptions, CliOptions, JiraIssue, MigrationState } from "./types";
import { convertAdfToMarkdown } from "./adf-to-markdown";
import { JiraClient } from "./jira";
import { LinearMigrationClient } from "./linear";
import { IssueMapper, resolveParentKey as resolveParentKeyFromIssue, sortIssuesByHierarchy } from "./mapper";

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

// ── Expand filter ─────────────────────────────────────────────────────────

/**
 * Filter issues discovered by --expand to only those worth migrating:
 *   - Active sprint, future sprint, or Backlog (no sprint + not done)
 *   - Not-done in a closed sprint (carry forward)
 *   - Epics: included if at least one child qualifies under the above rules
 *   - Excluded: done with no sprint, done in a closed sprint
 */
function filterIssuesForExpand(issues: JiraIssue[], verbose?: boolean): JiraIssue[] {
  const isDone = (issue: JiraIssue) =>
    ["Done", "Closed", "Resolved", "Released"].includes(issue.fields.status.name);

  // Returns true if a non-epic issue qualifies for migration
  function qualifies(issue: JiraIssue): boolean {
    const sprints = issue.fields.customfield_10020;
    const done = isDone(issue);

    if (!sprints || sprints.length === 0) {
      // Backlog: migrate only if not done
      return !done;
    }

    const sprint = sprints[sprints.length - 1];
    if (sprint.state === "active" || sprint.state === "future") return true;
    // Closed sprint: skip if done, carry forward if not done
    return !done;
  }

  // Build a set of keys that qualify (non-epics first)
  const qualifiedKeys = new Set(
    issues
      .filter((i) => i.fields.issuetype.name !== "Epic" && qualifies(i))
      .map((i) => i.key)
  );

  // Include epics whose at least one child (direct or via epicLink) qualifies
  const epicKeys = new Set(
    issues
      .filter((i) => i.fields.issuetype.name === "Epic")
      .map((i) => i.key)
  );

  for (const issue of issues) {
    if (issue.fields.issuetype.name === "Epic") continue;
    if (!qualifies(issue)) continue;
    // Check all parent/epic links
    const parentKey = issue.fields.parent?.key;
    const epicLink = issue.fields.customfield_10014;
    const epicField = issue.fields.epic?.key;
    for (const ancestor of [parentKey, epicLink, epicField]) {
      if (ancestor && epicKeys.has(ancestor)) qualifiedKeys.add(ancestor);
    }
  }

  const filtered = issues.filter((i) => qualifiedKeys.has(i.key));

  if (verbose) {
    const skipped = issues.filter((i) => !qualifiedKeys.has(i.key));
    for (const i of skipped) {
      const sprint = i.fields.customfield_10020;
      const sprintName = sprint?.length ? sprint[sprint.length - 1].name : "no sprint";
      console.log(`  [filter] SKIP ${i.key} (${i.fields.status.name}, ${sprintName})`);
    }
  }

  return filtered;
}

// ── Migration orchestrator ─────────────────────────────────────────────────

async function runMigration(opts: CliOptions): Promise<void> {
  const config = loadConfig(opts.configPath);
  const state = loadState(opts.statePath);

  if (!opts.expand && !opts.jql && !config.jql) {
    throw new Error("Provide --expand <issueKey>, --jql <query>, or set jql in config.json.");
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
  let jiraIssues;
  if (opts.expand) {
    const seedKey = opts.expand.toUpperCase().trim();
    console.log(`Expanding issue graph from seed: ${seedKey}`);
    jiraIssues = await jiraClient.expandIssueGraph(seedKey, opts.verbose);
    console.log(`Discovered ${jiraIssues.length} issues in the ${seedKey} graph`);
    jiraIssues = filterIssuesForExpand(jiraIssues, opts.verbose);
    console.log(`${jiraIssues.length} issues qualify after sprint filtering`);
  } else {
    const jql = opts.jql ?? config.jql!;
    console.log(`Fetching Jira issues with JQL: ${jql}`);
    jiraIssues = await jiraClient.fetchIssues(jql);
    console.log(`Found ${jiraIssues.length} Jira issues`);
  }

  if (jiraIssues.length === 0) {
    console.log("No issues to migrate.");
    return;
  }

  // Sort so parents (epics) come before children
  const sorted = sortIssuesByHierarchy(jiraIssues);

  // Collect all target Linear team IDs for state pre-loading
  const teamIds = new Set<string>();
  for (const issue of sorted) {
    const jiraTeamName =
      issue.fields.customfield_10001?.name ?? issue.fields.project.name;
    const teamId =
      linearClient.resolveTeamId(jiraTeamName, config.teamMapping) ??
      (config.defaultTeamName
        ? linearClient.resolveTeamId(config.defaultTeamName, {})
        : undefined);
    if (teamId) teamIds.add(teamId);
  }

  if (teamIds.size === 0) {
    throw new Error(
      "Could not resolve any Jira projects to Linear teams. Check your teamMapping in config.json."
    );
  }

  await linearClient.loadLabels();
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

    // Already migrated — sanity check parent linkage
    if (state.jiraKeyToLinearId[key]) {
      const linearId = state.jiraKeyToLinearId[key];
      const identifier = state.jiraKeyToLinearIdentifier[key];
      const parentJiraKey = resolveParentKeyFromIssue(jiraIssue);
      const expectedParentId = parentJiraKey ? state.jiraKeyToLinearId[parentJiraKey] : undefined;

      if (expectedParentId) {
        const actualParentId = await linearClient.getIssueParentId(linearId);
        if (actualParentId !== expectedParentId) {
          if (!opts.dryRun) {
            await linearClient.updateIssue(linearId, { parentId: expectedParentId });
            console.log(`FIXED parent: ${identifier} ← ${parentJiraKey}`);
          } else {
            console.log(`[DRY RUN] ${identifier}: would fix parent → ${parentJiraKey}`);
          }
        } else if (opts.verbose) {
          console.log(`OK (already migrated, parent correct): ${identifier}`);
        }
      } else if (opts.verbose) {
        console.log(`SKIP (already migrated): ${identifier}`);
      }

      skipped++;
      continue;
    }

    // Resolve team: use the Jira team field (customfield_10001) if present,
    // otherwise fall back to the project name, then defaultTeamName
    const jiraTeamName =
      jiraIssue.fields.customfield_10001?.name ??
      jiraIssue.fields.project.name;
    const teamId =
      linearClient.resolveTeamId(jiraTeamName, config.teamMapping) ??
      (config.defaultTeamName
        ? linearClient.resolveTeamId(config.defaultTeamName, {})
        : undefined);

    if (!teamId) {
      const msg = `No Linear team mapping for Jira team/project "${jiraTeamName}"`;
      console.warn(`WARN: ${msg} — skipping ${key}`);
      state.failed[key] = msg;
      saveState(opts.statePath, state);
      failed++;
      continue;
    }

    try {
      const mapped = await mapper.mapIssue(jiraIssue, teamId, sorted);

      if (mapped.skipMigration) {
        console.log(`SKIP (done in closed sprint): ${key}`);
        skipped++;
        continue;
      }

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

      // Jira flagged (Impediment) → always Blocked in Linear, regardless of Jira status
      // Backlog + cycle assigned → Todo (Linear drops cycleId for Backlog-state issues)
      // All other statuses respected as-is
      const mappedStateName = config.stateMigration?.[mapped.jiraStatusName] ?? mapped.jiraStatusName;
      const effectiveStateName = mapped.isBlocked
        ? "Blocked"
        : mappedStateName === "Backlog" && mapped.cycleId
        ? "Todo"
        : mappedStateName;
      const stateId = linearClient.resolveStateId(effectiveStateName, teamId);

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
        subscriberIds: mapped.subscriberIds.length ? mapped.subscriberIds : undefined,
        cycleId: mapped.cycleId,
        estimate: mapped.estimate,
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

      // Migrate existing Jira comments
      const jiraComments = jiraIssue.fields.comment?.comments ?? [];
      for (const jiraComment of jiraComments) {
        const commentText = convertAdfToMarkdown(jiraComment.body);
        if (!commentText.trim()) continue;
        const date = new Date(jiraComment.created).toISOString().split("T")[0];
        const authorName = jiraComment.author.displayName;
        const authorEmail = jiraComment.author.emailAddress
          ? ` (${jiraComment.author.emailAddress})`
          : "";
        const body = `**${authorName}${authorEmail}** on ${date}:\n\n${commentText}`;
        await linearClient.createComment(created.id, body);
        await sleep(rateLimitMs);
      }

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

// ── Backfill assignees orchestrator ───────────────────────────────────────

async function runBackfill(opts: BackfillOptions): Promise<void> {
  const state = loadState(opts.statePath);

  // Build inverted map: linearId → jiraKey
  const linearIdToJiraKey = Object.fromEntries(
    Object.entries(state.jiraKeyToLinearId).map(([jiraKey, linearId]) => [linearId, jiraKey])
  );

  if (Object.keys(linearIdToJiraKey).length === 0) {
    throw new Error("Migration state is empty — nothing to backfill.");
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

  const viewer = await linearClient.getViewer();
  console.log(`Connected to Linear as: ${viewer.name} (${viewer.email})`);

  console.log("Loading Linear workspace data...");
  await linearClient.loadTeams();
  await linearClient.loadUsers();

  // Resolve the target team by name (direct name match, no teamMapping needed)
  const teamId = linearClient.resolveTeamId(opts.teamName, {});
  if (!teamId) {
    throw new Error(`Linear team "${opts.teamName}" not found. Check the --team name.`);
  }
  console.log(`Fetching all issues for team "${opts.teamName}"...`);

  const linearIssues = await linearClient.getTeamIssues(teamId);
  console.log(`Found ${linearIssues.length} Linear issues.`);

  const rateLimitMs = 500;
  let updated = 0;
  let skippedNoJira = 0;
  let skippedNoAssignee = 0;
  let skippedUnresolved = 0;
  let skippedAlreadyAssigned = 0;
  let failed = 0;

  for (const issue of linearIssues) {
    const jiraKey = linearIdToJiraKey[issue.id];

    if (!jiraKey) {
      if (opts.verbose) console.log(`SKIP (not from Jira): ${issue.identifier}`);
      skippedNoJira++;
      continue;
    }

    let assigneeEmail: string | undefined;
    try {
      const jiraIssue = await jiraClient.fetchIssueByKey(jiraKey);
      assigneeEmail = jiraIssue.fields.assignee?.emailAddress;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`WARN: Could not fetch Jira issue ${jiraKey}: ${msg}`);
      failed++;
      continue;
    }

    if (!assigneeEmail) {
      if (opts.verbose) console.log(`SKIP (no Jira assignee): ${issue.identifier} ← ${jiraKey}`);
      skippedNoAssignee++;
      continue;
    }

    const assigneeId = linearClient.resolveUserByEmail(assigneeEmail);
    if (!assigneeId) {
      console.warn(`WARN: Cannot resolve ${assigneeEmail} to a Linear user — skipping ${issue.identifier}`);
      skippedUnresolved++;
      continue;
    }

    if (issue.assigneeId) {
      if (opts.verbose) console.log(`SKIP (Linear assignee takes precedence): ${issue.identifier} → keeping existing assignee`);
      skippedAlreadyAssigned++;
      continue;
    }

    if (opts.dryRun) {
      console.log(`[DRY RUN] ${issue.identifier} ← ${jiraKey}: would assign ${assigneeEmail}`);
      updated++;
      continue;
    }

    try {
      await linearClient.updateIssue(issue.id, { assigneeId });
      console.log(`UPDATED: ${issue.identifier} ← ${jiraKey}: assigned ${assigneeEmail}`);
      await sleep(rateLimitMs);
      updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ERROR: ${issue.identifier}: ${msg}`);
      failed++;
    }
  }

  console.log("\n=== Backfill complete ===");
  console.log(`  Updated               : ${updated}`);
  console.log(`  Skipped (not Jira)    : ${skippedNoJira}`);
  console.log(`  Skipped (no assignee) : ${skippedNoAssignee}`);
  console.log(`  Skipped (unresolved)  : ${skippedUnresolved}`);
  console.log(`  Skipped (Linear wins) : ${skippedAlreadyAssigned}`);
  console.log(`  Failed                : ${failed}`);
}

// ── CLI definition ─────────────────────────────────────────────────────────

program
  .name("jira-to-linear")
  .description("Migrate Jira Cloud issues to Linear")
  .version("1.0.0")
  .option("-j, --jql <query>", "JQL query to select Jira issues (overrides config.jql)")
  .option("-e, --expand <issueKey>", "Recursively discover and migrate all related issues from a seed issue key")
  .option("-d, --dry-run", "Preview migration without creating any Linear issues", false)
  .option("-c, --config <path>", "Path to config.json", "config.json")
  .option("-s, --state <path>", "Path to migration state file (for resume support)", "migration-state.json")
  .option("-v, --verbose", "Print detailed logs", false)
  .action(async (options: Record<string, unknown>) => {
    try {
      await runMigration({
        jql: options.jql as string | undefined,
        expand: options.expand as string | undefined,
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

program
  .command("backfill-assignees")
  .description("Assign Linear issues based on their original Jira assignees")
  .requiredOption("-t, --team <name>", "Linear team name to backfill")
  .option("-c, --config <path>", "Path to config.json", "config.json")
  .option("-s, --state <path>", "Path to migration state file", "migration-state.json")
  .option("-d, --dry-run", "Preview without making changes", false)
  .option("-v, --verbose", "Print detailed logs", false)
  .action(async (options: Record<string, unknown>) => {
    try {
      await runBackfill({
        teamName: options.team as string,
        configPath: options.config as string,
        statePath: options.state as string,
        dryRun: options.dryRun as boolean,
        verbose: options.verbose as boolean,
      });
    } catch (err) {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse(process.argv);
