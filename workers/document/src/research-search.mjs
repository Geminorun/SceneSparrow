// Bounded public-search adapter. The writing runner receives text only.
import { pathToFileURL } from "node:url";

export function endpointUrl(value) {
  const url = new URL(value);
  if (
    /[\u0000-\u0020\u007f]/u.test(value) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      ))
  )
    throw Error("invalid endpoint");
  return url;
}
function sourceUrl(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  )
    throw Error("invalid link");
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("invalid link");
  return url.href;
}
export async function search(
  endpoint,
  question,
  signal = AbortSignal.timeout(8000),
) {
  const url = endpointUrl(endpoint);
  // Only the explicit quote and question query crosses this boundary.
  url.searchParams.set("q", [...question.trim()].slice(0, 512).join(""));
  url.searchParams.set("format", "json");
  const response = await fetch(url, {
    signal,
    redirect: "error",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw Error("unavailable");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > 65536))
    throw Error("response limit");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 65536) {
      await response.body.cancel().catch(() => {});
      throw Error("response limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const entries = Array.isArray(data.sources)
    ? data.sources
    : Array.isArray(data.results)
      ? data.results.map((entry) => ({ ...entry, excerpt: entry?.content }))
      : null;
  if (!entries) throw Error("invalid sources");
  const sources = [];
  let partial = data.partial === true || entries.length > 16;
  for (const entry of entries.slice(0, 16)) {
    try {
      if (
        !entry ||
        typeof entry.title !== "string" ||
        !entry.title.trim() ||
        entry.title.length > 512 ||
        typeof entry.excerpt !== "string" ||
        !entry.excerpt.trim() ||
        entry.excerpt.length > 8192 ||
        /[\u0000]/u.test(entry.title + entry.excerpt)
      )
        throw Error("invalid source");
      const url = sourceUrl(entry.url);
      if (sources.some((s) => s.url === url) || sources.length >= 4) {
        partial = true;
        continue;
      }
      sources.push({
        id: `public-${sources.length + 1}`,
        title: entry.title.trim(),
        url,
        excerpt: [...entry.excerpt].slice(0, 1600).join(""),
      });
    } catch {
      partial = true;
    }
  }
  return {
    status: partial ? "partial" : sources.length ? "complete" : "empty",
    sources,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 32768) process.exit(1);
  }
  try {
    const { endpoint, question } = JSON.parse(input);
    process.stdout.write(JSON.stringify(await search(endpoint, question)));
  } catch {
    process.exitCode = 1;
  }
}
