# Demo: diagnosing a midi-qol warning

This walks an agent through finding and fixing a broken on-use macro, using only throwaway documents. It needs a
test world running **dnd5e** with **midi-qol** active (recorded with dnd5e 6.0.6 and midi-qol 14.6.11 on Foundry
14.370). Everything it creates is deleted at the end.

A player reports "my feature does nothing". Nothing appears in chat, because midi-qol reports a failing on-use
macro only as a console warning. The steps below are `foundry_eval` and `foundry_logs` calls; the outputs are from a
real run, with document ids shortened.

## 1. Create the fixtures

```js
const tag = 'MCP demo (temp, safe to delete)';
const macro = await Macro.create({
  name: tag, type: 'script',
  command: "const bonus = 2;\nconst total = actor.system.attributes.prof + bonuss;\nui.notifications.info(`Total ${total}`);",
});
const actor = await Actor.create({ name: tag, type: 'npc', system: { attributes: { hp: { value: 10, max: 10 } } } });
const [item] = await actor.createEmbeddedDocuments('Item', [{
  name: tag, type: 'feat',
  system: { activities: { mcpdemo000000001: { _id: 'mcpdemo000000001', type: 'utility', name: 'Demo', activation: { type: 'action' } } } },
  flags: { 'midi-qol': { onUseMacroName: `[postActiveEffects]Macro.${macro.uuid}` } },
}]);
// Everything is found again by the UUIDs saved here, never by name: an earlier run may have left documents with
// the same name, and cleaning up by name would delete those instead.
const run = { actorUuid: actor.uuid, macroUuid: macro.uuid, itemUuid: item.uuid, messageIds: [] };
// Record the chat messages this run's workflows create, so exactly those are deleted at the end. The hook keeps
// its own run, so a hook left by an earlier, unfinished run cannot add to this one.
run.hook = Hooks.on('createChatMessage', (message) => {
  if (message.speaker?.actor === actor.id) run.messageIds.push(message.id);
});
if (globalThis.mcpDemo?.hook) Hooks.off('createChatMessage', globalThis.mcpDemo.hook);
globalThis.mcpDemo = run;
return 'created';
```

The macro has a typo: `bonuss`.

## 2. Use the feature and wait for the workflow

```js
const item = await fromUuid(mcpDemo.itemUuid);
const workflow = await MidiQOL.completeItemUse(item, {}, { configure: false }, {});
return { state: workflow?.currentAction?.name, aborted: workflow?.aborted };
```

```json
{ "result": { "state": "WorkflowState_Cleanup", "aborted": false }, "logs": [ "..." ], "logSeq": 11 }
```

The workflow reports success. Note the `logSeq`.

## 3. Ask what midi-qol complained about

`foundry_logs` with `{ "since": 11, "package": "midi-qol", "contains": "macro error" }`:

```json
{
  "matched": 1,
  "entries": [{
    "level": "warn", "source": "console", "packages": ["midi-qol"], "fromEval": false,
    "text": "midi-qol | called macro error in MCP demo (temp, safe to delete) Actor.<id>.Item.<id> macro Macro.Macro.<id> ReferenceError: bonuss is not defined",
    "stack": [
      "at Macro.eval (eval at #executeScript (/scripts/foundry.mjs:53389:16), <anonymous>:4:46)",
      "at #executeScript (/scripts/foundry.mjs:53394:17)",
      "at Macro.execute (/scripts/foundry.mjs:53336:35)",
      "at Workflow.executeMacroWithScope (/modules/midi-qol/midi-qol.js:34649:22)",
      "at Workflow.callMacro (/modules/midi-qol/midi-qol.js:34693:23)",
      "at async Promise.allSettled (index 0)",
      "at async Workflow.callMacros (/modules/midi-qol/midi-qol.js:34510:23)",
      "at async Workflow.WorkflowState_RollFinished (/modules/midi-qol/midi-qol.js:33555:13)"
    ]
  }]
}
```

What this tells the agent:

- It is a **warning**, not an error. A filter of `level: "error"` would have hidden it.
- `packages: ["midi-qol"]` and `fromEval: false` mean midi-qol's own workflow raised it, not the agent's code.
- The stack shows the macro ran from `Workflow.callMacros` in the `RollFinished` state, and the text names the macro
  and the fault: `bonuss is not defined`.

Other entries from the same call (a deprecation warning inside midi-qol, a notification from another module) are
real but unrelated; `contains` keeps them out of the way.

## 4. Fix it and confirm

```js
await (await fromUuid(mcpDemo.macroUuid)).update({
  command: "const bonus = 2;\nconst total = actor.system.attributes.prof + bonus;\nconsole.log(`MCP demo total ${total}`);",
});
const item = await fromUuid(mcpDemo.itemUuid);
await MidiQOL.completeItemUse(item, {}, { configure: false }, {});
return 'used again';
```

`foundry_logs` with `since` set to this call's `logSeq` and `contains: "macro error"` now returns no entries.

## 5. Clean up

```js
const { actorUuid, macroUuid, messageIds, hook } = mcpDemo;
Hooks.off('createChatMessage', hook);
const messages = messageIds.filter((id) => game.messages.has(id));
await ChatMessage.deleteDocuments(messages);
await (await fromUuid(actorUuid))?.delete();
await (await fromUuid(macroUuid))?.delete();
delete globalThis.mcpDemo;
return {
  deletedMessages: messages.length,
  leftovers: [await fromUuid(actorUuid), await fromUuid(macroUuid)].filter(Boolean).length,
};
```

`leftovers` should be `0`. Documents with the same name from an earlier run are left alone.

## Things this demo taught us

- **Keep the Foundry window visible.** When it is minimized or covered, the browser throttles timers and a workflow
  that normally takes a second can take a minute or more, or outlast the call's timeout. `foundry_status` reports
  this as `windowVisibility: "hidden"`. During the recorded run, three workflows started while the window was hidden
  finished about 40 seconds late.
- **Wait for the workflow** (`await MidiQOL.completeItemUse(...)`) when you can. If you start one without waiting,
  its warnings arrive later and are found with `foundry_logs` and `since`.
- **A simulated error looks different.** Printing `console.error('midi-qol | fake')` from `foundry_eval` produces an
  entry with `fromEval: true` and an empty `packages` list.
