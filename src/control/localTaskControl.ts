import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { TaskAdmission } from "../tasks/taskAdmission.js";

export interface MaintenanceShutdownAccepted { accepted: true; onAccepted: () => void | Promise<void>; alreadyRequested?: boolean; }
export interface MaintenanceShutdownRejected { accepted: false; error: string; }
export interface AsusProposalConsumptionResult { observationId: string; taskId: string; status: string; continued: boolean; }
export interface DispatchRedriveControlResult { recoveryId: string; taskId: string; priorAssignment: string; status: string; }
export interface BindingReconcileControlResult { reconciliationId: string; taskId: string; oldBaseSha: string; newBaseSha: string; status: string; }
export interface LocalTaskControlOptions { host: string; port: number; token: string; maintenanceShutdown?: () => MaintenanceShutdownAccepted | MaintenanceShutdownRejected; asusProposalConsumer?: (taskId: string, acceptanceId: string) => Promise<AsusProposalConsumptionResult>; dispatchRedrive?: (taskId: string, recoveryId: string, reason: string) => Promise<DispatchRedriveControlResult>; bindingReconcile?: (taskId: string, reconciliationId: string, expectedOldBaseSha: string, approvedNewSha: string, reason: string) => BindingReconcileControlResult; }

export class LocalTaskControl {
  private server: Server | undefined;
  private maintenanceShutdown?: LocalTaskControlOptions["maintenanceShutdown"];
  private asusProposalConsumer?: LocalTaskControlOptions["asusProposalConsumer"];
  private dispatchRedrive?: LocalTaskControlOptions["dispatchRedrive"];
  private bindingReconcile?: LocalTaskControlOptions["bindingReconcile"];
  constructor(private readonly admission: TaskAdmission, private readonly options: LocalTaskControlOptions) {
    if (!isLoopback(options.host)) throw new Error("CONTROL_HOST_MUST_BE_LOOPBACK");
    if (!options.token) throw new Error("CONTROL_TOKEN_REQUIRED");
    this.maintenanceShutdown = options.maintenanceShutdown;
    this.asusProposalConsumer = options.asusProposalConsumer;
    this.dispatchRedrive = options.dispatchRedrive;
    this.bindingReconcile = options.bindingReconcile;
  }
  setMaintenanceShutdown(handler: NonNullable<LocalTaskControlOptions["maintenanceShutdown"]>): void { this.maintenanceShutdown = handler; }
  setAsusProposalConsumer(handler: NonNullable<LocalTaskControlOptions["asusProposalConsumer"]>): void { this.asusProposalConsumer = handler; }
  setDispatchRedrive(handler: NonNullable<LocalTaskControlOptions["dispatchRedrive"]>): void { this.dispatchRedrive = handler; }
  setBindingReconcile(handler: NonNullable<LocalTaskControlOptions["bindingReconcile"]>): void { this.bindingReconcile = handler; }
  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => void this.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.options.port, this.options.host, resolve); });
    } catch (error) {
      // A failed listen leaves a Server object behind, but it was never running.
      // Clear ownership so runtime startup cleanup cannot turn the real bind
      // failure into ERR_SERVER_NOT_RUNNING from a second close attempt.
      this.server = undefined;
      throw error;
    }
  }
  async close(): Promise<void> { const server = this.server; this.server = undefined; if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  address(): { host: string; port: number } | undefined { const address = this.server?.address(); return address && typeof address === "object" ? { host: address.address, port: address.port } : undefined; }
  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST" || request.url !== "/control") return reply(response, 404, { accepted: false, error: "UNKNOWN_COMMAND" });
    if (!authorized(request.headers.authorization, this.options.token)) return reply(response, 401, { accepted: false, error: "AUTHENTICATION_REJECTED" });
    try {
      const body = await readJson(request);
      if (body.command === "GET_TASK_STATUS") {
        const taskId = String(body.task_id || ""); if (!taskId) return reply(response, 400, { accepted: false, request_id: body.request_id, error: "MALFORMED_REQUEST" });
        const task = this.admission.status(taskId); return task
          ? reply(response, 200, { accepted: true, task_id: task.taskId, status: task.status, request_id: body.request_id })
          : reply(response, 404, { accepted: false, task_id: taskId, request_id: body.request_id, error: "TASK_NOT_FOUND" });
      }
      if (body.command === "CONTINUE_TASK") {
        const taskId = String(body.task_id || ""); if (!taskId) return reply(response, 400, { accepted: false, request_id: body.request_id, error: "MALFORMED_REQUEST" });
        const result = await this.admission.continueTask(taskId);
        return reply(response, 200, { accepted: true, task_id: result.task.taskId, status: result.task.status, continued: result.continued, request_id: body.request_id });
      }
      if (body.command === "MAINTENANCE_SHUTDOWN") {
        if (Object.keys(body).some((key) => !["command", "request_id"].includes(key))) return reply(response, 400, { accepted: false, request_id: body.request_id, error: "MALFORMED_REQUEST" });
        const result = this.maintenanceShutdown?.();
        if (!result) return reply(response, 503, { accepted: false, request_id: body.request_id, error: "MAINTENANCE_UNAVAILABLE" });
        if (!result.accepted) return reply(response, 409, { accepted: false, request_id: body.request_id, error: result.error });
        reply(response, 202, { accepted: true, already_requested: result.alreadyRequested === true, request_id: body.request_id });
        setImmediate(() => void result.onAccepted());
        return;
      }
      if (body.command === "CONSUME_ASUS_PROPOSAL") {
        const taskId = String(body.task_id || ""); const acceptanceId = String(body.acceptance_id || "");
        if (!taskId || !acceptanceId || Object.keys(body).some((key) => !["command", "task_id", "acceptance_id", "request_id"].includes(key)))
          return reply(response, 400, { accepted: false, request_id: body.request_id, error: "MALFORMED_REQUEST" });
        if (!this.asusProposalConsumer) return reply(response, 503, { accepted: false, request_id: body.request_id, error: "ASUS_PROPOSAL_CONSUMPTION_UNAVAILABLE" });
        const result = await this.asusProposalConsumer(taskId, acceptanceId);
        return reply(response, 200, { accepted: true, request_id: body.request_id, observation_id: result.observationId, task_id: result.taskId, status: result.status, continued: result.continued });
      }
      if (body.command === "REDRIVE_RUNTIME_DISPATCH") {
        const taskId = String(body.task_id || ""); const recoveryId = String(body.recovery_id || ""); const reason = String(body.reason || "");
        if (!taskId || !recoveryId || !reason || Object.keys(body).some((key) => !["command", "task_id", "recovery_id", "reason", "request_id"].includes(key)))
          return reply(response, 400, { accepted: false, request_id: body.request_id, error: "MALFORMED_REQUEST" });
        if (!this.dispatchRedrive) return reply(response, 503, { accepted: false, request_id: body.request_id, error: "DISPATCH_RECOVERY_UNAVAILABLE" });
        const result = await this.dispatchRedrive(taskId, recoveryId, reason);
        return reply(response, 200, { accepted: true, request_id: body.request_id, recovery_id: result.recoveryId, task_id: result.taskId, prior_assignment: result.priorAssignment, status: result.status });
      }
      if (body.command === "RECONCILE_EXECUTION_BINDING") {
        const taskId = String(body.task_id || ""); const reconciliationId = String(body.reconciliation_id || "");
        const oldSha = String(body.expected_old_base_sha || ""); const newSha = String(body.approved_new_sha || ""); const reason = String(body.reason || "");
        if (!taskId || !reconciliationId || !oldSha || !newSha || !reason || Object.keys(body).some((key) => !["command", "task_id", "reconciliation_id", "expected_old_base_sha", "approved_new_sha", "reason", "request_id"].includes(key)))
          return reply(response, 400, { accepted: false, request_id: body.request_id, error: "MALFORMED_REQUEST" });
        if (!this.bindingReconcile) return reply(response, 503, { accepted: false, request_id: body.request_id, error: "BINDING_RECONCILIATION_UNAVAILABLE" });
        const result = this.bindingReconcile(taskId, reconciliationId, oldSha, newSha, reason);
        return reply(response, 200, { accepted: true, request_id: body.request_id, reconciliation_id: result.reconciliationId, task_id: result.taskId, old_base_sha: result.oldBaseSha, new_base_sha: result.newBaseSha, status: result.status });
      }
      if (body.command !== "SUBMIT_TASK") return reply(response, 400, { accepted: false, request_id: body.request_id, error: "UNKNOWN_COMMAND" });
      if (!body.task || typeof body.task !== "object" || Array.isArray(body.task)) return reply(response, 400, { accepted: false, request_id: body.request_id, error: "MALFORMED_REQUEST" });
      const task = await this.admission.submit(body.task as Record<string, unknown>, { owner: caller(body.caller), defaultGoal: "Machine control task" });
      return reply(response, 202, { accepted: true, task_id: task.taskId, request_id: body.request_id });
    } catch (error) {
      const classification = typeof error === "object" && error && "classification" in error ? String(error.classification) : error instanceof SyntaxError ? "MALFORMED_REQUEST" : "ADMISSION_REJECTED";
      return reply(response, 400, { accepted: false, error: classification });
    }
  }
}

function isLoopback(host: string): boolean { return host === "127.0.0.1" || host === "::1" || host === "localhost"; }
function authorized(header: string | undefined, secret: string): boolean { if (!header?.startsWith("Bearer ")) return false; const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected); }
function caller(value: unknown): string { if (!value || typeof value !== "object" || Array.isArray(value)) return "LOCAL_CONTROL"; const type = String((value as Record<string, unknown>).type || "LOCAL_CONTROL").slice(0, 40); const id = String((value as Record<string, unknown>).id || "trusted-caller").slice(0, 80); return `${type}:${id}`; }
async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 64 * 1024) throw new SyntaxError("REQUEST_TOO_LARGE"); chunks.push(bytes); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("INVALID_JSON_OBJECT"); return value as Record<string, unknown>; }
function reply(response: import("node:http").ServerResponse, status: number, body: Record<string, unknown>): void { response.statusCode = status; response.end(JSON.stringify(body)); }
