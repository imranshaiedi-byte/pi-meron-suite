import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { makeToolText, setToolResultStatus, toolHeader } from "./claude-tool-style.js";
import { pluralize } from "./render-utils.js";

const TOOL_NAME = "todo";
const TOOL_LABEL = "Todo";
const COMMAND_NAMES = ["todos", "todo"] as const;
const STATE_ENTRY_TYPE = "meron-suite-todo-state";
const WIDGET_KEY = "meron-suite-todos";
const MAX_WIDGET_LINES = 12;
const MAX_TASK_DEPTH = 3;

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
  parentId?: number;
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
  parentId: Type.Optional(Type.Number({ description: "Parent task id. Creates a subtask on create; reparents on update. Max depth is 3 levels." })),
  clearParent: Type.Optional(Type.Boolean({ description: "Remove parent assignment, making this a root task. Only for update." })),
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
  "Use parentId on create to nest meaningful subtasks under a parent task. Prefer shallow 2-level plans; max depth is 3 levels (parent → child → grandchild). Use sibling subtasks instead of deeper nesting.",
  "Complete child subtasks before their parent. A parent task cannot be marked completed while any visible descendant remains pending or in_progress.",
  "Use clearParent on update to promote a subtask back to root level.",
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

function isAncestorOf(tasks: Task[], ancestorId: number, descendantId: number): boolean {
  const parentMap = new Map<number, number>();
  for (const task of tasks) {
    if (task.parentId !== undefined) parentMap.set(task.id, task.parentId);
  }
  let currentId: number | undefined = parentMap.get(descendantId);
  const visited = new Set<number>();
  while (currentId !== undefined) {
    if (currentId === ancestorId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    currentId = parentMap.get(currentId);
  }
  return false;
}

function taskDepth(tasks: Task[], id: number): number | undefined {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  let task = taskMap.get(id);
  if (!task || task.status === "deleted") return undefined;

  let depth = 1;
  const visited = new Set<number>([id]);
  while (task.parentId !== undefined) {
    if (visited.has(task.parentId)) return undefined;
    const parent = taskMap.get(task.parentId);
    if (!parent || parent.status === "deleted") break;
    depth++;
    visited.add(parent.id);
    task = parent;
  }
  return depth;
}

function childMap(tasks: Task[]): Map<number, Task[]> {
  const children = new Map<number, Task[]>();
  for (const task of tasks) {
    if (task.status !== "deleted" && task.parentId !== undefined) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    }
  }
  return children;
}

function subtreeHeight(tasks: Task[], rootId: number): number {
  const children = childMap(tasks);

  function walk(id: number, visited = new Set<number>()): number {
    if (visited.has(id)) return 0;
    visited.add(id);
    const childHeights = (children.get(id) ?? []).map((child) => walk(child.id, new Set(visited)));
    return 1 + (childHeights.length > 0 ? Math.max(...childHeights) : 0);
  }

  return walk(rootId);
}

function incompleteDescendants(tasks: Task[], rootId: number): Task[] {
  const children = childMap(tasks);
  const result: Task[] = [];

  function walk(id: number, visited = new Set<number>()) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const child of children.get(id) ?? []) {
      if (child.status !== "completed") result.push(child);
      walk(child.id, visited);
    }
  }

  walk(rootId);
  return result.sort((a, b) => a.id - b.id);
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
      const parentId = normalizeId(params.parentId);
      if (parentId !== undefined) {
        const parentTask = current.tasks.find((task) => task.id === parentId);
        if (!parentTask) return errorResult(current, `parentId: #${parentId} not found`);
        if (parentTask.status === "deleted") return errorResult(current, `parentId: #${parentId} is deleted`);
        if (parentTask.status === "completed") return errorResult(current, `cannot add an open subtask under completed parent #${parentId}`);
        const parentDepth = taskDepth(current.tasks, parentId);
        if (parentDepth === undefined) return errorResult(current, `parentId: #${parentId} has invalid ancestry`);
        if (parentDepth >= MAX_TASK_DEPTH) return errorResult(current, `parentId would exceed max task depth of ${MAX_TASK_DEPTH}`);
      }
      const task: Task = { id: current.nextId, subject, status: "pending" };
      if (typeof params.description === "string") task.description = params.description;
      if (typeof params.activeForm === "string") task.activeForm = params.activeForm;
      if (blockedBy.length > 0) task.blockedBy = blockedBy;
      if (parentId !== undefined) task.parentId = parentId;
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

      const hasMutation = params.subject !== undefined || params.description !== undefined || params.activeForm !== undefined || params.status !== undefined || params.owner !== undefined || params.metadata !== undefined || params.parentId !== undefined || params.clearParent === true || normalizeIdList(params.addBlockedBy).length > 0 || normalizeIdList(params.removeBlockedBy).length > 0;
      if (!hasMutation) return errorResult(current, "update requires at least one mutable field");

      const nextStatus = isStatus(params.status) ? params.status : existing.status;
      if (!isTransitionValid(existing.status, nextStatus)) return errorResult(current, `illegal transition ${existing.status} → ${nextStatus}`);
      if (nextStatus === "completed") {
        const openDescendants = incompleteDescendants(current.tasks, id);
        if (openDescendants.length > 0) {
          const ids = openDescendants.map((task) => `#${task.id}`).join(", ");
          return errorResult(current, `cannot complete #${id} while subtasks remain open: ${ids}`);
        }
      }

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

      let nextParentId = existing.parentId;
      const newParentId = normalizeId(params.parentId);
      if (newParentId !== undefined) {
        if (newParentId === id) return errorResult(current, `cannot set #${id} as its own parent`);
        const parentTask = current.tasks.find((task) => task.id === newParentId);
        if (!parentTask) return errorResult(current, `parentId: #${newParentId} not found`);
        if (parentTask.status === "deleted") return errorResult(current, `parentId: #${newParentId} is deleted`);
        if (parentTask.status === "completed" && nextStatus !== "completed") return errorResult(current, `cannot add open subtask #${id} under completed parent #${newParentId}`);
        if (parentTask.status === "completed" && incompleteDescendants(current.tasks, id).length > 0) return errorResult(current, `cannot add subtree #${id} under completed parent #${newParentId} while it has open subtasks`);
        if (isAncestorOf(current.tasks, id, newParentId)) return errorResult(current, `parentId: #${newParentId} is a descendant of #${id}, would create a cycle`);
        const parentDepth = taskDepth(current.tasks, newParentId);
        if (parentDepth === undefined) return errorResult(current, `parentId: #${newParentId} has invalid ancestry`);
        const resultingDepth = parentDepth + subtreeHeight(current.tasks, id);
        if (resultingDepth > MAX_TASK_DEPTH) return errorResult(current, `parentId would exceed max task depth of ${MAX_TASK_DEPTH}`);
        nextParentId = newParentId;
      } else if (params.clearParent === true) {
        nextParentId = undefined;
      }

      const updated: Task = { ...existing, status: nextStatus };
      if (typeof params.subject === "string") updated.subject = params.subject.trim() || updated.subject;
      if (params.description !== undefined) updated.description = typeof params.description === "string" ? params.description : undefined;
      if (params.activeForm !== undefined) updated.activeForm = typeof params.activeForm === "string" ? params.activeForm : undefined;
      if (params.owner !== undefined) updated.owner = typeof params.owner === "string" ? params.owner : undefined;
      if (nextParentId !== undefined) updated.parentId = nextParentId;
      else delete updated.parentId;
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

type TaskNode = {
  task: Task;
  children: TaskNode[];
};

type FlatTreeNode = {
  node: TaskNode;
  depth: number;
  isLast: boolean;
  parentIsLast: boolean[];
};

function buildTaskTree(tasks: Task[]): TaskNode[] {
  const nodeMap = new Map<number, TaskNode>();
  const roots: TaskNode[] = [];

  for (const task of tasks) {
    nodeMap.set(task.id, { task, children: [] });
  }

  for (const node of nodeMap.values()) {
    const pid = node.task.parentId;
    if (pid !== undefined && nodeMap.has(pid)) {
      nodeMap.get(pid)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => a.task.id - b.task.id);
  }
  roots.sort((a, b) => a.task.id - b.task.id);

  return roots;
}

function flattenTree(roots: TaskNode[]): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];

  function walk(nodes: TaskNode[], depth: number, parentIsLast: boolean[]) {
    for (let i = 0; i < nodes.length; i++) {
      const isLast = i === nodes.length - 1;
      result.push({
        node: nodes[i]!,
        depth,
        isLast,
        parentIsLast: [...parentIsLast],
      });
      if (nodes[i]!.children.length > 0) {
        walk(nodes[i]!.children, depth + 1, [...parentIsLast, isLast]);
      }
    }
  }

  walk(roots, 0, []);
  return result;
}

function treePrefix(flat: FlatTreeNode, branch: (text: string) => string, continuation: (text: string) => string): string {
  if (flat.depth === 0) return flat.isLast ? branch("└─ ") : branch("├─ ");

  let prefix = "";
  for (let level = 0; level < flat.depth; level++) {
    prefix += flat.parentIsLast[level] ? "   " : continuation("│  ");
  }
  return prefix + (flat.isLast ? branch("└─ ") : branch("├─ "));
}

function plainTreePrefix(flat: FlatTreeNode): string {
  if (flat.depth === 0) return flat.isLast ? "└─ " : "├─ ";

  let prefix = "";
  for (let level = 0; level < flat.depth; level++) {
    prefix += flat.parentIsLast[level] ? "   " : "│  ";
  }
  return prefix + (flat.isLast ? "└─ " : "├─ ");
}

function taskLine(task: Task, theme: Theme): string {
  const glyph = theme.fg(STATUS_COLOR[task.status], STATUS_GLYPH[task.status]);
  const subjectColor = task.status === "completed" || task.status === "deleted" ? "muted" : "text";
  const styledSubject = task.status === "completed" && theme.strikethrough
    ? theme.strikethrough(theme.fg(subjectColor, task.subject))
    : theme.fg(subjectColor, task.subject);
  return `${glyph} ${styledSubject}`;
}

function plainTaskLine(task: Task, prefix: string, options: { showStatus?: boolean; showParentHint?: boolean } = {}): string {
  const glyph = STATUS_GLYPH[task.status];
  const status = options.showStatus ? ` [${task.status}]` : "";
  const form = task.status === "in_progress" && task.activeForm ? ` (${task.activeForm})` : "";
  const parent = options.showParentHint && task.parentId !== undefined ? `    ↰ #${task.parentId}` : "";
  const deps = task.blockedBy?.length ? `    ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
  return `${prefix}${glyph} #${task.id}${status} ${task.subject}${form}${parent}${deps}`;
}

function formatContent(action: TaskAction, params: MutationParams, snapshot: TaskState, op: Operation): string {
  if (op.kind === "error") return `Todo error: ${op.message}`;
  switch (op.kind) {
    case "create": {
      const task = snapshot.tasks.find((task) => task.id === op.taskId);
      if (!task) return `Created #${op.taskId}`;
      const parentSuffix = task.parentId !== undefined ? ` (subtask of #${task.parentId})` : "";
      return `Created #${task.id}: ${task.subject}${parentSuffix}`;
    }
    case "update": {
      const task = snapshot.tasks.find((task) => task.id === op.id);
      return task ? `Updated #${task.id}: ${task.subject} (${STATUS_LABEL[task.status]})` : `Updated #${op.id}`;
    }
    case "delete":
      return `Deleted #${op.id}: ${op.subject}`;
    case "clear":
      return `Cleared ${op.count} ${pluralize(op.count, "todo", "todos")}`;
    case "get": {
      const parentSuffix = op.task.parentId !== undefined ? ` · subtask of #${op.task.parentId}` : "";
      const depsSuffix = op.task.blockedBy?.length ? ` · blocked by ${op.task.blockedBy.map((id) => `#${id}`).join(",")}` : "";
      return `#${op.task.id} ${op.task.subject} (${STATUS_LABEL[op.task.status]})${parentSuffix}${depsSuffix}`;
    }
    case "list": {
      const tasks = snapshot.tasks.filter((task) => (op.includeDeleted || task.status !== "deleted") && (!op.statusFilter || task.status === op.statusFilter));
      if (tasks.length === 0) return "No todos.";
      return formatPlainTaskTree(tasks, { showStatus: true, showParentHints: true });
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
    const parentId = normalizeId(args.parentId);
    if (parentId !== undefined) {
      summary += ` ${theme.fg("muted", `→ #${parentId}`)}`;
    }
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
  private hideCompletedList = false;

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
    this.hideCompletedList = false;
  }

  hideCompletedTasksFromPreviousTurn(): void {
    const taskCounts = counts();
    if (taskCounts.total > 0 && taskCounts.pending === 0 && taskCounts.inProgress === 0) {
      this.hideCompletedList = true;
      this.tui?.requestRender?.();
      this.update();
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const taskCounts = counts();
    if (taskCounts.pending > 0 || taskCounts.inProgress > 0) this.hideCompletedList = false;
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
    if (this.hideCompletedList) return [];
    return state.tasks.filter((task) => task.status !== "deleted");
  }

  private render(theme: Theme, width: number): string[] {
    const tasks = this.selectOverlayTasks();
    if (tasks.length === 0) return [];

    const taskCounts = counts({ tasks, nextId: state.nextId });
    const hasActive = taskCounts.inProgress > 0;
    const heading = `${theme.fg(hasActive ? "accent" : "muted", hasActive ? "●" : "○")} ${theme.fg(hasActive ? "accent" : "muted", `Todos (${taskCounts.completed}/${taskCounts.total})`)}`;
    const lines = [truncateToWidth(heading, width, "…")];

    const roots = buildTaskTree(tasks);
    const flat = flattenTree(roots);
    const visible = flat.slice(0, MAX_WIDGET_LINES - 1);
    const hidden = flat.length - visible.length;

    const branchFn = (text: string) => theme.fg("muted", text);
    const contFn = (text: string) => theme.fg("muted", text);

    for (const entry of visible) {
      const prefix = treePrefix(entry, branchFn, contFn);
      lines.push(truncateToWidth(`${prefix}${taskLine(entry.node.task, theme)}`, width, "…"));
      if (entry.node.task.status === "completed" && !this.hiddenCompleted.has(entry.node.task.id)) {
        this.completedPendingHide.add(entry.node.task.id);
      }
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

function formatPlainTaskTree(tasks: Task[], options: { showStatus?: boolean; showParentHints?: boolean } = {}): string {
  const roots = buildTaskTree(tasks);
  const flat = flattenTree(roots);
  return flat.map((entry) => {
    const hasVisibleParent = entry.node.task.parentId !== undefined && tasks.some((task) => task.id === entry.node.task.parentId);
    return plainTaskLine(entry.node.task, plainTreePrefix(entry), {
      showStatus: options.showStatus,
      showParentHint: options.showParentHints && entry.node.task.parentId !== undefined && !hasVisibleParent,
    });
  }).join("\n");
}

function renderCommandLines(): string[] {
  const visible = visibleTasks();
  if (visible.length === 0) return ["No todos yet. Ask the agent to add some."];
  const taskCounts = counts();
  const header = `${taskCounts.completed}/${taskCounts.total} completed · ${taskCounts.inProgress} in progress · ${taskCounts.pending} pending`;
  return [header, ...formatPlainTaskTree(visible).split("\n")];
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
    description: "Manage a persistent task tree for detailed multi-step coding progress. Supports create, update, list, get, delete, clear, dependencies via blockedBy, and subtasks via parentId up to 3 levels deep.",
    promptSnippet: "Manage a compact task tree for multi-step progress",
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
      description: name === "todo" ? "Alias for /todos" : "Show todos as a compact task tree",
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
