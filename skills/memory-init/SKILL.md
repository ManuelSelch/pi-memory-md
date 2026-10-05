---
name: memory-init
description: Initial setup and bootstrap for pi-memory-md repository
---

# Memory Init

Use this skill to set up pi-memory-md for the first time or reinitialize an existing installation.

## Prerequisites

1. **GitHub repository** - Create a new empty repository on GitHub
2. **Git access** - Configure SSH keys or personal access token
3. **Node.js & npm** - For installing the package

## Step 1: Install Package

```bash
pi install npm:pi-memory-md
```

## Step 2: Create GitHub Repository

Create a new repository on GitHub:
- Name it something like `memory-md` or `pi-memory`
- Make it private (recommended)
- Don't initialize with README (we'll do that)

**Clone URL will be:** `git@github.com:username/repo-name.git`

## Step 3: Configure Settings

Add to your settings file (global: `~/.pi/agent/settings.json`, project: `.pi/settings.json`):

```json
{
  "pi-memory-md": {
    "enabled": true,
    "repoUrl": "git@github.com:username/repo-name.git",
    "localPath": "~/.pi/memory-md",
  }
}
```

**Settings explained:**

| Setting | Purpose | Default |
|---------|---------|----------|
| `enabled` | Enable/disable extension | `true` |
| `repoUrl` | GitHub repository URL | Required |
| `localPath` | Local clone location (supports `~`) | `~/.pi/memory-md` |

## Step 4: Initialize Repository

Start pi and run:

```
memory_init()
```

**This does:**
1. Clones the GitHub repository
2. Creates directory structure:
   - `system/` - Always-loaded policies and preferences
   - `projects/` - Project-specific info
   - `long-term/user/` - Durable user information
   - `long-term/tech/` - Durable technical knowledge
   - `reference/` - Read-only external documentation
3. Creates default files:
   - `system/memory-policy.md` - Memory policy template
   - `system/preferences.md` - User preferences template
   - `long-term/user/identity.md` - User identity template

**Example output:**
```
Memory repository initialized:
Cloned repository successfully

Created directory structure:
  - system
  - projects
  - long-term/user
  - long-term/tech
  - reference
```

## Step 5: Import Preferences from AGENTS.md

After initialization, extract relevant preferences from your `AGENTS.md` file to populate `system/preferences.md`:

1. **Read AGENTS.md** (typically at `.pi/agent/AGENTS.md` or project root)

2. **Extract relevant sections** such as:
   - IMPORTANT Rules
   - Code Quality Principles
   - Coding Style Preferences
   - Architecture Principles
   - Development Workflow
   - Technical Preferences

3. **Present extracted content** to the user in a summarized format

4. **Ask first confirmation**: Include these extracted preferences in `system/preferences.md`?
   ```
   Found these preferences in AGENTS.md:
   - IMPORTANT Rules: [summary]
   - Code Quality Principles: [summary]
   - Coding Style: [summary]

   Include these in system/preferences.md? (yes/no)
   ```

5. **Ask for additional content**: Is there anything else you want to add to your preferences?
   ```
   Any additional preferences you'd like to include? (e.g., communication style, specific tools, workflows)
   ```

6. **Update system/preferences.md** with:
   - Extracted content from AGENTS.md (if user confirmed)
   - Any additional preferences provided by user

## Step 6: Verify Setup

Check status with command:

```
/memory status
```

Should show: `Memory: project-name | Repo: Clean | Path: {localPath}/project-name`

List files:

```
memory_list()
```

Should show: `system/preferences.md`, `long-term/user/identity.md`

## Project Structure

**Base path**: Configured via `settings["pi-memory-md"].localPath` (default: `~/.pi/memory-md`)

Each project gets its own folder in the repository:

```
{localPath}/
├── system/
│   ├── memory-policy.md
│   └── preferences.md
├── projects/
│   └── project-a/
├── long-term/
│   ├── user/
│   │   └── identity.md
│   └── tech/
└── reference/
├── project-b/
│   └── ...
└── project-c/
    └── ...
```

Project name is derived from:
- Git repository name (if in a git repo)
- Or current directory name

## First-Time Setup Script

Automate setup with this script:

```bash
#!/bin/bash
# setup-memory-md.sh

REPO_URL="git@github.com:username/memory-repo.git"
SETTINGS_FILE="$HOME/.pi/agent/settings.json"

# Backup existing settings
cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"

# Add pi-memory-md configuration
node -e "
const fs = require('fs');
const path = require('path');
const settingsPath = '$SETTINGS_FILE';
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings['pi-memory-md'] = {
  enabled: true,
  repoUrl: '$REPO_URL',
  localPath: path.join(require('os').homedir(), '.pi', 'memory-md')
};
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
"

echo "Settings configured. Now run: memory_init()"
```

## Reinitializing

To reset everything:

```
memory_init(force=true)
```

**Warning:** This will re-clone the repository, potentially losing local uncommitted changes.

## Troubleshooting

### Clone Failed

**Error:** `Clone failed: Permission denied`

**Solution:**
1. Verify SSH keys are configured: `ssh -T git@github.com`
2. Check repo URL is correct in settings
3. Ensure repo exists on GitHub

### Settings Not Found

**Error:** `GitHub repo URL not configured in settings["pi-memory-md"].repoUrl`

**Solution:**
1. Edit settings file (global or project)
2. Add `pi-memory-md` section (see Step 3)
3. Run `/reload` in pi

### Directory Already Exists

**Error:** `Directory exists but is not a git repo`

**Solution:**
1. Remove existing directory: `rm -rf {localPath}` (use your configured path)
2. Run `memory_init()` again

### No Write Permission

**Error:** `EACCES: permission denied`

**Solution:**
1. Check directory permissions: `ls -la {localPath}/..` (use your configured path)
2. Fix ownership: `sudo chown -R $USER:$USER {localPath}` (use your configured path)

## Verification Checklist

After setup, verify:

- [ ] Package installed: `pi install npm:pi-memory-md`
- [ ] Settings configured in settings file
- [ ] GitHub repository exists and is accessible
- [ ] Repository cloned to configured `localPath`
- [ ] Directory structure created
- [ ] `/memory status` shows correct info
- [ ] `memory_list()` returns files
- [ ] `prefer.md` populated (either from AGENTS.md or default template)

## Next Steps

After initialization:

1. **Import preferences** - Agent will prompt to extract from AGENTS.md
2. Edit your identity: `memory_read(path="long-term/user/identity.md")` then `memory_write(...)` to update
3. Review preferences: `memory_read(path="system/preferences.md")`
4. Add project context: `memory_write(path="projects/<project>/overview.md", ...)
5. Learn more: See `memory-management` skill

## Related Skills

- `memory-management` - Creating and managing memory files
- `memory-sync` - Git synchronization
- `memory-search` - Finding information
