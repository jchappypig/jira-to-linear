# jira-to-linear

CLI script to migrate Jira Cloud issues to Linear. Supports filtering by JQL (team, epic, sprint, etc.), field mapping, and safe resumable runs.

## Features

- Filter tickets with any JQL query
- Maps: title, description (ADF → Markdown), issue type, assignee, reporter, priority, status, parent/epic
- Epics become parent issues in Linear; child issues are linked automatically
- Adds a comment to each Linear issue with a link back to the original Jira ticket
- Configurable team name mapping (Jira project → Linear team)
- Dry-run mode to preview before migrating
- Resumable: skips already-migrated issues on re-run

## Prerequisites

- Node.js 18+
- Jira Cloud API token — [create one here](https://id.atlassian.com/manage-profile/security/api-tokens)
- Linear Personal API key — Settings → API → Personal API keys

## Setup

```bash
# 1. Clone and install
git clone https://github.com/jchappypig/jira-to-linear.git
cd jira-to-linear
npm install

# 2. Configure credentials
cp .env.example .env
# Edit .env with your Jira and Linear credentials

# 3. Configure mappings
cp config.example.json config.json
# Edit config.json — set teamMapping, issueTypeMapping, stateMigration

# 4. Build
npm run build
```

## Usage

```bash
# Preview (no issues created)
npx jira-to-linear --dry-run --jql "project = ENG AND 'Epic Link' = ENG-5"

# Migrate a specific epic's tickets
npx jira-to-linear --jql "project = ENG AND 'Epic Link' = ENG-5"

# Migrate a team's backlog by sprint
npx jira-to-linear --jql "project = ENG AND assignee in membersOf('backend-team') AND sprint in openSprints()"

# Resume a partial run (already-migrated issues are skipped automatically)
npx jira-to-linear --jql "..." --state migration-state.json

# Verbose output
npx jira-to-linear --jql "..." --verbose
```

## Configuration

### `.env`

```
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-api-token
LINEAR_API_KEY=lin_api_yourkey
```

### `config.json`

| Field | Description |
|---|---|
| `jql` | Default JQL query (can be overridden with `--jql`) |
| `teamMapping` | Maps Jira project names to Linear team names |
| `issueTypeMapping` | Maps Jira issue types to Linear labels with colors |
| `stateMigration` | Maps Jira status names to Linear workflow state names |
| `batchSize` | Issues per batch before a longer pause (default: 10) |
| `rateLimitDelayMs` | Delay between Linear API calls in ms (default: 500) |

## Field Mapping

| Jira | Linear |
|---|---|
| Summary | Title |
| Description | Description (ADF converted to Markdown) |
| Issue Type | Label (Bug, Story, Task, Incident, Epic) |
| Assignee | Assignee (matched by email) |
| Reporter | Comment on the created issue |
| Priority | Priority (Urgent/High/Normal/Low) |
| Status | Workflow state |
| Epic | Parent issue |
| Jira URL | Comment: "Migrated from Jira: [KEY](url)" |

## Epic handling

Jira epics are created as regular Linear issues (with an "Epic" label). All issues that belong to an epic (via Epic Link, parent field, or epic field) are created with that Linear issue as their `parentId`.

The script sorts issues topologically so epics are always created before their children.

## Resuming

A `migration-state.json` file tracks every successfully migrated issue. If the script is interrupted, re-running the same command will skip already-migrated issues and continue from where it left off.

Failed issues are also recorded in the state file with their error messages.
