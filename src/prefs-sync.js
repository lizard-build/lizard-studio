"use strict";

// Field patches keep a stale view from overwriting another window's chats.
(function () {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function diff(before = {}, after = {}) {
    const patch = { fields: {}, tabs: [], history: [] };
    for (const key of Object.keys(after)) {
      if (["tabs", "history", "syncRevision", "activeId"].includes(key)) continue;
      if (!equal(before[key], after[key])) patch.fields[key] = after[key];
    }
    // Active chat belongs to the local view; this is only a reopen default.
    if (before.activeId !== after.activeId) patch.fields.activeId = after.activeId;
    for (const list of ["tabs", "history"]) {
      const old = new Map((before[list] || []).map((item) => [item.id, item]));
      const current = new Map((after[list] || []).map((item) => [item.id, item]));
      for (const [id, item] of current) {
        if (!old.has(id)) patch[list].push({ id, create: item });
        else {
          const fields = {};
          for (const key of Object.keys(item)) if (!equal(old.get(id)[key], item[key])) fields[key] = item[key];
          if (Object.keys(fields).length) patch[list].push({ id, fields });
        }
      }
      for (const id of old.keys()) if (!current.has(id)) patch[list].push({ id, remove: true });
      if (!equal([...old.keys()], [...current.keys()])) patch[list + "Order"] = [...current.keys()];
    }
    return copy(patch);
  }
  function merge(prefs, patch) {
    const next = { ...prefs, ...patch.fields };
    for (const list of ["tabs", "history"]) {
      const items = new Map((prefs[list] || []).map((item) => [item.id, item]));
      for (const change of patch[list] || []) {
        if (change.remove) items.delete(change.id);
        else if (change.create) items.set(change.id, { ...change.create, ...items.get(change.id) });
        // A stale field edit must never resurrect a closed chat.
        else if (items.has(change.id)) items.set(change.id, { ...items.get(change.id), ...change.fields });
      }
      const order = [...new Set([...(patch[list + "Order"] || []), ...items.keys()])];
      next[list] = order.filter((id) => items.has(id)).map((id) => items.get(id));
    }
    return next;
  }
  function createStore(chrome) {
    let writes = Promise.resolve();
    function update(change) {
      const operation = writes.then(() => new Promise((resolve, reject) => {
        chrome.storage.local.get(["rkChatV2"], (data) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          const current = data.rkChatV2 || {};
          const prefs = { ...change(current), syncRevision: (current.syncRevision || 0) + 1 };
          chrome.storage.local.set({ rkChatV2: prefs }, () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(prefs);
          });
        });
      }));
      writes = operation.catch(() => {});
      return operation;
    }
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg?.type !== "studioPrefsPatch") return;
      if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("src/panel/panel.html")) return;
      update((prefs) => merge(prefs, msg.patch)).then((prefs) => reply({ prefs }), (error) => reply({ error: error.message }));
      return true;
    });
    return { update };
  }
  function createClient(chrome, initial, read, apply) {
    let last = copy(initial), latest = copy(initial), writing = Promise.resolve();
    const pending = [];
    function receive(prefs) {
      if ((prefs.syncRevision || 0) < (latest.syncRevision || 0)) return;
      const local = diff(last, read());
      latest = copy(prefs);
      let next = latest;
      for (const patch of pending) next = merge(next, patch);
      last = copy(next);
      apply(merge(next, local));
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.rkChatV2?.newValue) receive(changes.rkChatV2.newValue);
    });
    return {
      save(prefs, done) {
        const patch = diff(last, prefs);
        last = copy(prefs);
        pending.push(patch);
        const operation = writing.then(() => new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "studioPrefsPatch", patch }, (result) => {
            const error = chrome.runtime.lastError?.message || result?.error;
            if (error || !result?.prefs) { reject(new Error(error || "Could not save chats")); return; }
            pending.splice(pending.indexOf(patch), 1);
            receive(result.prefs);
            resolve();
          });
        }));
        writing = operation.catch(() => {});
        operation.then(() => done?.(), (error) => { pending.splice(pending.indexOf(patch), 1); done?.(error); });
      },
    };
  }
  globalThis.StudioPrefsSync = { diff, merge, createStore, createClient };
})();
