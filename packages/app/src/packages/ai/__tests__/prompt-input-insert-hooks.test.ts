import { describe, it, expect, vi } from 'vitest'
import { createInsertHashFile } from '../prompt-input-insert-hooks'

function makeContext(initialText: string, hashAt: number) {
  let text = initialText
  const setText = vi.fn((next: string) => { text = next })
  const onHashClose = vi.fn()
  const hashStartRef = { current: hashAt as number | null }
  const textareaRef = { current: null as HTMLDivElement | null }
  return {
    ctx: {
      text: () => text,
      setText,
      onHashClose,
      hashStartRef,
      textareaRef,
    },
    spies: { setText, onHashClose, hashStartRef },
  }
}

describe('createInsertHashFile', () => {
  it('replaces #query with @{path} and clears hashStartRef', () => {
    const initial = 'Hello #foo'
    const { ctx, spies } = makeContext(initial, 6)
    const insert = createInsertHashFile({
      get text() { return ctx.text() },
      setText: ctx.setText,
      onHashClose: ctx.onHashClose,
      textareaRef: ctx.textareaRef,
      hashStartRef: ctx.hashStartRef,
    } as any)
    insert('src/main.ts')
    expect(spies.setText).toHaveBeenCalledWith('Hello @{src/main.ts} ')
    expect(spies.hashStartRef.current).toBeNull()
    expect(spies.onHashClose).toHaveBeenCalledTimes(1)
  })
})
