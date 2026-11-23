import { createElement, memo, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";

type Node = {
  type: string;
  value?: string;
  alt?: string | null | undefined;
  depth?: number;
  ordered?: boolean | null | undefined;
  start?: number | null | undefined;
  children?: Node[];
};
// Render text and structure only: generated HTML, links and images have no active capabilities.
function content(node: Node, key: number): ReactNode {
  const children = node.children?.map(content);
  switch (node.type) {
    case "heading":
      return createElement(`h${node.depth}`, { key }, children);
    case "paragraph":
      return <p key={key}>{children}</p>;
    case "strong":
      return <strong key={key}>{children}</strong>;
    case "emphasis":
      return <em key={key}>{children}</em>;
    case "blockquote":
      return <blockquote key={key}>{children}</blockquote>;
    case "list":
      return node.ordered ? (
        <ol key={key} start={node.start ?? 1}>
          {children}
        </ol>
      ) : (
        <ul key={key}>{children}</ul>
      );
    case "listItem":
      return <li key={key}>{children}</li>;
    case "code":
      return (
        <pre key={key}>
          <code>{node.value}</code>
        </pre>
      );
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "thematicBreak":
      return <hr key={key} />;
    case "break":
      return <br key={key} />;
    default:
      return <span key={key}>{node.value ?? node.alt ?? children}</span>;
  }
}
export const MarkdownPreview = memo(function MarkdownPreview({
  text,
}: {
  text: string;
}) {
  return (
    <div className="markdown-preview">
      {fromMarkdown(text).children.map(content)}
    </div>
  );
});
