// Unit tests of the catalog's visibility layer: the advertised set is kept
// intact, the provider allowlist narrows it, and two narrowing levels
// intersect instead of replacing one another.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelCatalog, intersectVisible, isListedModel } from '../lib/catalog.js'

const cacheIn = () => join(mkdtempSync(join(tmpdir(), 'agy-catalog-')), 'catalog.json')

const modelOption = (ids) => ({
  id: 'model',
  category: 'model',
  currentValue: ids[0],
  options: ids.map(id => ({ value: id, name: id.toUpperCase() })),
})

test('an empty allowlist offers every advertised family', () => {
  const catalog = new ModelCatalog(cacheIn())
  catalog.observe([modelOption(['gemini-4-argon', 'claude-opus-5-5'])])
  assert.deepEqual(catalog.list().map(m => m.id), ['gemini-4-argon', 'claude-opus-5-5'])
  assert.deepEqual(catalog.availableModels().map(m => [m.id, m.enabled]), [
    ['gemini-4-argon', true],
    ['claude-opus-5-5', true],
  ])
})

test('an allowlist narrows the offered list and keeps the rest available', () => {
  const catalog = new ModelCatalog(cacheIn())
  catalog.observe([modelOption(['gemini-4-argon', 'claude-opus-5-5', 'gemini-3.8-flash'])])
  catalog.applyVisibility(['claude-opus-5-5'])
  assert.deepEqual(catalog.list().map(m => m.id), ['claude-opus-5-5'])
  assert.deepEqual(catalog.availableModels().map(m => [m.id, m.enabled]), [
    ['gemini-4-argon', false],
    ['claude-opus-5-5', true],
    ['gemini-3.8-flash', false],
  ])
})

test('widening the allowlist restores families without a new observation', () => {
  const catalog = new ModelCatalog(cacheIn())
  catalog.observe([modelOption(['gemini-4-argon', 'claude-opus-5-5'])], undefined, ['gemini-4-argon'])
  assert.deepEqual(catalog.list().map(m => m.id), ['gemini-4-argon'])
  catalog.applyVisibility([])
  assert.deepEqual(catalog.list().map(m => m.id), ['gemini-4-argon', 'claude-opus-5-5'])
})

test('every advertised family including Sonnet and GPT-OSS appears in availableModels and obeys the allowlist', () => {
  const catalog = new ModelCatalog(cacheIn())
  catalog.observe([modelOption(['gemini-4-argon', 'claude-sonnet-5-5', 'gpt-oss-120b-medium'])], undefined, ['gpt-oss-120b-medium'])
  assert.deepEqual(catalog.availableModels().map(m => [m.id, m.enabled]), [
    ['gemini-4-argon', false],
    ['claude-sonnet-5-5', false],
    ['gpt-oss-120b-medium', true],
  ])
  assert.deepEqual(catalog.list().map(m => m.id), ['gpt-oss-120b-medium'])
})

test('the cache stores the advertised set so a later widen survives a restart', () => {
  const path = cacheIn()
  const first = new ModelCatalog(path)
  first.observe([modelOption(['gemini-4-argon', 'claude-opus-5-5'])], undefined, ['gemini-4-argon'])
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(stored.models.map(m => m.id), ['gemini-4-argon', 'claude-opus-5-5'])
  const reopened = new ModelCatalog(path)
  reopened.applyVisibility([])
  assert.deepEqual(reopened.list().map(m => m.id), ['gemini-4-argon', 'claude-opus-5-5'])
})

test('a cache written before the visibility layer still loads', () => {
  const path = cacheIn()
  writeFileSync(path, JSON.stringify({ models: [{ id: 'gemini-4-argon', name: 'Gemini 4 Argon' }], efforts: ['low', 'medium', 'high'] }))
  const catalog = new ModelCatalog(path)
  assert.deepEqual(catalog.list().map(m => m.id), ['gemini-4-argon'])
  catalog.applyVisibility(['gemini-4-argon'])
  assert.deepEqual(catalog.availableModels().map(m => [m.id, m.enabled]), [['gemini-4-argon', true]])
})

test('two narrowing allowlists intersect rather than replace', () => {
  assert.deepEqual(intersectVisible([], []), [])
  assert.deepEqual(intersectVisible(['a', 'b'], []), ['a', 'b'])
  assert.deepEqual(intersectVisible([], ['b', 'c']), ['b', 'c'])
  assert.deepEqual(intersectVisible(['a', 'b', 'c'], ['b', 'c', 'd']), ['b', 'c'])
  assert.deepEqual(intersectVisible(['a'], ['b']), [], 'a disjoint pair serves nothing')
})

test('isListedModel treats an empty list as no restriction', () => {
  assert.equal(isListedModel('anything', []), true)
  assert.equal(isListedModel('a', ['a']), true)
  assert.equal(isListedModel('b', ['a']), false)
})
