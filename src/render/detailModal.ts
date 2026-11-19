import ICAL from "ical.js";
import { type App, Modal, Setting } from "obsidian";
import { editable } from "../ical/editable";
import type { CalObject, Managed, Patch, PendingUpdate } from "../types";
import { dateInputOf, diffPatch } from "../ui/editForm";
import { type RefView, formatDate } from "./present";
import { describeRrule } from "./recur";

const STATE_TEXT: Record<string, string> = {
  deleted: "已刪除", missing: "查無此物（從未同步到，或已不在任何清單）", ambiguous: "短 ID 對到多筆", pending: "待送（尚未送到伺服器）",
  moved: "已搬移", "maybe-moved": "可能已搬移：原物件已不在原清單，還有清單沒同步完，暫不判定為刪除",
};

function description(o: CalObject): string | undefined {
  try {
    const root = new ICAL.Component(ICAL.parse(o.ics));
    const c = [...root.getAllSubcomponents("vtodo"), ...root.getAllSubcomponents("vevent")].find((x) => !x.hasProperty("recurrence-id"));
    const d = c?.getFirstPropertyValue("description");
    return d == null ? undefined : String(d);
  } catch { return undefined; }
}

const STATUS_TEXT: Record<string, string> = { "": "未完成", "NEEDS-ACTION": "未完成", "IN-PROCESS": "進行中", COMPLETED: "已完成", CANCELLED: "已取消" };
/** Managed.date 形如 "date-time|Asia/Taipei|20261124T150000"。 */
function dateText(d: string | undefined): string {
  if (!d) return "（無日期）";
  const [type, tzid, v] = d.split("|");
  const day = `${v.slice(0, 4)}/${+v.slice(4, 6)}/${+v.slice(6, 8)}`;
  return type === "date" ? day : `${day} ${v.slice(9, 11)}:${v.slice(11, 13)}${tzid && tzid !== "Asia/Taipei" ? `（${tzid}）` : v.endsWith("Z") ? "（UTC）" : ""}`;
}
const managedText = (m: Managed, field: string) =>
  field === "summary" ? m.summary : field === "done" ? (STATUS_TEXT[m.status] ?? m.status) : dateText(m.date);

export interface DetailOptions {
  collectionName: (href: string) => string;
  pendingUpdate?: PendingUpdate;
  onSave?: (obj: CalObject, patch: Patch) => void;
  onResolve?: (p: PendingUpdate, choice: "mine" | "server") => void;
  /** 反向索引：參照此短 ID 的筆記 */
  notes?: string[];
  openNote?: (path: string) => void;
  /** 使用者明確要求改寫 .md 裡的這個短 ID（P2） */
  onRewrite?: (from: string, to: string) => void;
}

export class DetailModal extends Modal {
  constructor(app: App, private view: RefView, private opts: DetailOptions) { super(app); }

  onOpen() {
    const { contentEl, view, opts } = this;
    contentEl.addClass("caldav-detail");
    this.setTitle(view.obj?.summary || view.text);

    const pu = opts.pendingUpdate;
    if (pu?.state === "conflict" && pu.conflict && opts.onResolve) {
      const box = contentEl.createDiv({ cls: "caldav-detail__conflict" });
      box.createEl("strong", { text: "衝突：你修改的欄位在伺服器上也被改過" });
      const dl = box.createEl("dl");
      for (const f of Object.keys(pu.patch)) {
        dl.createEl("dt", { text: f === "summary" ? "標題" : f === "done" ? "狀態" : "日期" });
        dl.createEl("dd", { text: `我的：${managedText(pu.conflict.mine, f)}　伺服器：${managedText(pu.conflict.server, f)}` });
      }
      new Setting(box)
        .addButton((b) => b.setButtonText("用我的").setCta().onClick(() => { this.close(); opts.onResolve!(pu, "mine"); }))
        .addButton((b) => b.setButtonText("用伺服器的").onClick(() => { this.close(); opts.onResolve!(pu, "server"); }));
    } else if (pu) {
      contentEl.createEl("p", { text: pu.state === "failed" ? `修改送出失敗：${pu.lastError ?? ""}` : "有尚未送出的修改", cls: "caldav-detail__note" });
    }

    const dl = contentEl.createEl("dl");
    const row = (k: string, v: string | undefined) => { if (!v) return; dl.createEl("dt", { text: k }); dl.createEl("dd", { text: v }); };
    if (view.state !== "ok" && view.state !== "moved") row("狀態", view.ambiguity === "move" ? "搬移後有多筆相符：請選擇要指向哪一筆" : STATE_TEXT[view.state] ?? view.state);
    if (view.state === "moved" && view.obj) {
      const box = contentEl.createDiv({ cls: "caldav-detail__note" });
      contentEl.insertBefore(box, dl); // 搬移說明放在欄位之前
      box.createSpan({ text: `已從〈${opts.collectionName(view.movedFrom ?? "")}〉搬到〈${opts.collectionName(view.obj.collection)}〉。筆記裡仍是舊的短 ID ${view.id}，在這台裝置靠本機紀錄解析；其他裝置可能看不到。` });
      if (opts.onRewrite) {
        const to = view.obj.shortId;
        new Setting(box).addButton((b) => b.setButtonText(`更新參照（改為 ${to}）`).setCta().onClick(() => { this.close(); opts.onRewrite!(view.id, to); }));
      }
    }
    const objs = view.obj ? [view.obj] : view.candidates ?? [];
    const now = new Date();
    for (const o of objs) {
      if (objs.length > 1) {
        dl.createEl("dt", { text: `候選：${o.summary || "（無標題）"}` });
        if (view.ambiguity === "move" && opts.onRewrite) {
          const dd = dl.createEl("dd");
          new Setting(dd).addButton((b) => b.setButtonText("改指向這一筆").onClick(() => { this.close(); opts.onRewrite!(view.id, o.shortId); }));
        }
      }
      row("類型", o.kind === "VTODO" ? "任務" : "事件");
      row("狀態", o.status);
      row("開始", o.start && formatDate(o.start, now));
      row("到期", o.due && formatDate(o.due, now));
      row("結束", o.end && formatDate(o.end, now));
      row("重複", o.rrule && `${describeRrule(o.rrule)}（${o.rrule}）`);
      row("清單", opts.collectionName(o.collection));
      row("備註", description(o));
      row("UID", o.uid);
    }
    row("短 ID", view.id);

    if (opts.notes) {
      dl.createEl("dt", { text: `參照此項目的筆記（${opts.notes.length}）` });
      const dd = dl.createEl("dd", { cls: "caldav-detail__notes" });
      if (!opts.notes.length) dd.setText("—");
      for (const path of opts.notes) {
        const a = dd.createEl("a", { text: path.replace(/\.md$/, ""), href: "#" });
        a.addEventListener("click", (e) => { e.preventDefault(); this.close(); opts.openNote?.(path); });
      }
    }

    if ((view.state === "ok" || view.state === "moved") && view.obj && opts.onSave) this.editForm(view.obj);
  }

  private editForm(obj: CalObject) {
    const can = editable(obj);
    if (!can.title && !can.done && !can.date) {
      this.contentEl.createEl("p", { text: "重複事件請在行事曆 App 修改", cls: "caldav-detail__note" });
      return;
    }
    this.contentEl.createEl("h4", { text: "修改" });
    const cur = dateInputOf(obj.kind === "VTODO" ? obj.due : obj.start);
    let titleEl: HTMLInputElement | undefined, dateEl: HTMLInputElement | undefined, timeEl: HTMLInputElement | undefined;
    let done = obj.status === "COMPLETED" || obj.status === "CANCELLED";
    if (can.title) new Setting(this.contentEl).setName("標題").addText((t) => { t.setValue(obj.summary); titleEl = t.inputEl; });
    if (can.done) new Setting(this.contentEl).setName("完成").addToggle((t) => t.setValue(done).onChange((v) => (done = v)));
    else if (obj.kind === "VTODO" && obj.rrule) this.contentEl.createEl("p", { text: "重複任務的完成請在提醒事項操作（§4.3）", cls: "caldav-detail__note" });
    if (can.date) {
      const label = obj.kind === "VTODO" ? "到期" : "開始";
      new Setting(this.contentEl).setName(`${label}日期`).setDesc(obj.rrule ? "修改會移動整個系列" : "清空表示沒有日期")
        .addText((t) => { t.inputEl.type = "date"; t.setValue(cur.date); dateEl = t.inputEl; });
      new Setting(this.contentEl).setName(`${label}時間`).setDesc("清空表示全天")
        .addText((t) => { t.inputEl.type = "time"; t.setValue(cur.time); timeEl = t.inputEl; });
    }
    new Setting(this.contentEl).addButton((b) => b.setButtonText("儲存").setCta().onClick(() => {
      // 送出時直接讀欄位值（iOS 的選擇器不一定觸發 input 事件）
      const patch = diffPatch(obj, {
        summary: titleEl?.value ?? obj.summary, done,
        date: dateEl?.value ?? cur.date, time: timeEl?.value ?? cur.time,
      });
      this.close();
      if (Object.keys(patch).length) this.opts.onSave!(obj, patch);
    }));
  }

  onClose() { this.contentEl.empty(); }
}
