const LabelAssociationType = { Chat: 1, Message: 2 };
import {
  proto,
  DEFAULT_CONNECTION_CONFIG,
  jidNormalizedUser,
  toNumber,
  updateMessageWithReceipt,
  updateMessageWithReaction,
  md5,
  jidDecode
} from '@whiskeysockets/baileys';

import KeyedDB_ from '@adiwajshing/keyed-db';
const KeyedDB = KeyedDB_.default || KeyedDB_;
import makeOrderedDictionary from './make-ordered-dictionary.js';
import { ObjectRepository } from './object-repository.js';

const waChatKey = (pin = true) => ({
  key: (c) =>
    (pin ? (c.pinned ? '1' : '0') : '') +
    (c.archived ? '0' : '1') +
    (c.conversationTimestamp ? c.conversationTimestamp.toString(16).padStart(8, '0') : '') +
    c.id,
  compare: (k1, k2) => k2.localeCompare(k1)
});

const waMessageID = (m) => m.key.id || '';

const waLabelAssociationKey = {
  key: (la) =>
    la.type === LabelAssociationType.Chat
      ? la.chatId + la.labelId
      : la.chatId + la.messageId + la.labelId,
  compare: (k1, k2) => k2.localeCompare(k1)
};

const makeMessagesDictionary = () => makeOrderedDictionary(waMessageID);
export default function makeInMemoryStore(config = {}) {
  const socket = config.socket;
  const chatKey = config.chatKey || waChatKey(true);
  const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey;
  const logger = config.logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' });

  const chats = new KeyedDB(chatKey, (c) => c.id);
  const messages = {};
  const contacts = {};
  const groupMetadata = {};
  const presences = {};
  const state = { connection: 'close' };
  const labels = new ObjectRepository();
  const labelAssociations = new KeyedDB(labelAssociationKey, labelAssociationKey.key);

  const assertMessageList = (jid) => {
    if (!messages[jid]) messages[jid] = makeMessagesDictionary();
    return messages[jid];
  };

  const contactsUpsert = (newContacts) => {
    const oldContacts = new Set(Object.keys(contacts));
    for (const c of newContacts) {
      oldContacts.delete(c.id);
      contacts[c.id] = Object.assign(contacts[c.id] || {}, c);
    }
    return oldContacts;
  };

  const labelsUpsert = (newLabels) => {
    for (const l of newLabels) labels.upsertById(l.id, l);
  };

  /* ---------- event binder ---------- */
  const bind = (ev) => {
    ev.on('connection.update', (update) => Object.assign(state, update));

    ev.on('messaging-history.set', ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest }) => {
      if (isLatest) {
        chats.clear();
        for (const id in messages) delete messages[id];
      }
      chats.insertIfAbsent(...newChats);
      contactsUpsert(newContacts);
      for (const msg of newMessages) {
        assertMessageList(msg.key.remoteJid).upsert(msg, 'prepend');
      }
    });

    ev.on('chats.upsert', (arr) => chats.upsert(...arr));
    ev.on('chats.update', (updates) =>
      updates.forEach((u) => chats.update(u.id, (chat) => Object.assign(chat, u)))
    );
    ev.on('contacts.upsert', contactsUpsert);
    ev.on('messages.upsert', ({ messages: msgs, type }) => {
      if (type === 'notify' || type === 'append') {
        for (const msg of msgs) {
          const jid = jidNormalizedUser(msg.key.remoteJid);
          assertMessageList(jid).upsert(msg, 'append');
          if (type === 'notify' && !chats.get(jid)) {
            ev.emit('chats.upsert', [
              { id: jid, conversationTimestamp: toNumber(msg.messageTimestamp), unreadCount: 1 }
            ]);
          }
        }
      }
    });
    ev.on('messages.update', (updates) => {
      for (const { update, key } of updates) {
        assertMessageList(key.remoteJid).updateAssign(key.id, update);
      }
    });
    ev.on('messages.delete', (item) => {
      if ('all' in item) {
        messages[item.jid]?.clear();
      } else {
        const jid = item.keys[0].remoteJid;
        messages[jid]?.filter((m) => !item.keys.some((k) => k.id === m.key.id));
      }
    });
    ev.on('presence.update', ({ id, presences: update }) => {
      presences[id] = presences[id] || {};
      Object.assign(presences[id], update);
    });
    ev.on('group-participants.update', ({ id, participants, action }) => {
      const meta = groupMetadata[id];
      if (!meta) return;
      switch (action) {
        case 'add':
          meta.participants.push(...participants.map((p) => ({ id: p, isAdmin: false, isSuperAdmin: false })));
          break;
        case 'remove':
          meta.participants = meta.participants.filter((p) => !participants.includes(p.id));
          break;
        case 'promote':
        case 'demote':
          meta.participants.forEach((p) => {
            if (participants.includes(p.id)) p.isAdmin = action === 'promote';
          });
          break;
      }
    });
  };
  return {
    chats,
    contacts,
    messages,
    groupMetadata,
    state,
    presences,
    labels,
    labelAssociations,
    bind,
    loadMessages: async (jid, count, cursor) => {
      const list = assertMessageList(jid);
      const mode = !cursor || 'before' in cursor ? 'before' : 'after';
      const cursorKey = cursor ? ('before' in cursor ? cursor.before : cursor.after) : undefined;
      const cursorValue = cursorKey ? list.get(cursorKey.id) : undefined;
      let msgs = [];
      if (list && mode === 'before' && (!cursorKey || cursorValue)) {
        const idx = cursorValue ? list.array.findIndex((m) => m.key.id === cursorKey.id) : list.array.length;
        msgs = list.array.slice(0, idx);
        if (msgs.length > count) msgs = msgs.slice(-count);
      }
      return msgs;
    },
    loadMessage: async (jid, id) => assertMessageList(jid)?.get(id),
    mostRecentMessage: async (jid) => assertMessageList(jid)?.array.slice(-1)[0],
    fetchImageUrl: async (jid, sock) => {
      const c = contacts[jid];
      if (!c) return sock?.profilePictureUrl(jid);
      if (typeof c.imgUrl === 'undefined') c.imgUrl = await sock?.profilePictureUrl(jid);
      return c.imgUrl;
    },
    fetchGroupMetadata: async (jid, sock) => {
      if (!groupMetadata[jid]) groupMetadata[jid] = await sock?.groupMetadata(jid);
      return groupMetadata[jid];
    },
    toJSON: () => ({ chats, contacts, messages, labels, labelAssociations }),
    fromJSON: (json) => {
      chats.upsert(...json.chats);
      labelAssociations.upsert(...json.labelAssociations || []);
      contactsUpsert(Object.values(json.contacts));
      labelsUpsert(Object.values(json.labels || {}));
      for (const jid in json.messages) {
        const list = assertMessageList(jid);
        for (const msg of json.messages[jid]) {
          list.upsert(proto.WebMessageInfo.fromObject(msg), 'append');
        }
      }
    }
  };
}
