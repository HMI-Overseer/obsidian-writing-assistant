import MarkdownIt from "markdown-it";
import type { RendererRule, StateInline, Token } from "markdown-it";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCodeLanguageLabel(info: string): string {
  const language = info.trim().split(/\s+/)[0];
  return language || "text";
}

function renderCodeBlock(content: string, language: string): string {
  const escapedLanguage = escapeHtml(language);
  const escapedContent = escapeHtml(content);

  return [
    '<div class="lmsa-md-codeblock">',
    '  <div class="lmsa-md-codeblock-header">',
    `    <span class="lmsa-md-codeblock-language">${escapedLanguage}</span>`,
    '    <button type="button" class="lmsa-md-codeblock-copy">Copy</button>',
    "  </div>",
    `  <pre class="lmsa-md-codeblock-pre"><code class="language-${escapedLanguage}">${escapedContent}</code></pre>`,
    "</div>",
  ].join("");
}

export function normalizeMessageMarkdown(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

const markdownIt = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: false,
});

function isExternalHref(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

function buildInternalHref(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || isExternalHref(trimmed)) return null;

  const hashIndex = trimmed.indexOf("#");
  const pathPart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const hashPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";

  if (!pathPart.trim()) return null;

  const encodedPath = encodeURI(pathPart);
  if (!hashPart) return encodedPath;

  return `${encodedPath}#${encodeURIComponent(hashPart)}`;
}

function pushInternalLink(state: StateInline, href: string, label: string): void {
  const linkOpen = state.push("link_open", "a", 1);
  linkOpen.attrSet("href", href);

  const textToken = state.push("text", "", 0);
  textToken.content = label;

  state.push("link_close", "a", -1);
}

function parseWikilink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5b || state.src.charCodeAt(start + 1) !== 0x5b) {
    return false;
  }

  const end = state.src.indexOf("]]", start + 2);
  if (end < 0 || end > state.posMax) return false;

  const rawContent = state.src.slice(start + 2, end).trim();
  if (!rawContent) return false;

  const pipeIndex = rawContent.indexOf("|");
  const target = (pipeIndex >= 0 ? rawContent.slice(0, pipeIndex) : rawContent).trim();
  const label = (pipeIndex >= 0 ? rawContent.slice(pipeIndex + 1) : rawContent).trim();
  const href = buildInternalHref(target);
  if (!href || !label) return false;

  if (!silent) {
    pushInternalLink(state, href, label);
  }

  state.pos = end + 2;
  return true;
}

function parseInternalMarkdownLink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5b) return false;
  if (start > 0 && state.src.charCodeAt(start - 1) === 0x21) return false;

  const match = /^\[([^\]\n]+)\]\(([^)\n]+)\)/.exec(state.src.slice(start, state.posMax));
  if (!match) return false;

  const label = match[1].trim();
  const target = match[2].trim();
  const href = buildInternalHref(target);
  if (!label || !href) return false;

  if (!silent) {
    pushInternalLink(state, href, label);
  }

  state.pos = start + match[0].length;
  return true;
}

markdownIt.inline.ruler.before("link", "lmsa_wikilink", parseWikilink);
markdownIt.inline.ruler.before("link", "lmsa_internal_markdown_link", parseInternalMarkdownLink);

const defaultLinkOpen: RendererRule =
  markdownIt.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdownIt.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet("href");
  if (href) {
    tokens[idx].attrSet("data-lmsa-link-href", href);
  }
  tokens[idx].attrSet("rel", "nofollow");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

markdownIt.renderer.rules.fence = (tokens: Token[], idx: number) => {
  const token = tokens[idx];
  return renderCodeBlock(token.content, getCodeLanguageLabel(token.info));
};

markdownIt.renderer.rules.code_block = (tokens: Token[], idx: number) => {
  const token = tokens[idx];
  return renderCodeBlock(token.content, "text");
};

markdownIt.renderer.rules.image = (tokens: Token[], idx: number) => {
  // Security (finding 3.2): never emit an <img>. A remote / data:image source auto-loads
  // in the Electron renderer, an out-of-band tracking-pixel / exfiltration channel for a
  // prompt-injected model. Drop the source entirely, keep only the escaped alt text.
  return escapeHtml(tokens[idx].content ?? "");
};

markdownIt.renderer.rules.table_open = () => '<div class="lmsa-md-table-wrap"><table>';
markdownIt.renderer.rules.table_close = () => "</table></div>";

export function renderMessageMarkdownToHtml(text: string): string {
  return markdownIt.render(normalizeMessageMarkdown(text));
}
