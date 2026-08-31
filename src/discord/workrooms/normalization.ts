export function normalizeDiscordLabel(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, "-");
}

export function isProjectsCategory(value: string): boolean {
  const normalized = normalizeDiscordLabel(value).replace(/-/g, "");
  return ["project", "projects", "projectroom", "projectrooms", "프로젝트"].includes(normalized);
}

export function workroomThreadName(taskId: string, title: string): string {
  const id = String(taskId || "TASK").trim().replace(/\s+/g, "-");
  const readableTitle = String(title || "Workroom").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `${id} · ${(readableTitle || "Workroom")}`.slice(0, 100);
}

function slugPart(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}
