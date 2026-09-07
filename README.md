# Roundtable

**A shared workspace where people bring their own Codex and work together.**

People and agents share a conversation, discuss ideas, and tackle different tasks
at the same time. Each person brings their own tools, skills, and approach. Use it
for research, writing, analysis, design, software, or any work that benefits from
collaboration.

![A shared project with people, agents, work threads, and a main conversation](docs/evidence/project-ide/01-conversation.png)

*Navigate conversations, agent profiles, tasks, and outputs in one project.
[See the interface walkthrough.](docs/evidence/project-ide/README.md)*

## How it works

1. **Bring your Codex.** Join a table and connect a local folder or Git repository.
   Your agents use your own Codex login and configuration.
2. **Work together.** Create named specialists, talk with them in the shared
   conversation, and assign tasks to your own agents. Everyone can see progress
   while work happens in separate directories. Use **Tasks** to plan ownership,
   dependencies, and review alongside the conversation.
3. **Build shared knowledge.** Keep a brief, sources, decisions, and learnings in
   Context. Agents propose additions; people review them. Shared skills are opt-in
   for each person's agents.
4. **Review the results.** Download deliverables, review code changes, and save
   useful outputs back into the table's context.

## Get started

You need Node.js 20+ and a logged-in Codex CLI on each participant's machine.
The current integration has been tested with Codex CLI 0.153.3. Git is required
only for repository workspaces.

From your Roundtable checkout:

```bash
npm ci
npm start
```

Open [localhost:3131](http://localhost:3131), enter your name, and join a table.
Click **Connect your Codex**. When Roundtable was launched from Codex, it reuses
that Codex project’s folder. Otherwise, choose a folder in the system picker.
Roundtable uses your existing login, detects whether the folder is a Git repository,
and starts the connection for you. No pairing token or second terminal is needed
when Roundtable runs on your machine. It remembers the folder and restores your
connection when the local server restarts. **Disconnect mine** stops it and turns
off automatic reconnection.

If Codex needs a login, the setup screen opens its sign-in flow. Installation help
and optional folder, validation, and preview settings are available there too.

| Workspace | Use it for | Results |
| --- | --- | --- |
| Folder | Documents, research, data, and other work | Downloadable files from a separate output directory |
| Git repository | Changes to a committed codebase | A reviewable patch, with optional checks and a preview |

To work with friends on other machines, use a server URL everyone can reach;
`localhost` is only your own machine. Remote participants currently use **Manual
setup** and its private bridge command; the one-click manager is local-only. See [hosting](docs/hosting.md) for setup and
[the workspace guide](docs/workspaces.md) for connection options.

## Find your way around

- **The table** is the project’s shared conversation. Create a task from any message.
- **People & agents** shows who is here and what each agent is doing. Open an agent
  to see its role and assigned work, or mention it in the table.
- **Work threads** opens tasks with their own discussion, owner controls, and results.
  Task messages also appear in the table. Tabs let you switch between work without
  losing unsent task messages during the current page session.
- **Shared context**, **Outputs**, and **Canvas** open in the main area. Text
  deliverables can open in their own tabs; other files remain downloadable.
- **Your Codex** holds connection settings, conversation participation, and specialists.

## Try a shared task

Add a short brief and a source in **Context**, then create a specialist in chat:

```text
/specialist Mira | Compare the supplied options and explain the tradeoffs.
```

Ask Mira to discuss the source and propose a learning:

```text
@mira Read our shared context. What would you recommend, and what is still uncertain?
Propose one useful learning for us to review.
```

Review the proposal in Context, then use **Create task** under a message to assign
a deliverable, link sources, and track review. Its owner chooses **Start my agent**.
You can also start an execution directly from chat:

```text
/work @mira Write a decision brief using our accepted context. Save it as decision-brief.md.
```

Other people can work with their own agents in parallel. Specialists and task
threads from each connection stay together in one local Codex project.

## Current status

Roundtable is an early prototype. The [recorded test run](docs/evidence/shared-context/README.md)
uses real Astra agents under one local owner: they retrieved sources, proposed and
used accepted knowledge, and produced a brief after server and bridge restarts.
The [task board run](docs/evidence/task-board/README.md) also exercises two local
owner sessions, concurrent work, review, and prerequisite file handoff.
Multi-machine collaboration is the next validation step.

- Each person can have four specialists and run two execution tasks at once.
- Shared context, tasks, and specialist profiles persist. Saved local agent
  conversations survive bridge restarts; interrupted tasks can resume with their
  original files. Returning members get a summary of recent changes.
- Sources use pasted content and links. Automatic document syncing, arbitrary
  source-file uploads, and autonomous specialist creation are not implemented.
- Room links grant access to shared content. Use trusted participants, keep pairing
  commands private, and share only the inputs and outputs you intend to expose.

## Documentation

- [Local connection walkthrough](docs/evidence/local-connection/README.md) — setup, reconnect, and a real agent reply.
- [Session continuity walkthrough](docs/evidence/session-continuity/README.md) — saved conversations, retained work, and catch-up.
- [Task board walkthrough](docs/evidence/task-board/README.md) — conversation, dependencies, and real agent results.
- [Workspace guide](docs/workspaces.md) — setup, agent controls, context, and limits.
- [Hosting and security](docs/hosting.md) — persistence, deployment, and access.
- [Development](docs/development.md) — architecture, tests, and recorded evidence.
- [Product direction](PRODUCT.md) — the experience we're building toward.
- [Legacy chat and canvas](docs/legacy-canvas.md) — the original shared-brain workflow.

## License

[MIT](LICENSE)
