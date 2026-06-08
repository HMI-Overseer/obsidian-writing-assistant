import MarkdownIt from "markdown-it";
import type { RenderRule, Token } from "markdown-it";

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
  linkify: true,
});

const defaultLinkOpen: RenderRule =
  markdownIt.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

markdownIt.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer nofollow");
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

markdownIt.renderer.rules.table_open = () => '<div class="lmsa-md-table-wrap"><table>';
markdownIt.renderer.rules.table_close = () => "</table></div>";

export function renderMessageMarkdownToHtml(text: string): string {
  return markdownIt.render(normalizeMessageMarkdown(text));
}
