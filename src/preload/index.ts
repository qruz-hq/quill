import { contextBridge, ipcRenderer } from 'electron'

type Prefs = {
  model: string; languages: string[]
  duckEnabled: boolean; duckLevel: number
  aiEnabled: boolean; aiModel: string; aiMinWords: number; aiDeadlineMs: number; aiFixMishearings: boolean
  sttEngine: 'local' | 'cloud'; sttModel: string
  holdKey: number; toggleShortcut: string; padShortcut: string; noteShortcut: string
}

const api = {
  bar: {
    setMode: (mode: 'idle' | 'expanded' | 'recording') => ipcRenderer.send('bar:mode', mode)
  },
  shortcuts: {
    onFailed: (cb: (a: string[]) => void) => sub('shortcuts:failed', cb)
  },
  updates: {
    check: (): Promise<{ current: string; latest?: string; url?: string; newer: boolean }> =>
      ipcRenderer.invoke('updates:check'),
    prompt: () => ipcRenderer.invoke('updates:prompt')
  },
  system: {
    user: (): Promise<{ name: string }> => ipcRenderer.invoke('system:user')
  },
  hub: {
    show: () => ipcRenderer.send('hub:show')
  },
  pad: {
    open: () => ipcRenderer.send('pad:open'),
    close: () => ipcRenderer.send('pad:close'),
    expand: () => ipcRenderer.send('pad:expand')
  },
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    create: () => ipcRenderer.invoke('notes:create'),
    update: (id: string, patch: { title?: string; body?: string }) =>
      ipcRenderer.invoke('notes:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('notes:remove', id),
    onChanged: (cb: (n: unknown[]) => void) => sub('notes:changed', cb)
  },
  cleanup: {
    status: (): Promise<{ hasKey: boolean; masked: string | null }> => ipcRenderer.invoke('cleanup:status'),
    setKey: (key: string) => ipcRenderer.invoke('cleanup:setKey', key),
    clearKey: () => ipcRenderer.invoke('cleanup:clearKey'),
    verify: (model: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('cleanup:verify', model),
    models: (): Promise<{ models: string[]; error?: string }> => ipcRenderer.invoke('cleanup:models'),
    onError: (cb: (note: string) => void) => sub('cleanup:error', cb)
  },
  dictations: {
    list: () => ipcRenderer.invoke('dictations:list'),
    insights: () => ipcRenderer.invoke('dictations:insights'),
    remove: (id: string) => ipcRenderer.invoke('dictations:remove', id),
    onAdded: (cb: (d: unknown) => void) => sub('dictations:added', cb)
  },
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    save: (patch: unknown) => ipcRenderer.invoke('snippets:save', patch),
    remove: (id: string) => ipcRenderer.invoke('snippets:remove', id)
  },
  transforms: {
    list: () => ipcRenderer.invoke('transforms:list'),
    save: (patch: unknown) => ipcRenderer.invoke('transforms:save', patch),
    remove: (id: string) => ipcRenderer.invoke('transforms:remove', id),
    preview: (id: string, sample: string) => ipcRenderer.invoke('transforms:preview', id, sample)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    download: (id: string) => ipcRenderer.invoke('models:download', id),
    cancel: (id: string) => ipcRenderer.invoke('models:cancel', id),
    remove: (id: string) => ipcRenderer.invoke('models:remove', id),
    onProgress: (cb: (p: { id: string; received: number; total: number }) => void) =>
      sub('models:progress', cb),
    onDone: (cb: (d: { id: string }) => void) => sub('models:done', cb),
    onList: (cb: (l: unknown[]) => void) => sub('models:list', cb),
    onError: (cb: (e: { id: string; message: string }) => void) => sub('models:error', cb)
  },
  settings: {
    get: (): Promise<Prefs> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Prefs>): Promise<Prefs> =>
      ipcRenderer.invoke('settings:set', patch)
  },
  dictation: {
    start: () => ipcRenderer.invoke('dictation:start'),
    stop: (): Promise<string> => ipcRenderer.invoke('dictation:stop'),
    cancel: () => ipcRenderer.invoke('dictation:cancel'),
    startVoiceNote: () => ipcRenderer.invoke('voicenote:start'),
    onPartial: (cb: (t: string) => void) => sub('dictation:partial', cb),
    onFinal: (cb: (t: string) => void) => sub('dictation:final', cb),
    onLevel: (cb: (v: number) => void) => sub('dictation:level', cb),
    onError: (cb: (m: string) => void) => sub('dictation:error', cb),
    onToggle: (cb: () => void) => sub('dictation:toggle', cb),
    onState: (cb: (s: 'recording' | 'idle') => void) => sub('dictation:state', cb),
    onStage: (cb: (s: 'transcribing' | 'polishing' | 'idle') => void) => sub('dictation:stage', cb)
  }
}

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('flow', api)
export type FlowApi = typeof api
