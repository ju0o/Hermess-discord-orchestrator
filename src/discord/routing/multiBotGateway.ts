import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { ChannelType, Client, GatewayIntentBits, Partials, PermissionFlagsBits, ThreadAutoArchiveDuration, type Message, type TextBasedChannel } from "discord.js";
import { config } from "../../config/env.js";
import { AGENT_IDS, type AgentId, type Role, type TaskRecord } from "../../domain/types.js";
import type { Store } from "../../storage/database.js";
import type { AgentRegistry } from "../../registry/agentRegistry.js";
import type { TaskRepository } from "../../tasks/repository.js";
import type { AgentAdapter } from "../../agents/adapter.js";
import type { ProcessRunner } from "../../runtime/processRunner.js";
import type { ProtocolEvent, ProtocolSink } from "../../tasks/protocol.js";
import type { DiscordContextMessage, DiscordContextSource } from "../../context/discord.js";
import { redact, safeError } from "../../security/redaction.js";
import type { TaskAdmission } from "../../tasks/taskAdmission.js";
import { parseCommand } from "../commands/parser.js";
import { ensureRecipientMention } from "../messages/mentions.js";
import { DiscordDiscovery } from "../discovery/discovery.js";
import { StatusUi } from "../status/statusUi.js";
import type { TrustedBotRegistry } from "../control/trustedBotRegistry.js";
import type { InboundGuard, InboundInput } from "../control/inboundGuard.js";
import type { AsusHermesControlTransport } from "../control/controlTransport.js";
import { agentToBotType, blocksAutomaticReply, buildEnvelopeWireFragments, normalizeBotType, type BotType, type NativeEnvelope } from "../control/types.js";
import { WorkroomManager } from "../workrooms/manager.js";
import type { DiscordProjectChannelSnapshot, DiscordThreadSnapshot, DiscordWorkroomPort } from "../workrooms/types.js";
import { isProjectsCategory, normalizeDiscordLabel } from "../workrooms/normalization.js";
import type { ModelCatalog } from "../../models/catalog.js";
import type { CollaborationService } from "../../collaboration/service.js";
import type { EngineeringMeetingService } from "../../collaboration/meeting.js";
import type { PerformanceService } from "../../performance/service.js";
import type { WorkerRuntime } from "../../worker/runtime.js";
import { renderOfficeMessage } from "../conversation/officeRenderer.js";
import type { OwnerControl } from "../../office/ownerControl.js";
import { HumanFeedback, acknowledgement } from "../../office/humanFeedback.js";

interface BoundClient { client: Client; agentId?: AgentId; botType: BotType; leader: boolean; }
export interface BotConnection { agentId: AgentId | "ORCHESTRATOR"; connected: boolean; botId?: string; username?: string; guildIds: string[]; detail?: string; }

export class MultiBotGateway implements ProtocolSink, DiscordContextSource, DiscordWorkroomPort {
  readonly liveEvidenceSink = true;
  private readonly projectChannelPending = new Map<string, Promise<DiscordProjectChannelSnapshot>>();
  private readonly clients: BoundClient[] = [];
  private readonly discovery: DiscordDiscovery;
  private readonly status: StatusUi;
  readonly workrooms: WorkroomManager;
  private timers: NodeJS.Timeout[] = [];
  private collaboration?: CollaborationService;
  private meeting?: EngineeringMeetingService;
  private performance?: PerformanceService;
  private workerRuntime?: WorkerRuntime;
  private ownerControl?: OwnerControl;
  private readonly humanFeedback: HumanFeedback;
  constructor(private readonly store: Store, private readonly agents: AgentRegistry, private readonly tasks: TaskRepository,
    private readonly adapters: Map<AgentId, AgentAdapter>, private readonly runner: ProcessRunner,
    private readonly trustedBots: TrustedBotRegistry, private readonly inbound: InboundGuard,
    private readonly controlTransport: AsusHermesControlTransport, private readonly models: ModelCatalog, private readonly taskAdmission: TaskAdmission) {
    this.discovery = new DiscordDiscovery(store); this.status = new StatusUi(store, agents); this.workrooms = new WorkroomManager(store, tasks, this);
    this.humanFeedback = new HumanFeedback(store);
  }
  attachCollaboration(service: CollaborationService): void { this.collaboration = service; }
  attachMeeting(service: EngineeringMeetingService): void { this.meeting = service; }
  attachPerformance(service: PerformanceService): void { this.performance = service; }
  attachWorkerRuntime(runtime: WorkerRuntime): void { this.workerRuntime = runtime; }
  attachOwnerControl(control: OwnerControl): void { this.ownerControl = control; }

  configuredAgents(): AgentId[] { return AGENT_IDS.filter((id) => Boolean(config.botTokens[id])); }
  connectionReport(): BotConnection[] {
    const actual = this.clients.map<BotConnection>(({ client, agentId }) => {
      const item: BotConnection = { agentId: agentId ?? "ORCHESTRATOR", connected: client.isReady(), guildIds: [...client.guilds.cache.keys()] };
      if (client.user) { item.botId = client.user.id; item.username = client.user.username; }
      if (!client.isReady()) item.detail = "DISCORD_GATEWAY_NOT_READY";
      return item;
    });
    const observed = new Set(actual.map((item) => item.agentId));
    const missingWorkers = AGENT_IDS.filter((agentId) => !observed.has(agentId)).map((agentId) => ({
      agentId, connected: false, guildIds: [], detail: config.botTokens[agentId] ? "DISCORD_GATEWAY_NOT_STARTED" : "WORKER_DISCORD_CREDENTIAL_MISSING",
      ...(this.agents.get(agentId)?.discordBotId ? { botId: this.agents.get(agentId)!.discordBotId } : {}),
    }));
    return [...actual, ...missingWorkers];
  }
  reconcileWorkerHealth(): void {
    for (const connection of this.connectionReport()) {
      if (connection.agentId === "ORCHESTRATOR" || connection.connected) continue;
      this.agents.setHealth(connection.agentId, { status: "ERROR", detail: connection.detail || "DISCORD_GATEWAY_DISCONNECTED" });
    }
  }
  discoveryReport(): Array<Record<string, unknown>> {
    return this.store.db.prepare(`SELECT guild_id,kind,name,discord_id,parent_id,project_id,task_id
      FROM discord_mappings ORDER BY guild_id,kind,name`).all() as Array<Record<string, unknown>>;
  }
  controlChannelId(): string | undefined {
    const row = this.store.db.prepare(`SELECT discord_id FROM discord_mappings WHERE name='coding-control' AND kind='CHANNEL'
      ORDER BY updated_at DESC LIMIT 1`).get() as { discord_id: string } | undefined;
    return row?.discord_id;
  }
  statusMessageId(): string | undefined {
    const channel = this.store.db.prepare(`SELECT discord_id FROM discord_mappings WHERE name='coding-status' AND kind='CHANNEL'
      ORDER BY updated_at DESC LIMIT 1`).get() as { discord_id: string } | undefined;
    return channel ? this.store.getRuntimeState<string>(`discord:status_message:${channel.discord_id}`) : undefined;
  }
  async messageMetadata(channelId: string, messageId: string): Promise<{ authorId: string; mentionIds: string[] }> {
    const client = this.leader(); if (!client) throw new Error("Discord client unavailable");
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) throw new Error(`Discord channel unavailable: ${channelId}`);
    const message = await channel.messages.fetch(messageId);
    return { authorId: message.author.id, mentionIds: [...message.mentions.users.keys()] };
  }
  async updateStatus(): Promise<void> { const leader = this.leader(); if (leader) await this.status.update(leader); }
  async start(): Promise<void> {
    const definitions: Array<{ token: string; agentId?: AgentId; botType: BotType }> = [];
    if (config.DISCORD_ORCHESTRATOR_BOT_TOKEN) definitions.push({ token: config.DISCORD_ORCHESTRATOR_BOT_TOKEN, botType: "ORCHESTRATOR" });
    for (const agentId of AGENT_IDS) { const token = config.botTokens[agentId]; if (token) definitions.push({ token, agentId, botType: agentToBotType(agentId) }); }
    definitions.forEach((definition, index) => this.addClient(definition.token, definition.botType, definition.agentId, index === 0));
    await Promise.all(this.clients.map(({ client }) => new Promise<void>((resolve, reject) => {
      client.once("clientReady", () => resolve()); client.once("error", reject);
      const definition = definitions[this.clients.findIndex((item) => item.client === client)]!;
      void client.login(definition.token).catch(reject);
    })));
    this.trustedBots.seed();
    const dedicated = Boolean(this.clients.find((item) => item.botType === "ORCHESTRATOR"));
    const controlAvailable = dedicated || await this.controlTransport.availability();
    this.store.upsertRuntimeState("discord:control_identity", {
      status: controlAvailable ? (dedicated ? "DEDICATED" : "FALLBACK_CONTROL_IDENTITY") : "CONTROL_IDENTITY_REQUIRED", at: this.store.now(),
    });
    const leader = this.leader(); if (leader) {
      await this.discovery.reconcile(leader);
      await this.workrooms.reconcileActive();
      await this.status.update(leader);
      this.timers.push(setInterval(() => void this.discovery.reconcile(leader).catch(() => undefined), config.DISCOVERY_INTERVAL_MS));
      this.timers.push(setInterval(() => void this.status.update(leader).catch(() => undefined), 30_000));
    }
  }
  async stop(): Promise<void> { this.timers.forEach(clearInterval); this.timers = []; await Promise.all(this.clients.map(({ client }) => client.destroy())); }
  private leader(): Client | undefined { return this.clients.find((entry) => entry.leader)?.client; }

  private addClient(token: string, botType: BotType, agentId: AgentId | undefined, leader: boolean): void {
    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel, Partials.Message] });
    this.clients.push({ client, ...(agentId ? { agentId } : {}), botType, leader });
    client.on("clientReady", () => {
      if (!agentId || !client.user) return;
      const expected = this.agents.get(agentId)?.discordBotId;
      if (expected && expected !== client.user.id) {
        this.store.upsertRuntimeState(`discord:identity_mismatch:${agentId}`, {
          expected_bot_id: expected, observed_bot_id: client.user.id, at: this.store.now(), allowed: false,
        });
        this.agents.setHealth(agentId, { status: "ERROR", detail: "DISCORD_BOT_ID_MISMATCH" });
        void client.destroy();
        return;
      }
      this.agents.bindDiscord(agentId, client.user.id); this.trustedBots.seed();
    });
    client.on("channelCreate", (channel) => { if (leader && !channel.isDMBased()) this.discovery.record(channel); });
    client.on("channelUpdate", (_old, channel) => { if (leader && !channel.isDMBased()) this.discovery.record(channel); });
    client.on("channelDelete", (channel) => { if (leader && !channel.isDMBased()) this.discovery.remove(channel.id); });
    client.on("threadCreate", (thread) => { if (leader) this.discovery.record(thread); });
    client.on("threadUpdate", (_old, thread) => { if (leader) { this.discovery.record(thread); void this.workrooms.reconcileThread(thread.id).catch(() => undefined); } });
    client.on("threadDelete", (thread) => { if (leader) { this.workrooms.markDeleted(thread.id); this.discovery.remove(thread.id); } });
    client.on("threadListSync", (threads) => { if (leader) for (const thread of threads.values()) { this.discovery.record(thread); void this.workrooms.reconcileThread(thread.id).catch(() => undefined); } });
    client.on("messageCreate", (message) => { void this.onMessage(message, client, botType, leader).catch(async (error) => {
      console.error("worker-inbound-error", { messageId: message.id, currentIdentity: botType, error: safeError(error) });
      if (!message.author.bot && leader) await message.reply(`ERROR: ${safeError(error)}`);
    }); });
  }

  private async onMessage(message: Message, client: Client, currentIdentity: BotType, leader: boolean): Promise<void> {
    if (!message.guild || !message.content || !client.user) return;
    if (config.DISCORD_GUILD_ID && message.guild.id !== config.DISCORD_GUILD_ID) return;
    const input: InboundInput = {
      messageId: message.id, authorId: message.author.id, authorBot: message.author.bot, currentBotId: client.user.id,
      currentIdentity, mentionIds: [...message.mentions.users.keys()], content: message.content, channelId: message.channel.id,
      ...(message.channel.isThread() ? { threadId: message.channel.id } : {}), createdAt: message.createdAt.toISOString(),
    };
    const decision = this.inbound.evaluate(input);
    if (message.author.bot && message.mentions.users.has(client.user.id)) {
      this.store.upsertRuntimeState(`discord:last_mentioned_message:${currentIdentity}`, {
        gateway_received: true,
        message_id: message.id,
        author_id: message.author.id,
        channel_id: message.channel.id,
        thread_id: message.channel.isThread() ? message.channel.id : null,
        event_type: decision.envelope?.event_type || null,
        task_id: decision.envelope?.task_id || null,
        reason: decision.reason,
        allowed: decision.allowed,
        at: this.store.now(),
      });
    }
    if (message.author.bot) {
      if (!decision.allowed) {
        if (decision.reason !== "MENTION_REQUIRED" && decision.reason !== "SELF_MESSAGE" && decision.reason !== "FRAGMENT_PENDING") console.debug("bot-inbound-ignore", { messageId: message.id, reason: decision.reason, currentIdentity });
        return;
      }
      const workerTarget = Boolean(this.workerRuntime && ["TASK", "HANDOFF", "REVISION_REQUEST", "EXPERT_INVITE", "MEETING_INVITE", "EXECUTION_PROPOSAL", "ROLE_ACCEPT", "DEPENDENCY_REPORT", "CAPABILITY_REPORT"].includes(decision.envelope?.event_type || "") && currentIdentity !== "ASUS" && currentIdentity !== "MAIN" && currentIdentity !== "ORCHESTRATOR");
      if (workerTarget && decision.envelope) {
        await this.processInbound(decision.envelope);
        if (["MEETING_INVITE", "EXECUTION_PROPOSAL", "ROLE_ACCEPT", "DEPENDENCY_REPORT", "CAPABILITY_REPORT"].includes(decision.envelope.event_type)) {
          await this.workerRuntime!.receiveMeeting(input, decision.envelope);
        } else {
          await this.workerRuntime!.receive(input, decision.envelope);
        }
        return;
      }
      const claimed = this.inbound.claim(input, decision); if (!claimed.allowed || !claimed.envelope) return;
      await this.processInbound(claimed.envelope);
      this.inbound.processed(message.id); return;
    }
    if (!leader) return;
    // #owner-inbox is natural language, not !command syntax: capture and durably classify the
    // Owner's plain-language reply (no Hermes/LLM inference -- see office/humanFeedback.ts),
    // then acknowledge deterministically. Scoped to this one channel so ordinary chat elsewhere
    // is never silently turned into a feedback/policy record.
    if (isOwnerInboxChannel(message.channel)) {
      const record = this.humanFeedback.capture({
        rawText: message.content, sourceChannelId: message.channel.id, sourceMessageId: message.id, sourceAuthorId: message.author.id,
      });
      await message.reply(acknowledgement(record));
      return;
    }
    const command = parseCommand(message.content); if (!command) return;
    if (["office-pause", "office-resume", "office-full-stop"].includes(command.kind)) {
      if (!config.DISCORD_MAIN_USER_ID || message.author.id !== config.DISCORD_MAIN_USER_ID) {
        this.store.upsertRuntimeState("office:unauthorized_control", { command: command.kind, authorId: message.author.id, at: this.store.now() });
        return;
      }
      if (!this.ownerControl) return;
      const state = command.kind === "office-pause" ? this.ownerControl.pause("Discord Owner command", `DISCORD:${message.author.id}`)
        : command.kind === "office-full-stop" ? this.ownerControl.fullStop("Discord Owner command", `DISCORD:${message.author.id}`)
          : this.ownerControl.resume("Discord Owner command", `DISCORD:${message.author.id}`);
      await message.reply(state.mode === "RUNNING" ? "Owner 승인에 따라 운영을 재개합니다." : "Owner 지시에 따라 새 작업 배정과 자동 복구를 중지했습니다.");
      return;
    }
    if (this.ownerControl?.isPaused() && ["task-assign", "agent-resume"].includes(command.kind)) {
      await message.reply("Owner PAUSE가 적용되어 새 작업 배정과 실행 재개를 받지 않습니다. 명시적인 시작 승인 후 다시 요청해 주세요.");
      return;
    }
    if (command.kind === "runtime-handoff") { await message.reply(this.handoffSummary().slice(0, 1_950)); return; }
    if (command.kind === "agent-status") { await message.reply(this.status.render()); return; }
    if (command.kind === "agent-stop") {
      const taskId = this.agents.get(command.agentId)?.currentTask; const stopped = taskId ? this.runner.cancelTask(taskId) : false;
      if (taskId && stopped) { const cancelled = this.tasks.transition(taskId, "CANCELLED"); await this.workrooms.syncTaskState(cancelled); } await message.reply(stopped ? `Cancelled ${taskId}` : `${command.agentId} has no running task`); return;
    }
    if (command.kind === "agent-resume") { this.agents.release(command.agentId); await message.reply(`${command.agentId} marked AVAILABLE; scheduler will reconcile health.`); return; }
    if (command.kind === "agent-model") {
      if (command.model) { const result = await this.models.setAgentModel(command.agentId, command.model, `DISCORD:${message.author.id}`); await message.reply(result.detail); return; }
      const current = this.models.getCurrentModel(command.agentId); const catalog = current.catalog;
      await message.reply(catalog ? `${command.agentId}: requested=${current.preference?.selectedModel || "CLI_DEFAULT"}; effective=${catalog.observedActualModel || "UNKNOWN"}; provider=${catalog.provider}; verification=${catalog.verificationLevel}` : `${command.agentId}: CLI_DEFAULT; effective=UNKNOWN`); return;
    }
    if (command.kind === "agent-models") {
      const models = this.models.listAgentModels(command.agentId).filter((item) => item.available);
      const lines = models.map((item) => `${item.overrideValue} [${item.verificationLevel}]${item.observedActualModel ? ` -> ${item.observedActualModel}` : ""}`);
      await message.reply((`${command.agentId} models (${lines.length})\n${lines.join("\n")}`).slice(0, 1_950)); return;
    }
    if (command.kind === "performance-agents") { await message.reply((this.performance?.renderAgents({ dataClass: command.dataClass }) || "PERFORMANCE_UNAVAILABLE").slice(0, 1_950)); return; }
    if (command.kind === "performance-agent") { await message.reply((this.performance?.renderAgent(command.agentId, { dataClass: command.dataClass }) || "PERFORMANCE_UNAVAILABLE").slice(0, 1_950)); return; }
    if (command.kind === "performance-role") { await message.reply((this.performance?.renderRole(command.role, { dataClass: command.dataClass }) || "PERFORMANCE_UNAVAILABLE").slice(0, 1_950)); return; }
    if (command.kind === "performance-models") { await message.reply((this.performance?.renderModels(command.agentId, { dataClass: command.dataClass }) || "PERFORMANCE_UNAVAILABLE").slice(0, 1_950)); return; }
    if (command.kind === "performance-project") { await message.reply((this.performance?.renderProject(command.projectId, { dataClass: command.dataClass }) || "PERFORMANCE_UNAVAILABLE").slice(0, 1_950)); return; }
    if (command.kind === "task-status") { const task = this.tasks.get(command.taskId); await message.reply(task ? `Task ${task.taskId}: ${task.status}\nAgent: ${task.assignedAgent || "unassigned"}` : "Task not found"); return; }
    if (command.kind === "task-cancel") { const task = this.tasks.get(command.taskId); if (!task) { await message.reply("Task not found"); return; }
      if (task.assignedAgent) await this.adapters.get(task.assignedAgent)?.cancelTask(task.taskId); const cancelled = this.tasks.transition(task.taskId, "CANCELLED"); await this.workrooms.syncTaskState(cancelled); await message.reply(`Cancelled ${task.taskId}`); return; }
    if (command.kind !== "task-assign") return;
    const p = command.payload; const channel = message.channel; const threadId = channel.isThread() ? channel.id : undefined;
    const parentChannelId = channel.isThread() ? channel.parentId ?? undefined : channel.id;
    const controlOrigin = ("name" in channel && channel.name === "coding-control") || (channel.isThread() && channel.parent?.name === "coding-control");
    if (!String(p.workspace || "")) { await message.reply("workspace=<ASUS local path> is required"); return; }
    try {
      const task = await this.taskAdmission.submit({ ...p, title: p.title || "Discord coding task", projectId: p.projectId || p.project || (channel.isThread() ? channel.parent?.name : "discord-project") }, {
        owner: message.author.id, defaultGoal: message.content,
        ...(threadId && !controlOrigin ? { threadId } : {}), ...(!controlOrigin && parentChannelId ? { projectChannelId: parentChannelId } : {}),
      });
      await message.reply(`Task persisted: ${task.taskId} (${task.status})`);
    } catch (error) { await message.reply(error instanceof Error ? error.message : "Task admission rejected"); }
  }

  private async processInbound(envelope: NativeEnvelope): Promise<void> {
    const existing = this.store.db.prepare("SELECT 1 FROM protocol_events WHERE discord_message_id=?").get(envelope.message_id);
    if (!existing) this.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,discord_message_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(`inbound:${envelope.message_id}`, envelope.task_id, envelope.event_type, envelope.sender,
      envelope.recipient, JSON.stringify(envelope.payload), envelope.message_id, envelope.created_at);
    this.store.upsertRuntimeState("discord:last_native_inbound", { messageId: envelope.message_id, taskId: envelope.task_id,
      eventType: envelope.event_type, sender: envelope.sender, recipient: envelope.recipient, round: envelope.round, processedAt: this.store.now() });
    if (this.meeting && ["MEETING_INVITE", "CAPABILITY_REPORT", "EXECUTION_PROPOSAL", "RESOURCE_REPORT", "MODEL_PROPOSAL", "PARALLEL_PLAN", "DEPENDENCY_REPORT", "BLOCKER", "COUNTER_PROPOSAL", "ROLE_ACCEPT"].includes(envelope.event_type)) {
      await this.meeting.processInbound(envelope.task_id, envelope.sender, envelope.event_type as import("../../collaboration/meeting.js").MeetingEventType,
        String(envelope.payload.body || envelope.payload.content || ""), envelope.payload);
    }
    if (this.collaboration) await this.collaboration.processInbound(envelope);
    this.performance?.safeRefresh(envelope.task_id);
    if (blocksAutomaticReply(envelope.event_type, envelope.status)) return;
    // Workflow services own follow-up actions; passive protocol events never receive an implicit reply here.
  }

  async publish(event: ProtocolEvent, task: TaskRecord): Promise<string | undefined> {
    const controlOnly = event.payload.control_plane === true;
    if (!controlOnly) await this.workrooms.ensure(task);
    const routedTask = this.tasks.get(task.taskId) ?? task;
    const channelId = controlOnly ? await this.resolveMainChannel(routedTask) : routedTask.threadId; if (!channelId) return undefined;
    const deliveryId = randomUUID(); const recipient = /^\d{17,20}$/.test(event.recipient)
      ? { botType: "MAIN" as const, discordBotId: event.recipient, source: "human_task_owner", state: "RESOLVED" as const }
      : this.trustedBots.resolveRecipient(event.recipient);
    if (!recipient?.discordBotId) {
      this.store.db.prepare(`INSERT INTO delivery_records(delivery_id,task_id,channel_id,thread_id,content,state,event_type,sender,recipient,last_error,created_at,updated_at)
        VALUES(?,?,?,?,?,'DELIVERY_BLOCKED_RECIPIENT_UNKNOWN',?,?,?,?,?,?)`)
        .run(deliveryId, task.taskId, channelId, task.threadId ?? null, "", event.type, event.sender, event.recipient,
          "DELIVERY_BLOCKED_RECIPIENT_UNKNOWN", this.store.now(), this.store.now());
      throw new Error(`DELIVERY_BLOCKED_RECIPIENT_UNKNOWN: ${event.recipient}`);
    }
    const sender = this.resolveOutboundSender(event.sender); if (!sender) throw new Error("CONTROL_IDENTITY_REQUIRED");
    const nextOwner = normalizeBotType(String(event.payload.next_owner || event.payload.nextOwner || task.nextOwner || ""));
    const role = String(event.payload.role || task.role).toUpperCase() as Role; const round = Number(event.payload.round ?? 0);
    const envelope: NativeEnvelope = { event_type: event.type, task_id: task.taskId, sender: sender.reportedBy,
      recipient: recipient.botType, role, ...(typeof event.payload.status === "string" ? { status: event.payload.status } : {}),
      ...(event.payload.sender_role ? { sender_role: String(event.payload.sender_role).toUpperCase() as Role } : {}),
      ...(event.payload.recipient_role ? { recipient_role: String(event.payload.recipient_role).toUpperCase() as Role } : {}),
      ...(event.payload.discussion_topic ? { discussion_topic: String(event.payload.discussion_topic) } : {}),
      ...(event.payload.topic_id ? { topic_id: String(event.payload.topic_id) } : {}),
      ...(event.payload.parent_event_id ? { parent_event_id: String(event.payload.parent_event_id) } : {}),
      ...(nextOwner ? { next_owner: nextOwner } : {}), round: Number.isInteger(round) ? round : 0, message_id: "PENDING",
      ...(routedTask.threadId ? { thread_id: routedTask.threadId } : {}), created_at: event.createdAt, payload: compactPayload(event.payload),
      reported_by: sender.reportedBy, ...(sender.originalAgent ? { original_agent: sender.originalAgent } : {}),
      ...(sender.fallbackReason ? { fallback_reason: sender.fallbackReason } : {}) };
    const recipientBotId = recipient.discordBotId;
    const mention = `<@${recipientBotId}>`;
    // Every physical message we send must stay at/under this so neither discord.js nor the
    // external ASUS relay CLI fallback (controlTransport.ts) ever needs to invent its own,
    // metadata-free split -- that opaque splitting is what made oversized envelopes
    // unparseable on receipt. We do our own bounded, metadata-tagged chunking instead; see
    // buildEnvelopeWireFragments. A single-fragment envelope behaves exactly as before.
    const wireFragments = buildEnvelopeWireFragments(envelope, Math.max(200, 1_950 - mention.length - 2));
    const contents = wireFragments.map((wire, index) => {
      const displayBudget = Math.max(0, 1_950 - wire.length - mention.length - 2);
      const displaySource = index === 0 ? redact(renderOfficeMessage(event.type, event.payload, envelope))
        : `↳ (${index + 1}/${wireFragments.length})`;
      const display = displaySource.slice(0, displayBudget);
      // Keep the invisible machine envelope intact. Discord truncates by UTF-16
      // code units, so truncate only the human layer and never the protocol tail.
      return ensureRecipientMention(`${display}\n${wire}`, recipientBotId);
    });
    this.store.db.prepare(`INSERT INTO delivery_records(delivery_id,task_id,channel_id,thread_id,content,state,event_type,sender,recipient,
      reported_by,original_agent,fallback_reason,created_at,updated_at) VALUES(?,?,?,?,?,'CREATED',?,?,?,?,?,?,?,?)`)
      .run(deliveryId, task.taskId, channelId, routedTask.threadId ?? null, contents[0]!, event.type, event.sender, recipient.botType,
        sender.reportedBy, sender.originalAgent ?? null, sender.fallbackReason ?? null, this.store.now(), this.store.now());
    try {
      this.store.db.prepare("UPDATE delivery_records SET state='ATTEMPTING',attempts=attempts+1,updated_at=? WHERE delivery_id=?").run(this.store.now(), deliveryId);
      const messageIds: string[] = [];
      for (const fragmentContent of contents) messageIds.push(await this.sendPrepared(sender, channelId, fragmentContent));
      const finalMessageId = messageIds[messageIds.length - 1]!;
      if (contents.length > 1) this.store.upsertRuntimeState(`discord:last_fragmented_publish:${deliveryId}`,
        { taskId: task.taskId, eventType: event.type, fragmentCount: contents.length, messageIds, at: this.store.now() });
      const received = this.store.db.prepare("SELECT state FROM inbound_messages WHERE discord_message_id=?").get(finalMessageId) as { state: string } | undefined;
      this.store.db.prepare("UPDATE delivery_records SET state=?,discord_message_id=?,updated_at=? WHERE delivery_id=?")
        .run(received?.state || "SENT", finalMessageId, this.store.now(), deliveryId);
      return finalMessageId;
    } catch (error) {
      this.store.db.prepare("UPDATE delivery_records SET state='FAILED',last_error=?,updated_at=? WHERE delivery_id=?").run(safeError(error), this.store.now(), deliveryId); throw error;
    }
  }

  async ensureProjectChannel(projectId: string, projectName: string): Promise<DiscordProjectChannelSnapshot> {
    const key = normalizeDiscordLabel(projectId || projectName);
    const pending = this.projectChannelPending.get(key); if (pending) return pending;
    const operation = this.ensureProjectChannelOnce(projectId, projectName).finally(() => this.projectChannelPending.delete(key));
    this.projectChannelPending.set(key, operation); return operation;
  }

  private async ensureProjectChannelOnce(projectId: string, projectName: string): Promise<DiscordProjectChannelSnapshot> {
    const client = this.leader(); if (!client?.user) throw new Error("PROJECT_CHANNEL_ACCESS_DENIED: Discord client unavailable");
    const guild = config.DISCORD_GUILD_ID ? await client.guilds.fetch(config.DISCORD_GUILD_ID) : client.guilds.cache.first();
    if (!guild) throw new Error("PROJECT_CHANNEL_GUILD_NOT_FOUND");
    await guild.channels.fetch();
    const me = guild.members.me; if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error("PROJECT_CHANNEL_ACCESS_DENIED");
    let category = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && isProjectsCategory(channel.name));
    category ??= await guild.channels.create({ name: "PROJECTS", type: ChannelType.GuildCategory, reason: "SYMPHONY Project Router" });
    const desired = normalizeDiscordLabel(projectId || projectName);
    const existing = guild.channels.cache.find((channel) => channel.parentId === category!.id && channel.type === ChannelType.GuildText && normalizeDiscordLabel(channel.name) === desired);
    const channel = existing ?? await guild.channels.create({ name: desired, type: ChannelType.GuildText, parent: category.id,
      topic: `HERMESS PROJECT_ID: ${projectId}`, reason: "SYMPHONY Project Router" });
    this.discovery.record(category); this.discovery.record(channel);
    return { id: channel.id, name: channel.name, categoryId: category.id };
  }

  private async resolveMainChannel(task: TaskRecord): Promise<string | undefined> {
    const client = this.leader(); if (!client) return task.parentChannelId;
    const guild = config.DISCORD_GUILD_ID ? await client.guilds.fetch(config.DISCORD_GUILD_ID) : client.guilds.cache.first();
    await guild?.channels.fetch();
    const main = guild?.channels.cache.find((channel) => channel.type === ChannelType.GuildText && normalizeDiscordLabel(channel.name) === "main");
    return main?.id || task.parentChannelId;
  }

  private resolveOutboundSender(senderValue: string): { reportedBy: BotType; client?: Client; originalAgent?: string; fallbackReason?: string } | undefined {
    const requested = normalizeBotType(senderValue);
    if (requested && !["ORCHESTRATOR", "MAIN", "ASUS"].includes(requested)) {
      const worker = this.clients.find((entry) => entry.botType === requested);
      return worker ? { reportedBy: requested, client: worker.client } : undefined;
    }
    const dedicated = this.clients.find((entry) => entry.botType === "ORCHESTRATOR");
    if (dedicated) return { reportedBy: "ORCHESTRATOR", client: dedicated.client };
    const asus = this.trustedBots.resolveRecipient("ASUS", false);
    return asus?.discordBotId ? { reportedBy: "ASUS", originalAgent: senderValue, fallbackReason: "DEDICATED_ORCHESTRATOR_UNAVAILABLE" } : undefined;
  }

  private async sendPrepared(sender: { client?: Client }, channelId: string, content: string): Promise<string> {
    if (!sender.client) return (await this.controlTransport.send(channelId, content)).messageId;
    const channel = await sender.client.channels.fetch(channelId) as TextBasedChannel | null;
    if (!channel?.isSendable()) throw new Error(`Discord channel not sendable: ${channelId}`);
    return (await channel.send({ content, allowedMentions: { users: extractMentionIds(content), roles: [], repliedUser: false } })).id;
  }

  async alert(message: string): Promise<void> {
    const client = this.leader(); if (!client) return;
    const digest = createHash("sha256").update(message).digest("hex");
    const last = this.store.getRuntimeState<{ digest: string; at: string }>("discord:last_alert");
    if (last?.digest === digest && Date.now() - Date.parse(last.at) < 3_600_000) return;
    const channel = client.channels.cache.find((candidate) => candidate.isTextBased() && "name" in candidate && candidate.name === "coding-alerts");
    if (!channel?.isSendable()) return;
    await channel.send(`**HERMESS ALERT**\n${redact(message).slice(0, 1_900)}`);
    this.store.upsertRuntimeState("discord:last_alert", { digest, at: this.store.now() });
  }

  async recoverPendingDeliveries(): Promise<number> {
    const rows = this.store.db.prepare("SELECT * FROM delivery_records WHERE state IN ('pending','CREATED') ORDER BY created_at").all() as Array<{ delivery_id: string; channel_id: string; content: string; sender: string | null }>;
    let delivered = 0;
    for (const row of rows) {
      try {
        this.store.db.prepare("UPDATE delivery_records SET state='ATTEMPTING',attempts=attempts+1,updated_at=? WHERE delivery_id=?").run(this.store.now(), row.delivery_id);
        const sender = this.resolveOutboundSender(row.sender || "ORCHESTRATOR"); if (!sender) throw new Error("CONTROL_IDENTITY_REQUIRED");
        const messageId = await this.sendPrepared(sender, row.channel_id, row.content);
        this.store.db.prepare("UPDATE delivery_records SET state='SENT',discord_message_id=?,updated_at=? WHERE delivery_id=?").run(messageId, this.store.now(), row.delivery_id); delivered++;
      } catch (error) { this.store.db.prepare("UPDATE delivery_records SET state='FAILED',last_error=?,updated_at=? WHERE delivery_id=?").run(safeError(error), this.store.now(), row.delivery_id); }
    }
    return delivered;
  }

  async fetchThread(threadId: string, limit = 100): Promise<DiscordContextMessage[]> { return this.fetchMessages(threadId, limit); }
  async fetchChannel(channelId: string, limit = 50): Promise<DiscordContextMessage[]> { return this.fetchMessages(channelId, limit); }
  private async fetchMessages(channelId: string, limit: number): Promise<DiscordContextMessage[]> {
    const client = this.leader(); if (!client) return []; const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("messages" in channel)) return [];
    const messages = await channel.messages.fetch({ limit: Math.min(limit, 100) });
    return [...messages.values()].reverse().map((message) => ({ source: channelId, author: message.author.username, content: redact(message.content), timestamp: message.createdAt.toISOString() }));
  }

  handoffSummary(): string {
    const tasks = this.store.db.prepare(`SELECT task_id,project_id,status,assigned_agent,title,updated_at FROM tasks
      WHERE status NOT IN ('PASS','FAIL','CANCELLED') ORDER BY updated_at DESC LIMIT 30`).all() as Record<string, unknown>[];
    const lines = ["**HERMESS ASUS Runtime Handoff**", `State: persistent SQLite @ ${config.databasePath}`, "", "Agents:"];
    for (const agent of this.agents.list()) lines.push(`- ${agent.agentId}: ${agent.status}/${agent.health}${agent.currentTask ? ` task=${agent.currentTask}` : ""}`);
    lines.push("", "Active / gated tasks:");
    if (!tasks.length) lines.push("- none");
    else for (const task of tasks) lines.push(`- ${task.task_id} [${task.status}] ${task.title} (${task.assigned_agent || "unassigned"})`);
    return lines.join("\n");
  }

  async getThread(threadId: string): Promise<DiscordThreadSnapshot | undefined> {
    const client = this.leader(); if (!client?.user) return undefined;
    try {
      const channel = await client.channels.fetch(threadId); if (!channel?.isThread()) return undefined;
      const permissions = channel.permissionsFor(client.user);
      return { id: channel.id, parentId: channel.parentId || "UNKNOWN", name: channel.name, archived: Boolean(channel.archived),
        canView: Boolean(permissions?.has(PermissionFlagsBits.ViewChannel)), canSend: Boolean(permissions?.has(PermissionFlagsBits.SendMessagesInThreads)) };
    } catch { return undefined; }
  }

  async createPublicThread(parentChannelId: string, name: string): Promise<DiscordThreadSnapshot> {
    const client = this.leader(); if (!client?.user) throw new Error("THREAD_ACCESS_DENIED: Discord client unavailable");
    const parent = await client.channels.fetch(parentChannelId);
    if (!parent || parent.type !== ChannelType.GuildText) throw new Error("THREAD_ACCESS_DENIED: parent is not a public text channel");
    const permissions = parent.permissionsFor(client.user);
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.CreatePublicThreads)
      || !permissions.has(PermissionFlagsBits.SendMessagesInThreads)) throw new Error("THREAD_ACCESS_DENIED");
    const thread = await parent.threads.create({ name, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, reason: "SYMPHONY Task Workroom" });
    this.discovery.record(thread); return (await this.getThread(thread.id))!;
  }

  async setThreadArchived(threadId: string, archived: boolean): Promise<DiscordThreadSnapshot> {
    const client = this.leader(); if (!client) throw new Error("THREAD_ACCESS_DENIED");
    const channel = await client.channels.fetch(threadId); if (!channel?.isThread()) throw new Error("WORKROOM_MISSING");
    await channel.setArchived(archived, `SYMPHONY Workroom ${archived ? "final PASS/CANCELLED" : "active Task reuse"}`);
    this.discovery.record(channel); return (await this.getThread(threadId))!;
  }

  async sendBootstrap(threadId: string, content: string): Promise<string> {
    return (await this.controlTransport.send(threadId, redact(content))).messageId;
  }

  async sendControlMessage(threadId: string, content: string): Promise<string> { return this.sendBootstrap(threadId, content); }

  async pinMessage(threadId: string, messageId: string): Promise<void> {
    const client = this.leader(); if (!client) return;
    const channel = await client.channels.fetch(threadId); if (!channel?.isThread()) return;
    const message = await channel.messages.fetch(messageId); if (message.pinnable) await message.pin("SYMPHONY Workroom Task Brief");
  }
}

// V0 bridge: until #owner-inbox exists (blocked on a Discord permission -- see Sprint 01
// report), an interim thread under #coding-control stands in for it. Matching by name here
// (rather than a hardcoded thread id) means this keeps working across restarts and if the
// interim thread is recreated, and self-retires the moment the real channel exists and this
// V0 naming convention is retired.
const INTERIM_OWNER_INBOX_THREAD_NAME = "오너 인박스";
export function isOwnerInboxChannel(channel: Message["channel"]): boolean {
  if ("name" in channel && channel.name === "owner-inbox") return true;
  if (channel.isThread() && channel.parent?.name === "owner-inbox") return true;
  if (channel.isThread() && channel.name?.includes(INTERIM_OWNER_INBOX_THREAD_NAME) && channel.parent?.name === "coding-control") return true;
  return false;
}
function extractMentionIds(content: string): string[] { return [...content.matchAll(/<@(\d+)>/g)].map((match) => match[1]!).filter((id, i, all) => all.indexOf(id) === i); }
function compactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.meeting === true) {
    return { meeting: true, session_id: String(payload.session_id || ""), body: String(payload.body || payload.content || "").slice(0, 300), content: String(payload.content || payload.body || "").slice(0, 300),
      ...(payload.decision ? { decision: String(payload.decision) } : {}), ...(payload.requested_state ? { requested_state: String(payload.requested_state) } : {}), ...(payload.state ? { state: String(payload.state) } : {}) };
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") output[key] = value.slice(0, 180);
    else if (Array.isArray(value)) output[key] = value.slice(0, 3).map((item) => typeof item === "string" ? item.slice(0, 80) : item);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) output[key] = value;
  }
  const serialized = JSON.stringify(output);
  return serialized.length <= 600 ? output : { truncated: true, summary: serialized.slice(0, 480) };
}
