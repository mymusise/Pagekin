import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
  },
}))

import { closeProjectDatabase } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { DraftRepository } from '../../repositories/draft-repository'
import { FinalizationRepository } from '../../repositories/finalization-repository'
import { reopenWithContent } from '../../../test/helpers/reopened-draft'
import { projectAccess } from '../../services/project-access'
import { registerDatabaseController } from '../db-controller'

let parentDirectory = ''
let session = { projectId: '', leaseId: '', projectPath: '' }

beforeAll(() => registerDatabaseController())

beforeEach(() => {
  parentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-db-read-only-'))
  const lease = projectAccess.beginSession(projectAccess.createProject(parentDirectory, 'novel'))
  session = { projectId: lease.projectId, leaseId: lease.leaseId, projectPath: lease.rootPath }
  initProjectDatabase(lease.rootPath)
})

afterEach(() => {
  closeProjectDatabase()
  projectAccess.invalidateCurrentSession()
  fs.rmSync(parentDirectory, { recursive: true, force: true })
})

function finalizedDraft(content: string): number {
  const draftId = DraftRepository.getFinalizedByChapter(1)
    ? reopenWithContent(1, content)
    : DraftRepository.create({ chapterNumber: 1, source: 'write', content, wordCount: content.length })
  FinalizationRepository.commit({
    finalizationId: randomUUID(),
    draftId,
    chapterNumber: 1,
    chapterTitle: '雾钟',
    content,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    contentRevision: 1,
    targetFileName: `第1章 雾钟 ${draftId}.txt`,
  })
  return draftId
}

function updateContent(draftId: number, content: string) {
  return handlers.get('db:draft-update-content')!({}, draftId, content, content.length, session.projectPath, session)
}

describe('db:draft-update-content 对带定稿收据的稿', () => {
  it('定稿与被替换的旧定稿都返回只读拒绝，正文不变', async () => {
    const replaced = finalizedDraft('第一章旧定稿。')
    const current = finalizedDraft('第一章新定稿。')

    for (const draftId of [current, replaced]) {
      await expect(updateContent(draftId, '覆盖')).resolves.toEqual({
        success: false,
        error: 'Error: DRAFT_FINALIZED_READ_ONLY',
      })
    }
    expect([DraftRepository.getFull(replaced)?.content, DraftRepository.getFull(current)?.content])
      .toEqual(['第一章旧定稿。', '第一章新定稿。'])
  })

  it('工作稿照常保存', async () => {
    const draftId = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '初稿', wordCount: 2 })

    await expect(updateContent(draftId, '改稿')).resolves.toEqual({ success: true })
    expect(DraftRepository.getFull(draftId)?.content).toBe('改稿')
  })
})

describe('数据库控制器注册的通道', () => {
  it('不再提供无人调用的全局角色状态快照读写通道', () => {
    expect(handlers.has('db:draft-update-content')).toBe(true)
    expect(handlers.has('db:save-summary-snapshot')).toBe(false)
    expect(handlers.has('db:get-latest-summary')).toBe(false)
  })
})

describe('批注历史', () => {
  it('按章节保存并读取修改前后快照及意见，其他章节不可见', async () => {
    const first = DraftRepository.create({ chapterNumber: 3, source: 'write', content: '春雨落下', wordCount: 4 })
    const next = DraftRepository.create({ chapterNumber: 3, source: 'rewrite', content: '春雨落下', wordCount: 4 })
    const other = DraftRepository.create({ chapterNumber: 4, source: 'write', content: '另一章', wordCount: 3 })
    const entry = { draftId: first, before: '春雨落下', after: '秋雨落下', annotations: [{ id: 'note-1', from: 0, to: 1, selectedText: '春', instruction: '改成秋天' }] }
    await expect(handlers.get('db:annotation-history-record')!({}, entry, session.projectPath, session)).resolves.toEqual({ success: true })
    const rows = await handlers.get('db:annotation-history-list')!({}, next, session.projectPath, session) as unknown[]
    expect(rows).toEqual([expect.objectContaining(entry)])
    await expect(handlers.get('db:annotation-history-list')!({}, other, session.projectPath, session)).resolves.toEqual([])
    expect(DraftRepository.getFull(first)?.content).toBe('春雨落下')
  })

  it('拒绝与原文不符的批注和已定稿的写入', async () => {
    const draft = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '春雨', wordCount: 2 })
    const invalid = { draftId: draft, before: '春雨', after: '秋雨', annotations: [{ id: 'n', from: 0, to: 1, selectedText: '夏', instruction: '改成秋' }] }
    await expect(handlers.get('db:annotation-history-record')!({}, invalid, session.projectPath, session)).resolves.toMatchObject({ success: false })
    const final = finalizedDraft('已定稿')
    await expect(handlers.get('db:annotation-history-record')!({}, { ...invalid, draftId: final, annotations: [] }, session.projectPath, session)).resolves.toMatchObject({ success: false })
    await expect(handlers.get('db:annotation-history-list')!({}, draft, session.projectPath, session)).resolves.toEqual([])
  })
})
