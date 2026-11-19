import { MarkdownRenderChild, type MarkdownPostProcessor } from "obsidian";
import { renderRef } from "./chip";
import type { MemoryIndex } from "./index";
import { type RefView, present } from "./present";
import { findRefs } from "./refs";

class RefChild extends MarkdownRenderChild {
  constructor(el: HTMLElement, private id: string, private label: string, private index: MemoryIndex, private onClick: (v: RefView) => void) { super(el); }
  onload() {
    this.draw();
    this.register(this.index.onChange(() => this.draw()));
  }
  private draw() {
    const { objs, tombs, pending } = this.index.get(this.id);
    renderRef(this.containerEl, present(this.id, this.label, objs, tombs, new Date(), pending), this.onClick);
  }
}

/** 閱讀模式：Obsidian 已把 cal: 解析成外部連結（T7），程式碼裡的不會變成 <a>。 */
export function readingModeProcessor(index: MemoryIndex, onClick: (v: RefView) => void): MarkdownPostProcessor {
  return (el, ctx) => {
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a.external-link[href^="cal:"]'))) {
      const [ref] = findRefs(`[${a.textContent ?? ""}](${a.getAttribute("href") ?? ""})`);
      if (!ref) continue;
      const span = createSpan();
      a.replaceWith(span);
      ctx.addChild(new RefChild(span, ref.id, ref.label, index, onClick));
    }
  };
}
