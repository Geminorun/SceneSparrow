import { useEffect, useRef, useState } from "react";
import type {
  AiModel,
  AiSettings,
  AiSettingsView,
  AiTestAction,
  AiTestReceipt,
} from "@scenesparrow/contracts";
import {
  TransportError,
  type PlatformClient,
} from "@scenesparrow/platform-client";
import {
  notifyFailure,
  safeErrorCode,
  savedDiscoveryTarget,
} from "../notifications";
import { useNoticeOwner } from "../NotificationPresenter";
import { publishSavedAiView } from "./saved-view";
import {
  assignPreset,
  modelKey,
  modelParameters,
  presetProvider,
  savedTargetSignature,
  servicePresets,
  type ProviderDraft,
  type ServicePreset,
} from "./model";

const notificationsSaved = (key: string) =>
  notifyFailure(key, { tone: "success" });

type Operation = {
  busy?: boolean;
  error?: string;
  message?: "saved" | "partial";
  credential?: "saved" | "saving" | "failed" | "unknown";
};
type TestState = {
  action: AiTestAction;
  receipt?: AiTestReceipt;
  signature: string;
  invalidated?: boolean;
};
export function useAiSettings(
  client: PlatformClient,
  open: boolean,
  active: boolean,
) {
  const { report, resolve } = useNoticeOwner();
  const [view, setView] = useState<AiSettingsView | null>(null);
  const viewRef = useRef(view);
  const [providers, setProviders] = useState<Record<string, ProviderDraft>>({});
  const [models, setModelState] = useState<Record<string, AiModel>>({});
  const [operations, setOperations] = useState<Record<string, Operation>>({});
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({});
  const [catalogs, setCatalogs] = useState<Record<string, string[]>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const testing = useRef(new Set<string>());
  const generations = useRef<Record<string, number>>({});
  const pendingProviders = useRef<Record<string, string>>({});
  const providerDrafts = useRef(providers);
  const updateProviders = (
    change: (
      drafts: Record<string, ProviderDraft>,
    ) => Record<string, ProviderDraft>,
  ) => {
    const next = change(providerDrafts.current);
    providerDrafts.current = next;
    setProviders(next);
  };
  const modelDrafts = useRef(models);
  const setModels = (
    change: (drafts: Record<string, AiModel>) => Record<string, AiModel>,
  ) => {
    const next = change(modelDrafts.current);
    modelDrafts.current = next;
    setModelState(next);
  };
  const resolveProvider = (settings: AiSettings, selection: string) =>
    servicePresets.some((preset) => preset.id === selection)
      ? presetProvider(settings, selection as ServicePreset)
      : settings.providers.find((provider) => provider.id === selection);
  const providerKey = (selection: string) => {
    const settings = viewRef.current?.settings;
    return (
      (settings && resolveProvider(settings, selection)?.id) ??
      pendingProviders.current[selection] ??
      selection
    );
  };
  const publish = (next: AiSettingsView, refresh = false) => {
    const previous = viewRef.current;
    if (previous) {
      updateProviders((drafts) =>
        Object.fromEntries(
          Object.entries(drafts).map(([selection, draft]) => {
            const oldProvider = resolveProvider(previous.settings, selection);
            const newProvider = resolveProvider(next.settings, selection);
            const originalRoot =
              oldProvider?.baseUrl ??
              servicePresets.find((preset) => preset.id === selection)?.root ??
              "";
            const clean = draft.root === originalRoot;
            if (
              refresh &&
              !clean &&
              JSON.stringify(oldProvider) !== JSON.stringify(newProvider)
            )
              setConflicts((conflicts) => ({
                ...conflicts,
                [selection]: true,
              }));
            return [
              selection,
              clean
                ? { ...draft, root: newProvider?.baseUrl ?? originalRoot }
                : draft,
            ];
          }),
        ),
      );
    }
    if (previous)
      setModels((drafts) =>
        Object.fromEntries(
          Object.entries(drafts).flatMap(([id, draft]) => {
            const oldModel = previous.settings.models.find(
              (model) => modelKey(model.providerId, model.id) === id,
            );
            const newModel = next.settings.models.find(
              (model) => modelKey(model.providerId, model.id) === id,
            );
            const clean =
              oldModel &&
              JSON.stringify({
                ...oldModel,
                defaultParameters: modelParameters(previous.settings, oldModel),
              }) === JSON.stringify(draft);
            if (clean)
              return newModel
                ? [
                    [
                      id,
                      {
                        ...newModel,
                        defaultParameters: modelParameters(
                          next.settings,
                          newModel,
                        ),
                      },
                    ],
                  ]
                : [];
            if (
              refresh &&
              JSON.stringify(oldModel) !== JSON.stringify(newModel)
            )
              setConflicts((conflicts) => ({ ...conflicts, [id]: true }));
            return [[id, draft]];
          }),
        ),
      );
    // Creation aliases must not follow a saved profile when its preset changes.
    // Once authoritative, the provider UUID owns its draft and queued operations.
    for (const [preset, id] of Object.entries(pendingProviders.current)) {
      if (next.settings.providers.some((provider) => provider.id === id))
        delete pendingProviders.current[preset];
    }
    viewRef.current = next;
    setView(next);
    publishSavedAiView(next);
  };
  const operate = async (
    target: string,
    fn: () => Promise<void>,
    requestTarget?: string,
  ) => {
    resolve(target);
    setOperations((state) => ({
      ...state,
      [target]: {
        busy: true,
        ...(state[target]?.credential === "unknown"
          ? { credential: "unknown" as const }
          : {}),
      },
    }));
    try {
      await fn();
      return true;
    } catch (error) {
      report(error, {
        target: requestTarget,
        identity: target,
        actions:
          target === "load" || safeErrorCode(error) === "SETTINGS_CONFLICT"
            ? [{ kind: "retry", run: () => load() }]
            : target.startsWith("discovery:")
              ? [
                  {
                    kind: "retry",
                    run: () => discover(target.slice("discovery:".length)),
                  },
                ]
              : [],
      });
      setOperations((state) => ({
        ...state,
        [target]: {
          ...state[target],
          error: safeErrorCode(error),
        },
      }));
      return false;
    } finally {
      setOperations((state) => ({
        ...state,
        [target]: { ...state[target], busy: false },
      }));
    }
  };
  // All settings/credential writes read the latest revision only when their turn starts.
  // A conflict is shown; it is never silently rebased over another client's changes.
  const enqueue = (target: string, fn: () => Promise<void>) => {
    const next = queue.current.then(() => operate(target, fn));
    queue.current = next;
    return next;
  };
  const replace = async (change: (settings: AiSettings) => void) => {
    const current = viewRef.current;
    if (!current) throw new Error("AI_ERROR");
    const settings = structuredClone(current.settings);
    change(settings);
    publish(
      await client.updateAiSettings({
        expectedRevision: current.settings.revision,
        settings,
      }),
    );
  };
  const load = () =>
    enqueue("load", async () => {
      publish(await client.readAiSettings(), true);
    });
  useEffect(() => {
    for (const [id, conflict] of Object.entries(conflicts)) {
      if (conflict)
        report("aiRemoteDraftConflict", {
          identity: `conflict:${id}`,
          actions: [{ kind: "retry", run: () => load() }],
        });
      else resolve(`conflict:${id}`);
    }
  }, [conflicts, report, resolve]);
  const activated = useRef(false);
  useEffect(() => {
    if (!open) activated.current = false;
    if (active && !activated.current) {
      activated.current = true;
      void load();
    }
  }, [active, open]);
  useEffect(() => {
    if (!open) {
      resolve();
      updateProviders((drafts) =>
        Object.fromEntries(
          Object.entries(drafts).map(([id, draft]) => [
            id,
            { ...draft, key: "", reveal: false, editingKey: false },
          ]),
        ),
      );
    }
  }, [open, resolve]);
  const providerDraft = (selection: string): ProviderDraft => {
    if (providers[providerKey(selection)])
      return providers[providerKey(selection)]!;
    const provider =
      view &&
      (servicePresets.some((preset) => preset.id === selection)
        ? presetProvider(view.settings, selection as ServicePreset)
        : view.settings.providers.find(
            (provider) => provider.id === selection,
          ));
    return {
      root:
        provider?.baseUrl ??
        servicePresets.find((preset) => preset.id === selection)?.root ??
        "",
      key: "",
      reveal: false,
    };
  };
  const invalidateTests = (providerId: string, modelId?: string) => {
    const target = modelId ? modelKey(providerId, modelId) : providerId;
    generations.current[target] = (generations.current[target] ?? 0) + 1;
    setTests((tests) =>
      Object.fromEntries(
        Object.entries(tests).map(([id, test]) => [
          id,
          test.action.target.providerId === providerId &&
          (!modelId || test.action.target.modelId === modelId)
            ? { ...test, invalidated: true }
            : test,
        ]),
      ),
    );
  };
  const editProvider = (selection: string, patch: Partial<ProviderDraft>) => {
    if (patch.root !== undefined || patch.key !== undefined) {
      const settings = viewRef.current?.settings;
      const provider =
        settings &&
        (servicePresets.some((preset) => preset.id === selection)
          ? presetProvider(settings, selection as ServicePreset)
          : settings.providers.find((provider) => provider.id === selection));
      if (provider) invalidateTests(provider.id);
      setOperations((operations) =>
        operations[`provider:${providerKey(selection)}`]?.busy
          ? operations
          : {
              ...operations,
              [`provider:${providerKey(selection)}`]:
                operations[`provider:${providerKey(selection)}`]?.credential ===
                  "unknown" && patch.key === undefined
                  ? { credential: "unknown" }
                  : {},
            },
      );
    }
    updateProviders((drafts) => ({
      ...drafts,
      [providerKey(selection)]: { ...providerDraft(selection), ...patch },
    }));
  };
  const mutate = (target: string, change: (settings: AiSettings) => void) =>
    enqueue(target, () => replace(change));
  const saveProvider = (selection: string, providerId: string | undefined) => {
    const captured = { ...providerDraft(selection) };
    const preset = servicePresets.find((preset) => preset.id === selection);
    const oldKey = providerKey(selection);
    const id =
      providerId ?? pendingProviders.current[selection] ?? crypto.randomUUID();
    if (!providerId) {
      pendingProviders.current[selection] = id;
      updateProviders((drafts) => {
        const next = { ...drafts, [id]: captured };
        if (oldKey !== id) delete next[oldKey];
        return next;
      });
    }
    return enqueue(`provider:${id}`, async () => {
      await replace((settings) => {
        let provider = settings.providers.find(
          (provider) => provider.id === id,
        );
        if (!provider) {
          if (!preset) throw new Error("PROFILE_NOT_FOUND");
          provider = {
            id,
            label: preset.label,
            adapter: "openai_compatible",
            baseUrl: captured.root,
            authMode: "bearer",
            credentialRevision: null,
            revision: 1,
          };
          settings.providers.push(provider);
        }
        provider.baseUrl = captured.root;
        if (preset) assignPreset(settings, id, preset.id);
      });
      if (captured.key) {
        setOperations((state) => ({
          ...state,
          [`provider:${id}`]: { busy: true, credential: "saving" },
        }));
        try {
          publish(
            await client.updateAiCredential({
              expectedRevision: viewRef.current!.settings.revision,
              providerId: id,
              secret: captured.key,
            }),
          );
          updateProviders((drafts) => {
            const draft = drafts[id];
            return draft && draft.key === captured.key
              ? {
                  ...drafts,
                  [id]: { ...draft, key: "", reveal: false, editingKey: false },
                }
              : drafts;
          });
        } catch (error) {
          if (error instanceof TransportError) {
            updateProviders((drafts) => {
              const draft = drafts[id];
              return draft?.key === captured.key
                ? {
                    ...drafts,
                    [id]: {
                      ...draft,
                      key: "",
                      reveal: false,
                      editingKey: false,
                    },
                  }
                : drafts;
            });
          }
          // Readback never repeats the credential write. An unavailable response may
          // have followed a successful key rotation, so refresh presence before recovery.
          try {
            publish(await client.readAiSettings());
          } catch {
            /* Preserve the last confirmed configuration. */
          }
          setOperations((state) => ({
            ...state,
            [`provider:${id}`]: {
              message: "partial",
              credential:
                error instanceof TransportError ? "unknown" : "failed",
            },
          }));
          throw error;
        }
      }
      setConflicts((conflicts) => ({ ...conflicts, [id]: false }));
      setOperations((state) => ({
        ...state,
        [`provider:${id}`]: {
          message: "saved",
          ...(captured.key
            ? { credential: "saved" as const }
            : state[`provider:${id}`]?.credential === "unknown"
              ? { credential: "unknown" as const }
              : {}),
        },
      }));
      notificationsSaved(captured.key ? "aiKeySaved" : "aiConfigurationSaved");
    });
  };
  const discover = (providerId: string) => {
    const saved = viewRef.current?.settings.providers.find(
      (provider) => provider.id === providerId,
    );
    return operate(
      `discovery:${providerId}`,
      async () => {
        const provider = viewRef.current?.settings.providers.find(
          (provider) => provider.id === providerId,
        );
        const signature = JSON.stringify(provider);
        const result = await client.discoverAiModels(providerId);
        if (
          signature ===
          JSON.stringify(
            viewRef.current?.settings.providers.find(
              (provider) => provider.id === providerId,
            ),
          )
        )
          setCatalogs((catalogs) => ({
            ...catalogs,
            [providerId]: result.models,
          }));
      },
      saved && savedDiscoveryTarget(saved.baseUrl),
    );
  };
  const testModel = (model: AiModel, resolve = false) => {
    const id = modelKey(model.providerId, model.id);
    const signature = savedTargetSignature(viewRef.current!.settings, model);
    const previous = tests[id];
    const generation = [
      generations.current[model.providerId] ?? 0,
      generations.current[id] ?? 0,
    ].join(":");
    const invalidated = () =>
      generation !==
      [
        generations.current[model.providerId] ?? 0,
        generations.current[id] ?? 0,
      ].join(":");
    if (testing.current.has(id)) return Promise.resolve();
    testing.current.add(id);
    return operate(`test:${id}`, async () => {
      if (
        resolve &&
        (!previous ||
          previous.signature !== signature ||
          previous.invalidated ||
          previous.action.sessionId !== viewRef.current!.sessionId)
      )
        throw new Error("CONFIGURATION_STALE");
      const target = {
        providerId: model.providerId,
        modelId: model.id,
        tokenField: model.tokenField,
      };
      const action = resolve
        ? previous!.action
        : {
            sessionId: viewRef.current!.sessionId,
            actionId: crypto.randomUUID(),
            target,
            fingerprint: (await client.prepareAiTest(target)).configuration
              .fingerprint,
          };
      setTests((tests) => ({
        ...tests,
        [id]: { action, signature, invalidated: invalidated() },
      }));
      const receipt = await client.testAiConnection(action);
      if (receipt.status === "failed")
        report(receipt.error ?? "AI_ERROR", {
          identity: `test:${action.actionId}`,
        });
      setTests((tests) =>
        tests[id]?.action.actionId === action.actionId
          ? {
              ...tests,
              [id]: { ...tests[id]!, receipt, invalidated: invalidated() },
            }
          : tests,
      );
    }).finally(() => testing.current.delete(id));
  };
  return {
    view,
    providers,
    models,
    operations,
    catalogs,
    conflicts,
    tests,
    providerDraft,
    providerOperation: (selection: string) =>
      operations[`provider:${providerKey(selection)}`],
    providerConflict: (selection: string) => conflicts[providerKey(selection)],
    editProvider,
    setModels,
    invalidateTests,
    saveProvider,
    mutate,
    discover,
    testModel,
    load,
    deleteCredential: (selection: string, id: string) =>
      enqueue(`provider:${id}`, async () => {
        publish(
          await client.deleteAiCredential({
            expectedRevision: viewRef.current!.settings.revision,
            providerId: id,
            secret: "",
          }),
        );
      }),
  };
}
export type AiSettingsController = ReturnType<typeof useAiSettings>;
