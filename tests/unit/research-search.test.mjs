import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { endpointUrl, search } from "../../workers/research/search.mjs";

async function server(t, handler) {
  const app = createServer(handler);
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(() => {
    app.closeAllConnections();
    app.close();
  });
  return `http://127.0.0.1:${app.address().port}/search`;
}
test("research validates operator endpoints and refuses credentials, fragments, queries, and non-loopback HTTP", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://search.example/search",
    "https://user:secret@search.example",
    "https://search.example/#secret",
    "https://search.example/?key=secret",
    "https://search.example/\npath",
  ])
    assert.throws(() => endpointUrl(url));
  assert.equal(
    endpointUrl("https://search.example/search").host,
    "search.example",
  );
});
test("research performs real loopback HTTP retrieval and preserves actual SearXNG metadata", async (t) => {
  const query = "鄱阳湖的面积约为三千平方公里。这句话有出处吗？";
  const endpoint = await server(t, (request, response) => {
    const url = new URL(request.url, "http://localhost");
    assert.equal(url.searchParams.get("q"), query);
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(request.method, "GET");
    response.end(
      JSON.stringify({
        results: [
          {
            title: "湖泊调查 · Lake survey",
            url: "https://evidence.example/lake",
            content: "调查中的面积随季节变化。",
          },
        ],
      }),
    );
  });
  const result = await search(endpoint, query);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.sources, [
    {
      id: "public-1",
      title: "湖泊调查 · Lake survey",
      url: "https://evidence.example/lake",
      excerpt: "调查中的面积随季节变化。",
    },
  ]);
});
test("research retains valid partial sources, bounds Unicode excerpts, and rejects unsafe citations", async (t) => {
  const endpoint = await server(t, (_, response) =>
    response.end(
      JSON.stringify({
        sources: [
          {
            title: "Actual title",
            url: "https://evidence.example/a",
            excerpt: "𠮷中".repeat(2000),
          },
          {
            title: "Unsafe",
            url: "javascript:alert(1)",
            excerpt: "not evidence",
          },
        ],
      }),
    ),
  );
  const result = await search(endpoint, "question");
  assert.equal(result.status, "partial");
  assert.equal(result.sources.length, 1);
  assert.equal([...result.sources[0].excerpt].length, 1600);
  assert.equal(result.sources[0].excerpt, "𠮷中".repeat(800));
});
test("research keeps valid SearXNG rows when another row is malformed", async (t) => {
  const endpoint = await server(t, (_, response) =>
    response.end(
      JSON.stringify({
        results: [
          null,
          {
            title: "Actual",
            url: "https://evidence.example/a",
            content: "Evidence",
          },
        ],
      }),
    ),
  );
  const result = await search(endpoint, "question");
  assert.equal(result.status, "partial");
  assert.equal(result.sources[0].title, "Actual");
});

test("research reports an actual empty result without inventing sources", async (t) => {
  const endpoint = await server(t, (_, response) =>
    response.end('{"sources":[]}'),
  );
  assert.deepEqual(await search(endpoint, "question"), {
    status: "empty",
    sources: [],
  });
});
test("research rejects unavailable, lost, redirected, and oversized HTTP responses", async (t) => {
  for (const mode of [
    "unavailable",
    "lost",
    "redirect",
    "large",
    "stream-large",
  ]) {
    const endpoint = await server(t, (request, response) => {
      if (mode === "lost") return request.socket.destroy();
      if (mode === "redirect") {
        response.writeHead(302, { location: "http://127.0.0.1:1/secret" });
        return response.end();
      }
      if (mode === "unavailable") {
        response.statusCode = 503;
        return response.end();
      }
      if (mode === "large") {
        response.setHeader("content-length", "70000");
        return response.end("x".repeat(70000));
      }
      response.write("x".repeat(32768));
      response.end("x".repeat(32769));
    });
    await assert.rejects(search(endpoint, "question"));
  }
});
test("research aborts an in-flight HTTP request", async (t) => {
  let arrived;
  const seen = new Promise((resolve) => {
    arrived = resolve;
  });
  const endpoint = await server(t, () => arrived());
  const controller = new AbortController();
  const request = search(endpoint, "question", controller.signal);
  await seen;
  controller.abort();
  await assert.rejects(request);
});
