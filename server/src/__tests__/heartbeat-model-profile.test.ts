import { describe, expect, it } from "vitest";
import type { AdapterModelProfileDefinition } from "../adapters/index.js";
import {
  mergeProviderCascadeAdapterConfig,
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveProviderCascadeApplication,
  resolveModelProfileApplication,
  selectNextProviderCascadeEntry,
} from "../services/heartbeat.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });
});

describe("heartbeat provider cascade application", () => {
  const runtimeConfig = {
    providerCascade: {
      enabled: true,
      entries: [
        {
          label: "Codex fallback",
          adapterType: "codex_local",
          adapterConfig: {
            model: "gpt-5.5",
            modelReasoningEffort: "high",
          },
        },
        {
          label: "Gemini fallback",
          adapterType: "gemini_local",
          adapterConfig: {
            model: "gemini-2.5-pro",
          },
        },
      ],
    },
  };

  it("uses the cascade-selected adapter and config when run context names an active entry", () => {
    const providerCascade = resolveProviderCascadeApplication({
      agentAdapterType: "claude_local",
      agentRuntimeConfig: runtimeConfig,
      contextSnapshot: {
        providerCascade: {
          activeIndex: 0,
        },
      },
    });

    const merged = mergeProviderCascadeAdapterConfig({
      baseConfig: {
        cwd: "/repo",
        model: "claude-opus-4-7",
      },
      providerCascade,
    });

    expect(providerCascade).toMatchObject({
      activeIndex: 0,
      adapterType: "codex_local",
      entry: {
        label: "Codex fallback",
      },
      fallbackReason: null,
    });
    expect(merged).toEqual({
      cwd: "/repo",
      model: "gpt-5.5",
      modelReasoningEffort: "high",
    });
  });

  it("selects the next configured fallback after the active cascade entry", () => {
    const next = selectNextProviderCascadeEntry({
      agentAdapterType: "claude_local",
      agentRuntimeConfig: runtimeConfig,
      contextSnapshot: {
        providerCascade: {
          activeIndex: 0,
        },
      },
    });

    expect(next).toMatchObject({
      totalEntries: 2,
      entry: {
        index: 1,
        adapterType: "gemini_local",
        label: "Gemini fallback",
      },
    });
  });
});
