import promptsLib from "prompts";

import type { BrigadeConfig } from "../../config/io.js";

import {
  type BrigadeNonInteractiveSetupResult,
  runNonInteractiveSetup,
} from "./non-interactive.js";
import { BRIGADE_PROVIDER_CATALOG, resolveProviderById } from "./providers.js";

// Interactive wizard. Drives the same code path as runNonInteractiveSetup
// — only difference is where the inputs come from (TTY prompts vs flags).
// Persisted output is identical.
//
// Step order (mirrors the reference QuickStart flow trimmed to the
// surfaces we have validated end-to-end):
//   1. Provider pick                — grid of BRIGADE_PROVIDER_CATALOG entries
//   2. API key entry                — skipped if provider.noAuth
//   3. Secret-input mode pick       — plaintext vs ref (only if provider.envVar)
//   4. Primary model pick           — list filtered to the picked provider
//   5. (No fallback prompt for now — single-provider chain is the smoke-tested path)
//
// Cancelling any prompt aborts the wizard cleanly without writing anything.

export interface BrigadeInteractiveSetupArgs {
  config: BrigadeConfig;
  workspace: string;
  agentId: string;
  // True iff brigade.json already existed before this onboard. Threaded
  // through so the wizard's first-onboard-only seeds (controlUi /
  // denyCommands) are gated correctly even on the interactive path.
  hasExistingConfig?: boolean;
  // Optional pre-filled defaults so reruns can keep prior choices unless
  // the user explicitly changes them.
  defaults?: {
    provider?: string;
    model?: string;
    secretInputMode?: "plaintext" | "ref";
  };
}

export class BrigadeWizardCancelledError extends Error {
  constructor() {
    super("Wizard cancelled by user.");
    this.name = "BrigadeWizardCancelledError";
  }
}

export async function runInteractiveSetup(
  args: BrigadeInteractiveSetupArgs,
): Promise<BrigadeNonInteractiveSetupResult> {
  // Step 1 — provider pick.
  const providerAns = await promptsLib(
    {
      type: "select",
      name: "provider",
      message: "Pick the LLM provider you want Brigade to use",
      initial: indexOfProvider(args.defaults?.provider) ?? 0,
      choices: BRIGADE_PROVIDER_CATALOG.map((p) => ({
        title: p.label,
        value: p.id,
        description: providerSubtitle(p),
      })),
    },
    { onCancel: () => false },
  );
  const providerId = providerAns.provider as string | undefined;
  if (!providerId) throw new BrigadeWizardCancelledError();
  const provider = resolveProviderById(providerId);
  if (!provider) throw new BrigadeWizardCancelledError();

  // Step 2 — API key (skipped for noAuth providers like Ollama).
  let apiKey: string | undefined;
  let secretInputMode: "plaintext" | "ref" = args.defaults?.secretInputMode ?? "plaintext";
  if (!provider.noAuth) {
    const modeAns = await promptsLib(
      {
        type: "select",
        name: "mode",
        message: `How do you want Brigade to store your ${provider.label} API key?`,
        initial: secretInputMode === "ref" ? 1 : 0,
        choices: [
          {
            title: "Paste it here (stored at mode 0600)",
            value: "plaintext",
            description: "Literal key written to auth-profiles.json",
          },
          {
            title: `Read from ${provider.envVar || "env var"} at runtime`,
            value: "ref",
            description: "No literal key on disk — requires the env var to be set when Brigade runs",
          },
        ],
      },
      { onCancel: () => false },
    );
    secretInputMode = (modeAns.mode as "plaintext" | "ref" | undefined) ?? "plaintext";

    if (secretInputMode === "plaintext") {
      const keyAns = await promptsLib(
        {
          type: "password",
          name: "key",
          message: `Paste your ${provider.label} API key`,
          ...(provider.apiKeyHint ? { hint: provider.apiKeyHint } : {}),
          validate: (v: string) => (v && v.trim().length > 0 ? true : "API key required"),
        },
        { onCancel: () => false },
      );
      const k = (keyAns.key as string | undefined)?.trim();
      if (!k) throw new BrigadeWizardCancelledError();
      apiKey = k;
    } else {
      // ref mode — the actual literal stays in the user's env. We pass a
      // sentinel non-empty string so the non-interactive runner doesn't
      // bail on the "API key required" check; the metadata.keyRef path
      // is what gets persisted.
      apiKey = process.env[provider.envVar]?.trim() || "(set-via-env)";
    }
  }

  // Step 3 — primary model pick.
  const modelAns = await promptsLib(
    {
      type: "select",
      name: "model",
      message: `Pick the default ${provider.label} model`,
      initial: indexOfModel(provider.models, args.defaults?.model ?? provider.defaultModel) ?? 0,
      choices: provider.models.map((m) => ({ title: m.label, value: m.id, description: m.id })),
    },
    { onCancel: () => false },
  );
  const modelId = modelAns.model as string | undefined;
  if (!modelId) throw new BrigadeWizardCancelledError();

  return runNonInteractiveSetup({
    config: args.config,
    workspace: args.workspace,
    agentId: args.agentId,
    provider: provider.id,
    apiKey,
    secretInputMode,
    model: modelId,
    mode: "local",
    hasExistingConfig: args.hasExistingConfig === true,
  });
}

function providerSubtitle(p: { noAuth?: boolean; apiKeyHint?: string }): string | undefined {
  if (p.noAuth) return "Local — no API key required";
  return p.apiKeyHint;
}

function indexOfProvider(id: string | undefined): number | undefined {
  if (!id) return undefined;
  const idx = BRIGADE_PROVIDER_CATALOG.findIndex((p) => p.id === id);
  return idx >= 0 ? idx : undefined;
}

function indexOfModel(
  models: { id: string }[],
  id: string | undefined,
): number | undefined {
  if (!id) return undefined;
  const idx = models.findIndex((m) => m.id === id);
  return idx >= 0 ? idx : undefined;
}
