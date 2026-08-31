export interface SubmitTaskRequest { endpoint: string; token: string; requestId?: string; caller?: { type: string; id: string }; task: Record<string, unknown>; }
export interface SubmitTaskResponse { accepted: boolean; task_id?: string; request_id?: string; error?: string; }
export interface TaskStatusResponse extends SubmitTaskResponse { status?: string; }

export async function submitTask(request: SubmitTaskRequest): Promise<SubmitTaskResponse> {
  let response: Response;
  try { response = await fetch(new URL("/control", request.endpoint), { method: "POST", headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "SUBMIT_TASK", request_id: request.requestId, caller: request.caller, task: request.task }) }); }
  catch { throw new Error("CONTROL_RUNTIME_UNAVAILABLE"); }
  const body = await response.json().catch(() => ({ accepted: false, error: "INCOMPATIBLE_CONTROL_RESPONSE" })) as SubmitTaskResponse;
  if (!response.ok && !body.error) throw new Error("INCOMPATIBLE_CONTROL_RESPONSE"); return body;
}

export async function getTaskStatus(request: { endpoint: string; token: string; taskId: string; requestId?: string }): Promise<TaskStatusResponse> {
  let response: Response;
  try { response = await fetch(new URL("/control", request.endpoint), { method: "POST", headers: { authorization: `Bearer ${request.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: "GET_TASK_STATUS", request_id: request.requestId, task_id: request.taskId }) }); }
  catch { throw new Error("CONTROL_RUNTIME_UNAVAILABLE"); }
  return response.json().catch(() => ({ accepted: false, error: "INCOMPATIBLE_CONTROL_RESPONSE" })) as Promise<TaskStatusResponse>;
}
