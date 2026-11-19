import { type App, FuzzySuggestModal, type FuzzyMatch } from "obsidian";
import type { CalObject } from "../types";
import { formatDate, nextEventOccurrence } from "../render/present";
import { isDone as done, sortForPicker } from "./sort";

export class PickModal extends FuzzySuggestModal<CalObject> {
  constructor(app: App, private objs: CalObject[], private collectionName: (href: string) => string, private onPick: (o: CalObject) => void) {
    super(app);
    this.setPlaceholder("搜尋任務或事件…");
  }
  getItems(): CalObject[] { return sortForPicker(this.objs); }
  getItemText(o: CalObject): string { return `${o.summary} ${this.collectionName(o.collection)}`; }
  renderSuggestion(m: FuzzyMatch<CalObject>, el: HTMLElement): void {
    const o = m.item, now = new Date();
    const date = o.kind === "VEVENT" && o.rrule ? nextEventOccurrence(o, now) : o.due ?? o.start;
    el.createDiv({ text: `${o.kind === "VEVENT" ? "◷" : done(o) ? "☑" : "☐"} ${o.summary || "（無標題）"}` });
    el.createEl("small", { text: [date && formatDate(date, now), this.collectionName(o.collection)].filter(Boolean).join(" · "), cls: "caldav-pick__meta" });
  }
  onChooseItem(o: CalObject): void { this.onPick(o); }
}
