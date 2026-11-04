/**
 * Build loader: removes what the minifier can't see inside `/* glsl *\/` template strings, which is
 * their comments, indentation and blank lines. Without this they ship to every visitor, about 9 KB
 * gzipped of the renderer chunk. Production only, so shader errors in `pnpm dev` keep line numbers.
 */
// Turbopack runs loaders as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript');

const TAG = '/* glsl */';

function stripGlsl(source) {
  if (!source.includes(TAG)) return source;
  const file = ts.createSourceFile('shader.ts', source, ts.ScriptTarget.Latest, true);
  const tagged = (node) =>
    (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    source.slice(node.getFullStart(), node.getStart(file)).includes(TAG);

  /** The source from `start` to `end`, with each tagged template below `node` rewritten. */
  function render(node, start, end) {
    const edits = [];
    const visit = (child) => {
      if (tagged(child)) edits.push([child.getStart(file), child.end, template(child)]);
      else ts.forEachChild(child, visit);
    };
    visit(node);
    let out = '';
    let at = start;
    for (const [from, to, text] of edits) {
      out += source.slice(at, from) + text;
      at = to;
    }
    return out + source.slice(at, end);
  }

  function template(node) {
    let out = '';
    let line = '';
    let comment = false;
    const text = (raw) => {
      const pieces = raw.split('\n');
      pieces.forEach((piece, index) => {
        if (index > 0) {
          const kept = line.trimEnd();
          if (kept) out += kept + '\n';
          line = '';
          comment = false;
        }
        if (comment) return;
        const slashes = piece.indexOf('//');
        if (slashes >= 0) comment = true;
        const code = slashes >= 0 ? piece.slice(0, slashes) : piece;
        line += line ? code : code.trimStart();
      });
    };
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      text(source.slice(node.getStart(file) + 1, node.end - 1));
    } else {
      text(source.slice(node.head.getStart(file) + 1, node.head.end - 2));
      let previous = node.head.end;
      for (const span of node.templateSpans) {
        const literal = span.literal;
        const literalStart = literal.getStart(file);
        // An interpolation inside a comment was never part of the shader.
        if (!comment) line += '${' + render(span.expression, previous, literalStart) + '}';
        const closing = ts.isTemplateTail(literal) ? 1 : 2;
        text(source.slice(literalStart + 1, literal.end - closing));
        previous = literal.end;
      }
    }
    return '`' + out + line + '`';
  }

  return render(file, 0, source.length);
}

module.exports = function stripGlslLoader(source) {
  return stripGlsl(source);
};
module.exports.stripGlsl = stripGlsl;
