import type { SandboxResponseNormalizer } from "../sandbox/types";
import { TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER } from "./toolResultControlTokenPrefix";

const NORMALIZERS: Readonly<Record<string, SandboxResponseNormalizer>> = {
  "tool-result-control-token-prefix-v1": TOOL_RESULT_CONTROL_TOKEN_PREFIX_NORMALIZER,
};

export function listResponseNormalizerIds(): string[] {
  return Object.keys(NORMALIZERS).sort();
}

export function resolveResponseNormalizer(id: string): SandboxResponseNormalizer {
  const normalizer = NORMALIZERS[id];
  if (!normalizer) {
    throw new Error(
      `Unknown response normalizer ${JSON.stringify(id)}. Available normalizers: ` +
      `${listResponseNormalizerIds().join(", ")}.`,
    );
  }
  return normalizer;
}
