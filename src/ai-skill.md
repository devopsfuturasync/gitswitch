---
name: gitswitch
description: Use for any git or GitHub CLI operation (push, pull, fetch, clone, commit, gh pr/issue/repo) on this Windows machine, where the user has several GitHub accounts. Run them through the `gitswitch` command so the right account authenticates and authors the commit, instead of plain `git`/`gh` which use whatever account is cached.
---

# gitswitch: the right GitHub account for every repo

This machine has more than one GitHub account logged in with the GitHub CLI. Plain `git push` or `gh pr create` can authenticate as the wrong one. `gitswitch` picks the account per repository and runs the command with that account's token and commit identity. It never prompts.

## Rules

- For any command that talks to GitHub or creates commits, use `gitswitch git -- <args>` instead of `git <args>`, and `gitswitch gh -- <args>` instead of `gh <args>`.
- Read-only local commands (`git log`, `git diff`, `git status`) can stay plain `git`, though `gitswitch status --json` gives a better summary.
- Before pushing, run `gitswitch whoami --json` to confirm the account. If the user asked for a specific account, pass `--as <login>`.
- Add `--json` when you need to parse the output. Every JSON reply has `"ok": true|false`; failures add `"error"` (a plain sentence), `"kind"` and `"detail"` (raw git output).

## How the account is chosen

1. `--as <login>` if given.
2. The account the repo was last used with in GitSwitch.
3. The account that owns the `origin` remote on GitHub (or belongs to the owning organization).
4. The active account in the GitSwitch app.

`gitswitch whoami` prints which one applies and why (`reason`: `flag`, `repo`, `owner`, `active`).

## Commands

| Command | What it does |
|---|---|
| `gitswitch accounts --json` | Accounts, their commit identity and their folder |
| `gitswitch whoami [path] --json` | Account that will be used here, and why |
| `gitswitch status [path] --json` | Branch, upstream, ahead/behind, changed files, stashes, merge state |
| `gitswitch git [--as login] [-C path] -- <git args>` | Any git command as the right account |
| `gitswitch gh [--as login] [-C path] -- <gh args>` | Any GitHub CLI command as the right account |
| `gitswitch fetch` / `pull` / `push [--force]` | Network operations with plain-language errors (`--force` is `--force-with-lease`) |
| `gitswitch commit -m "msg" [--all] [--amend] [files…]` | Commit with the account's identity |
| `gitswitch clone <owner/repo or url> [--as login] [--dir path]` | Clone into the account's folder and add it to GitSwitch |
| `gitswitch repos [--account login] --json` | Repositories known to GitSwitch |
| `gitswitch use <login> [--keep-repo] --json` | Make an account active (the app follows) and select the repo last used with it; `repo` in the reply is its path |
| `gitswitch folder <login> [path]` | Show or set an account's folder |
| `gitswitch detect [--add] --json` | Find repos on disk per account; `--add` adds the missing ones |
| `gitswitch help [command] --json` | Machine-readable list of commands and options |

## Switching accounts

When the user asks to work as another account, run `gitswitch use <login> --json`. The reply's `repo` is the repository last used with that account (or `null`); `cd` there before continuing. Pass `--keep-repo` to switch the account for the repository you are already in. The GitSwitch app picks up the change when its window is focused.

## Language

Output is English when it goes to a pipe or with `--json` (what agents see), and in the system language at an interactive terminal. Set `GITSWITCH_LANG=en` to force English.

## Exit codes

`0` ok · `1` git/gh failed · `2` usage error · `3` authentication or permission · `4` not found (repo, account, path)

## Examples

```bash
gitswitch whoami --json
gitswitch git -- push -u origin HEAD
gitswitch gh -- pr create --fill
gitswitch commit -m "Fix login redirect" --all
gitswitch clone devopsfuturasync/bpv-console --as devopsfuturasync
```
