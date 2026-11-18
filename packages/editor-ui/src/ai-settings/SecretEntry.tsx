import React, { type CSSProperties } from "react";
import type en from "../locales/en.json";

// A missing CSS.supports (or unsupported masking) must never render visible text.
export function supportsSecretMask(
  css: Pick<typeof CSS, "supports"> | undefined,
) {
  return css?.supports("-webkit-text-security", "disc") === true;
}
export function SecretEntry({
  id,
  value,
  revealed,
  disabled,
  onChange,
  onReveal,
  t,
}: {
  id: string;
  value: string;
  revealed: boolean;
  disabled?: boolean | undefined;
  onChange: (value: string) => void;
  onReveal: () => void;
  t: typeof en;
}) {
  const maskedText = supportsSecretMask(
    typeof CSS === "undefined" ? undefined : CSS,
  );
  return (
    <label htmlFor={`scenesparrow-api-token-${id}`}>
      {t.aiKey}
      <span className="ai-key-input">
        <input
          id={`scenesparrow-api-token-${id}`}
          name={`scenesparrow-api-token-${id}`}
          type={revealed || maskedText ? "text" : "password"}
          style={
            { WebkitTextSecurity: revealed ? "none" : "disc" } as CSSProperties
          }
          aria-label={t.aiKey}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
          maxLength={8192}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="quiet-button"
          disabled={!value || disabled}
          aria-pressed={revealed}
          onClick={onReveal}
        >
          {revealed ? t.aiHideKey : t.aiShowKey}
        </button>
      </span>
    </label>
  );
}
