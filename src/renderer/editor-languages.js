import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import * as markdown from 'monaco-editor/esm/vs/basic-languages/markdown/markdown';
import * as javascript from 'monaco-editor/esm/vs/basic-languages/javascript/javascript';
import * as typescript from 'monaco-editor/esm/vs/basic-languages/typescript/typescript';
import * as css from 'monaco-editor/esm/vs/basic-languages/css/css';
import * as scss from 'monaco-editor/esm/vs/basic-languages/scss/scss';
import * as html from 'monaco-editor/esm/vs/basic-languages/html/html';
import * as xml from 'monaco-editor/esm/vs/basic-languages/xml/xml';
import * as yaml from 'monaco-editor/esm/vs/basic-languages/yaml/yaml';
import * as python from 'monaco-editor/esm/vs/basic-languages/python/python';
import * as ruby from 'monaco-editor/esm/vs/basic-languages/ruby/ruby';
import * as go from 'monaco-editor/esm/vs/basic-languages/go/go';
import * as rust from 'monaco-editor/esm/vs/basic-languages/rust/rust';
import * as java from 'monaco-editor/esm/vs/basic-languages/java/java';
import * as kotlin from 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin';
import * as swift from 'monaco-editor/esm/vs/basic-languages/swift/swift';
import * as cpp from 'monaco-editor/esm/vs/basic-languages/cpp/cpp';
import * as shell from 'monaco-editor/esm/vs/basic-languages/shell/shell';
import * as sql from 'monaco-editor/esm/vs/basic-languages/sql/sql';
import * as graphql from 'monaco-editor/esm/vs/basic-languages/graphql/graphql';
import * as ini from 'monaco-editor/esm/vs/basic-languages/ini/ini';
import { createTokenizationSupport } from 'monaco-editor/esm/vs/language/json/tokenization';

// Register grammars directly to keep highlighting independent of IDE language services.
const definitions = [
  ['markdown', markdown, ['md', 'markdown']],
  ['javascript', javascript, ['js', 'jsx', 'mjs', 'cjs']],
  ['typescript', typescript, ['ts', 'tsx']],
  ['css', css, ['css']],
  ['scss', scss, ['scss']],
  ['html', html, ['html']],
  ['xml', xml, ['xml']],
  ['yaml', yaml, ['yaml', 'yml']],
  ['python', python, ['py']],
  ['ruby', ruby, ['rb']],
  ['go', go, ['go']],
  ['rust', rust, ['rs']],
  ['java', java, ['java']],
  ['kotlin', kotlin, ['kt']],
  ['swift', swift, ['swift']],
  ['cpp', cpp, ['c', 'h', 'cpp', 'hpp']],
  ['shell', shell, ['sh', 'zsh', 'bash']],
  ['sql', sql, ['sql']],
  ['graphql', graphql, ['graphql', 'gql']],
  ['ini', ini, ['ini']],
];
for (const [id, grammar, extensions] of definitions) {
  monaco.languages.register({ id, extensions: extensions.map(ext => `.${ext}`) });
  monaco.languages.setMonarchTokensProvider(id, grammar.language);
  monaco.languages.setLanguageConfiguration(id, grammar.conf);
}
monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc'] });
monaco.languages.setTokensProvider('json', createTokenizationSupport(true));
monaco.languages.setLanguageConfiguration('json', {
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }]
});

// Use the same registered extensions for file detection and tokenization.
export function languageForFile(file) {
  const name = String(file?.name || '').toLowerCase();
  const ext = String(file?.ext || name.split('.').slice(1).pop() || '').toLowerCase();
  if (ext === 'env' || name.startsWith('.env')) return 'plaintext';
  if (['claude', 'agents', 'agent', 'readme'].includes(name)) return 'markdown';
  return monaco.languages.getLanguages().find(language =>
    language.extensions?.includes(`.${ext}`)
  )?.id || 'plaintext';
}

monaco.editor.defineTheme('botlogik-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#080809',
    'editor.foreground': '#D4D4D4',
    'editorLineNumber.foreground': '#60606A',
    'editorLineNumber.activeForeground': '#CCCCCC',
    'editor.selectionBackground': '#264F78',
    'editor.lineHighlightBackground': '#FFFFFF06',
    'editorIndentGuide.background1': '#FFFFFF12',
    'editorIndentGuide.activeBackground1': '#FFFFFF30'
  }
});
