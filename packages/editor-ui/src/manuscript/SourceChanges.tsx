import { GraphRecovery } from "./GraphRecovery";
import { ExternalWork } from "./ExternalWork";
import { createPortal } from "react-dom";
import {
  sourceDiff,
  rawEditorMap,
  patchNormalizedSourceInput,
  sourceAcknowledgmentInsertions,
} from "@scenesparrow/manuscript-format/editor-source";
import { useEffect, useRef, useState, useMemo } from "react";
import type {
  AuthoredSourceCandidate,
  AuthoredSourceRecoveryEvidence,
  AuthoredSourceRecoveryBytes,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type { ProjectSession } from "../project-session/project-session";
import type en from "../locales/en.json";
import { WritingDialog } from "../ui/WritingDialog";
import { useNoticeOwner } from "../feedback/NotificationPresenter";
export function downloadSource(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ChangedLines({
  before,
  after,
  title,
  t,
}: {
  before: string;
  after: string;
  title: string;
  t: typeof en;
}) {
  const diff = useMemo(() => sourceDiff(before, after), [before, after]);
  return (
    <section className="source-diff" aria-label={title}>
      <h3>{title}</h3>
      {!diff.changed ? (
        <p className="muted">{t.sourceDiffUnchanged}</p>
      ) : (
        <>
          {diff.identityOnly && <p role="status">{t.sourceDiffByteChanges}</p>}
          {diff.hunks.map((hunk, index) => (
            <ol key={index} className="source-diff-hunk">
              {hunk.map((line, at) => (
                <li
                  key={at}
                  data-diff-kind={line.kind}
                  className={
                    /^\uFEFF?<!-- scenesparrow:/.test(line.text)
                      ? "source-diff-identity"
                      : ""
                  }
                >
                  <span className="source-diff-line-number" aria-hidden="true">
                    {line.before ?? line.after}
                  </span>
                  <span aria-hidden="true">
                    {line.kind === "added"
                      ? "+"
                      : line.kind === "removed"
                        ? "−"
                        : " "}
                  </span>
                  <span className="visually-hidden">
                    {line.kind === "added"
                      ? t.sourceDiffAdded
                      : line.kind === "removed"
                        ? t.sourceDiffRemoved
                        : t.sourceDiffContext}
                  </span>
                  <code>{line.text || " "}</code>
                </li>
              ))}
            </ol>
          ))}
          {diff.truncated && <p role="status">{t.sourceDiffTruncated}</p>}
        </>
      )}
    </section>
  );
}
export function SourceChanges({
  save,
  client,
  t,
  frozen = false,
  externalWorkRequested = 0,
  sourceRequested = 0,
}: {
  save: ProjectSession;
  client: PlatformClient;
  t: typeof en;
  frozen?: boolean;
  externalWorkRequested?: number;
  sourceRequested?: number;
}) {
  const [graphEvidence, setGraphEvidence] = useState<string | undefined>();
  const [external, setExternal] = useState(false);
  const [open, setOpen] = useState(false),
    [candidate, setCandidate] = useState<AuthoredSourceCandidate | null>(null),
    [proposal, setProposal] = useState(""),
    [busy, setBusy] = useState(false),
    [proposalOpen, setProposalOpen] = useState(false),
    [error, setError] = useState("");
  const [evidence, setEvidence] =
      useState<AuthoredSourceRecoveryEvidence | null>(null),
    [version, setVersion] = useState<AuthoredSourceRecoveryBytes | null>(null);
  const [retained, setRetained] = useState(() => {
    try {
      return (
        localStorage.getItem(
          `scenesparrow.source-recovery:${save.source!.projectId}`,
        ) ?? ""
      );
    } catch {
      return "";
    }
  });
  const proposalRef = useRef(""),
    proposalBase = useRef(""),
    dialogOpen = useRef(false);
  proposalRef.current = proposal;
  const epoch = useRef(0),
    mounted = useRef(true),
    reading = useRef(false);
  const { report, resolve } = useNoticeOwner();
  const status = save.sourceStatus;
  useEffect(() => {
    const dirty = () => proposalRef.current !== proposalBase.current;
    save.sourceProposalDirty = dirty;
    return () => {
      if (save.sourceProposalDirty === dirty)
        save.sourceProposalDirty = undefined;
      save.composition(false, "source-proposal");
    };
  }, [save]);
  useEffect(() => {
    if (frozen) {
      epoch.current++;
      dialogOpen.current = false;
      setOpen(false);
    }
  }, [frozen]);
  const changeProposal = (value: string) => {
    const next = patchNormalizedSourceInput(proposalRef.current, value);
    proposalRef.current = next;
    epoch.current++;
    setProposal(next);
  };
  const resetProposal = () => {
    epoch.current++;
    save.actions.cancel("source-apply-proposal");
    proposalRef.current = save.sourceLocal;
    proposalBase.current = save.sourceLocal;
    setProposal(save.sourceLocal);
  };
  const close = () => {
    epoch.current++;
    dialogOpen.current = false;
    save.actions.cancel("source-apply-proposal");
    setOpen(false);
  };
  useEffect(() => {
    mounted.current = true;
    const inspect = async () => {
      if (reading.current) return;
      reading.current = true;
      try {
        await save.inspectSource();
      } catch {
        /* Durable local copy remains available. */
      } finally {
        reading.current = false;
      }
    };
    void inspect();
    const timer = setInterval(() => void inspect(), 2000);
    const focus = () => {
      void save.inspectSource(true).catch(() => {});
    };
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      epoch.current++;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [save]);
  useEffect(() => {
    if (!open || !status?.candidateId || candidate?.id === status.candidateId)
      return;
    let active = true;
    void client
      .readAuthoredSourceCandidate?.(status.candidateId)
      .then((next) => {
        if (active) {
          setCandidate(next);
          epoch.current++;
        }
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error ? failure.message : "STORAGE_UNAVAILABLE",
          );
      });
    return () => {
      active = false;
    };
  }, [open, status?.candidateId, client, candidate?.id]);
  useEffect(() => {
    if (error) report(error, { identity: "source-change" });
    else resolve("source-change");
  }, [error, report, resolve]);
  const show = () => {
    if (save.appliedSourceConflict) setExternal(false);
    else if (save.hasExternalRecovery) setExternal(true);
    epoch.current++;
    setError("");
    if (proposalRef.current === proposalBase.current) {
      proposalRef.current = save.sourceLocal;
      proposalBase.current = save.sourceLocal;
      setProposal(save.sourceLocal);
    }
    dialogOpen.current = true;
    setOpen(true);
  };
  useEffect(() => {
    if (externalWorkRequested) {
      setExternal(true);
      show();
    }
  }, [externalWorkRequested]);
  useEffect(() => {
    if (sourceRequested) {
      show();
      setExternal(false);
    }
  }, [sourceRequested]);
  const loadEvidence = async (hash: string) => {
    try {
      if (client.readGraphRecoveryMembers) {
        const page = await client.readGraphRecoveryMembers(hash);
        if (
          page.records.length ||
          save.sourceStatus?.pendingIntent?.version === 3
        ) {
          if (mounted.current) {
            setGraphEvidence(hash);
            setRetained(hash);
            setEvidence(null);
          }
          return;
        }
      }
      const next = await client.readAuthoredSourceRecoveryEvidence?.(hash);
      if (mounted.current && next) {
        setEvidence(next);
        setRetained(hash);
        try {
          localStorage.setItem(
            `scenesparrow.source-recovery:${save.source!.projectId}`,
            hash,
          );
        } catch {}
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "STORAGE_UNAVAILABLE",
      );
    }
  };
  const perform = async (action: () => Promise<boolean>) => {
    const captured = epoch.current,
      capturedProposal = proposalRef.current;
    setBusy(true);
    setError("");
    try {
      const ok = await action();
      await save.inspectSource(true);
      if (!mounted.current) return;
      if (!ok) {
        if (captured === epoch.current)
          setError(save.error || "SOURCE_EXTERNAL_CHANGE");
      } else {
        if (proposalRef.current === capturedProposal) {
          try {
            sourceAcknowledgmentInsertions(capturedProposal, save.sourceLocal);
            proposalBase.current = capturedProposal;
          } catch {
            /* A different proposal remains an owned draft. */
          }
        }
        if (!save.sourceStatus?.candidateId)
          setCandidate((current) =>
            current?.id === candidate?.id ? null : current,
          );
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : "STORAGE_UNAVAILABLE",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const pending = status?.pendingIntent;
  const needsAttention =
    save.hasPendingSourceRecovery ||
    save.hasExternalRecovery ||
    proposal !== proposalBase.current ||
    !!pending ||
    (!!status && status.externalStatus !== "unchanged") ||
    ["error", "conflict"].includes(save.status);
  return (
    <>
      <button
        className="source-changes-button quiet-button"
        data-testid="source-changes"
        aria-haspopup="dialog"
        data-pending={needsAttention}
        title={needsAttention ? t.sourceChangesPending : t.sourceChanges}
        onClick={show}
      >
        {t.sourceChanges}
      </button>
      {open &&
        createPortal(
          <WritingDialog
            title={t.sourceChanges}
            closeLabel={t.close}
            close={close}
            closeDisabled={frozen}
          >
            <div
              className="source-changes-dialog"
              onCompositionStart={() =>
                save.composition(true, "source-proposal")
              }
              onCompositionEnd={() =>
                queueMicrotask(() => save.composition(false, "source-proposal"))
              }
              onBlurCapture={() =>
                save.actions.blur("source-proposal", () =>
                  save.composition(false, "source-proposal"),
                )
              }
            >
              {client.createWorkItem && (
                <div
                  className="writing-view-switch"
                  role="group"
                  aria-label={t.sourceChanges}
                >
                  <button
                    aria-pressed={!external}
                    onClick={() => setExternal(false)}
                  >
                    {t.manuscript}
                  </button>
                  <button
                    aria-pressed={external}
                    onClick={() => setExternal(true)}
                  >
                    {t.externalWork}
                  </button>
                </div>
              )}
              {external && <ExternalWork client={client} save={save} t={t} />}
              <div hidden={external} inert={external}>
                <p
                  role="status"
                  data-testid={
                    save.appliedSourceConflict
                      ? "source-applied-conflict"
                      : undefined
                  }
                >
                  {save.appliedSourceConflict
                    ? t.EXTERNAL_APPLIED_SOURCE_CONFLICT
                    : status?.externalStatus === "missing"
                      ? t.sourceMissing
                      : status?.externalStatus === "unstable"
                        ? t.sourceUnstable
                        : needsAttention
                          ? t.sourceChangesHelp
                          : t.sourceUnchanged}
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await save.inspectSource(true);
                      return true;
                    })
                  }
                >
                  {t.sourceRescan}
                </button>
                <div className="source-diff-grid">
                  <ChangedLines
                    before={save.source?.source ?? ""}
                    after={save.sourceLocal}
                    title={t.sourceDiffLocal}
                    t={t}
                  />
                  {candidate?.source !== undefined &&
                    candidate.source !== null && (
                      <ChangedLines
                        before={save.source?.source ?? ""}
                        after={candidate.source}
                        title={t.sourceDiffExternal}
                        t={t}
                      />
                    )}
                </div>
                <details className="source-full-versions">
                  <summary>{t.sourceFullVersions}</summary>
                  <div className="source-version-grid">
                    <label>
                      {t.sourceAccepted}
                      <textarea readOnly value={save.source?.source ?? ""} />
                    </label>
                    <label>
                      {t.localCopy}
                      <textarea readOnly value={save.sourceLocal} />
                    </label>
                    <label>
                      {t.sourceExternal}
                      <textarea readOnly value={candidate?.source ?? ""} />
                      {candidate?.source === null && (
                        <span>{t.sourceMissing}</span>
                      )}
                    </label>
                  </div>
                </details>
                {candidate?.validationError && (
                  <p role="status">{t.sourceInvalidCandidate}</p>
                )}
                <button
                  onClick={() =>
                    downloadSource(
                      new TextEncoder().encode(save.sourceLocal),
                      "manuscript-local.md",
                    )
                  }
                >
                  {t.sourceDownloadLocal}
                </button>
                {proposal !== proposalBase.current && (
                  <button disabled={busy} onClick={resetProposal}>
                    {t.sourceResetProposal}
                  </button>
                )}
                {candidate &&
                  candidate.id === status?.candidateId &&
                  candidate.disposition === "pending" && (
                    <>
                      <div className="dialog-actions">
                        <button
                          disabled={
                            busy ||
                            candidate.source === null ||
                            !!candidate.validationError
                          }
                          onClick={() =>
                            void perform(() =>
                              save.resolveSource(candidate, "accept", null),
                            )
                          }
                        >
                          {t.sourceAccept}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(() =>
                              save.resolveSource(
                                candidate,
                                "proposal",
                                save.sourceLocal,
                              ),
                            )
                          }
                        >
                          {t.sourceKeepLocal}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(() =>
                              save.resolveSource(candidate, "discard", null),
                            )
                          }
                        >
                          {t.sourceDiscard}
                        </button>
                      </div>
                    </>
                  )}
                {!candidate &&
                  !pending &&
                  !save.appliedSourceConflict &&
                  ["error", "conflict"].includes(save.status) && (
                    <>
                      <button
                        disabled={busy}
                        onClick={() => void perform(() => save.flush(true))}
                      >
                        {t.retry}
                      </button>
                    </>
                  )}
                {((!pending && !!status?.candidateId) ||
                  ["error", "conflict"].includes(save.status) ||
                  proposalOpen ||
                  proposal !== proposalBase.current) && (
                  <details
                    key="source-proposal"
                    open={proposalOpen}
                    onToggle={(event) =>
                      setProposalOpen(event.currentTarget.open)
                    }
                  >
                    <summary>{t.sourceProposal}</summary>
                    <label>
                      {t.sourceProposal}
                      <textarea
                        value={rawEditorMap(proposal).text}
                        onChange={(event) => changeProposal(event.target.value)}
                      />
                    </label>
                    <button
                      disabled={
                        busy ||
                        !!pending ||
                        (!!status?.candidateId &&
                          (candidate?.id !== status.candidateId ||
                            candidate?.disposition !== "pending"))
                      }
                      onClick={() => {
                        const capturedCandidate = status?.candidateId
                          ? candidate
                          : null;
                        if (
                          status?.candidateId &&
                          capturedCandidate?.id !== status.candidateId
                        )
                          return;
                        const capturedInput = save.visibleInputIdentity,
                          capturedContext = save.actions.contextVersion;
                        void save.actions.run(
                          "source-apply-proposal",
                          () =>
                            perform(() =>
                              capturedCandidate
                                ? save.resolveSource(
                                    capturedCandidate,
                                    "proposal",
                                    proposalRef.current,
                                  )
                                : save.saveSourceProposal(proposalRef.current),
                            ),
                          () =>
                            mounted.current &&
                            dialogOpen.current &&
                            capturedInput === save.visibleInputIdentity &&
                            capturedContext === save.actions.contextVersion,
                        );
                      }}
                    >
                      {t.sourceUseProposal}
                    </button>
                  </details>
                )}
                {!save.hasUnresolvedSource &&
                  ["error", "conflict"].includes(save.status) && (
                    <button
                      disabled={busy}
                      onClick={() => void perform(() => save.reload())}
                    >
                      {t.sourceReloadAccepted}
                    </button>
                  )}
                {save.hasUnresolvedSource && (
                  <button
                    disabled={busy}
                    onClick={() => void perform(() => save.flush(true))}
                  >
                    {t.sourceResolvePrevious}
                  </button>
                )}
                {save.hasPendingSourceRecovery && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(() => save.retrySourceRecovery())
                    }
                  >
                    {t.sourceResolvePrevious}
                  </button>
                )}
                {pending && (
                  <div className="source-recovery-actions">
                    <p>{t.sourceRecoveryHelp}</p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void perform(() => save.recoverSource(status!))
                      }
                    >
                      {t.sourceRecoverKnown}
                    </button>
                    <button
                      disabled={
                        busy ||
                        (pending.version === 3
                          ? !client.inspectGraphRecovery
                          : !status?.observationFingerprint)
                      }
                      onClick={() =>
                        void perform(async () => {
                          let observed = status!;
                          const captured = epoch.current;
                          if (
                            pending.version === 3 &&
                            !save.hasPendingSourceRecovery
                          ) {
                            const inspection =
                              await client.inspectGraphRecovery!(
                                pending.intentHash,
                              );
                            if (
                              !mounted.current ||
                              captured !== epoch.current ||
                              save.sourceStatus?.pendingIntent?.intentHash !==
                                pending.intentHash
                            )
                              return false;
                            observed = {
                              ...status!,
                              observationFingerprint:
                                inspection.observationFingerprint,
                            };
                          }
                          const ok = await save.recoverSource(observed, true);
                          if (ok) await loadEvidence(pending.intentHash);
                          return ok;
                        })
                      }
                    >
                      {t.sourcePreserveExternal}
                    </button>
                    <button
                      onClick={() => void loadEvidence(pending.intentHash)}
                    >
                      {t.sourceEvidence}
                    </button>
                  </div>
                )}
                {retained && (
                  <button onClick={() => void loadEvidence(retained)}>
                    {t.sourceEvidence}
                  </button>
                )}
                {client.readGraphRecoveries && (
                  <GraphRecovery
                    client={client}
                    t={t}
                    {...(graphEvidence ? { intent: graphEvidence } : {})}
                  />
                )}
                {evidence && (
                  <section aria-label={t.sourceEvidence}>
                    <h3>{t.sourceEvidence}</h3>
                    {evidence.versions.map((member) => (
                      <div key={member.sourceHash}>
                        <span>
                          {member.roles
                            .map(
                              (role) =>
                                t[`sourceRole_${role}` as keyof typeof t] ??
                                role,
                            )
                            .join(", ")}{" "}
                          · {member.size} B
                        </span>
                        <button
                          onClick={() =>
                            void client
                              .readAuthoredSourceRecoveryVersion?.(
                                evidence.intentHash,
                                member.sourceHash,
                              )
                              .then((value) => {
                                if (mounted.current) setVersion(value);
                              })
                              .catch((failure) => setError(failure.message))
                          }
                        >
                          {t.sourceCompare}
                        </button>
                      </div>
                    ))}
                  </section>
                )}
                {version && (
                  <div>
                    <p>
                      {version.source === null
                        ? t.sourceInvalidUtf8
                        : t.sourceEvidencePreview}
                    </p>
                    {version.source !== null && (
                      <textarea
                        aria-label={t.sourceEvidencePreview}
                        readOnly
                        value={version.source}
                      />
                    )}
                    <button
                      onClick={() =>
                        downloadSource(
                          Uint8Array.from(atob(version.bytesBase64), (c) =>
                            c.charCodeAt(0),
                          ),
                          "manuscript-evidence.md",
                        )
                      }
                    >
                      {t.sourceDownloadEvidence}
                    </button>
                  </div>
                )}
                {error && (
                  <p role="alert">
                    {t[error as keyof typeof t] ?? t.sourceOperationFailed}
                  </p>
                )}
              </div>
            </div>
          </WritingDialog>,
          document.body,
        )}
    </>
  );
}
