// XML 特殊字符转义（RSS / sitemap 等 XML 输出共用，此前在两个端点各有一份）。
export const escapeXml = (value: string): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
