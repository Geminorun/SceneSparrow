import { createServer } from "node:http";
export function planningOutput(request) {
  const text = request.messages.find((m) => m.role === "user").content;
  const input = JSON.parse(
    typeof text === "string" ? text : text.find((p) => p.type === "text").text,
  );
  const { planning, operation, evidence } = input;
  if (operation !== "generate_initial_draft")
    return {
      schemaVersion: 1,
      nodes: [
        {
          existingId:
            operation === "adjust_outline"
              ? (planning.nodes[0]?.id ?? null)
              : null,
          depth: 0,
          title: "How sparrows learn 鸟鸣",
          keyPoints: ["Observe", "Explain"],
        },
        {
          existingId: null,
          depth: 0,
          title: "A practical example 示例",
          keyPoints: ["Connect to daily life"],
        },
      ],
    };
  return {
    schemaVersion: 1,
    sections: planning.nodes.map((n) => ({
      outlineNodeId: n.id,
      blocks: [
        {
          kind: "paragraph",
          attrs: {},
          runs: [
            {
              text: `完整初稿：${n.title}。这是可编辑的文稿内容 🐦。`,
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    })),
    evidenceReferences: evidence.length
      ? [{ evidenceId: evidence[0].id, outlineNodeId: planning.nodes[0].id }]
      : [],
    verificationHints: ["Generated claims need independent verification."],
    planningNotes: ["The outline supplied the structure."],
  };
}
export async function planningProvider() {
  const calls = [];
  let handler;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const value = JSON.parse(body || "{}");
    calls.push({ path: req.url, body: value });
    if (handler) await handler(req, res, value);
    else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { content: JSON.stringify(planningOutput(value)) },
              finish_reason: "stop",
            },
          ],
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    root: `http://127.0.0.1:${server.address().port}/compatible`,
    setHandler(value) {
      handler = value;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
export async function configurePlanning(
  req,
  root,
  { maxOutputTokens = 2048 } = {},
) {
  const view = (await req("/ai/settings")).data;
  const id = crypto.randomUUID();
  const unknown = {
    state: "unknown",
    source: "unknown",
    scope: "",
    observedAt: null,
  };
  const settings = {
    ...view.settings,
    providers: [
      {
        id,
        label: "Counted planning fixture",
        adapter: "openai_compatible",
        baseUrl: root,
        authMode: "none",
        credentialRevision: null,
        revision: 1,
      },
    ],
    models: [
      {
        providerId: id,
        id: "planning-fixture",
        label: "Planning fixture",
        capabilities: {
          images: unknown,
          streaming: unknown,
          nativeJson: unknown,
        },
        contextTokens: 32768,
        outputTokens: 8192,
        tokenField: "max_tokens",
      },
    ],
    bindings: [
      {
        category: "text",
        providerId: id,
        modelId: "planning-fixture",
        parameters: {
          temperatureMilli: null,
          maxOutputTokens,
          requestStreaming: false,
          requestNativeJson: false,
        },
        revision: 1,
      },
    ],
  };
  const result = await req(
    "/ai/settings",
    { expectedRevision: view.settings.revision, settings },
    "PUT",
  );
  if (result.status !== 200) throw Error(JSON.stringify(result));
  return result.data;
}
