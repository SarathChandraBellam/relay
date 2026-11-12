import { useDefaultRenderTool, useFrontendTool, useInterrupt } from "@copilotkit/react-core/v2";
import { z } from "zod";

const chartSchema = z.object({
  title: z.string().describe("Chart title"),
  points: z.array(z.object({ label: z.string(), value: z.number() })).describe("Bars to draw"),
});

function BarChart({ title, points }: Partial<z.infer<typeof chartSchema>>) {
  const max = Math.max(1, ...(points ?? []).map((p) => p.value));
  return (
    <div className="card chart">
      <div className="card-title">{title ?? "Chart"}</div>
      {(points ?? []).map((point, index) => (
        <div className="bar-row" key={index}>
          <span className="bar-label">{point.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(point.value / max) * 100}%` }} />
          </span>
          <span className="bar-value">{point.value}</span>
        </div>
      ))}
    </div>
  );
}

interface ApprovalRequest {
  action_requests?: { name: string; args: Record<string, unknown>; description?: string }[];
}

const parse = (value: unknown): ApprovalRequest => {
  if (typeof value !== "string") return (value ?? {}) as ApprovalRequest;
  try {
    return JSON.parse(value) as ApprovalRequest;
  } catch {
    return {};
  }
};

/**
 * Registers what the browser contributes to the agent:
 *
 *  - `render_chart`, a tool that runs here. The agent's run ends when it calls
 *    the tool; the browser draws the chart and starts a new run with the result.
 *  - the approval card for tools the agent may not run on its own.
 */
export function AgentTools({ agentId }: { agentId: string }) {
  useFrontendTool({
    name: "render_chart",
    description: "Draw a bar chart in the chat.",
    parameters: chartSchema,
    handler: async ({ points }) => `Rendered a chart with ${points.length} bars.`,
    render: ({ args }) => <BarChart {...args} />,
  });

  // A plain card for the agent's own tools (lookup_order, issue_refund, ...).
  useDefaultRenderTool();

  useInterrupt({
    agentId,
    render: ({ event, resolve }) => {
      const requests = parse(event.value).action_requests ?? [];
      const decide = (type: "approve" | "reject") =>
        resolve({ decisions: requests.map(() => (type === "approve" ? { type } : { type, message: "The user declined." })) });
      return (
        <div className="card approval">
          <div className="card-title">Approval needed</div>
          {requests.map((request, index) => (
            <div className="approval-item" key={index}>
              <code>{request.name}</code>
              <pre>{JSON.stringify(request.args, null, 2)}</pre>
            </div>
          ))}
          <div className="approval-actions">
            <button className="primary" onClick={() => decide("approve")}>
              Approve
            </button>
            <button onClick={() => decide("reject")}>Reject</button>
          </div>
        </div>
      );
    },
  });

  return null;
}
