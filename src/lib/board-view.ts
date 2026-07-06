/**
 * The /board page can render as a kanban (default), a flat sortable
 * list, or a monthly calendar keyed on task due date. The user's
 * choice is persisted per browser; nothing here is account-scoped.
 */

export type BoardView = 'kanban' | 'list' | 'calendar'

const STORAGE_KEY = 'team-manager.board-view'

export function loadBoardView(): BoardView {
  if (typeof window === 'undefined') return 'kanban'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'list' || raw === 'calendar') return raw
    return 'kanban'
  } catch {
    return 'kanban'
  }
}

export function saveBoardView(view: BoardView): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, view)
  } catch {
    // private mode / quota — ignore
  }
}
