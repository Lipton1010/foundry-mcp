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
  const pick = (entries, describe) => {
    let total = 0;
    const documents = [];
    for (const entry of entries) {
      if (needle !== undefined && !String(entry.name ?? '').toLowerCase().includes(needle)) continue;
      if (total >= offset && documents.length < limit) documents.push(describe(entry));
      total += 1;
    }
    const next = offset + documents.length;
    return { total, documents, ...(next < total ? { nextOffset: next } : {}) };
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
  const credential = /pass(?:word|wd)|secret|credential|authorization|cookie|api[-_]?key|private[-_]?key|(?:token|key)$/i;
  const label = (setting) => (typeof setting.name === 'string' ? game.i18n.localize(setting.name) : null);
  const needle = args.contains?.toLowerCase();
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  let total = 0;
  const settings = [];
  for (const setting of game.settings.settings.values()) {
    if (args.namespace !== undefined && setting.namespace !== args.namespace) continue;
    if (needle !== undefined && !(setting.key + ' ' + (label(setting) ?? '')).toLowerCase().includes(needle)) continue;
    total += 1;
    if (total <= offset || settings.length >= limit) continue;
    const entry = { namespace: setting.namespace, key: setting.key, scope: setting.scope, name: label(setting) };
    try {
      const value = game.settings.get(setting.namespace, setting.key);
      if (typeof value === 'string' && value && credential.test(setting.key)) settings.push({ ...entry, withheld: 'The key is named like a credential, so its text value is not returned.' });
      else settings.push({ ...entry, value });
    } catch (error) {
      settings.push({ ...entry, unreadable: String(error?.message ?? error) });
    }
  }
  const next = offset + settings.length;
  return { total, settings, ...(next < total ? { nextOffset: next } : {}) };
}

/**
 * Change tracking, installed once per page and kept until it reloads: hooks on every document type record
 * each create, update and delete the GM's tab sees, from any user or module. A tracker from an older hub is
 * replaced (its hooks are removed when it kept their ids). Returns the current sequence number, or null when
 * this Foundry has no hooks to track with.
 */
export function installChanges() {
  const KEY = Symbol.for('foundry-mcp.changes');
  const VERSION = 2;
  const old = globalThis[KEY];
  if (old?.version === VERSION) return { seq: old.seq };
  if (typeof Hooks?.on !== 'function' || !Array.isArray(globalThis.CONST?.ALL_DOCUMENT_TYPES)) return null;
  for (const [name, id] of old?.hookIds ?? []) Hooks.off(name, id);
  const LIMIT = 500; // entries kept
  const BYTES = 2_000_000; // and their total size as JSON
  const MAX_PATHS = 100; // paths recorded for one update
  const VALUE_CHARS = 2000;
  const DELETED_CHARS = 20_000;
  const MARK = 'foundryMcpChange'; // option that carries an update from its preUpdate hook to its update hook
  const OP = '__$OPERATOR$__';
  // Sequence numbers continue from an older tracker, so cursors the hub holds stay meaningful.
  const t = globalThis[KEY] = { version: VERSION, seq: old?.seq ?? 0, entries: [], bytes: 0, evicted: 0, since: Date.now(), snapshots: new Map(), hookIds: [] };
  const credential = /pass(?:word|wd)|secret|credential|authorization|cookie|salt|api[-_]?key|private[-_]?key|(?:token|key)$/i;
  const ID = /^[A-Za-z0-9]{16}$/;
  const DOC_UUID = /^(?:Compendium\.[\w.-]+\.)?[A-Z][A-Za-z]*\.[A-Za-z0-9]{16}(?:\.[A-Z][A-Za-z]*\.[A-Za-z0-9]{16})*$/;
  const ATTRIBUTE = /^[\w$@-]{1,40}(?:\.[\w$@-]{1,40})+$/;
  // Foundry's own fields named "token" and "key" are kept, but only where Foundry puts them and only when they
  // hold what Foundry puts there: a chat speaker's or a target's token id, and an Active Effect change's attribute path.
  const foundryOwn = (segments, value) => {
    const name = segments.at(-1);
    if (name === 'token') return (segments.at(-2) === 'speaker' || segments.includes('targets')) && (ID.test(value) || DOC_UUID.test(value));
    if (name === 'key') return /^\d+$/.test(segments.at(-2) ?? '') && segments.at(-3) === 'changes' && ATTRIBUTE.test(value);
    return false;
  };
  // An item of a list is judged by the list's name (apiKeys: ["..."]).
  const secret = (segments, value) => {
    if (typeof value !== 'string' || value === '') return false;
    const name = segments.findLast((segment) => !/^\d+$/.test(segment));
    return name !== undefined && credential.test(name) && !foundryOwn(segments, value);
  };
  // Withholds credential-like text anywhere inside a plain JSON value; `segments` is the path it is stored at.
  const scrub = (value, segments) => {
    if (Array.isArray(value)) return value.map((item, index) => scrub(item, [...segments, String(index)]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, [...segments, key])]));
    return secret(segments, value) ? '[withheld]' : value;
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
  const settingValue = (text) => {
    if (typeof text !== 'string') return text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return JSON.stringify(scrub(parsed, []));
    } catch {}
    return text;
  };
  // A value as reported: cut down, with credential-like text withheld at any depth.
  const clean = (doc, path, value) => {
    if (doc.documentName === 'Setting') {
      if (settingKeySecret(doc)) return '[withheld]';
      if (path === 'key') return cap(value);
      if (path === 'value') return cap(settingValue(value));
    }
    return scrub(cap(value), path.split('.'));
  };
  const describe = (doc, userId) => ({
    time: new Date().toISOString(), documentName: doc.documentName, uuid: doc.uuid, name: doc.name ?? null,
    parent: doc.parent?.uuid ?? null, user: game.users?.get(userId)?.name ?? userId ?? null, self: userId === game.user?.id,
  });
  const add = (entry) => {
    entry.seq = ++t.seq;
    let size = 200;
    try { size = JSON.stringify(entry).length; } catch {}
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
      for (const path of Object.keys(paths(change).rows)) before[path] = foundry.utils.getProperty(doc._source ?? {}, path);
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
        if (own && Object.hasOwn(own, path)) row.before = clean(doc, path, own[path]);
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
        else data = scrub(doc.toObject(), []);
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
    const entries = matched.slice(-(args.limit ?? 50));
    return {
      trackingSince: new Date(t.since).toISOString(), lastSeq: t.seq, evicted: t.evicted, ...(evictedSince ? { evictedSince } : {}),
      matched: matched.length,
      // The cursor just before the first match, so a later read with since=cursor picks up from there.
      cursor: (matched[0]?.seq ?? t.seq + 1) - 1,
      entries,
      ...(entries.length < matched.length ? { olderBefore: entries[0].seq } : {}),
    };
  };
  return { seq: t.seq };
}

/** foundry_changes and foundry_eval's change list: a query against the installed tracker. */
export function queryChanges(args) {
  const t = globalThis[Symbol.for('foundry-mcp.changes')];
  if (t?.version !== 2) return { installed: false };
  return t.query(args);
}

/**
 * foundry_dice. Replaces the random source behind every die rolled in the GM's tab with a seeded Mersenne
 * Twister, and/or queues exact results. Each of the three functions it wraps is tracked on its own and wraps
 * whatever is in place when it is installed, so a wrapper another module added earlier stays in the chain.
 * A wrapper another module adds on top of ours cannot be taken out again, so ours then passes rolls through.
 */
export function dice(args) {
  const KEY = Symbol.for('foundry-mcp.dice.v2');
  const MAX_QUEUE = 200;
  const DiceTerm = foundry.dice?.terms?.DiceTerm;
  if (typeof DiceTerm?.prototype?.mapRandomFace !== 'function' || !CONFIG?.Dice) throw new Error('This Foundry version does not expose DiceTerm#mapRandomFace, which dice control needs.');
  const mersenne = CONFIG.Dice.fulfillment?.methods?.mersenne;
  const kept = args.clear ? 0 : (globalThis[KEY]?.queue.length ?? 0);
  if (kept + (args.next?.length ?? 0) > MAX_QUEUE) {
    throw new Error('At most ' + MAX_QUEUE + ' results can be queued, and ' + kept + ' already are. Pass clear: true, or queue fewer.');
  }
  let s = globalThis[KEY];
  if (!s) {
    s = globalThis[KEY] = { seed: null, twister: null, queue: [], forced: 0, installed: {}, previous: {} };
    s.wrappers = {
      random: function (...rest) { return s.twister ? s.twister.random() : s.previous.random.apply(this, rest); },
      handler: function (term, ...rest) { return s.twister ? term.mapRandomFace(s.twister.random()) : s.previous.handler.call(this, term, ...rest); },
      // A queued result is used by the first die it fits: right number of faces (if given) and within the die's range.
      mapRandomFace: function (...rest) {
        const low = this.minValue ?? 1;
        const index = s.queue.findIndex((entry) => (entry.faces === undefined || entry.faces === this.faces) && entry.result >= low && entry.result <= low + this.faces - 1);
        if (index >= 0) {
          s.forced += 1;
          return s.queue.splice(index, 1)[0].result;
        }
        return s.previous.mapRandomFace.apply(this, rest);
      },
    };
  }
  const slots = { random: [CONFIG.Dice, 'randomUniform'], handler: mersenne ? [mersenne, 'handler'] : null, mapRandomFace: [DiceTerm.prototype, 'mapRandomFace'] };
  const install = (name) => {
    const slot = slots[name];
    if (!slot || s.installed[name]) return;
    s.previous[name] = slot[0][slot[1]];
    slot[0][slot[1]] = s.wrappers[name];
    s.installed[name] = true;
  };
  const remove = (name) => {
    const slot = slots[name];
    if (!slot || !s.installed[name] || slot[0][slot[1]] !== s.wrappers[name]) return; // wrapped since: ours passes rolls through
    slot[0][slot[1]] = s.previous[name];
    s.installed[name] = false;
  };
  // Is our wrapper still reached from what is installed now? Something may have replaced it outright.
  const reaches = (name) => {
    const slot = slots[name];
    if (!slot || slot[0][slot[1]] === s.wrappers[name]) return true;
    const saved = s.twister;
    let hit = false;
    s.twister = { random: () => ((hit = true), 0.5) };
    try {
      if (name === 'random') CONFIG.Dice.randomUniform();
      else mersenne.handler({ faces: 2, minValue: 1, mapRandomFace: (value) => value });
    } catch {
      // A wrapper that cannot be probed is left alone.
      hit = true;
    } finally {
      s.twister = saved;
    }
    return hit;
  };
  if (args.seed === null && s.seed !== null) {
    s.twister = null;
    s.seed = null;
    remove('random');
    remove('handler');
  } else if (args.seed !== undefined && args.seed !== null) {
    s.twister = new foundry.dice.MersenneTwister(args.seed);
    s.seed = args.seed;
    for (const name of ['random', 'handler']) {
      if (s.installed[name] && !reaches(name)) s.installed[name] = false; // replaced outright: install on top again
      install(name);
    }
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
 * foundry_update. Previews or applies a change to one document, given as dot paths. A preview validates the
 * change on a copy and returns the current and proposed values; applying checks `expected` (usually the current
 * values a preview returned) first, so a change someone else made in between is not overwritten.
 */
export async function updateDocument(args) {
  const doc = await fromUuid(args.uuid);
  if (!doc) throw new Error('Nothing found at "' + args.uuid + '".');
  if (doc.documentName === 'Setting') throw new Error('Settings are changed with game.settings.set through foundry_eval.');
  const { getProperty, hasProperty, deepClone, expandObject } = foundry.utils;
  const set = args.set ?? {};
  const remove = args.remove ?? [];
  const paths = [...new Set([...Object.keys(set), ...remove])];
  if (!paths.length) throw new Error('Nothing to change: pass `set` and/or `remove`.');
  for (const path of paths) if (path === '_id' || path.startsWith('_stats') || path.split('.').some((key) => !key || key.startsWith('-=') || key === '__proto__')) throw new Error('"' + path + '" cannot be changed with foundry_update.');
  const read = (source, path) => (hasProperty(source, path) ? deepClone(getProperty(source, path)) : null);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const current = Object.fromEntries(paths.map((path) => [path, read(doc._source, path)]));
  const existed = Object.fromEntries(paths.map((path) => [path, hasProperty(doc._source, path)]));
  const change = () => {
    const data = expandObject(deepClone(set));
    for (const path of remove) foundry.utils.setProperty(data, path, new foundry.data.operators.ForcedDeletion());
    return data;
  };
  const about = { uuid: doc.uuid, documentName: doc.documentName, name: doc.name ?? null };
  let proposed;
  try {
    const copy = doc.clone({}, { keepId: true });
    copy.updateSource(change());
    proposed = Object.fromEntries(paths.map((path) => [path, read(copy._source, path)]));
  } catch (error) {
    return { ...about, valid: false, error: String(error?.message ?? error), current };
  }
  const unchanged = paths.filter((path) => same(current[path], proposed[path]) && !remove.includes(path));
  if (!args.apply) return { ...about, valid: true, current, proposed, ...(unchanged.length ? { unchanged } : {}) };
  const conflicts = Object.entries(args.expected ?? {})
    .filter(([path, value]) => !same(read(doc._source, path), value))
    .map(([path, value]) => ({ path, expected: value, now: read(doc._source, path) }));
  if (conflicts.length) return { ...about, applied: false, conflicts, note: 'The document no longer has the expected values. Preview again.' };
  // For a path that did not exist, the outermost part of it that did not exist either ("flags.mod" for a new
  // "flags.mod.note"), so undoing can remove what the edit created rather than leave an empty object behind.
  const roots = Object.fromEntries(paths.filter((path) => !existed[path]).map((path) => {
    const keys = path.split('.');
    for (let i = 1; i <= keys.length; i++) if (!hasProperty(doc._source, keys.slice(0, i).join('.'))) return [path, keys.slice(0, i).join('.')];
    return [path, path];
  }));
  await doc.update(change());
  const after = Object.fromEntries(paths.map((path) => [path, read(doc._source, path)]));
  const exists = Object.fromEntries(paths.map((path) => [path, hasProperty(doc._source, path)]));
  return { ...about, applied: true, before: current, existed, after, exists, roots };
}

/** foundry_undo: puts back the values from before a foundry_update, if nobody has changed those paths since. */
export async function undoUpdate(args) {
  const doc = await fromUuid(args.uuid);
  if (!doc) throw new Error('Nothing found at "' + args.uuid + '"; it may have been deleted.');
  const { getProperty, hasProperty, deepClone, setProperty } = foundry.utils;
  const read = (path) => (hasProperty(doc._source, path) ? deepClone(getProperty(doc._source, path)) : null);
  const conflicts = Object.keys(args.after)
    .filter((path) => JSON.stringify(read(path)) !== JSON.stringify(args.after[path] ?? null) || hasProperty(doc._source, path) !== args.exists[path])
    .map((path) => ({ path, expected: args.after[path], now: read(path) }));
  if (conflicts.length) return { undone: false, conflicts, note: 'These paths changed after the update, so nothing was undone.' };
  const data = {};
  const created = {}; // outermost new part -> the new paths inside it
  for (const path of Object.keys(args.before)) {
    if (args.existed[path]) setProperty(data, path, args.before[path]);
    else (created[args.roots?.[path] ?? path] ??= []).push(path);
  }
  for (const [root, inside] of Object.entries(created)) {
    // The whole new part goes if it holds only what the edit put there; otherwise only the edit's own paths do.
    let made = {};
    for (const path of inside) {
      if (path === root) made = args.after[path];
      else setProperty(made, path.slice(root.length + 1), args.after[path]);
    }
    const whole = JSON.stringify(read(root)) === JSON.stringify(made);
    for (const path of whole ? [root] : inside) setProperty(data, path, new foundry.data.operators.ForcedDeletion());
  }
  await doc.update(data);
  return { undone: true, uuid: doc.uuid, restored: Object.fromEntries(Object.keys(args.before).map((path) => [path, read(path)])) };
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
    darknessLevel: darkness, darknessLock: env.darknessLock ?? null,
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
    if (!token || token.documentName !== 'Token') throw new Error('No token "' + args.token + '" on this scene.');
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
