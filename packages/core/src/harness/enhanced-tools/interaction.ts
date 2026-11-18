import type { ToolDef } from "@owncoder/llm";

// ── Handoff Tool ──────────────────────────────────────────

/**
 * report_blocker — the explicit "hand back to the user" terminal action.
 *
 * Without this the ReAct loop can only end by finishing the work or by
 * exhausting a budget, so a turn whose remaining work belongs to the user has
 * no compliant way to stop: the model keeps searching for another route and
 * drifts into work nobody asked for. Calling this tool ends the turn cleanly and
 * suppresses every autonomous follow-up stage (verify / auto-fix / task
 * auto-advance) while still presenting whatever was already changed.
 */
export const REPORT_BLOCKER_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "report_blocker",
    description:
      "End the turn and hand control back to the user. This is a SUCCESSFUL ending, not a failure — " +
      "use it whenever the remaining work is not yours to do. " +
      "Call it when: the root cause lies in user-owned runtime state (database rows, .env, credentials, " +
      "deployed config, external service or account settings); the user has forbidden an action and every " +
      "route you can see runs through it; progress needs a decision only the user can make (a tradeoff, a " +
      "scope change, a credential, approval of an irreversible action); the task rests on a premise you " +
      "found to be false; or 2-3 focused attempts at a real obstacle failed and you have no new hypothesis. " +
      "Do NOT look for a workaround to a goal the user just blocked, and do NOT build tooling (admin UI, " +
      "management API, migration script) that would let you perform the forbidden change — report instead. " +
      "After calling this, stop: issue no further tool calls this turn.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [
            "user_owned_state",
            "user_prohibited",
            "needs_user_decision",
            "false_premise",
            "attempts_exhausted",
          ],
          description:
            "Why you are handing back. 'user_owned_state' = the fix belongs to data/config the user owns; " +
            "'user_prohibited' = the user forbade the only route you can see; " +
            "'needs_user_decision' = a choice, credential, or approval is required; " +
            "'false_premise' = the request assumes something untrue; " +
            "'attempts_exhausted' = repeated focused attempts failed with no new hypothesis.",
        },
        summary: {
          type: "string",
          description:
            "The blocker or root cause, stated concretely. Name the specific thing (file, table, field, " +
            "setting, value) and how you determined it. Do not hedge or generalize.",
        },
        userAction: {
          type: "string",
          description:
            "Exactly what the user must do or decide to unblock this — the precise remediation, including " +
            "current value and intended value where applicable. If the user must choose between options, " +
            "list them with the tradeoff.",
        },
        completed: {
          type: "string",
          description:
            "Optional. What you did finish and verify before stopping, so the user knows the current state.",
        },
      },
      required: ["reason", "summary", "userAction"],
    },
  },
};

// ── Plan Submission Tool ─────────────────────────────────

/**
 * submit_plan — the Planner subagent's structural terminal action.
 *
 * Without an explicit submission signal a read-only planning loop can only end
 * by the model spontaneously emitting text-only turns, which weak executor
 * models rarely do — the loop then burns its entire budget on tool calls and
 * the parent discards the result as a partial report (the "never converges"
 * failure mode). Calling this tool hands the finished plan to the ReAct loop,
 * which terminates immediately and returns the plan text as the final report.
 *
 * Pure control flow: no side effect. Registered only for planner loops
 * (allEnhancedTools plannerLoop flag), so the main agent never sees it.
 */
export const SUBMIT_PLAN_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "submit_plan",
    description:
      "Submit the finished execution plan and end the planning loop. This is the ONLY successful way to finish: " +
      "when your plan is grounded in the evidence already gathered, call this tool with the complete plan text as the `plan` parameter. " +
      "The plan is plain text — the runner adds the standard report heading — and must contain the five sections: 目标, 编号步骤, 相关文件, 风险与不确定性, 验证方式. " +
      "Unresolved unknowns belong under 风险与不确定性 — do not keep researching to resolve them. " +
      "After calling this, stop: issue no further tool calls.",
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "The complete plan text: 目标 / 编号步骤 / 相关文件 / 风险与不确定性 / 验证方式 five sections. " +
            "Every numbered step must name the file, the symbol, and the change to make.",
        },
      },
      required: ["plan"],
    },
  },
};

// ── Report Submission Tool ───────────────────────────────

/**
 * submit_report — the Explore subagent's structural terminal action.
 *
 * Same failure mode as the Planner loop: a read-only research loop whose only
 * successful exit is a spontaneous text-only turn never converges on weak
 * executor models. Calling this tool hands the finished research report to the
 * ReAct loop, which terminates immediately and returns the report text as the
 * final findings.
 *
 * Pure control flow: no side effect. Registered only for explore loops
 * (allEnhancedTools exploreLoop flag), so the main agent never sees it.
 */
export const SUBMIT_REPORT_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "submit_report",
    description:
      "Submit the finished research report and end the exploration loop. This is the ONLY successful way to finish: " +
      "when the research question is established by the evidence already gathered, call this tool with the complete report as the `report` parameter. " +
      "The complete report text: concise summary of findings, each finding cited with workspace-relative file paths and line numbers, " +
      "distinguish confirmed facts from inference, state explicitly what could not be found, and end with a conclusion the parent can act on immediately. " +
      "Gaps are stated, not researched further. After calling this, stop: issue no further tool calls.",
    parameters: {
      type: "object",
      properties: {
        report: {
          type: "string",
          description:
            "The complete report text: concise summary of findings, per-finding evidence " +
            "(workspace-relative paths and line numbers), searched patterns, and a clear conclusion.",
        },
      },
      required: ["report"],
    },
  },
};

// ── Ask User Tool ─────────────────────────────────────────

/**
 * ask_user — ask the user a question and wait for an answer.
 *
 * The question may include selectable choices or allow a free-text response.
 * The turn pauses until the user responds.
 */
export const ASK_USER_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "ask_user",
    description:
      "Ask the user one question and wait for their response. " +
      "Use options for selectable choices or allowFreeText=true for an open-ended response. " +
      "Execution pauses until the user responds.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to present to the user.",
        },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short label shown on the choice button." },
              value: { type: "string", description: "Value returned to you when the user picks this option." },
              description: { type: "string", description: "Optional one-line explanation of the option." },
            },
            required: ["label", "value"],
          },
          description:
            "Optional selectable choices. The selected value is returned to you.",
        },
        allowFreeText: {
          type: "boolean",
          description: "If true, the user may type a free-text answer instead of picking an option. Default false.",
        },
        placeholder: {
          type: "string",
          description: "Placeholder hint for the free-text input (only used when allowFreeText is true).",
        },
      },
      required: ["question"],
    },
  },
};
