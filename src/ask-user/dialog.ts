import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  MAX_OPTIONS,
  type OptionData,
  type QuestionAnswer,
  type QuestionData,
  type QuestionParams,
  type QuestionnaireResult,
  SENTINEL_LABELS,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

type TuiLike = {
  requestRender(): void;
};

type DoneFn = (result: QuestionnaireResult | null) => void;

type OptionRowKind = "option" | "other" | "chat" | "next";

interface OptionRow {
  kind: OptionRowKind;
  label: string;
  description?: string;
  preview?: string;
  optionIndex?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOptionRows(question: QuestionData): OptionRow[] {
  const rows: OptionRow[] = question.options.map((opt, idx) => ({
    kind: "option" as const,
    label: opt.label,
    description: opt.description,
    preview: opt.preview,
    optionIndex: idx,
  }));

  const hasPreview = question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
  if (!question.multiSelect) {
    rows.push({ kind: "other", label: SENTINEL_LABELS.other, description: "Type a custom answer" });
  }
  rows.push({ kind: "chat", label: SENTINEL_LABELS.chat, description: "Abandon the questionnaire and chat instead" });
  if (question.multiSelect) {
    rows.push({ kind: "next", label: SENTINEL_LABELS.next, description: "Confirm your selections and continue" });
  }
  return rows;
}

function selectListTheme(theme: ThemeLike): SelectListTheme {
  return {
    selectedPrefix: (t: string) => theme.fg("accent", t),
    selectedText: (t: string) => theme.fg("accent", t),
    description: (t: string) => theme.fg("muted", t),
    scrollInfo: (t: string) => theme.fg("dim", t),
    noMatch: (t: string) => theme.fg("warning", t),
  };
}

// ---------------------------------------------------------------------------
// QuestionnaireDialog
// ---------------------------------------------------------------------------

export class QuestionnaireDialog {
  readonly component: Component;

  private tui: TuiLike;
  private theme: ThemeLike;
  private params: QuestionParams;
  private optionRows: OptionRow[][];
  private done: DoneFn;

  // State
  private currentTab = 0;
  private phase: "questions" | "input" | "review" = "questions";

  // Answers
  private singleAnswers: (string | null)[];
  private multiSelected: Set<number>[];
  private previewTexts: (string | undefined)[];
  private chatAnswers: boolean[];

  // Input mode
  private inputContainer?: Container;
  private inputComponent?: Input;

  // SelectList per question (lazily created)
  private selectLists: (SelectList | null)[];

  // Current highlighted preview
  private currentPreview: string | undefined;

  constructor(opts: {
    tui: TuiLike;
    theme: ThemeLike;
    params: QuestionParams;
    done: DoneFn;
  }) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.params = opts.params;
    this.done = opts.done;

    const n = this.params.questions.length;
    this.optionRows = this.params.questions.map(buildOptionRows);
    this.singleAnswers = new Array(n).fill(null);
    this.multiSelected = Array.from({ length: n }, () => new Set<number>());
    this.previewTexts = new Array(n).fill(undefined);
    this.chatAnswers = new Array(n).fill(false);
    this.selectLists = new Array(n).fill(null);

    this.component = {
      render: (width: number) => this.render(width),
      handleInput: (data: string) => this.handleInput(data),
      invalidate: () => this.invalidate(),
    };
  }

  // ---- Input handling ----

  private handleInput(data: string): void {
    // In input mode, delegate to the Input component
    if (this.phase === "input" && this.inputComponent) {
      this.inputComponent.handleInput(data);
      return;
    }

    // Tab → next tab
    if (matchesKey(data, Key.tab)) {
      this.advanceTab();
      return;
    }

    // Escape → cancel
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }

    // Space → toggle multi-select
    const q = this.params.questions[this.currentTab];
    if (q?.multiSelect && matchesKey(data, Key.space)) {
      const list = this.getSelectList(this.currentTab);
      const item = list?.getSelectedItem();
      if (item) {
        const row = this.optionRows[this.currentTab]?.find((r) => r.label === item.value);
        if (row?.kind === "option" && row.optionIndex !== undefined) {
          const sel = this.multiSelected[this.currentTab];
          if (sel.has(row.optionIndex)) sel.delete(row.optionIndex);
          else sel.add(row.optionIndex);
          this.tui.requestRender();
          return;
        }
      }
    }

    // Delegate to the current SelectList
    const list = this.getSelectList(this.currentTab);
    list?.handleInput(data);
  }

  private advanceTab(): void {
    const totalTabs = this.params.questions.length + 1; // questions + review
    const next = (this.currentTab + 1) % totalTabs;
    if (next === this.params.questions.length) {
      this.phase = "review";
    } else {
      this.phase = "questions";
    }
    this.currentTab = next;
    this.currentPreview = undefined;
    this.invalidateSelectLists();
    this.tui.requestRender();
  }

  // ---- SelectList management ----

  private getSelectList(index: number): SelectList | null {
    if (index >= this.params.questions.length) return null;
    if (this.selectLists[index]) return this.selectLists[index]!;

    const question = this.params.questions[index];
    const rows = this.optionRows[index];
    const items: SelectItem[] = rows.map((row) => {
      const checkbox = question.multiSelect && row.kind === "option" && row.optionIndex !== undefined;
      const checked = checkbox && this.multiSelected[index].has(row.optionIndex!);
      const prefix = checkbox ? (checked ? "☑ " : "☐ ") : "";
      return {
        value: row.label,
        label: `${prefix}${row.label}`,
        description: row.description,
      };
    });

    const list = new SelectList(items, Math.min(items.length + 1, 12), selectListTheme(this.theme));

    list.onSelectionChange = (item: SelectItem) => {
      const row = rows.find((r) => r.label === item.value);
      this.currentPreview = row?.preview;
      this.tui.requestRender();
    };

    list.onSelect = (item: SelectItem) => {
      const row = rows.find((r) => r.label === item.value);
      if (!row) return;
      this.handleRowSelect(row, index);
    };

    list.onCancel = () => {
      this.done(null);
    };

    this.selectLists[index] = list;
    return list;
  }

  private handleRowSelect(row: OptionRow, questionIndex: number): void {
    const question = this.params.questions[questionIndex];

    switch (row.kind) {
      case "option": {
        if (question.multiSelect) {
          // Toggle and stay
          const sel = this.multiSelected[questionIndex];
          if (row.optionIndex !== undefined) {
            if (sel.has(row.optionIndex)) sel.delete(row.optionIndex);
            else sel.add(row.optionIndex);
          }
          this.tui.requestRender();
        } else {
          // Single-select: record and advance
          this.singleAnswers[questionIndex] = row.label;
          this.previewTexts[questionIndex] = row.preview;
          this.advanceTab();
        }
        break;
      }
      case "other": {
        this.enterInputMode(questionIndex);
        break;
      }
      case "chat": {
        this.chatAnswers[questionIndex] = true;
        this.advanceTab();
        break;
      }
      case "next": {
        // Multi-select confirm → advance
        this.advanceTab();
        break;
      }
    }
  }

  private enterInputMode(questionIndex: number): void {
    this.phase = "input";

    const input = new Input();
    const container = new Container();

    container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom answer")), 1, 0));
    container.addChild(new Text(this.theme.fg("muted", "Type your answer, then press Enter to confirm. Esc to go back."), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(input);

    input.onSubmit = (value: string) => {
      if (value.trim()) {
        this.singleAnswers[questionIndex] = value.trim();
        this.previewTexts[questionIndex] = undefined;
      }
      this.exitInputMode();
      this.advanceTab();
    };

    input.onEscape = () => {
      this.exitInputMode();
      this.tui.requestRender();
    };

    this.inputComponent = input;
    this.inputContainer = container;
    this.tui.requestRender();
  }

  private exitInputMode(): void {
    this.phase = "questions";
    this.inputComponent = undefined;
    this.inputContainer = undefined;
    this.tui.requestRender();
  }

  private invalidateSelectLists(): void {
    for (let i = 0; i < this.selectLists.length; i++) {
      this.selectLists[i] = null;
    }
  }

  // ---- Submission ----

  private submitFromReview(): void {
    const answers: QuestionAnswer[] = [];
    for (let i = 0; i < this.params.questions.length; i++) {
      const q = this.params.questions[i];
      if (this.chatAnswers[i]) {
        answers.push({
          questionIndex: i,
          question: q.question,
          kind: "chat",
          answer: "Chat about this",
        });
      } else if (q.multiSelect) {
        const selected = [...this.multiSelected[i]]
          .sort((a, b) => a - b)
          .map((idx) => q.options[idx]!.label);
        answers.push({
          questionIndex: i,
          question: q.question,
          kind: "multi",
          answer: null,
          selected,
        });
      } else if (this.singleAnswers[i] !== null) {
        const optIdx = q.options.findIndex((o) => o.label === this.singleAnswers[i]);
        answers.push({
          questionIndex: i,
          question: q.question,
          kind: optIdx >= 0 ? "option" : "custom",
          answer: this.singleAnswers[i],
          preview: this.previewTexts[i],
        });
      }
    }

    this.done({ answers, cancelled: false });
  }

  // ---- Rendering ----

  private render(width: number): string[] {
    if (this.phase === "input" && this.inputContainer) {
      return this.renderInputMode(width);
    }

    const container = new Container();

    // Top border
    container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));

    // Title
    container.addChild(
      new Text(
        this.theme.fg("accent", this.theme.bold("Questions")) +
          this.theme.fg("muted", ` (${this.currentTab < this.params.questions.length ? this.currentTab + 1 : this.params.questions.length + 1}/${this.params.questions.length + 1})`),
        1,
        0,
      ),
    );

    // Tab bar
    container.addChild(new Text(this.renderTabBar(width), 1, 0));
    container.addChild(new Spacer(1));

    // Content
    if (this.currentTab < this.params.questions.length) {
      this.renderQuestionContent(container, this.currentTab, width);
    } else {
      this.renderReviewContent(container, width);
    }

    // Hints
    container.addChild(new Spacer(1));
    container.addChild(new Text(this.renderHints(), 1, 0));

    // Bottom border
    container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));

    return container.render(width);
  }

  private renderInputMode(width: number): string[] {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    if (this.inputContainer) {
      container.addChild(this.inputContainer);
    }
    container.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
    return container.render(width);
  }

  private renderTabBar(width: number): string {
    const tabs: string[] = [];
    for (let i = 0; i < this.params.questions.length; i++) {
      const q = this.params.questions[i];
      const isActive = i === this.currentTab;
      const answered = this.isAnswered(i);
      const dot = answered ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
      const label = isActive
        ? this.theme.fg("accent", this.theme.bold(q.header))
        : this.theme.fg("muted", q.header);
      tabs.push(`${dot} ${label}`);
    }
    // Submit tab
    const isReview = this.currentTab === this.params.questions.length;
    const submitLabel = isReview
      ? this.theme.fg("accent", this.theme.bold("Submit"))
      : this.theme.fg("muted", "Submit");
    tabs.push(submitLabel);

    return truncateToWidth(tabs.join("  "), width - 4, "…");
  }

  private renderQuestionContent(container: Container, index: number, width: number): void {
    const q = this.params.questions[index];

    // Question text
    container.addChild(
      new Text(this.theme.fg("text", q.question), 1, 0),
    );
    container.addChild(new Spacer(1));

    // Options (via SelectList)
    const list = this.getSelectList(index);
    if (list) {
      container.addChild(list);
    }

    // Preview pane (if current option has preview)
    if (this.currentPreview) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(this.theme.fg("dim", "─── Preview ───"), 1, 0),
      );
      const previewLines = this.currentPreview.split("\n");
      const maxPreviewLines = 8;
      const shown = previewLines.slice(0, maxPreviewLines);
      container.addChild(
        new Text(
          shown.map((l) => this.theme.fg("toolOutput", l)).join("\n"),
          1,
          0,
        ),
      );
      if (previewLines.length > maxPreviewLines) {
        container.addChild(
          new Text(this.theme.fg("dim", `... +${previewLines.length - maxPreviewLines} more lines`), 1, 0),
        );
      }
    }
  }

  private renderReviewContent(container: Container, width: number): void {
    container.addChild(
      new Text(this.theme.fg("accent", this.theme.bold("Review your answers")), 1, 0),
    );
    container.addChild(new Spacer(1));

    for (let i = 0; i < this.params.questions.length; i++) {
      const q = this.params.questions[i];
      const answered = this.isAnswered(i);
      const answerText = this.getAnswerSummary(i);

      const dot = answered ? this.theme.fg("success", "●") : this.theme.fg("warning", "○");
      const header = this.theme.fg("muted", `[${q.header}]`);
      const questionText = truncateToWidth(q.question, width - 10, "…");
      container.addChild(new Text(`${dot} ${header} ${questionText}`, 1, 0));

      if (answered) {
        container.addChild(
          new Text(`   ${this.theme.fg("text", answerText)}`, 1, 0),
        );
      } else {
        container.addChild(
          new Text(`   ${this.theme.fg("warning", "(unanswered)")}`, 1, 0),
        );
      }

      if (i < this.params.questions.length - 1) {
        container.addChild(new Spacer(1));
      }
    }

    container.addChild(new Spacer(1));
    container.addChild(
      new Text(this.theme.fg("accent", "Press Enter to submit, or Tab to go back and edit."), 1, 0),
    );
  }

  private renderHints(): string {
    if (this.currentTab >= this.params.questions.length) {
      return this.theme.fg("dim", "Enter submit • Tab back • Esc cancel");
    }
    const q = this.params.questions[this.currentTab];
    if (q.multiSelect) {
      return this.theme.fg("dim", "Space toggle • Enter/Next confirm • Tab next question • Esc cancel");
    }
    return this.theme.fg("dim", "↑↓ navigate • Enter select • Tab next question • Esc cancel");
  }

  // ---- Answer state helpers ----

  private isAnswered(index: number): boolean {
    const q = this.params.questions[index];
    if (this.chatAnswers[index]) return true;
    if (q.multiSelect) return this.multiSelected[index].size > 0;
    return this.singleAnswers[index] !== null;
  }

  private getAnswerSummary(index: number): string {
    const q = this.params.questions[index];
    if (this.chatAnswers[index]) return "Chat about this";
    if (q.multiSelect) {
      const selected = [...this.multiSelected[index]]
        .sort((a, b) => a - b)
        .map((idx) => q.options[idx]!.label);
      return selected.join(", ") || "(none)";
    }
    return this.singleAnswers[index] ?? "(none)";
  }

  private invalidate(): void {
    this.invalidateSelectLists();
    this.inputContainer = undefined;
    this.inputComponent = undefined;
  }
}
