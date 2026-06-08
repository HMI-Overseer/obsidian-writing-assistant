declare module "markdown-it" {
  export interface Token {
    content: string;
    info: string;
    markup?: string;
    type?: string;
    tag?: string;
    attrs?: Array<[string, string]>;
    attrSet(name: string, value: string): void;
    attrGet(name: string): string | null;
  }

  export interface StateInline {
    src: string;
    pos: number;
    posMax: number;
    push(type: string, tag: string, nesting: number): Token;
  }

  export interface Ruler {
    before(
      beforeName: string,
      ruleName: string,
      fn: (state: StateInline, silent: boolean) => boolean
    ): void;
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
    readonly inline: {
      ruler: Ruler;
    };

    render(src: string, env?: unknown): string;
  }
}
