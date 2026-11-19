import ICAL from "ical.js";
import { type App, Modal } from "obsidian";
import type { CalObject } from "../types";
import { type RefView, formatDate } from "./present";
import { describeRrule } from "./recur";

const STATE_TEXT: Record<string, string> = { ok: "", deleted: "已刪除", missing: "查無此物（從未同步到，或已不在任何清單）", ambiguous: "短 ID 對到多筆" };

function description(o: CalObject): string | undefined {
  try {
    const root = new ICAL.Component(ICAL.parse(o.ics));
    const c = [...root.getAllSubcomponents("vtodo"), ...root.getAllSubcomponents("vevent")].find((x) => !x.hasProperty("recurrence-id"));
    const d = c?.getFirstPropertyValue("description");
    return d == null ? undefined : String(d);
  } catch { return undefined; }
}

export class DetailModal extends Modal {
  constructor(app: App, private view: RefView, private collectionName: (href: string) => string) { super(app); }

  onOpen() {
    const { contentEl, view } = this;
    contentEl.addClass("caldav-detail");
    this.setTitle(view.obj?.summary || view.text);
    const dl = contentEl.createEl("dl");
    const row = (k: string, v: string | undefined) => { if (!v) return; dl.createEl("dt", { text: k }); dl.createEl("dd", { text: v }); };
    if (view.state !== "ok") row("狀態", STATE_TEXT[view.state] ?? view.state);
    const objs = view.obj ? [view.obj] : view.candidates ?? [];
    const now = new Date();
    for (const o of objs) {
      if (objs.length > 1) dl.createEl("dt", { text: `候選：${o.summary || "（無標題）"}`, cls: "caldav-detail__candidate" });
      row("類型", o.kind === "VTODO" ? "任務" : "事件");
      row("狀態", o.status);
      row("開始", o.start && formatDate(o.start, now));
      row("到期", o.due && formatDate(o.due, now));
      row("結束", o.end && formatDate(o.end, now));
      row("重複", o.rrule && `${describeRrule(o.rrule)}（${o.rrule}）`);
      row("清單", this.collectionName(o.collection));
      row("備註", description(o));
      row("UID", o.uid);
    }
    row("短 ID", view.id);
  }

  onClose() { this.contentEl.empty(); }
}
