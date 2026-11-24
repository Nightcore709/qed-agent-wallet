/**
 * A screen's choices kept in its address ("/passbook?period=last-month"), so that a link, a reload and the browser's Back
 * keep them. The choice is read when the address changes from outside (a link to the page, Back), and written in place
 * when the choice changes (history.replaceState: no new history entry, no scroll, no move of focus, as navigate would
 * do). What the screen itself wrote is never read back, so a choice made while an earlier one is being written (a fast
 * typist in a search field) is never replaced by the earlier one.
 */
import { type SetStateAction, useEffect, useRef, useState } from 'react'
import { useLocation } from './core.ts'

export function useUrlState<T>(path: string, read: (q: URLSearchParams) => T, write: (v: T) => string): [T, (v: SetStateAction<T>) => void] {
  const { query } = useLocation()
  const search = query.toString()
  const [value, setValue] = useState<T>(() => read(query))
  const written = useRef(search)
  useEffect(() => {
    if (search === written.current) return
    written.current = search
    setValue(read(new URLSearchParams(search)))
    // `read` is the screen's own pure function: only a change of address from outside is acted on here
  }, [search])
  const want = write(value)
  useEffect(() => {
    if (location.pathname !== path || want === written.current) return
    written.current = want
    history.replaceState(history.state, '', `${path}${want ? `?${want}` : ''}${location.hash}`)
  }, [want, path])
  return [value, setValue]
}
