# Third-party notices

The distributed build of Writing Assistant Chat (`main.js`) bundles the
following third-party components. Their license terms are reproduced or
referenced below, as required by those licenses. The plugin's own source code
is licensed under the MIT License (see [LICENSE](LICENSE)).

---

## markdown-it

- Version: 14.x
- Homepage: https://github.com/markdown-it/markdown-it
- License: MIT

```
Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

---

## @anthropic-ai/claude-agent-sdk

- Version: 0.3.207
- Homepage: https://github.com/anthropics/claude-agent-sdk-typescript
- License: Proprietary (not open source)

This component is used only to drive a locally installed `claude` command-line
tool when you choose the Claude Code provider. Its JavaScript is bundled into
`main.js`; the SDK's separate native binary is not shipped. It is not covered by
this plugin's MIT license.

```
© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
outlined here: https://code.claude.com/docs/en/legal-and-compliance
```
