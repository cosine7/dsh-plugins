/** Feishu post Markdown: isolate fenced blocks so following prose is not swallowed. */
export function markdownPost(content: string): string {
  const rows: { tag: "md"; text: string }[][] = [];
  let lines: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    if (lines.join("\n").trim()) rows.push([{ tag: "md", text: lines.join("\n") }]);
    lines = [];
  };
  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) {
      flush();
      fence = marker[1];
    } else if (
      marker &&
      fence &&
      marker[1][0] === fence[0] &&
      marker[1].length >= fence.length &&
      !marker[2].trim()
    ) {
      lines.push(line);
      flush();
      fence = undefined;
      continue;
    }
    lines.push(line);
  }
  flush();
  return JSON.stringify({ zh_cn: { content: rows } });
}

/** Split before serialization limits, preserving Unicode and fenced code across parts. */
export function splitMarkdown(content: string, limit = 6000): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let fence: { marker: string; opening: string } | undefined;
  const emit = () => {
    if (!chunk) return;
    chunks.push(chunk + (fence ? `\n${fence.marker}` : ""));
    chunk = fence ? `${fence.opening}\n` : "";
  };
  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    if (Buffer.byteLength(chunk + line, "utf8") > limit && chunk) emit();
    for (const character of line) {
      if (Buffer.byteLength(chunk + character, "utf8") > limit) emit();
      chunk += character;
    }
    chunk += "\n";
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) fence = { marker: marker[1], opening: line };
    else if (
      marker &&
      fence &&
      marker[1][0] === fence.marker[0] &&
      marker[1].length >= fence.marker.length &&
      !marker[2].trim()
    )
      fence = undefined;
  }
  if (chunk.trim()) chunks.push(chunk.trimEnd());
  if (
    chunks.some(
      (part) => Buffer.byteLength(JSON.stringify({ content: markdownPost(part) }), "utf8") > 24000,
    )
  ) {
    if (limit <= 256) throw new Error("Markdown 结构过大，请缩短代码围栏或内容。");
    return splitMarkdown(content, Math.floor(limit / 2));
  }
  return chunks;
}
