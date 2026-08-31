import type { NativeEnvelope, NativeEventType } from "../control/types.js";

const STREAM_NOISE = /^(?:step_start|step_end|tool_use|tool_result|model_request_start|model_request_end|thinking_start|thinking_delta|traceId|sessionID|runner_event)\b/i;
const PROTOCOL_NOISE = /^(?:ACK|RESULT|REVIEW|QA_RESULT)(?:\s*[:.]|$)/i;
const OFFICE_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2060-\u2064\uFEFF]/g;
const MOJIBAKE_MARKERS = /\uFFFD|媛|留|蹂|寃|덉뒿|뚯씪|꾩슜/g;

const agentNames: Record<string, string> = {
  ASUS: "ASUS", CODEX: "Codex", CLAUDE: "ClaudeCode", OPENCODE: "OpenCode", COMMANDCODE: "CommandCode", MAIN: "Main",
};

const ko = {
  employee: "\uc9c1\uc6d0", work: "\uc791\uc5c5", development: "\uac1c\ubc1c", review: "\ub9ac\ubdf0", validation: "\uac80\uc99d", design: "\uc124\uacc4", investigation: "\uc870\uc0ac",
  confirmed: "\ud655\uc778\ud588\uc2b5\ub2c8\ub2e4.", accepted: "\uc81c\uac00 \uc774 \uc791\uc5c5\uc744 \ub9e1\uaca0\uc2b5\ub2c8\ub2e4.",
  boundedRead: "\uc77d\uae30 \uc804\uc6a9 \ubc94\uc704\uc5d0\uc11c \uacb0\uacfc\ub97c \ud655\uc778\ud574 \ubcf4\uace0\ud558\uaca0\uc2b5\ub2c8\ub2e4.",
  noChanges: "\ud30c\uc77c \ubcc0\uacbd \uc5c6\uc774 bounded \ud655\uc778\uc744 \uc644\ub8cc\ud588\uc2b5\ub2c8\ub2e4.",
  independentReview: "\ub3c5\ub9bd \uac80\ud1a0\ub97c \ub9c8\uce58\uaca0\uc2b5\ub2c8\ub2e4.",
  aligned: "\ud604\uc7ac \uc218\uc815\uc740 Worker Runtime \uad6c\uc870\uc640 \uc77c\uce58\ud569\ub2c8\ub2e4.",
  noAdditional: "\ucd94\uac00 \ubb38\uc81c\ub97c \ubc1c\uacac\ud558\uc9c0 \ubabb\ud588\uc2b5\ub2c8\ub2e4.",
  validationDone: "\uac80\uc99d\uc744 \ub9c8\uce58\uaca0\uc2b5\ub2c8\ub2e4.",
  problem: "\ubb38\uc81c\uac00 \ud558\ub098 \uc788\uc2b5\ub2c8\ub2e4.",
  handoff: "\ub2e4\uc74c \ub2f4\ub2f9\uc790\uc5d0\uac8c \uc791\uc5c5\uc744 \ub118\uae30\uaca0\uc2b5\ub2c8\ub2e4.",
  meetingScope: "\ud68c\uc758 \ubc94\uc704\uc640 \ub2e4\uc74c dependency\ub97c \ud655\uc778\ud558\uaca0\uc2b5\ub2c8\ub2e4.",
  opinion: "\uc758\uacac\uc744 \uacf5\uc720\ud569\ub2c8\ub2e4.", expert: "\uc804\ubb38\uac00 \ud655\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.",
  analyzing: "\ubd84\uc11d \uc911\uc785\ub2c8\ub2e4.", next: "\ub2e4\uc74c \uc791\uc5c5\uc744 \uc9c4\ud589\ud558\uaca0\uc2b5\ub2c8\ub2e4.",
  result: "\uacb0\uacfc\ub97c \uacf5\uc720\ud569\ub2c8\ub2e4.", exists: "\uc874\uc7ac\ud568", currentBranch: "\ud604\uc7ac Git branch", fileChanges: "\ud30c\uc77c \ubcc0\uacbd\uc740 \uc5c6\uc2b5\ub2c8\ub2e4.",
  productChanges: "Product \ud30c\uc77c \ubcc0\uacbd\ub3c4 \uc5c6\uc2b5\ub2c8\ub2e4.", readOnly: "\uc77d\uae30 \uc804\uc6a9 \ud655\uc778\uc785\ub2c8\ub2e4.",
  completed: "bounded \uc2e4\ud589\uc744 \uc644\ub8cc\ud588\uc2b5\ub2c8\ub2e4.",
};

function cleanOfficeText(value: unknown): string {
  return String(value ?? "").normalize("NFC").replace(OFFICE_CONTROL_CHARS, "").replace(/\r\n?/g, "\n").trim();
}

function visibleOfficeText(value: unknown, fallback: string): string {
  const text = cleanOfficeText(value);
  const markers = text.match(MOJIBAKE_MARKERS)?.length || 0;
  return markers >= 2 || (text.match(/\?/g)?.length || 0) >= 4 ? fallback : text;
}

function agentLabel(value: unknown): string { const key = String(value || "").toUpperCase(); return agentNames[key] || cleanOfficeText(value) || ko.employee; }

function extractText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return ["summary", "result", "output", "text", "message", "content", "detail"].flatMap((key) => record[key] === undefined ? [] : extractText(record[key]));
}

function normalizeTechnicalLine(line: string): string {
  return line.replace(/^Changed files:/i, "\ubcc0\uacbd \ud30c\uc77c:")
    .replace(/^Validation:/i, "\uac80\uc99d:").replace(/^Evidence:/i, "\uadfc\uac70:")
    .replace(/^Blockers:/i, "\ucc28\ub2e8 \uc6d0\uc778:").replace(/^Human decision required:/i, "Owner \ud310\ub2e8 \ud544\uc694:")
    .replace(/^Git branch:/i, `${ko.currentBranch}:`).replace(/^(README\.md|package\.json): exists$/i, `$1: ${ko.exists}`);
}

function cleanResult(value: unknown): string {
  const raw = cleanOfficeText(extractText(value).join("\n"));
  if (!raw) return `${ko.completed} \uc0c1\uc138 evidence\ub294 \ub0b4\ubd80\uc5d0 \ubcf4\uad00\ud569\ub2c8\ub2e4.`;
  const lines: string[] = [];
  for (const source of raw.split("\n")) {
    const line = visibleOfficeText(source, "").replace(/^[-*]\s*/, "");
    if (!line || STREAM_NOISE.test(line) || PROTOCOL_NOISE.test(line)) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const nested = extractText(parsed).map(cleanOfficeText).filter((item) => item && !STREAM_NOISE.test(item));
      if (nested.length) lines.push(...nested);
      continue;
    } catch { /* ordinary human-readable output */ }
    if (/^(?:\{.*\}|\[.*\])$/.test(line)) continue;
    lines.push(normalizeTechnicalLine(line));
  }
  const unique = [...new Set(lines.map((line) => cleanOfficeText(line).replace(/\s+/g, " ")).filter(Boolean))];
  return unique.length ? unique.slice(0, 6).map((line) => `- ${line.slice(0, 260)}`).join("\n") : `${ko.completed} \uc0c1\uc138 evidence\ub294 \ub0b4\ubd80\uc5d0 \ubcf4\uad00\ud569\ub2c8\ub2e4.`;
}

function roleLabel(value: unknown): string {
  const role = String(value || "DEVELOPER").toUpperCase();
  return ({ DEVELOPER: ko.development, REVIEWER: ko.review, QA: ko.validation, ARCHITECT: ko.design, INVESTIGATOR: ko.investigation } as Record<string, string>)[role] || cleanOfficeText(value) || ko.work;
}

function bodyText(payload: Record<string, unknown>, fallback: string): string { return visibleOfficeText(payload.body || payload.content || payload.message || fallback, fallback); }

/** Human-facing office rendering. Structured event data remains in the envelope/evidence layer. */
export function renderOfficeMessage(type: NativeEventType | string, payload: Record<string, unknown>, envelope: NativeEnvelope): string {
  const sender = agentLabel(envelope.sender); const role = roleLabel(envelope.role); let message: string;
  switch (type) {
    case "TASK": message = `${ko.confirmed} ${role} ${ko.work}\uc744 \ub9e1\uaca0\uc2b5\ub2c8\ub2e4. ${ko.boundedRead}`; break;
    case "ACK": message = `${ko.confirmed} ${ko.accepted}`; break;
    case "RESULT": message = `${ko.confirmed}\n${cleanResult(payload.result || payload.output || payload.message)}\n\n${ko.noChanges}`; break;
    case "REVIEW": {
      const verdict = String(payload.verdict || "").toUpperCase();
      if (verdict === "REVIEW_PASS") message = `${ko.independentReview} ${ko.aligned} ${ko.productChanges} ${ko.noAdditional}`;
      else if (verdict === "REVISION_REQUIRED") message = `${ko.problem}\n${cleanResult(payload.findings || payload.evidence)}\n\uc218\uc815 \ud6c4 \ub2e4\uc2dc \ud655\uc778\ud558\uaca0\uc2b5\ub2c8\ub2e4.`;
      else message = `${ko.independentReview}\n${cleanResult(payload.findings || payload.evidence)}`;
      break;
    }
    case "QA_RESULT": message = String(payload.status || "").toUpperCase() === "PASS" ? `${ko.validationDone} bounded checks\ub97c \ud1b5\uacfc\ud588\uace0 \ucd94\uac00 \ubb38\uc81c\ub294 \uc5c6\uc2b5\ub2c8\ub2e4.` : `\uac80\uc99d \uacb0\uacfc\ub97c ${ko.result}\n${cleanResult(payload.checks || payload.evidence)}`; break;
    case "HANDOFF":
    case "REVISION_REQUEST": message = `${sender}\uc5d0\uc11c ${ko.handoff}\n${cleanResult(payload.findings || payload.reason || payload.requested_changes || payload.next_role)}`; break;
    case "VERDICT": message = String(payload.status || "").toUpperCase() === "PASS" ? `${ko.validationDone} \ud604\uc7ac \ub2e8\uacc4\uc758 bounded checks\ub97c \ud1b5\uacfc\ud588\uc2b5\ub2c8\ub2e4.` : `\uac80\uc99d \uacb0\uacfc\ub97c ${ko.result}\n${cleanResult(payload.result || payload.reason)}`; break;
    case "MEETING_INVITE":
    case "CAPABILITY_REPORT":
    case "EXECUTION_PROPOSAL":
    case "RESOURCE_REPORT":
    case "MODEL_PROPOSAL":
    case "PARALLEL_PLAN":
    case "DEPENDENCY_REPORT":
    case "BLOCKER":
    case "COUNTER_PROPOSAL":
    case "ROLE_ACCEPT": message = bodyText(payload, `${ko.confirmed} ${ko.meetingScope}`); break;
    case "QUESTION": message = `${sender}\uc758 \uc9c8\ubb38\uc785\ub2c8\ub2e4.\n${bodyText(payload, "\ud310\ub2e8\uc774 \ud544\uc694\ud55c \uc0ac\ud56d\uc774 \uc788\uc2b5\ub2c8\ub2e4.")}`; break;
    case "ANSWER":
    case "PROPOSAL":
    case "OBJECTION":
    case "CLARIFICATION":
    case "CONSENSUS": message = `${sender}\uc758 ${ko.opinion}\n${bodyText(payload, "\ub0b4\uc6a9\uc744 \uacf5\uc720\ud569\ub2c8\ub2e4.")}`; break;
    case "EXPERT_REQUEST":
    case "EXPERT_INVITE": message = `${ko.expert} ${cleanOfficeText(payload.requested_role || payload.role || "\ub2f4\ub2f9\uc790")}\uc5d0\uac8c \ud655\uc778\uc744 \uc694\uccad\ud569\ub2c8\ub2e4.\n${cleanOfficeText(payload.reason || "\ud604\uc7ac \ubc94\uc704\uc758 \ucd94\uac00 \uac80\uc99d\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.")}`; break;
    case "EXPERT_RESULT": message = `\uc804\ubb38\uac00\uac00 \uac80\ud1a0 \uacb0\uacfc\ub97c ${ko.result}\n${cleanResult(payload.recommendation || payload.evidence || payload.result)}`; break;
    default: message = `\uc5c5\ubb34 \uc0c1\ud0dc\uac00 \uac31\uc2e0\ub418\uc5c8\uc2b5\ub2c8\ub2e4. \uc0c1\uc138 evidence\ub294 \ub0b4\ubd80 \uae30\ub85d\uc5d0 \ubcf4\uad00\ud569\ub2c8\ub2e4.`;
  }
  return cleanOfficeText(message);
}
