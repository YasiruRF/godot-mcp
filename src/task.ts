/**
 * Per-task bookkeeping: the working set the agent declared (scope discipline) and a log of what it
 * changed, phrased in Godot terms. A "task" runs from begin_task to end_task; if the agent never
 * declares one, an implicit task still guards high-blast-radius files and caps silent mass edits.
 */

/** Project-relative paths (or folders) that are never written unless the task names them explicitly. */
const PROTECTED: { test: (rel: string) => boolean; what: string }[] = [
  { test: (r) => r === "project.godot", what: "the project settings file" },
  { test: (r) => r === "export_presets.cfg", what: "the export presets" },
  { test: (r) => r === ".godot" || r.startsWith(".godot/"), what: "Godot's generated cache folder" },
  { test: (r) => r === ".git" || r.startsWith(".git/"), what: "the git folder" },
  { test: (r) => r === "addons" || r.startsWith("addons/"), what: "the addons folder (plugins, including this bridge)" },
];

/** After this long without an edit, an implicit (undeclared) task starts over. */
const IMPLICIT_TASK_IDLE_MS = 30 * 60 * 1000;

export const DEFAULT_MAX_FILES = Number(process.env.GODOT_MCP_MAX_FILES) > 0 ? Number(process.env.GODOT_MCP_MAX_FILES) : 10;

/** Normalises res://, ./ and backslashes to a project-relative path with forward slashes. */
export function normalizeRel(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^res:\/\//, "")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function matchesEntry(rel: string, entryRaw: string): boolean {
  const entry = normalizeRel(entryRaw);
  if (entry === "") return false;
  if (entry.includes("*")) {
    const re = entry
      .split("**")
      .map((part) => part.split("*").map(escapeRe).join("[^/]*"))
      .join(".*");
    return new RegExp(`^${re}$`).test(rel);
  }
  return rel === entry || rel.startsWith(entry + "/");
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export class TaskTracker {
  label: string | undefined;
  /** Paths the agent said it would touch; undefined means no scope was declared. */
  private scope: string[] | undefined;
  /** Paths the user later approved via allow_paths. */
  private allowed: string[] = [];
  private touched = new Set<string>();
  private declined: string[] = [];
  private log: string[] = [];
  private lastActivity = Date.now();
  maxFiles = DEFAULT_MAX_FILES;

  hasScope(): boolean {
    return this.scope !== undefined;
  }

  get active(): boolean {
    return this.label !== undefined;
  }

  begin(label: string, scope?: string[]): void {
    this.reset();
    this.label = label;
    this.scope = scope && scope.length > 0 ? scope.map(normalizeRel) : undefined;
  }

  /** Ends the task and returns its report; the tracker goes back to the implicit state. */
  end(): { label: string | undefined; summary: string; touched: string[]; declined: string[] } {
    const report = {
      label: this.label,
      summary: this.summary(),
      touched: [...this.touched].sort(),
      declined: [...this.declined],
    };
    this.reset();
    return report;
  }

  allow(paths: string[]): void {
    this.allowed.push(...paths.map(normalizeRel));
  }

  /**
   * Throws unless a write to `relRaw` is within the task's scope. Call before changing a file.
   * Every refusal says how to widen the scope on purpose.
   */
  check(relRaw: string): void {
    const rel = normalizeRel(relRaw);
    this.expireImplicitTask();
    const explicit = [...(this.scope ?? []), ...this.allowed];
    const named = explicit.some((e) => matchesEntry(rel, e));

    const prot = PROTECTED.find((p) => p.test(rel));
    if (prot && !named) {
      this.refuse(
        rel,
        `${rel} is ${prot.what}. It is off limits by default because changing it can break the whole project.`
      );
    }
    if (this.scope && !named) {
      this.refuse(rel, `${rel} is outside this task's working set (${this.scope.join(", ")}).`);
    }
    if (!named && !this.touched.has(rel) && this.touched.size >= this.maxFiles) {
      this.refuse(
        rel,
        `This task has already changed ${this.touched.size} files and ${rel} would be number ${this.touched.size + 1}. ` +
          `Edits that touch this many files need a go-ahead first.`
      );
    }
  }

  /** Records that a file was changed (call after a successful write). */
  touch(relRaw: string): void {
    this.touched.add(normalizeRel(relRaw));
    this.lastActivity = Date.now();
  }

  /** Adds a line to the change log, in Godot terms (nodes, properties, signals — not diffs). */
  record(line: string): void {
    this.log.push(line);
    this.lastActivity = Date.now();
  }

  /** Short human-readable account of the task so far: at most four lines. */
  summary(): string {
    if (this.log.length === 0) return "Nothing has been changed yet.";
    const shown = this.log.slice(0, 3);
    const rest = this.log.length - shown.length;
    if (rest === 1) shown.push(this.log[3]);
    else if (rest > 1) shown.push(`…and ${rest} more changes.`);
    return shown.join("\n");
  }

  touchedFiles(): string[] {
    return [...this.touched].sort();
  }

  private refuse(rel: string, why: string): never {
    this.declined.push(rel);
    throw new Error(
      `${why} Nothing was changed. If this is what the user wants, ask them to confirm, then call ` +
        `allow_paths with ["${rel}"] (or start the task with begin_task and list it in allowed_paths) and retry.`
    );
  }

  private expireImplicitTask(): void {
    if (!this.active && Date.now() - this.lastActivity > IMPLICIT_TASK_IDLE_MS) this.reset();
  }

  private reset(): void {
    this.label = undefined;
    this.scope = undefined;
    this.allowed = [];
    this.touched = new Set();
    this.declined = [];
    this.log = [];
    this.lastActivity = Date.now();
  }
}
