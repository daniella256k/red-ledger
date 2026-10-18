/**
 * Best-effort file type label from a file name, used as a hint for the model
 * (e.g. <attached_file type="yaml">). Unknown extensions fall back to the
 * extension itself; files with no extension fall back to "text".
 */

const TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text', text: 'text', log: 'log',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx', rst: 'restructuredtext', adoc: 'asciidoc', tex: 'latex',
  pdf: 'pdf',
  csv: 'csv', tsv: 'tsv',
  json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'jsonl', ndjson: 'jsonl', ipynb: 'jupyter-notebook',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'config', properties: 'properties',
  env: 'dotenv',
  xml: 'xml', xsd: 'xml', xsl: 'xslt', xslt: 'xslt', plist: 'xml', svg: 'svg',
  html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  py: 'python', pyi: 'python', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', r: 'r', jl: 'julia',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy',
  gradle: 'gradle', swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', fs: 'fsharp', vb: 'vb', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  hs: 'haskell', elm: 'elm', clj: 'clojure', ml: 'ocaml', nim: 'nim', zig: 'zig', sol: 'solidity',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf', prisma: 'prisma',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'fish', ps1: 'powershell', psm1: 'powershell',
  bat: 'batch', cmd: 'batch', mk: 'makefile', cmake: 'cmake', tf: 'terraform', hcl: 'hcl', nix: 'nix',
  dockerfile: 'dockerfile', diff: 'diff', patch: 'diff'
}

const TYPE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  rakefile: 'ruby',
  gemfile: 'ruby',
  jenkinsfile: 'groovy',
  vagrantfile: 'ruby',
  procfile: 'procfile',
  '.gitignore': 'gitignore',
  '.dockerignore': 'gitignore',
  '.gitattributes': 'gitattributes',
  '.editorconfig': 'editorconfig',
  '.env': 'dotenv'
}

export function detectFileType(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (TYPE_BY_FILENAME[baseName]) return TYPE_BY_FILENAME[baseName]
  if (baseName.startsWith('.env.')) return 'dotenv'

  const dotIndex = baseName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === baseName.length - 1) return 'text'

  const extension = baseName.slice(dotIndex + 1)
  return TYPE_BY_EXTENSION[extension] ?? extension
}
