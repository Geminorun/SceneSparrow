import { useEffect, useState } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";

type Heading = {
  text: string;
  offset: number;
  depth: number;
};
function textContent(node: {
  type: string;
  value?: string;
  alt?: string | null | undefined;
  children?: Parameters<typeof textContent>[0][];
}): string {
  return (
    node.value ?? node.alt ?? node.children?.map(textContent).join("") ?? ""
  );
}
function readHeadings(text: string): Heading[] {
  const bom = text.startsWith("\ufeff") ? 1 : 0;
  return fromMarkdown(text.slice(bom)).children.flatMap((node) =>
    node.type === "heading"
      ? [
          {
            text: textContent(node),
            offset: (node.position?.start.offset ?? 0) + bom,
            depth: node.depth,
          },
        ]
      : [],
  );
}
export function HeadingNavigation({
  text,
  label,
  empty,
  onSelect,
}: {
  text: string;
  label: string;
  empty: string;
  onSelect: (offset: number) => void;
}) {
  const [outline, setOutline] = useState<{ text: string; headings: Heading[] }>(
    { text: "", headings: [] },
  );
  useEffect(() => {
    const timer = setTimeout(
      () => setOutline({ text, headings: readHeadings(text) }),
      200,
    );
    return () => clearTimeout(timer);
  }, [text]);
  function select(heading: Heading) {
    const matches = (candidate: Heading) =>
      candidate.text === heading.text && candidate.depth === heading.depth;
    const occurrence = outline.headings.filter(matches).indexOf(heading);
    // Resolve against live text when the navigation is waiting for its debounce.
    const current =
      outline.text === text ? outline.headings : readHeadings(text);
    const target = current.filter(matches)[occurrence];
    if (target) onSelect(target.offset);
  }
  return (
    <nav aria-label={label}>
      {outline.headings.length ? (
        <ul>
          {outline.headings.map((heading, index) => (
            <li
              key={index}
              style={{
                paddingInlineStart: `${(heading.depth - 1) * 0.75}rem`,
              }}
            >
              <button onClick={() => select(heading)}>
                {heading.text || label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </nav>
  );
}
