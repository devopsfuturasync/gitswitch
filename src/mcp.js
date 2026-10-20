// GitSwitch as an MCP server (Model Context Protocol, stdio transport):
// `gitswitch mcp`. Each tool runs the same code as the matching gitswitch
// command and returns its JSON result, so AI apps can switch accounts and
// run git/gh as the right account without a terminal.
//
// Messages are newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to
// stderr. No SDK: the protocol surface used here is small and stable.

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_OUTPUT = 100_000; // characters of git/gh stdout or stderr per call

const INSTRUCTIONS = `GitSwitch knows which of the user's GitHub accounts each repository belongs to.
Use these tools instead of plain git/gh for anything that talks to GitHub or creates commits:
- gitswitch_whoami before pushing, to see which account will be used and why.
- gitswitch_use to switch accounts; its "repo" is the repository last used with that account.
- gitswitch_git / gitswitch_gh run any git or GitHub CLI command authenticated as the right account.
Paths are absolute. Every result is JSON with "ok"; failures add "error" (plain sentence) and "kind".
Some accounts keep their token in GitSwitch's encrypted vault. When it is locked, GitSwitch shows the user a password prompt and the call waits; if it still fails with kind "auth", ask the user to unlock GitSwitch, then retry. Never ask for the password yourself.`;

const pathProp = { type: 'string', description: 'Absolute path of the repository (or any folder inside it).' };
const asProp = { type: 'string', description: 'GitHub login to use instead of the automatic choice.' };

// name -> { command, title, description, schema, annotations, toArgs(input) -> {pos, opts, rest} }
const TOOLS = {
  gitswitch_accounts: {
    command: 'accounts', title: 'List GitHub accounts',
    description: 'GitHub accounts signed in on this computer, with the commit name/email and the folder of each, and which one is active.',
    schema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    toArgs: () => ({}),
  },
  gitswitch_whoami: {
    command: 'whoami', title: 'Account for a repository',
    description: 'Which account GitSwitch will use for a repository and why (reason: flag, repo, owner or active), plus the commit identity.',
    schema: { type: 'object', properties: { path: pathProp, as: asProp }, required: ['path'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, as: i.as } }),
  },
  gitswitch_use: {
    command: 'use', title: 'Switch account',
    description: 'Makes an account the active one (the GitSwitch app follows) and selects the repository last used with it. Returns that repository path as "repo"; work there next. keep_repo switches the account for the repository already selected.',
    schema: { type: 'object', properties: { login: { type: 'string', description: 'GitHub login to switch to.' }, keep_repo: { type: 'boolean' } }, required: ['login'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    toArgs: (i) => ({ pos: [i.login], opts: { 'keep-repo': Boolean(i.keep_repo) } }),
  },
  gitswitch_status: {
    command: 'status', title: 'Repository status',
    description: 'Branch, upstream, ahead/behind, changed files, stashes, operation in progress (merge, cherry-pick…) and the account in use.',
    schema: { type: 'object', properties: { path: pathProp }, required: ['path'] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    toArgs: (i) => ({ opts: { C: i.path } }),
  },
  gitswitch_repos: {
    command: 'repos', title: 'Known repositories',
    description: 'Repositories in GitSwitch with the account each one uses, and the last repository used per account.',
    schema: { type: 'object', properties: { account: { type: 'string', description: 'Only this login’s repositories.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    toArgs: (i) => ({ opts: { account: i.account } }),
  },
  gitswitch_git: {
    command: 'git', title: 'Run git as the right account',
    description: 'Runs any git command in the repository, authenticated with the right account’s token and committing with its name/email. Returns stdout, stderr and the exit code. Never prompts. Example args: ["push", "-u", "origin", "HEAD"].',
    schema: { type: 'object', properties: { path: pathProp, args: { type: 'array', items: { type: 'string' }, description: 'Arguments after "git".' }, as: asProp }, required: ['path', 'args'] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, as: i.as }, rest: i.args }),
  },
  gitswitch_gh: {
    command: 'gh', title: 'Run GitHub CLI as the right account',
    description: 'Runs any GitHub CLI (gh) command with the right account’s token (pull requests, issues, releases, API). Prompts are disabled, so pass every value as a flag. Example args: ["pr", "create", "--fill"].',
    schema: { type: 'object', properties: { path: pathProp, args: { type: 'array', items: { type: 'string' }, description: 'Arguments after "gh".' }, as: asProp }, required: ['path', 'args'] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, as: i.as }, rest: i.args }),
  },
  gitswitch_fetch: {
    command: 'fetch', title: 'Fetch',
    description: 'Fetches from GitHub and returns ahead/behind for the current branch.',
    schema: { type: 'object', properties: { path: pathProp, as: asProp }, required: ['path'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, as: i.as } }),
  },
  gitswitch_pull: {
    command: 'pull', title: 'Pull',
    description: 'Brings in and merges the branch’s commits from GitHub.',
    schema: { type: 'object', properties: { path: pathProp, as: asProp }, required: ['path'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, as: i.as } }),
  },
  gitswitch_push: {
    command: 'push', title: 'Push',
    description: 'Pushes the current branch (publishing it if it is not on GitHub yet). force uses --force-with-lease.',
    schema: { type: 'object', properties: { path: pathProp, force: { type: 'boolean' }, as: asProp }, required: ['path'] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, as: i.as, force: Boolean(i.force) } }),
  },
  gitswitch_commit: {
    command: 'commit', title: 'Commit',
    description: 'Commits with the account’s name and email. Give the files to include, or all: true for every change. amend replaces the last commit.',
    schema: {
      type: 'object',
      properties: {
        path: pathProp, message: { type: 'string' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths relative to the repository.' },
        all: { type: 'boolean' }, amend: { type: 'boolean' }, as: asProp,
      },
      required: ['path', 'message'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    toArgs: (i) => ({ pos: i.files || [], opts: { C: i.path, message: i.message, all: Boolean(i.all), amend: Boolean(i.amend), as: i.as } }),
  },
  gitswitch_clone: {
    command: 'clone', title: 'Clone',
    description: 'Clones owner/repo (or a URL) into the account’s folder as the right account and adds it to GitSwitch. Returns the new path.',
    schema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/repo or a clone URL.' }, dir: { type: 'string', description: 'Parent folder (default: the account’s folder).' }, as: asProp }, required: ['repo'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    toArgs: (i) => ({ pos: [i.repo], opts: { dir: i.dir, as: i.as } }),
  },
  gitswitch_pr: {
    command: 'pr', title: 'Pull request status',
    description: 'The current branch’s pull request with its checks (CI) state, and the other open pull requests.',
    schema: { type: 'object', properties: { path: pathProp, as: asProp }, required: ['path'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, as: i.as } }),
  },
  gitswitch_pr_create: {
    command: 'pr-create', title: 'Create pull request',
    description: 'Pushes the current branch if needed and opens a pull request as the right account. base defaults to the repository’s default branch.',
    schema: { type: 'object', properties: { path: pathProp, title: { type: 'string' }, body: { type: 'string' }, base: { type: 'string' }, draft: { type: 'boolean' }, as: asProp }, required: ['path', 'title'] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    toArgs: (i) => ({ opts: { C: i.path, title: i.title, body: i.body, base: i.base, draft: Boolean(i.draft), as: i.as } }),
  },
  gitswitch_folder: {
    command: 'folder', title: 'Account folder',
    description: 'Shows the folder where an account’s repositories live, or sets it when path is given.',
    schema: { type: 'object', properties: { login: { type: 'string' }, path: { type: 'string' } }, required: ['login'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    toArgs: (i) => ({ pos: [i.login, i.path].filter(Boolean) }),
  },
  gitswitch_vault_status: {
    command: 'vault', title: 'Where tokens are stored',
    description: 'For each account, where its token is stored: system keyring (encrypted), GitSwitch vault (encrypted) or plain text, and whether the vault is unlocked in the open app.',
    schema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    toArgs: () => ({ pos: ['status'] }),
  },
  gitswitch_detect: {
    command: 'detect', title: 'Find repositories on disk',
    description: 'Scans the usual folders for repositories of each account. add: true adds the missing ones to GitSwitch.',
    schema: { type: 'object', properties: { add: { type: 'boolean' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    toArgs: (i) => ({ opts: { add: Boolean(i.add) } }),
  },
};

function toolList() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name, title: t.title, description: t.description, inputSchema: t.schema, annotations: { title: t.title, ...t.annotations },
  }));
}

function serve({ capture, version }) {
  const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

  // One tool call at a time: commands share process-wide state (cwd, capture).
  let queue = Promise.resolve();

  async function callTool(id, params) {
    const tool = TOOLS[params?.name];
    if (!tool) { error(id, -32602, `Unknown tool: ${params?.name}`); return; }
    try {
      const data = await capture(tool.command, tool.toArgs(params.arguments || {}));
      // A whole `git log` would flood the agent's context: keep the start of it.
      for (const key of ['stdout', 'stderr']) {
        if (typeof data?.[key] === 'string' && data[key].length > MAX_OUTPUT) {
          data[`${key}Truncated`] = data[key].length;
          data[key] = data[key].slice(0, MAX_OUTPUT);
        }
      }
      const ok = data?.ok !== false;
      reply(id, { content: [{ type: 'text', text: JSON.stringify({ ok, ...data }, null, 2) }], isError: !ok });
    } catch (err) {
      const body = { ok: false, error: err.message, kind: err.kind || 'failed', ...(err.detail ? { detail: err.detail } : {}) };
      reply(id, { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true });
    }
  }

  function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        reply(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'gitswitch', title: 'GitSwitch', version },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'ping': reply(id, {}); return;
      case 'tools/list': reply(id, { tools: toolList() }); return;
      case 'tools/call': queue = queue.then(() => callTool(id, params)); return;
      default:
        if (isRequest) error(id, -32601, `Method not found: ${method}`);
        // notifications (initialized, cancelled…) need no answer
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); continue; }
      try { handle(msg); } catch (err) { if (msg.id != null) error(msg.id, -32603, err.message); }
    }
  });
  return new Promise((resolve) => process.stdin.on('end', resolve));
}

module.exports = { serve, TOOLS };
