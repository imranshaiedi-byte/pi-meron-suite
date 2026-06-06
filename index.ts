import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolDisplayExtension from "./src/index.js";
import { registerMeronFooter } from "./src/meron-footer.js";
import { registerTodoExtension } from "./src/todo-extension.js";
import { registerAskUserQuestionTool } from "./src/ask-user/tool.js";

export default function meronSuite(pi: ExtensionAPI): void {
  toolDisplayExtension(pi);
  registerMeronFooter(pi);
  registerTodoExtension(pi);
  registerAskUserQuestionTool(pi);
}
