# Promotion Plan

## Positioning

Use this positioning:

> A self-hosted mobile control panel for persistent Codex development sessions.

Avoid positioning it as a generic AI chat UI. The value is mobile control over server-side Codex work.

## Target Users

- developers already using Codex on a VPS or remote Linux machine
- VS Code Remote / SSH users who want phone access
- self-hosted and home lab users
- people who run long Codex tasks and want progress checks from mobile
- developers managing multiple Codex sessions across projects

## Short Pitch

English:

> Codex Mobile Console lets you control persistent Codex sessions from your phone. Codex runs on your server; the browser is a mobile-first control panel for switching sessions, sending prompts, stopping runs, viewing runtime state, and keeping history.

Chinese:

> Codex Mobile Console 是一个自托管的 Codex 手机控制台。Codex 在你的服务器上持续运行，手机浏览器只负责随时接管会话、补充指令、查看状态和停止任务。

## Launch Checklist

- README has visual case images above the fold.
- Official website and README use the same positioning and core visual assets.
- Install path works on a clean server.
- HTTPS deployment instructions are clear.
- Security notes are explicit.
- Repository has a LICENSE.
- GitHub topics are set:
  - `codex`
  - `self-hosted`
  - `pwa`
  - `mobile`
  - `developer-tools`
  - `ai-coding`
- Record a 30-60 second mobile demo:
  - open the PWA
  - switch sessions
  - send a prompt
  - show running state
  - open runtime panel
  - stop or queue a task
- Publish `v1.4.0` as the first public release.
- Make the repository public before posting.

Ready-to-use launch copy lives in [launch-posts.md](launch-posts.md).

## Website And README Visuals

Keep the public-facing visuals concrete and product-led. The first impression should show what the tool helps with, not just a blank chat screen.

Primary visual assets:

| Asset | Use |
| --- | --- |
| `docs/assets/case-remote-control.svg` | README hero and website hero |
| `docs/assets/case-queue.svg` | Queue and mobile follow-up prompts |
| `docs/assets/case-runtime.svg` | Runtime/process/status diagnostics |
| `docs/assets/case-skills.svg` | Skill management and reusable workflows |

When the website visuals change, copy the updated public assets into `docs/assets/` and update README references in the same commit. This keeps GitHub, launch posts, and the preview site aligned.

## Suggested Posts

### Hacker News / Reddit

Title:

```text
Show HN: A self-hosted mobile console for persistent Codex sessions
```

Body:

```text
I built Codex Mobile Console because mobile SSH clients were a poor fit for checking and controlling long-running Codex work.

Codex runs on your own server. The web app is a mobile-first PWA for switching sessions, sending prompts, viewing Codex history, checking runtime/process state, and stopping active runs.

It is intended for personal self-hosted use behind HTTPS/VPN/access control.
```

### X / Twitter

```text
I built Codex Mobile Console: a self-hosted mobile control panel for persistent Codex sessions.

Codex runs on your server. Your phone can switch sessions, send prompts, view history, check runtime state, and stop stuck runs without using a mobile SSH client.
```

### V2EX

```text
做了一个自托管的 Codex 手机控制台。

我的使用场景是：Codex 跑在服务器上，平时用 VS Code Remote 开发，但出门后希望用手机继续看进度、补充指令、切换会话、停止卡住的任务。

这个项目不是通用 AI Chat UI，而是给服务器上的 Codex 做一个移动端控制面板。
```

## Demo Flow

1. Start from mobile home screen or browser.
2. Show session list grouped by recent/project.
3. Open a running session.
4. Send a short follow-up prompt.
5. Show run indicator and stop button.
6. Open runtime info.
7. Show settings and storage controls.

## Messaging To Avoid

- Do not claim it is a full IDE replacement.
- Do not claim it is safe for public multi-user hosting.
- Do not market it as a generic ChatGPT clone.
- Do not promise compatibility with every Codex CLI version without testing.
