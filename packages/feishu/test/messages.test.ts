import { expect, test } from "vitest";
import { markdownPost, splitMarkdown } from "../src/messages.js";

test("post preserves Markdown and isolates fenced code from following prose", () => {
  const parsed = JSON.parse(
    markdownPost(
      "# 标题\n**加粗**\n\n```ts\nconst x = 1;\n```\n\n[链接](https://example.com)\n| A | B |\n|---|---|\n| 1 | 2 |",
    ),
  );
  expect(parsed.zh_cn.content).toHaveLength(3);
  expect(parsed.zh_cn.content[1][0].text).toBe("```ts\nconst x = 1;\n```");
  expect(parsed.zh_cn.content[2][0].text).toContain("[链接](https://example.com)");
  expect(parsed.zh_cn.content[2][0].text).toContain("| A | B |");
});

test("long code is split into complete fences without breaking Unicode or wire limits", () => {
  const parts = splitMarkdown("说明\n```text\n" + "你好🙂".repeat(4000) + "\n```\n结束");
  expect(parts.length).toBeGreaterThan(2);
  for (const part of parts) {
    expect((part.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(part).not.toContain("\uFFFD");
    expect(Buffer.byteLength(JSON.stringify({ content: markdownPost(part) }), "utf8")).toBeLessThan(
      24001,
    );
  }
  const reconstructed = parts
    .join("\n")
    .replace(/^说明\n|^```text\n|^```\n?|结束$/gm, "")
    .replaceAll("\n", "");
  expect(reconstructed).toBe("你好🙂".repeat(4000));
});

test("serialization-heavy input and many fences stay below the rich-message size limit", () => {
  for (const input of ["\0".repeat(30000), "```\nx\n```\n".repeat(2200)]) {
    for (const part of splitMarkdown(input))
      expect(
        Buffer.byteLength(JSON.stringify({ content: markdownPost(part) }), "utf8"),
      ).toBeLessThan(24001);
  }
});
