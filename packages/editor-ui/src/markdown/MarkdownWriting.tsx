export type WritingCapture = {
  projectId: string;
  revision: string;
  text: string;
  epoch: number;
  session: object;
  outline?:
    | {
        session: object;
        text: string;
        revision: string | null;
        epoch: number;
      }
    | undefined;
};
export type WritingDraft = {
  capture: WritingCapture;
  text: string;
  conflict?: boolean;
};
