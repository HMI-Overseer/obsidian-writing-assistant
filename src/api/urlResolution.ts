export const DEFAULT_LM_STUDIO_ROOT_URL = "http://localhost:1234";

export function stripKnownApiSuffix(pathname: string): string {
  const trimmed = pathname.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  if (trimmed.endsWith("/api/v1")) return trimmed.slice(0, -7);
  if (trimmed.endsWith("/v1")) return trimmed.slice(0, -3);
  return trimmed;
}

export function joinBasePath(rootPath: string, suffix: string): string {
  const trimmedRoot = rootPath.replace(/\/+$/, "");
  return trimmedRoot ? `${trimmedRoot}${suffix}` : suffix;
}

export function resolveLMStudioBaseUrls(input: string): {
  serverRootUrl: string;
  openAIBaseUrl: string;
  nativeApiBaseUrl: string;
} {
  const trimmed = input.trim().replace(/\/+$/, "");
  const fallbackRoot = DEFAULT_LM_STUDIO_ROOT_URL;

  if (!trimmed) {
    return {
      serverRootUrl: fallbackRoot,
      openAIBaseUrl: `${fallbackRoot}/v1`,
      nativeApiBaseUrl: `${fallbackRoot}/api/v1`,
    };
  }

  try {
    const url = new URL(trimmed);
    const rootPath = stripKnownApiSuffix(url.pathname);
    const serverRootUrl = `${url.origin}${rootPath}`;

    return {
      serverRootUrl,
      openAIBaseUrl: `${url.origin}${joinBasePath(rootPath, "/v1")}`,
      nativeApiBaseUrl: `${url.origin}${joinBasePath(rootPath, "/api/v1")}`,
    };
  } catch {
    const serverRootUrl = stripKnownApiSuffix(trimmed) || fallbackRoot;

    return {
      serverRootUrl,
      openAIBaseUrl: `${serverRootUrl}/v1`,
      nativeApiBaseUrl: `${serverRootUrl}/api/v1`,
    };
  }
}

export function normalizeLMStudioBaseUrl(input: string): string {
  return resolveLMStudioBaseUrls(input).openAIBaseUrl;
}
