import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { makeToolText, setToolResultStatus, toolHeader } from "./claude-tool-style.js";
import { pluralize } from "./render-utils.js";

const TOOL_NAME = "todo";
const TOOL_LABEL = "Todo";
const COMMAND_NAMES = ["todos", "todo"] as const;
const STATE_ENTRY_TYPE = "meron-todo-state";
const WIDGET_KEY = "meron-todos";
const MAX_WIDGET_LINES = 12;

type Theme = {
  fg(name: string, value: string): string;
  bold(value: string): string;
  strikethrough?: (value: string) => string;
};

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

type Task = {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
};

type TaskState = {
  tasks: Task[];
  nextId: number;
};

type TodoDetails = {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
};

type MutationParams = Static<typeof TodoParamsSchema> & Record<string, unknown>;

type Operation =
  | { kind: "create"; taskId: number }
  | { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };
let state: TaskState = { ...EMPTY_STATE, tasks: [] };
const stateListeners = new Set<() => void>();

export function onTodoStateChange(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

function emitTodoStateChange(): void {
  for (const listener of stateListeners) listener();
}

const StatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("deleted"),
]);

const ActionSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("list"),
  Type.Literal("get"),
  Type.Literal("delete"),
  Type.Literal("clear"),
]);

const TodoParamsSchema = Type.Object({
  action: ActionSchema,
  subject: Type.Optional(Type.String({ description: "Short imperative task subject. Required for create." })),
  description: Type.Optional(Type.String({ description: "Longer task details or acceptance criteria." })),
  activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while in_progress, e.g. 'writing tests'." })),
  status: Type.Optional(StatusSchema),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Initial dependency task ids for create." })),
  addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Dependency task ids to add on update." })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Dependency task ids to remove on update." })),
  owner: Type.Optional(Type.String({ description: "Optional owner/agent label." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Arbitrary metadata; null deletes a key on update." })),
  id: Type.Optional(Type.Number({ description: "Task id for update, get, or delete." })),
  includeDeleted: Type.Optional(Type.Boolean({ description: "Include deleted tombstones when listing. Default false." })),
});

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "completed",
  deleted: "deleted",
};

const STATUS_GLYPH: Record<TaskStatus, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  deleted: "⊘",
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "muted",
  in_progress: "warning",
  completed: "success",
  deleted: "muted",
};

const ACTION_GLYPH: Record<TaskAction, string> = {
  create: "+",
  update: "→",
  list: "☰",
  get: "›",
  delete: "×",
  clear: "∅",
};

const PROMPT_GUIDELINES = [
  "Use `todo` for complex work with 3+ steps, user-provided task lists, or work that spans research/design/implementation. Skip it for single trivial requests.",
  "Keep exactly one task in_progress when actively working. Mark a task in_progress before starting it and completed immediately when finished.",
  "Never mark work completed if tests are failing, implementation is partial, or unresolved errors remain; keep it in_progress and create a blocker task if needed.",
  "Use short imperative subjects. Use activeForm for present-continuous labels shown in the live todo overlay.",
  "Use blockedBy/addBlockedBy/removeBlockedBy to capture task dependencies. Dependency cycles and references to missing/deleted tasks are rejected.",
];

function cloneState(input: TaskState): TaskState {
  return {
    nextId: Number.isFinite(input.nextId) && input.nextId > 0 ? Math.floor(input.nextId) : 1,
    tasks: Array.isArray(input.tasks) ? input.tasks.map((task) => ({ ...task, blockedBy: task.blockedBy ? [...task.blockedBy] : undefined, metadata: task.metadata ? { ...task.metadata } : undefined })) : [],
  };
}

function getState(): TaskState {
  return cloneState(state);
}

function replaceState(next: TaskState): void {
  const previous = JSON.stringify(state);
  state = cloneState(next);
  if (JSON.stringify(state) !== previous) emitTodoStateChange();
}

function isStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted";
}

function normalizeId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function normalizeIdList(value: unknown): number[] {
  return Array.isArray(value)
    ? [...new Set(value.map(normalizeId).filter((id): id is number => id !== undefined))]
    : [];
}

function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  if (from === "deleted") return false;
  if (to === "deleted") return true;
  if (to === "completed") return from === "pending" || from === "in_progress";
  if (to === "in_progress") return from === "pending";
  if (to === "pending") return from === "in_progress";
  return false;
}

function detectCycle(tasks: Task[], targetId: number, nextBlockedBy: number[]): boolean {
  const deps = new Map<number, number[]>();
  for (const task of tasks) deps.set(task.id, task.blockedBy ?? []);
  deps.set(targetId, nextBlockedBy);

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (id: number): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) {
      if (visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return visit(targetId);
}

function errorResult(current: TaskState, message: string): { state: TaskState; op: Operation } {
  return { state: current, op: { kind: "error", message } };
}

function applyMutation(current: TaskState, action: TaskAction, params: MutationParams): { state: TaskState; op: Operation } {
  switch (action) {
    case "create": {
      const subject = typeof params.subject === "string" ? params.subject.trim() : "";
      if (!subject) return errorResult(current, "subject required for create");
      const blockedBy = normalizeIdList(params.blockedBy);
      for (const dep of blockedBy) {
        const depTask = current.tasks.find((task) => task.id === dep);
        if (!depTask) return errorResult(current, `blockedBy: #${dep} not found`);
        if (depTask.status === "deleted") return errorResult(current, `blockedBy: #${dep} is deleted`);
      }
      const task: Task = { id: current.nextId, subject, status: "pending" };
      if (typeof params.description === "string") task.description = params.description;
      if (typeof params.activeForm === "string") task.activeForm = params.activeForm;
      if (blockedBy.length > 0) task.blockedBy = blockedBy;
      if (typeof params.owner === "string") task.owner = params.owner;
      if (params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)) task.metadata = { ...params.metadata };
      return { state: { tasks: [...current.tasks, task], nextId: current.nextId + 1 }, op: { kind: "create", taskId: task.id } };
    }
    case "update": {
      const id = normalizeId(params.id);
      if (id === undefined) return errorResult(current, "id required for update");
      const index = current.tasks.findIndex((task) => task.id === id);
      if (index < 0) return errorResult(current, `#${id} not found`);
      const existing = current.tasks[index]!;
      if (existing.status === "deleted") return errorResult(current, `#${id} is deleted`);

      const hasMutation = params.subject !== undefined || params.description !== undefined || params.activeForm !== undefined || params.status !== undefined || params.owner !== undefined || params.metadata !== undefined || normalizeIdList(params.addBlockedBy).length > 0 || normalizeIdList(params.removeBlockedBy).length > 0;
      if (!hasMutation) return errorResult(current, "update requires at least one mutable field");

      const nextStatus = isStatus(params.status) ? params.status : existing.status;
      if (!isTransitionValid(existing.status, nextStatus)) return errorResult(current, `illegal transition ${existing.status} → ${nextStatus}`);

      let blockedBy = existing.blockedBy ? [...existing.blockedBy] : [];
      const remove = new Set(normalizeIdList(params.removeBlockedBy));
      blockedBy = blockedBy.filter((id) => !remove.has(id));
      for (const dep of normalizeIdList(params.addBlockedBy)) {
        if (dep === id) return errorResult(current, `cannot block #${id} on itself`);
        const depTask = current.tasks.find((task) => task.id === dep);
        if (!depTask) return errorResult(current, `addBlockedBy: #${dep} not found`);
        if (depTask.status === "deleted") return errorResult(current, `addBlockedBy: #${dep} is deleted`);
        if (!blockedBy.includes(dep)) blockedBy.push(dep);
      }
      if (detectCycle(current.tasks, id, blockedBy)) return errorResult(current, "addBlockedBy would create a cycle");

      const updated: Task = { ...existing, status: nextStatus };
      if (typeof params.subject === "string") updated.subject = params.subject.trim() || updated.subject;
      if (params.description !== undefined) updated.description = typeof params.description === "string" ? params.description : undefined;
      if (params.activeForm !== undefined) updated.activeForm = typeof params.activeForm === "string" ? params.activeForm : undefined;
      if (params.owner !== undefined) updated.owner = typeof params.owner === "string" ? params.owner : undefined;
      if (blockedBy.length > 0) updated.blockedBy = blockedBy;
      else delete updated.blockedBy;
      if (params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)) {
        const metadata = { ...(updated.metadata ?? {}) };
        for (const [key, value] of Object.entries(params.metadata)) {
          if (value === null) delete metadata[key];
          else metadata[key] = value;
        }
        if (Object.keys(metadata).length > 0) updated.metadata = metadata;
        else delete updated.metadata;
      }
      const tasks = [...current.tasks];
      tasks[index] = updated;
      return { state: { tasks, nextId: current.nextId }, op: { kind: "update", id, fromStatus: existing.status, toStatus: nextStatus } };
    }
    case "list":
      return { state: current, op: { kind: "list", statusFilter: isStatus(params.status) ? params.status : undefined, includeDeleted: params.includeDeleted === true } };
    case "get": {
      const id = normalizeId(params.id);
      if (id === undefined) return errorResult(current, "id required for get");
      const task = current.tasks.find((task) => task.id === id);
      return task ? { state: current, op: { kind: "get", task } } : errorResult(current, `#${id} not found`);
    }
    case "delete": {
      const id = normalizeId(params.id);
      if (id === undefined) return errorResult(current, "id required for delete");
      const index = current.tasks.findIndex((task) => task.id === id);
      if (index < 0) return errorResult(current, `#${id} not found`);
      const existing = current.tasks[index]!;
      if (existing.status === "deleted") return errorResult(current, `#${id} is already deleted`);
      const tasks = [...current.tasks];
      tasks[index] = { ...existing, status: "deleted" };
      return { state: { tasks, nextId: current.nextId }, op: { kind: "delete", id, subject: existing.subject } };
    }
    case "clear":
      return { state: cloneState(EMPTY_STATE), op: { kind: "clear", count: current.tasks.length } };
  }
}

function visibleTasks(input = state): Task[] {
  return input.tasks.filter((task) => task.status !== "deleted");
}

function counts(input = state) {
  const visible = visibleTasks(input);
  return {
    total: visible.length,
    pending: visible.filter((task) => task.status === "pending").length,
    inProgress: visible.filter((task) => task.status === "in_progress").length,
    completed: visible.filter((task) => task.status === "completed").length,
  };
}

function taskLine(task: Task, theme: Theme, showId = true): string {
  const glyph = theme.fg(STATUS_COLOR[task.status], STATUS_GLYPH[task.status]);
  const subjectColor = task.status === "completed" || task.status === "deleted" ? "muted" : "text";
  const styledSubject = task.status === "completed" && theme.strikethrough
    ? theme.strikethrough(theme.fg(subjectColor, task.subject))
    : theme.fg(subjectColor, task.subject);
  const id = showId ? ` ${theme.fg("accent", `#${task.id}`)}` : "";
  const form = task.status === "in_progress" && task.activeForm ? ` ${theme.fg("muted", `(${task.activeForm})`)}` : "";
  const deps = task.blockedBy?.length ? ` ${theme.fg("muted", `⛓ ${task.blockedBy.map((dep) => `#${dep}`).join(",")}`)}` : "";
  return `${glyph}${id} ${styledSubject}${form}${deps}`;
}

function plainTaskLine(task: Task, glyph = STATUS_GLYPH[task.status]): string {
  const form = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
  const deps = task.blockedBy?.length ? `    ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  return `  ${glyph} #${task.id} ${task.subject}${form}${deps}`;
}

function formatContent(action: TaskAction, params: MutationParams, snapshot: TaskState, op: Operation): string {
  if (op.kind === "error") return `Todo error: ${op.message}`;
  switch (op.kind) {
    case "create": {
      const task = snapshot.tasks.find((task) => task.id === op.taskId);
      return task ? `Created #${task.id}: ${task.subject}` : `Created #${op.taskId}`;
    }
    case "update": {
      const task = snapshot.tasks.find((task) => task.id === op.id);
      return task ? `Updated #${task.id}: ${task.subject} (${STATUS_LABEL[task.status]})` : `Updated #${op.id}`;
    }
    case "delete":
      return `Deleted #${op.id}: ${op.subject}`;
    case "clear":
      return `Cleared ${op.count} ${pluralize(op.count, "todo", "todos")}`;
    case "get":
      return `#${op.task.id} ${op.task.subject} (${STATUS_LABEL[op.task.status]})`;
    case "list": {
      const tasks = snapshot.tasks.filter((task) => (op.includeDeleted || task.status !== "deleted") && (!op.statusFilter || task.status === op.statusFilter));
      if (tasks.length === 0) return "No todos.";
      return tasks.map((task) => `#${task.id} [${task.status}] ${task.subject}`).join("\n");
    }
  }
}

function buildToolResult(action: TaskAction, params: MutationParams, snapshot: TaskState, op: Operation) {
  const details: TodoDetails = {
    action,
    params: { ...params },
    tasks: cloneState(snapshot).tasks,
    nextId: snapshot.nextId,
    ...(op.kind === "error" ? { error: op.message } : {}),
  };
  return {
    content: [{ type: "text", text: formatContent(action, params, snapshot, op) }],
    details,
    isError: op.kind === "error",
  };
}

function todoCallGlyph(args: MutationParams): { glyph: string; color: string } {
  const action = args.action as TaskAction;
  if (action === "update" && isStatus(args.status)) {
    return { glyph: STATUS_GLYPH[args.status], color: STATUS_COLOR[args.status] };
  }
  if (action === "delete") return { glyph: "×", color: "muted" };
  if (action === "clear") return { glyph: "∅", color: "muted" };
  if (action === "create") return { glyph: "+", color: "success" };
  return { glyph: ACTION_GLYPH[action] ?? "•", color: "muted" };
}

function renderTodoCall(args: MutationParams, theme: Theme, context: any): Text {
  const action = args.action as TaskAction;
  const { glyph, color } = todoCallGlyph(args);
  let summary = theme.fg(color, glyph);

  if (action === "clear") {
    summary += ` ${theme.fg("muted", "clear")}`;
  } else if (action === "create" && typeof args.subject === "string") {
    summary += ` ${theme.fg("text", args.subject)}`;
  } else if ((action === "update" || action === "get" || action === "delete") && args.id !== undefined) {
    const id = normalizeId(args.id);
    const task = id === undefined ? undefined : state.tasks.find((task) => task.id === id);
    summary += ` ${theme.fg("accent", task ? `#${task.id}` : `#${args.id}`)}`;
    if (task) summary += ` ${theme.fg("text", task.subject)}`;
  } else if (action === "list" && isStatus(args.status)) {
    summary += ` ${theme.fg("muted", STATUS_LABEL[args.status])}`;
  }

  return makeToolText(context?.lastComponent, toolHeader("Todo", summary, theme as any, context));
}

function renderTodoResult(result: { details?: unknown; isError?: boolean }, theme: Theme, context: any): Text {
  const details = result.details as TodoDetails | undefined;
  if (details?.error || result.isError) {
    setToolResultStatus(context, true);
    return makeToolText(context?.lastComponent, theme.fg("error", `✗ ${details?.error ?? "todo failed"}`));
  }

  setToolResultStatus(context, false);
  return makeToolText(context?.lastComponent, "");
}

class TodoOverlay {
  private uiCtx: any;
  private tui: any;
  private registered = false;
  private completedPendingHide = new Set<number>();
  private hiddenCompleted = new Set<number>();

  setUICtx(uiCtx: any): void {
    if (uiCtx !== this.uiCtx) {
      this.uiCtx = uiCtx;
      this.tui = undefined;
      this.registered = false;
    }
  }

  resetCompletedDisplayState(): void {
    this.completedPendingHide.clear();
    this.hiddenCompleted.clear();
  }

  hideCompletedTasksFromPreviousTurn(): void {
    for (const id of this.completedPendingHide) this.hiddenCompleted.add(id);
    this.completedPendingHide.clear();
    this.tui?.requestRender?.();
    this.update();
  }

  update(): void {
    if (!this.uiCtx) return;
    if (this.selectOverlayTasks().length === 0) {
      if (this.registered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.registered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.registered) {
      this.uiCtx.setWidget(WIDGET_KEY, (tui: any, theme: Theme) => {
        this.tui = tui;
        return {
          render: (width: number) => this.render(theme, width),
          invalidate: () => {
            this.registered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.registered = true;
    } else {
      this.tui?.requestRender?.();
    }
  }

  dispose(): void {
    this.uiCtx?.setWidget?.(WIDGET_KEY, undefined);
    this.uiCtx = undefined;
    this.tui = undefined;
    this.registered = false;
    this.resetCompletedDisplayState();
  }

  private selectOverlayTasks(): Task[] {
    return state.tasks.filter((task) => task.status !== "deleted" && !(task.status === "completed" && this.hiddenCompleted.has(task.id)));
  }

  private render(theme: Theme, width: number): string[] {
    const tasks = this.selectOverlayTasks();
    if (tasks.length === 0) return [];

    const taskCounts = counts({ tasks, nextId: state.nextId });
    const hasActive = taskCounts.inProgress > 0;
    const heading = `${theme.fg(hasActive ? "accent" : "muted", hasActive ? "●" : "○")} ${theme.fg(hasActive ? "accent" : "muted", `Todos (${taskCounts.completed}/${taskCounts.total})`)}`;
    const lines = [truncateToWidth(heading, width, "…")];

    const sorted = [...tasks].sort((a, b) => {
      const rank = (task: Task) => task.status === "in_progress" ? 0 : task.status === "pending" ? 1 : 2;
      return rank(a) - rank(b) || a.id - b.id;
    });
    const visible = sorted.slice(0, MAX_WIDGET_LINES - 1);
    const hidden = sorted.length - visible.length;
    for (const [index, task] of visible.entries()) {
      const branch = index === visible.length - 1 && hidden <= 0 ? "└─" : "├─";
      lines.push(truncateToWidth(`${theme.fg("muted", branch)} ${taskLine(task, theme, true)}`, width, "…"));
      if (task.status === "completed" && !this.hiddenCompleted.has(task.id)) this.completedPendingHide.add(task.id);
    }
    if (hidden > 0) {
      lines.push(truncateToWidth(`${theme.fg("muted", "└─")} ${theme.fg("muted", `+${hidden} more`)}`, width, "…"));
    }
    return lines;
  }
}

function replayFromSession(ctx: any): TaskState {
  let replay = cloneState(EMPTY_STATE);
  const entries = typeof ctx.sessionManager.getBranch === "function"
    ? ctx.sessionManager.getBranch()
    : ctx.sessionManager.getEntries?.() ?? [];
  for (const entry of entries) {
    if (entry?.type === "custom" && entry.customType === STATE_ENTRY_TYPE && entry.data && typeof entry.data === "object") {
      const snapshot = entry.data as Partial<TaskState>;
      if (Array.isArray(snapshot.tasks) && typeof snapshot.nextId === "number") {
        replay = cloneState(snapshot as TaskState);
      }
    }
    if (entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === TOOL_NAME) {
      const details = entry.message.details as Partial<TodoDetails> | undefined;
      if (details && Array.isArray(details.tasks) && typeof details.nextId === "number") {
        replay = cloneState({ tasks: details.tasks as Task[], nextId: details.nextId });
      }
    }
  }
  return replay;
}

function renderCommandLines(): string[] {
  const visible = visibleTasks();
  if (visible.length === 0) return ["No todos yet. Ask the agent to add some."];
  const taskCounts = counts();
  const header = `${taskCounts.completed}/${taskCounts.total} completed · ${taskCounts.inProgress} in progress · ${taskCounts.pending} pending`;
  const lines = [header];
  const addGroup = (label: string, status: TaskStatus) => {
    const group = visible.filter((task) => task.status === status);
    if (group.length === 0) return;
    lines.push(`── ${label} ──`);
    for (const task of group) lines.push(plainTaskLine(task));
  };
  addGroup("In Progress", "in_progress");
  addGroup("Pending", "pending");
  addGroup("Completed", "completed");
  return lines;
}

export function getTodoCountsForFooter(): { open: number; inProgress: number; total: number } {
  const taskCounts = counts();
  return { open: taskCounts.pending + taskCounts.inProgress, inProgress: taskCounts.inProgress, total: taskCounts.total };
}

export function registerTodoExtension(pi: ExtensionAPI): void {
  let overlay: TodoOverlay | undefined;

  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description: "Manage a persistent task list for tracking multi-step coding progress. Supports create, update, list, get, delete, and clear, with dependencies via blockedBy.",
    promptSnippet: "Manage a small todo list for multi-step progress",
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: TodoParamsSchema,
    async execute(_toolCallId, params) {
      const action = params.action as TaskAction;
      const result = applyMutation(getState(), action, params as MutationParams);
      replaceState(result.state);
      pi.appendEntry(STATE_ENTRY_TYPE, getState());
      return buildToolResult(action, params as MutationParams, getState(), result.op);
    },
    renderCall(args, theme, context) {
      return renderTodoCall(args as MutationParams, theme as Theme, context);
    },
    renderResult(result, _options, theme, context) {
      return renderTodoResult(result, theme as Theme, context);
    },
  });

  for (const name of COMMAND_NAMES) {
    pi.registerCommand(name, {
      description: name === "todo" ? "Alias for /todos" : "Show todos grouped by status",
      handler: async (args, ctx) => {
        const trimmed = args.trim();
        if (trimmed === "clear") {
          replaceState(cloneState(EMPTY_STATE));
          pi.appendEntry(STATE_ENTRY_TYPE, getState());
          overlay?.update();
          ctx.ui.notify("Todos cleared", "info");
          return;
        }
        ctx.ui.notify(renderCommandLines().join("\n"), "info");
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    replaceState(replayFromSession(ctx));
    if (ctx.hasUI) {
      overlay ??= new TodoOverlay();
      overlay.setUICtx(ctx.ui);
      overlay.resetCompletedDisplayState();
      overlay.update();
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    try {
      replaceState(replayFromSession(ctx));
    } catch {}
    overlay?.resetCompletedDisplayState();
    overlay?.update();
  });

  pi.on("session_tree", async (_event, ctx) => {
    try {
      replaceState(replayFromSession(ctx));
    } catch {}
    overlay?.resetCompletedDisplayState();
    overlay?.update();
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === TOOL_NAME && !event.isError) overlay?.update();
  });

  pi.on("agent_start", async () => {
    overlay?.hideCompletedTasksFromPreviousTurn();
  });

  pi.on("session_shutdown", async () => {
    overlay?.dispose();
    overlay = undefined;
  });
}
