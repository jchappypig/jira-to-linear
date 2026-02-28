# jira-to-linear

CLI tool to migrate Jira Cloud issues to Linear. Supports filtering by JQL, field mapping, comment migration, and safe resumable runs.

## Features

- Filter tickets with any JQL query
- Maps: title, description (ADF → Markdown), issue type, assignee, reporter, priority, status, parent/epic
- Migrates all existing Jira comments (with author name, email, and date)
- Uses the Jira team field (`customfield_10001`) to route issues to the correct Linear team
- Epics become parent issues in Linear; child issues are linked automatically
- Adds a comment to each Linear issue linking back to the original Jira ticket
- Dry-run mode to preview before migrating
- Resumable: skips already-migrated issues on re-run, no duplicates

## Prerequisites

- Node.js 18+
- Jira Cloud API token — [create one here](https://id.atlassian.com/manage-profile/security/api-tokens) — use **"Create API token"** (not the scoped version)
- Linear Personal API key — Settings → API → Personal API keys

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your-jira-api-token
LINEAR_API_KEY=lin_api_yourkey
```

### 3. Configure mappings

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "jql": "project = 12442 ORDER BY created ASC",
  "teamMapping": {
    "Convert Team": "Performance",
    "Engage Team": "Performance",
    "Enable Team": "Growth",
    "Scale Team": "Efficiency",
    "Orchestrate Team": "Efficiency"
  },
  "issueTypeMapping": {
    "Bug":      { "linearLabel": "Bug" },
    "Story":    { "linearLabel": "Feature" },
    "Task":     { "linearLabel": "Feature" },
    "Incident": { "linearLabel": "Bug" },
    "Epic":     { "linearLabel": "Feature" }
  },
  "stateMigration": {
    "Backlog":           "Backlog",
    "In Progress":       "In Progress",
    "Functional Review": "Functional Review",
    "Done":              "Done",
    "Won't do":          "Won't do"
  },
  "defaultTeamName": "my-fallback-team",
  "batchSize": 10,
  "rateLimitDelayMs": 500
}
```

**Config fields:**

| Field | Description |
|---|---|
| `jql` | JQL query to select which Jira issues to migrate. **Note:** use the numeric project ID (e.g. `project = 12442`) if the project key doesn't work with your Jira instance |
| `teamMapping` | Maps the Jira team field value (or project name) to a Linear team name |
| `issueTypeMapping` | Maps Jira issue types to Linear label names |
| `stateMigration` | Maps Jira status names to Linear workflow state names |
| `defaultTeamName` | Fallback Linear team name for issues with no matching team mapping |
| `batchSize` | Number of issues per batch before a longer pause (default: 10) |
| `rateLimitDelayMs` | Delay in ms between API calls to avoid rate limiting (default: 500) |

> **Tip:** To find your numeric project ID, go to your Jira project and check the URL, or use the Jira API: `GET /rest/api/3/project/search`

## Usage

### Step 1 — Always dry run first

Preview what will be migrated without creating anything in Linear:

```bash
node dist/index.js --dry-run --verbose
```

### Step 2 — Run the migration

Once you're happy with the dry-run output:

```bash
node dist/index.js
```

### CLI options

| Option | Default | Description |
|---|---|---|
| `--jql <query>` / `-j` | config.jql | Override the JQL query |
| `--expand <issueKey>` / `-e` | — | Recursively discover and migrate all related issues from a seed issue key |
| `--dry-run` / `-d` | false | Preview only, no issues created |
| `--verbose` / `-v` | false | Print detailed logs per issue |
| `--config <path>` / `-c` | `config.json` | Path to config file |
| `--state <path>` / `-s` | `migration-state.json` | Path to state tracking file |

### Examples

```bash
# Dry run a specific issue
node dist/index.js --dry-run --verbose --jql "issue = DEL-6258"

# Migrate a single issue
node dist/index.js --jql "issue = DEL-6258"

# Migrate all issues in a project
node dist/index.js --jql "project = 12442 ORDER BY created ASC"

# Migrate issues updated in the last 30 days
node dist/index.js --jql "project = 12442 AND updated >= -30d ORDER BY created ASC"

# Expand from a seed issue — migrates the epic + all children + same-project linked issues
node dist/index.js --expand DEL-6258 --dry-run --verbose
node dist/index.js --expand DEL-6258

# Resume an interrupted run (already-migrated issues are skipped automatically)
node dist/index.js --jql "project = 12442 ORDER BY created ASC"
```

### How `--expand` works

Starting from a single issue key, it recursively discovers the full graph:

1. Fetches the seed issue
2. Follows **children** (via `parent =` and `Epic Link =`)
3. Follows **issuelinks** — but only to issues in the **same project** (e.g. DEL-*). Links to other projects like MAP or IDEAS are ignored
4. Repeats for each newly discovered issue
5. Uses a visited set to prevent infinite loops from circular links

This means you can point `--expand` at an epic and it will automatically pull in all its stories, tasks, and any cross-linked DEL issues — without needing to manually construct a JQL query.

## What gets migrated

| Jira field | Linear field |
|---|---|
| Summary | Title |
| Description (ADF) | Description (Markdown) |
| Assignee | Assignee (matched by email) |
| Priority | Priority |
| Issue type | Label (via `issueTypeMapping`) |
| Status | Workflow state (via `stateMigration`) |
| Parent / Epic Link | Parent issue |
| Comments | Comments (with author name, email, and date) |
| Project key | Label `Jira:KEY` for traceability |
| Team field | Used to route to the correct Linear team |

A comment is also added to each migrated Linear issue with:
- Link back to the original Jira ticket
- Reporter name and email
- Jira status at time of migration
- Migration date

## Resume support

Every successfully migrated issue is recorded in `migration-state.json` with its Jira key → Linear ID mapping. If the migration is interrupted, re-running the same command will skip already-migrated issues and continue from where it left off — no duplicates will be created.

Failed issues are also recorded in the state file with their error messages.

## Building from source

If you modify any TypeScript source files, rebuild before running:

```bash
npm run build
```
