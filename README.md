# Safe Outputs Action

> Security gate for AI agent outputs in GitHub Actions. Validates constraints,
> sanitizes secrets, and applies actions through a controlled write pipeline.

**This is an initial implementation inspired by [GitHub Next Agentic Workflows (gh-aw)](https://github.github.com/gh-aw/).**

gh-aw's safe outputs architecture enforces a critical security principle: the AI
agent never has direct write access to your repository. Instead, the agent
proposes actions as structured data, and a separate gated job validates,
sanitizes, and applies them. This action brings that same pattern to standard
GitHub Actions workflows where gh-aw's built-in sandbox is not available -- for
example, when your agent needs to read from external systems like Kubernetes
clusters, Azure resources, or third-party APIs.

## Why this exists

gh-aw provides an excellent security model, but its safe outputs are tightly
coupled to the gh-aw runtime and cannot be used independently. If your agentic
workflow needs to:

- Consume data from external systems (cloud APIs, databases, clusters)
- Run in a standard GitHub Actions environment
- Use a custom agent or model not supported by gh-aw

...then you need to implement your own output gate. This action provides that
gate as a reusable, configurable step.

## Architecture

```
+-----------------------------------------+
|  Agent Job (read-only permissions)      |
|                                         |
|  AI agent analyzes data, produces       |
|  structured JSON output artifact        |
+-----------------------------------------+
          |
          v  (artifact upload/download)
+-----------------------------------------+
|  Safe Outputs Job (write permissions)   |
|                                         |
|  1. Validate constraints (limits,       |
|     title prefix, allowed labels)       |
|  2. Sanitize secrets (JWTs, keys,       |
|     connection strings, custom)         |
|  3. Apply actions via GitHub API        |
+-----------------------------------------+
          |
          v
+-----------------------------------------+
|  GitHub (issues, PRs, comments, labels) |
+-----------------------------------------+
```

The agent and the write job are separate GitHub Actions jobs with different
permission sets. The agent job runs with minimal (ideally read-only) permissions.
The write job runs with scoped write permissions but contains no AI reasoning --
it mechanically applies validated, sanitized output.

## Agent output schema

The agent must produce a JSON file conforming to this schema:

```json
{
  "version": "1",
  "actions": [
    {
      "type": "issue_comment",
      "issue_number": 42,
      "body": "## Analysis Results\n..."
    },
    {
      "type": "create_issue",
      "title": "[bot] Node pressure detected",
      "body": "Details...",
      "labels": ["bug", "auto-generated"],
      "assignees": ["octocat"]
    },
    {
      "type": "create_pull_request",
      "title": "[bot] Fix HPA configuration",
      "body": "This PR adjusts the HPA settings...",
      "head": "fix/hpa-config",
      "base": "main"
    },
    {
      "type": "add_labels",
      "issue_number": 42,
      "labels": ["triaged", "cluster-doctor"]
    }
  ]
}
```

### Supported action types

| Type | Description | Required fields |
|------|-------------|----------------|
| `issue_comment` | Add a comment to an existing issue or PR | `issue_number`, `body` |
| `create_issue` | Create a new issue | `title`, `body` |
| `create_pull_request` | Create a PR (branch must already exist) | `title`, `body`, `head` |
| `add_labels` | Add labels to an existing issue or PR | `issue_number`, `labels` |

## Usage

### Basic example

```yaml
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      # Your agent step - produces output JSON
      - name: Run AI agent
        run: |
          # Agent writes its proposed actions to a JSON file
          copilot -p "Analyze this repo and propose improvements" \
            --output agent-output.json

      - uses: actions/upload-artifact@v4
        with:
          name: agent-output
          path: agent-output.json

  safe-outputs:
    needs: analyze
    runs-on: ubuntu-latest
    permissions:
      issues: write
      pull-requests: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: agent-output

      - uses: microsoftgbb/safe-outputs-action@v0
        with:
          artifact-path: agent-output.json
          max-issues: 1
          max-comments: 3
          title-prefix: '[bot] '
          allowed-labels: 'bug,auto-generated,enhancement'
```

### With external data gathering (cluster diagnostics)

This is the primary use case -- an agent that needs access to external systems:

```yaml
jobs:
  gather-diagnostics:
    runs-on: ubuntu-latest
    permissions:
      id-token: write   # Azure OIDC
      contents: read
    steps:
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.ARM_CLIENT_ID }}
          tenant-id: ${{ secrets.ARM_TENANT_ID }}
          subscription-id: ${{ secrets.ARM_SUBSCRIPTION_ID }}

      - name: Collect cluster data
        run: |
          az aks get-credentials --resource-group $RG --name $CLUSTER
          kubectl get events -A -o json > diagnostics/events.json
          kubectl get pods -A -o json > diagnostics/pods.json
          kubectl top nodes -o json > diagnostics/nodes.json

      - uses: actions/upload-artifact@v4
        with:
          name: diagnostics
          path: diagnostics/

  analyze:
    needs: gather-diagnostics
    runs-on: ubuntu-latest
    permissions:
      contents: read   # Read-only -- no cloud creds, no write token
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: diagnostics
          path: diagnostics/

      - name: AI analysis
        env:
          GITHUB_TOKEN: ${{ secrets.COPILOT_CLI_TOKEN }}
        run: |
          copilot -p "Analyze the K8s diagnostics in diagnostics/ and produce
            a JSON report following the safe-outputs schema. Write to output.json" \
            --agent "cluster-doctor"

      - uses: actions/upload-artifact@v4
        with:
          name: agent-output
          path: output.json

  apply:
    needs: analyze
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: agent-output

      - uses: microsoftgbb/safe-outputs-action@v0
        with:
          artifact-path: output.json
          title-prefix: '[cluster-doctor] '
          allowed-labels: 'cluster-doctor,bug,investigation'
          custom-secret-patterns: |
            10\.0\.\d+\.\d+
            aks-[a-z0-9]{8,}
```

### Dry run mode

Validate and sanitize without applying -- useful for testing:

```yaml
- uses: microsoftgbb/safe-outputs-action@v0
  with:
    artifact-path: output.json
    dry-run: true
```

### Strict mode (fail on secrets)

Fail the workflow if the agent output contains any sensitive data, instead of
redacting and proceeding:

```yaml
- uses: microsoftgbb/safe-outputs-action@v0
  with:
    artifact-path: output.json
    fail-on-sanitize: true
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `artifact-path` | Path to the agent output JSON file | Yes | - |
| `max-issues` | Max issues the agent can create per run | No | `1` |
| `max-comments` | Max comments the agent can create per run | No | `3` |
| `max-pull-requests` | Max PRs the agent can create per run | No | `1` |
| `max-labels` | Max add-labels actions per run | No | `5` |
| `title-prefix` | Required prefix for issue/PR titles | No | `''` |
| `allowed-labels` | Comma-separated label allowlist (empty = all allowed) | No | `''` |
| `custom-secret-patterns` | Additional regex patterns, one per line | No | `''` |
| `dry-run` | Validate and sanitize without applying | No | `false` |
| `fail-on-sanitize` | Fail if any content is redacted | No | `false` |
| `token` | GitHub token for write operations | No | `${{ github.token }}` |

## Outputs

| Output | Description |
|--------|-------------|
| `applied-count` | Number of actions successfully applied |
| `blocked-count` | Number of actions blocked by constraints |
| `sanitized-count` | Number of fields with redacted content |
| `summary` | JSON summary of all phases |

## Built-in secret patterns

The sanitizer scans for these patterns by default:

- **JWTs** -- `eyJ...` header.payload.signature format
- **Azure connection strings** -- `DefaultEndpointsProtocol=...`
- **Azure SAS tokens** -- URL query parameters with signature components
- **AWS access keys** -- `AKIA...`, `ASIA...` prefixes
- **GitHub tokens** -- `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_` prefixes
- **Private key blocks** -- PEM-encoded private keys
- **Bearer tokens** -- `Bearer <token>` patterns
- **Generic key=value secrets** -- `password=`, `secret:`, `api_key=`, etc.
- **Hex-encoded tokens** -- Long hex strings associated with secret-like key names

Add domain-specific patterns (e.g., internal IPs, cluster names) via the
`custom-secret-patterns` input.

## How it compares to gh-aw safe outputs

| Dimension | gh-aw safe outputs | This action |
|-----------|-------------------|-------------|
| Integration | Built into gh-aw runtime | Standalone GitHub Action |
| Agent scope | Repo-scoped only | Any data source |
| Threat detection | AI-powered scan | Regex-based sanitization |
| Configuration | Markdown frontmatter | Action inputs |
| Network firewall | Built-in (AWF) | Not included (use separately) |
| Customization | Declarative constraints | Full control via inputs |

This action implements the *output gate* portion of gh-aw's security model. For
the full defense-in-depth stack, combine it with:

- **Scoped RBAC** on your cloud credentials (read-only K8s ClusterRole, Azure Reader)
- **Network firewall** via container networking or gh-aw's AWF
- **Separate jobs** with distinct permission sets (gather / analyze / apply)

## Development

```bash
npm install
npm test
npm run build
```

To verify the dist is up to date:

```bash
npm run build
git diff dist/
```

## License

MIT
