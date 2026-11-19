import { useEffect, type RefObject } from "react";
import { EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import type { ManuscriptState } from "@scenesparrow/contracts";
import type { ProjectSession } from "../project-session/project-session";
import { useManuscriptEditor } from "./use-manuscript-editor";
export function LegacyEditor({
  initial,
  save,
  label,
  protectionReady,
  sourceVisible,
  onEditor,
}: {
  initial: ManuscriptState;
  save: ProjectSession;
  label: string;
  protectionReady: boolean;
  sourceVisible: RefObject<boolean>;
  onEditor: (editor: Editor | null) => void;
}) {
  const { editor } = useManuscriptEditor({
    initial,
    save,
    label,
    protectionReady,
    sourceVisible,
  });
  useEffect(() => {
    onEditor(editor);
    return () => onEditor(null);
  }, [editor, onEditor]);
  return <EditorContent editor={editor} />;
}
