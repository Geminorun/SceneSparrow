import { validateOperator } from "../../apps/web/server/gateway.mjs";

export function operatorConfiguration(env) {
  const hasUsername = Boolean(env.OPERATOR_USERNAME);
  const hasPassword = Boolean(env.OPERATOR_PASSWORD);
  if (hasUsername !== hasPassword)
    throw Error("Both operator username and password are required");
  if (hasUsername) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(env.OPERATOR_USERNAME) ||
      !/^[\x21-\x7e]{6,256}$/.test(env.OPERATOR_PASSWORD)
    )
      throw Error("Invalid operator configuration");
    return validateOperator(
      `${env.OPERATOR_USERNAME}:${env.OPERATOR_PASSWORD}`,
    );
  }
  return env.OPERATOR_AUTH
    ? validateOperator(env.OPERATOR_AUTH.replace(/\n$/, ""))
    : undefined;
}
