import { useState } from "react";
import type { Editor } from "@tiptap/core";
import type en from "../locales/en.json";
export function DocumentToolbar({
  editor,
  t,
  toolbar,
}: {
  editor: Editor | null;
  t: typeof en;
  toolbar: (action: () => unknown) => void;
}) {
  const [link, setLink] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  return (
    <>
      <div className="editor-toolbar" role="toolbar" aria-label={t.formatting}>
        <select
          aria-label={t.blockStyle}
          value=""
          onChange={(e) => {
            const value = e.target.value;
            toolbar(() =>
              value === "paragraph"
                ? editor?.chain().setParagraph().run()
                : editor
                    ?.chain()
                    .setHeading({
                      level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6,
                    })
                    .run(),
            );
          }}
        >
          <option value="" disabled>
            {t.blockStyle}
          </option>
          <option value="paragraph">{t.paragraph}</option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {t.heading} {n}
            </option>
          ))}
        </select>
        <button
          aria-label={t.bold}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toolbar(() => editor?.chain().toggleBold().run())}
        >
          <strong>B</strong>
        </button>
        <button
          aria-label={t.italic}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toolbar(() => editor?.chain().toggleItalic().run())}
        >
          <em>I</em>
        </button>
        <button
          aria-label={t.inlineCode}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toolbar(() => editor?.chain().toggleCode().run())}
        >
          {"</>"}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            toolbar(() => editor?.chain().toggleBulletList().run())
          }
        >
          {t.bulletList}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            toolbar(() => editor?.chain().toggleOrderedList().run())
          }
        >
          {t.orderedList}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setLink(String(editor?.getAttributes("link").href ?? ""));
            setLinkOpen(!linkOpen);
          }}
        >
          {t.link}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toolbar(() => editor?.chain().unsetLink().run())}
        >
          {t.removeLink}
        </button>
      </div>
      {linkOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (/^(https?:\/\/|mailto:)/i.test(link)) {
              toolbar(() =>
                editor
                  ?.chain()
                  .extendMarkRange("link")
                  .setLink({ href: link })
                  .run(),
              );
              setLinkOpen(false);
            }
          }}
        >
          <label>
            {t.linkUrl}
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              required
              pattern="(https?://|mailto:).*"
            />
          </label>
          <button type="submit">{t.applyLink}</button>
        </form>
      )}
    </>
  );
}
