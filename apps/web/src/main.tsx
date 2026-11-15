import { createRoot } from "react-dom/client";
import { App } from "@scenesparrow/editor-ui";
import {
  createHttpClient,
  createDesktopClient,
  type DesktopBridge,
} from "@scenesparrow/platform-client";
import "@scenesparrow/editor-ui/styles.css";

declare global {
  interface Window {
    sceneSparrow?: DesktopBridge;
  }
}
const client = window.sceneSparrow
  ? createDesktopClient(window.sceneSparrow)
  : createHttpClient();
createRoot(document.getElementById("root")!).render(<App client={client} />);
