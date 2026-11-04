import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import type { StreamParser } from '@codemirror/language';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Tag, tags } from '@lezer/highlight';

// The clike mode's own state, extended with where the tokenizer is inside a `///` doc comment line, the text of
// the last token, and whether it is inside a type declaration's header (`class A : B, C`).
type CsharpState = Record<string, unknown> & {
  inDocComment: boolean;
  inDocTag: boolean;
  previousToken: string;
  inTypeHeader: boolean;
};

// Visual Studio colors the `///`, the XML tags and their attribute names in one color and the prose in another.
const docCommentDelimiterTag = Tag.define(tags.comment);
const docCommentAttributeValueTag = Tag.define(tags.comment);

const CONTROL_KEYWORDS = new Set([
  'break', 'case', 'catch', 'continue', 'default', 'do', 'else', 'finally', 'for', 'foreach', 'goto',
  'if', 'return', 'switch', 'throw', 'try', 'while', 'yield', 'await',
]);

// C# keywords that name a type; Visual Studio colors these as keywords, and every other type name as a class.
const KEYWORD_TYPES = new Set([
  'bool', 'byte', 'char', 'decimal', 'double', 'dynamic', 'float', 'int', 'long', 'nint', 'nuint', 'object',
  'sbyte', 'short', 'string', 'uint', 'ulong', 'ushort', 'var', 'void',
]);

const TYPE_DECLARATION_KEYWORDS = new Set(['class', 'struct', 'interface', 'record', 'enum']);

// Keywords that can follow a value rather than a type, as in `Instance is null` or `Count switch { ... }`.
const VALUE_FOLLOWING_KEYWORDS = new Set(['is', 'as', 'in', 'and', 'or', 'not', 'when', 'switch', 'with']);

const csharpBase = csharp as unknown as StreamParser<Record<string, unknown>>;

function tokenDocComment(stream: Parameters<StreamParser<CsharpState>['token']>[0], state: CsharpState): string | null {
  if (state.inDocTag) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^\/?>/)) {
      state.inDocTag = false;
      return 'docCommentDelimiter';
    }
    if (stream.match(/^"[^"]*"?/) || stream.match(/^'[^']*'?/)) return 'docCommentAttributeValue';
    if (stream.match(/^[\w:.-]+/) || stream.match('=')) return 'docCommentDelimiter';
    stream.next();
    return 'docCommentDelimiter';
  }
  if (stream.match(/^<\/?[\w:.-]*/)) {
    state.inDocTag = true;
    return 'docCommentDelimiter';
  }
  if (!stream.match(/^[^<]+/)) stream.next();
  return 'docComment';
}

/**
 * Guesses that a capitalized name is a type until the semantic layer knows for sure: one followed by another
 * name (`StopController lastStop`), one after `new`, one opening an attribute (`[Required]`), or one in a type's
 * base list (`class A : B`).
 */
function looksLikeTypeName(stream: Parameters<StreamParser<CsharpState>['token']>[0], state: CsharpState, text: string, previousToken: string): boolean {
  if (!/^[A-Z]/.test(text)) return false;
  if (previousToken === 'new' || previousToken === '[') return true;
  if (state.inTypeHeader && (previousToken === ':' || previousToken === ',')) return true;
  const nextWord = stream.match(/^\s+@?([A-Za-z_]\w*)/, false) as RegExpMatchArray | null;
  return nextWord !== null && !VALUE_FOLLOWING_KEYWORDS.has(nextWord[1]);
}

// The clike C# mode with `///` doc comments split into delimiters, tags and prose, and control-flow keywords told apart.
const csharpParser: StreamParser<CsharpState> = {
  name: 'csharp',
  startState: (indentUnit) => ({
    ...csharpBase.startState!(indentUnit),
    inDocComment: false,
    inDocTag: false,
    previousToken: '',
    inTypeHeader: false,
  }),
  token(stream, state) {
    if (stream.sol()) {
      state.inDocComment = false;
      state.inDocTag = false;
    }
    if (state.inDocComment) return tokenDocComment(stream, state);

    // Only a `///` that is not inside a string or block comment starts a doc comment.
    if (state.tokenize == null && stream.match(/^\s*\/\/\/(?!\/)/, false)) {
      if (stream.eatSpace()) return null;
      stream.match('///');
      state.inDocComment = true;
      return 'docCommentDelimiter';
    }

    const previousToken = state.previousToken;
    const style = csharpBase.token(stream, state);
    const text = stream.current().trim();
    if (text) state.previousToken = text;
    if (TYPE_DECLARATION_KEYWORDS.has(text)) state.inTypeHeader = true;
    else if (text === '{' || text === ';') state.inTypeHeader = false;

    if (style === 'keyword' && CONTROL_KEYWORDS.has(text)) return 'controlKeyword';
    if (style === 'type' && !KEYWORD_TYPES.has(text)) return 'className';
    if (style === 'variable' && looksLikeTypeName(stream, state, text, previousToken)) return 'className';
    return style;
  },
  indent: (state, textAfter, context) => csharpBase.indent!(state, textAfter, context),
  languageData: csharpBase.languageData,
  tokenTable: {
    controlKeyword: tags.controlKeyword,
    className: tags.className,
    docComment: tags.docComment,
    docCommentDelimiter: docCommentDelimiterTag,
    docCommentAttributeValue: docCommentAttributeValueTag,
  },
};

const csharpLanguage = StreamLanguage.define(csharpParser);

// Visual Studio 2022 "Dark" C# colors.
const visualStudioDarkStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#569CD6' },
  { tag: tags.controlKeyword, color: '#D8A0DF' },
  { tag: tags.className, color: '#4EC9B0' },
  { tag: [tags.typeName, tags.standard(tags.variableName)], color: '#569CD6' },
  { tag: [tags.string, tags.special(tags.string)], color: '#D69D85' },
  { tag: tags.number, color: '#B5CEA8' },
  { tag: tags.atom, color: '#569CD6' },
  { tag: tags.comment, color: '#57A64A' },
  { tag: tags.docComment, color: '#57A64A' },
  { tag: docCommentDelimiterTag, color: '#808080' },
  { tag: docCommentAttributeValueTag, color: '#C8C8C8' },
  { tag: [tags.meta, tags.processingInstruction], color: '#9B9B9B' },
  { tag: tags.operator, color: '#B4B4B4' },
  { tag: [tags.variableName, tags.definition(tags.variableName), tags.punctuation], color: '#DCDCDC' },
], { themeType: 'dark' });

// Visual Studio 2022 "Light" C# colors.
const visualStudioLightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#0000FF' },
  { tag: tags.controlKeyword, color: '#8F08C4' },
  { tag: tags.className, color: '#2B91AF' },
  { tag: [tags.typeName, tags.standard(tags.variableName)], color: '#0000FF' },
  { tag: [tags.string, tags.special(tags.string)], color: '#A31515' },
  { tag: tags.number, color: '#000000' },
  { tag: tags.atom, color: '#0000FF' },
  { tag: tags.comment, color: '#008000' },
  { tag: tags.docComment, color: '#008000' },
  { tag: docCommentDelimiterTag, color: '#808080' },
  { tag: docCommentAttributeValueTag, color: '#808080' },
  { tag: [tags.meta, tags.processingInstruction], color: '#808080' },
  { tag: [tags.operator, tags.variableName, tags.definition(tags.variableName), tags.punctuation], color: '#000000' },
], { themeType: 'light' });

/**
 * The syntactic C# layer: colors a `.cs` file the moment it opens, without a language server. Used by
 * `getLanguageExtensions`. The highest precedence makes these colors win over the editor theme's own palette.
 */
export const csharpSyntaxExtensions: Extension[] = [
  csharpLanguage,
  Prec.highest(syntaxHighlighting(visualStudioDarkStyle)),
  Prec.highest(syntaxHighlighting(visualStudioLightStyle)),
];
