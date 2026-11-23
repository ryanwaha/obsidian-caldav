const leaf = app.workspace.getMostRecentLeaf();
const lines = [...leaf.view.contentEl.querySelectorAll('.cm-line')];
return lines.map((l, i) => (i+1) + ':' + l.querySelectorAll('.m6-probe-chip').length + ' "' + l.textContent.replace(/◆/g,'◆') + '"');
