import { describe, expect, it } from "vitest";
// @ts-expect-error the driver is plain ESM outside the typechecked source tree (plan D6).
import {
  buildEpilogue,
  missingBundleIdentifiers,
  REQUIRED_BUNDLE_IDENTIFIERS,
} from "../../../dev/driver/lib/scriptedProvider.mjs";

/**
 * The driver no longer changes the plugin's source, so nothing compiles it against the bundle.
 * This assertion is what replaces the compiler: it is the reason reaching into a built artifact
 * is honest here rather than the silent-drift trap plan decision D3 rejected. If it stops
 * failing on a drifted bundle, the driver goes back to being able to screenshot the wrong thing
 * while looking healthy.
 *
 * Red-green: each case below was observed failing against a deliberately broken input before it
 * was trusted, which for this file means checking that a *renamed* and a *minified* bundle are
 * both reported rather than passing.
 */

const BUNDLE = `
"use strict";
var __create = Object.create;
function createStreamMetadataGate(fallback) { return fallback; }
function createOwnedStreamRun(config) { return config; }
function createCaptureBatch(input) { return input; }
function getProviderDescriptor(id) { return id; }
function createChatClient(provider, providerSettings, claudeCodeRuntime) { return provider; }
module.exports = {};
`;

describe("the bundle shape the driver's epilogue depends on", () => {
  it("accepts a flat, unminified bundle carrying all four declarations", () => {
    expect(missingBundleIdentifiers(BUNDLE)).toStrictEqual([]);
  });

  it("reports a renamed identifier rather than appending an epilogue that cannot bind", () => {
    const renamed = BUNDLE.replace("function createOwnedStreamRun", "function createOwnedRun");
    expect(missingBundleIdentifiers(renamed)).toStrictEqual(["createOwnedStreamRun"]);
  });

  it("reports every missing identifier at once, not just the first", () => {
    expect(missingBundleIdentifiers("var x = 1;\n")).toStrictEqual([
      ...REQUIRED_BUNDLE_IDENTIFIERS,
    ]);
  });

  it("reports a minified bundle, because a mangled scope is not reachable by name", () => {
    // esbuild only hoists these to column zero while `minifySyntax` is off. A one-line bundle is
    // what the check has to catch, since the names may still appear as call targets.
    const minified = BUNDLE.replace(/\n/g, " ");
    expect(missingBundleIdentifiers(minified)).toStrictEqual([...REQUIRED_BUNDLE_IDENTIFIERS]);
  });
});

describe("the epilogue itself", () => {
  it("parses, so a template mistake fails here and not inside a launched Obsidian", () => {
    expect(() => new Function(buildEpilogue())).not.toThrow();
  });

  it("rebinds the factory rather than shadowing it, which is what reaches all eight call sites", () => {
    expect(buildEpilogue()).toMatch(/^ {2}createChatClient = function \(/m);
  });

  it("carries the scripted client's own source, so the tested function is the shipped one", () => {
    expect(buildEpilogue()).toContain("loweredReason: \"scripted_driver_provider\"");
  });
});
