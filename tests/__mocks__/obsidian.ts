// Stub mock for the Obsidian API.
// Provides empty implementations of every symbol the plugin imports,
// so module resolution succeeds during tests without pulling in the
// real Obsidian runtime.

export class Plugin {}
export class PluginSettingTab {}
export class ItemView {
  contentEl = document.createElement("div");
}
export class Modal {}
export class Component {}
export class Notice {}
export class Setting {
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addToggle() {
    return this;
  }
  addDropdown() {
    return this;
  }
  addButton() {
    return this;
  }
  addSlider() {
    return this;
  }
  addTextArea() {
    return this;
  }
}
export class MarkdownRenderer {
  static render() {
    return Promise.resolve();
  }
}

export function setIcon() {}
export function requestUrl() {
  return Promise.resolve({ json: {}, text: "", status: 200 });
}
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/(^\/|\/$)/g, "");
}

export class TFile {
  name = "";
  path = "";
  extension = "md";
}

export class TFolder {
  name = "";
  path = "";
  children: (TFile | TFolder)[] = [];
}

// Type-only exports referenced via `import type` don't need runtime
// values, but re-exporting empty interfaces keeps TypeScript happy
// if someone accidentally uses a value import.
export type App = Record<string, unknown>;
export type WorkspaceLeaf = Record<string, unknown>;
export type MetadataCache = Record<string, unknown>;
