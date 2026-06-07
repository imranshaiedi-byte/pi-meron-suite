import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTodoCountsForFooter } from "./todo-extension.js";

interface Theme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

interface TUI {
  requestRender(): void;
}

interface DashboardData {
  contextPercent: number;
  contextWindow: number;
  activeTasks: number;
  sessionCost: number;
  thinkingLevel: string;
}

function formatContextBar(percent: number, theme: Theme): string {
  const width = 10;
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  
  const barColor = percent > 80 ? "error" : percent > 60 ? "warning" : "success";
  const filledBar = theme.fg(barColor, "█".repeat(filled));
  const emptyBar = theme.fg("dim", "░".repeat(empty));
  
  return `[${filledBar}${emptyBar}] ${percent.toFixed(0)}%`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

function getDashboardData(ctx: any, thinkingLevel: string): DashboardData {
  // Get context usage
  const contextUsage = ctx.getContextUsage?.();
  const contextPercent = contextUsage?.percent ?? 0;
  const contextWindow = contextUsage?.contextWindow ?? 0;
  
  // Get active tasks using the exported function
  const todoCounts = getTodoCountsForFooter();
  const activeTasks = todoCounts.open;
  
  // Calculate session cost (matching footer.ts implementation)
  let sessionCost = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      sessionCost += entry.message.usage?.cost?.total ?? 0;
    }
  }
  
  return {
    contextPercent,
    contextWindow,
    activeTasks,
    sessionCost,
    thinkingLevel,
  };
}

export function registerDashboard(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    
    ctx.ui.setWidget("meron-dashboard", {
      placement: "aboveEditor",
      render: (tui: TUI, theme: Theme, width: number): string[] => {
        const thinkingLevel = pi.getThinkingLevel();
        const data = getDashboardData(ctx, thinkingLevel);
        
        const contextBar = formatContextBar(data.contextPercent, theme);
        const taskCount = theme.fg("accent", `⚡ ${data.activeTasks}`);
        const cost = theme.fg("muted", formatCost(data.sessionCost));
        const mode = theme.fg("dim", data.thinkingLevel);
        
        // Build the dashboard line
        const parts = [
          theme.fg("muted", "Context:"),
          contextBar,
          theme.fg("dim", "│"),
          taskCount,
          theme.fg("dim", "│"),
          cost,
          theme.fg("dim", "│"),
          mode,
        ];
        
        const line = parts.join(" ");
        
        // Add separator line
        const separator = theme.fg("dim", "─".repeat(Math.min(width, 80)));
        
        return [line, separator];
      },
    });
  });
}
