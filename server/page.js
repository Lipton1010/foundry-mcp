// Code that runs in the GM's Foundry tab. The hub sends a function's source text and its arguments as
// JSON data (never as code), so each function must be self-contained: no imports and no references to
// anything outside its own body. They are ordinary functions so the tests can also call them directly.

/** foundry_status. The hub adds the page session it knows from the handshake. */
export function status() {
  return {
    world: game.world.id, worldTitle: game.world.title,
    core: game.version, system: game.system.id, systemTitle: game.system.title, systemVersion: game.system.version,
    user: game.user.name, activeScene: game.scenes.active?.name ?? null, viewedScene: canvas?.scene?.name ?? null,
    viewedLevel: canvas?.level ? { id: canvas.level.id, name: canvas.level.name ?? null } : null,
    counts: { actors: game.actors.size, items: game.items.size, scenes: game.scenes.size, macros: game.macros.size, journal: game.journal.size },
    activeModules: game.modules.filter((m) => m.active).map((m) => m.id + '@' + m.version),
    // "hidden" means the Foundry window is minimized or covered: the browser then throttles timers,
    // and anything that waits on them (workflows, animations, setTimeout) can take a minute or more.
    windowVisibility: globalThis.document?.visibilityState ?? null,
  };
}

/** foundry_documents. Collections are walked directly, so a page of a large one costs no more than the page. */
export function listDocuments(args) {
  const needle = args.name?.toLowerCase();
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 50;
  // Rows stop when the page would be too long for one reply, so nextOffset never skips a row that was not sent.
  const pick = (entries, describe) => {
    let total = 0;
    let room = 60_000;
    const documents = [];
    for (const entry of entries) {
      if (needle !== undefined && !String(entry.name ?? '').toLowerCase().includes(needle)) continue;
      if (total >= offset && documents.length < limit && room > 0) {
        const row = describe(entry);
        room -= JSON.stringify(row).length;
        documents.push(row);
      }
      total += 1;
    }
    const next = offset + documents.length;
    // The cursor comes before the rows: if a row is cut on the way to the hub, the cursor still arrives.
    return { total, ...(next < total ? { nextOffset: next } : {}), documents };
  };
  if (args.pack !== undefined) {
    const pack = game.packs.get(args.pack);
    if (!pack) throw new Error('No compendium "' + args.pack + '". Call foundry_documents without arguments to list them.');
    return {
      pack: pack.collection, documentName: pack.documentName,
      ...pick(pack.index.values(), (e) => ({ id: e._id, name: e.name ?? null, type: e.type ?? null, folder: e.folder ?? null, uuid: e.uuid ?? pack.getUuid(e._id) })),
    };
  }
  // Stored settings are documents too, with their raw values: those go through foundry_settings only.
  const worldTypes = [...game.collections.keys()].filter((name) => name !== 'Setting');
  if (args.type !== undefined) {
    if (args.type === 'Setting') throw new Error('Settings are read with foundry_settings.');
    const collection = game.collections.get(args.type);
    if (!collection) throw new Error('No world collection of "' + args.type + '". This world has: ' + worldTypes.join(', '));
    return { type: args.type, ...pick(collection.values(), (d) => ({ id: d.id, name: d.name ?? null, type: d.type ?? null, folder: d.folder?.id ?? null, uuid: d.uuid })) };
  }
  return {
    collections: Object.fromEntries(worldTypes.map((name) => [name, game.collections.get(name).size])),
    packs: [...game.packs.values()].map((pack) => ({ id: pack.collection, label: pack.metadata?.label ?? null, documentName: pack.documentName, size: pack.index.size })),
  };
}

/** foundry_document. */
export async function readDocument(args) {
  const doc = await fromUuid(args.uuid);
  if (!doc) throw new Error('Nothing found at "' + args.uuid + '".');
  if (doc.documentName === 'Setting') throw new Error('Settings are read with foundry_settings.');
  const about = { uuid: doc.uuid, documentName: doc.documentName };
  const data = doc.toObject();
  if (!args.fields) return { ...about, data };
  const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
  const at = (path) => path.split('.').reduce((value, key) => (own(value, key) ? value[key] : undefined), data);
  return { ...about, fields: Object.fromEntries(args.fields.map((path) => [path, at(path) ?? null])) };
}

/**
 * foundry_settings. A text value under a key named like a credential is withheld: modules keep API keys in
 * settings, and this module keeps its pairing token there. Token and key are also everyday words in Foundry,
 * so only text is withheld (an on/off setting such as "find-my-token" is shown).
 */
export function readSettings(args) {
  const credential = /pass(?:word|wd|code|phrase)|secret|credential|session|patreon|e[-_]?mail|account|licen[cs]e|signature|cloud|(?:^|[-_])user[-_]?id$|authorization|cookie|api[-_]?key|private[-_]?key|(?:token|key)$/i;
  const label = (setting) => (typeof setting.name === 'string' ? game.i18n.localize(setting.name) : null);
  const needle = args.contains?.toLowerCase();
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  // Inside a value: text under a credential-like key is withheld at any depth, and a URL that carries its secret in
  // itself (a webhook, a password in the address, a token in the query) has that part withheld.
  const url = (text) => text
    .replace(/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1[withheld]')
    .replace(/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'?#]+/gi, '$1[withheld]')
    .replace(/(:\/\/[^/@\s:"']*:)[^\s/?#"']+@/g, '$1[withheld]@')
    .replace(/([?&](?:token|access_token|api[-_]?key|key|sig|signature|secret|password|auth|code)=)[^&\s"'#]+/gi, '$1[withheld]');
  const clean = (value, depth, key = '') => {
    if (typeof value === 'string') {
      if (key && credential.test(key) && value) return '[withheld]';
      // JSON encoded as a string more than once is unwrapped and cleaned too; too long to unwrap and holding an escaped
      // key, it is withheld.
      if (/^\s*"/.test(value) && (value.length > 100_000 || depth > 20)) return /\\+"\s*:/.test(value) ? '[withheld: too long to check for credentials]' : value;
      if (/^\s*"/.test(value) && value.length <= 100_000 && depth <= 20) {
        let inner;
        try {
          inner = JSON.parse(value);
        } catch {
          inner = undefined;
        }
        if (typeof inner === 'string') {
          const cleaned = clean(inner, depth + 1);
          return cleaned === inner ? value : JSON.stringify(cleaned);
        }
      }
      // Text holding JSON (a profile stored as a string) is read and cleaned the same way; unreadable such text is withheld.
      if (/^\s*[[{]/.test(value) && /"\s*:/.test(value)) {
        if (value.length > 100_000 || depth > 20) return '[withheld: too long to check for credentials]';
        try {
          return JSON.stringify(clean(JSON.parse(value), depth + 1));
        } catch {
          return '[withheld: not readable as JSON]';
        }
      }
      const plainText = /:\/\//.test(value) ? url(value) : value;
      // An email address is private, wherever a module keeps it (DDB Importer keeps the GM's Patreon email in a setting).
      return plainText.includes('@') ? plainText.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[withheld: email]') : plainText;
    }
    if (!value || typeof value !== 'object' || depth > 20) return value;
    if (typeof value.toObject === 'function') {
      try {
        value = value.toObject(); // a data model: its stored data
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1, key));
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, clean(item, depth + 1, name)]));
  };
  let total = 0;
  let room = 60_000; // rows stop when the page would be too long for one reply; a single huge value is cut inside it
  const settings = [];
  for (const setting of game.settings.settings.values()) {
    if (args.namespace !== undefined && setting.namespace !== args.namespace) continue;
    if (needle !== undefined && !(setting.key + ' ' + (label(setting) ?? '')).toLowerCase().includes(needle)) continue;
    total += 1;
    if (total <= offset || settings.length >= limit || room <= 0) continue;
    try {
      room -= JSON.stringify(game.settings.get(setting.namespace, setting.key) ?? null)?.length ?? 4;
    } catch {
      room -= 100;
    }
    const entry = { namespace: setting.namespace, key: setting.key, scope: setting.scope, name: label(setting) };
    try {
      const value = game.settings.get(setting.namespace, setting.key);
      if (typeof value === 'string' && value && credential.test(setting.key)) settings.push({ ...entry, withheld: 'The key is named like a credential, so its text value is not returned.' });
      else settings.push({ ...entry, value: clean(value, 0) });
    } catch (error) {
      settings.push({ ...entry, unreadable: String(error?.message ?? error) });
    }
  }
  const next = offset + settings.length;
  return { total, ...(next < total ? { nextOffset: next } : {}), settings };
}

/**
 * Change tracking, installed once per page and kept until it reloads: hooks on every document type record
 * each create, update and delete the GM's tab sees, from any user or module. A tracker from an older hub is
 * replaced (its hooks are removed when it kept their ids). Returns the current sequence number, or null when
 * this Foundry has no hooks to track with.
 */
export function installChanges() {
  const KEY = Symbol.for('foundry-mcp.changes');
  const VERSION = 11; // raise whenever this code changes, so a page that already has the tracker gets the new one; and in queryChanges
  const old = globalThis[KEY];
  if (old?.version === VERSION) return { seq: old.seq };
  if (typeof Hooks?.on !== 'function' || !Array.isArray(globalThis.CONST?.ALL_DOCUMENT_TYPES)) return null;
  for (const [name, id] of old?.hookIds ?? []) Hooks.off(name, id);
  // 0.6 kept no hook ids, so its hooks stay until the page reloads. Give them a buffer that keeps nothing.
  if (old && !old.hookIds) old.entries = { length: 0, push() {}, shift() {}, filter: () => [] };
  const LIMIT = 500; // entries kept
  const BYTES = 2_000_000; // and their total size as JSON
  const MAX_PATHS = 100; // paths recorded for one update
  const VALUE_CHARS = 2000;
  const DELETED_CHARS = 20_000;
  const MARK = 'foundryMcpChange'; // option that carries an update from its preUpdate hook to its update hook
  const OP = '__$OPERATOR$__';
  // Sequence numbers continue from an older tracker, so cursors the hub holds stay meaningful.
  const t = globalThis[KEY] = { version: VERSION, seq: old?.seq ?? 0, entries: [], bytes: 0, evicted: 0, since: Date.now(), snapshots: new Map(), hookIds: [] };
  const credential = /pass(?:word|wd|code|phrase)|secret|credential|session|patreon|e[-_]?mail|account|licen[cs]e|signature|cloud|(?:^|[-_])user[-_]?id$|authorization|cookie|salt|api[-_]?key|private[-_]?key|(?:token|key)$/i;
  const ID = /^[A-Za-z0-9]{16}$/;
  const DOC_UUID = /^(?:Compendium\.[\w.-]+\.)?[A-Z][A-Za-z]*\.[A-Za-z0-9]{16}(?:\.[A-Z][A-Za-z]*\.[A-Za-z0-9]{16})*$/;
  const ATTRIBUTE = /^[\w$@-]{1,40}(?:\.[\w$@-]{1,40})+$/;
  // Foundry's own fields named "token" and "key" are kept, but only in the document type and at the exact path where
  // Foundry puts them, and only when they hold what Foundry puts there: a chat message's speaker token id, and an
  // Active Effect change's attribute path. The same names anywhere else (a module's flags, say) are withheld.
  const foundryOwn = (documentName, segments, value) => {
    const path = segments.join('.');
    if (documentName === 'ChatMessage' && path === 'speaker.token') return ID.test(value) || DOC_UUID.test(value);
    if (documentName === 'ActiveEffect' && /^(?:system\.)?changes\.\d+\.key$/.test(path)) return ATTRIBUTE.test(value);
    return false;
  };
  // An item of a list is judged by the list's name (apiKeys: ["..."]).
  const secret = (documentName, segments, value) => {
    if (typeof value !== 'string' || value === '') return false;
    const name = segments.findLast((segment) => !/^\d+$/.test(segment));
    return name !== undefined && credential.test(name) && !foundryOwn(documentName, segments, value);
  };
  // Withholds credential-like text anywhere inside a plain JSON value; `segments` is the full path it is stored at
  // in a document of type `documentName` (null for data that is not a document's own, such as a setting's value).
  const scrub = (value, segments, documentName = null, depth = 0) => {
    if (Array.isArray(value)) return value.map((item, index) => scrub(item, [...segments, String(index)], documentName, depth));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, [...segments, key], documentName, depth)]));
    if (secret(documentName, segments, value)) return '[withheld]';
    // A URL can carry its credential in itself, whatever the field is called: a Discord or Slack webhook, a password
    // in the address, or a token in the query.
    if (typeof value === 'string' && /:\/\//.test(value)) {
      value = value
        .replace(/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1[withheld]') // with or without an API version
        .replace(/(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^\s"'?#]+/gi, '$1[withheld]')
        .replace(/(:\/\/[^/@\s:"']*:)[^\s/?#"']+@/g, '$1[withheld]@')
        .replace(/([?&](?:token|access_token|api[-_]?key|key|sig|signature|secret|password|auth|code)=)[^&\s"'#]+/gi, '$1[withheld]');
    }
    // An email address is private, wherever a module keeps it (DDB Importer keeps the GM's Patreon email in a setting).
    if (typeof value === 'string' && value.includes('@')) value = value.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[withheld: email]');
    // JSON encoded as a string more than once (text that is itself a quoted string) is unwrapped, a few levels deep.
    // Too long to unwrap safely, and holding an escaped key: withheld rather than shown cut down.
    if (typeof value === 'string' && /^\s*"/.test(value) && value.length > 100_000) return /\\+"\s*:/.test(value) ? '[withheld: too long to check for credentials]' : value;
    if (typeof value === 'string' && /^\s*"/.test(value) && value.length <= 100_000) {
      let inner;
      try {
        inner = JSON.parse(value);
      } catch {
        inner = undefined;
      }
      if (typeof inner === 'string') {
        if (depth >= 3) return /[[{]/.test(inner) && /\\?"\s*:/.test(inner) ? '[withheld: nested too deeply to check]' : value;
        const cleaned = scrub(inner, segments, null, depth + 1);
        return cleaned === inner ? value : JSON.stringify(cleaned);
      }
    }
    // Text that holds JSON (a module storing a profile as a string) is read and scrubbed like any object, and given back
    // re-written from what was read (so a repeated key cannot carry an earlier value through). Text that looks like
    // JSON (it opens with a bracket and has a quoted key) but is too long to read safely, or does not parse, is withheld.
    if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      const keyed = /"\s*:/.test(value);
      if (value.length > 100_000) return keyed ? '[withheld: too long to check for credentials]' : value;
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        return keyed ? '[withheld: not readable as JSON]' : value;
      }
      if (parsed && typeof parsed === 'object') return JSON.stringify(scrub(parsed, [], null));
    }
    return value;
  };
  // Plain JSON, with long text and large objects cut so the buffer stays small.
  const cap = (value) => {
    if (typeof value === 'string') return value.length > VALUE_CHARS ? value.slice(0, VALUE_CHARS) + '[Truncated ' + (value.length - VALUE_CHARS) + ' chars]' : value;
    if (value === undefined) return null;
    let json;
    try { json = JSON.stringify(value); } catch { return '[Unserializable]'; }
    if (json === undefined) return null;
    return json.length > VALUE_CHARS ? '[' + (Array.isArray(value) ? 'Array' : 'Object') + ', ' + json.length + ' chars; read the document for it]' : JSON.parse(json);
  };
  const plain = (value) => (value && typeof value === 'object' && typeof value.toJSON === 'function' ? value.toJSON() : value);
  // A change as dot paths, walked without copying it first and stopped after MAX_PATHS. Foundry's deletion
  // operator and the older "-=key" form both read as deleted.
  const paths = (change) => {
    const rows = {};
    let count = 0;
    let more = false;
    const put = (path, row) => {
      if (count >= MAX_PATHS) return void (more = true);
      rows[path] = row;
      count += 1;
    };
    const walk = (value, path, depth) => {
      if (more) return;
      value = plain(value);
      if (value && typeof value === 'object' && !Array.isArray(value) && depth < 30) {
        if (OP in value) return put(path, value[OP] === 'ForcedDeletion' ? { deleted: true } : { value: value.value });
        if (value.constructor?.name === 'ForcedDeletion') return put(path, { deleted: true });
        const keys = Object.keys(value);
        if (!keys.length && path) return put(path, { value: {} });
        for (const key of keys) {
          if (!path && (key === '_id' || key === '_stats')) continue;
          if (key.startsWith('-=')) put((path ? path + '.' : '') + key.slice(2), { deleted: true });
          else if (key.startsWith('==')) put((path ? path + '.' : '') + key.slice(2), { value: plain(value[key]) }); // older replacement syntax
          else walk(value[key], (path ? path + '.' : '') + key, depth + 1);
          if (more) return;
        }
        return;
      }
      put(path, { value });
    };
    try { walk(change ?? {}, '', 0); } catch {}
    return { rows, more };
  };
  const settingKeySecret = (doc) => doc.documentName === 'Setting' && credential.test(String(doc.key ?? '').split('.').at(-1));
  // A setting stores its value as JSON text: credentials inside it are withheld like any others.
  // Text that looks like JSON but does not parse is withheld rather than shown half-read.
  const settingValue = (text) => {
    if (typeof text !== 'string') return text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return JSON.stringify(scrub(parsed, []));
      // A setting whose value is itself text holding JSON is stored encoded twice: read the inner text too.
      if (typeof parsed === 'string') {
        const inner = scrub(parsed, [], null);
        return inner === parsed ? text : JSON.stringify(inner);
      }
      return text;
    } catch {
      return /^\s*[[{]/.test(text) ? '[withheld: not readable as JSON]' : text;
    }
  };
  // A value as reported: cut down, with credential-like text withheld at any depth.
  const clean = (doc, path, value) => {
    if (doc.documentName === 'Setting') {
      if (settingKeySecret(doc)) return '[withheld]';
      if (path === 'key') return cap(value);
      if (path === 'value') return cap(settingValue(value));
    }
    // Scrubbed whole, then cut down: cutting first could turn JSON text into something that no longer parses.
    let plainValue = value;
    try {
      plainValue = value === undefined ? null : JSON.parse(JSON.stringify(value));
    } catch {
      return '[Unserializable]';
    }
    return cap(scrub(plainValue, path.split('.'), doc.documentName));
  };
  const describe = (doc, userId) => ({
    time: new Date().toISOString(), documentName: doc.documentName, uuid: doc.uuid, name: doc.name ?? null,
    parent: doc.parent?.uuid ?? null, user: game.users?.get(userId)?.name ?? userId ?? null, self: userId === game.user?.id,
  });
  const add = (data) => {
    const entry = { seq: ++t.seq, ...data }; // seq first, so it survives if a large entry is cut on the way
    let size = 200;
    try { size = new TextEncoder().encode(JSON.stringify(entry)).length; } catch {} // bytes, not characters
    Object.defineProperty(entry, 'ms', { value: Date.now() }); // for sinceTime; not part of the reply
    Object.defineProperty(entry, 'size', { value: size });
    t.entries.push(entry);
    t.bytes += size;
    while (t.entries.length > LIMIT || (t.bytes > BYTES && t.entries.length > 1)) {
      t.bytes -= t.entries.shift().size;
      t.evicted += 1;
    }
  };
  const on = (name, fn) => t.hookIds.push([name, Hooks.on(name, (...args) => { try { fn(...args); } catch {} })]); // never return false: that would cancel the change
  for (const type of CONST.ALL_DOCUMENT_TYPES) {
    // Earlier values are taken before an update made from this tab is sent, and matched to it by an option that
    // travels with the update to its update hook. An update from elsewhere (another user, another tab) carries no
    // option this tab set, so it gets no earlier values rather than someone else's.
    on('preUpdate' + type, (doc, change, options) => {
      if (!options || typeof options !== 'object') return;
      const mark = (options[MARK] ??= Math.random().toString(36).slice(2) + Date.now().toString(36));
      const before = {};
      // Cleaned now, which also copies them: Foundry changes the source objects in place when the update lands, and a
      // setting's value must be scrubbed before it is cut down.
      for (const path of Object.keys(paths(change).rows)) before[path] = clean(doc, path, foundry.utils.getProperty(doc._source ?? {}, path));
      t.snapshots.set(mark + ' ' + doc.uuid, before);
      // An update another hook cancels never reaches its update hook; its snapshot is dropped eventually.
      for (const key of t.snapshots.keys()) if (t.snapshots.size > 200) t.snapshots.delete(key); else break;
    });
    on('update' + type, (doc, change, options, userId) => {
      const key = options?.[MARK] ? options[MARK] + ' ' + doc.uuid : null;
      const before = key && t.snapshots.get(key);
      if (key) t.snapshots.delete(key);
      const own = userId === game.user?.id ? before : undefined;
      const { rows, more } = paths(change);
      const changed = Object.entries(rows);
      if (!changed.length) return;
      add({ action: 'update', ...describe(doc, userId), changes: changed.map(([path, { value, deleted }]) => {
        const row = { path };
        if (deleted) row.deleted = true;
        else row.value = clean(doc, path, value);
        if (own && Object.hasOwn(own, path)) row.before = own[path];
        return row;
      }), ...(more ? { morePaths: 'Only the first ' + MAX_PATHS + ' changed paths are listed; read the document for the rest.' } : {}) });
    });
    on('create' + type, (doc, options, userId) => add({ action: 'create', ...describe(doc, userId), type: doc.type ?? null }));
    on('delete' + type, (doc, options, userId) => {
      const entry = { action: 'delete', ...describe(doc, userId), type: doc.type ?? null };
      // The deleted data, so the change can be undone by creating it again.
      let data = null;
      try {
        if (settingKeySecret(doc)) data = null;
        else if (doc.documentName === 'Setting') { const raw = doc.toObject(); data = { ...raw, value: settingValue(raw.value) }; }
        else data = scrub(doc.toObject(), [], doc.documentName);
      } catch {}
      const json = data && JSON.stringify(data);
      if (json && json.length <= DELETED_CHARS) entry.data = data;
      else if (json) entry.dataChars = json.length;
      add(entry);
    });
  }
  t.query = (args) => {
    const since = args.since ?? 0;
    const matched = t.entries.filter((entry) =>
      entry.seq > since &&
      (args.before === undefined || entry.seq < args.before) &&
      (args.sinceTime === undefined || entry.ms >= args.sinceTime) &&
      (args.documentName === undefined || entry.documentName === args.documentName) &&
      (args.uuid === undefined || entry.uuid === args.uuid || entry.uuid?.startsWith(args.uuid + '.')));
    // Changes after `since` that the buffer no longer holds: a gap, not a filter.
    const oldest = t.entries[0]?.seq ?? t.seq + 1;
    const upTo = Math.min(oldest - 1, args.before === undefined ? Infinity : args.before - 1);
    const evictedSince = Math.max(0, upTo - since);
    // Whole entries, newest first, up to what one reply can carry; olderBefore leads back to the rest.
    let entries = matched.slice(-(args.limit ?? 50));
    let room = 60_000;
    for (let i = entries.length - 1; i >= 0; i--) {
      room -= entries[i].size;
      if (room < 0 && i < entries.length - 1) {
        entries = entries.slice(i + 1);
        break;
      }
    }
    return {
      trackingSince: new Date(t.since).toISOString(), lastSeq: t.seq, evicted: t.evicted, ...(evictedSince ? { evictedSince } : {}),
      matched: matched.length,
      // The cursor just before the first match, so a later read with since=cursor picks up from there.
      cursor: (matched[0]?.seq ?? t.seq + 1) - 1,
      ...(entries.length < matched.length ? { olderBefore: entries[0].seq } : {}),
      entries,
    };
  };
  return { seq: t.seq };
}

/** foundry_changes and foundry_eval's change list: a query against the installed tracker. */
export function queryChanges(args) {
  const t = globalThis[Symbol.for('foundry-mcp.changes')];
  if (t?.version !== 11) return { installed: false }; // the same number as VERSION in installChanges
  return t.query(args);
}

/**
 * foundry_dice. Replaces the random source behind every die rolled in the GM's tab with a seeded Mersenne
 * Twister, and/or queues exact results. Each of the three functions it replaces gets a new wrapper per
 * installation, which keeps the function that was in place at that moment as its own, fixed predecessor: so a
 * wrapper another module added earlier stays in the chain, and no wrapper of ours can end up calling itself.
 * A wrapper another module adds on top of ours cannot be taken out again; ours then passes rolls through.
 */
export function dice(args) {
  const KEY = Symbol.for('foundry-mcp.dice.v3');
  const MAX_QUEUE = 200;
  const DiceTerm = foundry.dice?.terms?.DiceTerm;
  if (typeof DiceTerm?.prototype?.mapRandomFace !== 'function' || !CONFIG?.Dice) throw new Error('This Foundry version does not expose DiceTerm#mapRandomFace, which dice control needs.');
  const mersenne = CONFIG.Dice.fulfillment?.methods?.mersenne;
  const kept = args.clear ? 0 : (globalThis[KEY]?.queue.length ?? 0);
  if (kept + (args.next?.length ?? 0) > MAX_QUEUE) {
    throw new Error('At most ' + MAX_QUEUE + ' results can be queued, and ' + kept + ' already are. Pass clear: true, or queue fewer.');
  }
  const s = (globalThis[KEY] ??= { seed: null, twister: null, queue: [], forced: 0, current: {}, previous: {} });
  const make = {
    random: (previous) => function (...rest) { return s.twister ? s.twister.random() : previous.apply(this, rest); },
    handler: (previous) => function (term, ...rest) { return s.twister ? term.mapRandomFace(s.twister.random()) : previous.call(this, term, ...rest); },
    // A queued result is used by the first die it fits: right number of faces (if given) and within the die's range.
    mapRandomFace: (previous) => function (...rest) {
      const low = this.minValue ?? 1;
      const index = s.queue.findIndex((entry) => (entry.faces === undefined || entry.faces === this.faces) && entry.result >= low && entry.result <= low + this.faces - 1);
      if (index >= 0) {
        s.forced += 1;
        return s.queue.splice(index, 1)[0].result;
      }
      return previous.apply(this, rest);
    },
  };
  const slots = { random: [CONFIG.Dice, 'randomUniform'], handler: mersenne ? [mersenne, 'handler'] : null, mapRandomFace: [DiceTerm.prototype, 'mapRandomFace'] };
  const top = (name) => slots[name][0][slots[name][1]];
  // Puts a fresh wrapper on top unless ours already is. Other modules' functions are never called to find out
  // whether ours is somewhere below them: a wrapper they added stays in the chain under the new one, and passes
  // rolls through to Foundry's own once control is off. Each wrapper keeps the function it replaced.
  const install = (name) => {
    if (!slots[name] || (s.current[name] && top(name) === s.current[name])) return;
    const previous = top(name);
    s.current[name] = make[name](previous);
    s.previous[name] = previous;
    slots[name][0][slots[name][1]] = s.current[name];
  };
  // Takes ours out if it is on top; if something wrapped it since, it stays and passes rolls through.
  const remove = (name) => {
    if (!slots[name] || !s.current[name] || top(name) !== s.current[name]) return;
    slots[name][0][slots[name][1]] = s.previous[name];
    s.current[name] = null;
  };
  if (args.seed === null && s.seed !== null) {
    s.twister = null;
    s.seed = null;
    remove('random');
    remove('handler');
  } else if (args.seed !== undefined && args.seed !== null) {
    s.twister = new foundry.dice.MersenneTwister(args.seed);
    s.seed = args.seed;
    install('random');
    install('handler');
  }
  if (args.clear) s.queue.length = 0;
  if (args.next?.length) install('mapRandomFace');
  for (const entry of args.next ?? []) s.queue.push(entry.faces === undefined ? { result: entry.result } : { faces: entry.faces, result: entry.result });
  const active = s.seed !== null || s.queue.length > 0;
  const report = { seed: s.seed, queued: [...s.queue], forced: s.forced, active };
  // Only a call that asks for a change tears down; one without arguments just reports. The count starts again next time.
  if (!active && (args.seed !== undefined || args.clear)) {
    for (const name of ['random', 'handler', 'mapRandomFace']) remove(name);
    s.forced = 0;
  }
  return report;
}

/**
 * foundry_update. Previews or applies a change to one document, given as dot paths. A preview validates the change
 * on a copy and returns each path's proposed value and `expected`: a fingerprint of the world, the document, the
 * exact change, and every affected path's current value and whether it exists. Applying requires that fingerprint.
 * Everything an apply relies on (the fingerprint check, the earlier values, the shape of the objects holding each
 * path) is read inside a per-document lock held until Foundry has saved, immediately before the save.
 */
export async function updateDocument(args, signal) {
  const MAX_PREVIEW = 60_000; // characters a preview's fingerprint and proposed values may take, so the reply carries them whole
  const MAX_RECORD = 380_000; // characters the undo record may take; it is the only large field of an apply reply
  const doc = await fromUuid(args.uuid);
  if (!doc) throw new Error('Nothing found at "' + args.uuid + '".');
  if (doc.documentName === 'Setting') throw new Error('Settings are changed with game.settings.set through foundry_eval.');
  const { getProperty, hasProperty, deepClone, setProperty } = foundry.utils;
  // Compared by content, not by the order of keys.
  const canon = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]])) : item));
  const set = args.set ?? {};
  const remove = args.remove ?? [];
  const paths = [...new Set([...Object.keys(set), ...remove])].sort();
  if (!paths.length) throw new Error('Nothing to change: pass `set` and/or `remove`.');
  for (const path of paths) {
    // "-=" and "==" are Foundry's older deletion and replacement syntax: they would act on another path than the one recorded.
    if (path === '_id' || path === '_stats' || path.startsWith('_stats.') || path.split('.').some((key) => !key || key.startsWith('-=') || key.startsWith('==') || key === '__proto__' || key === 'constructor' || key === 'prototype')) {
      throw new Error('"' + path + '" cannot be changed with foundry_update.');
    }
  }
  if (Object.keys(set).some((path) => remove.includes(path))) throw new Error('A path cannot be both set and removed.');
  const ancestors = (path) => {
    const keys = path.split('.');
    return keys.slice(0, -1).map((_, i) => keys.slice(0, i + 1).join('.'));
  };
  for (const path of paths) for (const ancestor of ancestors(path)) if (paths.includes(ancestor)) throw new Error('"' + ancestor + '" and "' + path + '" overlap. Change one or the other.');
  // What holds each path: for every ancestor, whether it is absent, an object, or another value.
  const kind = (path, source = doc._source) => {
    if (!hasProperty(source, path)) return 'absent';
    const value = getProperty(source, path);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? 'object' : 'value';
  };
  const shapeOf = (list, source = doc._source) => Object.fromEntries([...new Set(list.flatMap(ancestors))].map((ancestor) => [ancestor, kind(ancestor, source)]));
  // Saves `data` and returns what Foundry reports this one update changed: the change its update hook receives for
  // this operation, which includes what the game system or a module added while preparing it (dnd5e resets death
  // saves when hit points rise from 0). Saves made by anyone else in the meantime are separate operations, not part of it.
  const saveAndCapture = async (data) => {
    const MARK = 'foundryMcpEdit';
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const hook = 'update' + doc.documentName;
    let changed = null;
    const hookId = Hooks.on(hook, (document, change, options) => {
      if (document === doc && options?.[MARK] === id) changed = change;
    });
    // Other documents under the same owner (the actor or scene this one belongs to, it, and everything embedded in it)
    // that change while this is saved and for a moment after: a system can do that because of the update, sometimes in
    // a later save of its own (dnd5e removes a downed effect on healing, and an Encumbered effect and a favorite when an
    // item's quantity drops). Undo cannot put those back, so they are reported, with the paths an update touched. A
    // save someone else makes to them in that time is reported too, to be safe.
    let top = doc;
    while (top.parent) top = top.parent;
    const family = top.uuid;
    const linked = [];
    // The edited document itself counts too: a system can save it again, separately, because of this edit (dnd5e clears
    // a favorite on the actor after an effect it removed). Only this edit's own save is left out.
    const related = (other) => other && typeof other.uuid === 'string' && (other.uuid === family || other.uuid.startsWith(family + '.'));
    const watchers = (globalThis.CONST?.ALL_DOCUMENT_TYPES ?? []).flatMap((type) => ['create', 'update', 'delete'].map((action) => [action + type, Hooks.on(action + type, (other, change, options) => {
      if (!related(other)) return;
      if (other === doc && action === 'update' && options?.[MARK] === id) return; // this edit's own save
      linked.push({ action, documentName: type, uuid: other.uuid, name: other.name ?? null, ...(action === 'update' ? { paths: changedPaths(change).slice(0, 20) } : {}) });
    })]));
    const SETTLE_MS = globalThis.foundryMcpSettleMs ?? 1000; // how long after the save to keep watching
    try {
      const updated = await doc.update(data, { [MARK]: id });
      // What this save left, read at once: anything saved during the watch below is someone else's, never this edit's.
      const saved = updated ? deepClone(doc._source) : null;
      if (updated) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return { updated, changed, linked, saved };
    } finally {
      Hooks.off(hook, hookId);
      for (const [name, watcher] of watchers) Hooks.off(name, watcher);
    }
  };
  // The dot paths an update's change touched, outermost first where one holds another; _id and _stats left out.
  const changedPaths = (change) => {
    const out = [];
    const walk = (value, path) => {
      if (value && typeof value === 'object' && typeof value.toJSON === 'function') value = value.toJSON();
      const operator = value && typeof value === 'object' && ('__$OPERATOR$__' in value || value.constructor?.name === 'ForcedDeletion' || value.constructor?.name === 'ForcedReplacement');
      if (value && typeof value === 'object' && !Array.isArray(value) && !operator && Object.keys(value).length) {
        for (const [key, item] of Object.entries(value)) {
          if (!path && (key === '_id' || key === '_stats')) continue;
          const name = key.startsWith('-=') || key.startsWith('==') ? key.slice(2) : key;
          if (key.startsWith('-=')) out.push((path ? path + '.' : '') + name);
          else walk(item, (path ? path + '.' : '') + name);
        }
      } else if (path) out.push(path);
    };
    try {
      walk(change ?? {}, '');
    } catch {}
    const sorted = [...new Set(out)].sort();
    return sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(q + '.')));
  };
  // Writing inside a value that is not an object would replace it, and undo could not tell what it was.
  const checkShape = () => {
    for (const path of paths) for (const ancestor of ancestors(path)) if (kind(ancestor) === 'value') throw new Error('"' + ancestor + '" holds a value, not an object, so "' + path + '" cannot be written inside it. Set "' + ancestor + '" itself.');
  };
  checkShape();
  const read = (source, path) => (hasProperty(source, path) ? deepClone(getProperty(source, path)) : null);
  const state = (source) => paths.map((path) => [path, hasProperty(source, path), read(source, path)]);
  // The exact change asked for: each path with its new value, or marked removed.
  const asked = paths.map((path) => (Object.hasOwn(set, path) ? [path, 'set', set[path]] : [path, 'remove']));
  const change = () => {
    const data = {};
    for (const [path, value] of Object.entries(set)) setProperty(data, path, deepClone(value));
    for (const path of remove) setProperty(data, path, new foundry.data.operators.ForcedDeletion());
    return data;
  };
  const about = { uuid: doc.uuid, documentName: doc.documentName, name: doc.name ?? null };
  if (!args.apply) {
    let proposed;
    try {
      const copy = doc.clone({}, { keepId: true });
      copy.updateSource(change());
      proposed = Object.fromEntries(paths.map((path) => [path, read(copy._source, path)]));
    } catch (error) {
      return { ...about, valid: false, error: String(error?.message ?? error) };
    }
    const expected = JSON.stringify({ world: game.world.id, uuid: doc.uuid, change: asked, state: state(doc._source) });
    // Measured as the reply will carry it: the fingerprint as quoted text, and the current values the hub shows beside it.
    const size = JSON.stringify({ expected, proposed, current: state(doc._source) }).length;
    if (size > MAX_PREVIEW) return { ...about, valid: false, error: 'This change is too large for foundry_update (' + size + ' characters with its record). Make it with foundry_eval instead.' };
    const unchanged = paths.filter((path) => canon(state(doc._source).find(([p]) => p === path)[2]) === canon(proposed[path]) && !remove.includes(path));
    return { ...about, valid: true, proposed, expected, ...(unchanged.length ? { unchanged } : {}) };
  }
  if (typeof args.expected !== 'string') throw new Error('Applying needs `expected`, the fingerprint a preview of this same change returned.');
  let shown;
  try {
    shown = JSON.parse(args.expected);
  } catch {
    shown = null;
  }
  if (!Array.isArray(shown?.state) || shown.world !== game.world.id || shown.uuid !== doc.uuid || canon(shown.change) !== canon(asked) || shown.state.length !== paths.length) {
    throw new Error('`expected` is from a preview of a different change, document or world. Preview this change and pass its `expected`.');
  }
  const cancelled = { ...about, applied: false, note: 'The call was given up on before the change was saved, so nothing was changed.' };
  if (signal?.aborted) return cancelled;
  // One edit at a time per document in this tab, held until Foundry has answered, however long the caller waits.
  const LOCKS = Symbol.for('foundry-mcp.edit-locks');
  const locks = (globalThis[LOCKS] ??= new Map());
  const waitFor = locks.get(doc.uuid) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => (release = resolve));
  const chain = waitFor.then(() => mine);
  locks.set(doc.uuid, chain);
  await waitFor;
  try {
    // Everything below is read now, under the lock, just before the save.
    if (signal?.aborted) return cancelled;
    checkShape();
    const now = state(doc._source);
    const conflicts = [];
    now.forEach(([path, exists, value], i) => {
      const [, wasThere, was] = shown.state[i];
      if (exists !== wasThere || canon(value) !== canon(was)) conflicts.push({ path, expected: wasThere ? was : '(absent)', now: exists ? value : '(absent)' });
    });
    if (conflicts.length) return { ...about, applied: false, conflicts, note: 'The document has changed since the preview. Preview again.' };
    const snapshot = deepClone(doc._source);
    // The documents embedded in this one before the save (effects, items...), so undo can say which are gone since:
    // a system can remove one as a result of the edit after the save has returned (dnd5e's downed effect, on healing).
    const embeddedIds = () => Object.fromEntries(Object.entries(doc.collections ?? {}).map(([name, collection]) => [name, [...(collection?.keys?.() ?? [])]]));
    const embedded = embeddedIds();
    const { updated, changed, linked, saved } = await saveAndCapture(change());
    // Foundry resolves to nothing when a hook or the server refused the update.
    if (!updated) return { ...about, applied: false, note: 'Foundry did not save the change: a module hook or the server refused it. Nothing was changed.' };
    // The undo record is made of exactly the paths Foundry reports this one update changed: the leaves an object
    // merge actually set (not the whole object, so a separate save to a sibling is never reverted), anything the game
    // system or a module added while preparing it (dnd5e resets death saves when hit points rise from 0), and any
    // object a module replaced or created whole. If Foundry reported nothing, the requested paths are used.
    const near = (p, q) => p === q || p.startsWith(q + '.') || q.startsWith(p + '.');
    // A key written into what was null or another value (a nullable object being set up) is recorded at that value's
    // path, whole, so undo can put the null back rather than leave an empty object.
    const holderIn = (source, path) => ancestors(path).find((ancestor) => {
      if (!hasProperty(source, ancestor)) return false;
      const value = getProperty(source, ancestor);
      return value === null || typeof value !== 'object' || Array.isArray(value);
    });
    const leaves = changed ? changedPaths(changed) : paths;
    const lifted = [...new Set(leaves.map((path) => holderIn(snapshot, path) ?? path))].sort();
    const recorded = lifted.filter((p) => !lifted.some((q) => q !== p && p.startsWith(q + '.')));
    if (!recorded.length) return { ...about, applied: true, note: 'Foundry saved no difference: the document already held these values. Nothing to undo.' };
    const extra = recorded.filter((p) => !paths.some((q) => near(p, q)));
    const before = Object.fromEntries(recorded.map((path) => [path, read(snapshot, path)]));
    const existed = Object.fromEntries(recorded.map((path) => [path, hasProperty(snapshot, path)]));
    // For a path that did not exist, the outermost part of it that did not exist either (flags.mod for a new
    // flags.mod.note), so undoing can remove what the edit created rather than leave an empty object behind.
    const roots = {};
    for (const path of recorded.filter((p) => !existed[p])) {
      const keys = path.split('.');
      for (let i = 1; i <= keys.length; i++) if (!hasProperty(snapshot, keys.slice(0, i).join('.'))) { roots[path] = keys.slice(0, i).join('.'); break; }
    }
    const after = Object.fromEntries(recorded.map((path) => [path, read(saved, path)]));
    const exists = Object.fromEntries(recorded.map((path) => [path, hasProperty(saved, path)]));
    // A module replaced an object holding one of the paths with a value as this was saved: undo could not write
    // through it, so say so now rather than offer an undo that will refuse.
    const replaced = Object.entries(shapeOf(recorded, saved)).filter(([, kind]) => kind === 'value').map(([path]) => path);
    if (replaced.length) return { ...about, applied: true, ...(extra.length ? { alsoChanged: extra } : {}), undoable: 'As this was saved, something replaced ' + replaced.join(', ') + ' with a value, so this edit cannot be undone with foundry_undo.' };
    // The undo record is the one large field in this reply, so it arrives whole; the hub shows before and after from it.
    const elsewhere = linked.length ? { linkedChanged: linked, linkedNote: 'Foundry also changed these linked documents as this was saved (a system can, as dnd5e removes a downed effect on healing). foundry_undo restores this document only, not them.' } : {};
    const record = JSON.stringify({ paths: recorded, before, existed, after, exists, roots, shape: shapeOf(recorded, saved), linked, embedded });
    const scope = Object.keys(embedded).length ? { undoScope: 'foundry_undo restores the data of this document itself. Documents embedded in it (effects, items) that the system adds or removes because of this edit, now or a moment later, are reported by foundry_undo, not restored.' } : {};
    if (record.length > MAX_RECORD) return { ...about, applied: true, undoable: 'Foundry saved larger values than were asked for (a module may have added to them), too large to keep a record of, so this edit cannot be undone with foundry_undo.' };
    return { ...about, applied: true, ...(extra.length ? { alsoChanged: extra } : {}), ...elsewhere, ...scope, record };
  } finally {
    release();
    if (locks.get(doc.uuid) === chain) locks.delete(doc.uuid);
  }
}

/**
 * foundry_undo: puts back the values from before a foundry_update, if nobody has changed those paths, or the objects
 * holding them, since. Checked and written under the same per-document lock, and verified after saving.
 */
export async function undoUpdate(args, signal) {
  const doc = await fromUuid(args.uuid);
  if (!doc) throw new Error('Nothing found at "' + args.uuid + '"; it may have been deleted.');
  const { getProperty, hasProperty, deepClone, setProperty } = foundry.utils;
  const { ForcedDeletion, ForcedReplacement } = foundry.data.operators;
  const canon = (value) => JSON.stringify(value ?? null, (key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((k) => [k, item[k]])) : item));
  const read = (path) => (hasProperty(doc._source, path) ? deepClone(getProperty(doc._source, path)) : null);
  const kind = (path, source = doc._source) => {
    if (!hasProperty(source, path)) return 'absent';
    const value = getProperty(source, path);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? 'object' : 'value';
  };
  // Saves `data` and returns what Foundry reports this one update changed: the change its update hook receives for
  // this operation, which includes what the game system or a module added while preparing it (dnd5e resets death
  // saves when hit points rise from 0). Saves made by anyone else in the meantime are separate operations, not part of it.
  const saveAndCapture = async (data) => {
    const MARK = 'foundryMcpEdit';
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const hook = 'update' + doc.documentName;
    let changed = null;
    const hookId = Hooks.on(hook, (document, change, options) => {
      if (document === doc && options?.[MARK] === id) changed = change;
    });
    // Other documents under the same owner (the actor or scene this one belongs to, it, and everything embedded in it)
    // that change while this is saved and for a moment after: a system can do that because of the update, sometimes in
    // a later save of its own (dnd5e removes a downed effect on healing, and an Encumbered effect and a favorite when an
    // item's quantity drops). Undo cannot put those back, so they are reported, with the paths an update touched. A
    // save someone else makes to them in that time is reported too, to be safe.
    let top = doc;
    while (top.parent) top = top.parent;
    const family = top.uuid;
    const linked = [];
    // The edited document itself counts too: a system can save it again, separately, because of this edit (dnd5e clears
    // a favorite on the actor after an effect it removed). Only this edit's own save is left out.
    const related = (other) => other && typeof other.uuid === 'string' && (other.uuid === family || other.uuid.startsWith(family + '.'));
    const watchers = (globalThis.CONST?.ALL_DOCUMENT_TYPES ?? []).flatMap((type) => ['create', 'update', 'delete'].map((action) => [action + type, Hooks.on(action + type, (other, change, options) => {
      if (!related(other)) return;
      if (other === doc && action === 'update' && options?.[MARK] === id) return; // this edit's own save
      linked.push({ action, documentName: type, uuid: other.uuid, name: other.name ?? null, ...(action === 'update' ? { paths: changedPaths(change).slice(0, 20) } : {}) });
    })]));
    const SETTLE_MS = globalThis.foundryMcpSettleMs ?? 1000; // how long after the save to keep watching
    try {
      const updated = await doc.update(data, { [MARK]: id });
      // What this save left, read at once: anything saved during the watch below is someone else's, never this edit's.
      const saved = updated ? deepClone(doc._source) : null;
      if (updated) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return { updated, changed, linked, saved };
    } finally {
      Hooks.off(hook, hookId);
      for (const [name, watcher] of watchers) Hooks.off(name, watcher);
    }
  };
  // The dot paths an update's change touched, outermost first where one holds another; _id and _stats left out.
  const changedPaths = (change) => {
    const out = [];
    const walk = (value, path) => {
      if (value && typeof value === 'object' && typeof value.toJSON === 'function') value = value.toJSON();
      const operator = value && typeof value === 'object' && ('__$OPERATOR$__' in value || value.constructor?.name === 'ForcedDeletion' || value.constructor?.name === 'ForcedReplacement');
      if (value && typeof value === 'object' && !Array.isArray(value) && !operator && Object.keys(value).length) {
        for (const [key, item] of Object.entries(value)) {
          if (!path && (key === '_id' || key === '_stats')) continue;
          const name = key.startsWith('-=') || key.startsWith('==') ? key.slice(2) : key;
          if (key.startsWith('-=')) out.push((path ? path + '.' : '') + name);
          else walk(item, (path ? path + '.' : '') + name);
        }
      } else if (path) out.push(path);
    };
    try {
      walk(change ?? {}, '');
    } catch {}
    const sorted = [...new Set(out)].sort();
    return sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(q + '.')));
  };
  const cancelled = { undone: false, note: 'The call was given up on before the undo was saved, so nothing was changed.' };
  if (signal?.aborted) return cancelled;
  const LOCKS = Symbol.for('foundry-mcp.edit-locks');
  const locks = (globalThis[LOCKS] ??= new Map());
  const waitFor = locks.get(doc.uuid) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => (release = resolve));
  const chain = waitFor.then(() => mine);
  locks.set(doc.uuid, chain);
  await waitFor;
  try {
    if (signal?.aborted) return cancelled;
    const conflicts = [];
    for (const path of Object.keys(args.after)) {
      if (hasProperty(doc._source, path) !== args.exists[path] || canon(read(path)) !== canon(args.after[path])) {
        conflicts.push({ path, expected: args.exists[path] ? args.after[path] : '(absent)', now: hasProperty(doc._source, path) ? read(path) : '(absent)' });
      }
    }
    // The objects holding the paths must be as the edit left them, and objects: writing through a value (one a module
    // put there as the edit was saved, say) would replace it, whatever it holds now.
    for (const [ancestor, was] of Object.entries(args.shape ?? {})) {
      const now = kind(ancestor);
      if (now !== was || now === 'value') conflicts.push({ path: ancestor, expected: was === 'value' ? '(an object)' : '(' + was + ')', now: '(' + now + ')' });
    }
    if (conflicts.length) return { undone: false, conflicts, note: 'These paths changed after the update, so nothing was undone.' };
    const data = {};
    const created = {}; // outermost new part -> the new paths inside it
    for (const path of Object.keys(args.before)) {
      if (!args.existed[path]) {
        (created[args.roots?.[path] ?? path] ??= []).push(path);
        continue;
      }
      const value = args.before[path];
      // An object is put back whole: an update would merge it with keys the edit added.
      setProperty(data, path, value && typeof value === 'object' && !Array.isArray(value) ? new ForcedReplacement(value) : value);
    }
    const goes = []; // paths the undo deletes, checked afterwards
    for (const [root, inside] of Object.entries(created)) {
      // The whole new part goes if it holds only what the edit put there; otherwise only the edit's own paths do.
      let made = {};
      for (const path of inside.filter((p) => args.exists[p])) {
        if (path === root) made = args.after[path];
        else setProperty(made, path.slice(root.length + 1), args.after[path]);
      }
      const whole = canon(read(root)) === canon(made);
      const removing = whole ? [root] : [...inside];
      if (!whole) {
        // Something else has been added inside the new part since: keep it, but also remove the objects the edit made
        // that the removals leave empty, so no empty object is left behind.
        const tree = read(root);
        for (const path of inside) {
          const keys = path === root ? [] : path.slice(root.length + 1).split('.');
          const holder = keys.slice(0, -1).reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), tree);
          if (holder && typeof holder === 'object' && keys.length) delete holder[keys.at(-1)];
        }
        // Only the objects on the way from the new part down to the paths the edit created are candidates, deepest first:
        // an empty object someone else put elsewhere inside it is theirs, and stays.
        const candidates = [...new Set(inside.flatMap((path) => {
          const keys = path === root ? [] : path.slice(root.length + 1).split('.');
          return keys.slice(0, -1).map((_, i) => keys.slice(0, i + 1).join('.'));
        }))].sort((x, y) => y.split('.').length - x.split('.').length);
        const at = (relative) => relative.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), tree);
        for (const relative of candidates) {
          const node = at(relative);
          if (node && typeof node === 'object' && !Array.isArray(node) && !Object.keys(node).length) {
            removing.push(root + '.' + relative);
            const keys = relative.split('.');
            const holder = keys.length > 1 ? at(keys.slice(0, -1).join('.')) : tree;
            if (holder && typeof holder === 'object') delete holder[keys.at(-1)];
          }
        }
        if (tree && typeof tree === 'object' && !Array.isArray(tree) && !Object.keys(tree).length) removing.push(root);
      }
      for (const path of removing) {
        setProperty(data, path, new ForcedDeletion());
        goes.push(path);
      }
    }
    const { updated, changed, linked, saved } = await saveAndCapture(data);
    if (!updated) return { undone: false, note: 'Foundry did not save the undo: a module hook or the server refused it. Nothing was changed.' };
    // Anything else the system or a module changed as part of this undo is reported; it is not undone in turn.
    const mine = Object.keys(args.before);
    const alsoChanged = changedPaths(changed).filter((p) => !mine.some((q) => p === q || p.startsWith(q + '.') || q.startsWith(p + '.')));
    // Checked, not assumed: a hook may have changed what was saved.
    const differs = [
      // Read from what this save left, not from later saves made during the watch.
      ...Object.keys(args.before).filter((path) => args.existed[path] && (!hasProperty(saved, path) || canon(getProperty(saved, path)) !== canon(args.before[path]))),
      ...goes.filter((path) => hasProperty(saved, path)),
    ];
    return {
      undone: differs.length === 0, uuid: doc.uuid, restored: Object.fromEntries(Object.keys(args.before).map((path) => [path, hasProperty(saved, path) ? deepClone(getProperty(saved, path)) : null])),
      ...(differs.length ? { notRestored: differs, note: 'Foundry saved something other than the earlier state for these paths, so the edit is kept as not undone.' } : {}),
      ...(alsoChanged.length ? { alsoChanged } : {}),
      // What the edit changed in linked documents is not put back; say so every time, not only when the edit was made.
      ...(args.linked?.length ? { notRestoredElsewhere: args.linked, linkedNote: 'The edit also changed these linked documents, which undo does not restore.' } : {}),
      // Embedded documents that were there before the edit and are gone now, however late they went: not restored.
      ...(() => {
        const missing = Object.entries(args.embedded ?? {}).flatMap(([name, ids]) => ids.filter((id) => !doc.collections?.[name]?.has?.(id)).map((id) => doc.uuid + '.' + (doc.collections?.[name]?.documentClass?.documentName ?? name) + '.' + id));
        const added = Object.entries(doc.collections ?? {}).flatMap(([name, collection]) => [...(collection?.keys?.() ?? [])].filter((id) => !(args.embedded?.[name] ?? []).includes(id)).map((id) => doc.uuid + '.' + (collection?.documentClass?.documentName ?? name) + '.' + id));
        return {
          ...(missing.length ? { missingSinceEdit: missing, missingNote: 'These embedded documents existed before the edit and are gone now (the system may have removed them because of it). Undo does not recreate them; foundry_changes has their data if they were deleted while it was tracking.' } : {}),
          ...(added.length && args.embedded ? { addedSinceEdit: added, addedNote: 'These embedded documents were added since the edit (by it or by anyone). Undo does not remove them.' } : {}),
        };
      })(),
      ...(linked.length ? { linkedChanged: linked } : {}),
    };
  } finally {
    release();
    if (locks.get(doc.uuid) === chain) locks.delete(doc.uuid);
  }
}

/**
 * foundry_scene. Read-only answers to common scene questions, gathered in one call:
 * "overview" (the scene, its levels, lighting and vision settings), "vision" (why a token can or cannot see)
 * and "lights" (which lights and light-emitting tokens are on a level).
 */
export async function sceneCheck(args) {
  const scene = args.scene ? await fromUuid(args.scene) : canvas?.scene;
  if (!scene || scene.documentName !== 'Scene') throw new Error(args.scene ? 'No scene at "' + args.scene + '".' : 'No scene is being viewed. Pass `scene` with a scene UUID.');
  const viewed = canvas?.scene === scene;
  const levels = [...(scene.levels ?? [])].map((level) => ({ id: level.id, name: level.name ?? null, elevation: level._source.elevation ?? null }));
  const levelOf = (id) => levels.find((level) => level.id === id) ?? null;
  // Which level a placeable is on: its own `level` field (tokens), its `levels` list (lights and others),
  // or else the level whose elevation range holds its elevation. Foundry decides the last case itself, so it is an estimate.
  const onLevel = (source, levelId) => {
    if (!levelId || !levels.length) return true;
    if (typeof source.level === 'string' && source.level) return source.level === levelId;
    if (Array.isArray(source.levels) && source.levels.length) return source.levels.includes(levelId);
    const range = levelOf(levelId)?.elevation;
    const elevation = source.elevation ?? 0;
    return !range || (elevation >= (range.bottom ?? -Infinity) && elevation < (range.top ?? Infinity));
  };
  const env = scene._source.environment ?? {};
  const darkness = viewed ? canvas.environment?.darknessLevel ?? env.darknessLevel ?? 0 : env.darknessLevel ?? 0;
  const global = env.globalLight ?? {};
  const globalLit = Boolean(global.enabled) && darkness >= (global.darkness?.min ?? 0) && darkness <= (global.darkness?.max ?? 1);
  const lighting = {
    darknessLevel: darkness, darknessLock: env.darknessLock ?? env.darknessLevelLock ?? null,
    globalLight: { enabled: global.enabled ?? null, darknessRange: global.darkness ?? null, litNow: globalLit, bright: global.bright ?? null },
  };
  const about = { scene: { uuid: scene.uuid, name: scene.name, active: scene.active, viewed }, viewedLevel: viewed && canvas.level ? { id: canvas.level.id, name: canvas.level.name ?? null } : null };
  const grid = { size: scene.grid?.size ?? null, distance: scene.grid?.distance ?? null, units: scene.grid?.units ?? null };
  const pixelsPerUnit = (grid.size ?? 100) / (grid.distance || 1);
  const light = (doc, kind) => {
    const config = kind === 'token' ? doc._source.light : doc._source.config;
    return {
      kind, uuid: doc.uuid, name: doc.name ?? null, x: doc._source.x, y: doc._source.y, elevation: doc._source.elevation ?? 0,
      level: doc._source.level ?? null, levels: doc._source.levels ?? null, hidden: doc._source.hidden ?? false,
      bright: config?.bright ?? 0, dim: config?.dim ?? 0, angle: config?.angle ?? 360, color: config?.color ?? null,
      negative: config?.negative ?? false, animation: config?.animation?.type ?? null, darknessRange: config?.darkness ?? null,
      litNow: !(doc._source.hidden ?? false) && darkness >= (config?.darkness?.min ?? 0) && darkness <= (config?.darkness?.max ?? 1),
    };
  };
  const lightsOn = (levelId) => [
    ...scene.lights.filter((doc) => onLevel(doc._source, levelId)).map((doc) => light(doc, 'light')),
    ...scene.tokens.filter((doc) => (doc._source.light?.dim || doc._source.light?.bright) && onLevel(doc._source, levelId)).map((doc) => light(doc, 'token')),
  ];
  const check = args.check ?? 'overview';
  if (check === 'overview') {
    return {
      // Foundry 14 replaced fog.exploration with fog.mode; reading the old name only logs a deprecation warning.
      ...about, grid, tokenVision: scene._source.tokenVision ?? null, fog: scene._source.fog && 'mode' in scene._source.fog ? { mode: scene._source.fog.mode } : { exploration: scene._source.fog?.exploration ?? null }, lighting,
      levels: levels.map((level) => ({
        ...level,
        tokens: scene.tokens.filter((doc) => onLevel(doc._source, level.id)).length,
        lights: scene.lights.filter((doc) => onLevel(doc._source, level.id)).length,
      })),
      counts: { tokens: scene.tokens.size, lights: scene.lights.size, walls: scene.walls.size, regions: scene.regions?.size ?? null, tiles: scene.tiles.size },
    };
  }
  if (check === 'lights') {
    const levelId = args.level ?? (viewed ? canvas.level?.id : undefined) ?? levels[0]?.id;
    const list = lightsOn(levelId);
    return { ...about, level: levelOf(levelId), lighting, total: list.length, lights: list.slice(0, args.limit ?? 100) };
  }
  if (check === 'vision') {
    if (!args.token) throw new Error('Pass `token`: a token UUID, or the name of a token on this scene.');
    const token = args.token.includes('.') ? await fromUuid(args.token) : scene.tokens.find((doc) => doc.name === args.token);
    if (!token || token.documentName !== 'Token' || token.parent !== scene) throw new Error('No token "' + args.token + '" on this scene.');
    const sight = token._source.sight ?? {};
    const actor = token.actor;
    const levelId = token._source.level || undefined;
    const notes = [];
    if (!scene._source.tokenVision) notes.push('The scene has token vision off, so nothing is hidden by vision at all.');
    if (!sight.enabled) notes.push('The token has vision disabled (sight.enabled is false), so it cannot see on its own.');
    if (sight.enabled && !sight.range && !globalLit) notes.push('Sight range is 0 and global light is not lit, so the token only sees inside light sources.');
    if (sight.enabled && (sight.angle ?? 360) < 360) notes.push('Sight is limited to a ' + sight.angle + '-degree cone.');
    if (viewed && levelId && canvas.level && canvas.level.id !== levelId) notes.push('The token is on another level than the one being viewed.');
    if (token._source.hidden) notes.push('The token is hidden, so players do not see it.');
    if (!globalLit && darkness > 0.5 && sight.visionMode === 'basic') notes.push('The scene is dark, global light is not lit, and the vision mode is basic (no darkvision).');
    const darkvision = Number(actor?.system?.attributes?.senses?.ranges?.darkvision ?? actor?.system?.attributes?.senses?.darkvision ?? 0);
    if (darkvision > 0 && sight.visionMode === 'basic') notes.push('The actor has darkvision (' + darkvision + ') but the token\'s vision mode is basic, so the token does not use it.');
    const players = actor ? [...(game.users ?? [])].filter((user) => !user.isGM && actor.testUserPermission?.(user, 'OWNER')).map((user) => user.name) : [];
    if (actor && !players.length) notes.push('No player owns this token\'s actor, so no player sees through it.');
    const placeable = viewed ? token.object : null;
    const position = { x: token._source.x + (token._source.width ?? 1) * (grid.size ?? 100) / 2, y: token._source.y + (token._source.height ?? 1) * (grid.size ?? 100) / 2 };
    const nearby = lightsOn(levelId)
      .filter((entry) => entry.uuid !== token.uuid)
      .map((entry) => ({ ...entry, distance: Math.round(Math.hypot(entry.x - position.x, entry.y - position.y) / pixelsPerUnit * 10) / 10 }))
      .filter((entry) => entry.distance <= Math.max(entry.dim, entry.bright))
      .slice(0, 20);
    if (!nearby.some((entry) => entry.litNow && !entry.negative) && !globalLit && darkness > 0.5) notes.push('No light source reaches the token and the scene is dark.');
    return {
      ...about, lighting, tokenVision: scene._source.tokenVision ?? null,
      token: {
        uuid: token.uuid, name: token.name, level: levelOf(levelId) ?? levelId ?? null, elevation: token._source.elevation ?? 0, hidden: token._source.hidden ?? false,
        sight: { enabled: sight.enabled ?? null, range: sight.range ?? null, angle: sight.angle ?? null, visionMode: sight.visionMode ?? null },
        detectionModes: token._source.detectionModes ?? null,
        senses: actor?.system?.attributes?.senses ?? null,
        ownedByPlayers: players,
        rendered: placeable ? { hasSight: placeable.hasSight ?? null, visionActive: placeable.vision?.active ?? null, visible: placeable.visible ?? null } : null,
      },
      lightsReachingToken: nearby,
      notes: notes.length ? notes : ['Nothing obvious stops this token from seeing. Check walls between it and what it should see.'],
    };
  }
  throw new Error('Unknown check "' + check + '". Use "overview", "vision" or "lights".');
}

/** foundry_screenshot: the canvas as the GM sees it now, scaled down to fit and encoded as JPEG. */
export async function screenshot(args) {
  if (!canvas?.ready || !canvas.app?.renderer?.extract) throw new Error('The canvas is not ready (no scene is being viewed).');
  const renderer = canvas.app.renderer;
  const frame = new PIXI.Rectangle(0, 0, renderer.screen.width, renderer.screen.height);
  const source = renderer.extract.canvas(canvas.app.stage, frame);
  let width = Math.min(args.maxWidth ?? 1024, source.width);
  let quality = args.quality ?? 0.7;
  for (let tries = 0; ; tries++) {
    const scale = width / source.width;
    const out = document.createElement('canvas');
    out.width = Math.round(source.width * scale);
    out.height = Math.round(source.height * scale);
    out.getContext('2d').drawImage(source, 0, 0, out.width, out.height);
    const url = out.toDataURL('image/jpeg', quality);
    const data = url.slice(url.indexOf(',') + 1);
    // Kept well inside what one reply from the tab can carry.
    if (data.length <= 350_000 || tries >= 5) {
      return {
        scene: canvas.scene?.name ?? null, level: canvas.level ? { id: canvas.level.id, name: canvas.level.name ?? null } : null,
        width: out.width, height: out.height, quality,
        view: { x: Math.round(canvas.stage.pivot.x), y: Math.round(canvas.stage.pivot.y), scale: Math.round(canvas.stage.scale.x * 1000) / 1000 },
        windowVisibility: document.visibilityState, mimeType: 'image/jpeg', data,
      };
    }
    width = Math.round(width * 0.75);
    quality = Math.max(0.4, quality - 0.1);
  }
}
