export type SaveStatus = "saved" | "pending" | "saving" | "error" | "conflict";

export type SaveFeedback = {
  status: SaveStatus;
  error: string;
  retry: () => Promise<unknown>;
};
