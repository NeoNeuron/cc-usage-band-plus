# usage-band-plus

A Claude Code mod that puts a two-row band above the prompt with what you need to keep an eye on while you work. It is a fork of [usage-band](https://github.com/JetsonChan/CC-Usage-Band) by Jetson Chan, with a row added for the session itself:

- **Model · effort** — the main loop's model and the reasoning effort its requests go out with
- **Git** — branch, `*` when dirty, and counts: `✗` conflicts, `!` modified, `+` staged, `?` untracked, `↑` ahead, `↓` behind
- **Todos** — the task in progress and how many are done

Under it, the usage row:

- **5h / 7d** — how much of your 5-hour and 7-day rate-limit windows is used, and when each resets
- **Context** — tokens in the context window out of its size
- **Cache hit** — how much of the last turn's input the prompt cache served

Each metric has its own color and turns red when it needs attention: a limit or the context past 80%, or a cache hit rate under 50%. The limit bars carry a slow shine that sweeps left to right, in step across bars.

> **Fork notice.** usage-band-plus is a fork of [usage-band](https://github.com/JetsonChan/CC-Usage-Band), created by **Jetson Chan**, who wrote the usage row (limits, context window, cache hit rate), the terminal and desktop drawing, and the preview command. This fork, maintained by Kai Chen, adds the info row (model, effort, git status, todos). Both are MIT licensed.

Requires Claude Code 2.1.322 or newer.

## How it looks

**Terminal**

```
Opus 5.5 · high  git:(main* !2 +1 ?3 ↑1)  ▸ Fix the bug (2/5)
5h ■■■■■■■■ 78% · 1h18m  7d ■■■■■■■■ 48% · 5d3h  󰌨 398K/1M  󰓾 100%
```

Each row fits itself to the terminal width. The usage row drops the bars first, then the countdowns. The info row drops the todo's text, then ahead/behind, then the file counts, then the effort.

**Desktop app (Code tab)**

The info row as one centered line of text, over a centered row drawn as SVG: limit bars with the figure and reset time beside them, the context window as a 2×10 dot matrix (each dot is 5% of the window), and the cache hit rate. Hairlines separate the groups. It follows the app's light and dark mode.

## Install

```
/plugin marketplace add NeoNeuron/cc-usage-band-plus
/plugin install usage-band-plus@cc-usage-band-plus
```

Then open a new session (or run `/reload-plugins`). Nothing to configure. Best in [Ghostty](https://ghostty.org), which ships the icon font.

## Settings

Terminal icons are picked automatically: Nerd Font icons in Ghostty, plain Unicode elsewhere. To override, set `USAGE_BAND_ICONS` in your shell profile to `auto`, `nerd`, `unicode` or `ascii`, e.g. `export USAGE_BAND_ICONS=unicode`.

Run `/usage-band-plus-preview` to see the band in every terminal style side by side, including how a 256-color terminal shows the colors.

## Notes

- The 5h / 7d figures come from your subscription's rate-limit headers, so they appear after the first response of a session and only on a subscription.
- The cache hit rate is the last turn's cache reads over all its input (uncached + cache reads + cache writes), summed over the turn's requests.
- Git is read with `git status` at session start, after each turn, after a Bash, Edit, Write or NotebookEdit call, and every minute. Outside a repository the git group is hidden.
- The todo list is built from the `TodoWrite`, `TaskCreate` and `TaskUpdate` calls the mod sees, subagents' included. Tasks made before the mod loaded appear once they are updated.
- If the original `usage-band` is also installed, turn it off, or both bands draw.
- The desktop text uses Inter when it is installed and falls back to SF Pro / the system UI font.

## What it can reach

Mods run with the same access as Claude Code itself; they are not sandboxed. This one only:

- reads the session's usage figures (`$.session.usage`, `session.measure`, `turn.complete`), its model (`$.session.model`, `turn.step`) and the `effortLevel` and `modelSettings` settings
- watches the results of `TodoWrite`, `TaskCreate` and `TaskUpdate` calls, passing every call through unchanged
- runs `git --no-optional-locks status --porcelain=v2 --branch` in the session's directory: read-only, and it takes no lock
- reads the `TERM_PROGRAM` and `USAGE_BAND_ICONS` environment variables to pick terminal icons, and `CLAUDE_CODE_EFFORT_LEVEL` for the effort
- registers the `/usage-band-plus-preview` command and draws the band

It reads and writes no files, runs no other process and makes no network requests.

## Development

```bash
claude plugin validate .
claude plugin test .
```

## License

[MIT](./LICENSE). The original usage-band is © Jetson Chan; the changes in this fork are by Kai Chen.
