# SynthOS: one program for daily life and work

SynthOS aims to become the place where a person can access and carry out their daily work: communications, projects, knowledge, files, creative tools, development, and home services. Its interface should preserve context as the person moves between these activities.

This is the product direction. The current application implements a subset: the T3 workspace, managed GCH missions, knowledge connections, reviewed AgentMail sending, device intake, and read-only DAM browsing. A listed goal is not a claim that its connection is running.

## The experience

The guiding rule is **interaction-ready access within 30 seconds and no more than three page transitions**, from an already authenticated starting point. Common activities should fit inside the SynthOS window. Long processing jobs show progress separately from time to access. First-time authentication, service outages and services that require an external application remain visible exceptions.

Focused views should make the whole program manageable:

- **Today:** attention, calendar, reminders, unfinished work and next actions.
- **Messages:** authorized conversations across accounts and services, with the correct sending identity and source-specific reply controls.
- **Work:** projects, tasks, people, CRM, planning and approved automation.
- **Knowledge:** personal notes, research, citations, graph exploration and ideation.
- **Library:** documents, assets, photos, files and source-linked previews.
- **Home:** household and infrastructure status, inventory and supported device controls.
- **Studio:** coding, terminals, analysis, presentations, audio/video and other specialist tools.

Search, browser access, AI assistance and an attention rail cross these views. Switching a view should preserve drafts, selection, position and running jobs. Disconnected or stale sources must not look empty or healthy.

## Connect services with explicit capabilities

The target is one interface over connected services. Each connection declares the operations it actually supports:

- **Native:** SynthOS reads or acts through an authorized API.
- **Relay:** a separately qualified bridge supplies supported operations.
- **Service view:** an isolated account view provides the service's own interface.
- **Launcher:** a direct route opens the supported application.
- **Import:** the user selects data to bring into a workflow.

These modes provide different search, unread, reply and notification coverage. A service view does not establish a synchronized inbox. The interface must show these differences.

Communications priorities are multiple Gmail accounts, Outlook and Slack. Personal messaging and social channels follow through individually qualified access routes. Browser profiles retain explicit account/workspace bindings. Shopping and entertainment can begin with service views or launchers.

## Keep ownership clear

T3 owns SynthOS execution: provider sessions, processes, workspaces, terminals, command receipts and cancellation. GCH contributes operating methods and policy to that execution path. Specialist services remain behind bounded adapters.

Source systems keep their records and permissions. DAM owns assets; file providers own their files; knowledge sources own their notes. Derived search indexes and graph views retain source identity, revision, provenance and freshness. Each record has an explicit authority before writeback or synchronization is enabled.

An authenticated connection grants only its declared capabilities. Reading a source does not authorize sending its contents to a model. Workspace policy controls AI access and destination. Owner-only content stays opt-in. Credentials remain on the selected server environment.

Sending messages and performing other consequential actions require the appropriate review. Message approval binds the provider, account, recipients, content and attachments. An uncertain delivery result must be reconciled before retrying.

## Support different models and harnesses

Workflows and skills should run through provider-neutral contracts. Codex, Claude and qualified local models can fill roles according to capability, availability and workspace policy. Hard controls belong in the host/server boundary rather than depending on one provider's hooks.

Local-only work must remain local. Missing capabilities or required independent review remain visibly unqualified. Changing a model name or harness does not establish independent review or equivalent quality.

## Build toward the vision

The next product increments are foundation qualification, curated skills, the daily-driver console, core Messages, broader Library access and qualified specialist workflows. The existing DAM connection is described in [the SynthOS guide](./synthos.md#connect-your-dam-library).

Before building a feature, research existing GitHub implementations, their issues and relevant Reddit experience. Check source behavior, maintenance, permissions and licences before reuse. Community reports are discovery evidence; product acceptance requires checks on the actual candidate and intended host.

A release is accepted through real journeys, recovery tests and observed receipts. A merged feature, registered tool, configured key or successful mock does not establish a working account, device or complete daily workflow.
