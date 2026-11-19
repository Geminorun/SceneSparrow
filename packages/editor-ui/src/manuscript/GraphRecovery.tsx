import { useEffect, useState } from "react";
import type {
  GraphRecoveryMemberView,
  GraphRecoveryView,
} from "@scenesparrow/contracts";
import type { PlatformClient } from "@scenesparrow/platform-client";
import type en from "../locales/en.json";
import { useScopedRead } from "./use-scoped-read";
/** Large v3 recovery members retain path/role/version identity and use the
 * authenticated attachment stream instead of the legacy base64 source reader. */
export function GraphRecovery({
  client,
  t,
  intent,
}: {
  client: PlatformClient;
  t: typeof en;
  intent?: string;
}) {
  const [operations, setOperations] = useState<GraphRecoveryView[]>([]),
    [operationCursor, setOperationCursor] = useState<string | null>(null),
    [selected, setSelected] = useState(intent ?? null),
    [members, setMembers] = useState<GraphRecoveryMemberView[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const reads = useScopedRead(client, selected);
  const message = (code: string) =>
    (t as Record<string, string>)[code] ?? t.externalWorkFailed;
  useEffect(() => {
    if (intent) {
      reads.invalidate();
      setSelected(intent);
    }
  }, [intent]);
  function loadOperations(after: string | null = null) {
    return reads.run(
      "recovery-operations",
      () => client.readGraphRecoveries!(after ?? undefined),
      (page) => {
        setOperations((rows) =>
          after ? [...rows, ...page.records] : page.records,
        );
        setOperationCursor(page.continuation);
      },
    );
  }
  function loadMembers(operation: string, after: string | null = null) {
    return reads.run(
      "recovery-members",
      () => client.readGraphRecoveryMembers!(operation, after ?? undefined),
      (page) => {
        setMembers((rows) =>
          after ? [...rows, ...page.records] : page.records,
        );
        setCursor(page.continuation);
      },
    );
  }
  useEffect(() => {
    void loadOperations();
  }, [client]);
  useEffect(() => {
    setMembers([]);
    setCursor(null);
    if (selected) void loadMembers(selected);
  }, [client, selected]);
  return (
    <details className="graph-recovery" open={!!intent}>
      <summary>{t.externalRecoveryFiles}</summary>
      {reads.recovery && (
        <div className="compact-read-recovery" role="status">
          <p>{message(reads.recovery.code)}</p>
          <button onClick={reads.recovery.retry}>{t.retry}</button>
        </div>
      )}
      <ul className="external-work-items">
        {operations.map((operation) => (
          <li key={operation.intentHash}>
            <button
              aria-pressed={selected === operation.intentHash}
              onClick={() => {
                if (selected === operation.intentHash) return;
                reads.invalidate();
                setSelected(operation.intentHash);
              }}
            >
              {t.sourceEvidence} · {operation.memberCount}
            </button>
          </li>
        ))}
      </ul>
      {operationCursor && (
        <button onClick={() => void loadOperations(operationCursor)}>
          {t.externalMore}
        </button>
      )}
      {selected && !members.length && (
        <p className="muted">{t.externalRecoveryEmpty}</p>
      )}
      <ul className="external-work-files">
        {members.map((member) => (
          <li key={member.memberId}>
            <span title={member.path}>{member.path}</span>
            <small>
              {(t as Record<string, string>)[`sourceRole_${member.role}`] ??
                t.sourceEvidence}{" "}
              · {member.size} B · {member.hash.slice(0, 10)}
            </small>
            <button
              onClick={() =>
                void reads.run(
                  `recovery-download:${member.memberId}`,
                  () =>
                    client.downloadGraphRecoveryMember!(
                      selected!,
                      member.memberId,
                    ),
                  () => {},
                )
              }
            >
              {t.externalDownloadMember}
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button onClick={() => void loadMembers(selected!, cursor)}>
          {t.externalMore}
        </button>
      )}
    </details>
  );
}
