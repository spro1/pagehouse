// Live co-editing. Everyone with a page open joins its room over a WebSocket (the y-websocket protocol);
// edits merge as Yjs updates, so two people typing at once never conflict. The server keeps one Y.Doc per open
// page, seeded from the database, and saves it back (with history) a moment after the last edit.
// With several app instances, a relay (cluster.ts) passes each room's updates to the same room on the other instances.
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import * as aw from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { WSContext } from 'hono/ws'

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] }
type Conn = { userId: number; canEdit: boolean; clients: Set<number> }
type Room = {
  doc: Y.Doc; awareness: aw.Awareness; conns: Map<WSContext, Conn>; ready: Promise<void>
  dirty: boolean; editor: number | null; timer?: NodeJS.Timeout; firstDirty: number; saving: Promise<void>
}
export type CollabDeps = {
  load: (pageId: number) => Promise<{ title: string; doc: Json; version: number; ydoc: Buffer | null } | null>
  /** Stores the room's Yjs state. With `claim`, only if none is stored, returning whether it was (first instance wins). */
  storeState: (pageId: number, state: Uint8Array | null, claim?: boolean) => Promise<boolean>
  /** Returns false when the page is gone; the room then stops saving. */
  save: (pageId: number, userId: number, title: string, doc: Json, checkpoint: boolean) => Promise<{ version: number; updatedAt: Date; updatedBy: string } | null>
}

const SYNC = 0
const AWARENESS = 1
const SERVER = 'server' // transaction origin for the server's own changes (seeding, saved-state, REST saves)
const REMOTE = 'remote' // changes relayed from another app instance
export type Relay = {
  publish: (pageId: number, kind: 'u' | 'a', data: Uint8Array) => void
  /** Updates other instances relayed for this page since its state was last claimed. */
  backlog: (pageId: number) => Promise<Uint8Array[]>
}
const QUIET_MS = 1500
const MAX_WAIT_MS = 10_000

// ---------- ProseMirror JSON <-> Y.XmlFragment (the layout y-prosemirror / Tiptap Collaboration use) ----------
function fill(parent: Y.XmlFragment | Y.XmlElement, nodes: Json[] = []) {
  const out: (Y.XmlElement | Y.XmlText)[] = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.type === 'text') {
      // A run of text nodes is one Y.XmlText with formatting attributes for the marks.
      const t = new Y.XmlText()
      const run: [string, Record<string, unknown>][] = []
      for (; i < nodes.length && nodes[i].type === 'text'; i++) {
        const marks: Record<string, unknown> = {}
        for (const m of nodes[i].marks ?? []) marks[m.type in marks ? `${m.type}--${JSON.stringify(m.attrs)}` : m.type] = m.attrs ?? {}
        run.push([nodes[i].text ?? '', marks])
      }
      i--
      t.applyDelta(run.map(([insert, attributes]) => ({ insert, attributes })))
      out.push(t)
    } else {
      const el = new Y.XmlElement(n.type)
      for (const [k, v] of Object.entries(n.attrs ?? {})) if (v !== null && v !== undefined) el.setAttribute(k, v as any)
      fill(el, n.content)
      out.push(el)
    }
  }
  parent.insert(0, out)
}

function read(el: Y.XmlElement | Y.XmlFragment): Json[] {
  const out: Json[] = []
  for (const ch of el.toArray()) {
    if (ch instanceof Y.XmlText) {
      for (const d of ch.toDelta() as { insert: unknown; attributes?: Record<string, any> }[]) {
        if (typeof d.insert !== 'string' || !d.insert) continue
        const marks = Object.entries(d.attributes ?? {}).map(([k, v]) => ({ type: k.split('--')[0], ...(v && Object.keys(v).length ? { attrs: v } : {}) }))
        out.push({ type: 'text', text: d.insert, ...(marks.length ? { marks } : {}) })
      }
    } else if (ch instanceof Y.XmlElement) {
      const attrs = ch.getAttributes()
      const content = read(ch)
      out.push({ type: ch.nodeName, ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}) })
    }
  }
  return out
}

export const docToY = (doc: Y.Doc, json: Json, title: string) => {
  const frag = doc.getXmlFragment('default')
  frag.delete(0, frag.length)
  fill(frag, json.content?.length ? json.content : [{ type: 'paragraph' }])
  const t = doc.getText('title')
  t.delete(0, t.length)
  t.insert(0, title)
}
export const yToDoc = (doc: Y.Doc): Json => {
  const content = read(doc.getXmlFragment('default'))
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

// ---------- rooms ----------
export function createCollab(deps: CollabDeps) {
  const rooms = new Map<number, Room>()
  let relay: Relay | null = null

  const send = (ws: WSContext, m: Uint8Array) => {
    try {
      ws.send(m as Uint8Array<ArrayBuffer>)
    } catch {}
  }
  const broadcast = (room: Room, m: Uint8Array) => room.conns.forEach((_, ws) => send(ws, m))

  function room(pageId: number) {
    let r = rooms.get(pageId)
    if (r) return r
    const doc = new Y.Doc()
    const awareness = new aw.Awareness(doc)
    awareness.setLocalState(null)
    r = { doc, awareness, conns: new Map(), dirty: false, editor: null, firstDirty: 0, saving: Promise.resolve(), ready: Promise.resolve() }
    const rr = r
    rr.ready = (async () => {
      let p = await deps.load(pageId)
      if (!p) return
      // Resume the stored state (cleared whenever the page is saved outside a room); otherwise start a new document
      // identity (epoch), which editors still holding the old one detect and reload instead of merging two copies.
      // Two instances opening the page at once both build one; the first stored wins and the other loads it.
      if (!p.ydoc) {
        const fresh = new Y.Doc()
        fresh.transact(() => (docToY(fresh, p!.doc, p!.title), fresh.getMap('meta').set('epoch', Math.random().toString(36).slice(2))))
        const state = Y.encodeStateAsUpdate(fresh)
        fresh.destroy()
        p = (await deps.storeState(pageId, state, true)) ? { ...p, ydoc: Buffer.from(state) } : await deps.load(pageId)
        if (!p?.ydoc) return
      }
      Y.applyUpdate(doc, new Uint8Array(p.ydoc), SERVER)
      for (const u of (await relay?.backlog(pageId)) ?? []) Y.applyUpdate(doc, u, REMOTE)
    })()
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, SYNC)
      sync.writeUpdate(e, update)
      broadcast(rr, encoding.toUint8Array(e))
      if (origin !== REMOTE) relay?.publish(pageId, 'u', update)
      if (origin === SERVER || origin === REMOTE) return
      rr.editor = rr.conns.get(origin as WSContext)?.userId ?? rr.editor
      if (!rr.dirty) rr.firstDirty = Date.now()
      rr.dirty = true
      clearTimeout(rr.timer)
      // Save shortly after typing stops, and at least every 10 seconds while it doesn't.
      rr.timer = setTimeout(() => persist(pageId, rr), Math.max(0, Math.min(QUIET_MS, rr.firstDirty + MAX_WAIT_MS - Date.now())))
    })
    awareness.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      const conn = r!.conns.get(origin as WSContext)
      if (conn) for (const id of added) conn.clients.add(id)
      if (conn) for (const id of removed) conn.clients.delete(id)
      const e = encoding.createEncoder()
      const a = aw.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])
      encoding.writeVarUint(e, AWARENESS)
      encoding.writeVarUint8Array(e, a)
      broadcast(rr, encoding.toUint8Array(e))
      if (origin !== REMOTE) relay?.publish(pageId, 'a', a)
    })
    rooms.set(pageId, r)
    return r
  }

  function persist(pageId: number, r: Room) {
    clearTimeout(r.timer)
    r.saving = r.saving.then(async () => {
      if (!r.dirty || r.editor === null) return
      r.dirty = false
      const meta = r.doc.getMap('meta')
      const checkpoint = meta.get('checkpoint') === true
      try {
        const state = Y.encodeStateAsUpdate(r.doc)
        const saved = await deps.save(pageId, r.editor, r.doc.getText('title').toString().trim() || 'Untitled', yToDoc(r.doc), checkpoint)
        if (saved) await deps.storeState(pageId, state)
        // Everyone in the room learns the save landed (their local drafts can go) from this shared map.
        if (saved)
          r.doc.transact(() => {
            meta.set('version', saved.version)
            meta.set('updatedAt', saved.updatedAt.toISOString())
            meta.set('updatedBy', saved.updatedBy)
            if (checkpoint) meta.delete('checkpoint')
          }, SERVER)
      } catch (e) {
        // Keep the edits in memory and try again; clients also keep their local drafts until a save lands.
        console.error(`collab: saving page ${pageId} failed`, e)
        r.dirty = true
        r.timer = setTimeout(() => persist(pageId, r), 5000)
      }
    })
    return r.saving
  }

  return {
    /** WebSocket handlers for one connection; access is decided by the caller before upgrading. */
    connect(pageId: number, userId: number, canEdit: boolean, epoch?: string) {
      let r: Room
      let ws: WSContext
      return {
        onOpen(_: Event, w: WSContext) {
          ws = w
          r = room(pageId)
          r.conns.set(ws, { userId, canEdit, clients: new Set() })
          r.ready.then(() => {
            // A reconnecting editor whose copy comes from another document identity must not merge it.
            if (epoch && epoch !== r.doc.getMap('meta').get('epoch')) return ws.close(4409, 'document replaced')
            const e = encoding.createEncoder()
            encoding.writeVarUint(e, SYNC)
            sync.writeSyncStep1(e, r.doc)
            send(ws, encoding.toUint8Array(e))
            const states = [...r.awareness.getStates().keys()]
            if (states.length) {
              const a = encoding.createEncoder()
              encoding.writeVarUint(a, AWARENESS)
              encoding.writeVarUint8Array(a, aw.encodeAwarenessUpdate(r.awareness, states))
              send(ws, encoding.toUint8Array(a))
            }
          })
        },
        onMessage(evt: MessageEvent) {
          const data = evt.data
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null
          if (!bytes) return
          // Queued behind seeding, so nobody syncs against an empty document.
          r.ready.then(() => {
            if (epoch && epoch !== r.doc.getMap('meta').get('epoch')) return
            try {
              const d = decoding.createDecoder(bytes)
              const kind = decoding.readVarUint(d)
              if (kind === SYNC) {
                // Read-only members may ask for the document (step 1) but their changes (step 2, updates) are dropped.
                if (!canEdit && decoding.peekVarUint(d) !== sync.messageYjsSyncStep1) return
                const e = encoding.createEncoder()
                encoding.writeVarUint(e, SYNC)
                sync.readSyncMessage(d, e, r.doc, ws)
                if (encoding.length(e) > 1) send(ws, encoding.toUint8Array(e))
              } else if (kind === AWARENESS) {
                aw.applyAwarenessUpdate(r.awareness, decoding.readVarUint8Array(d), ws)
              }
            } catch {
              ws.close(1003, 'bad message')
            }
          })
        },
        onClose() {
          const conn = r?.conns.get(ws)
          if (!conn) return
          r.conns.delete(ws)
          aw.removeAwarenessStates(r.awareness, [...conn.clients], null)
          if (r.conns.size) return
          // Last one out: save, then drop the room unless someone joined meanwhile.
          void persist(pageId, r).then(() => {
            if (!r.conns.size && rooms.get(pageId) === r) (rooms.delete(pageId), r.doc.destroy())
          })
        },
      }
    },
    /** A save that didn't come through the room (REST, import, MCP): put it into the open room so nobody overwrites it. */
    async replace(pageId: number, json: unknown, title: string) {
      const r = rooms.get(pageId)
      if (r) {
        await r.ready
        r.doc.transact(() => docToY(r.doc, json as Json, title), SERVER)
        r.dirty = false
        clearTimeout(r.timer)
        return void (await deps.storeState(pageId, Y.encodeStateAsUpdate(r.doc)).catch(() => {}))
      }
      // No room here: apply the change to the stored state (plus what other instances relayed since) and relay the
      // difference, so rooms open elsewhere get it as an ordinary edit and the next room starts from it.
      const p = await deps.load(pageId)
      if (!p?.ydoc) return
      const d = new Y.Doc()
      Y.applyUpdate(d, new Uint8Array(p.ydoc))
      for (const u of (await relay?.backlog(pageId)) ?? []) Y.applyUpdate(d, u)
      const before = Y.encodeStateVector(d)
      docToY(d, json as Json, title)
      relay?.publish(pageId, 'u', Y.encodeStateAsUpdate(d, before))
      await deps.storeState(pageId, Y.encodeStateAsUpdate(d)).catch(() => {})
      d.destroy()
    },
    setRelay: (r: Relay | null) => void (relay = r),
    /** An update or awareness change from the same page's room on another instance. */
    receive(pageId: number, kind: 'u' | 'a', data: Uint8Array) {
      const r = rooms.get(pageId)
      if (!r) return
      if (kind === 'u') Y.applyUpdate(r.doc, data, REMOTE)
      else aw.applyAwarenessUpdate(r.awareness, data, REMOTE)
    },
    /** Saves the page's room now, if it has unsaved edits. */
    flush: (pageId: number) => (rooms.has(pageId) ? persist(pageId, rooms.get(pageId)!) : Promise.resolve()),
    /** Saves every open room; used on shutdown. */
    flushAll: () => Promise.all([...rooms].map(([id, r]) => persist(id, r))),
    rooms,
  }
}
