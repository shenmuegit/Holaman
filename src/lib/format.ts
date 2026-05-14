export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function tryFormatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || /<body[\s>]/i.test(value);
}

export function formatHtml(value: string): string {
  const compact = value
    .replace(/>\s+</g, "><")
    .replace(/</g, "\n<")
    .replace(/>\n/g, ">");
  const lines = compact
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let depth = 0;
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);

  return lines
    .map((line) => {
      const closing = /^<\//.test(line);
      const match = line.match(/^<\/?([a-z0-9-]+)/i);
      const tagName = match?.[1]?.toLowerCase();
      const selfClosing = /\/>$/.test(line) || (tagName ? voidTags.has(tagName) : false);
      const hasClosingOnSameLine = /^<([a-z0-9-]+)[^>]*>.*<\/\1>$/i.test(line);

      if (closing) depth = Math.max(depth - 1, 0);
      const formatted = `${"  ".repeat(depth)}${line}`;
      if (!closing && !selfClosing && !hasClosingOnSameLine && /^</.test(line) && !/^<!/.test(line)) {
        depth += 1;
      }
      return formatted;
    })
    .join("\n");
}

export async function formatHtmlPretty(value: string): Promise<string> {
  try {
    const [{ default: prettier }, { default: htmlPlugin }, { default: babelPlugin }, { default: estreePlugin }] =
      await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/html"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);

    const html = await prettier.format(value, {
      parser: "html",
      plugins: [htmlPlugin],
      printWidth: 100,
      tabWidth: 2,
      htmlWhitespaceSensitivity: "ignore",
      bracketSameLine: false,
    });

    return expandInlineScripts(html, async (script) =>
      prettier.format(script, {
        parser: "babel",
        plugins: [babelPlugin, estreePlugin],
        printWidth: 100,
        tabWidth: 2,
        semi: true,
        singleQuote: false,
      }),
    );
  } catch {
    return formatHtml(value);
  }
}

async function expandInlineScripts(
  html: string,
  formatScript: (script: string) => Promise<string>,
): Promise<string> {
  const scriptPattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let output = "";
  let lastIndex = 0;

  for (const match of html.matchAll(scriptPattern)) {
    const [fullMatch, attrs = "", script = ""] = match;
    const index = match.index ?? 0;
    output += html.slice(lastIndex, index);
    lastIndex = index + fullMatch.length;

    if (/\ssrc\s*=/i.test(attrs) || !script.trim()) {
      output += fullMatch;
      continue;
    }

    try {
      const formattedScript = (await formatScript(script.trim())).trimEnd();
      output += `<script${attrs}>\n${indentBlock(formattedScript, 2)}\n</script>`;
    } catch {
      output += fullMatch;
    }
  }

  return output + html.slice(lastIndex);
}

function indentBlock(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => (line.trim() ? `${prefix}${line}` : line))
    .join("\n");
}

export function rowId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
