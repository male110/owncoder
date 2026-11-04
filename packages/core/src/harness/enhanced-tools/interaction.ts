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
