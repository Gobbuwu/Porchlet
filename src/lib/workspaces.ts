// Small helpers shared by the workspace pages and their Server Actions (M2 PR 2).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a uuid in its canonical text form, the only ids the database hands out. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function workspacePage(workspaceId: string): string {
  return `/w/${workspaceId}`;
}

/**
 * True when a (trimmed) name is empty or longer than `max`. Counted in code points, as the
 * database's char_length() checks do (workspaces 1 to 80, projects 1 to 120), so the app refuses
 * exactly what the database would.
 */
export function nameProblem(name: string, max: number): boolean {
  const length = [...name].length;
  return length < 1 || length > max;
}
