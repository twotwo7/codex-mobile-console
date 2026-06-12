# Launch Posts

Use these after the repository is public and the `v1.4.0` release is published.

## Hacker News / Reddit

Title:

```text
Show HN: A self-hosted mobile console for persistent Codex sessions
```

Post:

```text
I built Codex Mobile Console because mobile SSH clients were a poor control surface for long-running Codex work.

Codex runs on your own server. The web app is a mobile-first PWA for switching sessions, sending prompts, viewing Codex history, checking runtime/process state, uploading attachments, queueing prompts, and stopping active runs.

The intended workflow is personal/self-hosted: run Codex on a VPS, home lab, NAS, or remote dev box, then use your phone to check progress and send follow-up instructions without keeping an SSH terminal alive.

Install:

curl -fsSL https://raw.githubusercontent.com/twotwo7/codex-mobile-console/main/scripts/install.sh | bash

It is intended to sit behind HTTPS, VPN, Tailscale, Cloudflare Access, or another trusted access layer. It is not a hosted SaaS or multi-user team product.

Repo: https://github.com/twotwo7/codex-mobile-console
```

## X / Twitter

```text
I built Codex Mobile Console: a self-hosted mobile control panel for persistent Codex sessions.

Codex runs on your server. Your phone can switch sessions, send prompts, view history, check runtime state, upload attachments, queue prompts, and stop stuck runs without using a mobile SSH client.

https://github.com/twotwo7/codex-mobile-console
```

## V2EX

Title:

```text
做了一个自托管的 Codex 手机控制台
```

Post:

```text
我平时是 Codex 跑在服务器上，用 VS Code Remote 做开发。但出门之后经常只想用手机看一下 Codex 跑完没有，补一句指令，或者停止一个卡住的任务。Termius/SSH 手机端体验不太适合这种长期 AI 开发会话。

所以做了 Codex Mobile Console。

它不是通用 AI Chat UI，而是给服务器上的 Codex 做一个移动端控制面板：

- 手机 PWA 界面
- 多会话切换
- Codex 历史读取
- 运行状态和停止按钮
- 运行时/进程信息
- 队列
- 图片和文件附件
- Skill 管理
- 一键安装 systemd 服务

安装：

curl -fsSL https://raw.githubusercontent.com/twotwo7/codex-mobile-console/main/scripts/install.sh | bash

建议只放在 HTTPS/VPN/Tailscale/Cloudflare Access 后面自用。

GitHub: https://github.com/twotwo7/codex-mobile-console
```

## Demo Script

Record a 30-60 second vertical video:

1. Open the PWA from a phone browser or home screen.
2. Switch between two sessions.
3. Send a short prompt.
4. Show the run status indicator.
5. Open runtime info.
6. Add an attachment or image.
7. Stop or queue a task.

Keep the demo project generic and remove any private repository names, credentials, or customer data.
