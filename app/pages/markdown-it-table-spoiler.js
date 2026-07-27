module.exports = function tableSpoilerPlugin(md) {
  md.core.ruler.push('table_spoiler', function (state) {
    let tableIndex = -1;
    let colIndex = 0;
    let inTable = false;
    let checkedCols = state.env.checkedColumns || new Set();

    for (let i = 0; i < state.tokens.length; i++) {
      let token = state.tokens[i];

      if (token.type === 'table_open') {
        tableIndex++;
        inTable = true;
      } else if (token.type === 'table_close') {
        inTable = false;
      } else if (inTable && token.type === 'tr_open') {
        colIndex = 0;
      } else if (inTable && token.type === 'th_open') {
        const id = `${tableIndex}-${colIndex}`;
        const isChecked = checkedCols.has(id);
        const checkboxHtml = `<input type="checkbox" class="col-spoiler-checkbox" data-id="${id}" ${isChecked ? 'checked' : ''} style="margin-right: 8px; cursor: pointer;" />`;

        let inlineToken = state.tokens[i + 1];
        if (inlineToken && inlineToken.type === 'inline') {
          let htmlToken = new state.Token('html_inline', '', 0);
          htmlToken.content = checkboxHtml;
          inlineToken.children.unshift(htmlToken);
        }
        colIndex++;
      } else if (inTable && token.type === 'td_open') {
        const id = `${tableIndex}-${colIndex}`;
        const isChecked = checkedCols.has(id);
        let inlineToken = state.tokens[i + 1];
        
        if (inlineToken && inlineToken.type === 'inline') {
          let openSpansToClose = 0;

          if (inlineToken.children) {
            inlineToken.children = inlineToken.children.filter((child) => {
              if (child.type === 'html_inline') {
                if (/<span\s+class\s*=\s*['"]?(spoiler|spolier)['"]?[^>]*>/i.test(child.content)) {
                  if (!isChecked) {
                    openSpansToClose++;
                    return false; // Strip it out, revealing the text
                  }
                  return true; // Keep it, preserving the manual markdown spoiler
                }
                if (/<\/span>/i.test(child.content)) {
                  if (!isChecked && openSpansToClose > 0) {
                    openSpansToClose--;
                    return false; // Strip the corresponding closing tag
                  }
                  return true;
                }
              }
              return true;
            });
          }
        }
        colIndex++;
      }
    }
  });
};
