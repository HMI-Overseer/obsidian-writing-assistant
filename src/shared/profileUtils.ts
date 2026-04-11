import type { PluginSettings, ProviderOption, ProviderProfile } from "./types";
import { makeDefaultProfile } from "../constants";

/**
 * Returns all profiles for a given provider, with the built-in default prepended.
 */
export function getProfilesForProvider(
  settings: PluginSettings,
  provider: ProviderOption,
): ProviderProfile[] {
  const defaultProfile = makeDefaultProfile(provider);
  const userProfiles = settings.providerProfiles.filter(
    (p) => p.provider === provider,
  );
  return [defaultProfile, ...userProfiles];
}

/**
 * Resolves the active profile for a provider. Falls back to the built-in default
 * if the stored active ID doesn't match any persisted profile.
 */
export function getActiveProfile(
  settings: PluginSettings,
  provider: ProviderOption,
): ProviderProfile {
  const activeId = settings.activeProfileIds[provider];
  const defaultProfile = makeDefaultProfile(provider);

  if (activeId === defaultProfile.id) return defaultProfile;

  const found = settings.providerProfiles.find(
    (p) => p.id === activeId && p.provider === provider,
  );
  return found ?? defaultProfile;
}

/**
 * Generates a unique profile ID scoped to a provider.
 */
export function generateProfileId(provider: ProviderOption): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${provider}-${ts}-${rand}`;
}
