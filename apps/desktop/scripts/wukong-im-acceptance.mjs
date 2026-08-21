import { randomUUID } from 'node:crypto';
import WKSDK, { ConnectStatus, ChannelTypePerson } from 'wukongimjssdk';

const DEVICE_FLAG_PC = 2;
process.on('uncaughtException', failFast);
process.on('unhandledRejection', failFast);

const apiBaseUrl = process.env.WUKONG_IM_API_BASE_URL ?? 'http://127.0.0.1:5501';
const websocketUrl = process.env.WUKONG_IM_PUBLIC_WS_URL ?? 'ws://127.0.0.1:5520';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const senderUid = `accept_sender_${suffix}`;
const recipientUid = `accept_recipient_${suffix}`;
const senderToken = `sender_token_${suffix}`;
const recipientToken = `recipient_token_${suffix}`;
const conversationId = randomUUID();
const messageId = randomUUID();
const eventId = randomUUID();
const clientMsgNo = `accept_${suffix}`;
const groupChannelId = `accept_group_${suffix}`;
const groupClientMsgNo = `accept_group_msg_${suffix}`;
const received = [];

await Promise.all([
  post('/user/token', {
    uid: senderUid,
    token: senderToken,
    device_flag: DEVICE_FLAG_PC,
    device_level: 1,
  }),
  post('/user/token', {
    uid: recipientUid,
    token: recipientToken,
    device_flag: DEVICE_FLAG_PC,
    device_level: 1,
  }),
]);
process.stderr.write('WuKongIM acceptance: identities provisioned\n');

const recipient = WKSDK.shared();
recipient.config.uid = recipientUid;
recipient.config.token = recipientToken;
recipient.config.deviceFlag = DEVICE_FLAG_PC;
recipient.config.debug = false;
recipient.config.provider.connectAddrCallback = (callback) => callback(websocketUrl);
recipient.chatManager.addMessageListener((message) => received.push(message));

try {
  await connectSdk(recipient, 10_000);
  process.stderr.write('WuKongIM acceptance: recipient connected\n');
  const payload = {
    type: 1,
    content: `acceptance-${suffix}`,
    enterprise: { version: 1, eventId, messageId, conversationId },
  };
  const first = await post('/message/send', {
    header: { no_persist: 0, red_dot: 1, sync_once: 0 },
    from_uid: senderUid,
    channel_id: recipientUid,
    channel_type: ChannelTypePerson,
    client_msg_no: clientMsgNo,
    payload: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  });
  assert(first.reason === 1, `first send failed with reason ${String(first.reason)}`);
  await waitFor(
    () => received.some((message) => message.clientMsgNo === clientMsgNo),
    10_000,
    'recipient delivery',
  );
  const delivered = received.find((message) => message.clientMsgNo === clientMsgNo);
  assert(delivered?.fromUID === senderUid, 'sender identity did not survive delivery');
  assert(delivered?.content?.text === payload.content, 'message content did not survive delivery');

  const duplicate = await post('/message/send', {
    header: { no_persist: 0, red_dot: 1, sync_once: 0 },
    from_uid: senderUid,
    channel_id: recipientUid,
    channel_type: ChannelTypePerson,
    client_msg_no: clientMsgNo,
    payload: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  });
  assert(
    duplicate.reason === 1,
    `idempotent replay failed with reason ${String(duplicate.reason)}`,
  );
  assert(
    duplicate.message_id_exact === first.message_id_exact,
    'idempotent replay produced a different message id',
  );

  const history = await post('/channel/messagesync', {
    login_uid: recipientUid,
    channel_id: senderUid,
    channel_type: ChannelTypePerson,
    start_message_seq: 0,
    end_message_seq: 0,
    pull_mode: 1,
    limit: 20,
  });
  assert(
    Array.isArray(history.messages) &&
      history.messages.some((message) => message.client_msg_no === clientMsgNo),
    'durable message could not be recalled from channel history',
  );

  await post('/channel', {
    channel_id: groupChannelId,
    channel_type: 2,
    reset: 1,
    subscribers: [senderUid, recipientUid],
  });
  const groupPayload = {
    type: 1,
    content: `group-acceptance-${suffix}`,
    enterprise: { version: 1, eventId: randomUUID(), messageId: randomUUID(), conversationId },
  };
  const groupSend = await post('/message/send', {
    header: { no_persist: 0, red_dot: 1, sync_once: 0 },
    from_uid: senderUid,
    channel_id: groupChannelId,
    channel_type: 2,
    client_msg_no: groupClientMsgNo,
    payload: Buffer.from(JSON.stringify(groupPayload), 'utf8').toString('base64'),
  });
  assert(groupSend.reason === 1, `group send failed with reason ${String(groupSend.reason)}`);
  await waitFor(
    () => received.some((message) => message.clientMsgNo === groupClientMsgNo),
    10_000,
    'group recipient delivery',
  );
  const groupHistory = await post('/channel/messagesync', {
    login_uid: recipientUid,
    channel_id: groupChannelId,
    channel_type: 2,
    start_message_seq: 0,
    end_message_seq: 0,
    pull_mode: 1,
    limit: 20,
  });
  assert(
    Array.isArray(groupHistory.messages) &&
      groupHistory.messages.some((message) => message.client_msg_no === groupClientMsgNo),
    'durable group message could not be recalled from channel history',
  );

  process.stdout.write(
    JSON.stringify({
      status: 'passed',
      websocketDelivery: true,
      idempotentReplay: true,
      durableHistory: true,
      nativeGroupDelivery: true,
      nativeGroupHistory: true,
      messageId: first.message_id_exact,
      messageSeq: first.message_seq,
    }) + '\n',
  );
} finally {
  recipient.disconnect();
}
process.exit(0);

async function post(path, body) {
  const response = await fetch(new URL(path, apiBaseUrl), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(parsed)}`);
  }
  const exactMessageId = /"message_id"\s*:\s*([0-9]{1,30})(?=\s*[,}])/u.exec(text)?.[1];
  return exactMessageId === undefined ? parsed : { ...parsed, message_id_exact: exactMessageId };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function connectSdk(sdk, timeoutMs) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`recipient websocket connection timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const listener = (status, reasonCode) => {
      if (status === ConnectStatus.Connected) finish();
      if (status === ConnectStatus.ConnectFail || status === ConnectStatus.ConnectKick) {
        finish(
          new Error(`recipient websocket authentication failed with reason ${String(reasonCode)}`),
        );
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sdk.connectManager.removeConnectStatusListener(listener);
      if (error) reject(error);
      else resolve();
    };
    sdk.connectManager.addConnectStatusListener(listener);
    sdk.connect();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function failFast(error) {
  process.stderr.write(
    `WuKongIM acceptance failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
}
