import type en from "../locales/en.json";

// Linear comparison; input is bounded by the manuscript's 2 MiB limit.
export function ExchangeComparison({
  current,
  returned,
  t,
}: {
  current: string;
  returned: string;
  t: typeof en;
}) {
  let start = 0;
  while (
    start < current.length &&
    start < returned.length &&
    current[start] === returned[start]
  )
    start++;
  start = start === 0 ? 0 : current.lastIndexOf("\n", start - 1) + 1;
  let end = 0;
  while (
    end < current.length - start &&
    end < returned.length - start &&
    current[current.length - end - 1] === returned[returned.length - end - 1]
  )
    end++;
  const suffix = current.slice(current.length - end);
  const line = suffix.indexOf("\n");
  end = line < 0 ? 0 : end - line - 1;
  const prefix = current.slice(Math.max(0, start - 1000), start);
  const tail = end
    ? current.slice(current.length - end, current.length - end + 1000)
    : "";
  return (
    <div className="markdown-exchange-diff">
      {prefix && <pre>{prefix}</pre>}
      <h3>{t.markdownCurrentText}</h3>
      <pre className="markdown-diff-removed">
        {current.slice(start, current.length - end)}
      </pre>
      <h3>{t.markdownReturnedText}</h3>
      <pre className="markdown-diff-added">
        {returned.slice(start, returned.length - end)}
      </pre>
      {tail && <pre>{tail}</pre>}
    </div>
  );
}
