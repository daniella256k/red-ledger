import { describe, it, expect } from 'vitest'
import { buildGrepMatcher, buildGlobMatcher, excerptAroundMatch } from '../WorkspaceService'
import { PathJailError } from '../pathJail'

describe('buildGrepMatcher — literal mode', () => {
  it('returns the index of the first occurrence', () => {
    const m = buildGrepMatcher('foo', false, true)
    expect(m('xx foo yy')).toBe(3)
  })

  it('returns -1 when not found', () => {
    const m = buildGrepMatcher('foo', false, true)
    expect(m('no match here')).toBe(-1)
  })

  it('is case-sensitive by default', () => {
    const m = buildGrepMatcher('Foo', false, true)
    expect(m('foo bar')).toBe(-1)
    expect(m('Foo bar')).toBe(0)
  })

  it('is case-insensitive when caseSensitive is false', () => {
    const m = buildGrepMatcher('foo', false, false)
    expect(m('FOO bar')).toBe(0)
    expect(m('Hello FoO')).toBe(6)
  })

  it('treats regex metacharacters as literal text in literal mode', () => {
    const m = buildGrepMatcher('a.b', false, true)
    expect(m('axb')).toBe(-1)
    expect(m('a.b is here')).toBe(0)
  })

  it('matches an empty haystack only with a non-empty pattern returning -1', () => {
    const m = buildGrepMatcher('foo', false, true)
    expect(m('')).toBe(-1)
  })
})

describe('buildGrepMatcher — regex mode', () => {
  it('returns the match index for a regex pattern', () => {
    const m = buildGrepMatcher('\\bfoo\\b', true, true)
    expect(m('xx foo yy')).toBe(3)
    expect(m('xxfooyy')).toBe(-1)
  })

  it('honors caseSensitive=false by setting the i flag', () => {
    const m = buildGrepMatcher('foo', true, false)
    expect(m('FOO bar')).toBe(0)
  })

  it('throws PathJailError(INVALID_INPUT) for invalid regex', () => {
    expect(() => buildGrepMatcher('(', true, true)).toThrow(PathJailError)
    try {
      buildGrepMatcher('(', true, true)
    } catch (err) {
      expect((err as PathJailError).code).toBe('INVALID_INPUT')
    }
  })

  it('supports character classes and anchors', () => {
    const m = buildGrepMatcher('^[A-Z]+$', true, true)
    expect(m('HELLO')).toBe(0)
    expect(m('Hello')).toBe(-1)
  })
})

describe('buildGlobMatcher', () => {
  it('matches a simple suffix glob anywhere in the path', () => {
    const m = buildGlobMatcher('*.ts')
    expect(m('foo.ts')).toBe(true)
    expect(m('src/foo.ts')).toBe(true)
    expect(m('src/deep/nested/foo.ts')).toBe(true)
    expect(m('foo.tsx')).toBe(false)
    expect(m('foo.js')).toBe(false)
  })

  it('* does not cross directory separators', () => {
    const m = buildGlobMatcher('*.ts')
    // "src/foo.ts" matches via the (^|/) anchor in non-path-aware mode
    expect(m('src/foo.ts')).toBe(true)
    // But once a path-aware glob is supplied, * stops at /
    const scoped = buildGlobMatcher('src/*.ts')
    expect(scoped('src/foo.ts')).toBe(true)
    expect(scoped('src/deep/foo.ts')).toBe(false)
  })

  it('** matches across directory boundaries', () => {
    const m = buildGlobMatcher('**/*.ts')
    expect(m('foo.ts')).toBe(true)
    expect(m('src/foo.ts')).toBe(true)
    expect(m('src/deep/nested/foo.ts')).toBe(true)
    expect(m('foo.js')).toBe(false)
  })

  it('? matches exactly one non-separator character', () => {
    const m = buildGlobMatcher('foo?.ts')
    expect(m('foo1.ts')).toBe(true)
    expect(m('fooA.ts')).toBe(true)
    expect(m('foo.ts')).toBe(false)
    expect(m('foo12.ts')).toBe(false)
    expect(m('foo/.ts')).toBe(false)
  })

  it('escapes regex metacharacters in literal segments', () => {
    const m = buildGlobMatcher('a.b.ts')
    expect(m('a.b.ts')).toBe(true)
    expect(m('axbxts')).toBe(false)
  })

  it('matches path-aware globs against the full relative path', () => {
    const m = buildGlobMatcher('src/utils/*.ts')
    expect(m('src/utils/foo.ts')).toBe(true)
    expect(m('src/utils/foo.tsx')).toBe(false)
    expect(m('utils/foo.ts')).toBe(false)
    expect(m('src/components/utils/foo.ts')).toBe(false)
  })

  it('supports ** with path-aware globs', () => {
    const m = buildGlobMatcher('src/**/*.test.ts')
    expect(m('src/foo.test.ts')).toBe(true)
    expect(m('src/deep/foo.test.ts')).toBe(true)
    expect(m('src/deep/nested/foo.test.ts')).toBe(true)
    expect(m('lib/foo.test.ts')).toBe(false)
  })

  it('treats an empty or whitespace glob as match-all', () => {
    const m1 = buildGlobMatcher('')
    const m2 = buildGlobMatcher('   ')
    expect(m1('anything.ts')).toBe(true)
    expect(m2('anything.ts')).toBe(true)
  })
})

describe('excerptAroundMatch', () => {
  it('returns short lines whole', () => {
    expect(excerptAroundMatch('privacy matters', 0)).toBe('privacy matters')
  })

  it('centers long lines on the match', () => {
    const line = 'a'.repeat(633) + 'privacy and safety' + 'b'.repeat(600)
    const excerpt = excerptAroundMatch(line, 633, 50)

    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).toContain('privacy and safety')
    expect(excerpt.length).toBe(102)
  })

  it('does not add an ellipsis at the line edges', () => {
    const line = 'privacy ' + 'x'.repeat(1000)
    expect(excerptAroundMatch(line, 0, 50).startsWith('privacy')).toBe(true)
  })
})

describe('buildGrepMatcher — inline flags', () => {
  it('accepts a leading (?i) as case-insensitive', () => {
    const match = buildGrepMatcher('(?i)privacy|safety', true, true)
    expect(match('Data PRIVACY policy')).toBe(5)
  })

  it('points to case_sensitive in regex errors', () => {
    expect(() => buildGrepMatcher('a(?i)b', true, true)).toThrow(/case_sensitive: false/)
  })
})
