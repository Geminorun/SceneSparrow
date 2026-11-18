import { ApiError } from "./errors";

export function validateExternalLink(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new ApiError("INVALID_URL");
}
