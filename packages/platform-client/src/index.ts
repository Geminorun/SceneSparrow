export type {
  BridgeResult,
  DesktopBridge,
  PlatformClient,
  RecentProject,
} from "./types";
export { ApiError, TransportError } from "./errors";
export { onTransportFailure } from "./transport";
export { createHttpClient } from "./http";
export { createDesktopClient } from "./desktop";
export { validateExternalLink } from "./links";
export { subscribeProjectEvents } from "./events";

export type {
  ProjectPackageClient,
  ProjectPackageBridge,
} from "./project-package";

export { PackageFileUpload, PACKAGE_CHUNK_BYTES } from "./package-file";
export { safePackageFilename } from "./package-name.mjs";
