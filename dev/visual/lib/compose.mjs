export function composeDocument(theme, appCss, pluginCss, scaffold, surfaceHtml) {
  return `<!doctype html><html class="theme-${theme}"><head>
        <style>${appCss}</style><style>${pluginCss}</style><style>${scaffold}</style></head>
        <body class="theme-${theme} mod-windows is-focused">${surfaceHtml}</body></html>`;
}
