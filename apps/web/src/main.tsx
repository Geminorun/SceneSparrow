import { createRoot } from "react-dom/client";
import { App } from "@scenesparrow/editor-ui";
import {
  createHttpClient,
  type PlatformClient,
} from "@scenesparrow/platform-client";
import "@scenesparrow/editor-ui/styles.css";

declare global {
  interface Window {
    sceneSparrow?: PlatformClient;
  }
}
const client = window.sceneSparrow ?? createHttpClient();
createRoot(document.getElementById("root")!).render(<App client={client} />);
