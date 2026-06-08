declare module "markdown-it" {
  export interface Token {
    content: string;
    info: string;
    attrSet(name: string, value: string): void;
  }

  export type RenderRule = (
    tokens: Token[],
    idx: number,
    options: unknown,
    env: unknown,
    self: { renderToken(tokens: Token[], idx: number, options: unknown): string }
  ) => string;

  export default class MarkdownIt {
    constructor(options?: {
      breaks?: boolean;
      html?: boolean;
      linkify?: boolean;
    });

    readonly renderer: {
      rules: Record<string, RenderRule | undefined>;
      renderToken(tokens: unknown[], idx: number, options: unknown): string;
    };

    render(src: string, env?: unknown): string;
  }
}
