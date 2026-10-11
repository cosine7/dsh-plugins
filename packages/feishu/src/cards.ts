import { text, record, type Card, type Choice } from "./types.js";

export function choices(value: unknown): Choice[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6)
    throw new Error("确认卡片需要 2–6 个按钮。");
  const result = value.map((v) => {
    if (!record(v)) throw new Error("按钮格式无效。");
    const id = text(v.id, "按钮 ID", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error("按钮 ID 仅支持英文字母、数字、下划线和连字符。");
    return { id, label: text(v.label, "按钮文字", 32) };
  });
  if (new Set(result.map((c) => c.id)).size !== result.length)
    throw new Error("按钮 ID 不可重复。");
  return result;
}

export function deadline(value: unknown, now: number): number {
  const iso = text(value, "expires_at", 64);
  const timestamp = Date.parse(iso);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso) || !Number.isFinite(timestamp) || timestamp <= now)
    throw new Error("expires_at 必须是带时区偏移的未来 ISO 时间。");
  if (timestamp - now > 14 * 86400000)
    throw new Error("飞书消息卡片原地更新上限为 14 天，请指定更早的截止时间。");
  return timestamp;
}

/** Card 2.0: status never claims that merely accepting an action executed a trade. */
export function renderCard(card: Card): Record<string, unknown> {
  const pending = card.state === "pending";
  const state =
    card.status_text ??
    (pending ? "等待确认" : card.state === "expired" ? "已过期" : "已收到，待 Agent 处理");
  const deadlineText = new Date(card.expires_at).toISOString();
  const elements: Record<string, unknown>[] = [
    {
      tag: "column_set",
      flex_mode: "none",
      background_style: pending ? "blue-50" : "grey-50",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [{ tag: "markdown", content: card.content }],
        },
      ],
    },
    {
      tag: "markdown",
      content: `**${state}**\n截止时间：${deadlineText}\n确认只提交给 Agent，由 Agent 按收到时的情况重新判断。`,
    },
  ];
  if (pending)
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      columns: card.choices.map((choice, i) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          {
            tag: "button",
            text: { tag: "plain_text", content: choice.label },
            type: i === 0 ? "primary_filled" : "default",
            width: "fill",
            behaviors: [
              { type: "callback", value: { dsh_card_id: card.id, action_id: choice.id } },
            ],
          },
        ],
      })),
    });
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: {
      title: { tag: "plain_text", content: card.title },
      template: pending ? "blue" : "grey",
    },
    body: { direction: "vertical", vertical_spacing: "12px", elements },
  };
}
